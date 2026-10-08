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
 * How far a client may fall behind before it is dropped. The socket keeps every unsent message
 * in memory, so a client that stops reading (a phone asleep on the LAN) held gigabytes of a
 * busy session's events until the server ran out of heap. A dropped client reconnects and
 * refetches what it missed.
 */
export const WS_MAX_BUFFERED = 32 * 1024 * 1024;
/** A socket that answers no ping within this long is gone (asleep, off the network). */
const WS_HEARTBEAT_MS = 30_000;

/** Send, unless the client has stopped keeping up: then drop it rather than queue more. */
export function sendOrDrop(ws: WebSocket, text: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount + text.length > WS_MAX_BUFFERED) {
    console.warn(`[ws] Dropping a client ${Math.round(ws.bufferedAmount / 1048576)} MB behind; it reconnects and refetches`);
    ws.terminate();
    return;
  }
  ws.send(text);
}

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
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        ws.on('close', () => {
          peers.delete(ws);
          alive.delete(ws);
        });
        wss.emit('connection', ws, request, url);
      });
    } else {
      socket.destroy();
    }
  };

  const sessionClients = new Set<WebSocket>();
  // Every open socket, terminals included, so a revoked device can be cut off at once
  const peers = new Map<WebSocket, Peer>();

  // Sockets that answered the last ping; one that did not is closed, so nothing queues for it
  const alive = new Set<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of peers.keys()) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref();

  devices.on('revoked', (deviceId: string) => {
    for (const [ws, peer] of peers) {
      if (peer.deviceId === deviceId) ws.close(WS_CLOSE_REVOKED, 'Device access revoked');
    }
  });

  // Only the host can let a device in, so only the host hears that one is asking
  const toLocal = (msg: object) => {
    const text = JSON.stringify(msg);
    for (const ws of sessionClients) {
      if (peers.get(ws)?.local) sendOrDrop(ws, text);
    }
  };
  devices.on('pairingRequest', (request) => toLocal({ type: 'pairingRequest', request }));
  devices.on('changed', () => toLocal({ type: 'devicesChanged' }));

  // The account-wide Claude plan limits changed; every open Usage view shows them
  sessionManager.on('claudeRateLimits', (rateLimits) => {
    const msg = JSON.stringify({ type: 'claudeRateLimits', rateLimits });
    for (const ws of sessionClients) {
      sendOrDrop(ws, msg);
    }
  });

  // Relay session events to all active connected web clients
  sessionManager.on('sessionsUpdated', (sessions) => {
    const msg = JSON.stringify({ type: 'sessionsUpdated', sessions });
    for (const ws of sessionClients) {
      sendOrDrop(ws, msg);
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
      sendOrDrop(ws, msg);
    }
  });

  sessionManager.on('permissionRequested', (payload) => {
    const msg = JSON.stringify({ type: 'permissionRequested', ...payload });
    for (const ws of sessionClients) {
      sendOrDrop(ws, msg);
    }
  });

  sessionManager.on('permissionResolved', (payload) => {
    const msg = JSON.stringify({ type: 'permissionResolved', ...payload });
    for (const ws of sessionClients) {
      sendOrDrop(ws, msg);
    }
  });

  // Forms the agent asks the user to fill in, relayed like approvals
  for (const type of ['elicitationRequested', 'elicitationResolved']) {
    sessionManager.on(type, (payload) => {
      const msg = JSON.stringify({ type, ...payload });
      for (const ws of sessionClients) {
        sendOrDrop(ws, msg);
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
        if (evt.id === termId) sendOrDrop(ws, JSON.stringify({ type: 'data', data: evt.data }));
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
