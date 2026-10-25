import fs from 'node:fs';
import { ensurePrivateDir, FILE_MODE, getAppDir, getSettingsFile } from '../../paths.js';

// Settings for CodePit's own MCP server, kept under `codepitMcp` in settings.json.
// Off until the user turns it on.

/** 'ask': a session another session starts waits for the user. 'auto': it starts at once. */
export type CodepitStartMode = 'ask' | 'auto';

export interface CodepitMcpSettings {
  enabled: boolean;
  /** Agents whose sessions get the server. */
  agents: string[];
  startMode: CodepitStartMode;
  /** A new session takes its parent's tags unless the agent says otherwise. */
  inheritTags: boolean;
  /** How many generations of sessions starting sessions are allowed. */
  maxDepth: number;
  /** How many sessions one session may start. */
  maxChildren: number;
  /** send_to_session: an agent may send messages into any other session, starting a stopped one. */
  allowMessaging: boolean;
}

export const DEFAULT_CODEPIT_MCP: CodepitMcpSettings = {
  enabled: false,
  agents: ['claude', 'codex'],
  startMode: 'ask',
  inheritTags: true,
  maxDepth: 3,
  maxChildren: 20,
  allowMessaging: false,
};

const LIMITS = { maxDepth: [1, 10], maxChildren: [1, 100] } as const;

function readFile(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readCodepitMcpSettings(): CodepitMcpSettings {
  const saved = readFile().codepitMcp;
  const parsed = saved && typeof saved === 'object' ? parseCodepitMcpSettings(saved, DEFAULT_CODEPIT_MCP) : null;
  return parsed && typeof parsed !== 'string' ? parsed : { ...DEFAULT_CODEPIT_MCP };
}

/** `body` laid over `base`, every field checked; a string is the reason it was refused. */
export function parseCodepitMcpSettings(body: unknown, base: CodepitMcpSettings): CodepitMcpSettings | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected an object';
  const b = body as Record<string, unknown>;
  const out = { ...base };
  for (const key of ['enabled', 'inheritTags', 'allowMessaging'] as const) {
    if (key in b) {
      if (typeof b[key] !== 'boolean') return `${key} must be true or false`;
      out[key] = b[key] as boolean;
    }
  }
  if ('startMode' in b) {
    if (b.startMode !== 'ask' && b.startMode !== 'auto') return 'startMode must be ask or auto';
    out.startMode = b.startMode;
  }
  if ('agents' in b) {
    if (!Array.isArray(b.agents) || b.agents.some((a) => typeof a !== 'string' || !/^[a-z0-9-]{1,32}$/.test(a))) return 'agents must be a list of agent ids';
    out.agents = [...new Set(b.agents as string[])];
  }
  for (const key of ['maxDepth', 'maxChildren'] as const) {
    if (key in b) {
      const v = b[key];
      const [min, max] = LIMITS[key];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return `${key} must be a whole number from ${min} to ${max}`;
      out[key] = v;
    }
  }
  return out;
}

export function writeCodepitMcpSettings(settings: CodepitMcpSettings): void {
  ensurePrivateDir(getAppDir());
  const file = getSettingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...readFile(), codepitMcp: settings }, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}
