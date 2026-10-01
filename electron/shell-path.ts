import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = '__CT_PATH__';

/** Where CLIs usually live when the shell cannot be asked, and nothing was saved from a run that could. */
function fallbackDirs(): string[] {
  const home = os.homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), nvmDefaultBin(), path.join(home, '.volta/bin')];
  return dirs.filter((d): d is string => Boolean(d) && fs.existsSync(d!));
}

/**
 * The bin folder of nvm's default Node. nvm only exists in an interactive shell, so a
 * PATH not read from one lacks it, and an older Node elsewhere on PATH would be used.
 */
export function nvmDefaultBin(): string | undefined {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  let versions: string[];
  try {
    versions = fs.readdirSync(path.join(nvmDir, 'versions', 'node')).filter((v) => /^v\d+\.\d+\.\d+$/.test(v));
  } catch {
    return undefined;
  }
  if (versions.length === 0) return undefined;
  const parts = (v: string) => v.slice(1).split('.').map(Number);
  versions.sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  let alias = '';
  try {
    alias = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8').trim();
  } catch {
    // no default set: nvm's own choice is the newest
  }
  // A version or its prefix ("22", "v22.1") picks the newest match; node, stable, lts/* and the rest the newest of all
  const wanted = /^v?\d+(\.\d+){0,2}$/.test(alias) ? `v${alias.replace(/^v/, '')}` : '';
  const pick = (wanted && versions.find((v) => v === wanted || v.startsWith(`${wanted}.`))) || versions[0];
  return path.join(nvmDir, 'versions', 'node', pick, 'bin');
}

function askLoginShell(timeoutMs: number): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    // Interactive login, because that is where nvm, Homebrew and friends extend PATH.
    // The markers skip whatever the rc files print; stdin is closed so a prompt can't hang it.
    const child = spawn(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = out.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
      resolve(match ? match[1].trim() : null);
    });
  });
}

function readSavedPath(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function savePath(file: string | undefined, value: string): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  } catch (err) {
    console.warn('[codepit] could not save the login shell PATH:', err);
  }
}

export interface ShellPathOptions {
  /** How long the first read may take before startup goes on without it. */
  timeoutMs?: number;
  /** How long the read in the background, after a first one failed, may take. */
  retryTimeoutMs?: number;
  /** Where the last PATH read from the shell is kept, for a start when the shell is slow. */
  savedPathFile?: string;
}

/**
 * An app opened from Finder or the Dock gets launchd's PATH (/usr/bin:/bin:...),
 * so agents could not find claude, codex, agy, git or node. Adopt the PATH the
 * user's login shell builds, ahead of what we were given. Runs once at startup.
 *
 * A shell slow to start (just after login, or right after an install) used to leave
 * the app on a short guess for its whole life. Now the last PATH read is used
 * until a second read in the background succeeds; agents started after that get it.
 * Resolves with where the PATH came from.
 */
export async function adoptLoginShellPath(opts: ShellPathOptions = {}): Promise<'shell' | 'saved' | 'fallback' | 'unchanged'> {
  if (process.platform === 'win32') return 'unchanged';
  const { timeoutMs = 10_000, retryTimeoutMs = 30_000, savedPathFile } = opts;
  const given = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const adopt = (dirs: string[]) => {
    process.env.PATH = [...new Set([...dirs, ...given])].join(path.delimiter);
  };
  const split = (value: string) => value.split(path.delimiter).filter(Boolean);

  const fromShell = await askLoginShell(timeoutMs);
  if (fromShell) {
    adopt(split(fromShell));
    savePath(savedPathFile, fromShell);
    return 'shell';
  }

  const saved = readSavedPath(savedPathFile);
  adopt(saved ? split(saved) : fallbackDirs());
  console.warn(`[codepit] could not read PATH from the login shell in ${timeoutMs / 1000}s; using ${saved ? 'the one saved last time' : 'common locations'} and trying again`);
  void askLoginShell(retryTimeoutMs).then((later) => {
    if (!later) {
      console.warn('[codepit] the login shell did not answer a second time either');
      return;
    }
    adopt(split(later));
    savePath(savedPathFile, later);
    console.log('[codepit] read PATH from the login shell; agents started from now on use it');
  });
  return saved ? 'saved' : 'fallback';
}
