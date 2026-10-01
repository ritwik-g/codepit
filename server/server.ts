import express from 'express';
import { syncAgyMcpQuietly } from './mcp/agy-sync.js';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { apiRouter } from './api.js';
import { setupWebSockets } from './ws.js';
import { sessionManager } from './acp/session-mgr.js';
import { initStorage, removeLegacyToken } from './paths.js';
import { loadStoredCredentials } from './subscriptions.js';
import { checkAccess, checkOrigin, setAppKey } from './security.js';
import { deviceCookie } from './devices.js';
import { isPairingRequestPath, pairingRouter } from './pairing-routes.js';
import { webManifest } from './manifest.js';
import { resolveStartupNetwork } from './network.js';
import { lanAccess, readStoredLanEnabled, type LanStatus } from './lan.js';

export interface StartServerOptions {
  /** Built web client to serve; nothing is served outside /api when absent or missing. */
  staticDir?: string;
  /** Defaults to PORT, then 7890. 0 picks a free port. */
  port?: number;
  /**
   * The desktop app's key for this launch. Loopback clients that send it (as the
   * codepit_app cookie) are the host; other local clients are refused unless
   * CODEPIT_LOCALHOST allows them.
   */
  appKey?: string;
}

export interface ServerHandle {
  /** Loopback address of the server. */
  url: string;
  port: number;
  /** LAN state right after startup, including interfaces that failed to bind. */
  lan: LanStatus;
  /** Sessions whose agent process is running (or starting) right now. */
  runningAgentCount(): number;
  /** Stops every listener and every agent and terminal this server started. */
  close(): Promise<void>;
}

/** Where this machine reaches a listener bound to `host`. */
function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === 'localhost') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Starts the HTTP + WebSocket server. Used by `server/cli.ts` (npm start / npm run
 * dev) and by the CodePit desktop app, which hosts the server in its main process.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  initStorage();
  removeLegacyToken();
  setAppKey(opts.appKey);
  loadStoredCredentials();
  // Changes made while CodePit was closed, on either side, are reconciled once at start
  syncAgyMcpQuietly();

  const app = express();

  // JSON only: the web client never sends form bodies, and a urlencoded parser would let a
  // cross-site HTML form reach the API as a "simple" request without a CORS preflight.
  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    // Static assets, the page and the manifest are public; the API is not
    if (!req.path.startsWith('/api')) {
      return next();
    }
    // An unpaired device must be able to ask to pair and hear back
    const decision = isPairingRequestPath(req.path) ? checkOrigin(req) : checkAccess(req);
    if (!decision.ok) {
      res.status(decision.status).json({ error: decision.error, reason: decision.reason });
      return;
    }
    res.locals.access = decision;
    // Sent again now and then so the browser never expires a device that is in use
    if (decision.refreshCookie) res.append('Set-Cookie', deviceCookie(decision.refreshCookie));
    next();
  });

  app.use('/api', pairingRouter);
  app.use('/api', apiRouter);

  app.get('/manifest.webmanifest', (_req, res) => {
    res.type('application/manifest+json').set('Cache-Control', 'no-store').send(JSON.stringify(webManifest()));
  });

  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const attachWebSockets = setupWebSockets();
  const server = http.createServer(app);
  attachWebSockets(server);
  // Tracked so close() does not wait on idle keep-alive and WebSocket connections
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  sessionManager.init();

  const network = resolveStartupNetwork(readStoredLanEnabled());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? Number(process.env.PORT || 7890), network.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const lan = await lanAccess.start({
    handler: app,
    attach: attachWebSockets,
    port,
    host: network.host,
    enabled: network.lanEnabled,
    lockedReason: network.lockedReason,
  });

  const url = `http://${urlHost(network.host)}:${port}`;
  let closing: Promise<void> | null = null;

  return {
    url,
    port,
    lan,
    runningAgentCount: () => sessionManager.listSessions().filter((s) => s.isAgentRunning).length,
    close: () =>
      (closing ??= (async () => {
        sessionManager.shutdown();
        await lanAccess.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
      })()),
  };
}
