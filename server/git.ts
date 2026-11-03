import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { GitInfo } from './types.js';

const exec = promisify(execFile);
const TTL_MS = 15_000;
// Non-git directories cache `null` so repeated lookups stay stable within the TTL
const cache = new Map<string, { at: number; info: GitInfo | null }>();

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  if (!cwd || !fs.existsSync(cwd)) return null;

  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  const info: GitInfo = {
    branch: '',
    uncommittedFiles: 0,
    unpushedCommits: 0,
    isClean: true,
    repoRoot: cwd,
  };

  try {
    const { stdout } = await exec(
      'git',
      [
        '-c', 'core.fsmonitor=',
        '-c', 'core.hooksPath=/dev/null',
        '--no-optional-locks',
        'status', '--porcelain=v2', '--branch',
      ],
      { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
    );

    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const branchName = line.slice('# branch.head '.length).trim();
        info.branch = branchName === '(detached)' ? 'detached' : branchName;
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          info.unpushedCommits = Number(m[1]);
        }
      } else if (line && !line.startsWith('#')) {
        info.uncommittedFiles++;
      }
    }

    info.isClean = info.uncommittedFiles === 0 && info.unpushedCommits === 0;

    // The checkout's root, and the main clone it belongs to (a worktree's main clone is another folder)
    try {
      const { stdout: rootOut } = await exec('git', ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 2000 });
      const [top, common] = rootOut.split('\n').map((l) => l.trim());
      info.repoRoot = top || cwd;
      info.mainRoot = mainCloneRoot(common, info.repoRoot);
    } catch {
      // git before 2.31 has no --path-format: the checkout's root still groups it
      try {
        const { stdout: rootOut } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000 });
        info.repoRoot = rootOut.trim() || cwd;
      } catch {
        info.repoRoot = cwd;
      }
      info.mainRoot = info.repoRoot;
    }
  } catch {
    // Not a git repository
    cache.set(cwd, { at: Date.now(), info: null });
    return null;
  }

  cache.set(cwd, { at: Date.now(), info });
  return info;
}

/**
 * The main clone's folder from git's common dir: <main>/.git for the main clone and its
 * worktrees. Anything else (a submodule's .git/modules/x, a bare repo) is its own repo.
 */
export function mainCloneRoot(commonDir: string | undefined, repoRoot: string): string {
  if (commonDir && path.isAbsolute(commonDir) && path.basename(commonDir) === '.git') return path.dirname(commonDir);
  return repoRoot;
}
