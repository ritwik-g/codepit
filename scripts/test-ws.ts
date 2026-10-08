import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';

/**
 * The event socket does not queue without bound for a client that stops reading: once the
 * client is WS_MAX_BUFFERED behind it is dropped (it reconnects and refetches), while a
 * client that keeps up gets every event. Before this, a phone asleep on the LAN held every
 * event of a busy session in CodePit's memory until the process ran out of heap.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
fs.mkdirSync(testAppDir, { recursive: true });

const { startServer } = await import('../server/server.js');
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { WS_MAX_BUFFERED } = await import('../server/ws.js');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.log(`   FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const handle = await startServer({ port: 0 });
  const url = `ws://127.0.0.1:${handle.port}/ws`;

  const open = async () => {
    const ws = new WebSocket(url);
    const got: string[] = [];
    let closed = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'sessionStream' && msg.event === 'wsTest') got.push(msg.text);
    });
    ws.on('close', () => (closed = true));
    ws.on('error', () => {});
    await new Promise((r) => ws.once('open', r));
    return { ws, got, isClosed: () => closed };
  };

  console.log('1. A client that stops reading is dropped; one that keeps up gets everything');
  const healthy = await open();
  const stalled = await open();
  await sleep(100);
  // Stops reading: what the server sends piles up in its socket
  (stalled.ws as any)._socket.pause();

  const chunk = 'x'.repeat(1024 * 1024);
  const count = Math.ceil((WS_MAX_BUFFERED * 2) / chunk.length);
  for (let i = 0; i < count; i++) {
    sessionManager.emit('sessionStream', { sessionId: 'ws-test', type: 'wsTest', text: `${i}:${chunk}` });
    await sleep(5);
  }
  const deadline = Date.now() + 10_000;
  while (healthy.got.length < count && Date.now() < deadline) await sleep(50);
  check('the healthy client got every event', healthy.got.length === count, { got: healthy.got.length, count });
  check('and is still connected', !healthy.isClosed());

  (stalled.ws as any)._socket.resume();
  const closeDeadline = Date.now() + 10_000;
  while (!stalled.isClosed() && Date.now() < closeDeadline) await sleep(50);
  check('the stalled client was dropped', stalled.isClosed());
  check('before the server queued everything for it', stalled.got.length < count, { got: stalled.got.length, count });

  healthy.ws.close();
  await handle.close();
}

try {
  await main();
} finally {
  fs.rmSync(testAppDir, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`\n${failures} ws check(s) failed`);
  process.exit(1);
}
console.log('\nAll ws checks passed');
process.exit(0);
