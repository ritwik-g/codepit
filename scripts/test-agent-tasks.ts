/**
 * Agent tasks (subagents, background shells, workflows): the records built on a
 * session from the agent's tool calls, AIR async_task updates and subagent
 * transcripts. Pure logic, no agent process.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AcpSession, ToolCallRecord, TurnMessage } from '../server/types.js';
import {
  appendSubagentText,
  completeAsyncSubagent,
  endAgentTasks,
  readTranscriptEnd,
  settleEndedSubagents,
  stopAsyncSubagent,
  SUBAGENT_STOPPED,
  stopAgentTask,
  syncAgentTasks,
  trackAsyncTask,
  trackTaskText,
  trackToolCall,
  trackToolCallUpdate,
} from '../server/acp/agent-tasks.js';
import { parseAsyncTaskUpdate } from '../server/acp/client-host.js';
import { rankSession } from '../server/rank.js';
import { readScriptMeta, readWorkflowAgent, readWorkflowRun } from '../server/acp/workflow-run.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function session(turns: TurnMessage[] = [], withTasks = true): AcpSession {
  return {
    id: 's1', agentId: 'claude', agentName: 'Claude', title: 't', titleSource: 'auto', cwd: '/tmp',
    startedAt: 0, updatedAt: 0, state: 'working', score: 0, reasons: [], lastPrompt: '', recap: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextTokens: 0 }, git: null,
    user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false },
    pendingPermission: null, turns, ...(withTasks ? { agentTasks: [] } : {}),
  };
}

function agentTurn(calls: ToolCallRecord[] = []): TurnMessage {
  return { id: 'm1', role: 'agent', toolCalls: calls, segments: [], timestamp: 0 };
}

/** What session-mgr does with a new call: store it on the turn, then track it. */
function addCall(s: AcpSession, call: ToolCallRecord) {
  s.turns[0].toolCalls!.push(call);
  return trackToolCall(s, call);
}

function update(s: AcpSession, id: string, patch: Partial<ToolCallRecord>) {
  const call = s.turns[0].toolCalls!.find((c) => c.id === id)!;
  Object.assign(call, patch);
  return trackToolCallUpdate(s, call);
}

console.log('agent tasks');

test('a subagent call starts a task, fills in its title, and finishes with the call', () => {
  const s = session([agentTurn()]);
  const [task] = addCall(s, { id: 'a1', title: 'Task', status: 'pending', startedAt: 1000, isSubagent: true, toolName: 'Agent' });
  assert.equal(task.id, 'a1');
  assert.equal(task.kind, 'subagent');
  assert.equal(task.title, 'Subagent'); // placeholder until the input streams in
  update(s, 'a1', { input: { description: 'Count ts files', prompt: 'Count the .ts files', subagent_type: 'Explore' }, subagentType: 'Explore' });
  assert.equal(s.agentTasks![0].title, 'Count ts files');
  assert.equal(s.agentTasks![0].prompt, 'Count the .ts files');
  assert.equal(s.agentTasks![0].agentType, 'Explore');
  assert.equal(s.agentTasks![0].status, 'running');
  update(s, 'a1', { status: 'completed', completedAt: 5000, agentUsage: { totalTokens: 20817, toolUses: 1, durationMs: 4225 } });
  assert.equal(s.agentTasks![0].status, 'completed');
  assert.equal(s.agentTasks![0].endedAt, 5000);
  assert.deepEqual(s.agentTasks![0].usage, { totalTokens: 20817, toolUses: 1, durationMs: 4225 });
});

test("calls, text and reasoning inside a subagent are tagged with and filed under it", () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Explore', status: 'running', startedAt: 1, isSubagent: true });
  const changed = addCall(s, { id: 'b1', title: '$ ls', status: 'running', startedAt: 2, parentToolUseId: 'a1' });
  assert.equal(s.turns[0].toolCalls![1].agentTaskId, 'a1');
  assert.deepEqual(changed.map((t) => t.id), ['a1']);
  trackTaskText(s, 'a1', 'thought', 'Look');
  trackTaskText(s, 'a1', 'thought', 'ing');
  trackTaskText(s, 'a1', 'text', 'Found ', 'm1');
  trackTaskText(s, 'a1', 'text', '3.', 'm1');
  trackTaskText(s, 'a1', 'text', 'Next', 'm2');
  const segs = s.agentTasks![0].segments!;
  assert.deepEqual(segs.map((x) => x.kind), ['tool', 'thought', 'text', 'text']);
  assert.equal((segs[1] as any).text, 'Looking');
  assert.equal((segs[2] as any).text, 'Found 3.');
  // A call the task already has is not filed twice
  trackToolCall(s, s.turns[0].toolCalls![1]);
  assert.equal(s.agentTasks![0].segments!.filter((x) => x.kind === 'tool').length, 1);
  assert.equal(trackTaskText(s, 'unknown', 'text', 'x'), undefined);
});

test("the call's copy of a subagent reply is capped, keeping the end", () => {
  let text = '';
  for (let i = 0; i < 2000; i++) text = appendSubagentText(text, `chunk ${i} `.padEnd(40, '.'));
  assert.ok(text.length <= 32 * 1024, `capped at 32 KB, got ${text.length}`);
  assert.ok(text.startsWith('... [earlier text truncated] ...'));
  assert.ok(text.includes('chunk 1999'), 'the latest text is kept');
  assert.equal(appendSubagentText('Found ', '3.'), 'Found 3.');
});

test('a nested subagent records the task it was launched from', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Outer', status: 'running', startedAt: 1, isSubagent: true });
  addCall(s, { id: 'a2', title: 'Inner', status: 'running', startedAt: 2, isSubagent: true, parentToolUseId: 'a1' });
  assert.equal(s.agentTasks![1].parentTaskId, 'a1');
});

test('a background shell is a task until its async task reports an end', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'c1', title: '$ npm run dev', status: 'running', startedAt: 1, input: { command: 'npm run dev' } });
  assert.equal(s.agentTasks!.length, 0); // a foreground command is not a task
  update(s, 'c1', { status: 'completed', background: true, completedAt: 2 });
  assert.equal(s.agentTasks![0].kind, 'background');
  assert.equal(s.agentTasks![0].title, 'npm run dev');
  assert.equal(s.agentTasks![0].status, 'running');
  trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'bt1', toolCallId: 'c1', taskType: 'shell', name: 'Dev server' }, 'c1');
  assert.equal(s.agentTasks!.length, 1);
  assert.equal(s.agentTasks![0].asyncTaskId, 'bt1');
  assert.equal(s.agentTasks![0].agentType, 'shell');
  trackAsyncTask(s, { kind: 'state', asyncTaskId: 'bt1', state: 'failed', summary: 'exit 1' }, 'c1');
  assert.equal(s.agentTasks![0].status, 'failed');
  assert.equal(s.agentTasks![0].summary, 'exit 1');
});

test('a workflow is named after the run and takes its usage from progress', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'w1', title: 'Workflow', status: 'completed', startedAt: 1, toolName: 'Workflow' });
  const task = trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'wt1', toolCallId: 'w1', taskType: 'workflow', name: 'review-pr', description: 'Review PR 42' }, 'w1')!;
  assert.equal(task.kind, 'workflow');
  assert.equal(task.title, 'review-pr');
  assert.equal(task.prompt, 'Review PR 42');
  trackAsyncTask(s, { kind: 'progress', asyncTaskId: 'wt1', usage: { totalTokens: 900, toolUses: 4, durationMs: 3000 } }, 'w1');
  assert.equal(task.usage!.toolUses, 4);
  // The completed Workflow call does not end the run; the async task does
  trackToolCallUpdate(s, s.turns[0].toolCalls![0]);
  assert.equal(task.status, 'running');
  trackAsyncTask(s, { kind: 'state', asyncTaskId: 'wt1', state: 'completed' }, 'w1');
  assert.equal(task.status, 'completed');
});

test('a spawn announced before its call is linked later without a duplicate record', () => {
  const s = session([agentTurn()]);
  // Seen live: async_task_spawned (no toolCallId), then the Bash call, then progress naming the call
  trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'bt1', taskType: 'shell', name: 'Run sleep in background' }, undefined);
  addCall(s, { id: 'c1', title: '$ sleep 20', status: 'completed', startedAt: 1, background: true, input: { command: 'sleep 20' } });
  assert.equal(s.agentTasks!.length, 2);
  trackAsyncTask(s, { kind: 'progress', asyncTaskId: 'bt1', toolCallId: 'c1' }, 'c1');
  assert.equal(s.agentTasks!.length, 1);
  const task = s.agentTasks![0];
  assert.equal(task.id, 'task:bt1');
  assert.equal(task.toolCallId, 'c1');
  assert.equal(task.prompt, 'sleep 20');
  assert.equal(task.startedAt, 1);
  // Later call updates land on the same record
  update(s, 'c1', { backgroundState: 'completed' });
  assert.equal(s.agentTasks!.length, 1);
  assert.equal(task.status, 'completed');
});

test('an async task with no tool call still gets a record; bare progress does not', () => {
  const s = session([agentTurn()]);
  assert.equal(trackAsyncTask(s, { kind: 'progress', asyncTaskId: 'x' }, undefined), undefined);
  const task = trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'm1', taskType: 'monitor', name: 'Watch logs' }, undefined)!;
  assert.equal(task.id, 'task:m1');
  assert.equal(task.title, 'Watch logs');
});

test('an async subagent runs until its transcript ends, then carries the report', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Read notes', status: 'running', startedAt: 1, isSubagent: true });
  update(s, 'a1', { status: 'completed', background: true, output: 'Async agent launched', agentOutputFile: '/tmp/x.output' });
  assert.equal(s.agentTasks![0].status, 'running');
  const done = completeAsyncSubagent(s, 'a1', 'The file says hello')!;
  assert.equal(done.task.status, 'completed');
  assert.equal(done.call!.backgroundState, 'completed');
  assert.equal(done.call!.subagentText, 'The file says hello');
  assert.equal((s.agentTasks![0].segments!.at(-1) as any).text, 'The file says hello');
  assert.equal(completeAsyncSubagent(s, 'a1', 'again'), null);
});

test('a subagent already finished when the agent stops is completed, not stopped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  const doneFile = path.join(dir, 'done.output');
  const busyFile = path.join(dir, 'busy.output');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    doneFile,
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 'Report A' } }] } }) +
      line({ type: 'user', toolEndsTurn: true, message: { content: [{ type: 'tool_result', tool_use_id: 'h1' }] } })
  );
  fs.writeFileSync(busyFile, line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1' }] } }));
  const finishedAt = Date.parse('2026-10-01T11:00:00Z');
  fs.utimesSync(doneFile, finishedAt / 1000, finishedAt / 1000);

  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Finished', status: 'running', startedAt: 1, isSubagent: true });
  update(s, 'a1', { status: 'completed', background: true, output: 'Async agent launched', agentOutputFile: doneFile });
  addCall(s, { id: 'a2', title: 'Still going', status: 'running', startedAt: 1, isSubagent: true });
  update(s, 'a2', { status: 'completed', background: true, output: 'Async agent launched', agentOutputFile: busyFile });

  // What a stop does first: the finished one completes with its report and its real end time
  assert.deepEqual(settleEndedSubagents(s).map((t) => t.id), ['a1']);
  endAgentTasks(s, 'Stopped when the agent was stopped');
  assert.deepEqual(s.agentTasks!.map((t) => t.status), ['completed', 'stopped']);
  assert.equal(s.agentTasks![0].endedAt, finishedAt);
  assert.equal((s.agentTasks![0].segments!.at(-1) as any).text, 'Report A');

  // One a stop already closed is repaired on the next start, and only when asked to look at stopped ones
  const t = s.agentTasks![0];
  Object.assign(t, { status: 'stopped', summary: 'Stopped when the server restarted', endedAt: Date.now() });
  assert.deepEqual(settleEndedSubagents(s), []);
  assert.deepEqual(settleEndedSubagents(s, true).map((x) => x.id), ['a1']);
  assert.equal(t.status, 'completed');
  assert.equal(t.summary, undefined);
  assert.equal(t.endedAt, finishedAt);
  // A subagent the stop really cut short stays stopped
  assert.equal(s.agentTasks![1].status, 'stopped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stopping the agent stops running tasks and leaves finished ones', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'A', status: 'running', startedAt: 1, isSubagent: true });
  addCall(s, { id: 'a2', title: 'B', status: 'completed', startedAt: 1, completedAt: 2, isSubagent: true });
  assert.equal(endAgentTasks(s, 'Stopped when the agent was stopped'), true);
  assert.deepEqual(s.agentTasks!.map((t) => t.status), ['stopped', 'completed']);
  assert.equal(s.agentTasks![0].summary, 'Stopped when the agent was stopped');
  assert.equal(endAgentTasks(s, 'again'), false);
});

test('one task can be stopped on its own, only while it runs', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'A', status: 'running', startedAt: 1, isSubagent: true });
  addCall(s, { id: 'a2', title: 'B', status: 'running', startedAt: 1, isSubagent: true });
  const ended = stopAgentTask(s, 'a1', 'No sign of it finishing after 6 hours')!;
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.summary, 'No sign of it finishing after 6 hours');
  assert.ok(ended.endedAt);
  assert.equal(s.agentTasks![1].status, 'running');
  assert.equal(stopAgentTask(s, 'a1', 'again'), null);
  assert.equal(stopAgentTask(s, 'missing', 'x'), null);
});

test('sessions recorded before tasks get them built; undone calls take their task along', () => {
  const calls: ToolCallRecord[] = [
    { id: 'a1', title: 'Map cookies', status: 'completed', startedAt: 1, completedAt: 9, isSubagent: true, subagentText: 'Found 4 reads' },
    { id: 'r1', title: 'Read: a.ts', status: 'completed', startedAt: 2, parentToolUseId: 'a1' },
    { id: 'x1', title: '$ ls', status: 'completed', startedAt: 3 },
  ];
  const s = session([agentTurn(calls)], false);
  assert.equal(syncAgentTasks(s), true);
  assert.equal(s.agentTasks!.length, 1);
  const task = s.agentTasks![0];
  assert.equal(task.status, 'completed');
  assert.equal(calls[1].agentTaskId, 'a1');
  assert.deepEqual(task.segments!.map((x) => x.kind), ['tool', 'text']);
  assert.equal(syncAgentTasks(s), false);
  s.turns = [];
  assert.equal(syncAgentTasks(s), true);
  assert.equal(s.agentTasks!.length, 0);
});

test('a transcript is done only when its last message ends the turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  const file = path.join(dir, 'abc.output');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line({ type: 'user', message: { role: 'user', content: 'go' } }) + line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: false });
  fs.appendFileSync(file, line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: false });
  fs.appendFileSync(file, line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All done.' }] } }) + line({ type: 'summary' }));
  assert.deepEqual(readTranscriptEnd(file), { done: true, report: 'All done.' });
  // Only adapter task files are read
  const other = path.join(dir, 'abc.jsonl');
  fs.copyFileSync(file, other);
  assert.deepEqual(readTranscriptEnd(other), { done: false });
  assert.deepEqual(readTranscriptEnd('relative.output'), { done: false });
  assert.deepEqual(readTranscriptEnd(path.join(dir, 'missing.output')), { done: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a transcript that ends on an interrupt, or whose meta says stoppedByUser, is stopped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const busy = line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1' }] } });
  // What Claude Code writes when a cancel cuts a subagent's tool call short
  const file = path.join(dir, 'abc.output');
  fs.writeFileSync(
    file,
    busy +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: "The user doesn't want to proceed with this tool use." }] } }) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
  );
  assert.deepEqual(readTranscriptEnd(file), { done: true, stopped: true });
  fs.writeFileSync(file, busy + line({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }));
  assert.deepEqual(readTranscriptEnd(file), { done: true, stopped: true });

  // The .output file links to the transcript; the meta beside it records a stop the transcript may not show yet
  const transcript = path.join(dir, 'agent-x.jsonl');
  fs.writeFileSync(transcript, busy);
  const link = path.join(dir, 'x.output');
  fs.symlinkSync(transcript, link);
  assert.deepEqual(readTranscriptEnd(link), { done: false });
  fs.writeFileSync(path.join(dir, 'agent-x.meta.json'), JSON.stringify({ stoppedByUser: true }));
  assert.deepEqual(readTranscriptEnd(link), { done: true, stopped: true });
  // A transcript that finished wins over the meta
  fs.appendFileSync(transcript, line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }));
  assert.deepEqual(readTranscriptEnd(link), { done: true, report: 'Done.' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a subagent cut short in the agent is recorded as stopped, on the task and its call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  const file = path.join(dir, 'cut.output');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) + '\n');
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Cut short', status: 'running', startedAt: 1, isSubagent: true });
  update(s, 'a1', { status: 'completed', background: true, output: 'Async agent launched', agentOutputFile: file });
  assert.deepEqual(settleEndedSubagents(s).map((t) => t.id), ['a1']);
  const task = s.agentTasks![0];
  assert.equal(task.status, 'stopped');
  assert.equal(task.summary, SUBAGENT_STOPPED);
  const call = s.turns[0].toolCalls![0];
  assert.equal(call.backgroundState, 'stopped');
  assert.equal(call.backgroundSummary, SUBAGENT_STOPPED);
  // Already stopped: left alone, even when asked to look at stopped ones
  assert.deepEqual(settleEndedSubagents(s, true), []);
  assert.equal(stopAsyncSubagent(s, 'a1', 'again'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a transcript that ends on a hand-back tool is done, with the handed-back report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  const file = path.join(dir, 'abc.output');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const handback = { type: 'tool_use', id: 'toolu_h', name: 'SubagentHandback', input: { message: 'Found 3 gaps.' } };
  const base =
    line({ type: 'user', message: { role: 'user', content: 'go' } }) +
    line({ type: 'assistant', message: { stop_reason: null, content: [{ type: 'thinking' }] } }) +
    line({ type: 'assistant', message: { stop_reason: null, content: [handback] } });
  fs.writeFileSync(file, base);
  assert.deepEqual(readTranscriptEnd(file), { done: false });
  // An ordinary tool result does not end the turn
  fs.writeFileSync(file, base + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_h' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: false });
  fs.writeFileSync(file, base + line({ type: 'user', toolEndsTurn: true, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_h' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: true, report: 'Found 3 gaps.' });
  // A tool that ends the turn without a message still finishes the task
  fs.writeFileSync(file, line({ type: 'user', toolEndsTurn: true, message: { content: [{ type: 'tool_result', tool_use_id: 'gone' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: true, report: undefined });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('async_task updates carry type, description and usage', () => {
  const u = parseAsyncTaskUpdate({
    sessionUpdate: 'async_task_progress', asyncTaskId: 't1', description: 'Review',
    usage: { totalTokens: 5, toolUses: 2, durationMs: 100 },
  })!;
  assert.equal(u.kind, 'progress');
  assert.equal(u.description, 'Review');
  assert.deepEqual(u.usage, { totalTokens: 5, toolUses: 2, durationMs: 100 });
  const spawned = parseAsyncTaskUpdate({ sessionUpdate: 'async_task_spawned', asyncTaskId: 't2', taskType: 'workflow', name: 'wf', usage: { totalTokens: 1 } })!;
  assert.equal(spawned.taskType, 'workflow');
  assert.equal(spawned.usage, undefined);
});

test('a Workflow call is a workflow task, named from its script, even with no async_task update', () => {
  const s = session([agentTurn()]);
  const script = "export const meta = {\n  name: 'review-changes',\n  description: 'Review the diff, verify each finding',\n}\n";
  const [task] = addCall(s, { id: 'w1', title: 'Workflow', status: 'pending', startedAt: 1000, toolName: 'Workflow', background: true, input: JSON.stringify({ script }) });
  assert.equal(task.kind, 'workflow');
  assert.equal(task.title, 'review-changes');
  assert.equal(task.prompt, 'Review the diff, verify each finding');
  update(s, 'w1', { status: 'completed', completedAt: 2000 });
  assert.equal(s.agentTasks![0].status, 'running', 'the run outlives the launching call');
  update(s, 'w1', { backgroundState: 'completed', backgroundEndedAt: 9000 });
  assert.equal(s.agentTasks![0].status, 'completed');
  assert.equal(s.agentTasks![0].endedAt, 9000);
});

test('a workflow stored as a background task is relabelled when the session loads', () => {
  const call: ToolCallRecord = { id: 'w2', title: 'Workflow', status: 'completed', startedAt: 1000, toolName: 'Workflow', background: true, backgroundState: 'completed', input: { name: 'nightly-audit' } };
  const s = session([agentTurn([call])]);
  s.agentTasks = [{ id: 'w2', kind: 'background', title: 'Background task', status: 'completed', startedAt: 1000, toolCallId: 'w2' }];
  assert.equal(syncAgentTasks(s), true);
  assert.equal(s.agentTasks[0].kind, 'workflow');
  assert.equal(s.agentTasks[0].title, 'nightly-audit');
  assert.equal(syncAgentTasks(s), false, 'nothing left to change');
});

test("what the agent reports about a subagent (id, model, worktree) goes on the task's audit", () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a9', title: 'Agent', status: 'pending', startedAt: 1, isSubagent: true, toolName: 'Agent' });
  s.agentTasks![0].audit = { agentId: 'claude', agentName: 'Claude Code', agentSessionId: 'sess-1' };
  update(s, 'a9', { status: 'completed', agentRef: { subagentId: 'abc123', subagentModel: 'claude-haiku-4-5', worktreeBranch: 'wt-1' } });
  const audit = s.agentTasks![0].audit!;
  assert.equal(audit.subagentId, 'abc123');
  assert.equal(audit.subagentModel, 'claude-haiku-4-5');
  assert.equal(audit.worktreeBranch, 'wt-1');
  assert.equal(audit.agentSessionId, 'sess-1', 'the session stamp is kept');
});

test('a finished turn with background work still running ranks as working, not waiting for the user', () => {
  const s = session([agentTurn()]);
  s.state = 'needs_you';
  s.agentTasks = [{ id: 'w1', kind: 'workflow', title: 'Review', status: 'running', startedAt: 1, toolCallId: 'w1' }];
  const busy = rankSession(s);
  assert.equal(busy.state, 'needs_you', 'state stays needs_you so a new message is sent, not queued');
  assert.equal(busy.factors[0].label, 'Working in the background');
  s.agentTasks[0].status = 'completed';
  const idle = rankSession(s);
  assert.equal(idle.factors[0].label, 'Waiting for your reply');
  assert.ok(idle.score > busy.score, 'waiting for the user ranks above working in the background');
  s.agentTasks[0].status = 'running';
  s.pendingPermission = { requestId: 'r', toolCallId: 't', title: 'Run', options: [], createdAt: 0 } as any;
  assert.equal(rankSession(s).state, 'blocked', 'a question from the agent still needs the user');
});

test("a Claude workflow run's phases, agents and each agent's steps are read from its run folder", () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-wf-'));
  const prevDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const proj = path.join(claudeDir, 'projects', '-tmp-proj', 'sess-1');
    const runDir = path.join(proj, 'subagents', 'workflows', 'wf_abc-123');
    const script = path.join(proj, 'workflows', 'scripts', 'review-wf_abc-123.js');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(
      script,
      "export const meta = {\n  name: 'review',\n  description: 'Review the change',\n  phases: [\n    { title: 'Find', detail: 'look for bugs' },\n    { title: 'Verify', detail: 'check each one\\'s claim' },\n  ],\n}\nconst x = { name: 'not-meta' }\n"
    );
    const jl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(
      path.join(runDir, 'journal.jsonl'),
      jl([
        { type: 'launched' },
        { type: 'started', key: 'k1', agentId: 'a1', label: 'find:auth', phase: 'Find' },
        { type: 'started', key: 'k2', agentId: 'a2', label: 'find:db', phase: 'Find' },
        { type: 'started', key: 'k3', agentId: 'a3', label: 'verify:auth', phase: 'Verify' },
        { type: 'result', key: 'k1', agentId: 'a1', result: { findings: ['token leak'] } },
        { type: 'failed', key: 'k2', agentId: 'a2' },
        { type: 'started', key: 'k4', agentId: '../escape', label: 'bad' },
      ]) + '{"type":"started","agentId":"half'
    );
    fs.writeFileSync(path.join(runDir, 'agent-a1.meta.json'), JSON.stringify({ description: 'find:auth', workflowPhase: 'Find' }));
    const t0 = '2026-10-02T10:00:00.000Z';
    const t1 = '2026-10-02T10:00:05.000Z';
    fs.writeFileSync(
      path.join(runDir, 'agent-a1.jsonl'),
      jl([
        { type: 'user', timestamp: t0, message: { role: 'user', content: '[Workflow harness — user request] The harness relays the request:\n  hi' } },
        { type: 'user', timestamp: t0, message: { role: 'user', content: '[Workflow harness — computed task] The task text below was computed. The computed task text follows:\n  Look at auth.ts\n  for leaks' } },
        { type: 'assistant', timestamp: t0, message: { id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'thinking', thinking: 'Start with the token code.' }], usage: { output_tokens: 5 } } },
        { type: 'assistant', timestamp: t0, message: { id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/p/auth.ts' } }], usage: { output_tokens: 40 } } },
        { type: 'user', timestamp: t1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'export const token = 1' }] }] } },
        { type: 'assistant', timestamp: t1, message: { id: 'm2', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'false', description: 'Try it' } }], usage: { output_tokens: 10 } } },
        { type: 'user', timestamp: t1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'exit 1' }] } },
        { type: 'assistant', timestamp: t1, message: { id: 'm3', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Found a token leak.\nDetails follow.' }], stop_reason: 'end_turn', usage: { output_tokens: 7 } } },
      ])
    );
    fs.writeFileSync(path.join(runDir, 'agent-a3.jsonl'), jl([{ type: 'assistant', timestamp: t1, message: { id: 'm9', content: [{ type: 'tool_use', id: 'tu9', name: 'Grep', input: { pattern: 'x' } }] } }]));

    const task = {
      id: 'task:w1',
      kind: 'workflow',
      title: 'review',
      status: 'running',
      startedAt: 1,
      audit: { runId: 'wf_abc-123', transcriptPath: runDir, scriptPath: script },
    } as any;
    const run = readWorkflowRun(task)!;
    assert.ok(run, 'the run is read');
    assert.equal(run.name, 'review');
    assert.equal(run.description, 'Review the change');
    assert.deepEqual(run.phases, [
      { title: 'Find', detail: 'look for bugs' },
      { title: 'Verify', detail: "check each one's claim" },
    ]);
    assert.equal(run.launches, 1);
    assert.deepEqual(run.agents.map((a) => a.id), ['a1', 'a2', 'a3'], 'ids that are not plain are ignored, a half-written line too');
    const [a1, a2, a3] = run.agents;
    assert.equal(a1.status, 'completed');
    assert.equal(a1.toolUses, 2);
    assert.equal(a1.outputTokens, 40 + 10 + 7, 'one count per message, its largest');
    assert.equal(a1.model, 'claude-opus-4-8');
    assert.equal(a1.lastText, 'Found a token leak.');
    assert.equal(a1.lastActivityAt! - a1.startedAt!, 5000);
    assert.equal(a2.status, 'failed');
    assert.equal(a3.status, 'running');
    assert.equal(a3.lastTool, 'Grep');

    const detail = readWorkflowAgent(task, 'a1')!;
    assert.equal(detail.prompt, 'Look at auth.ts\nfor leaks', 'the computed task without its frame');
    assert.deepEqual(detail.segments.map((s) => s.kind), ['thought', 'tool', 'tool', 'text']);
    assert.equal(detail.calls[0].toolName, 'Read');
    assert.equal(detail.calls[0].kind, 'read');
    assert.equal(detail.calls[0].output, 'export const token = 1');
    assert.equal(detail.calls[1].status, 'failed');
    assert.equal(detail.calls[1].title, 'Try it');
    assert.match(detail.result!, /token leak/);
    assert.equal(readWorkflowAgent(task, '../escape'), undefined);
    assert.equal(readWorkflowAgent(task, 'nope'), undefined);

    // The run is over: agents that never reported are stopped, not running
    assert.equal(readWorkflowRun({ ...task, status: 'completed' })!.agents[2].status, 'stopped');

    // A running agent's transcript grows between polls: only what was appended is read, and a
    // line still being written waits for the next poll
    const a3File = path.join(runDir, 'agent-a3.jsonl');
    const half = JSON.stringify({ type: 'assistant', timestamp: t1, message: { id: 'm10', content: [{ type: 'tool_use', id: 'tu10', name: 'Read', input: { file_path: '/x' } }] } });
    fs.appendFileSync(a3File, half.slice(0, 40));
    assert.equal(readWorkflowRun(task)!.agents[2].toolUses, 1, 'a half-written line is not read yet');
    fs.appendFileSync(a3File, half.slice(40) + '\n');
    const grown = readWorkflowRun(task)!.agents[2];
    assert.equal(grown.toolUses, 2, 'the completed line is read on the next poll');
    assert.equal(grown.lastTool, 'Read');
    assert.deepEqual(readWorkflowAgent(task, 'a3')!.calls.map((c) => c.id), ['tu9', 'tu10'], 'nothing is read twice');

    // Resumed: the run is launched again; an agent the first launch left unfinished is stopped,
    // one the new launch started runs
    fs.appendFileSync(path.join(runDir, 'journal.jsonl'), '\n' + jl([{ type: 'launched' }, { type: 'started', key: 'k5', agentId: 'a5', label: 'verify:db', phase: 'Verify' }]));
    const resumed = readWorkflowRun(task)!;
    assert.equal(resumed.launches, 2);
    assert.equal(resumed.agents.find((a) => a.id === 'a3')!.status, 'stopped');
    assert.equal(resumed.agents.find((a) => a.id === 'a5')!.status, 'running');
    assert.equal(resumed.agents.find((a) => a.id === 'a1')!.status, 'completed');

    // A file in the run folder that is a symlink is not followed
    const secret = path.join(claudeDir, 'secret.jsonl');
    fs.writeFileSync(secret, jl([{ type: 'assistant', timestamp: t0, message: { id: 's', content: [{ type: 'text', text: 'secret' }] } }]));
    fs.symlinkSync(secret, path.join(runDir, 'agent-a5.jsonl'));
    assert.equal(readWorkflowAgent(task, 'a5')!.segments.length, 0, 'a symlinked transcript is not read');

    // Only folders under Claude's projects folder, named like a run, are read
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wf_outside-'));
    fs.writeFileSync(path.join(outside, 'journal.jsonl'), jl([{ type: 'started', agentId: 'a1', label: 'x' }]));
    assert.equal(readWorkflowRun({ ...task, audit: { transcriptPath: outside } }), undefined);
    assert.equal(readWorkflowRun({ ...task, audit: { transcriptPath: path.join(runDir, '..', '..', '..') } }), undefined);
    assert.equal(readWorkflowRun({ ...task, kind: 'subagent' }), undefined);
    assert.equal(readWorkflowRun({ ...task, audit: undefined }), undefined);
    assert.deepEqual(readScriptMeta('/etc/hosts'), { phases: [] }, 'a script outside the projects folder is not read');
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevDir;
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);
