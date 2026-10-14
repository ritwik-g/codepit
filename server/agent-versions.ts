import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The versions of the agent CLIs CodePit runs, the latest release of each, and their own
 * update commands. Every agent runs the CLI installed on this machine, so a new release
 * reaches a session the next time its agent starts; one already running keeps its version.
 */

export interface AgentVersionInfo {
  agentId: string;
  /** The CLI CodePit starts for this agent. */
  binary: string;
  installed?: string;
  latest?: string;
  /** Claude Code's release channel (autoUpdatesChannel), when it has one. */
  channel?: string;
  updateAvailable: boolean;
  /** Whether the CLI has an update command CodePit can run. */
  canUpdate: boolean;
  /** Why the installed or latest version could not be read. */
  error?: string;
}

const LATEST_TTL_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Same lookup as the agents themselves: client-host for Claude, codex-acp for Codex, antigravity-agent for agy. */
export function agentBinary(agentId: string): string | undefined {
  const local = (name: string) => {
    const p = path.join(os.homedir(), '.local/bin', name);
    return fs.existsSync(p) ? p : undefined;
  };
  if (agentId === 'claude') return process.env.CLAUDE_CODE_EXECUTABLE || local('claude');
  if (agentId === 'codex') return process.env.CODEX_PATH || 'codex';
  if (agentId === 'antigravity') return process.env.AGY_PATH || local('agy') || 'agy';
  return undefined;
}

/** "2.1.299 (Claude Code)", "codex-cli 0.157.1", "1.3.3" -> the version number. */
export function parseVersion(out: string): string | undefined {
  return out.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
}

/** Numeric compare of dotted versions; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// Keyed by the resolved file and its mtime, so an update (a new file or a moved symlink) is read again
const installedCache = new Map<string, { key: string; version: string }>();

function fileKey(binary: string): string {
  try {
    const real = fs.realpathSync(binary);
    return `${real}:${fs.statSync(real).mtimeMs}`;
  } catch {
    return binary; // on PATH: resolved by the shell, not here
  }
}

export async function installedVersion(agentId: string): Promise<string | undefined> {
  const binary = agentBinary(agentId);
  if (!binary) return undefined;
  const key = fileKey(binary);
  const cached = installedCache.get(agentId);
  if (cached?.key === key) return cached.version;
  const { stdout } = await run(binary, ['--version'], { timeout: 15_000 });
  const version = parseVersion(stdout);
  if (version) installedCache.set(agentId, { key, version });
  return version;
}

/** The last version read for the agent, without running anything. */
export function cachedInstalledVersion(agentId: string): string | undefined {
  return installedCache.get(agentId)?.version;
}

function claudeChannel(): string {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'settings.json'), 'utf8'));
    return settings?.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
  } catch {
    return 'latest';
  }
}

const latestCache = new Map<string, { at: number; version?: string; channel?: string }>();

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

/** The newest release: Claude Code's channel on its release server, Codex's npm package. agy has no public feed. */
async function latestVersion(agentId: string, refresh: boolean): Promise<{ version?: string; channel?: string }> {
  const channel = agentId === 'claude' ? claudeChannel() : undefined;
  const cached = latestCache.get(agentId);
  if (!refresh && cached && cached.channel === channel && Date.now() - cached.at < LATEST_TTL_MS) return cached;
  let version: string | undefined;
  if (agentId === 'claude') version = parseVersion(await fetchText(`https://downloads.claude.ai/claude-code-releases/${channel}`));
  else if (agentId === 'codex') version = parseVersion(JSON.parse(await fetchText('https://registry.npmjs.org/@openai/codex/latest')).version ?? '');
  const entry = { at: Date.now(), version, channel };
  latestCache.set(agentId, entry);
  return entry;
}

export async function agentVersionInfo(agentId: string, refresh = false): Promise<AgentVersionInfo | undefined> {
  const binary = agentBinary(agentId);
  if (!binary) return undefined;
  const info: AgentVersionInfo = { agentId, binary, updateAvailable: false, canUpdate: true };
  const errors: string[] = [];
  const [installed, latest] = await Promise.allSettled([installedVersion(agentId), latestVersion(agentId, refresh)]);
  if (installed.status === 'fulfilled') info.installed = installed.value;
  else errors.push(`Could not run ${binary} --version: ${installed.reason?.message ?? installed.reason}`);
  if (latest.status === 'fulfilled') Object.assign(info, { latest: latest.value.version, channel: latest.value.channel });
  else errors.push(`Could not check the latest release: ${latest.reason?.message ?? latest.reason}`);
  info.updateAvailable = Boolean(info.installed && info.latest && compareVersions(info.latest, info.installed) > 0);
  if (errors.length) info.error = errors.join('; ');
  return info;
}

const updating = new Map<string, Promise<AgentVersionInfo | undefined>>();

/** Run the CLI's own `update`. Agents already running keep their version until they next start. */
export function updateAgent(agentId: string): Promise<AgentVersionInfo | undefined> {
  const binary = agentBinary(agentId);
  if (!binary) return Promise.reject(new Error(`${agentId} has no CLI to update`));
  // One at a time per agent: a second click joins the first
  const pending = updating.get(agentId);
  if (pending) return pending;
  const job = (async () => {
    try {
      const child = run(binary, ['update'], { timeout: UPDATE_TIMEOUT_MS });
      // Nobody can answer a prompt: one that asks gets end of input instead of waiting out the timeout
      child.child.stdin?.end();
      await child;
    } catch (err: any) {
      const detail = `${err.stderr || err.stdout || err.message}`.trim().split('\n').slice(-3).join(' ');
      throw new Error(`${path.basename(binary)} update failed: ${detail}`);
    }
    installedCache.delete(agentId);
    return agentVersionInfo(agentId, true);
  })().finally(() => updating.delete(agentId));
  updating.set(agentId, job);
  return job;
}
