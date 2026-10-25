import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * Stopping idle agents: an agent unused for the setting's hours is stopped, keeps its place
 * in the list and starts again on the next message; one in a turn, waiting on the user, with
 * a resume scheduled or used recently is left running; Never stops nothing; and the HTTP
 * routes. Runs against a scripted agent.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-idle-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
const stateDir = path.join(testAppDir, 'agent-state');
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
process.env.CODEPIT_CLAUDE_USAGE_CMD = 'echo';
fs.mkdirSync(stateDir, { recursive: true });

const { readIdleStopHours, DEFAULT_IDLE_STOP_HOURS, IDLE_STOPS_PER_TICK } = await import('../server/idle-stop.js');
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { readEvents } = await import('../server/event-log.js');
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
AGENT_REGISTRY.idletest = {
  id: 'idletest',
  name: 'Idle test agent',
  provider: 'mock' as const,
  description: 'Scripted agent for test-idle-stop',
  command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
  args: [path.join(here, 'lib/effort-test-agent.ts')],
  env: { EFFORT_TEST_STATE_DIR: stateDir },
  icon: 'mock',
  defaultModel: 'big',
  availableModels: ['big', 'small'],
  efforts: [],
} as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

async function waitForIdle(id: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (sessionManager.isTurnInFlight(id)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for session ${id} to go idle`);
    await sleep(50);
  }
}

async function newSession(): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-idle-ws-'));
  const id = (await sessionManager.createSession({ agentId: 'idletest', cwd, model: 'big' })).id;
  await sessionManager.sendPrompt(id, 'hello');
  await waitForIdle(id);
  return id;
}

const hosts = () => (sessionManager as any).activeHosts as Map<string, { lastActivityAt: number }>;
const running = (id: string) => hosts().has(id);
/** Make the agent look unused for this many hours. */
const age = (id: string, hours: number) => {
  hosts().get(id)!.lastActivityAt = Date.now() - hours * HOUR;
};

async function main(): Promise<void> {
  console.log('1. The setting');
  check(`defaults to ${DEFAULT_IDLE_STOP_HOURS} hours`, readIdleStopHours() === DEFAULT_IDLE_STOP_HOURS);

  console.log('2. Which agents are stopped');
  const old = await newSession();
  const recent = await newSession();
  const asking = await newSession();
  const scheduled = await newSession();
  for (const id of [old, asking, scheduled]) age(id, 49);
  age(recent, 47);
  const stateBefore = store.get(old)!.state;
  const updatedBefore = store.get(old)!.updatedAt;
  store.get(asking)!.pendingPermission = { title: 'Run a command?' } as any;
  await sessionManager.scheduleResume(scheduled, Date.now() + HOUR, "carry on");

  check('Never stops nothing', (await sessionManager.stopIdleAgents(Date.now(), 0)).length === 0 && running(old));
  const stopped = await sessionManager.stopIdleAgents(Date.now(), 48);
  check('the agent unused for 49h is stopped', stopped.includes(old) && !running(old), stopped);
  check('one used 47h ago is left running', !stopped.includes(recent) && running(recent));
  check('one waiting on a permission answer is left running', !stopped.includes(asking) && running(asking));
  check('one with a resume scheduled is left running', !stopped.includes(scheduled) && running(scheduled));

  const s = store.get(old)!;
  check('it keeps its state rather than being parked', s.state === stateBefore && !s.agentStopped, { state: s.state, agentStopped: s.agentStopped });
  check('it keeps its place in the recency ranking', s.updatedAt === updatedBefore);
  check('it is no longer marked running', s.isAgentRunning === false);
  const note = s.turns[s.turns.length - 1];
  check('the transcript says why', note.role === 'system' && /after 2 days without use/.test(note.content ?? ''), note.content);

  const stopEvent = readEvents({ sessionId: old }).find((e) => e.kind === 'agent.stopped');
  check('the event log records it', stopEvent?.reason === 'idle' && stopEvent.idleHours === 48, stopEvent);

  console.log('3. The next message starts it again');
  await sessionManager.sendPrompt(old, 'back again');
  await waitForIdle(old);
  check('the agent runs again', running(old));
  check('and the reply came back', store.get(old)!.turns.some((t) => t.role === 'agent' && t.timestamp > note.timestamp));

  console.log('4. A few per poll');
  store.get(asking)!.pendingPermission = null;
  const extra = [await newSession(), await newSession(), await newSession()];
  for (const id of [...extra, asking, recent]) age(id, 100);
  const firstTick = await sessionManager.stopIdleAgents(Date.now(), 48);
  check(`at most ${IDLE_STOPS_PER_TICK} per poll`, firstTick.length === IDLE_STOPS_PER_TICK, firstTick);
  const secondTick = await sessionManager.stopIdleAgents(Date.now(), 48);
  check('the rest on the next poll', firstTick.length + secondTick.length === 5, secondTick);

  console.log('5. HTTP routes');
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
    const got = await call('GET', '/settings/idle-stop');
    check('GET the setting and its choices', got.body.hours === 48 && got.body.choices.includes(0), got);
    check('PUT an hour not on the list is 400', (await call('PUT', '/settings/idle-stop', { hours: 5 })).status === 400);
    check('PUT a string is 400', (await call('PUT', '/settings/idle-stop', { hours: '24' })).status === 400);
    const put = await call('PUT', '/settings/idle-stop', { hours: 24 });
    check('PUT the setting', put.status === 200 && put.body.hours === 24 && readIdleStopHours() === 24, put);
    check('PUT Never', (await call('PUT', '/settings/idle-stop', { hours: 0 })).body.hours === 0 && readIdleStopHours() === 0);
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
  console.log(`\n${failures} idle-stop check(s) failed`);
  process.exit(1);
}
console.log('\nAll idle-stop checks passed');
process.exit(0);
