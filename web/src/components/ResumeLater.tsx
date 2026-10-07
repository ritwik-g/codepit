import React, { useEffect, useMemo, useState } from 'react';
import type { LimitResumeMode, ScheduledResume } from '../types';
import { api } from '../api';
import { Button, Icon, Input, Segmented, Textarea } from '../ui';
import { Modal } from './Modal';
import { atHour, toLocalInput, whenLabel } from './SessionOrganize';
import { shortTime } from './Sidebar';

// A session that sends a message by itself later: after Claude's 5-hour usage limit resets,
// or at a time the user picked when pausing it. The server keeps the time, so it resumes
// with this view closed and after a restart.

export const RESUME_PROMPT = 'Continue from where you left off.';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** "in 2h 10m", "in 4m", "now". */
function untilLabel(ts: number, now: number): string {
  const mins = Math.round((ts - now) / MIN);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h >= 24 ? `in ${Math.round(h / 24)}d` : `in ${h}h${m ? ` ${m}m` : ''}`;
}

function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** The card above the composer while the session waits to resume. */
export const ResumeBanner: React.FC<{
  sessionId: string;
  resume: ScheduledResume;
  onPickTime: () => void;
}> = ({ sessionId, resume, onPickTime }) => {
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const limit = resume.reason === 'limit';
  const at = resume.at;
  const due = resume.armed && at !== undefined && at <= now;
  const when = at !== undefined ? `${shortTime(at)} (${untilLabel(at, now)})` : '';
  // The message usually ends in a full stop of its own, so the sentence ends at the quote
  const sends = <>by sending “{resume.prompt}”</>;

  let kicker: string;
  let text: React.ReactNode;
  if (limit && resume.armed) {
    kicker = 'Usage limit reached';
    text = due ? <>The 5-hour limit has reset. Resuming…</> : <>Claude hit its 5-hour limit. CodePit resumes this session at {when} {sends}</>;
  } else if (limit && at !== undefined) {
    kicker = 'Usage limit reached';
    text =
      at <= now ? (
        <>Claude hit its 5-hour limit, which has reset since. Resume now?</>
      ) : (
        <>Claude hit its 5-hour limit, which resets at {shortTime(resume.resetsAt ?? at)}. Resume then?</>
      );
  } else if (limit) {
    kicker = 'Usage limit reached';
    text = <>Claude hit its usage limit.</>;
  } else {
    kicker = 'Paused';
    text = due ? <>Resuming…</> : <>Resumes at {when} {sends}</>;
  }

  const cancel = (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy !== null}
      loading={busy === 'cancel'}
      onClick={() => run('cancel', () => api.cancelScheduledResume(sessionId))}
      title="Nothing is sent; the session waits for your next message"
    >
      {resume.armed ? 'Cancel' : 'Dismiss'}
    </Button>
  );
  const pick = (
    <Button variant="secondary" size="sm" icon="clock" disabled={busy !== null} onClick={onPickTime}>
      {resume.armed ? 'Change time…' : 'Pick a time…'}
    </Button>
  );

  return (
    <section className="ws-approval ws-resume" role="region" aria-label={kicker}>
      <span className="ws-approval-icon" aria-hidden>
        <Icon name={limit ? 'gauge' : 'pause'} size={16} />
      </span>
      <div className="ws-approval-body">
        <div className="ws-approval-kicker">{kicker}</div>
        <div className="ws-restore-text">{text}</div>
        {resume.note && <div className="ws-resume-note">{resume.note}</div>}
        {limit && resume.limitMessage && <div className="ws-resume-note">Claude said: {resume.limitMessage}</div>}
        {error && <div className="ws-restore-error">{error}</div>}
      </div>
      <div className="ws-approval-actions">
        {/* "Ask" with a known reset: one click turns resuming on for every limit from now on */}
        {limit && !resume.armed && at !== undefined && !resume.note && (
          <Button
            variant="ghost"
            size="sm"
            className="ws-approval-auto"
            disabled={busy !== null}
            loading={busy === 'auto'}
            onClick={() => run('auto', () => api.setLimitResumeMode('auto'))}
            title="Resume every session by itself when the 5-hour limit resets. Change it under Accounts and usage."
          >
            Always resume automatically
          </Button>
        )}
        <span className="ws-approval-main">
          {cancel}
          {pick}
          {/* Armed, or offered and its time has already come (the user came back after the reset) */}
          {resume.armed || (at !== undefined && at <= now) ? (
            <Button
              variant="primary"
              size="sm"
              icon="play"
              disabled={busy !== null || due}
              loading={busy === 'now' || due}
              onClick={() => run('now', () => api.resumeNow(sessionId))}
              title={limit ? 'Send it now; if the limit has not reset yet, it hits it again' : 'Send it now'}
            >
              Resume now
            </Button>
          ) : (
            at !== undefined && (
              <Button
                variant="primary"
                size="sm"
                icon="play"
                disabled={busy !== null}
                loading={busy === 'arm'}
                // The time may pass while the card is open; the server refuses one in the past
                onClick={() => run('arm', () => api.scheduleResume(sessionId, Math.max(at, Date.now()), resume.prompt))}
              >
                Resume at {shortTime(at)}
              </Button>
            )
          )}
        </span>
      </div>
    </section>
  );
};

/** Pick when the session resumes and what it sends; pauses a running turn. */
export const ResumeAtModal: React.FC<{
  sessionId: string;
  /** A turn is running: picking a time stops it now. */
  working: boolean;
  current?: ScheduledResume | null;
  /** When Claude's 5-hour window resets, if known. */
  fiveHourResetsAt?: number;
  onClose: () => void;
}> = ({ sessionId, working, current, fiveHourResetsAt, onClose }) => {
  const presets = useMemo(() => {
    const now = Date.now();
    const list = [
      { id: '15m', label: '15 minutes', at: now + 15 * MIN },
      { id: '30m', label: '30 minutes', at: now + 30 * MIN },
      { id: '1h', label: '1 hour', at: now + HOUR },
      { id: '3h', label: '3 hours', at: now + 3 * HOUR },
    ];
    const reset = current?.resetsAt ?? fiveHourResetsAt;
    if (reset && reset > now) list.push({ id: 'reset', label: 'When the 5-hour limit resets', at: reset + MIN });
    list.push({ id: 'tomorrow', label: 'Tomorrow, 9 am', at: atHour(1, 9) });
    return list;
  }, [current?.resetsAt, fiveHourResetsAt]);
  const [prompt, setPrompt] = useState(current?.prompt || RESUME_PROMPT);
  const [custom, setCustom] = useState(() => toLocalInput(current?.at && current.at > Date.now() ? current.at : Date.now() + HOUR));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customTs = custom ? new Date(custom).getTime() : NaN;
  const customValid = Number.isFinite(customTs) && customTs > Date.now();

  const pick = async (at: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.scheduleResume(sessionId, at, prompt.trim() || RESUME_PROMPT);
      onClose();
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      nested
      size="sm"
      icon="pause"
      heading={working ? 'Pause and resume later' : current ? 'Change when it resumes' : 'Resume later'}
      description={
        working
          ? 'Stops the current turn now. At the time you pick, CodePit sends the message below and the agent carries on.'
          : 'At the time you pick, CodePit sends the message below to the agent, even if this window is closed.'
      }
    >
      <label className="resume-prompt-label" htmlFor="resume-prompt">
        Message to send
      </label>
      <Textarea id="resume-prompt" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="snooze-presets resume-presets">
        {presets.map((p) => (
          <button key={p.id} type="button" className="snooze-preset" disabled={busy} onClick={() => pick(p.at)}>
            <span>{p.label}</span>
            <span className="snooze-preset-when">{whenLabel(p.at)}</span>
          </button>
        ))}
      </div>
      <form
        className="snooze-custom"
        onSubmit={(e) => {
          e.preventDefault();
          if (customValid) pick(customTs);
        }}
      >
        <label htmlFor="resume-custom-at">At</label>
        <Input id="resume-custom-at" type="datetime-local" value={custom} min={toLocalInput(Date.now())} onChange={(e) => setCustom(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!customValid || busy}>
          {working ? 'Pause' : 'Schedule'}
        </Button>
      </form>
      {error && <div className="ws-restore-error">{error}</div>}
    </Modal>
  );
};

const MODE_OPTIONS: Array<{ value: LimitResumeMode; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'Do nothing; the session waits for your next message' },
  { value: 'ask', label: 'Ask', title: 'Offer to resume when the limit resets' },
  { value: 'auto', label: 'Resume automatically', title: 'Send “Continue” by itself once the limit resets' },
];

/** What every session does when Claude hits its 5-hour limit. */
export const LimitResumeSetting: React.FC = () => {
  const [mode, setMode] = useState<LimitResumeMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getLimitResumeMode().then((r) => setMode(r.mode)).catch((err) => setError(err?.message || String(err)));
  }, []);
  const change = async (next: LimitResumeMode) => {
    const prev = mode;
    setMode(next);
    setError(null);
    try {
      setMode((await api.setLimitResumeMode(next)).mode);
    } catch (err: any) {
      setMode(prev);
      setError(err?.message || String(err));
    }
  };
  return (
    <div className="limit-resume-setting">
      <span className="acct-mode-label">When the 5-hour limit is hit</span>
      {mode && <Segmented<LimitResumeMode> size="sm" label="When the 5-hour limit is hit" value={mode} onChange={change} options={MODE_OPTIONS} />}
      {error && <div className="acct-inline-error">{error}</div>}
    </div>
  );
};
