import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store } from '../../store.js';
import type { AcpSession } from '../../types.js';

// Claude Code registers each running session in ~/.claude/sessions/<pid>.json with its
// session id and its current name, the address SendMessage takes. Names change on resume
// and on /rename, so they are read fresh (cached for two seconds), never stored.

const TTL_MS = 2000;
let cache: { at: number; names: Map<string, string> } | null = null;

const registryDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function readNames(): Map<string, string> {
  const names = new Map<string, string>();
  let files: string[];
  try {
    files = fs.readdirSync(registryDir()).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return names;
  }
  for (const f of files) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(registryDir(), f), 'utf8'));
      if (typeof reg?.sessionId === 'string' && typeof reg?.name === 'string' && reg.name && alive(reg.pid)) names.set(reg.sessionId, reg.name);
    } catch {
      // being written, or not a registry file
    }
  }
  return names;
}

/**
 * CodePit sessions Claude knows by `name`: the one running under it now first, then any
 * stopped one that last ran under it. Auto-derived names can repeat, so there may be several.
 */
export function sessionsByClaudeName(name: string): AcpSession[] {
  const live: AcpSession[] = [];
  const stopped: AcpSession[] = [];
  for (const s of store.getAll()) {
    const current = claudeSessionName(s.agentSessionId);
    if (current === name) live.push(s);
    else if (!current && s.lastAgentSessionName === name) stopped.push(s);
  }
  return [...live, ...stopped];
}

/** The live Claude session's current name, by its session id. */
export function claudeSessionName(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), names: readNames() };
  return cache.names.get(sessionId);
}
