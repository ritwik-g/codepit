import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A snooze that ends becomes a reminder: the session ranks with the ones waiting on the user,
 * says what to come back for, and stays that way until the user replies, snoozes it again or
 * marks it done.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-reminder-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;

const { store } = await import('../server/store.js');
const { sessionManager, wakeSnooze } = await import('../server/acp/session-mgr.js');
const { rankSession } = await import('../server/rank.js');
const { parseAnnotations } = await import('../server/api.js');
type AcpSession = import('../server/types.js').AcpSession;

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

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-reminder-cwd-'));
let n = 0;
function session(over: Partial<AcpSession> = {}): AcpSession {
  n++;
  const s: AcpSession = {
    id: `rem-${n}`,
    agentId: 'mock',
    agentName: 'Mock',
    title: `Reminder ${n}`,
    titleSource: 'user',
    cwd,
    startedAt: Date.now() - 3 * 86_400_000,
    updatedAt: Date.now() - 3 * 86_400_000,
    state: 'quiet',
    score: 0,
    reasons: [],
    lastPrompt: '',
    recap: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextTokens: 0, lifetime: true },
    git: null,
    user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false },
    pendingPermission: null,
    turns: [],
    ...over,
  };
  store.save(s, { touch: false });
  return s;
}

console.log('🧪 [Test Suite] Snooze reminders\n');

await test('the annotations API takes a snooze note and only clears a reminder', () => {
  assert.deepEqual(parseAnnotations({ snoozedUntil: 5, snoozeNote: '  check CI  ' }), { snoozedUntil: 5, snoozeNote: 'check CI' });
  assert.deepEqual(parseAnnotations({ snoozeNote: '   ' }), { snoozeNote: undefined });
  assert.deepEqual(parseAnnotations({ reminder: null }), { reminder: null });
  assert.equal(typeof parseAnnotations({ reminder: { at: 1 } }), 'string');
  assert.equal(typeof parseAnnotations({ snoozeNote: 3 }), 'string');
});

await test('a snooze only wakes once its time has come', () => {
  const s = session({ user: { priority: null, pinned: false, snoozedUntil: Date.now() + 60_000, tags: [], cleanup: false, snoozeNote: 'later' } });
  assert.equal(wakeSnooze(s), false);
  assert.equal(s.user.reminder, undefined);
  assert.equal(rankSession(s).state, 'snoozed');
});

await test('a snooze that ends becomes a reminder carrying its note', () => {
  const s = session({ user: { priority: null, pinned: false, snoozedUntil: 1000, tags: [], cleanup: false, snoozeNote: 'check the CI run' } });
  assert.equal(wakeSnooze(s, 5000), true);
  assert.deepEqual(s.user.reminder, { at: 5000, note: 'check the CI run' });
  assert.equal(s.user.snoozedUntil, null);
  assert.equal(s.user.snoozeNote, undefined);
  const bare = session({ user: { priority: null, pinned: false, snoozedUntil: 1000, tags: [], cleanup: false } });
  wakeSnooze(bare, 5000);
  assert.deepEqual(bare.user.reminder, { at: 5000 });
});

await test('a due reminder ranks above idle sessions and replies waiting for the user, and says why', () => {
  const idle = session();
  const waiting = session({ turns: [{ id: 'a', role: 'agent', content: 'done', timestamp: 1 }] });
  const reminded = session({ user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false, reminder: { at: 1, note: 'review the PR' } } });
  const r = rankSession(reminded);
  assert.ok(r.score > rankSession(waiting).score && r.score > rankSession(idle).score, `${r.score}`);
  assert.ok(r.factors.some((f) => f.label === 'Your reminder is due'));
  assert.ok(r.summary.includes('review the PR'), r.summary);
  // The reminder does not change the session's own state, so clearing it leaves nothing stuck
  assert.equal(r.state, 'quiet');
});

await test('snoozing again puts the reminder off with a new note; waking by hand drops both', () => {
  const s = session({ user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false, reminder: { at: 1 } } });
  const again = sessionManager.updateAnnotations(s.id, { snoozedUntil: Date.now() + 3_600_000, snoozeNote: 'after lunch' })!;
  assert.equal(again.user.reminder, null);
  assert.equal(again.user.snoozeNote, 'after lunch');
  assert.equal(rankSession(again).state, 'snoozed');
  const woke = sessionManager.updateAnnotations(s.id, { snoozedUntil: null })!;
  assert.equal(woke.user.reminder, null);
  assert.equal(woke.user.snoozeNote, undefined);
});

await test('"Done" clears the reminder', () => {
  const s = session({ user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false, reminder: { at: 1 } } });
  assert.equal(sessionManager.updateAnnotations(s.id, { reminder: null })!.user.reminder, null);
});

await test('replying to the session clears the reminder', async () => {
  const s = session({ user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false, reminder: { at: 1, note: 'x' } } });
  // Recorded before the agent is started, so the outcome of the turn does not matter here
  const sent = sessionManager.sendPrompt(s.id, 'hello').catch(() => {});
  assert.equal(store.get(s.id)!.user.reminder, null);
  await sent;
});

sessionManager.shutdown();
store.flush();
fs.rmSync(testAppDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll reminder tests passed');
process.exit(0);
