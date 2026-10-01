import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stub `claude -p "/usage"`: prints the report from a file and counts its runs
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-usage-'));
const report = path.join(dir, 'report.txt');
const runs = path.join(dir, 'runs.txt');
const writeReport = (session: number) =>
  fs.writeFileSync(
    report,
    'You are currently using your subscription to power your Claude Code usage\n\n' +
      `Current session: ${session}% used · resets Oct 1 at 9:10pm (Asia/Calcutta)\n` +
      'Current week (all models): 82% used · resets Oct 4 at 3:30pm (Asia/Calcutta)\n' +
      'Current week (Fable): 30% used · resets Oct 4 at 3:29pm (Asia/Calcutta)\n'
  );
writeReport(15);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = path.join(dir, 'app');
process.env.CODEPIT_CLAUDE_USAGE_CMD = `echo run >> '${runs}'; cat '${report}'`;

const { refreshClaudeRateLimitsAsync, updateClaudeRateLimitsFromSdk, getClaudeRateLimits, onClaudeRateLimitsChanged, formatResetTime } = await import(
  '../server/subscriptions.js'
);

const runCount = () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').length : 0);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

let heard = 0;
onClaudeRateLimitsChanged(() => heard++);
await wait(1500); // the startup read

await test('the startup read takes the numbers /usage reports, and says so', () => {
  const l = getClaudeRateLimits();
  assert.equal(runCount(), 1);
  assert.equal(l.fiveHour?.utilization, 15);
  assert.equal(l.fiveHour?.resetsAt, 'Oct 1 at 9:10pm (Asia/Calcutta)');
  assert.equal(l.weeklyAll?.utilization, 82);
  assert.deepEqual(l.weeklyModels?.map((m) => [m.name, m.utilization]), [['Fable', 30]]);
  assert.equal(heard, 1);
});

await test('an agent event without a percentage changes no number and does not count as fresh', () => {
  const before = getClaudeRateLimits().updatedAt;
  updateClaudeRateLimitsFromSdk({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: Date.parse('2026-10-01T15:40:00Z') / 1000 });
  updateClaudeRateLimitsFromSdk({ status: 'allowed', rateLimitType: 'seven_day_fable' });
  updateClaudeRateLimitsFromSdk({ status: 'allowed', rateLimitType: 'seven_day_overage_included', utilization: 0.5 });
  const l = getClaudeRateLimits();
  assert.equal(l.fiveHour?.utilization, 15);
  assert.equal(l.updatedAt, before);
  assert.deepEqual(l.weeklyModels?.map((m) => m.name), ['Fable']);
  assert.equal(heard, 1);
});

await test('an agent event with a percentage updates that window, with the reset time in the same format', () => {
  updateClaudeRateLimitsFromSdk({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.84, resetsAt: Date.parse('2026-10-04T10:00:00Z') / 1000 });
  const l = getClaudeRateLimits();
  assert.equal(l.weeklyAll?.utilization, 84);
  assert.equal(l.weeklyAll?.resetsAt, formatResetTime(Date.parse('2026-10-04T10:00:00Z')));
  assert.equal(heard, 2);
});

await test('reads are not repeated within five minutes, however often the numbers are asked for', async () => {
  for (let i = 0; i < 5; i++) {
    getClaudeRateLimits();
    updateClaudeRateLimitsFromSdk({ status: 'allowed', rateLimitType: 'five_hour' });
  }
  await wait(300);
  assert.equal(runCount(), 1);
});

await test('a refresh picks up a newer number and tells the listeners', async () => {
  writeReport(16);
  await refreshClaudeRateLimitsAsync();
  assert.equal(runCount(), 2);
  assert.equal(getClaudeRateLimits().fiveHour?.utilization, 16);
  assert.equal(heard, 3);
});

await test('reset times read like claude /usage writes them', () => {
  assert.equal(formatResetTime(Date.parse('2026-10-04T10:00:00Z'), 'UTC'), 'Oct 4 at 10:00am (UTC)');
  assert.equal(formatResetTime(Date.parse('2026-10-01T15:40:00Z'), 'Asia/Calcutta'), 'Oct 1 at 9:10pm (Asia/Calcutta)');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
process.exit(0);
