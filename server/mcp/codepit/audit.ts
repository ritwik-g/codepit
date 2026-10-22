import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, FILE_MODE, getLogDir } from '../../paths.js';

/**
 * Every call made to CodePit's MCP server, refused ones included. One JSON object per
 * line in <app dir>/logs/codepit-mcp.jsonl, owner-only, rotated to codepit-mcp.1.jsonl
 * past 5 MB. Long text arguments are cut to 500 characters.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 500;
const FILE = 'codepit-mcp.jsonl';
const ROTATED = 'codepit-mcp.1.jsonl';

export interface AuditCaller {
  sessionId: string;
  title?: string;
  agentId?: string;
  agentSessionId?: string;
}

export interface AuditEntry {
  at: string;
  /** Absent when the request carried no valid token. */
  caller?: AuditCaller;
  /** The JSON-RPC method; tools/call entries also name the tool. */
  method: string;
  tool?: string;
  args?: unknown;
  ok: boolean;
  error?: string;
  /** Sessions the call created or changed. */
  sessions?: string[];
  ms?: number;
}

function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}… (${value.length} chars)` : value;
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clip(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, clip(v, depth + 1)]));
}

export function writeAudit(entry: Omit<AuditEntry, 'at'>): void {
  try {
    const dir = getLogDir();
    ensurePrivateDir(dir);
    const file = path.join(dir, FILE);
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, ROTATED));
    } catch {
      // no log yet
    }
    const line: AuditEntry = { at: new Date().toISOString(), ...entry, ...(entry.args !== undefined ? { args: clip(entry.args) } : {}) };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: FILE_MODE });
  } catch (err: any) {
    console.warn(`[codepit-mcp] Could not write the audit log: ${err.message}`);
  }
}

/** The newest entries first, optionally only those a session made or touched. */
export function readAudit(opts: { limit?: number; sessionId?: string } = {}): AuditEntry[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const dir = getLogDir();
  const out: AuditEntry[] = [];
  for (const name of [FILE, ROTATED]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i].trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (opts.sessionId && entry.caller?.sessionId !== opts.sessionId && !entry.sessions?.includes(opts.sessionId)) continue;
      out.push(entry);
    }
    if (out.length >= limit) break;
  }
  return out;
}

export const auditLogFile = () => path.join(getLogDir(), FILE);
