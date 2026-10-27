import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { EventCategory, EventParty, SessionEvent, SessionSummary } from '../types';
import { Modal } from './Modal';
import { relativeTime } from './Sidebar';
import { Badge, Button, Field, SectionHeader, Segmented, Spinner, Switch } from '../ui';
import { useComposerLayout, type ComposerPosition } from '../composerLayout';
import '../styles/mcp.css';

const hoursLabel = (h: number) => (h === 0 ? 'Never' : h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h}h`);

/** Stop agents left unused: each running one holds hundreds of MB until it is stopped. */
const IdleStopSetting: React.FC = () => {
  const [hours, setHours] = useState<number | null>(null);
  const [choices, setChoices] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getIdleStop()
      .then((r) => {
        setHours(r.hours);
        setChoices(r.choices);
      })
      .catch((err) => setError(err?.message || String(err)));
  }, []);
  const change = async (next: string) => {
    const prev = hours;
    setHours(Number(next));
    setError(null);
    try {
      setHours((await api.setIdleStop(Number(next))).hours);
    } catch (err: any) {
      setHours(prev);
      setError(err?.message || String(err));
    }
  };
  return (
    <Field
      label="Stop agents left unused for"
      hint="A stopped agent frees its memory. Your next message starts it again and carries on the same conversation."
      error={error}
    >
      {hours === null ? (
        !error && <Spinner />
      ) : (
        <Segmented<string>
          size="sm"
          label="Stop agents left unused for"
          value={String(hours)}
          onChange={change}
          options={choices.map((h) => ({ value: String(h), label: hoursLabel(h) }))}
        />
      )}
    </Field>
  );
};

const KIND_LABEL: Record<SessionEvent['kind'], string> = {
  'message.sent': 'Message',
  'message.refused': 'Message',
  'message.received': 'Received',
  'agent.started': 'Agent started',
  'agent.stopped': 'Agent stopped',
  'agent.failed': 'Agent failed to start',
  'agent.exited': 'Agent exited',
  'session.created': 'Session created',
  'session.deleted': 'Session deleted',
  'setting.changed': 'Setting changed',
};

const FAILED = new Set<SessionEvent['kind']>(['message.refused', 'agent.failed', 'agent.exited']);
const DELIVERY_LABEL = { sent: 'sent', queued: 'queued behind a turn', started: 'started its agent' } as const;

type CategoryFilter = 'all' | EventCategory;
const CATEGORY_OPTIONS: Array<{ value: CategoryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Messages' },
  { value: 'agents', label: 'Agents' },
  { value: 'sessions', label: 'Sessions & settings' },
];
const DAY_OPTIONS = [
  { value: '1', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
];

const settingValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Older events (before reasons were words): idle and user stops. */
const reasonText = (e: SessionEvent) =>
  e.reason === 'idle' ? `Unused for ${hoursLabel(e.idleHours ?? 0)}` : e.reason === 'user' ? 'Stopped by you' : e.reason;

/** Sessions, their agents and the messages between them, newest first. */
const EventLog: React.FC<{ sessions: SessionSummary[]; onSelectSession: (id: string) => void }> = ({ sessions, onSelectSession }) => {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [days, setDays] = useState('7');
  const [sessionId, setSessionId] = useState('');
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [info, setInfo] = useState<{ location: string; keptDays: number; compressedAfterDays: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.getEvents({ limit: 500, days: Number(days), sessionId: sessionId || undefined, categories: category === 'all' ? undefined : [category] });
      setEvents(r.events);
      setInfo({ location: r.location, keptDays: r.keptDays, compressedAfterDays: r.compressedAfterDays });
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [category, days, sessionId]);
  useEffect(() => {
    load();
  }, [load]);

  const party = (p: EventParty | undefined) =>
    !p ? null : p.sessionId && sessions.some((s) => s.id === p.sessionId) ? (
      <button type="button" className="mcp-linkbtn" onClick={() => onSelectSession(p.sessionId!)}>
        {p.title ?? p.name ?? p.sessionId}
      </button>
    ) : (
      <code>{p.title ?? p.name ?? p.sessionId ?? 'unknown'}</code>
    );

  const detail = (e: SessionEvent) => {
    if (e.kind.startsWith('message.')) {
      return (
        <>
          {party(e.from)} → {party(e.to)}
          {e.delivery && <span className="cpm-hint">{DELIVERY_LABEL[e.delivery]}</span>}
        </>
      );
    }
    if (e.kind === 'setting.changed' && e.setting) {
      return (
        <span className="cpm-hint">
          {e.setting.name}: {settingValue(e.setting.from)} → {settingValue(e.setting.to)}
        </span>
      );
    }
    return (
      <>
        {party(e.session ?? e.to)}
        {reasonText(e) && <span className="cpm-hint">{reasonText(e)}</span>}
        {e.kind === 'agent.started' && e.resumed && <span className="cpm-hint">(continued its conversation)</span>}
      </>
    );
  };

  return (
    <section>
      <SectionHeader
        title="Event log"
        description={
          info && (
            <span>
              Kept {info.keptDays} days, compressed after {info.compressedAfterDays}. <span className="mono cpm-path">{info.location}</span>
            </span>
          )
        }
        actions={
          <Button size="sm" variant="ghost" icon="refresh" onClick={load} loading={busy}>
            Refresh
          </Button>
        }
      />
      <div className="settings-event-filters">
        <Segmented<CategoryFilter> size="sm" label="Kind of event" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
        <Segmented<string> size="sm" label="How far back" value={days} onChange={setDays} options={DAY_OPTIONS} />
        <select className="ui-input settings-event-session" aria-label="Session" value={sessionId} onChange={(ev) => setSessionId(ev.target.value)}>
          <option value="">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <div className="acct-inline-error">{error}</div>
      ) : !events ? (
        <div className="mcp-loading">
          <Spinner size={14} /> Loading…
        </div>
      ) : events.length === 0 ? (
        <p className="cpm-hint">Nothing logged for these filters.</p>
      ) : (
        <ul className="cpm-audit">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`cpm-audit-row ${FAILED.has(e.kind) ? 'is-refused' : ''}`}>
              <span className="cpm-audit-time" title={new Date(e.at).toLocaleString()}>
                {relativeTime(Date.parse(e.at))}
              </span>
              <span className="cpm-audit-main">
                <span className="cpm-audit-top">
                  <code>{KIND_LABEL[e.kind] ?? e.kind}</code>
                  {e.via && <Badge tone="neutral">{e.via === 'claude' ? 'SendMessage' : 'send_to_session'}</Badge>}
                  {e.kind === 'message.refused' && <Badge tone="danger">Failed</Badge>}
                  {detail(e)}
                </span>
                {e.error && <span className="cpm-audit-error">{e.error}</span>}
                {e.preview && <span className="cpm-hint">{e.preview}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** Where the message box sits. On this device only; phones always keep it at the bottom. */
const ComposerLayoutSetting: React.FC = () => {
  const [layout, update] = useComposerLayout();
  return (
    <Field
      label="Message box position"
      hint="Top keeps typing and the start of each reply near eye level. Saved on this device; phones keep it at the bottom."
    >
      <Segmented<ComposerPosition>
        size="sm"
        label="Message box position"
        value={layout.position}
        onChange={(position) => update({ position })}
        options={[
          { value: 'bottom', label: 'Bottom' },
          { value: 'top', label: 'Top' },
        ]}
      />
      <Switch
        checked={layout.compactWhenIdle}
        onChange={(compactWhenIdle) => update({ compactWhenIdle })}
        label="Shrink when not typing"
        description="Collapses to one line until you click it or press i."
      />
    </Field>
  );
};

export const SettingsModal: React.FC<{ sessions: SessionSummary[]; onClose: () => void; onSelectSession: (id: string) => void }> = ({
  sessions,
  onClose,
  onSelectSession,
}) => (
  <Modal onClose={onClose} heading="Settings" icon="settings" description="Applies to every session." size="lg">
    <ComposerLayoutSetting />
    <IdleStopSetting />
    <EventLog sessions={sessions} onSelectSession={onSelectSession} />
  </Modal>
);
