import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capToolOutput } from './client-host.js';
import type {
  AgentTask,
  AgentTaskStatus,
  ToolCallRecord,
  TurnSegment,
  WorkflowAgentDetail,
  WorkflowAgentInfo,
  WorkflowPhaseInfo,
  WorkflowRunInfo,
} from '../types.js';

/**
 * Claude workflow runs, read from disk. Over ACP a run is one async task with
 * progress totals; the phases, the agents and what each one did live only in
 * the run's folder, which the Workflow tool reports as `transcriptDir`:
 *
 *   journal.jsonl            launched / started {agentId,label,phase} / result / failed
 *   agent-<id>.meta.json     {description, workflowPhase, spawnDepth}
 *   agent-<id>.jsonl         the agent's own Claude Code transcript
 *
 * Nothing here trusts a path from a request: the folder comes from the task's
 * audit, and is only read when it sits under Claude's projects folder.
 */

const claudeProjectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

const AGENT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** `file` resolved, when it lies inside Claude's projects folder. */
function insideProjects(file: string | undefined): string | undefined {
  if (!file || !path.isAbsolute(file)) return undefined;
  let real: string;
  let root: string;
  try {
    real = fs.realpathSync(file);
    root = fs.realpathSync(claudeProjectsDir());
  } catch {
    return undefined;
  }
  return real.startsWith(root + path.sep) ? real : undefined;
}

/** The run folder of a workflow task, if CodePit knows it and it is a real workflow folder. */
export function workflowDirOf(task: AgentTask): string | undefined {
  if (task.kind !== 'workflow') return undefined;
  const dir = insideProjects(task.audit?.transcriptPath);
  if (!dir || !/^wf_[\w-]+$/.test(path.basename(dir))) return undefined;
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** A plain file in the run folder: a symlink there could point anywhere, so it is not followed. */
function plainFile(file: string): fs.Stats | undefined {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------- Journal

interface JournalAgent {
  id: string;
  key?: string;
  label?: string;
  phase?: string;
  outcome?: 'completed' | 'failed';
  result?: unknown;
  /** Which launch started it (1 for the first); a resume launches the run again. */
  launch: number;
}

function readJsonl(file: string): any[] {
  if (!plainFile(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line still being written
    }
  }
  return out;
}

function readJournal(dir: string): { agents: JournalAgent[]; launches: number } {
  const agents = new Map<string, JournalAgent>();
  let launches = 0;
  for (const e of readJsonl(path.join(dir, 'journal.jsonl'))) {
    if (e?.type === 'launched') {
      launches++;
      continue;
    }
    if (typeof e?.agentId !== 'string' || !AGENT_ID.test(e.agentId)) continue;
    const a: JournalAgent = agents.get(e.agentId) ?? { id: e.agentId, launch: launches };
    if (e.type === 'started') {
      a.key = e.key;
      a.launch = launches;
      if (typeof e.label === 'string') a.label = e.label;
      if (typeof e.phase === 'string') a.phase = e.phase;
    } else if (e.type === 'result') {
      a.outcome = 'completed';
      a.result = e.result;
    } else if (e.type === 'failed') {
      a.outcome = 'failed';
    }
    agents.set(e.agentId, a);
  }
  return { agents: [...agents.values()], launches };
}

/** The script's `meta` name, description and phases, read as text (the script is never run). */
export function readScriptMeta(file: string | undefined): { name?: string; description?: string; phases: WorkflowPhaseInfo[] } {
  const real = insideProjects(file);
  if (!real) return { phases: [] };
  let text: string;
  try {
    text = fs.readFileSync(real, 'utf8').slice(0, 64 * 1024);
  } catch {
    return { phases: [] };
  }
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
  const str = '(?:\'((?:\\\\.|[^\'\\\\])*)\'|"((?:\\\\.|[^"\\\\])*)"|`((?:\\\\.|[^`\\\\])*)`)';
  const field = (src: string, name: string) => {
    const m = new RegExp(`\\b${name}\\s*:\\s*${str}`).exec(src);
    const raw = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    return raw?.replace(/\\(.)/g, '$1');
  };
  const phasesSrc = /\bphases\s*:\s*\[([\s\S]*?)\]/.exec(meta)?.[1] ?? '';
  const phases: WorkflowPhaseInfo[] = [];
  for (const obj of phasesSrc.match(/\{[^{}]*\}/g) ?? []) {
    const title = field(obj, 'title');
    if (title) phases.push({ title, detail: field(obj, 'detail') });
  }
  // Only the top-level name/description: drop the phases list before matching
  const top = meta.replace(/\bphases\s*:\s*\[[\s\S]*?\]/, '');
  return { name: field(top, 'name'), description: field(top, 'description'), phases };
}

// ---------------------------------------------------- Agent transcripts

const HARNESS_TASK = /^\[Workflow harness — computed task\][\s\S]*?follows:\n/;

/** Text of a relayed harness message, without its frame and two-space indent. */
function unframe(text: string): string {
  return text
    .replace(HARNESS_TASK, '')
    .split('\n')
    .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
    .join('\n')
    .trim();
}

const TOOL_KIND: Record<string, string> = {
  Bash: 'execute',
  PowerShell: 'execute',
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
};

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function stringify(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

interface ParsedAgent {
  prompt?: string;
  segments: TurnSegment[];
  calls: ToolCallRecord[];
  startedAt?: number;
  lastActivityAt?: number;
  outputTokens: number;
  model?: string;
  structured?: unknown;
  finalText?: string;
}

/**
 * One agent's transcript, folded entry by entry. Transcripts are re-read on every poll
 * while a run is open and a running agent's file grows each time, so only the lines
 * appended since the last read are parsed.
 */
class AgentTranscript {
  readonly parsed: ParsedAgent = { segments: [], calls: [], outputTokens: 0 };
  /** Bytes consumed so far: up to the end of the last complete line. */
  offset = 0;
  private calls = new Map<string, ToolCallRecord>();
  // A message's blocks arrive as separate entries, each with the usage so far: keep the largest
  private outputByMessage = new Map<string, number>();
  private seg = 0;

  readFrom(file: string, size: number): void {
    if (size <= this.offset) return;
    const buf = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    // A line still being written is left for the next read
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.feed(JSON.parse(line));
      } catch {
        // not an entry we can read
      }
    }
    this.offset += end + 1;
  }

  private feed(e: any): void {
    const out = this.parsed;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      out.startedAt ??= ts;
      out.lastActivityAt = ts;
    }
    if (e.attachment?.type === 'structured_output') {
      out.structured = e.attachment.data;
      return;
    }
    const msg = e.message;
    if (!msg) return;
    if (e.type === 'user') {
      if (typeof msg.content === 'string') {
        if (HARNESS_TASK.test(msg.content)) out.prompt = unframe(msg.content);
        return;
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_result') continue;
        const call = this.calls.get(b.tool_use_id);
        if (!call) continue;
        const text = resultText(b.content);
        call.status = b.is_error ? 'failed' : 'completed';
        if (b.is_error) call.error = capToolOutput(text);
        else call.output = capToolOutput(text);
        if (Number.isFinite(ts)) call.completedAt = ts;
      }
      return;
    }
    if (e.type !== 'assistant') return;
    if (typeof msg.model === 'string' && !msg.model.startsWith('<')) out.model = msg.model;
    if (msg.id) {
      const before = this.outputByMessage.get(msg.id) ?? 0;
      const now = Math.max(before, Number(msg.usage?.output_tokens) || 0);
      this.outputByMessage.set(msg.id, now);
      out.outputTokens += now - before;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.segments.push({ kind: 'text', id: `w${this.seg++}`, text: b.text });
        out.finalText = b.text;
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        out.segments.push({ kind: 'thought', id: `w${this.seg++}`, text: b.thinking });
      } else if (b?.type === 'tool_use' && typeof b.id === 'string' && !this.calls.has(b.id)) {
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const call: ToolCallRecord = {
          id: b.id,
          title: typeof input.description === 'string' && input.description ? input.description : b.name,
          kind: TOOL_KIND[b.name] ?? 'other',
          status: 'running',
          input,
          startedAt: Number.isFinite(ts) ? ts : 0,
          toolName: b.name,
          description: typeof input.description === 'string' ? input.description : undefined,
        };
        this.calls.set(b.id, call);
        out.calls.push(call);
        out.segments.push({ kind: 'tool', id: `w${this.seg++}`, toolCallId: b.id });
      }
    }
  }
}

const cache = new Map<string, AgentTranscript>();
const CACHE_LIMIT = 200;

function parsedAgent(file: string): ParsedAgent | undefined {
  const st = plainFile(file);
  if (!st) return undefined;
  let t = cache.get(file);
  // Shorter than what was read: rewritten, so start over
  if (!t || st.size < t.offset) t = new AgentTranscript();
  try {
    t.readFrom(file, st.size);
  } catch {
    return undefined;
  }
  cache.delete(file);
  cache.set(file, t);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return t.parsed;
}

function readMeta(dir: string, id: string): { description?: string; workflowPhase?: string } {
  const file = path.join(dir, `agent-${id}.meta.json`);
  if (!plainFile(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

const firstLine = (text: string | undefined) =>
  text?.trim().split('\n').find((l) => l.trim())?.trim().replace(/^#+\s*/, '').slice(0, 200);

function agentInfo(dir: string, j: JournalAgent, launches: number, runActive: boolean): { info: WorkflowAgentInfo; parsed?: ParsedAgent } {
  const parsed = parsedAgent(path.join(dir, `agent-${j.id}.jsonl`));
  const meta = readMeta(dir, j.id);
  // The journal is the authority on how an agent ended. One with no outcome runs only while the
  // run does and only if the latest launch started it: an earlier launch's was cut off
  const status: AgentTaskStatus = j.outcome ?? (runActive && j.launch === launches ? 'running' : 'stopped');
  const calls = parsed?.calls ?? [];
  const last = calls[calls.length - 1];
  return {
    parsed,
    info: {
      id: j.id,
      label: j.label || meta.description || j.id,
      phase: j.phase || meta.workflowPhase,
      status,
      startedAt: parsed?.startedAt,
      lastActivityAt: parsed?.lastActivityAt,
      toolUses: calls.length,
      outputTokens: parsed?.outputTokens ?? 0,
      model: parsed?.model,
      lastTool: status === 'running' ? last?.toolName : undefined,
      lastText: firstLine(parsed?.finalText),
    },
  };
}

/** The run's phases and agents, as they stand on disk now. */
export function readWorkflowRun(task: AgentTask): WorkflowRunInfo | undefined {
  const dir = workflowDirOf(task);
  if (!dir) return undefined;
  const { agents, launches } = readJournal(dir);
  const script = readScriptMeta(task.audit?.scriptPath);
  const runActive = task.status === 'running';
  const infos = agents.map((j) => agentInfo(dir, j, launches, runActive).info);
  const phases = [...script.phases];
  for (const a of infos) if (a.phase && !phases.some((p) => p.title === a.phase)) phases.push({ title: a.phase });
  return { runId: task.audit?.runId, name: script.name, description: script.description, phases, agents: infos, launches };
}

/** One agent's prompt, steps and result. */
export function readWorkflowAgent(task: AgentTask, agentId: string): WorkflowAgentDetail | undefined {
  const dir = workflowDirOf(task);
  if (!dir || !AGENT_ID.test(agentId)) return undefined;
  const journal = readJournal(dir);
  const j = journal.agents.find((a) => a.id === agentId);
  if (!j) return undefined;
  const { info, parsed } = agentInfo(dir, j, journal.launches, task.status === 'running');
  const result = stringify(j.result) ?? stringify(parsed?.structured) ?? (info.status === 'completed' ? parsed?.finalText : undefined);
  return {
    agent: info,
    prompt: parsed?.prompt,
    segments: parsed?.segments ?? [],
    calls: parsed?.calls ?? [],
    result: capToolOutput(result),
  };
}
