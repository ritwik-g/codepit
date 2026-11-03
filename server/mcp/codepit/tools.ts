import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionManager } from '../../acp/session-mgr.js';
import { store } from '../../store.js';
import { searchSessions } from '../../search.js';
import { getAgent, listAgents } from '../../agents/registry.js';
import { MAX_TAGS, normalizeTags } from '../../tags.js';
import { claudeSessionName, sessionsByClaudeName } from './claude-names.js';
import { logEvent, preview } from '../../event-log.js';
import { readCodepitMcpSettings, type CodepitMcpSettings } from './settings.js';
import type { AcpSession, SessionLink, SessionLinkKind, SessionSummary, UserAnnotations } from '../../types.js';

// The tools CodePit's MCP server offers. `caller` is always the session the request's
// token belongs to; no argument can stand in for it.

/** A refusal the agent should read: sent back as a tool error, not a protocol error. */
export class ToolError extends Error {}

export interface ToolResult {
  result: unknown;
  /** Sessions the call created or changed, for the audit log. */
  sessions?: string[];
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Offered only when this says so. */
  when?: (settings: CodepitMcpSettings) => boolean;
  run: (caller: AcpSession, args: Record<string, any>, settings: CodepitMcpSettings) => Promise<ToolResult> | ToolResult;
}

const LINK_KINDS: SessionLinkKind[] = ['related', 'follow-up', 'blocked-by'];
const MAX_PROMPT = 100_000;
const MAX_TURN_TEXT = 4000;
const MAX_NOTE = 2000;
const MAX_SNOOZE_MINUTES = 90 * 24 * 60;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const strList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

// ------------------------------------------------------------------ argument checks

function optString(args: Record<string, any>, key: string, max = 500): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolError(`${key} must be text`);
  if (v.length > max) throw new ToolError(`${key} is longer than ${max} characters`);
  return v.trim() || undefined;
}

function optBool(args: Record<string, any>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`${key} must be true or false`);
  return v;
}

function optStrings(args: Record<string, any>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) throw new ToolError(`${key} must be a list of text`);
  return v;
}

function optInt(args: Record<string, any>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`${key} must be a whole number from ${min} to ${max}`);
  return v;
}

function sessionArg(args: Record<string, any>, key: string, fallback?: AcpSession): AcpSession {
  const id = optString(args, key, 100);
  if (!id) {
    if (fallback) return fallback;
    throw new ToolError(`${key} is required`);
  }
  const s = store.get(id);
  if (!s) throw new ToolError(`No CodePit session with id ${id}. find_session looks one up by name or agent session id.`);
  return s;
}

/** send_to_session's target: by exactly one of id, name or agent_session_id. */
function messageTarget(args: Record<string, any>): AcpSession {
  const given = ['id', 'name', 'agent_session_id'].filter((k) => optString(args, k, 200));
  if (given.length !== 1) throw new ToolError('Give exactly one of id, name or agent_session_id');
  if (given[0] === 'id') return sessionArg(args, 'id');
  if (given[0] === 'agent_session_id') {
    const id = optString(args, 'agent_session_id', 200)!;
    const found = store.getAll().filter((s) => s.agentSessionId === id || s.agentSessions?.some((a) => a.id === id));
    if (found.length === 0) throw new ToolError(`No CodePit session has agent session ${id}`);
    return found[0];
  }
  const name = optString(args, 'name', 200)!;
  const found = sessionsByClaudeName(name);
  if (found.length === 0) throw new ToolError(`No CodePit session is or was named ${name}. find_session looks one up by title or text.`);
  // Auto-derived names repeat: the one running under the name wins, otherwise it must be the only one
  const running = found.filter((s) => claudeSessionName(s.agentSessionId) === name);
  const candidates = running.length > 0 ? running : found;
  if (candidates.length > 1) {
    const options = candidates.slice(0, 5).map((s) => `${s.id} ("${s.title}")`).join(', ');
    throw new ToolError(`More than one session is named ${name}: ${options}. Send by id instead.`);
  }
  return candidates[0];
}

// ------------------------------------------------------------------ views

const summaries = (): SessionSummary[] => sessionManager.listSessions();

/** Claude's current name for the session; only Claude registers one, under its unique session id. */
function agentSessionName(s: Pick<AcpSession, 'agentSessionId'>): string | undefined {
  return claudeSessionName(s.agentSessionId);
}

/** One session as the tools show it. */
function row(s: SessionSummary) {
  return {
    id: s.id,
    title: s.title,
    agent: s.agentId,
    model: s.model,
    state: s.pendingStart ? 'waiting_to_start' : s.state,
    agentRunning: Boolean(s.isAgentRunning),
    folder: s.cwd,
    branch: s.git?.branch,
    tags: s.user.tags ?? [],
    agentSessionId: s.agentSessionId,
    agentSessionName: agentSessionName(s),
    parentId: s.spawnedBy?.sessionId,
    links: s.links?.map((l) => ({ sessionId: l.sessionId, kind: l.kind })),
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

function rowOf(id: string | undefined) {
  if (!id) return null;
  const s = summaries().find((x) => x.id === id);
  return s ? row(s) : null;
}

/** The session at the top of `id`'s chain of parents. */
function rootOf(id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = store.get(current)?.spawnedBy?.sessionId;
    if (!parent || !store.get(parent)) break;
    current = parent;
  }
  return current;
}

/** Whether `descendantId` was started by `ancestorId`, directly or further down. */
function startedBy(ancestorId: string, descendantId: string): boolean {
  const seen = new Set<string>();
  let current = store.get(descendantId)?.spawnedBy?.sessionId;
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = store.get(current)?.spawnedBy?.sessionId;
  }
  return false;
}

/** The memory-graph stamp: [YYYY-MM-DD HH:MM] [repo:<main clone>] [name:<name>] [id:<agent session id>]. */
function stampFor(s: AcpSession): string | undefined {
  if (!s.agentSessionId) return undefined;
  let repo = path.basename(s.cwd);
  try {
    const common = execFileSync('git', ['-C', s.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common) repo = path.basename(path.dirname(common));
  } catch {
    // not a git folder: its own name
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[${when}] [repo:${repo}] [name:${agentSessionName(s) ?? s.title}] [id:${s.agentSessionId}]`;
}

/** What a session it started is told about it, so it can report back. */
function reportBackNote(parent: AcpSession, childAgentId: string, settings: CodepitMcpSettings): string {
  const name = agentSessionName(parent);
  let how: string;
  if (parent.agentId === 'claude' && childAgentId === 'claude' && name) {
    how = `send it a message with SendMessage to "${name}" (if that name stops working, the codepit whoami tool gives its current one)`;
  } else if (settings.allowMessaging) {
    how = `send it a message with the codepit send_to_session tool, id ${parent.id}`;
  } else {
    how = 'say so in your reply; it reads your progress with the codepit get_session tool';
  }
  return `\n\n---\nThis session was started by the CodePit session "${parent.title}" (id ${parent.id}). When you finish, or need a decision from it, ${how}.`;
}

// ------------------------------------------------------------------ tools

const TOOLS: ToolDef[] = [
  {
    name: 'whoami',
    description:
      'This session as CodePit knows it: its CodePit id, title, agent, model, folder, tags, agent session id and name, the session that started it, the sessions it started, and a memory-graph stamp "[YYYY-MM-DD HH:MM] [repo:..] [name:..] [id:..]".',
    inputSchema: obj({}),
    run: (caller, _args, settings) => {
      const all = summaries();
      const me = all.find((s) => s.id === caller.id)!;
      return {
        result: {
          ...row(me),
          stamp: stampFor(caller),
          depth: caller.spawnedBy?.depth ?? 0,
          parent: rowOf(caller.spawnedBy?.sessionId),
          children: all.filter((s) => s.spawnedBy?.sessionId === caller.id).map(row),
          rules: {
            startMode: settings.startMode,
            inheritTags: settings.inheritTags,
            maxDepth: settings.maxDepth,
            maxChildren: settings.maxChildren,
            messaging: settings.allowMessaging,
            delete: settings.allowDelete,
          },
        },
      };
    },
  },
  {
    name: 'list_sessions',
    description:
      'List CodePit sessions with their CodePit id, title, agent, model, state, folder, branch, tags, agent session id and (for Claude) agent session name, and parent. Sessions marked for cleanup are left out unless include_cleanup is true.',
    inputSchema: obj({
      scope: str('all (default), family (this session, the one that started it, and everything started from the same root), children (sessions this one started) or live (agent running)', {
        enum: ['all', 'family', 'children', 'live'],
      }),
      tag: str('Only sessions with this tag'),
      folder: str('Only sessions whose folder is or is inside this path'),
      query: str('Words that must all appear in the title, folder, branch, tags, prompts or transcript'),
      include_cleanup: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many, in CodePit attention order (default 50)' },
    }),
    run: (caller, args) => {
      const scope = optString(args, 'scope') ?? 'all';
      if (!['all', 'family', 'children', 'live'].includes(scope)) throw new ToolError('scope must be all, family, children or live');
      const tag = optString(args, 'tag');
      const folder = optString(args, 'folder', 4096);
      const query = optString(args, 'query');
      const includeCleanup = optBool(args, 'include_cleanup') ?? false;
      const limit = optInt(args, 'limit', 1, 200) ?? 50;
      const matching = query ? new Set(searchSessions(query).map((s) => s.id)) : null;
      const root = scope === 'family' ? rootOf(caller.id) : null;
      const wantTag = tag ? normalizeTags([tag])[0] : undefined;
      const folderPath = folder ? path.resolve(folder.replace(/^~/, os.homedir())) : undefined;
      const rows = summaries()
        .filter((s) => includeCleanup || !s.user.cleanup)
        .filter((s) => scope !== 'children' || s.spawnedBy?.sessionId === caller.id)
        .filter((s) => scope !== 'live' || s.isAgentRunning)
        .filter((s) => !root || rootOf(s.id) === root)
        .filter((s) => !wantTag || (s.user.tags ?? []).includes(wantTag))
        .filter((s) => !folderPath || s.cwd === folderPath || s.cwd.startsWith(folderPath + path.sep))
        .filter((s) => !matching || matching.has(s.id));
      return { result: { total: rows.length, sessions: rows.slice(0, limit).map(row) } };
    },
  },
  {
    name: 'find_session',
    description:
      'Look a session up by its agent session id (e.g. a Claude session id from a memory-graph stamp), its CodePit id, its name (CodePit title or Claude session name), or by text. Give one of the four.',
    inputSchema: obj({
      agent_session_id: str("The agent's own session id"),
      id: str('The CodePit session id'),
      name: str('A CodePit title or Claude session name; exact matches come first'),
      query: str('Words to search for in titles, prompts and transcripts'),
    }),
    run: (_caller, args) => {
      const agentSessionId = optString(args, 'agent_session_id', 200);
      const id = optString(args, 'id', 100);
      const name = optString(args, 'name');
      const query = optString(args, 'query');
      if (!agentSessionId && !id && !name && !query) throw new ToolError('Give agent_session_id, id, name or query');
      const all = summaries();
      let found: SessionSummary[];
      if (id) found = all.filter((s) => s.id === id);
      else if (agentSessionId) {
        // Earlier agent sessions behind a CodePit session count too
        found = all.filter((s) => s.agentSessionId === agentSessionId || store.get(s.id)?.agentSessions?.some((a) => a.id === agentSessionId));
      } else if (name) {
        const n = name.toLowerCase();
        const named = (s: SessionSummary) => [s.title, agentSessionName(s)].filter(Boolean).map((x) => x!.toLowerCase());
        const exact = all.filter((s) => named(s).includes(n));
        found = exact.length > 0 ? exact : all.filter((s) => named(s).some((x) => x.includes(n)));
      } else {
        const ids = new Set(searchSessions(query!).map((s) => s.id));
        found = all.filter((s) => ids.has(s.id));
      }
      return { result: { sessions: found.slice(0, 20).map(row) } };
    },
  },
  {
    name: 'get_session',
    description:
      "A session's status and its latest turns: state, recap, last prompt, anything waiting on the user (an approval or a question), queued messages, and the last few turns' text. Use it to check on a session this one started.",
    inputSchema: obj(
      {
        id: str('The CodePit session id'),
        turns: { type: 'integer', minimum: 0, maximum: 10, description: 'How many of the latest turns to include (default 2)' },
      },
      ['id']
    ),
    run: (_caller, args) => {
      const s = sessionArg(args, 'id');
      const turns = optInt(args, 'turns', 0, 10) ?? 2;
      const summary = summaries().find((x) => x.id === s.id)!;
      const recent = turns === 0 ? [] : s.turns.filter((t) => t.role !== 'system').slice(-turns);
      return {
        result: {
          ...row(summary),
          recap: s.recap,
          note: s.user.note || undefined,
          priority: s.user.priority ?? undefined,
          pinned: Boolean(s.user.pinned),
          snoozedUntil: s.user.snoozedUntil && s.user.snoozedUntil > Date.now() ? new Date(s.user.snoozedUntil).toISOString() : undefined,
          snoozeNote: s.user.snoozedUntil && s.user.snoozedUntil > Date.now() ? s.user.snoozeNote : undefined,
          reminder: s.user.reminder ? { at: new Date(s.user.reminder.at).toISOString(), note: s.user.reminder.note } : undefined,
          cleanup: Boolean(s.user.cleanup),
          lastPrompt: s.lastPrompt.slice(0, MAX_TURN_TEXT),
          waitingForApproval: s.pendingPermission?.title,
          waitingForAnswer: s.pendingElicitation?.message,
          heldPrompt: s.pendingStart?.prompt.slice(0, MAX_TURN_TEXT),
          queuedMessages: s.queuedPrompts?.length ?? 0,
          workingInBackground: Boolean(summary.workingInBackground),
          recentTurns: recent.map((t) => ({
            role: t.role,
            at: new Date(t.timestamp).toISOString(),
            text: (t.content || '').slice(-MAX_TURN_TEXT),
          })),
        },
      };
    },
  },
  {
    name: 'create_session',
    description:
      "Start a new CodePit session with a prompt, to hand work to another agent. Folder, agent and model default to this session's own; set them to run elsewhere or with another agent or model. Tags are copied from this session unless inherit_tags is false. The new session is told who started it and how to report back. Depending on the user's settings it starts at once or waits for the user to start it; the result says which.",
    inputSchema: obj(
      {
        prompt: str('The first message for the new session: the whole task, as you would hand it to a colleague'),
        title: str('A short title for the sidebar'),
        cwd: str("Absolute path of the folder to work in (default: this session's)"),
        agent: str("Agent id, e.g. claude or codex (default: this session's)"),
        model: str("Model id (default: this session's model when the agent is the same, else the agent's default)"),
        tags: strList('Tags to add, e.g. ["fe-v1"]'),
        inherit_tags: { type: 'boolean', description: "Copy this session's tags (default: the user's setting)" },
        start: str('now (default) or wait: leave it for the user to start. The user may require wait.', { enum: ['now', 'wait'] }),
        report_back: { type: 'boolean', description: 'Tell the new session to report back to this one when it finishes or needs a decision (default true)' },
      },
      ['prompt']
    ),
    run: async (caller, args, settings) => {
      const prompt = optString(args, 'prompt', MAX_PROMPT);
      if (!prompt) throw new ToolError('prompt is required');
      const title = optString(args, 'title', 200);
      const agentId = optString(args, 'agent', 64) ?? caller.agentId;
      if (!listAgents().some((a) => a.id === agentId)) throw new ToolError(`Unknown agent ${agentId}. Known: ${listAgents().map((a) => a.id).join(', ')}`);
      const rawCwd = optString(args, 'cwd', 4096);
      const cwd = rawCwd ? path.resolve(rawCwd.replace(/^~/, os.homedir())) : caller.cwd;
      let isDir = false;
      try {
        isDir = fs.statSync(cwd).isDirectory();
      } catch {
        // missing or unreadable
      }
      if (!isDir) throw new ToolError(`Folder does not exist: ${cwd}`);
      const sameAgent = agentId === caller.agentId;
      const model = optString(args, 'model', 200) ?? (sameAgent ? caller.model : undefined);
      const extraTags = optStrings(args, 'tags') ?? [];
      const inherit = optBool(args, 'inherit_tags') ?? settings.inheritTags;
      const tags = normalizeTags([...(inherit ? caller.user.tags ?? [] : []), ...extraTags]).slice(0, MAX_TAGS);
      const start = optString(args, 'start') ?? 'now';
      if (start !== 'now' && start !== 'wait') throw new ToolError('start must be now or wait');
      const reportBack = optBool(args, 'report_back') ?? true;

      const depth = (caller.spawnedBy?.depth ?? 0) + 1;
      if (depth > settings.maxDepth) {
        throw new ToolError(`Sessions may start sessions only ${settings.maxDepth} level${settings.maxDepth === 1 ? '' : 's'} deep, and this one is already at ${depth - 1}. The user can raise the limit in CodePit's MCP settings.`);
      }
      const started = store.getAll().filter((s) => s.spawnedBy?.sessionId === caller.id).length;
      if (started >= settings.maxChildren) {
        throw new ToolError(`This session has already started ${started} sessions, the most the user allows. The user can raise the limit in CodePit's MCP settings.`);
      }

      const hold = start === 'wait' || settings.startMode === 'ask';
      const text = reportBack ? prompt + reportBackNote(caller, agentId, settings) : prompt;
      let session: AcpSession;
      try {
        session = await sessionManager.createSession({
          agentId,
          cwd,
          title,
          model,
          tags,
          // The same approval mode as this session: never one the user did not choose
          mode: sameAgent ? caller.mode : undefined,
          spawnedBy: { sessionId: caller.id, at: Date.now(), depth },
          ...(hold ? { holdPrompt: { prompt: text, requestedBy: caller.id } } : { initialPrompt: text }),
        });
      } catch (err: any) {
        throw new ToolError(`Could not start the session: ${err?.message || err}`);
      }
      const fresh = store.get(session.id) ?? session;
      return {
        sessions: [session.id],
        result: {
          id: session.id,
          title: fresh.title,
          agent: agentId,
          agentName: getAgent(agentId).name,
          model: fresh.model,
          folder: cwd,
          tags,
          started: !hold,
          waitingForUser: hold,
          ...(hold ? { note: start === 'wait' ? 'It waits in CodePit until the user starts it.' : "The user's settings hold every new session until they start it; it is waiting in CodePit." } : {}),
          agentSessionId: fresh.agentSessionId,
          agentSessionName: agentSessionName(fresh),
        },
      };
    },
  },
  {
    name: 'tag_session',
    description: 'Add or remove tags on a session (this one by default). Tags group related sessions in CodePit.',
    inputSchema: obj({
      id: str('The CodePit session id (default: this session)'),
      add: strList('Tags to add'),
      remove: strList('Tags to remove'),
    }),
    run: (caller, args) => {
      const target = sessionArg(args, 'id', caller);
      const add = normalizeTags(optStrings(args, 'add') ?? []);
      const remove = new Set(normalizeTags(optStrings(args, 'remove') ?? []));
      if (add.length === 0 && remove.size === 0) throw new ToolError('Give tags to add or remove');
      const next = normalizeTags([...(target.user.tags ?? []).filter((t) => !remove.has(t)), ...add]);
      if (next.length > MAX_TAGS) throw new ToolError(`A session can have at most ${MAX_TAGS} tags`);
      sessionManager.updateAnnotations(target.id, { tags: next });
      return { sessions: [target.id], result: { id: target.id, tags: next } };
    },
  },
  {
    name: 'mark_cleanup',
    description:
      "Mark a session (this one by default) for cleanup once its work is finished: CodePit moves it to the sidebar's Cleanup tab, " +
      'leaves it out of list_sessions unless include_cleanup is true, and no longer offers to restore it after a restart. It is not ' +
      'deleted and its agent is not stopped. Set cleanup to false to unmark it.',
    inputSchema: obj({
      id: str('The CodePit session id (default: this session)'),
      cleanup: { type: 'boolean', description: 'true (default) to mark, false to unmark' },
    }),
    run: (caller, args) => {
      const target = sessionArg(args, 'id', caller);
      const cleanup = optBool(args, 'cleanup') ?? true;
      if (cleanup && target.pendingStart) throw new ToolError('That session is waiting for the user to start it; the user can discard it in CodePit instead');
      const was = Boolean(target.user.cleanup);
      sessionManager.updateAnnotations(target.id, { cleanup });
      return { sessions: [target.id], result: { id: target.id, title: target.title, cleanup, changed: was !== cleanup } };
    },
  },
  {
    name: 'snooze_session',
    description:
      'Snooze a session (this one by default) until a time, with a note saying what to come back for. It sinks to the bottom of ' +
      "CodePit's list; when the snooze ends it counts as needing the user, with the note shown as a reminder. Use it while waiting on " +
      'something outside CodePit (CI, a review, a deploy). Give minutes or until; set wake to true to end a snooze now.',
    inputSchema: obj({
      id: str('The CodePit session id (default: this session)'),
      minutes: { type: 'integer', minimum: 1, maximum: MAX_SNOOZE_MINUTES, description: 'Snooze for this many minutes' },
      until: str('Snooze until this time, ISO 8601 (e.g. 2026-11-04T09:00:00+05:30)'),
      note: str('What to come back for, shown with the reminder'),
      wake: { type: 'boolean', description: 'true ends the snooze now, without a reminder' },
    }),
    run: (caller, args) => {
      const target = sessionArg(args, 'id', caller);
      const minutes = optInt(args, 'minutes', 1, MAX_SNOOZE_MINUTES);
      const until = optString(args, 'until', 100);
      const note = optString(args, 'note', 500);
      const wake = optBool(args, 'wake') ?? false;
      if (wake) {
        if (minutes !== undefined || until || note) throw new ToolError('wake takes no minutes, until or note');
        sessionManager.updateAnnotations(target.id, { snoozedUntil: null });
        return { sessions: [target.id], result: { id: target.id, snoozedUntil: null } };
      }
      if ((minutes === undefined) === !until) throw new ToolError('Give exactly one of minutes or until (or wake: true)');
      const at = minutes !== undefined ? Date.now() + minutes * 60_000 : Date.parse(until!);
      if (!Number.isFinite(at)) throw new ToolError('until must be an ISO 8601 time');
      if (at <= Date.now()) throw new ToolError('until must be in the future');
      if (at > Date.now() + MAX_SNOOZE_MINUTES * 60_000) throw new ToolError(`A snooze can last at most ${MAX_SNOOZE_MINUTES / 1440} days`);
      sessionManager.updateAnnotations(target.id, { snoozedUntil: at, snoozeNote: note });
      return { sessions: [target.id], result: { id: target.id, snoozedUntil: new Date(at).toISOString(), note } };
    },
  },
  {
    name: 'rename_session',
    description: "Set a session's title (this one by default), as shown in CodePit's sidebar. Counts as a title the user chose: the agent's own titles no longer replace it.",
    inputSchema: obj(
      {
        id: str('The CodePit session id (default: this session)'),
        title: str('The new title: short, saying what the session is for'),
      },
      ['title']
    ),
    run: (caller, args) => {
      const target = sessionArg(args, 'id', caller);
      const title = optString(args, 'title', 200)?.replace(/\s+/g, ' ');
      if (!title) throw new ToolError('title is required');
      const s = store.get(target.id)!;
      const was = s.title;
      s.title = title;
      s.titleSource = 'user';
      store.save(s, { touch: false });
      sessionManager.emit('sessionsUpdated', sessionManager.listSessions());
      return { sessions: [s.id], result: { id: s.id, title, was } };
    },
  },
  {
    name: 'set_note',
    description:
      "Set the note on a session (this one by default), shown with it in CodePit: e.g. a handoff summary, where the work stands, or what is left. Replaces any note already there; an empty note clears it. get_session returns the current note.",
    inputSchema: obj(
      {
        id: str('The CodePit session id (default: this session)'),
        note: str(`The note, at most ${MAX_NOTE} characters; empty clears it`),
      },
      ['note']
    ),
    run: (caller, args) => {
      const target = sessionArg(args, 'id', caller);
      const v = args.note;
      if (typeof v !== 'string') throw new ToolError('note must be text');
      if (v.length > MAX_NOTE) throw new ToolError(`note is longer than ${MAX_NOTE} characters`);
      const note = v.trim();
      sessionManager.updateAnnotations(target.id, { note });
      return { sessions: [target.id], result: { id: target.id, note } };
    },
  },
  {
    name: 'prioritize_session',
    description: "Set a session's priority (p0 highest, p1, p2, or none) and whether it is pinned to the top of CodePit's list. This one by default.",
    inputSchema: obj({
      id: str('The CodePit session id (default: this session)'),
      priority: str('p0, p1, p2 or none', { enum: ['p0', 'p1', 'p2', 'none'] }),
      pinned: { type: 'boolean' },
    }),
    run: (caller, args) => {
      const target = sessionArg(args, 'id', caller);
      const priority = optString(args, 'priority', 10);
      const pinned = optBool(args, 'pinned');
      if (priority === undefined && pinned === undefined) throw new ToolError('Give priority, pinned or both');
      if (priority !== undefined && !['p0', 'p1', 'p2', 'none'].includes(priority)) throw new ToolError('priority must be p0, p1, p2 or none');
      const patch: Partial<UserAnnotations> = {};
      if (priority !== undefined) patch.priority = priority === 'none' ? null : (priority as 'p0' | 'p1' | 'p2');
      if (pinned !== undefined) patch.pinned = pinned;
      const updated = sessionManager.updateAnnotations(target.id, patch)!;
      return { sessions: [target.id], result: { id: target.id, priority: updated.user.priority ?? 'none', pinned: Boolean(updated.user.pinned) } };
    },
  },
  {
    name: 'stop_session',
    description:
      "Stop the agent of a session this one started (directly or further down), once its work is done, to free its memory. Its conversation is kept: a later message starts it again. A session in the middle of a turn is refused unless force is true, which cancels that turn. Only sessions this one started can be stopped.",
    inputSchema: obj(
      {
        id: str('The CodePit session id'),
        force: { type: 'boolean', description: 'Cancel a turn in progress and stop anyway (default false)' },
      },
      ['id']
    ),
    run: async (caller, args) => {
      const target = sessionArg(args, 'id');
      if (target.id === caller.id) throw new ToolError('A session cannot stop itself');
      if (!startedBy(caller.id, target.id)) throw new ToolError(`${target.id} ("${target.title}") was not started by this session, so it cannot stop it`);
      const force = optBool(args, 'force') ?? false;
      if (!sessionManager.isAgentRunning(target.id)) return { sessions: [target.id], result: { id: target.id, stopped: false, note: 'Its agent was not running.' } };
      if (sessionManager.isTurnInFlight(target.id) && !force) {
        throw new ToolError('That session is in the middle of a turn. Wait for it (get_session shows its state), or set force to cancel the turn.');
      }
      await sessionManager.stopSessionAgent(target.id, { reason: `Stopped by the session "${caller.title}"` });
      return { sessions: [target.id], result: { id: target.id, stopped: true } };
    },
  },
  {
    name: 'delete_session',
    description:
      'Delete a session this one started (directly or further down): its conversation, attachments and terminal go, and it cannot be ' +
      'undone. Prefer mark_cleanup, which the user can review and undo; delete only scratch sessions whose work is finished and of no ' +
      'further use. Refused for a session still in a turn, one that started sessions of its own (delete those first), or any session ' +
      'this one did not start.',
    inputSchema: obj(
      {
        id: str('The CodePit session id'),
        confirm_title: str('The title of the session being deleted, exactly as get_session or list_sessions shows it, as a check against the wrong id'),
      },
      ['id', 'confirm_title']
    ),
    when: (settings) => settings.allowDelete,
    run: (caller, args) => {
      const target = sessionArg(args, 'id');
      if (target.id === caller.id) throw new ToolError('A session cannot delete itself');
      if (!startedBy(caller.id, target.id)) throw new ToolError(`${target.id} ("${target.title}") was not started by this session, so it cannot delete it`);
      if (optString(args, 'confirm_title', 200) !== target.title) throw new ToolError(`confirm_title does not match: ${target.id} is titled "${target.title}"`);
      if (sessionManager.isTurnInFlight(target.id)) throw new ToolError('That session is in the middle of a turn. Wait for it, or stop it with stop_session first.');
      const kids = store.getAll().filter((s) => s.spawnedBy?.sessionId === target.id);
      if (kids.length > 0) throw new ToolError(`That session started ${kids.length} session${kids.length === 1 ? '' : 's'} of its own (${kids.slice(0, 5).map((s) => s.id).join(', ')}); delete or keep those first`);
      const title = target.title;
      if (!sessionManager.deleteSession(target.id)) throw new ToolError('Could not delete the session');
      return { sessions: [target.id], result: { id: target.id, title, deleted: true } };
    },
  },
  {
    name: 'link_sessions',
    description:
      'Record how two sessions relate, shown in CodePit: related, follow-up (from is a follow-up of to) or blocked-by (from waits on to). The session that started another is linked to it already. Set remove to undo a link.',
    inputSchema: obj(
      {
        to: str('The other CodePit session id'),
        from: str('The CodePit session id the link starts at (default: this session)'),
        kind: str('related (default), follow-up or blocked-by', { enum: LINK_KINDS }),
        remove: { type: 'boolean' },
      },
      ['to']
    ),
    run: (caller, args) => {
      const from = sessionArg(args, 'from', caller);
      const to = sessionArg(args, 'to');
      if (from.id === to.id) throw new ToolError('A session cannot be linked to itself');
      const kind = (optString(args, 'kind') ?? 'related') as SessionLinkKind;
      if (!LINK_KINDS.includes(kind)) throw new ToolError(`kind must be ${LINK_KINDS.join(', ')}`);
      const remove = optBool(args, 'remove') ?? false;
      const updated = sessionManager.updateRelations(from.id, (s) => {
        const others = (s.links ?? []).filter((l) => !(l.sessionId === to.id && l.kind === kind));
        const link: SessionLink = { sessionId: to.id, kind, at: Date.now(), by: caller.id };
        s.links = remove ? others : [...others, link];
        if (s.links.length === 0) delete s.links;
      });
      return { sessions: [from.id, to.id], result: { from: from.id, links: updated?.links ?? [] } };
    },
  },
  {
    name: 'send_to_session',
    description:
      'Send a message into any other CodePit session as its next prompt, by its CodePit id, its Claude session name, or its agent session id. ' +
      "A session whose agent is stopped is started again, continuing its conversation, so this also reaches sessions Claude's SendMessage cannot: " +
      'use it when SendMessage fails because the session is not running. It is queued if that session is busy. The message is marked as coming from this session.',
    inputSchema: obj(
      {
        id: str('The CodePit session id'),
        name: str('The Claude session name, the address SendMessage takes (e.g. unstract-repos-55)'),
        agent_session_id: str("The agent's own session id (e.g. a Claude session id)"),
        message: str('What to send'),
      },
      ['message']
    ),
    when: (settings) => settings.allowMessaging,
    run: async (caller, args) => {
      const addressed = { name: optString(args, 'name', 200), agentSessionId: optString(args, 'agent_session_id', 200) };
      const to = { name: addressed.name, sessionId: optString(args, 'id', 100) };
      const message = optString(args, 'message', MAX_PROMPT);
      const from = { sessionId: caller.id, title: caller.title, name: agentSessionName(caller) ?? caller.lastAgentSessionName };
      try {
        const target = messageTarget(args);
        if (target.id === caller.id) throw new ToolError('That is this session');
        if (target.pendingStart) throw new ToolError('That session is waiting for the user to start it');
        if (!message) throw new ToolError('message is required');
        const replyTo = from.name ? `reply with SendMessage to "${from.name}", or ` : 'reply ';
        const text = `[Message from the CodePit session "${caller.title}" (id ${caller.id}); ${replyTo}with the codepit send_to_session tool, id ${caller.id}]\n\n${message}`;
        const wasRunning = sessionManager.isAgentRunning(target.id);
        const { queued } = await sessionManager.queuePrompt(target.id, text, undefined, { startReason: `Message from the session "${caller.title}"` });
        const delivery = queued ? 'queued' : wasRunning ? 'sent' : 'started';
        logEvent({
          kind: 'message.sent',
          via: 'codepit',
          from,
          to: { sessionId: target.id, title: target.title, name: agentSessionName(target) ?? target.lastAgentSessionName },
          delivery,
          preview: preview(message),
        });
        const note = {
          queued: 'It is busy: the message goes out when its current turn ends.',
          sent: 'Sent.',
          started: 'Its agent was stopped: CodePit started it again, continuing its conversation, and sent the message.',
        }[delivery];
        return { sessions: [target.id], result: { id: target.id, title: target.title, delivery, queued, note } };
      } catch (err: any) {
        logEvent({ kind: 'message.refused', via: 'codepit', from, to, error: err?.message || String(err), ...(message ? { preview: preview(message) } : {}) });
        throw err;
      }
    },
  },
];

export function listTools(settings: CodepitMcpSettings = readCodepitMcpSettings()) {
  return TOOLS.filter((t) => !t.when || t.when(settings)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(caller: AcpSession, name: string, args: unknown, settings: CodepitMcpSettings = readCodepitMcpSettings()): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name && (!t.when || t.when(settings)));
  if (!tool) throw new ToolError(`Unknown tool ${name}`);
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) throw new ToolError('Arguments must be an object');
  return tool.run(caller, (args ?? {}) as Record<string, any>, settings);
}
