import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { SessionEvent } from '../types';
import { Modal } from './Modal';
import { relativeTime } from './Sidebar';
import { Badge, Button, Field, SectionHeader, Segmented, Spinner } from '../ui';
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
  'agent.stopped': 'Agent stopped',
};

const DELIVERY_LABEL = { sent: 'sent', queued: 'queued behind a turn', started: 'started its agent' } as const;

/** Messages between sessions and agents CodePit stopped, newest first. */
const EventLog: React.FC<{ onSelectSession: (id: string) => void }> = ({ onSelectSession }) => {
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.getEvents({ limit: 100 });
      setEvents(r.events);
      setFile(r.file);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const party = (p: SessionEvent['from']) =>
    !p ? null : p.sessionId ? (
      <button type="button" className="mcp-linkbtn" onClick={() => onSelectSession(p.sessionId!)}>
        {p.title ?? p.name ?? p.sessionId}
      </button>
    ) : (
      <code>{p.name ?? 'unknown'}</code>
    );

  return (
    <section>
      <SectionHeader
        title="Event log"
        description={file && <span className="mono cpm-path">{file}</span>}
        actions={
          <Button size="sm" variant="ghost" icon="refresh" onClick={load} loading={busy}>
            Refresh
          </Button>
        }
      />
      {error ? (
        <div className="acct-inline-error">{error}</div>
      ) : !events ? (
        <div className="mcp-loading">
          <Spinner size={14} /> Loading…
        </div>
      ) : events.length === 0 ? (
        <p className="cpm-hint">No messages between sessions or stopped agents yet.</p>
      ) : (
        <ul className="cpm-audit">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`cpm-audit-row ${e.kind === 'message.refused' ? 'is-refused' : ''}`}>
              <span className="cpm-audit-time" title={new Date(e.at).toLocaleString()}>
                {relativeTime(Date.parse(e.at))}
              </span>
              <span className="cpm-audit-main">
                <span className="cpm-audit-top">
                  <code>{KIND_LABEL[e.kind]}</code>
                  {e.via && <Badge tone="neutral">{e.via === 'claude' ? 'SendMessage' : 'send_to_session'}</Badge>}
                  {e.kind === 'message.refused' && <Badge tone="danger">Failed</Badge>}
                  {e.kind === 'agent.stopped' ? (
                    <>
                      {party(e.to)}
                      <span className="cpm-hint">{e.reason === 'idle' ? `unused for ${hoursLabel(e.idleHours ?? 0)}` : 'by you'}</span>
                    </>
                  ) : (
                    <>
                      {party(e.from)} → {party(e.to)}
                      {e.delivery && <span className="cpm-hint">{DELIVERY_LABEL[e.delivery]}</span>}
                    </>
                  )}
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

export const SettingsModal: React.FC<{ onClose: () => void; onSelectSession: (id: string) => void }> = ({ onClose, onSelectSession }) => (
  <Modal onClose={onClose} heading="Settings" icon="settings" description="Applies to every session." size="md">
    <IdleStopSetting />
    <EventLog onSelectSession={onSelectSession} />
  </Modal>
);
