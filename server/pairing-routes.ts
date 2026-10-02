import { Router, type NextFunction, type Request, type Response } from 'express';
import { clearDeviceCookie, deviceCookie, devices, PairingError } from './devices.js';
import { lanAccess } from './lan.js';
import { describeLanAddresses, getLanHostname } from './network.js';
import { getRemoteAddress, isHostClient, isLoopbackAddress, type AccessDecision } from './security.js';

/**
 * Pairing a device for LAN access, and managing the paired ones.
 *
 * Two routes are open to an unpaired device (the server's gate lets them through
 * after the Origin check): asking to pair, and polling for the answer. Everything
 * that decides who gets in is for the host machine only, like the LAN switch.
 */
export const pairingRouter = Router();

/** Request paths the gate lets through without a device cookie. */
export function isPairingRequestPath(path: string): boolean {
  return path === '/api/pair/request' || /^\/api\/pair\/request\/[\w-]+$/.test(path);
}

const param = (req: Request, name: string): string => String(req.params[name]);

function hostOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isHostClient(req)) {
    res.status(403).json({ error: 'Devices can only be paired and managed on the computer running CodePit' });
    return;
  }
  next();
}

function fail(res: Response, err: unknown): void {
  if (err instanceof PairingError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error)?.message || 'Pairing failed' });
}

const remoteIp = (req: Request) => getRemoteAddress(req) ?? 'unknown';

// ------------------------------------------------- the device asking to pair

pairingRouter.post('/pair/request', (req: Request, res: Response) => {
  if (isHostClient(req)) {
    res.status(400).json({ error: 'This computer runs CodePit and needs no pairing' });
    return;
  }
  // Pairing is for other devices; on this machine only the app gets in
  if (isLoopbackAddress(getRemoteAddress(req))) {
    res.status(403).json({ error: 'On this computer, CodePit opens only in the CodePit app', reason: 'use-app' });
    return;
  }
  if (!lanAccess.status().enabled) {
    res.status(409).json({ error: 'LAN access is off on the host' });
    return;
  }
  const { ticket, name, standalone } = req.body ?? {};
  try {
    res.json(
      devices.requestPairing({ ip: remoteIp(req), userAgent: String(req.headers['user-agent'] ?? ''), ticket, name, standalone })
    );
  } catch (err) {
    fail(res, err);
  }
});

pairingRouter.get('/pair/request/:id', (req: Request, res: Response) => {
  const result = devices.pollPairing(param(req, 'id'), req.query.secret);
  if (result.token) res.setHeader('Set-Cookie', deviceCookie(result.token));
  res.set('Cache-Control', 'no-store').json({ status: result.status, device: result.device });
});

pairingRouter.patch('/pair/request/:id', (req: Request, res: Response) => {
  try {
    res.json(devices.renameRequest(param(req, 'id'), req.body?.secret, req.body?.name));
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------ the host side

pairingRouter.post('/pair/ticket', hostOnly, async (_req: Request, res: Response) => {
  const lan = lanAccess.status();
  if (!lan.enabled) {
    res.status(409).json({ error: 'Turn LAN access on first' });
    return;
  }
  const { ticket, expiresAt } = devices.createTicket();
  const interfaces = await describeLanAddresses(lan.addresses);
  const hostname = getLanHostname();
  res.json({
    ticket,
    expiresAt,
    // The mDNS name keeps working when the IP changes, so it is the link to offer first
    hostname,
    hostnameUrl: hostname ? `http://${hostname}:${lan.port}/?pair=${ticket}` : null,
    lanInterfaces: interfaces.map((iface) => ({ ...iface, url: `http://${iface.address}:${lan.port}/?pair=${ticket}` })),
  });
});

pairingRouter.get('/devices', hostOnly, (_req: Request, res: Response) => {
  res.json({ devices: devices.list(), pending: devices.pendingRequests() });
});

pairingRouter.post('/pair/approve', hostOnly, (req: Request, res: Response) => {
  try {
    res.json({ device: devices.approve({ code: req.body?.code, requestId: req.body?.requestId }) });
  } catch (err) {
    fail(res, err);
  }
});

pairingRouter.post('/pair/deny', hostOnly, (req: Request, res: Response) => {
  try {
    devices.deny(req.body?.requestId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------- a paired device about itself

function selfId(res: Response): string | undefined {
  const access = res.locals.access as AccessDecision | undefined;
  return access?.ok ? access.deviceId : undefined;
}

pairingRouter.get('/devices/self', (req: Request, res: Response) => {
  if (isHostClient(req)) {
    res.json({ local: true });
    return;
  }
  const id = selfId(res);
  const device = id ? devices.get(id) : null;
  res.json({ local: false, device });
});

pairingRouter.delete('/devices/self', (_req: Request, res: Response) => {
  const id = selfId(res);
  if (!id) {
    res.status(400).json({ error: 'This browser is not a paired device' });
    return;
  }
  devices.revoke(id);
  res.setHeader('Set-Cookie', clearDeviceCookie);
  res.json({ ok: true });
});

pairingRouter.delete('/devices/:id', hostOnly, (req: Request, res: Response) => {
  if (!devices.revoke(param(req, 'id'))) {
    res.status(404).json({ error: 'No such device' });
    return;
  }
  res.json({ ok: true });
});

pairingRouter.patch('/devices/:id', hostOnly, (req: Request, res: Response) => {
  try {
    res.json({ device: devices.rename(param(req, 'id'), req.body?.name) });
  } catch (err) {
    fail(res, err);
  }
});
