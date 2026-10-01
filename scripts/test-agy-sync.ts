/**
 * Keeping CodePit's MCP servers in agy's own settings for Antigravity. Runs against
 * temporary files only (CODEPIT_AGY_MCP_CONFIG); never your real ~/.gemini.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-agy-sync-'));
const agyFile = path.join(dir, 'gemini', 'config', 'mcp_config.json');
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = path.join(dir, 'app');
process.env.CODEPIT_AGY_MCP_CONFIG = agyFile;

const { createMcpServer, updateMcpServer, setMcpServerEnabled, deleteMcpServer } = await import('../server/mcp/config.js');
const { syncAgyMcp } = await import('../server/mcp/agy-sync.js');

const readAgy = () => JSON.parse(fs.readFileSync(agyFile, 'utf8')).mcpServers as Record<string, any>;
const state = (status: ReturnType<typeof syncAgyMcp>, name: string) => status.entries.find((e) => e.name === name);
let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// What the user had in agy before: one server of their own, and one they added by hand from CodePit
fs.mkdirSync(path.dirname(agyFile), { recursive: true });
fs.writeFileSync(
  agyFile,
  JSON.stringify({
    mcpServers: {
      mine: { command: 'my-server', args: [], disabled: false },
      'codepit-memory': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: '/m.json' }, disabled: false },
      web: { serverUrl: 'https://other.example/mcp', disabled: false },
    },
    otherSetting: true,
  }),
  { mode: 0o644 }
);

const memory = createMcpServer({ name: 'codepit-memory', transport: 'stdio', enabled: true, scope: 'all', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: '/m.json' } });
const castai = createMcpServer({ name: 'CastAI', transport: 'http', enabled: true, scope: 'all', url: 'https://docs.cast.ai/mcp', headers: { 'x-readme-auth': 'secret-token' } });
const web = createMcpServer({ name: 'web', transport: 'http', enabled: true, scope: 'antigravity', url: 'https://mine.example/mcp' });
const fsServer = createMcpServer({ name: 'files', transport: 'stdio', enabled: true, scope: 'all', command: 'npx', args: ['server-filesystem', '${workspace}'] });
const sse = createMcpServer({ name: 'old-sse', transport: 'sse', enabled: true, scope: 'all', url: 'https://sse.example/sse' });
createMcpServer({ name: 'claude-only', transport: 'stdio', enabled: true, scope: 'claude', command: 'x' });
createMcpServer({ name: 'switched-off', transport: 'stdio', enabled: false, scope: 'all', command: 'y' });

test('servers for Antigravity are written in agy\'s own shape; the rest of the file is left alone', () => {
  const status = syncAgyMcp();
  assert.equal(status.error, undefined);
  const agy = readAgy();
  assert.deepEqual(agy.CastAI, { serverUrl: 'https://docs.cast.ai/mcp', headers: { 'x-readme-auth': 'secret-token' }, disabled: false });
  assert.deepEqual(agy.mine, { command: 'my-server', args: [], disabled: false });
  assert.equal(JSON.parse(fs.readFileSync(agyFile, 'utf8')).otherSetting, true);
  assert.equal(state(status, 'CastAI')?.state, 'synced');
  assert.equal(agy['claude-only'], undefined);
  assert.equal(agy['switched-off'], undefined);
});

test('an identical entry the user added by hand is adopted; a different one with the name is a clash, untouched', () => {
  const status = syncAgyMcp();
  assert.equal(state(status, 'codepit-memory')?.state, 'synced');
  assert.equal(state(status, 'web')?.state, 'conflict');
  assert.match(state(status, 'web')!.reason!, /didn't add/);
  assert.equal(readAgy().web.serverUrl, 'https://other.example/mcp');
});

test('SSE and ${workspace} servers are skipped, with the reason', () => {
  const status = syncAgyMcp();
  assert.equal(state(status, 'old-sse')?.state, 'skipped');
  assert.match(state(status, 'files')!.reason!, /\$\{workspace\}/);
  assert.equal(readAgy().files, undefined);
  assert.equal(readAgy()['old-sse'], undefined);
});

test('the file is made owner-only, since it now holds tokens', () => {
  assert.equal(fs.statSync(agyFile).mode & 0o777, 0o600);
});

test('switching a server off, renaming it or removing it takes it out of agy; the user\'s own entries stay', () => {
  setMcpServerEnabled(castai.id, false);
  syncAgyMcp();
  assert.equal(readAgy().CastAI, undefined);
  setMcpServerEnabled(castai.id, true);
  updateMcpServer(castai.id, { name: 'CastAI-docs' } as any);
  syncAgyMcp();
  assert.equal(readAgy().CastAI, undefined);
  assert.equal(readAgy()['CastAI-docs'].serverUrl, 'https://docs.cast.ai/mcp');
  deleteMcpServer(memory.id);
  syncAgyMcp();
  // It was adopted, so CodePit owns it now and removes it with its server
  assert.equal(readAgy()['codepit-memory'], undefined);
  assert.ok(readAgy().mine);
  assert.equal(readAgy().web.serverUrl, 'https://other.example/mcp');
});

test('a server CodePit wrote is updated in place when it changes', () => {
  updateMcpServer(web.id, { name: 'web2' } as any);
  syncAgyMcp();
  updateMcpServer(web.id, { url: 'https://mine.example/v2' } as any);
  syncAgyMcp();
  assert.equal(readAgy().web2.serverUrl, 'https://mine.example/v2');
});

test('an agy file that is not valid JSON is reported and left exactly as it was', () => {
  fs.writeFileSync(agyFile, '{ broken');
  const status = syncAgyMcp();
  assert.match(status.error!, /Can't read/);
  assert.equal(fs.readFileSync(agyFile, 'utf8'), '{ broken');
});

void fsServer;
void sse;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
process.exit(0);
