import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The sidebar's grouping (web/src/sidebarGroups.ts) and the main-clone lookup behind Repo grouping.
const { groupSessions, isGroupBy, repoKey, GROUP_BY_MODES, freshFirst, isIdleStopped, needsAttention } = await import('../web/src/sidebarGroups.js');
const { getGitInfo, mainCloneRoot } = await import('../server/git.js');
type Summary = Parameters<typeof groupSessions>[1][number];

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

let n = 0;
function session(over: Partial<Summary> & { id?: string }): Summary {
  n++;
  return {
    id: over.id ?? `s${n}`,
    agentId: 'claude',
    agentName: 'Claude Code',
    title: `Session ${n}`,
    cwd: '/work/app',
    startedAt: n,
    updatedAt: n,
    state: 'quiet',
    score: 0,
    reasons: [],
    lastPrompt: '',
    recap: '',
    git: null,
    user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false },
    tokenCount: 0,
    turnCount: 0,
    ...over,
  } as Summary;
}
const git = (repoRoot: string, mainRoot?: string) => ({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, isClean: true, repoRoot, ...(mainRoot ? { mainRoot } : {}) });
const group = (mode: Parameters<typeof groupSessions>[0], list: Summary[]) => groupSessions(mode, list, list, [{ id: 'all', label: 'All', test: () => true }]);

console.log('🧪 [Test Suite] Sidebar grouping\n');

await test('every mode is accepted when read back, anything else is not', () => {
  for (const m of GROUP_BY_MODES) assert.ok(isGroupBy(m), m);
  for (const v of ['', 'vendor', null, undefined, 3]) assert.ok(!isGroupBy(v), String(v));
});

await test('a worktree joins the group of its main clone', () => {
  const main = session({ git: git('/src/codepit', '/src/codepit') });
  const wt = session({ cwd: '/src/codepit/.claude/worktrees/x', git: git('/src/codepit/.claude/worktrees/x', '/src/codepit') });
  const groups = group('repo', [main, wt]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'codepit');
  assert.equal(groups[0].id, 'repo:/src/codepit');
  assert.equal(groups[0].title, '/src/codepit');
});

await test('sessions saved before the main clone was recorded fall back to their checkout, then their folder', () => {
  assert.equal(repoKey(session({ git: git('/src/a') })), '/src/a');
  assert.equal(repoKey(session({ cwd: '/tmp/scratch', git: null })), '/tmp/scratch');
});

await test('two repos with the same folder name stay apart and are told apart by parent folder', () => {
  const a = session({ git: git('/work/api', '/work/api') });
  const b = session({ git: git('/personal/api', '/personal/api') });
  const groups = group('repo', [a, b]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.label).sort(), ['personal/api', 'work/api']);
});

await test('repo groups put the most recently active first, and keep the incoming order inside', () => {
  const old1 = session({ git: git('/r/old', '/r/old'), updatedAt: 10 });
  const new1 = session({ git: git('/r/new', '/r/new'), updatedAt: 50 });
  const old2 = session({ git: git('/r/old', '/r/old'), updatedAt: 5 });
  const groups = group('repo', [old1, new1, old2]);
  assert.deepEqual(groups.map((g) => g.label), ['new', 'old']);
  assert.deepEqual(groups[1].items.map((s) => s.id), [old1.id, old2.id]);
  assert.ok(groups.every((g) => !g.depth), 'repo groups are not indented');
});

await test('agent groups are per agent, named without "(ACP)", and carry the agent for the icon', () => {
  const c = session({ agentId: 'claude', agentName: 'Claude Code', updatedAt: 1 });
  const x = session({ agentId: 'codex', agentName: 'Codex CLI (ACP)', updatedAt: 9 });
  const c2 = session({ agentId: 'claude', agentName: 'Claude Code', updatedAt: 2 });
  const groups = group('agent', [c, x, c2]);
  assert.deepEqual(groups.map((g) => [g.id, g.label, g.agentId, g.items.length]), [
    ['agent:codex', 'Codex CLI', 'codex', 1],
    ['agent:claude', 'Claude Code', 'claude', 2],
  ]);
});

await test('family and tag grouping still work', () => {
  const parent = session({ id: 'p', title: 'Parent' });
  const child = session({ id: 'c', spawnedBy: { sessionId: 'p' } as Summary['spawnedBy'] });
  const lone = session({ id: 'l', user: { priority: null, pinned: false, snoozedUntil: null, tags: ['ui'], cleanup: false } });
  const fam = group('family', [parent, child, lone]);
  assert.deepEqual(fam.map((g) => g.label), ['Parent', 'On their own']);
  assert.equal(fam[0].depth?.get('c'), 1);
  assert.deepEqual(group('tag', [parent, lone]).map((g) => g.label), ['#ui', 'No tags']);
});

await test('the main clone is read from git common dir; a submodule or bare repo is its own repo', () => {
  assert.equal(mainCloneRoot('/src/app/.git', '/src/app/wt'), '/src/app');
  assert.equal(mainCloneRoot('/src/app/.git/modules/lib', '/src/app/lib'), '/src/app/lib');
  assert.equal(mainCloneRoot('/srv/app.git', '/srv/app.git'), '/srv/app.git');
  assert.equal(mainCloneRoot(undefined, '/x'), '/x');
});

await test('getGitInfo gives a worktree the same main root as its clone', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-groups-')));
  try {
    const main = path.join(dir, 'main');
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    fs.mkdirSync(main);
    g(main, 'init', '-q');
    g(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    g(main, 'worktree', 'add', '-q', path.join(dir, 'wt'));
    const a = await getGitInfo(main);
    const b = await getGitInfo(path.join(dir, 'wt'));
    assert.equal(a?.mainRoot, main);
    assert.equal(b?.repoRoot, path.join(dir, 'wt'));
    assert.equal(b?.mainRoot, main);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const STATUS = [
  { id: 'needs_you', label: 'Needs you', test: (s: Summary) => needsAttention(s) },
  { id: 'parked', label: 'Parked', test: (s: Summary) => s.state === 'parked' || isIdleStopped(s) },
];

await test('new replies and open questions go to the top of Needs you, newest first', () => {
  const old = session({ state: 'needs_you', isAgentRunning: true, lastTurnEndedAt: 100, seenAt: 200 });
  const reply = session({ state: 'needs_you', isAgentRunning: true, lastTurnEndedAt: 300, seenAt: 200 });
  const question = session({ state: 'blocked', isAgentRunning: true, hasPendingElicitation: true, askedAt: 500 });
  const newerReply = session({ state: 'needs_you', isAgentRunning: true, lastTurnEndedAt: 400 });
  const [needs] = groupSessions('status', [old, reply, question, newerReply], [], STATUS);
  assert.deepEqual(needs.items.map((s) => s.id), [question.id, newerReply.id, reply.id, old.id]);
});

await test('with nothing new, the server ranking is kept', () => {
  const a = session({ state: 'needs_you', isAgentRunning: true, updatedAt: 1 });
  const b = session({ state: 'needs_you', isAgentRunning: true, updatedAt: 9 });
  assert.deepEqual(freshFirst([a, b]).map((s) => s.id), [a.id, b.id]);
});

await test('new things lead inside repo groups too', () => {
  const a = session({ state: 'needs_you', isAgentRunning: true });
  const b = session({ state: 'needs_you', isAgentRunning: true, lastTurnEndedAt: 50 });
  assert.deepEqual(group('repo', [a, b])[0].items.map((s) => s.id), [b.id, a.id]);
});

await test('an agent CodePit stopped, with its reply read, is parked', () => {
  const stopped = session({ state: 'needs_you', isAgentRunning: false, lastTurnEndedAt: 10, seenAt: 20 });
  const groups = groupSessions('status', [stopped], [], STATUS);
  assert.equal(groups[0].id, 'parked');
  assert.ok(!needsAttention(stopped));
});

await test('a stopped agent still needs you while its reply is unread, a reminder is due, or it is offered back', () => {
  const unread = session({ state: 'needs_you', isAgentRunning: false, lastTurnEndedAt: 30, seenAt: 20 });
  const reminder = session({ state: 'needs_you', isAgentRunning: false, user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false, reminder: { at: 1 } } });
  const restore = session({ state: 'needs_you', isAgentRunning: false, restore: { reason: 'quit' } as any });
  for (const s of [unread, reminder, restore]) assert.ok(needsAttention(s) && !isIdleStopped(s), s.id);
});

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll sidebar grouping tests passed');
