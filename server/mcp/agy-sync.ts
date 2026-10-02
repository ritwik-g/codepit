import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppDir, ensurePrivateDir, FILE_MODE } from '../paths.js';
import type { McpServerConfig } from '../types.js';
import { WORKSPACE_VAR, appliesTo, listMcpServers } from './config.js';

// Antigravity's agy CLI takes no MCP servers per run: it reads one file,
// ~/.gemini/config/mcp_config.json, which every agy run and the desktop app share.
// So CodePit keeps its servers for Antigravity in that file, touching only the
// entries it wrote (their names are kept in <app dir>/agy-mcp-sync.json).

export type AgySyncState = 'synced' | 'skipped' | 'conflict';

export interface AgySyncEntry {
  serverId: string;
  name: string;
  state: AgySyncState;
  reason?: string;
}

export interface AgySyncStatus {
  /** False when Antigravity is not installed here, so nothing was written. */
  available: boolean;
  file: string;
  entries: AgySyncEntry[];
  /** Why the file could not be read or written; nothing was changed. */
  error?: string;
  syncedAt?: number;
}

/** agy's own shape for one server: stdio uses command/args/env, HTTP serverUrl/headers. */
type AgyServer = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  serverUrl?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
};

export function agyMcpConfigFile(): string {
  return process.env.CODEPIT_AGY_MCP_CONFIG || path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
}

function managedFile(): string {
  return path.join(getAppDir(), 'agy-mcp-sync.json');
}

/** Antigravity is here: its config folder exists or agy is installed. Tests only ever touch a file they name. */
function agyAvailable(file: string): boolean {
  if (process.env.CODEPIT_AGY_MCP_CONFIG) return true;
  if (process.env.NODE_ENV === 'test') return false;
  const agy = process.env.AGY_PATH || path.join(os.homedir(), '.local/bin/agy');
  return fs.existsSync(path.dirname(file)) || fs.existsSync(agy);
}

function readManaged(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(managedFile(), 'utf8'));
    return new Set(Array.isArray(raw?.managed) ? raw.managed.filter((n: unknown) => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Names CodePit itself wrote into agy's file, so they aren't another source's server of that name. */
export function agyManagedNames(): Set<string> {
  return readManaged();
}

function writeManaged(names: Set<string>): void {
  ensurePrivateDir(getAppDir());
  fs.writeFileSync(managedFile(), JSON.stringify({ version: 1, managed: [...names].sort() }, null, 2), { mode: FILE_MODE });
}

/** Why a server can't go into agy's file, if it can't. */
function skipReason(server: McpServerConfig): string | undefined {
  if (server.transport === 'sse') return 'agy takes only stdio and HTTP servers.';
  const values = [server.command, ...(server.args ?? []), server.url, ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})];
  if (values.some((v) => v?.includes(WORKSPACE_VAR))) {
    return `It uses ${WORKSPACE_VAR}, which follows each session's folder, and agy's settings are shared by every Antigravity run.`;
  }
  return undefined;
}

function toAgyServer(server: McpServerConfig): AgyServer {
  if (server.transport === 'stdio') {
    return { command: server.command ?? '', args: server.args ?? [], ...(server.env ? { env: server.env } : {}), disabled: false };
  }
  return { serverUrl: server.url ?? '', ...(server.headers ? { headers: server.headers } : {}), disabled: false };
}

/** The same server, ignoring whether agy has it switched off. */
function sameServer(a: AgyServer, b: AgyServer): boolean {
  const norm = (s: AgyServer) =>
    JSON.stringify([s.command ?? '', s.args ?? [], Object.entries(s.env ?? {}).sort(), s.serverUrl ?? '', Object.entries(s.headers ?? {}).sort()]);
  return norm(a) === norm(b);
}

let lastStatus: AgySyncStatus | null = null;

/**
 * Bring agy's MCP file in line with CodePit's servers for Antigravity: add or update
 * the enabled ones in scope, remove ones CodePit added earlier that no longer are.
 * An entry CodePit didn't write is never changed; one identical to a CodePit server
 * is adopted, a different one with the same name is reported as a clash.
 */
export function syncAgyMcp(servers?: McpServerConfig[]): AgySyncStatus {
  const file = agyMcpConfigFile();
  const status: AgySyncStatus = { available: agyAvailable(file), file, entries: [] };
  if (!status.available) return (lastStatus = status);

  try {
    servers ??= listMcpServers();
  } catch (err: any) {
    return (lastStatus = { ...status, error: err.message });
  }

  let doc: { mcpServers?: Record<string, AgyServer>; [key: string]: unknown } = {};
  let before = '';
  try {
    before = fs.readFileSync(file, 'utf8');
    doc = JSON.parse(before);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      return (lastStatus = { ...status, error: `Can't read ${file} (${err.message}); left it alone.` });
    }
    doc = {};
  }
  const agyServers: Record<string, AgyServer> = { ...(doc.mcpServers ?? {}) };
  const managed = readManaged();

  const wanted = new Map<string, { server: McpServerConfig; entry: AgyServer }>();
  for (const s of servers) {
    if (!s.enabled || !appliesTo(s, 'antigravity')) continue;
    const reason = skipReason(s);
    if (reason) {
      status.entries.push({ serverId: s.id, name: s.name, state: 'skipped', reason });
      continue;
    }
    wanted.set(s.name, { server: s, entry: toAgyServer(s) });
  }

  for (const name of [...managed]) {
    if (wanted.has(name)) continue;
    delete agyServers[name];
    managed.delete(name);
  }
  for (const [name, { server, entry }] of wanted) {
    const existing = agyServers[name];
    if (existing && !managed.has(name) && !sameServer(existing, entry)) {
      status.entries.push({
        serverId: server.id,
        name,
        state: 'conflict',
        reason: `Antigravity already has a different server called ${name} that CodePit didn't add. Rename one of them.`,
      });
      continue;
    }
    agyServers[name] = entry;
    managed.add(name);
    status.entries.push({ serverId: server.id, name, state: 'synced' });
  }

  const next = JSON.stringify({ ...doc, mcpServers: agyServers }, null, 2) + '\n';
  try {
    const changed = before.trim() !== next.trim();
    if (changed || managed.size > 0) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (changed) {
        const tmp = `${file}.codepit-${process.pid}.tmp`;
        fs.writeFileSync(tmp, next, { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
      // It holds tokens once CodePit's servers are in it; agy itself writes it readable by everyone
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
    writeManaged(managed);
  } catch (err: any) {
    return (lastStatus = { ...status, entries: [], error: `Can't write ${file}: ${err.message}` });
  }
  status.syncedAt = Date.now();
  return (lastStatus = status);
}

/** The result of the last sync, syncing first if there has been none. */
export function agySyncStatus(): AgySyncStatus {
  return lastStatus ?? syncAgyMcp();
}

/** Sync without letting a failure stop what triggered it. */
export function syncAgyMcpQuietly(servers?: McpServerConfig[]): AgySyncStatus | null {
  try {
    const status = syncAgyMcp(servers);
    if (status.error) console.warn(`[mcp] Antigravity sync: ${status.error}`);
    return status;
  } catch (err: any) {
    console.warn(`[mcp] Antigravity sync failed: ${err.message}`);
    return null;
  }
}
