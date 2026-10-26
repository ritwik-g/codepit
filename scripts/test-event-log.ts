import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';

/**
 * The daily logs behind the event log and the MCP audit log: one file per day, days past a
 * week gzipped and still read, days past 60 deleted, the old single-file logs folded in,
 * and reads filtered by age, session and kind.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-events-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
const logs = path.join(testAppDir, 'logs');
fs.mkdirSync(logs, { recursive: true });

const { DailyLog } = await import('../server/daily-log.js');
const { logEvent, readEvents, categoryOf } = await import('../server/event-log.js');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.log(`   FAIL ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
const dayName = (daysAgo: number) => at(daysAgo).slice(0, 10);
const files = () => fs.readdirSync(logs).filter((f) => f.startsWith('t-')).sort();

try {
  console.log('1. One file per day');
  const log = new DailyLog<{ at: string; n: number }>('t', ['t.1.jsonl', 't.jsonl']);
  // The old single-file log, newest in t.jsonl and older in t.1.jsonl
  fs.writeFileSync(path.join(logs, 't.1.jsonl'), [at(70), at(20)].map((a, i) => JSON.stringify({ at: a, n: 100 + i })).join('\n') + '\n');
  fs.writeFileSync(path.join(logs, 't.jsonl'), JSON.stringify({ at: at(20), n: 102 }) + '\n' + 'torn{' + '\n');
  for (const d of [0, 0, 3, 8, 59, 61]) log.append({ at: at(d), n: d });
  check('a file per day', files().includes(`t-${dayName(0)}.jsonl`) && files().includes(`t-${dayName(8)}.jsonl`), files());
  check('owner-only', (fs.statSync(path.join(logs, `t-${dayName(0)}.jsonl`)).mode & 0o777) === 0o600);

  console.log('2. Tidying');
  log.tidy(now);
  const after = files();
  check('the old single-file log is folded in and removed', !fs.existsSync(path.join(logs, 't.jsonl')) && !fs.existsSync(path.join(logs, 't.1.jsonl')));
  check('days within a week stay plain', after.includes(`t-${dayName(0)}.jsonl`) && after.includes(`t-${dayName(3)}.jsonl`), after);
  check('days past a week are gzipped', after.includes(`t-${dayName(8)}.jsonl.gz`) && !after.includes(`t-${dayName(8)}.jsonl`) && after.includes(`t-${dayName(20)}.jsonl.gz`), after);
  check('days past 60 are deleted', !after.some((f) => f.includes(dayName(61)) || f.includes(dayName(70))), after);
  check('day 59 is kept', after.includes(`t-${dayName(59)}.jsonl.gz`), after);
  const gz = zlib.gunzipSync(fs.readFileSync(path.join(logs, `t-${dayName(20)}.jsonl.gz`))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l).n);
  check('a migrated day keeps its lines, in order, without torn ones', JSON.stringify(gz) === '[101,102]', gz);

  console.log('3. Reading');
  const all = log.read({ limit: 100 });
  check('newest first, across plain and gzipped days', JSON.stringify(all.map((e) => e.n)) === '[0,0,3,8,102,101,59]', all.map((e) => e.n));
  check('since a time', log.read({ since: now - 7 * DAY }).every((e) => Date.parse(e.at) >= now - 7 * DAY) && log.read({ since: now - 7 * DAY }).length === 3);
  check('a limit', log.read({ limit: 2 }).length === 2);
  check('a filter', log.read({ filter: (e) => e.n === 3 }).length === 1);

  console.log('4. The event log');
  logEvent({ kind: 'agent.stopped', session: { sessionId: 'acp-a', title: 'A' }, reason: 'Stopped by you' });
  logEvent({ kind: 'message.sent', via: 'codepit', from: { sessionId: 'acp-a' }, to: { sessionId: 'acp-b' }, delivery: 'started', preview: 'hi' });
  logEvent({ kind: 'setting.changed', setting: { name: 'x', from: 1, to: 2 } });
  check('kinds fall into categories', categoryOf('agent.started') === 'agents' && categoryOf('message.refused') === 'messages' && categoryOf('setting.changed') === 'sessions');
  check('by category', readEvents({ categories: ['agents'] }).every((e) => e.kind.startsWith('agent.')) && readEvents({ categories: ['agents'] }).length === 1);
  check('by session, either end of a message', readEvents({ sessionId: 'acp-b' }).length === 1 && readEvents({ sessionId: 'acp-a' }).length === 2);
  check('by age', readEvents({ sinceDays: 1 }).length === 3);
} catch (err) {
  failures++;
  console.error(err);
} finally {
  fs.rmSync(testAppDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} event-log check(s) failed`);
  process.exit(1);
}
console.log('\nAll event-log checks passed');
process.exit(0);
