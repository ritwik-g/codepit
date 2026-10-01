import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { sessionManager } from './acp/session-mgr.js';
import { ptyManager } from './pty-manager.js';
import { store } from './store.js';
import { checkAccess } from './security.js';
import { devices } from './devices.js';

/** Who is on the other end of a socket: the host machine, or a paired device. */
interface Peer {
  local: boolean;
  deviceId?: string;
}

/** Close code a revoked device's sockets end with; the page then shows the pair screen. */
export const WS_CLOSE_REVOKED = 4401;

/**
 * Sets up the WebSocket endpoints and returns `attach`, which adds them to an HTTP
 * listener. The loopback listener and every LAN listener share one set of clients,
 * so session events are relayed once however many listeners there are.
 */
export function setupWebSockets(): (server: Server) => void {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host}`);
    } catch {
      // Malformed Host header or request URL: refuse rather than let the throw crash the process
      socket.destroy();
      return;
    }
    const pathname = url.pathname;

    if (pathname === '/ws' || pathname.startsWith('/ws/terminal/')) {
      const decision = checkAccess(request);
      if (!decision.ok) {
        socket.write(`HTTP/1.1 ${decision.status} ${decision.status === 403 ? 'Forbidden' : 'Unauthorized'}\r\n\r\n`);
        socket.destroy();
        return;
      }

      const peer: Peer = { local: decision.local, deviceId: decision.deviceId };
      wss.handleUpgrade(request, socket, head, (ws) => {
        peers.set(ws, peer);
        ws.on('close', () => peers.delete(ws));
        wss.emit('connection', ws, request, url);
      });
    } else {
      socket.destroy();
    }
  };

  const sessionClients = new Set<WebSocket>();
  // Every open socket, terminals included, so a revoked device can be cut off at once
  const peers = new Map<WebSocket, Peer>();

  devices.on('revoked', (deviceId: string) => {
    for (const [ws, peer] of peers) {
      if (peer.deviceId === deviceId) ws.close(WS_CLOSE_REVOKED, 'Device access revoked');
    }
  });

  // Only the host can let a device in, so only the host hears that one is asking
  const toLocal = (msg: object) => {
    const text = JSON.stringify(msg);
    for (const ws of sessionClients) {
      if (peers.get(ws)?.local && ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  };
  devices.on('pairingRequest', (request) => toLocal({ type: 'pairingRequest', request }));
  devices.on('changed', () => toLocal({ type: 'devicesChanged' }));

  // Relay session events to all active connected web clients
  sessionManager.on('sessionsUpdated', (sessions) => {
    const msg = JSON.stringify({ type: 'sessionsUpdated', sessions });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  sessionManager.on('sessionStream', (payload) => {
    const msg = JSON.stringify({
      type: 'sessionStream',
      event: payload.type,
      sessionId: payload.sessionId,
      session: payload.session,
      text: payload.text,
      turn: payload.turn,
      toolCall: payload.toolCall,
      usage: payload.usage,
      rateLimits: payload.rateLimits,
      promptSuggestion: payload.promptSuggestion,
      agentTasks: payload.agentTasks,
      removedAgentTaskIds: payload.removedAgentTaskIds,
      taskText: payload.taskText,
    });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  sessionManager.on('permissionRequested', (payload) => {
    const msg = JSON.stringify({ type: 'permissionRequested', ...payload });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  sessionManager.on('permissionResolved', (payload) => {
    const msg = JSON.stringify({ type: 'permissionResolved', ...payload });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  // Forms the agent asks the user to fill in, relayed like approvals
  for (const type of ['elicitationRequested', 'elicitationResolved']) {
    sessionManager.on(type, (payload) => {
      const msg = JSON.stringify({ type, ...payload });
      for (const ws of sessionClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    });
  }

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, url: URL) => {
    const pathname = url.pathname;

    // Terminal attachment stream: /ws/terminal/:terminalId (or /ws/terminal/:sessionId)
    if (pathname.startsWith('/ws/terminal/')) {
      const targetId = pathname.slice('/ws/terminal/'.length);
      let term = ptyManager.getTerminal(targetId);

      // If targetId is not an active transient terminal, check if it is a session ID
      if (!term) {
        const session = store.get(targetId);
        if (session) {
          term = ptyManager.getOrCreateSessionTerminal(session.id, session.cwd);
        }
      }

      if (!term) {
        ws.send(JSON.stringify({ type: 'error', message: 'Terminal not found' }));
        ws.close();
        return;
      }

      const termId = term.id;

      // Replay existing output buffer
      if (term.outputBuffer) {
        ws.send(JSON.stringify({ type: 'data', data: term.outputBuffer }));
      }

      const onData = (evt: { id: string; data: string }) => {
        if (evt.id === termId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: evt.data }));
        }
      };

      const onExit = (evt: { id: string; exitCode: number | null }) => {
        if (evt.id === termId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', exitCode: evt.exitCode }));
        }
      };

      ptyManager.on('data', onData);
      ptyManager.on('exit', onExit);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'input' && typeof msg.data === 'string') {
            ptyManager.write(termId, msg.data);
          } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            ptyManager.resize(termId, msg.cols, msg.rows);
          }
        } catch {
          // ignore malformed message
        }
      });

      ws.on('close', () => {
        ptyManager.off('data', onData);
        ptyManager.off('exit', onExit);
      });

      return;
    }

    // Default: Session management stream
    sessionClients.add(ws);

    // Send initial snapshot
    ws.send(JSON.stringify({
      type: 'initial',
      sessions: sessionManager.listSessions(),
    }));

    ws.on('close', () => {
      sessionClients.delete(ws);
    });
  });

  return (server: Server) => {
    server.on('upgrade', onUpgrade);
  };
}
