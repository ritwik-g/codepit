import { DailyLog } from '../../daily-log.js';

/**
 * Every call made to CodePit's MCP server, refused ones included. One JSON object per line,
 * kept as daily files (logs/codepit-mcp-YYYY-MM-DD.jsonl, owner-only), gzipped after a week
 * and deleted after 60 days. Long text arguments are cut to 500 characters.
 */

const MAX_TEXT = 500;

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

const log = new DailyLog<AuditEntry>('codepit-mcp', ['codepit-mcp.1.jsonl', 'codepit-mcp.jsonl']);

export function writeAudit(entry: Omit<AuditEntry, 'at'>): void {
  log.append({ at: new Date().toISOString(), ...entry, ...(entry.args !== undefined ? { args: clip(entry.args) } : {}) });
}

/** The newest entries first, optionally only those a session made or touched. */
export function readAudit(opts: { limit?: number; sessionId?: string } = {}): AuditEntry[] {
  const { sessionId } = opts;
  return log.read({ limit: Math.min(opts.limit ?? 200, 1000), filter: sessionId ? (e) => e.caller?.sessionId === sessionId || Boolean(e.sessions?.includes(sessionId)) : undefined });
}

export const auditLogFile = () => log.location;
