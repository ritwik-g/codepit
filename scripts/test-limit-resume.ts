import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * Resuming later: Claude's usage-limit messages and reset times are read right; a turn
 * stopped on the 5-hour limit is resumed at the reset under "Auto", offered under "Ask" and
 * left alone under "Off" or on a weekly limit; every due session resumes at once; a message
 * of the user's own replaces the resume; repeated limit hits stop resuming by themselves;
 * a manual pause stops the running turn and sends the user's message at their time; and the
 * HTTP routes. Runs against a scripted agent.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-limit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
const stateDir = path.join(testAppDir, 'agent-state');
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
// The /usage probe must not run the real claude
process.env.CODEPIT_CLAUDE_USAGE_CMD = 'echo';
fs.mkdirSync(stateDir, { recursive: true });

const { parseUsageLimit, parseResetTime, decideLimitResume, parseScheduleRequest, readLimitResumeMode, RESUME_PROMPT, RESUME_BUFFER_MS, MAX_LIMIT_STREAK } = await import('../server/limit-resume.js');
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { AGENT_REGISTRY } = await import('../server/agents/registry.js');
const { store } = await import('../server/store.js');
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
AGENT_REGISTRY.limittest = {
  id: 'limittest',
  name: 'Limit test agent',
  provider: 'mock' as const,
  description: 'Scripted agent for test-limit-resume',
  command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
  args: [path.join(here, 'lib/effort-test-agent.ts')],
  env: { EFFORT_TEST_STATE_DIR: stateDir },
  icon: 'mock',
  defaultModel: 'big',
  availableModels: ['big', 'small'],
  efforts: [],
} as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const HOUR = 60 * MIN;

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

async function newSession(): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-limit-ws-'));
  return (await sessionManager.createSession({ agentId: 'limittest', cwd, model: 'big' })).id;
}

async function send(id: string, text: string): Promise<void> {
  await sessionManager.sendPrompt(id, text);
  await waitForIdle(id);
}

const resumeOf = (id: string) => store.get(id)!.scheduledResume ?? null;
const summary = (id: string) => sessionManager.listSessions().find((s) => s.id === id);
const lastOf = (id: string, role: string) => [...store.get(id)!.turns].reverse().find((t) => t.role === role);

function pure(): void {
  console.log('1. Claude\'s limit messages and reset times');
  const now = Date.parse('2026-10-07T10:00:00Z');
  const five = parseUsageLimit("Internal error: You've hit your session limit · resets 3:40pm (UTC)", now);
  check('the 5-hour message is a five_hour limit', five?.window === 'five_hour', five);
  check('its reset is today at 15:40 UTC', five?.resetsAt === Date.parse('2026-10-07T15:40:00Z'), five?.resetsAt && new Date(five.resetsAt).toISOString());
  check('"Internal error: " is left out of the message', five?.message.startsWith("You've hit your session limit") === true, five?.message);
  const weekly = parseUsageLimit("You've hit your weekly limit · resets Oct 9, 10am (Europe/Paris)", now);
  check('the weekly message is weekly', weekly?.window === 'weekly', weekly);
  check('a dated reset in another zone', weekly?.resetsAt === Date.parse('2026-10-09T08:00:00Z'), weekly?.resetsAt && new Date(weekly.resetsAt).toISOString());
  check('a per-model limit is weekly', parseUsageLimit("You've hit your Opus limit · resets Oct 9, 10am", now)?.window === 'weekly');
  check('out of credits is not a timed limit', parseUsageLimit("You're out of usage credits", now)?.window === 'credits');
  const old = parseUsageLimit('Claude AI usage limit reached|1791398400', now);
  check('the old "|<epoch>" form', old?.resetsAt === 1791398400 * 1000 && old.window === 'unknown', old);
  check('another error is not a limit', parseUsageLimit('Internal error: connection reset', now) === null);
  check('a time already past today is tomorrow\'s', parseResetTime('9am (UTC)', now) === Date.parse('2026-10-08T09:00:00Z'));
  check('"Oct 4 at 3:30pm (Asia/Calcutta)", the /usage form', parseResetTime('Oct 4 at 3:30pm (Asia/Calcutta)', now) === Date.parse('2026-10-04T10:00:00Z'));
  check('an unknown zone falls back to the default', parseResetTime('3pm (Not/AZone)', now, 'UTC') === Date.parse('2026-10-07T15:00:00Z'));
  check('Jan in late December is next year', parseResetTime('Jan 2, 9am (UTC)', Date.parse('2026-12-30T10:00:00Z')) === Date.parse('2027-01-02T09:00:00Z'));
  check('no time, nothing', parseResetTime('soon', now) === undefined);
  const twoLines = parseUsageLimit("You've hit your session limit · resets 3pm (UTC)\n/upgrade to increase your usage limit.", now);
  check('a reset on a line before others', twoLines?.resetsAt === Date.parse('2026-10-07T15:00:00Z'), twoLines);

  console.log('2. What a limit hit leads to');
  const hit = five!;
  const auto = decideLimitResume({ hit, mode: 'auto', now, streak: 0 });
  check('Auto: armed, a minute past the reset', auto?.armed === true && auto.at === hit.resetsAt! + RESUME_BUFFER_MS && auto.reason === 'limit' && auto.prompt === RESUME_PROMPT, auto);
  const askd = decideLimitResume({ hit, mode: 'ask', now, streak: 0 });
  check('Ask: offered, not armed', askd?.armed === false && askd.at === auto?.at, askd);
  check('Off: nothing', decideLimitResume({ hit, mode: 'off', now, streak: 0 }) === null);
  check('weekly: nothing', decideLimitResume({ hit: weekly!, mode: 'auto', now, streak: 0 }) === null);
  const eventReset = now + 2 * HOUR;
  const fromEvent = decideLimitResume({ hit: { window: 'unknown', message: 'usage limit reached' }, mode: 'auto', now, streak: 0, rejected: { type: 'five_hour', resetsAt: eventReset, seenAt: now } });
  check('the rate-limit event names the window and the reset', fromEvent?.armed === true && fromEvent.resetsAt === eventReset, fromEvent);
  check('an unnamed limit resetting in days is not the 5-hour one', decideLimitResume({ hit: { window: 'unknown', message: 'usage limit reached', resetsAt: now + 3 * 24 * HOUR }, mode: 'auto', now, streak: 0 }) === null);
  const stale = decideLimitResume({ hit: { window: 'five_hour', message: "You've hit your session limit" }, mode: 'auto', now, streak: 0, fiveHourResetsAt: now - MIN });
  check('a reset already past is not used: offered with no time', stale?.armed === false && stale.at === undefined && Boolean(stale.note), stale);
  const fromUsage = decideLimitResume({ hit: { window: 'five_hour', message: "You've hit your session limit" }, mode: 'auto', now, streak: 0, fiveHourResetsAt: now + HOUR });
  check('the /usage reset is the fallback', fromUsage?.armed === true && fromUsage.resetsAt === now + HOUR, fromUsage);
  const streaked = decideLimitResume({ hit, mode: 'auto', now, streak: MAX_LIMIT_STREAK });
  check(`after ${MAX_LIMIT_STREAK} limit resumes in a row it waits for the user`, streaked?.armed === false && /hit the limit again/.test(streaked.note || ''), streaked);

  console.log('3. A pause request');
  check('a time and a message', JSON.stringify(parseScheduleRequest({ at: now + HOUR, prompt: '  go on ' }, now)) === JSON.stringify({ at: now + HOUR, prompt: 'go on' }));
  check('no message: the default', (parseScheduleRequest({ at: now + HOUR }, now) as any).prompt === RESUME_PROMPT);
  check('a past time is refused', 'error' in parseScheduleRequest({ at: now - HOUR }, now));
  check('over 30 days is refused', 'error' in parseScheduleRequest({ at: now + 31 * 24 * HOUR }, now));
  check('not a number is refused', 'error' in parseScheduleRequest({ at: 'tomorrow' }, now));
}

async function main(): Promise<void> {
  pure();
  sessionManager.init();

  console.log('4. Auto: the turn stopped on the limit resumes at the reset');
  check('the default is Ask', readLimitResumeMode() === 'ask');
  sessionManager.setLimitResumeMode('auto');
  const a = await newSession();
  const resetA = Date.now() + 2 * HOUR;
  await send(a, `do the work hit-limit:${resetA}`);
  const ra = resumeOf(a);
  check('a resume is armed for a minute past the reset', ra?.armed === true && ra.reason === 'limit' && ra.at === resetA + RESUME_BUFFER_MS, ra);
  check('Claude\'s message is kept', /session limit/.test(ra?.limitMessage || ''), ra?.limitMessage);
  check('the error still shows in the conversation', /hit your session limit/.test(lastOf(a, 'agent')?.content || ''));
  check('the summary carries it for the sidebar', summary(a)?.scheduledResume?.at === ra?.at);
  check('nothing is sent before its time', sessionManager.runDueResumes(resetA).length === 0 && !sessionManager.isTurnInFlight(a));

  const b = await newSession();
  await send(b, `hit-limit:${resetA}`);
  const resumed = sessionManager.runDueResumes(resetA + RESUME_BUFFER_MS + 1);
  check('every due session resumes at once', resumed.includes(a) && resumed.includes(b), resumed);
  await waitForIdle(a);
  await waitForIdle(b);
  check('the resume is gone once sent', resumeOf(a) === null && summary(a)?.scheduledResume === null);
  const turnsA = store.get(a)!.turns;
  const userA = lastOf(a, 'user');
  check('a note says why it resumed', turnsA.some((t) => t.role === 'system' && /usage limit reset/.test(t.content || '')));
  check('"Continue" was sent and answered', userA?.content === RESUME_PROMPT && /seen=2/.test(lastOf(a, 'agent')?.content || ''), lastOf(a, 'agent')?.content);
  check('a clean turn resets the streak', !store.get(a)!.limitResumeStreak);

  console.log('5. Hitting the limit again straight away stops resuming by itself');
  const c = await newSession();
  for (let i = 1; i <= MAX_LIMIT_STREAK; i++) {
    await send(c, `hit-limit:${resetA}`);
    if (i < MAX_LIMIT_STREAK) {
      check(`hit ${i}: still armed`, resumeOf(c)?.armed === true, resumeOf(c));
      sessionManager.runDueResumes(resetA + RESUME_BUFFER_MS + 1);
      await waitForIdle(c);
    }
  }
  // The resumed "Continue" ends cleanly in the scripted agent, so fake resumes that hit the limit at once
  const sc = store.get(c)!;
  sc.limitResumeStreak = MAX_LIMIT_STREAK - 1;
  sc.limitResumeSentAt = Date.now();
  store.save(sc, { touch: false });
  await send(c, `hit-limit:${resetA}`);
  check('offered, not armed, after hitting it again straight away', resumeOf(c)?.armed === false && /again/.test(resumeOf(c)?.note || ''), resumeOf(c));
  const sl = store.get(c)!;
  sl.limitResumeStreak = MAX_LIMIT_STREAK - 1;
  sl.limitResumeSentAt = Date.now() - 4 * HOUR;
  store.save(sl, { touch: false });
  await send(c, `hit-limit:${resetA}`);
  check('a limit hit after hours of work is a new window: armed again', resumeOf(c)?.armed === true && !store.get(c)!.limitResumeStreak, resumeOf(c));
  sessionManager.cancelScheduledResume(c);

  console.log('6. Ask, Off, a weekly limit, and a message of the user\'s own');
  sessionManager.setLimitResumeMode('ask');
  const d = await newSession();
  await send(d, `hit-limit:${resetA}`);
  const rd = resumeOf(d);
  check('Ask: offered with the reset time, not armed', rd?.armed === false && rd.at === resetA + RESUME_BUFFER_MS, rd);
  check('an unarmed one is never sent', sessionManager.runDueResumes(resetA + 10 * HOUR).length === 0);
  await sessionManager.scheduleResume(d, rd!.at!, RESUME_PROMPT);
  check('saying yes arms it and keeps Claude\'s message', resumeOf(d)?.armed === true && resumeOf(d)?.reason === 'limit' && Boolean(resumeOf(d)?.limitMessage), resumeOf(d));
  await send(d, 'my own message');
  check('a message of the user\'s own replaces it', resumeOf(d) === null);

  const e = await newSession();
  await send(e, `hit-limit:${resetA}`);
  sessionManager.setLimitResumeMode('auto');
  check('switching to Auto arms a waiting offer', resumeOf(e)?.armed === true, resumeOf(e));
  sessionManager.setLimitResumeMode('off');
  check('switching to Off drops it', resumeOf(e) === null);
  await send(e, `hit-limit:${resetA}`);
  check('Off: nothing kept', resumeOf(e) === null);
  sessionManager.setLimitResumeMode('auto');
  await send(e, 'hit-weekly');
  check('a weekly limit is not resumed', resumeOf(e) === null && /weekly limit/.test(lastOf(e, 'agent')?.content || ''));

  console.log('6b. A stop, a switch away or cleanup drops the resume; Ask after the reset');
  const st = await newSession();
  await send(st, `hit-limit:${resetA}`);
  await sessionManager.stopSessionAgent(st);
  check('Stop drops it', resumeOf(st) === null);
  const cl = await newSession();
  await send(cl, `hit-limit:${resetA}`);
  const scl = store.get(cl)!;
  scl.user.cleanup = true;
  store.save(scl, { touch: false });
  check('a session marked for cleanup is not resumed', !sessionManager.runDueResumes(resetA + 10 * HOUR).includes(cl));
  scl.user.cleanup = false;
  store.save(scl, { touch: false });
  sessionManager.cancelScheduledResume(cl);
  sessionManager.setLimitResumeMode('ask');
  const late = await newSession();
  await send(late, `hit-limit:${Date.now() + 2000}`);
  const rl = resumeOf(late);
  check('Ask: offered, not armed', rl?.armed === false && rl.at !== undefined, rl);
  sessionManager.resumeNow(late);
  await waitForIdle(late);
  check('Resume now sends an offer not yet agreed to', lastOf(late, 'user')?.content === RESUME_PROMPT && resumeOf(late) === null);
  sessionManager.setLimitResumeMode('auto');

  console.log('6c. A few agents start per tick');
  const many: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await newSession();
    await send(id, `hit-limit:${resetA}`);
    await sessionManager.stopSessionAgent(id);
    // Stop drops the resume: put one back on the stopped session, as a restart would leave it
    const sm = store.get(id)!;
    sm.scheduledResume = { reason: 'manual', at: Date.now(), armed: true, prompt: 'go', createdAt: Date.now() };
    sm.agentStopped = false;
    store.save(sm, { touch: false });
    many.push(id);
  }
  const first = sessionManager.runDueResumes(Date.now() + 1);
  check('three agents started on the first tick', first.length === 3, first);
  for (const id of first) await waitForIdle(id);
  const second = sessionManager.runDueResumes(Date.now() + 1);
  check('the rest on the next', second.length === 2 && [...first, ...second].sort().join() === [...many].sort().join(), second);
  for (const id of second) await waitForIdle(id);

  console.log('7. Pause and resume at a picked time');
  const f = await newSession();
  void sessionManager.sendPrompt(f, 'slow-turn please').catch(() => {});
  check('the turn is running', await waitFor(() => sessionManager.isTurnInFlight(f) && store.get(f)!.state === 'working'));
  await sleep(200);
  const at = Date.now() + HOUR;
  await sessionManager.scheduleResume(f, at, 'go on with the plan');
  check('pausing stops the turn', !sessionManager.isTurnInFlight(f) && store.get(f)!.state === 'needs_you');
  const rf = resumeOf(f);
  check('a manual resume is armed at the picked time', rf?.reason === 'manual' && rf.armed && rf.at === at && rf.prompt === 'go on with the plan', rf);
  check('a note says it was paused', store.get(f)!.turns.some((t) => t.role === 'system' && /^Paused/.test(t.content || '')));
  sessionManager.cancelScheduledResume(f);
  check('cancel drops it', resumeOf(f) === null);
  await sessionManager.scheduleResume(f, Date.now() + HOUR, 'go on with the plan');
  sessionManager.resumeNow(f);
  await waitForIdle(f);
  check('Resume now sends the message', lastOf(f, 'user')?.content === 'go on with the plan' && resumeOf(f) === null);

  console.log('8. A resume survives a restart and is sent when due');
  const g = await newSession();
  await sessionManager.scheduleResume(g, Date.now() + HOUR, 'after restart');
  sessionManager.shutdown();
  sessionManager.init();
  check('still there after the restart', resumeOf(g)?.prompt === 'after restart');
  sessionManager.runDueResumes(Date.now() + 2 * HOUR);
  await waitFor(() => lastOf(g, 'user')?.content === 'after restart');
  await waitForIdle(g);
  check('sent when due, starting the agent again', /seen=\d/.test(lastOf(g, 'agent')?.content || ''), lastOf(g, 'agent')?.content);

  console.log('9. HTTP routes');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    check('GET the setting', (await call('GET', '/settings/limit-resume')).body.mode === 'auto');
    check('PUT a bad setting is 400', (await call('PUT', '/settings/limit-resume', { mode: 'sometimes' })).status === 400);
    const put = await call('PUT', '/settings/limit-resume', { mode: 'ask' });
    check('PUT the setting', put.status === 200 && put.body.mode === 'ask' && readLimitResumeMode() === 'ask', put);
    const h = await newSession();
    const past = await call('PUT', `/sessions/${h}/scheduled-resume`, { at: Date.now() - HOUR });
    check('a past time is 400', past.status === 400, past);
    const unknown = await call('PUT', '/sessions/acp-nope/scheduled-resume', { at: Date.now() + HOUR });
    check('an unknown session is 404', unknown.status === 404, unknown);
    const ok = await call('PUT', `/sessions/${h}/scheduled-resume`, { at: Date.now() + HOUR });
    check('PUT schedules with the default message', ok.status === 200 && ok.body.scheduledResume?.prompt === RESUME_PROMPT, ok);
    const del = await call('DELETE', `/sessions/${h}/scheduled-resume`);
    check('DELETE cancels', del.status === 200 && resumeOf(h) === null, del);
    const none = await call('POST', `/sessions/${h}/scheduled-resume/now`);
    check('resume now with nothing waiting is 409', none.status === 409, none);
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
  console.log(`\n${failures} limit-resume check(s) failed`);
  process.exit(1);
}
console.log('\nAll limit-resume checks passed');
process.exit(0);
