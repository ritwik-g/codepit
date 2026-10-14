import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, AgentSessionRecord, AgentVersionInfo } from '../types';
import { api } from '../api';
import { Badge, Button, EmptyState, Segmented } from '../ui';
import { cx, formatTime } from './sessionMeta';
import { VendorIcon } from './VendorLogos';
import { DetailValue, exactTime } from './AgentsView';
import '../styles/agents.css';

/**
 * The Agents tab: the agent sessions behind this CodePit conversation, newest first.
 * CodePit continues the same agent session across Stop/Start and restarts where the agent
 * can; "Start fresh" sets it aside so the next message starts a new one.
 */

type HandoverMode = 'compact' | 'full' | 'none';

const HANDOVER: Array<{ value: HandoverMode; label: string; title: string }> = [
  { value: 'compact', label: 'Summary', title: 'The new agent session gets a summary of this conversation' },
  { value: 'full', label: 'Recent turns', title: 'The new agent session gets the recent turns word for word' },
  { value: 'none', label: 'Clean slate', title: 'The new agent session starts with nothing from this conversation' },
];

const shortName = (name: string) => name.replace(/ \(ACP\)$/, '');

export const AgentSessionsPanel: React.FC<{
  session: AcpSession;
  /** The agent session to scroll to and highlight, from a subagent's details. */
  focusedId?: string | null;
  busy: boolean;
  onChanged: () => void;
}> = ({ session, focusedId, busy, onChanged }) => {
  const records = [...(session.agentSessions || [])].sort((a, b) => b.lastStartedAt - a.lastStartedAt);
  const continuing = session.agentResume?.sessionId;
  // Set aside by a switch to another agent: switching back continues them
  const parked = new Set((session.parkedAgentResumes || []).map((p) => p.sessionId));
  // A running agent's session is set aside too, even one the agent could not continue later
  const hasCurrent = Boolean(continuing || session.isAgentRunning);
  const [mode, setMode] = useState<HandoverMode>('compact');
  const [working, setWorking] = useState(false);
  const focusRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedId]);

  const startFresh = async () => {
    setWorking(true);
    try {
      await api.forgetAgentSession(session.id, mode);
    } catch (err: any) {
      alert(`Could not start fresh: ${err.message}`);
    } finally {
      setWorking(false);
      onChanged();
    }
  };

  return (
    <div className="agents-tab">
      <div className="agents-col">
        <header className="agents-head">
          <h2 className="agents-title">Agent sessions</h2>
          <p className="agents-desc">
            The agent's own sessions behind this conversation. Stopping the agent or restarting CodePit continues the same one
            where the agent supports it, so it keeps its full memory.
          </p>
        </header>

        <AgentVersionSection session={session} records={records} />

        <section className="agent-sessions-fresh" aria-label="Start fresh">
          <div className="agent-sessions-fresh-text">
            <strong>Start fresh</strong>
            <span>
              {hasCurrent
                ? 'Your next message starts a new agent session instead of continuing the current one.'
                : 'Nothing to continue: your next message starts a new agent session anyway.'}
            </span>
          </div>
          <div className="agent-sessions-fresh-actions">
            <Segmented<HandoverMode> label="What the new session gets" size="sm" value={mode} onChange={setMode} options={HANDOVER} />
            <Button size="sm" icon="refresh" onClick={startFresh} loading={working} disabled={busy || working || !hasCurrent}>
              Start fresh
            </Button>
          </div>
          {busy && <p className="agents-note">Wait for the running turn to finish first.</p>}
        </section>

        {records.length === 0 ? (
          <EmptyState
            icon="bot"
            title="No agent sessions recorded yet"
            description="The agent session your next message starts or continues shows up here, with its id and transcript."
          />
        ) : (
          <ul className="agent-sessions-list">
            {records.map((r) => (
              <AgentSessionRow
                key={r.id}
                record={r}
                current={r.id === session.agentSessionId && Boolean(session.isAgentRunning)}
                continues={r.id === continuing}
                parked={parked.has(r.id)}
                focused={r.id === focusedId}
                ref={r.id === focusedId ? focusRef : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/**
 * The agent CLI's installed version, whether a newer one is out, and its own update command.
 * The agent runs the installed CLI, so an update reaches this conversation when its agent next
 * starts; stopping it and sending a message continues the same agent session on the new one.
 */
const AgentVersionSection: React.FC<{ session: AcpSession; records: AgentSessionRecord[] }> = ({ session, records }) => {
  const [info, setInfo] = useState<AgentVersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);

  const load = async (refresh: boolean) => {
    setChecking(true);
    setError(null);
    try {
      const { versions } = await api.getAgentVersions(refresh);
      setInfo(versions[session.agentId] ?? null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    setInfo(null);
    setUpdatedTo(null);
    load(false);
  }, [session.agentId]);

  const update = async () => {
    setUpdating(true);
    setError(null);
    try {
      const { version } = await api.updateAgent(session.agentId);
      if (version) setInfo(version);
      setUpdatedTo(version?.installed ?? null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUpdating(false);
    }
  };

  if (!info && !error) return null;
  const name = shortName(session.agentName);
  const running = session.isAgentRunning ? records.find((r) => r.id === session.agentSessionId)?.version : undefined;
  const behind = Boolean(running && info?.installed && running !== info.installed);
  const status = !info?.installed
    ? 'Installed version unknown.'
    : info.updateAvailable
    ? `${info.latest} is available${info.channel === 'stable' ? ' on the stable channel' : ''}.`
    : info.latest
    ? `Up to date${info.channel === 'stable' ? ' on the stable channel' : ''}.`
    : 'CodePit cannot check this agent for a newer release; Update runs its own update command.';

  return (
    <section className="agent-sessions-fresh" aria-label="Agent version">
      <div className="agent-sessions-fresh-text">
        <strong>
          {name} {info?.installed && <span className="mono">{info.installed}</span>}
        </strong>
        <span>{status}</span>
      </div>
      <div className="agent-sessions-fresh-actions">
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => load(true)} loading={checking} disabled={checking || updating}>
          Check again
        </Button>
        {info?.canUpdate && (
          <Button
            size="sm"
            variant={info.updateAvailable ? 'primary' : 'secondary'}
            onClick={update}
            loading={updating}
            disabled={checking || updating}
            title={`Runs ${info.binary} update`}
          >
            {updating ? 'Updating…' : 'Update'}
          </Button>
        )}
      </div>
      {updatedTo && <p className="agents-note">Now on {updatedTo}. New agent starts use it.</p>}
      {behind && (
        <p className="agents-note">
          The running agent is on {running}. Stop it and send a message to move it to {info!.installed}: it continues the same agent
          session, so nothing is lost.
        </p>
      )}
      {(error || info?.error) && <p className="agents-note tone-warn">{error || info?.error}</p>}
    </section>
  );
};

const AgentSessionRow = React.forwardRef<
  HTMLLIElement,
  { record: AgentSessionRecord; current: boolean; continues: boolean; parked: boolean; focused: boolean }
>(({ record: r, current, continues, parked, focused }, ref) => {
  const rows: Array<{ label: string; node: React.ReactNode }> = [
    { label: 'Session id', node: <DetailValue value={r.id} /> },
    { label: 'Started', node: exactTime(r.startedAt) },
  ];
  if (r.resumes > 0) rows.push({ label: 'Last continued', node: exactTime(r.lastStartedAt) });
  if (r.version) rows.push({ label: 'Version', node: <span className="mono">{r.version}</span> });
  // A set-aside session is only paused, so it does not read as ended
  const endLabel = parked ? 'Set aside' : 'Ended';
  if (r.endedAt) rows.push({ label: endLabel, node: `${exactTime(r.endedAt)}${r.endReason ? ` · ${r.endReason}` : ''}` });
  else if (r.endReason) rows.push({ label: endLabel, node: r.endReason });
  if (r.replacedBecause) rows.push({ label: 'Replaced the previous one', node: r.replacedBecause });
  if (r.transcriptPath) rows.push({ label: 'Transcript', node: <DetailValue value={r.transcriptPath} /> });

  return (
    <li ref={ref} className={cx('agent-sessions-item', focused && 'is-focused')}>
      <div className="agent-sessions-item-head">
        <VendorIcon agentId={r.agentId} size={16} />
        <span className="agent-sessions-name">{shortName(r.agentName)}</span>
        {r.model && <span className="mono agent-sessions-model">{r.model}</span>}
        <span className="agent-sessions-badges">
          {current ? (
            <Badge tone="ok" dot>
              Running
            </Badge>
          ) : continues ? (
            <Badge tone="accent" title="Your next message continues this agent session">
              Continues next
            </Badge>
          ) : parked ? (
            <Badge tone="info" title={`Switching back to ${shortName(r.agentName)} continues this agent session`}>
              Kept for later
            </Badge>
          ) : (
            <Badge tone="neutral">Ended</Badge>
          )}
          {r.resumes > 0 && (
            <Badge tone="info" title="How many times it was continued after a stop or restart">
              Continued {r.resumes}×
            </Badge>
          )}
        </span>
        <span className="agent-sessions-when" title={exactTime(r.lastStartedAt)}>
          {formatTime(r.lastStartedAt)}
        </span>
      </div>
      <dl className="agents-detail-list">
        {rows.map((row) => (
          <div key={row.label} className="agents-detail-row">
            <dt>{row.label}</dt>
            <dd>{row.node}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
});
AgentSessionRow.displayName = 'AgentSessionRow';
