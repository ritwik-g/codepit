import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * Restoring agents after CodePit restarts: an agent running at a quit or a crash is
 * offered back (never restarted on its own); Restore continues its agent session and
 * sends nothing again; the cases with no offer (stopped, exited, cleanup, agent gone,
 * another live CodePit); the manual actions that clear it; a failed restore; Restore all
 * a few at a time; and the HTTP routes. Runs against a scripted agent.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-restore-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
const stateDir = path.join(testAppDir, 'agent-state');
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
fs.mkdirSync(stateDir, { recursive: true });

const { sessionManager, RestoreError } = await import('../server/acp/session-mgr.js');
const { AGENT_REGISTRY } = await import('../server/agents/registry.js');
const { AcpClientHost } = await import('../server/acp/client-host.js');
const { store } = await import('../server/store.js');
const { getSessionsDir } = await import('../server/paths.js');
const { apiRouter } = await import('../server/api.js');
const { default: express } = await import('express');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.log(`   FAIL ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const TSX_BIN = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const agentEntry = (id: string, env: Record<string, string>) => ({
  id,
  name: 'Restore test agent',
  provider: 'mock' as const,
  description: 'Scripted agent for test-restore',
  command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
  args: [path.join(here, 'lib/effort-test-agent.ts')],
  env,
  icon: 'mock',
  defaultModel: 'big',
  availableModels: ['big', 'small'],
  efforts: [],
});
AGENT_REGISTRY.restoretest = agentEntry('restoretest', { EFFORT_TEST_STATE_DIR: stateDir });
AGENT_REGISTRY.restoregone = agentEntry('restoregone', { EFFORT_TEST_STATE_DIR: stateDir });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForIdle(id: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (sessionManager.isTurnInFlight(id)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for session ${id} to go idle`);
    await sleep(50);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

async function ask(id: string, text: string): Promise<string> {
  await sessionManager.sendPrompt(id, text);
  await waitForIdle(id);
  const turns = sessionManager.getSession(id)!.turns;
  return [...turns].reverse().find((t) => t.role === 'agent')?.content || '';
}

const field = (reply: string, key: string) => reply.match(new RegExp(`${key}=(\\S+)`))?.[1];
const notes = (id: string) => sessionManager.getSession(id)!.turns.filter((t) => t.role === 'system').map((t) => t.content || '');
const summary = (id: string) => sessionManager.listSessions().find((s) => s.id === id);
const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(getSessionsDir(), `${id}.json`), 'utf8'));
const promptsSeen = (agentSessionId: string): number =>
  JSON.parse(fs.readFileSync(path.join(stateDir, `${agentSessionId}.json`), 'utf8')).prompts.length;

/** CodePit quits and starts again in this process. */
function restart(): void {
  sessionManager.shutdown();
  sessionManager.init();
}

async function newSession(agentId = 'restoretest'): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-restore-ws-'));
  return (await sessionManager.createSession({ agentId, cwd, model: 'big' })).id;
}

/** A session whose agent was running at the last restart: it has an offer now. */
async function offered(): Promise<string> {
  const id = await newSession();
  await ask(id, 'hello');
  restart();
  if (!summary(id)?.restore) throw new Error(`Expected a restore offer on ${id}`);
  return id;
}

async function main(): Promise<void> {
  console.log('1. A graceful quit offers the agent back');
  const a = await newSession();
  await ask(a, 'remember fig');
  check('the live mark is on disk while the agent runs', Boolean(onDisk(a).agentLive?.since) && onDisk(a).agentLive?.pid === process.pid, onDisk(a).agentLive);
  const agentSession = sessionManager.getSession(a)!.agentSessionId!;
  restart();
  const offerA = summary(a);
  check('offered back, continuing the same agent session', offerA?.restore?.continues === true && offerA.restore.turnInterrupted === false, offerA?.restore);
  check('not restarted on its own', offerA?.isAgentRunning === false && !sessionManager.isTurnInFlight(a), offerA?.isAgentRunning);
  check('the mark became the offer', !store.get(a)!.agentLive);
  check('the summary label hint is there for the sidebar', Boolean(offerA?.restore?.runningSince && offerA.restore.foundAt));

  console.log('2. A crash leaves the mark, so it is offered too');
  const b = await newSession();
  await ask(b, 'before the crash');
  const snapshot = fs.readFileSync(path.join(getSessionsDir(), `${b}.json`), 'utf8');
  check('the snapshot holds the live mark', Boolean(JSON.parse(snapshot).agentLive));
  sessionManager.shutdown();
  fs.writeFileSync(path.join(getSessionsDir(), `${b}.json`), snapshot);
  store.clear();
  sessionManager.init();
  check('offered after the crash', Boolean(summary(b)?.restore), summary(b)?.restore);
  check('an offer made before it survives the reload', Boolean(summary(a)?.restore));

  console.log('2b. A crash mid-turn, read back from disk');
  const bw = await newSession();
  await ask(bw, 'warm up');
  const bwTurn = sessionManager.sendPrompt(bw, 'slow-turn, then crash').catch(() => {});
  await waitFor(() => sessionManager.getSession(bw)!.state === 'working');
  await sleep(200);
  const workingSnapshot = fs.readFileSync(path.join(getSessionsDir(), `${bw}.json`), 'utf8');
  check('the snapshot is mid-turn', JSON.parse(workingSnapshot).state === 'working' && Boolean(JSON.parse(workingSnapshot).agentLive));
  // A turn waiting on an approval when CodePit crashed was cut off just the same
  const bb = await newSession();
  await ask(bb, 'hi');
  const blockedSnapshot = JSON.parse(fs.readFileSync(path.join(getSessionsDir(), `${bb}.json`), 'utf8'));
  blockedSnapshot.state = 'blocked';
  blockedSnapshot.pendingPermission = { requestId: 'r1', toolCallId: 't1', title: 'Run a command', options: [], requestedAt: Date.now() };
  sessionManager.shutdown();
  void bwTurn;
  fs.writeFileSync(path.join(getSessionsDir(), `${bw}.json`), workingSnapshot);
  fs.writeFileSync(path.join(getSessionsDir(), `${bb}.json`), JSON.stringify(blockedSnapshot));
  store.clear();
  sessionManager.init();
  check('offered with the turn marked as cut off', summary(bw)?.restore?.turnInterrupted === true, summary(bw)?.restore);
  check('with the interrupted note', notes(bw).filter((n) => n.startsWith('CodePit stopped while this turn was running')).length === 1, notes(bw).slice(-2));
  check('and no longer working', store.get(bw)!.state === 'needs_you', store.get(bw)!.state);
  check('a turn waiting on an approval counts as cut off', summary(bb)?.restore?.turnInterrupted === true, summary(bb)?.restore);
  check('it gets the note too', notes(bb).some((n) => n.startsWith('CodePit stopped while this turn was running')), notes(bb).slice(-2));
  check('and needs you, with the request gone', store.get(bb)!.state === 'needs_you' && !store.get(bb)!.pendingPermission, store.get(bb)!.state);
  sessionManager.dismissRestore(bw);
  sessionManager.dismissRestore(bb);

  console.log('3. Restore continues the same agent session');
  await sessionManager.restoreSession(a);
  const restoredReply = await ask(a, 'what was the word?');
  check('continued, not handed a summary', field(restoredReply, 'resumed') === 'true' && field(restoredReply, 'history') === 'false' && field(restoredReply, 'seen') === '2', restoredReply);
  check('the notes say so', notes(a).some((n) => n.startsWith('↪️ Continued agent session')) && notes(a).some((n) => n.startsWith('▶️ Agent restored')), notes(a).slice(-4));
  check('the offer is gone and the agent is marked live again', !store.get(a)!.restore && Boolean(onDisk(a).agentLive) && !summary(a)?.restore);
  check('the same agent session', sessionManager.getSession(a)!.agentSessionId === agentSession);
  await sessionManager.restoreSession(a);
  check('restoring a running agent again is harmless', summary(a)?.isAgentRunning === true);

  console.log('4. A turn cut off by the quit is not sent again');
  const c = await newSession();
  await ask(c, 'warm up');
  const cAgent = sessionManager.getSession(c)!.agentSessionId!;
  const cutOff = sessionManager.sendPrompt(c, 'slow-turn, then quit').catch(() => {});
  await waitFor(() => sessionManager.getSession(c)!.state === 'working');
  check('the turn is running at the quit', sessionManager.getSession(c)!.state === 'working');
  await sleep(200);
  const seenBefore = promptsSeen(cAgent);
  restart();
  void cutOff;
  check('offered, with the turn marked as cut off', summary(c)?.restore?.turnInterrupted === true, summary(c)?.restore);
  const cutNotes = notes(c).filter((n) => n.startsWith('CodePit stopped while this turn was running'));
  // The note is kept for good, so it names no Restore button that a Dismiss or a restore takes away
  check('one interrupted note, naming no Restore button', cutNotes.length === 1 && !cutNotes[0].includes('Restore'), cutNotes);
  sessionManager.init();
  check('a second start adds no second note', notes(c).filter((n) => n.startsWith('CodePit stopped while')).length === 1);
  await sessionManager.restoreSession(c);
  await sleep(500);
  check('nothing was sent again', promptsSeen(cAgent) === seenBefore, { before: seenBefore, after: promptsSeen(cAgent) });
  check('the note says so', notes(c).some((n) => n.includes('not sent again')), notes(c).slice(-2));
  check('not working after the restore', sessionManager.getSession(c)!.state !== 'working');

  console.log('5. A paused queue stays paused');
  const d = await newSession();
  await ask(d, 'warm up');
  const slow = sessionManager.sendPrompt(d, 'slow-turn').catch(() => {});
  await waitFor(() => sessionManager.isTurnInFlight(d) && sessionManager.getSession(d)!.state === 'working');
  await sleep(200);
  const queued = await sessionManager.queuePrompt(d, 'queued for later');
  check('queued behind the turn', queued.queued === true);
  restart();
  void slow;
  await sessionManager.restoreSession(d);
  await sleep(1000);
  check('the queued message is still there', sessionManager.getSession(d)!.queuedPrompts?.length === 1, sessionManager.getSession(d)!.queuedPrompts);
  check('and was not sent', sessionManager.getSession(d)!.state !== 'working' && !sessionManager.isTurnInFlight(d));
  check('the note says it stays paused', notes(d).some((n) => n.includes('1 queued message stays paused')), notes(d).slice(-2));

  console.log('6. When the agent cannot continue its session, restore starts a new one');
  const e = await newSession();
  await ask(e, 'remember kiwi');
  const eAgent = sessionManager.getSession(e)!.agentSessionId!;
  restart();
  fs.rmSync(path.join(stateDir, `${eAgent}.json`));
  await sessionManager.restoreSession(e);
  check('says it could not continue', notes(e).some((n) => n.startsWith('⚠️ Could not continue agent session')), notes(e).slice(-3));
  const eReply = await ask(e, 'what was the word?');
  check('the next message hands over the conversation', field(eReply, 'history') === 'true' && field(eReply, 'resumed') === 'false', eReply);

  console.log('7. Not offered');
  const stopped = await newSession();
  await ask(stopped, 'hi');
  await sessionManager.stopSessionAgent(stopped);
  check('a stop clears the live mark', !onDisk(stopped).agentLive);
  restart();
  check('an agent the user stopped', !summary(stopped)?.restore);

  const exited = await newSession();
  const exitedReply = await ask(exited, 'hi');
  process.kill(Number(field(exitedReply, 'pid')), 'SIGKILL');
  check('the agent exits on its own', await waitFor(() => summary(exited)?.isAgentRunning === false));
  check('its exit clears the live mark', await waitFor(() => !onDisk(exited).agentLive));
  restart();
  check('an agent that exited before the quit', !summary(exited)?.restore);

  const cleanup = await newSession();
  await ask(cleanup, 'hi');
  const cs = store.get(cleanup)!;
  cs.user.cleanup = true;
  store.save(cs, { touch: false });
  restart();
  check('a session marked for cleanup', !store.get(cleanup)!.restore && !store.get(cleanup)!.agentLive);

  const gone = await newSession('restoregone');
  await ask(gone, 'hi');
  sessionManager.shutdown();
  const goneEntry = AGENT_REGISTRY.restoregone;
  delete AGENT_REGISTRY.restoregone;
  sessionManager.init();
  check('an agent no longer registered', !store.get(gone)!.restore && !store.get(gone)!.agentLive);
  let goneErr: any;
  const gs = store.get(gone)!;
  gs.restore = { runningSince: Date.now(), foundAt: Date.now(), turnInterrupted: false, continues: true };
  store.save(gs, { touch: false });
  await sessionManager.restoreSession(gone).catch((err) => (goneErr = err));
  check('a stale offer for it is refused, never started as Claude', goneErr instanceof RestoreError && goneErr.status === 409 && summary(gone)?.isAgentRunning === false, goneErr?.message);
  AGENT_REGISTRY.restoregone = goneEntry;
  sessionManager.dismissRestore(gone);

  const other = await newSession();
  await ask(other, 'hi');
  sessionManager.shutdown();
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  const os2 = store.get(other)!;
  os2.agentLive = { since: Date.now(), pid: sleeper.pid! };
  store.save(os2, { touch: false });
  sessionManager.init();
  check('an agent another live CodePit owns', !store.get(other)!.restore && store.get(other)!.agentLive?.pid === sleeper.pid, store.get(other)!.agentLive);
  // With its start time recorded, the same live process still owns the mark
  os2.agentLive = { since: Date.now(), pid: sleeper.pid!, started: Date.now(), boot: Date.now() - os.uptime() * 1000 };
  store.save(os2, { touch: false });
  sessionManager.init();
  check('an owner whose start time matches still owns it', !store.get(other)!.restore && Boolean(store.get(other)!.agentLive));
  // The pid now belongs to an unrelated process (pids are reused, densely after a reboot)
  os2.agentLive = { since: Date.now(), pid: sleeper.pid!, started: Date.now() - 3_600_000, boot: Date.now() - os.uptime() * 1000 };
  store.save(os2, { touch: false });
  sessionManager.init();
  check('a reused pid that started at another time is not that CodePit', Boolean(store.get(other)!.restore) && !store.get(other)!.agentLive, store.get(other)!.agentLive);
  sessionManager.dismissRestore(other);
  os2.agentLive = { since: Date.now(), pid: sleeper.pid!, started: Date.now(), boot: Date.now() - os.uptime() * 1000 - 86_400_000 };
  store.save(os2, { touch: false });
  sessionManager.init();
  check('a mark from before the last boot is offered', Boolean(store.get(other)!.restore) && !store.get(other)!.agentLive);
  sessionManager.dismissRestore(other);
  os2.agentLive = { since: Date.now(), pid: sleeper.pid! };
  store.save(os2, { touch: false });
  sleeper.kill();
  await once(sleeper, 'exit');
  sessionManager.init();
  check('offered once that CodePit is gone', Boolean(store.get(other)!.restore));
  sessionManager.dismissRestore(other);

  console.log('8. Manual actions clear the offer');
  const m1 = await offered();
  await ask(m1, 'a message');
  check('a message', !store.get(m1)!.restore);
  const m2 = await offered();
  await sessionManager.stopSessionAgent(m2);
  check('a stop', !store.get(m2)!.restore);
  const m3 = await offered();
  sessionManager.updateAnnotations(m3, { cleanup: true });
  check('marking for cleanup', !store.get(m3)!.restore);
  const m4 = await offered();
  sessionManager.dismissRestore(m4);
  check('dismiss', !store.get(m4)!.restore && !summary(m4)?.restore);
  const m5 = await offered();
  await sessionManager.forgetAgentSession(m5);
  check('setting the agent session aside', !store.get(m5)!.restore);
  const m6 = await offered();
  await sessionManager.setSessionAgent(m6, 'restoretest', 'small');
  check('switching the model or agent', !store.get(m6)!.restore);

  console.log('9. A failed restore keeps the offer, with the error');
  sessionManager.dismissAllRestores();
  const f = await offered();
  const goodEntry = AGENT_REGISTRY.restoretest;
  AGENT_REGISTRY.restoretest = { ...goodEntry, command: path.join(testAppDir, 'no-such-agent') };
  let failErr: any;
  await sessionManager.restoreSession(f).catch((err) => (failErr = err));
  AGENT_REGISTRY.restoretest = goodEntry;
  check('it throws', Boolean(failErr));
  const fs1 = summary(f);
  check('the offer stays with the error', Boolean(fs1?.restore?.error), fs1?.restore);
  check('not restoring any more, and no agent left behind', !fs1?.restoring && fs1?.isAgentRunning === false && !(sessionManager as any).startingHosts.has(f));
  sessionManager.dismissRestore(f);
  check('and can be dismissed', !summary(f)?.restore);

  console.log('9b. Restores that overlap, and a stop or switch during one');
  /** Slow every agent start down, so the next steps land while one is starting. */
  const slowStarts = (ms: number) => {
    const orig = AcpClientHost.prototype.start;
    AcpClientHost.prototype.start = async function (this: InstanceType<typeof AcpClientHost>) {
      await sleep(ms);
      return orig.call(this);
    };
    return () => (AcpClientHost.prototype.start = orig);
  };
  const isStarting = (id: string) => (sessionManager as any).startingHosts.has(id);
  const restoredNotes = (id: string) => notes(id).filter((n) => n.startsWith('▶️ Agent restored')).length;
  const dup = await offered();
  let undo = slowStarts(300);
  try {
    const first = sessionManager.restoreSession(dup);
    const second = sessionManager.restoreSession(dup);
    await sleep(100);
    check('still restoring while either restore runs', summary(dup)?.restoring === true);
    await Promise.all([first, second]);
  } finally {
    undo();
  }
  check('two restores at once add one restored note', restoredNotes(dup) === 1, notes(dup).slice(-3));
  check('and leave the agent running', summary(dup)?.isAgentRunning === true && !summary(dup)?.restoring);

  const viaStart = await offered();
  undo = slowStarts(300);
  try {
    const start = sessionManager.startSessionAgent(viaStart);
    await waitFor(() => isStarting(viaStart));
    await sessionManager.restoreSession(viaStart);
    await start;
  } finally {
    undo();
  }
  check('a restore during a Start joins it with no restored note', restoredNotes(viaStart) === 0 && summary(viaStart)?.isAgentRunning === true && !summary(viaStart)?.restore);

  const stopMid = await offered();
  undo = slowStarts(300);
  let stopErr: any;
  try {
    const run = sessionManager.restoreSession(stopMid).catch((err) => (stopErr = err));
    await waitFor(() => isStarting(stopMid));
    await sessionManager.stopSessionAgent(stopMid);
    await run;
  } finally {
    undo();
  }
  check('a stop during a restore ends it', Boolean(stopErr) && summary(stopMid)?.isAgentRunning === false);
  check('and the offer does not come back', !store.get(stopMid)!.restore && !summary(stopMid)?.restore, store.get(stopMid)!.restore);

  const switchMid = await offered();
  undo = slowStarts(300);
  try {
    const run = sessionManager.restoreSession(switchMid).catch(() => {});
    await waitFor(() => isStarting(switchMid));
    await sessionManager.setSessionAgent(switchMid, 'restoretest', 'small');
    await run;
  } finally {
    undo();
  }
  check('a switch during a restore leaves no offer', !store.get(switchMid)!.restore, store.get(switchMid)!.restore);

  console.log('10. Restore all, a few at a time');
  sessionManager.dismissAllRestores();
  const batch: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await newSession();
    await ask(id, `hello ${i}`);
    batch.push(id);
  }
  restart();
  const marked = store.get(batch[4])!;
  marked.user.cleanup = true;
  store.save(marked, { touch: false });
  check('the cleanup session is hidden from the summaries', !summary(batch[4])?.restore && Boolean(store.get(batch[4])!.restore));
  let running = 0;
  let maxRunning = 0;
  const origStart = AcpClientHost.prototype.start;
  AcpClientHost.prototype.start = async function (this: InstanceType<typeof AcpClientHost>) {
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      await sleep(150);
      return await origStart.call(this);
    } finally {
      running--;
    }
  };
  let all: Awaited<ReturnType<typeof sessionManager.restoreAllSessions>>;
  try {
    all = await sessionManager.restoreAllSessions();
  } finally {
    AcpClientHost.prototype.start = origStart;
  }
  check('at most 3 start at once', maxRunning <= 3 && maxRunning > 1, maxRunning);
  check('every offered session restored', all.restored.length === 4 && all.failed.length === 0 && batch.slice(0, 4).every((id) => all.restored.includes(id)), all);
  check('the cleanup session is untouched', summary(batch[4])?.isAgentRunning === false);

  console.log('11. HTTP');
  // Only the two sessions below have their agents running at the next restart
  restart();
  sessionManager.dismissAllRestores();
  const h1 = await newSession();
  await ask(h1, 'hi');
  const h2 = await newSession();
  await ask(h2, 'hi');
  restart();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, url: string) => {
    const res = await fetch(`${base}${url}`, { method });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const restoredAll = await call('POST', '/sessions/restore-all');
    check('POST restore-all', restoredAll.status === 200 && Array.isArray(restoredAll.body.restored) && Array.isArray(restoredAll.body.failed) && restoredAll.body.restored.length === 2, restoredAll);
    restart();
    const before = store.getAll().length;
    const dismissed = await call('DELETE', '/sessions/restore-all');
    check('DELETE restore-all dismisses', dismissed.status === 200 && dismissed.body.dismissed >= 2, dismissed);
    check('and deletes no session', store.getAll().length === before && Boolean(store.get(h1)) && Boolean(store.get(h2)));
    const none = await call('POST', `/sessions/${h1}/restore`);
    check('POST restore with no offer is 409', none.status === 409, none);
    const unknown = await call('POST', '/sessions/acp-nope/restore');
    check('POST restore of an unknown session is 404', unknown.status === 404, unknown);
    const h3 = await offered();
    const one = await call('POST', `/sessions/${h3}/restore`);
    check('POST restore starts it', one.status === 200 && one.body.session?.id === h3 && summary(h3)?.isAgentRunning === true, one.status);
    const dismissOne = await call('DELETE', `/sessions/${h1}/restore`);
    check('DELETE restore', dismissOne.status === 200 && dismissOne.body.ok === true, dismissOne);
    const dismissUnknown = await call('DELETE', '/sessions/acp-nope/restore');
    check('DELETE restore of an unknown session is 404', dismissUnknown.status === 404, dismissUnknown);
  } finally {
    server.close();
  }
}

try {
  await main();
} catch (err) {
  failures++;
  console.error(err);
} finally {
  sessionManager.shutdown();
  fs.rmSync(testAppDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} restore check(s) failed`);
  process.exit(1);
}
console.log('\nAll restore checks passed');
process.exit(0);
