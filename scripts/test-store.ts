import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Session writes are throttled: a save after a quiet spell goes to disk at once, saves
 * inside the next second fold into one write at its end, and nothing waiting is lost to
 * flush(), clear() (reload from disk) or process exit. `now: true` skips the wait. A deleted
 * session is not written back.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;

const { store } = await import('../server/store.js');
const { getSessionsDir } = await import('../server/paths.js');
type AcpSession = import('../server/types.js').AcpSession;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.log(`   FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileOf = (id: string) => path.join(getSessionsDir(), `${id}.json`);
const onDisk = (id: string): AcpSession | null => {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
};

function makeSession(id: string, title: string): AcpSession {
  const now = Date.now();
  return {
    id,
    agentId: 'mock',
    agentName: 'Mock',
    title,
    cwd: testAppDir,
    startedAt: now,
    updatedAt: now,
    turns: [],
    user: {},
  } as unknown as AcpSession;
}

try {
  console.log('Session writes are throttled');
  store.clear();

  const s = makeSession('acp-store-a', 'v0');
  store.save(s);
  check('the first save is written at once', onDisk(s.id)?.title === 'v0', onDisk(s.id)?.title);

  for (let i = 1; i <= 20; i++) {
    s.title = `v${i}`;
    store.save(s);
  }
  check('saves inside the interval wait', onDisk(s.id)?.title === 'v0', onDisk(s.id)?.title);
  check('the session in memory is current', store.get(s.id)?.title === 'v20');
  await sleep(1200);
  check('they are folded into one write with the latest state', onDisk(s.id)?.title === 'v20', onDisk(s.id)?.title);

  await sleep(1100);
  s.title = 'after-quiet';
  store.save(s);
  check('a save after a quiet spell is written at once', onDisk(s.id)?.title === 'after-quiet', onDisk(s.id)?.title);

  s.title = 'flushed';
  store.save(s);
  check('a save right after one waits', onDisk(s.id)?.title === 'after-quiet');
  store.flush();
  check('flush() writes what is waiting', onDisk(s.id)?.title === 'flushed', onDisk(s.id)?.title);

  s.title = 'waiting';
  store.save(s);
  s.title = 'now';
  store.save(s, { now: true });
  check('now: true writes at once, inside the interval', onDisk(s.id)?.title === 'now', onDisk(s.id)?.title);
  await sleep(1200);
  check('and leaves no older write waiting behind it', onDisk(s.id)?.title === 'now', onDisk(s.id)?.title);

  s.title = 'before-reload';
  store.save(s);
  store.clear();
  check('clear() writes what is waiting before reloading from disk', store.get(s.id)?.title === 'before-reload', store.get(s.id)?.title);

  const b = makeSession('acp-store-b', 'b0');
  store.save(b);
  b.title = 'b1';
  store.save(b);
  store.delete(b.id);
  await sleep(1200);
  check('a deleted session is not written back', !fs.existsSync(fileOf(b.id)));
} finally {
  fs.rmSync(testAppDir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} store check(s) failed`);
  process.exit(1);
}
console.log('\nAll store checks passed');
