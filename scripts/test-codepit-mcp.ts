import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// CodePit's own MCP server: settings, who may call it, every tool, the held start,
// the limits, the audit log and the app API around it. Runs against the real HTTP
// server with mock agents.

const testAppDir = path.join(os.tmpdir(), `codepit-own-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
const claudeDir = path.join(testAppDir, 'claude-config');
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });

const { startServer } = await import('../server/server.js');
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { store } = await import('../server/store.js');
const { tokenFor } = await import('../server/mcp/codepit/access.js');
const { parseCodepitMcpSettings, readCodepitMcpSettings, writeCodepitMcpSettings, DEFAULT_CODEPIT_MCP } = await import('../server/mcp/codepit/settings.js');
const { readAudit } = await import('../server/mcp/codepit/audit.js');
const { readEvents } = await import('../server/event-log.js');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.log(`   FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

async function main(): Promise<void> {
  console.log('1. Settings');
  check('off by default', readCodepitMcpSettings().enabled === false && readCodepitMcpSettings().startMode === 'ask');
  check('bad start mode refused', typeof parseCodepitMcpSettings({ startMode: 'yes' }, DEFAULT_CODEPIT_MCP) === 'string');
  check('depth out of range refused', typeof parseCodepitMcpSettings({ maxDepth: 0 }, DEFAULT_CODEPIT_MCP) === 'string');
  const parsed = parseCodepitMcpSettings({ enabled: true, agents: ['mock'], maxChildren: 3 }, DEFAULT_CODEPIT_MCP);
  check('fields laid over the base', typeof parsed !== 'string' && parsed.enabled && parsed.maxChildren === 3 && parsed.inheritTags === true, parsed);

  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-own-mcp-ws-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-own-mcp-other-'));

  let rpcId = 0;
  const rpc = async (token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    const res = r.json?.result;
    return { isError: Boolean(res?.isError), data: res?.structuredContent, text: res?.content?.[0]?.text as string };
  };
  const api = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`${base}/api${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };

  try {
    console.log('2. Not handed to agents while off');
    const off = await sessionManager.createSession({ agentId: 'mock', cwd: workDir, title: 'Off' });
    check('no codepit server while off', !sessionManager.getSession(off.id)!.mcp?.attached.includes('codepit'), sessionManager.getSession(off.id)!.mcp);

    console.log('3. Turned on through the app API');
    const put = await api('PUT', '/codepit-mcp', { enabled: true, agents: ['mock'], startMode: 'auto' });
    check('saved', put.status === 200 && put.json.settings.enabled && put.json.reachable, put.json);
    check('bad settings refused', (await api('PUT', '/codepit-mcp', { maxChildren: 'lots' })).status === 400);
    check('send_to_session hidden until messaging is allowed', !put.json.tools.some((t: any) => t.name === 'send_to_session'));

    const parent = await sessionManager.createSession({ agentId: 'mock', cwd: workDir, title: 'Factory' });
    sessionManager.updateAnnotations(parent.id, { tags: ['fe-v1'] });
    const p = sessionManager.getSession(parent.id)!;
    check('handed to the agent', p.mcp?.attached.includes('codepit') === true, p.mcp);
    const token = tokenFor(parent.id);

    console.log('4. Who may call it');
    check('no token: 401', (await rpc(null, 'tools/list')).status === 401);
    check('wrong token: 401', (await rpc('nope', 'tools/list')).status === 401);
    check('browser page: 403', (await rpc(token, 'tools/list', undefined, { Origin: 'http://evil.example' })).status === 403);
    check('from the LAN: 403', (await rpc(token, 'tools/list', undefined, { 'x-test-remote-ip': '192.168.1.20' })).status === 403);
    check('GET has no stream: 405', (await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status === 405);
    check('token opens nothing on /api', (await fetch(`${base}/api/codepit-mcp`, { headers: { Authorization: `Bearer ${token}`, 'x-test-remote-ip': '192.168.1.20' } })).status !== 200);

    console.log('5. Protocol');
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    check('initialize', init.json?.result?.serverInfo?.name === 'codepit' && init.json.result.protocolVersion === '2025-03-26', init.json);
    const note = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    check('notification: 202', note.status === 202);
    const tools = await rpc(token, 'tools/list');
    const names = (tools.json?.result?.tools ?? []).map((t: any) => t.name);
    check('tools listed', ['whoami', 'list_sessions', 'find_session', 'get_session', 'create_session', 'tag_session', 'link_sessions'].every((n) => names.includes(n)), names);
    check('unknown method', (await rpc(token, 'resources/list')).json?.error?.code === -32601);

    console.log('6. whoami and the Claude session name');
    const agentSessionId = sessionManager.getSession(parent.id)!.agentSessionId!;
    fs.writeFileSync(path.join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: agentSessionId, name: 'factory-1a' }));
    const me = await tool(token, 'whoami');
    check('whoami is the caller', !me.isError && me.data.id === parent.id && me.data.agentSessionId === agentSessionId && me.data.tags.includes('fe-v1'), me);
    check('stamp', /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[repo:[^\]]+\] \[name:factory-1a\] \[id:[^\]]+\]$/.test(me.data.stamp), me.data.stamp);

    console.log('7. create_session (starts at once)');
    const made = await tool(token, 'create_session', { prompt: 'Build the login page', title: 'Login page', tags: ['login'] });
    check('created and started', !made.isError && made.data.started === true && made.data.waitingForUser === false, made);
    const child = sessionManager.getSession(made.data.id)!;
    check('records its parent', child.spawnedBy?.sessionId === parent.id && child.spawnedBy.depth === 1, child.spawnedBy);
    check('tags inherited and added', ['fe-v1', 'login'].every((t) => child.user.tags.includes(t)), child.user.tags);
    check('folder and agent default to the parent', child.cwd === workDir && child.agentId === 'mock');
    await until(() => (sessionManager.getSession(child.id)!.turns.find((t) => t.role === 'user')?.content ?? '') !== '');
    const firstPrompt = sessionManager.getSession(child.id)!.turns.find((t) => t.role === 'user')?.content ?? '';
    check('told who started it', firstPrompt.startsWith('Build the login page') && firstPrompt.includes(`id ${parent.id}`), firstPrompt);

    const noInherit = await tool(token, 'create_session', { prompt: 'x', cwd: otherDir, inherit_tags: false, report_back: false });
    const ni = sessionManager.getSession(noInherit.data.id)!;
    check('inherit_tags false and another folder', ni.user.tags.length === 0 && ni.cwd === otherDir, { tags: ni.user.tags, cwd: ni.cwd });
    check('report_back false sends the prompt as is', (await until(() => sessionManager.getSession(ni.id)!.turns.some((t) => t.role === 'user'))) && sessionManager.getSession(ni.id)!.turns.find((t) => t.role === 'user')!.content === 'x');
    check('missing folder refused', (await tool(token, 'create_session', { prompt: 'x', cwd: path.join(otherDir, 'nope') })).isError);
    check('unknown agent refused', (await tool(token, 'create_session', { prompt: 'x', agent: 'nope' })).isError);
    check('prompt required', (await tool(token, 'create_session', {})).isError);

    console.log('8. Held start');
    const held = await tool(token, 'create_session', { prompt: 'Wait for me', start: 'wait' });
    const h = sessionManager.listSessions().find((s) => s.id === held.data.id)!;
    check('waits for the user', held.data.waitingForUser === true && Boolean(h.pendingStart) && !h.isAgentRunning && h.state === 'needs_you', h);
    await api('PUT', '/codepit-mcp', { startMode: 'ask' });
    const asked = await tool(token, 'create_session', { prompt: 'Ask first' });
    check('ask mode holds even start=now', asked.data.waitingForUser === true, asked.data);
    const started = await api('POST', `/sessions/${held.data.id}/pending-start`, { action: 'start', prompt: 'Edited prompt' });
    check('start from the app', started.status === 200 && !sessionManager.getSession(held.data.id)!.pendingStart);
    check('runs the edited prompt', await until(() => sessionManager.getSession(held.data.id)!.turns.some((t) => t.role === 'user' && t.content === 'Edited prompt')));
    check('discard deletes it', (await api('POST', `/sessions/${asked.data.id}/pending-start`, { action: 'discard' })).status === 200 && !store.get(asked.data.id));
    check('nothing to start: 404', (await api('POST', `/sessions/${held.data.id}/pending-start`, { action: 'start' })).status === 404);
    await api('PUT', '/codepit-mcp', { startMode: 'auto' });

    console.log('9. Lookups');
    const listed = await tool(token, 'list_sessions', { scope: 'children' });
    check('children', listed.data.sessions.length === 3 && listed.data.sessions.every((s: any) => s.parentId === parent.id), listed.data);
    const tagged = await tool(token, 'list_sessions', { tag: '#login' });
    check('by tag', tagged.data.sessions.length === 1 && tagged.data.sessions[0].id === child.id, tagged.data);
    const family = await tool(tokenFor(child.id), 'list_sessions', { scope: 'family' });
    check('family from a child includes the parent', family.data.sessions.some((s: any) => s.id === parent.id) && !family.data.sessions.some((s: any) => s.id === off.id), family.data);
    check('find by agent session id', (await tool(token, 'find_session', { agent_session_id: agentSessionId })).data.sessions[0]?.id === parent.id);
    const byName = await tool(token, 'find_session', { name: 'factory-1a' });
    check('find by Claude session name', byName.data.sessions[0]?.id === parent.id && byName.data.sessions[0].agentSessionName === 'factory-1a', byName.data);
    check('find by title', (await tool(token, 'find_session', { name: 'login' })).data.sessions[0]?.id === child.id);
    check('find needs an argument', (await tool(token, 'find_session', {})).isError);
    await until(() => sessionManager.getSession(child.id)!.turns.some((t) => t.role === 'agent' && Boolean(t.content)));
    const got = await tool(token, 'get_session', { id: child.id, turns: 2 });
    check('get_session', !got.isError && got.data.id === child.id && got.data.recentTurns.length > 0, got);
    check('unknown id refused', (await tool(token, 'get_session', { id: 'acp-nope' })).isError);

    console.log('10. Tags and links');
    const tg = await tool(token, 'tag_session', { id: child.id, add: ['Review Needed'], remove: ['login'] });
    check('tag_session', tg.data.tags.includes('review-needed') && !tg.data.tags.includes('login'), tg.data);
    const ln = await tool(token, 'link_sessions', { from: ni.id, to: child.id, kind: 'blocked-by' });
    check('link_sessions', ln.data.links.length === 1 && ln.data.links[0].kind === 'blocked-by' && ln.data.links[0].by === parent.id, ln.data);
    check('links in the summary', sessionManager.listSessions().find((s) => s.id === ni.id)!.links?.length === 1);
    const unl = await tool(token, 'link_sessions', { from: ni.id, to: child.id, kind: 'blocked-by', remove: true });
    check('unlink', unl.data.links.length === 0 && !store.get(ni.id)!.links);
    check('no self link', (await tool(token, 'link_sessions', { to: parent.id })).isError);

    console.log('11. Limits');
    await api('PUT', '/codepit-mcp', { maxDepth: 1 });
    const deep = await tool(tokenFor(child.id), 'create_session', { prompt: 'grandchild' });
    check('depth limit', deep.isError && /level/.test(deep.text), deep.text);
    await api('PUT', '/codepit-mcp', { maxDepth: 3, maxChildren: 3 });
    const many = await tool(token, 'create_session', { prompt: 'one too many' });
    check('children limit', many.isError && /already started 3/.test(many.text), many.text);
    await api('PUT', '/codepit-mcp', { maxChildren: 20 });

    console.log('12. send_to_session');
    check('hidden while messaging is off', (await tool(tokenFor(child.id), 'send_to_session', { id: parent.id, message: 'done' })).isError);
    await api('PUT', '/codepit-mcp', { allowMessaging: true });
    const sent = await tool(tokenFor(child.id), 'send_to_session', { id: parent.id, message: 'Login page done' });
    check('child messages its parent', !sent.isError, sent);
    check('arrives marked as from the child', await until(() => sessionManager.getSession(parent.id)!.turns.some((t) => t.role === 'user' && (t.content ?? '').includes('Login page done') && (t.content ?? '').includes(`id ${child.id}`))));
    const initMsg = await rpc(token, 'initialize', { protocolVersion: '2025-06-18' });
    check('the instructions say to fall back to send_to_session', /SendMessage fails[\s\S]*send_to_session/.test(initMsg.json?.result?.instructions ?? ''), initMsg.json?.result?.instructions);
    const idle = (id: string) => until(() => !sessionManager.isTurnInFlight(id), 10_000);
    await idle(parent.id);
    const unrelated = await tool(tokenFor(child.id), 'send_to_session', { id: off.id, message: 'hi from a stranger' });
    check('any session can be messaged, related or not', !unrelated.isError && ['sent', 'started'].includes(unrelated.data.delivery), unrelated);
    await idle(off.id);
    const offAgentId = sessionManager.getSession(off.id)!.agentSessionId!;
    const offReg = path.join(claudeDir, 'sessions', '999999.json');
    fs.writeFileSync(offReg, JSON.stringify({ pid: process.pid, sessionId: offAgentId, name: 'off-7c' }));
    const sentByName = await tool(tokenFor(child.id), 'send_to_session', { name: 'off-7c', message: 'by name' });
    check('by Claude session name', !sentByName.isError && sentByName.data.id === off.id && sentByName.data.delivery === 'sent', sentByName);
    await idle(off.id);
    check('both id and name refused', (await tool(tokenFor(child.id), 'send_to_session', { id: off.id, name: 'off-7c', message: 'x' })).isError);

    await sessionManager.stopSessionAgent(off.id);
    fs.rmSync(offReg); // Claude takes a stopped session off its list
    check('the name is kept when the agent stops', store.get(off.id)!.lastAgentSessionName === 'off-7c');
    const woken = await tool(tokenFor(child.id), 'send_to_session', { name: 'off-7c', message: 'wake up and look' });
    check('a stopped session is started and sent the message', !woken.isError && woken.data.delivery === 'started' && /started it again/.test(woken.data.note), woken);
    check('its agent runs again', await until(() => sessionManager.isAgentRunning(off.id)));
    check('the message arrived, with how to reply', await until(() => sessionManager.getSession(off.id)!.turns.some((t) => t.role === 'user' && (t.content ?? '').includes('wake up and look') && (t.content ?? '').includes(`send_to_session tool, id ${child.id}`))));
    await idle(off.id);
    await sessionManager.stopSessionAgent(off.id);
    store.get(ni.id)!.lastAgentSessionName = 'off-7c';
    const twice = await tool(tokenFor(child.id), 'send_to_session', { name: 'off-7c', message: 'which one?' });
    check('a name two stopped sessions had is refused, naming both', twice.isError && twice.text.includes(off.id) && twice.text.includes(ni.id), twice.text);
    delete store.get(ni.id)!.lastAgentSessionName;

    console.log('12b. Event log');
    store.get(off.id)!.lastAgentSessionName = 'off-7c';
    const parentHost = (sessionManager as any).activeHosts.get(parent.id);
    const call = (id: string, to: string, output: string, status = 'completed') =>
      parentHost.emit('toolCall', { id, kind: 'other', title: 'SendMessage', toolName: 'SendMessage', status, input: { to, message: `to ${to}` }, output });
    call('toolu_sm_ok', 'off-7c', '{"success":true,"message":"delivered"}');
    call('toolu_sm_fail', 'gone-99', '{"success":false,"message":"No session named gone-99"}');
    call('toolu_sm_sub', 'a64f5a7e4818c6dd3', '{"success":true}');
    parentHost.emit('peerMessage', { from: 'off-7c', fromName: 'off-7c', text: 'reply from off' });
    const events = readEvents({ limit: 1000 });
    check("Claude's SendMessage to another session is logged", events.some((e) => e.kind === 'message.sent' && e.via === 'claude' && e.from?.sessionId === parent.id && e.to?.sessionId === off.id && e.preview === 'to off-7c'));
    check('a failed SendMessage is logged with its error', events.some((e) => e.kind === 'message.refused' && e.via === 'claude' && e.to?.name === 'gone-99' && /No session named/.test(e.error ?? '')));
    check("messages to the session's own subagents are left out", !events.some((e) => e.to?.name === 'a64f5a7e4818c6dd3'));
    check('a received message is logged with its sender', events.some((e) => e.kind === 'message.received' && e.to?.sessionId === parent.id && e.from?.sessionId === off.id && e.preview === 'reply from off'));
    check('a message that started an agent is logged', events.some((e) => e.kind === 'message.sent' && e.via === 'codepit' && e.delivery === 'started' && e.from?.sessionId === child.id && e.to?.sessionId === off.id && e.to?.name === 'off-7c' && e.preview === 'wake up and look'), events.slice(0, 5));
    check('a refused message is logged with why', events.some((e) => e.kind === 'message.refused' && /More than one/.test(e.error ?? '') && e.to?.name === 'off-7c'));
    check('stopping an agent is logged', events.some((e) => e.kind === 'agent.stopped' && e.reason === 'user' && e.to?.sessionId === off.id));
    const perOff = await api('GET', `/events?sessionId=${off.id}&limit=500`);
    check('events read per session over HTTP', perOff.json.events.length > 0 && perOff.json.events.every((e: any) => e.sessions.includes(off.id)), perOff.json);
    check('owner-only event log', (fs.statSync(path.join(testAppDir, 'logs', 'events.jsonl')).mode & 0o777) === 0o600);

    console.log('13. Turned off');
    await api('PUT', '/codepit-mcp', { enabled: false });
    check('calls refused once off', (await tool(token, 'whoami')).isError);

    console.log('14. Audit log');
    const audit = readAudit({ limit: 1000 });
    check('tool calls recorded with the caller', audit.some((e) => e.tool === 'create_session' && e.ok && e.caller?.sessionId === parent.id && e.sessions?.includes(child.id)));
    check('refusals recorded', audit.some((e) => e.tool === 'create_session' && !e.ok && /level/.test(e.error ?? '')));
    check('unauthorized requests recorded', audit.some((e) => !e.caller && e.error === 'Unknown or missing session token'));
    const perSession = await api('GET', `/codepit-mcp/audit?sessionId=${child.id}&limit=500`);
    check('filtered by session', perSession.json.entries.length > 0 && perSession.json.entries.every((e: any) => e.caller?.sessionId === child.id || e.sessions?.includes(child.id)));
    const mode = fs.statSync(path.join(testAppDir, 'logs', 'codepit-mcp.jsonl')).mode & 0o777;
    check('owner-only log', mode === 0o600, mode.toString(8));

    console.log('15. Deleting a session revokes its token');
    const niToken = tokenFor(ni.id);
    sessionManager.deleteSession(ni.id);
    check('revoked', (await rpc(niToken, 'tools/list')).status === 401);
  } finally {
    await handle.close();
    writeCodepitMcpSettings(DEFAULT_CODEPIT_MCP);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll CodePit MCP server checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
