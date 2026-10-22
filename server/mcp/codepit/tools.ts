import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionManager } from '../../acp/session-mgr.js';
import { store } from '../../store.js';
import { searchSessions } from '../../search.js';
import { getAgent, listAgents } from '../../agents/registry.js';
import { MAX_TAGS, normalizeTags } from '../../tags.js';
import { claudeSessionName } from './claude-names.js';
import { readCodepitMcpSettings, type CodepitMcpSettings } from './settings.js';
import type { AcpSession, SessionLink, SessionLinkKind, SessionSummary } from '../../types.js';

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

const inFamily = (a: string, b: string) => rootOf(a) === rootOf(b);

function isLinked(a: AcpSession, b: AcpSession): boolean {
  return Boolean(a.links?.some((l) => l.sessionId === b.id) || b.links?.some((l) => l.sessionId === a.id));
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
      'Send a message into another session as its next prompt: the session that started this one, a session this one started (or anything else started from the same root), or a linked session. It is queued if that session is busy. The message is marked as coming from this session.',
    inputSchema: obj(
      {
        id: str('The CodePit session id'),
        message: str('What to send'),
      },
      ['id', 'message']
    ),
    when: (settings) => settings.allowMessaging,
    run: async (caller, args) => {
      const target = sessionArg(args, 'id');
      if (target.id === caller.id) throw new ToolError('That is this session');
      if (!inFamily(caller.id, target.id) && !isLinked(caller, target)) {
        throw new ToolError('Only sessions related to this one can be messaged: its parent, sessions started from the same root, or linked sessions');
      }
      if (target.pendingStart) throw new ToolError('That session is waiting for the user to start it');
      const message = optString(args, 'message', MAX_PROMPT);
      if (!message) throw new ToolError('message is required');
      const text = `[Message from the CodePit session "${caller.title}" (id ${caller.id})]\n\n${message}`;
      const { queued } = await sessionManager.queuePrompt(target.id, text);
      return { sessions: [target.id], result: { id: target.id, queued, note: queued ? 'It is busy: the message goes out when its current turn ends.' : 'Sent.' } };
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
