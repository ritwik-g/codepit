/**
 * Reading PATH from the login shell at app start: a slow shell must not leave the app
 * on a short guess for good. Uses a stub shell; never runs your real one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-shell-path-'));
const home = path.join(dir, 'home');
const nvm = path.join(dir, 'nvm');
for (const v of ['v18.20.8', 'v22.9.0', 'v22.23.1', 'v24.21.0']) fs.mkdirSync(path.join(nvm, 'versions', 'node', v, 'bin'), { recursive: true });
fs.mkdirSync(path.join(nvm, 'alias'), { recursive: true });
fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
process.env.HOME = home;
process.env.NVM_DIR = nvm;

// The stub "shell" prints STUB_PATH between the markers after STUB_DELAY seconds
const shell = path.join(dir, 'stub-shell');
fs.writeFileSync(shell, '#!/bin/sh\nsleep "${STUB_DELAY:-0}"\nprintf \'motd noise\\n__CT_PATH__%s__CT_PATH__\' "$STUB_PATH"\n', { mode: 0o755 });
process.env.SHELL = shell;

const { adoptLoginShellPath, nvmDefaultBin } = await import('../electron/shell-path.js');
const saved = path.join(dir, 'app', 'shell-path.txt');
const given = '/usr/bin:/bin';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await test("nvm's default Node is found from its alias, newest match first", () => {
  fs.writeFileSync(path.join(nvm, 'alias', 'default'), '22\n');
  assert.equal(nvmDefaultBin(), path.join(nvm, 'versions', 'node', 'v22.23.1', 'bin'));
  fs.writeFileSync(path.join(nvm, 'alias', 'default'), 'v18.20.8');
  assert.equal(nvmDefaultBin(), path.join(nvm, 'versions', 'node', 'v18.20.8', 'bin'));
  fs.writeFileSync(path.join(nvm, 'alias', 'default'), 'node');
  assert.equal(nvmDefaultBin(), path.join(nvm, 'versions', 'node', 'v24.21.0', 'bin'));
  fs.rmSync(path.join(nvm, 'alias', 'default'));
  assert.equal(nvmDefaultBin(), path.join(nvm, 'versions', 'node', 'v24.21.0', 'bin'));
});

await test('a shell that answers gives its PATH, ahead of the one the app was given, and it is saved', async () => {
  process.env.PATH = given;
  process.env.STUB_PATH = '/shell/a:/shell/nvm/bin';
  process.env.STUB_DELAY = '0';
  assert.equal(await adoptLoginShellPath({ timeoutMs: 3000, savedPathFile: saved }), 'shell');
  assert.equal(process.env.PATH, '/shell/a:/shell/nvm/bin:/usr/bin:/bin');
  assert.equal(fs.readFileSync(saved, 'utf8').trim(), '/shell/a:/shell/nvm/bin');
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
});

await test('a slow shell: the saved PATH is used at once, and the shell PATH once it answers', async () => {
  process.env.PATH = given;
  process.env.STUB_PATH = '/shell/b:/shell/nvm/bin';
  process.env.STUB_DELAY = '1';
  const started = Date.now();
  assert.equal(await adoptLoginShellPath({ timeoutMs: 300, retryTimeoutMs: 5000, savedPathFile: saved }), 'saved');
  assert.ok(Date.now() - started < 1000, 'startup waited no longer than the first timeout');
  assert.equal(process.env.PATH, '/shell/a:/shell/nvm/bin:/usr/bin:/bin');
  await wait(1800);
  assert.equal(process.env.PATH, '/shell/b:/shell/nvm/bin:/usr/bin:/bin');
  assert.equal(fs.readFileSync(saved, 'utf8').trim(), '/shell/b:/shell/nvm/bin');
});

await test("nothing saved and no answer: common locations plus nvm's Node, never just the launchd PATH", async () => {
  fs.rmSync(saved);
  fs.writeFileSync(path.join(nvm, 'alias', 'default'), '22');
  process.env.PATH = given;
  process.env.STUB_DELAY = '5';
  assert.equal(await adoptLoginShellPath({ timeoutMs: 200, retryTimeoutMs: 200, savedPathFile: saved }), 'fallback');
  const dirs = process.env.PATH!.split(':');
  assert.ok(dirs.includes(path.join(nvm, 'versions', 'node', 'v22.23.1', 'bin')), process.env.PATH);
  assert.ok(dirs.includes(path.join(home, '.local', 'bin')), process.env.PATH);
  assert.deepEqual(dirs.slice(-2), ['/usr/bin', '/bin']);
  await wait(400); // the second try gives up too, and changes nothing
  assert.ok(process.env.PATH!.includes('v22.23.1'));
  assert.equal(fs.existsSync(saved), false);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
process.exit(0);
