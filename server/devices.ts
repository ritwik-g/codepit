import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ensurePrivateDir, getAppDir, FILE_MODE } from './paths.js';

/**
 * Devices allowed in over the LAN, one credential each, and the pairing requests
 * that let a new one in.
 *
 * A paired device holds 32 random bytes in an HttpOnly cookie; devices.json keeps
 * only their SHA-256, so the file alone cannot be used to sign in. A device that
 * goes unused for 30 days is dropped (sliding expiry); the host can also revoke
 * one at any time. Pairing requests live only in memory: a restart cancels them.
 */

export const DEVICE_COOKIE = 'codepit_device';
/** Browsers cap cookie lifetimes at 400 days; the sliding expiry below is what really ends access. */
export const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** lastSeenAt is bumped on every request but written to disk at most this often. */
const LAST_SEEN_WRITE_MS = 60 * 60 * 1000;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING = 10;
export const MAX_PENDING_PER_IP = 3;
const MAX_TICKETS = 20;
const MAX_NAME = 60;

export interface Device {
  id: string;
  name: string;
  userAgent: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
}

/** A device as the host sees it: no credential hash. */
export type DeviceView = Omit<Device, 'tokenHash'> & { expiresAt: number };

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired';

interface PairingRequest {
  id: string;
  code: string;
  pollSecret: string;
  name: string;
  userAgent: string;
  ip: string;
  /** Opened from a QR code the host is showing, so the host may allow it with one click. */
  viaTicket: boolean;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied';
  /** Set on approval and handed over once, by the next poll. */
  credential?: { token: string; deviceId: string };
}

/**
 * A pairing request as the host sees it: no poll secret, no credential, and no
 * code, which the host must read off the device and type in.
 */
export interface PairingRequestView {
  id: string;
  name: string;
  ip: string;
  viaTicket: boolean;
  createdAt: number;
  expiresAt: number;
}

export class PairingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();
const randomId = () => crypto.randomBytes(9).toString('base64url');

function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return trimmed || null;
}

/** "iPhone · Safari", "Mac · Chrome": a default name the person can recognise and change. */
export function deviceNameFromUserAgent(ua: string, standalone = false): string {
  const platform = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone|iPod/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux PC'
                : 'Device';
  // An app added to the home screen keeps its own cookies, so it pairs as its own device
  if (standalone) return `${platform} · Home screen app`;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  return browser ? `${platform} · ${browser}` : platform;
}

/** The value of one cookie from a Cookie header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

/** Set-Cookie value for a device credential; no Secure flag, since LAN access is plain HTTP. */
export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
}

export const clearDeviceCookie = `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

class DeviceRegistry extends EventEmitter {
  private devices: Device[] = [];
  private loadedFrom: { file: string; mtimeMs: number } | null = null;
  /** lastSeenAt as last written, to keep writes to once an hour per device. */
  private writtenSeen = new Map<string, number>();
  private requests = new Map<string, PairingRequest>();
  private tickets = new Map<string, number>();

  static file(): string {
    return path.join(getAppDir(), 'devices.json');
  }

  /** Reloads when the file changed underneath (another process, a test, a hand edit). */
  private load(): Device[] {
    const file = DeviceRegistry.file();
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // no file yet
    }
    if (this.loadedFrom && this.loadedFrom.file === file && this.loadedFrom.mtimeMs === mtimeMs) return this.devices;
    let devices: Device[] = [];
    if (mtimeMs !== -1) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.devices)) {
          devices = parsed.devices.filter(
            (d: any) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && typeof d.lastSeenAt === 'number'
          );
        }
      } catch (err: any) {
        console.warn(`[codepit] Could not read ${file}; no device is paired until it is fixed: ${err.message}`);
      }
    }
    this.devices = devices;
    this.writtenSeen = new Map(devices.map((d) => [d.id, d.lastSeenAt]));
    this.loadedFrom = { file, mtimeMs };
    return devices;
  }

  private save(): void {
    ensurePrivateDir(getAppDir());
    const file = DeviceRegistry.file();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2), { mode: FILE_MODE });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, FILE_MODE);
    } catch {
      // best-effort chmod
    }
    this.loadedFrom = { file, mtimeMs: fs.statSync(file).mtimeMs };
    this.writtenSeen = new Map(this.devices.map((d) => [d.id, d.lastSeenAt]));
  }

  /** Drops devices unused for 30 days. Returns true when any were dropped. */
  private prune(now = Date.now()): boolean {
    const devices = this.load();
    const kept = devices.filter((d) => now - d.lastSeenAt < DEVICE_IDLE_MS);
    if (kept.length === devices.length) return false;
    const dropped = devices.filter((d) => !kept.includes(d)).map((d) => d.id);
    this.devices = kept;
    this.save();
    for (const id of dropped) this.emit('revoked', id);
    this.emit('changed');
    return true;
  }

  /**
   * The device a credential belongs to, or null. Compares hashes in constant time,
   * bumps lastSeenAt, and says whether the cookie should be sent again to keep it
   * from expiring in the browser (on the same hourly beat as the disk write).
   */
  verify(token: string | undefined, ip?: string): { device: Device; refreshCookie: boolean } | null {
    if (!token || token.length > 128) return null;
    this.prune();
    const hash = sha256(token);
    let match: Device | null = null;
    for (const d of this.devices) {
      const stored = Buffer.from(d.tokenHash, 'hex');
      if (stored.length === hash.length && crypto.timingSafeEqual(stored, hash)) match = d;
    }
    if (!match) return null;
    const now = Date.now();
    match.lastSeenAt = now;
    if (ip) match.lastIp = ip;
    const due = now - (this.writtenSeen.get(match.id) ?? 0) >= LAST_SEEN_WRITE_MS;
    if (due) this.save();
    return { device: match, refreshCookie: due };
  }

  list(): DeviceView[] {
    this.prune();
    return this.devices.map(({ tokenHash: _hash, ...d }) => ({ ...d, expiresAt: d.lastSeenAt + DEVICE_IDLE_MS }));
  }

  get(id: string): DeviceView | null {
    return this.list().find((d) => d.id === id) ?? null;
  }

  revoke(id: string): boolean {
    const devices = this.load();
    const kept = devices.filter((d) => d.id !== id);
    if (kept.length === devices.length) return false;
    this.devices = kept;
    this.save();
    this.emit('revoked', id);
    this.emit('changed');
    return true;
  }

  rename(id: string, name: unknown): DeviceView {
    const clean = cleanName(name);
    if (!clean) throw new PairingError('Give the device a name', 400);
    const device = this.load().find((d) => d.id === id);
    if (!device) throw new PairingError('No such device', 404);
    device.name = clean;
    this.save();
    this.emit('changed');
    return this.get(id)!;
  }

  // ---------------------------------------------------------------- pairing

  private sweep(now = Date.now()): void {
    let changed = false;
    for (const [id, r] of this.requests) {
      if (r.expiresAt <= now) {
        this.requests.delete(id);
        changed ||= r.status === 'pending';
        // Approved, but the device never came back for its credential: nobody can use it
        if (r.credential) this.revoke(r.credential.deviceId);
      }
    }
    for (const [ticket, expiresAt] of this.tickets) if (expiresAt <= now) this.tickets.delete(ticket);
    if (changed) this.emit('changed');
  }

  /** A one-time ticket for the QR code; whoever opens the link first uses it up. */
  createTicket(): { ticket: string; expiresAt: number } {
    this.sweep();
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.tickets.set(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  /**
   * A device asks to be let in. Capped overall and per address so a device on the
   * network cannot flood the host's list. An unknown or used ticket still gives a
   * request, approvable only by its code.
   */
  requestPairing(opts: { ip: string; userAgent: string; ticket?: unknown; name?: unknown; standalone?: unknown }) {
    this.sweep();
    const pending = [...this.requests.values()].filter((r) => r.status === 'pending');
    if (pending.length >= MAX_PENDING) throw new PairingError('Too many devices are waiting to pair. Try again in a few minutes.', 429);
    if (pending.filter((r) => r.ip === opts.ip).length >= MAX_PENDING_PER_IP) {
      throw new PairingError('This device already has pairing requests waiting. Try again in a few minutes.', 429);
    }
    const viaTicket = typeof opts.ticket === 'string' && this.tickets.has(opts.ticket);
    if (viaTicket) this.tickets.delete(opts.ticket as string);
    const userAgent = opts.userAgent.slice(0, 400);
    let code: string;
    do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    while (pending.some((r) => r.code === code));
    const now = Date.now();
    const request: PairingRequest = {
      id: randomId(),
      code,
      pollSecret: crypto.randomBytes(24).toString('base64url'),
      name: cleanName(opts.name) ?? deviceNameFromUserAgent(userAgent, opts.standalone === true),
      userAgent,
      ip: opts.ip,
      viaTicket,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      status: 'pending',
    };
    this.requests.set(request.id, request);
    this.emit('pairingRequest', this.viewRequest(request));
    this.emit('changed');
    return {
      requestId: request.id,
      code: request.code,
      pollSecret: request.pollSecret,
      name: request.name,
      viaTicket,
      expiresAt: request.expiresAt,
      ticketRejected: opts.ticket !== undefined && !viaTicket,
    };
  }

  private viewRequest(r: PairingRequest): PairingRequestView {
    return { id: r.id, name: r.name, ip: r.ip, viaTicket: r.viaTicket, createdAt: r.createdAt, expiresAt: r.expiresAt };
  }

  /** The request a poll secret belongs to; unknown ids and wrong secrets look the same. */
  private ownRequest(id: string, secret: unknown): PairingRequest | null {
    this.sweep();
    const r = this.requests.get(id);
    if (!r || typeof secret !== 'string') return null;
    const a = Buffer.from(r.pollSecret);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? r : null;
  }

  /** The waiting device's poll. Hands the credential over once, on the first poll after approval. */
  pollPairing(id: string, secret: unknown): { status: PairingStatus; token?: string; device?: { id: string; name: string } } {
    const r = this.ownRequest(id, secret);
    if (!r) return { status: 'expired' };
    if (r.status === 'approved' && r.credential) {
      const { token, deviceId } = r.credential;
      this.requests.delete(r.id);
      return { status: 'approved', token, device: { id: deviceId, name: r.name } };
    }
    return { status: r.status === 'approved' ? 'expired' : r.status };
  }

  /** The waiting device renames itself before it is approved. */
  renameRequest(id: string, secret: unknown, name: unknown): { name: string } {
    const r = this.ownRequest(id, secret);
    if (!r || r.status !== 'pending') throw new PairingError('This pairing request has ended', 404);
    const clean = cleanName(name);
    if (!clean) throw new PairingError('Give the device a name', 400);
    r.name = clean;
    this.emit('changed');
    return { name: clean };
  }

  pendingRequests(): PairingRequestView[] {
    this.sweep();
    return [...this.requests.values()].filter((r) => r.status === 'pending').map((r) => this.viewRequest(r));
  }

  /**
   * The host lets a device in: by the code the device shows, or with one click for
   * a request that came from the host's own QR code. A request typed in by code
   * alone could be anyone on the network, so it is never approvable by id.
   */
  approve(by: { code?: unknown; requestId?: unknown }): DeviceView {
    this.sweep();
    const pending = [...this.requests.values()].filter((r) => r.status === 'pending');
    let r: PairingRequest | undefined;
    if (typeof by.code === 'string') {
      const code = by.code.replace(/\D/g, '');
      r = pending.find((p) => p.code === code);
      if (!r) throw new PairingError('No device is waiting with that code. Check the code, or reload the page on the device.', 404);
    } else if (typeof by.requestId === 'string') {
      r = pending.find((p) => p.id === by.requestId);
      if (!r) throw new PairingError('That pairing request has ended', 404);
      if (!r.viaTicket) throw new PairingError('Enter the code shown on the device to allow it', 400);
    } else {
      throw new PairingError('Give the code shown on the device', 400);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const device: Device = {
      id: randomId(),
      name: r.name,
      userAgent: r.userAgent,
      tokenHash: sha256(token).toString('hex'),
      createdAt: now,
      lastSeenAt: now,
      lastIp: r.ip,
    };
    this.load();
    this.devices.push(device);
    this.save();
    r.status = 'approved';
    r.credential = { token, deviceId: device.id };
    // The device polls every couple of seconds; give it at least a minute to pick the credential up
    r.expiresAt = Math.max(r.expiresAt, now + 60_000);
    this.emit('changed');
    return this.get(device.id)!;
  }

  deny(requestId: unknown): void {
    this.sweep();
    const r = typeof requestId === 'string' ? this.requests.get(requestId) : undefined;
    if (!r || r.status !== 'pending') throw new PairingError('That pairing request has ended', 404);
    r.status = 'denied';
    this.emit('changed');
  }

  /** Forget every pending request and ticket (LAN access turned off). */
  cancelPairing(): void {
    if (this.requests.size === 0 && this.tickets.size === 0) return;
    for (const r of this.requests.values()) if (r.credential) this.revoke(r.credential.deviceId);
    this.requests.clear();
    this.tickets.clear();
    this.emit('changed');
  }
}

export const devices = new DeviceRegistry();
