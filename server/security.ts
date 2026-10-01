import crypto from 'node:crypto';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import { DEVICE_COOKIE, devices, readCookie } from './devices.js';
import { appEnv } from './env.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackAddress(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Remote address of the request. The `x-test-remote-ip` override exists only so test
 * scripts can simulate LAN clients; outside NODE_ENV=test any client could send it to
 * pose as loopback, so it is ignored there.
 */
export function getRemoteAddress(req: IncomingMessage): string | undefined {
  if (process.env.NODE_ENV === 'test') {
    const simulated = req.headers['x-test-remote-ip'];
    if (typeof simulated === 'string' && simulated) return simulated;
  }
  return req.socket.remoteAddress;
}

function localInterfaceAddresses(): Set<string> {
  const out = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) out.add(iface.address);
  }
  return out;
}

/** Hostname of a `host[:port]` value, lower-cased, keeping IPv6 brackets. Null when unparsable. */
function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  const bare = hostname.replace(/^\[|\]$/g, '');
  return localInterfaceAddresses().has(bare);
}

/**
 * Host header allowlist for requests trusted only because they come from loopback.
 * Without it a DNS-rebinding page (evil.example resolving to 127.0.0.1) would be
 * same-origin with the server and pass the Origin check.
 */
export function isTrustedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && isLocalHostname(hostname);
}

/**
 * Origin check for browser-initiated requests. Requests without an Origin header
 * (curl, scripts, same-origin GETs) are allowed; a present Origin must be local
 * (loopback or one of this machine's addresses, any port, so the Vite dev server
 * on 5280 works) or match the Host the request was sent to.
 */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isLocalHostname(parsed.hostname.toLowerCase())) return true;
  return Boolean(hostHeader) && parsed.host.toLowerCase() === hostHeader!.toLowerCase();
}

/**
 * A client on this machine addressing the server by a local name. The Host check
 * keeps a DNS-rebinding page out even though it is loopback. This alone is not
 * trust: see isHostClient.
 */
export function isLocalClient(req: IncomingMessage): boolean {
  return isLoopbackAddress(getRemoteAddress(req)) && isTrustedHost(req.headers.host);
}

/** Cookie the desktop app sets on its own window, carrying this launch's app key. */
export const APP_COOKIE = 'codepit_app';

let appKey: Buffer | null = null;

/** The key the desktop app minted for this launch; only it can open CodePit on this machine. */
export function setAppKey(key: string | undefined): void {
  appKey = key ? Buffer.from(key) : null;
}

/**
 * Whether a plain browser (or script) on this machine is let in without the app
 * key: CODEPIT_LOCALHOST=1 for testing and development, on by default in tests,
 * off otherwise.
 */
export function localhostAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = appEnv('LOCALHOST', env)?.toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return env.NODE_ENV === 'test';
}

function hasAppKey(req: IncomingMessage): boolean {
  const sent = readCookie(req.headers.cookie, APP_COOKIE);
  if (!appKey || !sent) return false;
  const b = Buffer.from(sent);
  return b.length === appKey.length && crypto.timingSafeEqual(b, appKey);
}

/**
 * The host: the CodePit app on this machine, or any local client when localhost
 * access is allowed for testing. The only client trusted without pairing, and the
 * only one allowed to change who else may connect. Loopback alone is not enough,
 * since every user and process on the machine can reach it.
 */
export function isHostClient(req: IncomingMessage): boolean {
  return isLocalClient(req) && (localhostAllowed() || hasAppKey(req));
}

export type AccessDecision =
  | { ok: true; local: boolean; deviceId?: string; refreshCookie?: string }
  /** reason 'use-app': a browser on the host machine, which only the CodePit app may open. */
  | { ok: false; status: 401 | 403; error: string; reason?: 'use-app' };

/** The Origin check on its own, for the pairing endpoints an unpaired device must reach. */
export function checkOrigin(req: IncomingMessage): AccessDecision {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(typeof origin === 'string' ? origin : undefined, req.headers.host)) {
    return { ok: false, status: 403, error: 'Forbidden: cross-origin request rejected' };
  }
  return { ok: true, local: isHostClient(req) };
}

/**
 * Shared gate for /api requests and WebSocket upgrades: reject foreign Origins, then
 * accept the host (see isHostClient), or a paired device's cookie from another
 * machine. Anything else on this machine is refused outright: it cannot pair.
 *
 * No CSRF token is needed for the cookie: it is SameSite=Strict, so another site's
 * page never sends it; the API takes JSON bodies only, which forces a CORS preflight
 * on cross-site writes; and a foreign Origin is refused above in any case.
 */
export function checkAccess(req: IncomingMessage): AccessDecision {
  const origin = checkOrigin(req);
  if (!origin.ok || origin.local) return origin;
  if (isLoopbackAddress(getRemoteAddress(req))) {
    return { ok: false, status: 401, error: 'On this computer, CodePit opens only in the CodePit app', reason: 'use-app' };
  }
  const cookie = readCookie(req.headers.cookie, DEVICE_COOKIE);
  const verified = devices.verify(cookie, getRemoteAddress(req));
  if (verified) {
    return { ok: true, local: false, deviceId: verified.device.id, refreshCookie: verified.refreshCookie ? cookie : undefined };
  }
  return { ok: false, status: 401, error: 'Unauthorized: this device is not paired' };
}

/** True when HOST binds only the loopback interface, so LAN clients cannot connect. */
export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
