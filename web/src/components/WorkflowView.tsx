import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AcpSession, AgentTask, AgentTaskStatus, ToolCallRecord, WorkflowAgentDetail, WorkflowAgentInfo, WorkflowRunInfo } from '../types';
import { Badge, Button, Icon, Progress, Spinner } from '../ui';
import { IoPanel, OutputText } from './AgentTurn';
import { MarkdownContent } from './MarkdownContent';
import { Timeline } from './TaskTimeline';
import { cx, formatTokens } from './sessionMeta';
import { STATUS, useNow } from './taskStatus';
import { describeTool, formatDuration } from '../toolDisplay';
import { useEscapeLayer } from '../hooks';
import '../styles/workflow.css';

/**
 * Workflow views: a board of phases and the agents in each, live.
 *
 * - A Claude workflow run: ACP only reports the run's totals, so the phases,
 *   agents and each agent's steps come from the run's folder on the host
 *   (GET /api/sessions/:id/tasks/:taskId/workflow), polled while it runs.
 * - Subagents (Codex's own sessions, Claude's Agent tool): the same board built
 *   from the session's tasks, one round per message that started them.
 */

const POLL_MS = 2500;

// ----------------------------------------------------------------- Board

export interface BoardCard {
  id: string;
  title: string;
  status: AgentTaskStatus;
  /** What it is doing now, or the first line of what it said last. */
  activity?: string;
  meta: string[];
  /** Nesting under another card in the same lane (a subagent's own subagent). */
  depth?: number;
  onOpen: () => void;
}

export interface BoardLane {
  key: string;
  title: string;
  detail?: string;
  cards: BoardCard[];
}

const AgentCard: React.FC<{ card: BoardCard }> = ({ card }) => {
  const status = STATUS[card.status];
  return (
    <li className="wf-card-item" style={card.depth ? { marginLeft: `${Math.min(card.depth, 3) * 16}px` } : undefined}>
      <button type="button" className={cx('wf-card', `is-${card.status}`)} onClick={card.onOpen}>
        <span className="wf-card-head">
          <span className="wf-card-title" title={card.title}>
            {card.depth ? <Icon name="chevronRight" size={12} className="wf-card-nest" /> : null}
            {card.title}
          </span>
          <Badge tone={status.tone}>
            {card.status === 'running' && <Spinner size={9} />}
            {status.label}
          </Badge>
        </span>
        {card.activity && (
          <span className={cx('wf-card-activity', card.status === 'running' && 'is-live')} title={card.activity}>
            {card.activity}
          </span>
        )}
        {card.meta.length > 0 && <span className="wf-card-meta">{card.meta.join(' · ')}</span>}
      </button>
    </li>
  );
};

const LaneProgress: React.FC<{ cards: BoardCard[] }> = ({ cards }) => {
  const done = cards.filter((c) => c.status !== 'running').length;
  const failed = cards.some((c) => c.status === 'failed');
  return (
    <span className="wf-lane-progress">
      <span className="wf-lane-count">
        {done}/{cards.length}
      </span>
      <Progress value={cards.length ? (done / cards.length) * 100 : 0} tone={failed ? 'danger' : done === cards.length ? 'ok' : 'accent'} size="sm" label={`${done} of ${cards.length} finished`} />
    </span>
  );
};

export const WorkflowBoard: React.FC<{ lanes: BoardLane[] }> = ({ lanes }) => (
  <div className="wf-board">
    {lanes.map((lane, i) => (
      <section key={lane.key} className="wf-lane" aria-label={lane.title}>
        <header className="wf-lane-head">
          <span className="wf-lane-step" aria-hidden>
            {i + 1}
          </span>
          <span className="wf-lane-titles">
            <span className="wf-lane-title" title={lane.title}>
              {lane.title}
            </span>
            {lane.detail && <span className="wf-lane-detail">{lane.detail}</span>}
          </span>
          {lane.cards.length > 0 && <LaneProgress cards={lane.cards} />}
        </header>
        {lane.cards.length > 0 ? (
          <ul className="wf-cards">
            {lane.cards.map((c) => (
              <AgentCard key={c.id} card={c} />
            ))}
          </ul>
        ) : (
          <p className="agents-note">Not started.</p>
        )}
      </section>
    ))}
  </div>
);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortModel = (m?: string) => m?.replace(/^claude-/, '');

/** "3 of 10 done · 2 running · 1 failed" */
function tally(statuses: AgentTaskStatus[]): string {
  const n = (s: AgentTaskStatus) => statuses.filter((x) => x === s).length;
  return [
    `${n('completed')} of ${plural(statuses.length, 'agent')} done`,
    n('running') ? `${n('running')} running` : null,
    n('failed') ? `${n('failed')} failed` : null,
    n('stopped') ? `${n('stopped')} stopped` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ------------------------------------------------- Claude workflow runs

function agentCard(a: WorkflowAgentInfo, now: number, onOpen: () => void): BoardCard {
  const end = a.status === 'running' ? now : a.lastActivityAt;
  return {
    id: a.id,
    title: a.label,
    status: a.status,
    activity: a.status === 'running' ? (a.lastTool ? `Using ${a.lastTool}` : 'Starting…') : a.lastText,
    meta: [
      shortModel(a.model),
      plural(a.toolUses, 'tool call'),
      a.startedAt && end ? formatDuration(end - a.startedAt) : null,
      a.outputTokens ? `${formatTokens(a.outputTokens)} out` : null,
    ].filter((x): x is string => Boolean(x)),
    onOpen,
  };
}

/** Fetches `load` now and, while `live`, every few seconds; keeps the last good value on errors. */
function usePolled<T>(load: () => Promise<T>, deps: unknown[], live: boolean): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  // Another run or agent: never show the last one's data under it (a change of `live` keeps it)
  const key = JSON.stringify(deps);
  useEffect(() => setState({}), [key]);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const data = await load();
        if (!cancelled) setState({ data });
      } catch (err: any) {
        if (!cancelled) setState((prev) => ({ ...prev, error: err?.message || 'Could not load' }));
      }
      if (!cancelled && live) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, live]);
  return state;
}

/**
 * The phases and agents of a Claude workflow run, and one agent's steps when
 * opened. Renders `fallback` when the run's folder is not known or readable.
 */
export const WorkflowRunPanel: React.FC<{ session: AcpSession; task: AgentTask; fallback: React.ReactNode }> = ({ session, task, fallback }) => {
  const [agentId, setAgentId] = useState<string | null>(null);
  const live = task.status === 'running';
  const { data, error } = usePolled(() => api.getWorkflowRun(session.id, task.id), [session.id, task.id], live);
  const run: WorkflowRunInfo | null | undefined = data?.run;
  const now = useNow(Boolean(run?.agents.some((a) => a.status === 'running')));

  useEffect(() => setAgentId(null), [task.id]);

  if (agentId) {
    return <WorkflowAgentPanel session={session} task={task} agentId={agentId} onBack={() => setAgentId(null)} />;
  }
  if (data === undefined) {
    return error ? (
      <p className="agents-note">Could not read the workflow run: {error}</p>
    ) : (
      <div className="timeline-thinking" role="status">
        <Spinner size={12} />
        <span>Reading the workflow run…</span>
      </div>
    );
  }
  if (!run) return <>{fallback}</>;

  const lanes: BoardLane[] = run.phases.map((p) => ({
    key: p.title,
    title: p.title,
    detail: p.detail,
    cards: run.agents.filter((a) => a.phase === p.title).map((a) => agentCard(a, now, () => setAgentId(a.id))),
  }));
  const loose = run.agents.filter((a) => !a.phase);
  if (loose.length > 0) {
    lanes.push({ key: '__agents', title: run.phases.length ? 'Other agents' : 'Agents', cards: loose.map((a) => agentCard(a, now, () => setAgentId(a.id))) });
  }

  return (
    <section className="agents-activity" aria-label="Workflow">
      <h3 className="agents-group-label">
        Phases <span className="agents-group-count">{run.agents.length > 0 ? tally(run.agents.map((a) => a.status)) : 'no agents started yet'}</span>
      </h3>
      {run.launches > 1 && <p className="agents-note">This run was launched {run.launches} times; agents from every launch are shown.</p>}
      {lanes.length > 0 ? <WorkflowBoard lanes={lanes} /> : <p className="agents-note">No agents have started yet.</p>}
    </section>
  );
};

/** Pretty JSON when the agent returned structured output, else its text as Markdown. */
const AgentResult: React.FC<{ text: string }> = ({ text }) => {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    return (
      <IoPanel label="Structured output" copy={t}>
        <OutputText text={t} />
      </IoPanel>
    );
  }
  return <MarkdownContent content={t} />;
};

const WorkflowAgentPanel: React.FC<{ session: AcpSession; task: AgentTask; agentId: string; onBack: () => void }> = ({
  session,
  task,
  agentId,
  onBack,
}) => {
  // A layer, so Esc goes back to the run before the Subagents tab closes the run itself
  useEscapeLayer(true, onBack);
  const [live, setLive] = useState(task.status === 'running');
  const { data, error } = usePolled(() => api.getWorkflowAgent(session.id, task.id, agentId), [session.id, task.id, agentId], live);
  const detail: WorkflowAgentDetail | undefined = data;
  useEffect(() => {
    if (detail) setLive(detail.agent.status === 'running');
  }, [detail?.agent.status]);
  const now = useNow(live);
  const calls = useMemo(() => new Map<string, ToolCallRecord>((detail?.calls ?? []).map((c) => [c.id, c])), [detail?.calls]);

  const back = (
    <div className="wf-back">
      <Button variant="ghost" size="sm" icon="arrowLeft" onClick={onBack}>
        All phases
      </Button>
    </div>
  );
  if (!detail) {
    return (
      <>
        {back}
        {error ? (
          <p className="agents-note">Could not read this agent: {error}</p>
        ) : (
          <div className="timeline-thinking" role="status">
            <Spinner size={12} />
            <span>Reading the agent’s transcript…</span>
          </div>
        )}
      </>
    );
  }
  const a = detail.agent;
  const status = STATUS[a.status];
  const end = a.status === 'running' ? now : a.lastActivityAt;
  const facts: Array<[string, string]> = [
    ...(a.phase ? [['Phase', a.phase] as [string, string]] : []),
    ...(a.model ? [['Model', a.model] as [string, string]] : []),
    ['Tool calls', String(a.toolUses)],
    ...(a.outputTokens ? [['Output', `${formatTokens(a.outputTokens)} tokens`] as [string, string]] : []),
    ...(a.startedAt && end ? [[a.status === 'running' ? 'Running for' : 'Took', formatDuration(end - a.startedAt) ?? ''] as [string, string]] : []),
  ];

  return (
    <>
      {back}
      <header className={cx('agents-focus-head', `is-${a.status}`)}>
        <span className={cx('agents-kind is-lg', `tone-${status.tone}`)} aria-hidden>
          <Icon name="bot" size={18} />
        </span>
        <div className="agents-focus-titles">
          <div className="agents-focus-kicker">Workflow agent · {task.title}</div>
          <h2 className="agents-focus-title">{a.label}</h2>
          <dl className="agents-facts">
            {facts.map(([k, v]) => (
              <div key={k} className="agents-fact">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Badge tone={status.tone}>
          {a.status === 'running' && <Spinner size={9} />}
          {status.label}
        </Badge>
      </header>

      {detail.prompt && (
        <div className="agents-prompt wf-prompt">
          <IoPanel label="Task the script gave it" copy={detail.prompt}>
            {detail.prompt}
          </IoPanel>
        </div>
      )}

      <section className="agents-activity" aria-label="Activity">
        <h3 className="agents-group-label">Activity</h3>
        {detail.segments.length > 0 ? (
          <Timeline segments={detail.segments} calls={calls} taskRunning={a.status === 'running'} />
        ) : (
          <p className="agents-note">{a.status === 'running' ? 'Starting…' : 'No steps recorded.'}</p>
        )}
      </section>

      {detail.result && (
        <section className="agents-result" aria-label="Result">
          <h3 className="agents-group-label">Returned</h3>
          <AgentResult text={detail.result} />
        </section>
      )}
    </>
  );
};

// ----------------------------------------------------------- Subagents

/** What a subagent is doing now (its latest call), or the first line it said last. */
function subagentActivity(task: AgentTask, calls: ToolCallRecord[]): string | undefined {
  if (task.status === 'running') {
    const last = calls[calls.length - 1];
    if (!last) return 'Starting…';
    const d = describeTool(last);
    return [d.verb, d.target].filter(Boolean).join(' ');
  }
  const text = [...(task.segments || [])].reverse().find((s) => s.kind === 'text' && s.text.trim());
  const line = text?.kind === 'text' ? text.text.trim().split('\n').find((l) => l.trim()) : undefined;
  return line?.replace(/^#+\s*/, '').slice(0, 200) || task.summary;
}

/** The first line of the user message a turn answered. */
function promptLine(turns: AcpSession['turns'], agentTurn: number): string | undefined {
  for (let i = agentTurn; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].content?.trim().split('\n').find((l) => l.trim())?.slice(0, 140);
  }
  return undefined;
}

/**
 * The session's subagents as a board: one lane per message that started them,
 * a subagent's own subagents nested under it.
 */
export const SubagentBoard: React.FC<{
  session: AcpSession;
  tasks: AgentTask[];
  callsOf: (task: AgentTask) => ToolCallRecord[];
  onOpen: (id: string) => void;
}> = ({ session, tasks, callsOf, onOpen }) => {
  const now = useNow(tasks.some((t) => t.status === 'running'));
  const subagents = tasks.filter((t) => t.kind === 'subagent');
  const turnOfCall = useMemo(() => {
    const map = new Map<string, number>();
    session.turns.forEach((turn, i) => (turn.toolCalls || []).forEach((c) => map.set(c.id, i)));
    return map;
  }, [session.turns]);

  const byId = new Map(subagents.map((t) => [t.id, t]));
  const rootOf = (t: AgentTask): AgentTask => {
    let cur = t;
    for (let guard = 0; cur.parentTaskId && byId.has(cur.parentTaskId) && guard < 10; guard++) cur = byId.get(cur.parentTaskId)!;
    return cur;
  };
  const depthOf = (t: AgentTask): number => {
    let d = 0;
    for (let cur = t; cur.parentTaskId && byId.has(cur.parentTaskId) && d < 10; d++) cur = byId.get(cur.parentTaskId)!;
    return d;
  };

  const lanes = new Map<string, { turn: number; tasks: AgentTask[] }>();
  for (const t of [...subagents].sort((a, b) => a.startedAt - b.startedAt)) {
    const root = rootOf(t);
    const turn = root.toolCallId ? turnOfCall.get(root.toolCallId) ?? -1 : -1;
    const key = `t${turn}`;
    if (!lanes.has(key)) lanes.set(key, { turn, tasks: [] });
    lanes.get(key)!.tasks.push(t);
  }

  // Children listed right after their parent
  const ordered = (list: AgentTask[]) => {
    const out: AgentTask[] = [];
    const visit = (t: AgentTask) => {
      out.push(t);
      for (const c of list.filter((x) => x.parentTaskId === t.id)) visit(c);
    };
    for (const t of list.filter((x) => !x.parentTaskId || !list.some((y) => y.id === x.parentTaskId))) visit(t);
    return out;
  };

  const boardLanes: BoardLane[] = [...lanes.entries()]
    .sort((a, b) => a[1].turn - b[1].turn)
    .map(([key, lane]) => ({
      key,
      title: (lane.turn >= 0 && promptLine(session.turns, lane.turn)) || 'Subagents',
      cards: ordered(lane.tasks).map((t) => {
        const calls = callsOf(t);
        const count = t.usage?.toolUses ?? calls.length;
        const end = t.status === 'running' ? now : t.endedAt;
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          activity: subagentActivity(t, calls),
          depth: depthOf(t),
          meta: [
            t.agentType,
            shortModel(t.audit?.subagentModel),
            plural(count, 'tool call'),
            t.usage?.durationMs != null && t.status !== 'running' ? formatDuration(t.usage.durationMs) : end ? formatDuration(end - t.startedAt) : null,
            t.usage?.totalTokens ? `${formatTokens(t.usage.totalTokens)} tokens` : null,
          ].filter((x): x is string => Boolean(x)),
          onOpen: () => onOpen(t.id),
        };
      }),
    }));

  if (boardLanes.length === 0) return <p className="agents-note">No subagents in this session yet.</p>;
  return (
    <section className="agents-activity" aria-label="Subagents board">
      <h3 className="agents-group-label">
        Rounds <span className="agents-group-count">{tally(subagents.map((t) => t.status))}</span>
      </h3>
      <WorkflowBoard lanes={boardLanes} />
    </section>
  );
};
