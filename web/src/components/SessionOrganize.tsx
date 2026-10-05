import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button, Icon, Input, StatusDot } from '../ui';
import type { SessionSummary } from '../types';
import { folderName, relativeTime, sessionStatus } from './Sidebar';

// Dialogs for organising a session: how long to snooze it, and its tags.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The next `hour`:00 on the given weekday offset from today (0 = today), local time. */
function atHour(daysAhead: number, hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function nextMonday9(): number {
  const day = new Date().getDay(); // 0 Sunday … 6 Saturday
  return atHour(((8 - day) % 7) || 7, 9);
}

export function snoozePresets(): Array<{ id: string; label: string; until: number }> {
  const now = Date.now();
  return [
    { id: '15m', label: '15 minutes', until: now + 15 * MIN },
    { id: '1h', label: '1 hour', until: now + HOUR },
    { id: '3h', label: '3 hours', until: now + 3 * HOUR },
    { id: 'tomorrow', label: 'Tomorrow, 9 am', until: atHour(1, 9) },
    { id: 'monday', label: 'Next Monday, 9 am', until: nextMonday9() },
  ];
}

const whenLabel = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });

/** "2026-10-05T18:30" in local time, for a datetime-local input. */
function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * MIN);
  return d.toISOString().slice(0, 16);
}

export const SnoozeModal: React.FC<{
  snoozedUntil: number | null;
  onSnooze: (until: number | null) => void;
  onClose: () => void;
}> = ({ snoozedUntil, onSnooze, onClose }) => {
  const presets = useMemo(snoozePresets, []);
  const [custom, setCustom] = useState(() => toLocalInput(Date.now() + 2 * HOUR));
  const customTs = custom ? new Date(custom).getTime() : NaN;
  const customValid = Number.isFinite(customTs) && customTs > Date.now();
  const snoozed = Boolean(snoozedUntil && snoozedUntil > Date.now());
  const pick = (until: number | null) => {
    onSnooze(until);
    onClose();
  };

  return (
    <Modal
      onClose={onClose}
      nested
      size="sm"
      icon="moon"
      heading="Snooze session"
      description={
        snoozed ? `Snoozed until ${whenLabel(snoozedUntil!)}. It wakes up by itself then.` : 'It moves to the bottom of the list and wakes up by itself.'
      }
      footer={
        snoozed ? (
          <Button variant="secondary" onClick={() => pick(null)}>
            Wake now
          </Button>
        ) : undefined
      }
    >
      <div className="snooze-presets">
        {presets.map((p) => (
          <button key={p.id} type="button" className="snooze-preset" onClick={() => pick(p.until)}>
            <span>{p.label}</span>
            <span className="snooze-preset-when">{whenLabel(p.until)}</span>
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
        <label htmlFor="snooze-custom-at">Until</label>
        <Input id="snooze-custom-at" type="datetime-local" value={custom} min={toLocalInput(Date.now())} onChange={(e) => setCustom(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!customValid}>
          Snooze
        </Button>
      </form>
    </Modal>
  );
};

/** Tags as the server keeps them: lower case, no #, spaces become dashes. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\s]+/)) {
    const tag = raw.replace(/^#+/, '').toLowerCase().replace(/[^\p{L}\p{N}_./-]/gu, '').slice(0, 32);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** A tag as a chip; with `onRemove` it gets a remove button. */
export const TagChip: React.FC<{ tag: string; onRemove?: () => void; onClick?: () => void; active?: boolean }> = ({ tag, onRemove, onClick, active }) => (
  <span className={`tag-chip ${active ? 'is-active' : ''}`}>
    {onClick ? (
      <button type="button" className="tag-chip-label" onClick={onClick}>
        #{tag}
      </button>
    ) : (
      <span className="tag-chip-label">#{tag}</span>
    )}
    {onRemove && (
      <button type="button" className="tag-chip-remove" onClick={onRemove} aria-label={`Remove #${tag}`} title={`Remove #${tag}`}>
        <Icon name="x" size={11} />
      </button>
    )}
  </span>
);

const MAX_TAGS = 12;

/** The session's Tags tab: its tags as chips, adding with suggestions, and other sessions that share them. */
export const TagsPanel: React.FC<{
  sessionId: string;
  tags: string[];
  /** Every session, for suggestions and for the sessions that share a tag. */
  sessions: SessionSummary[];
  onSave: (tags: string[]) => void;
  onSelectSession?: (id: string) => void;
}> = ({ sessionId, tags, sessions, onSave, onSelectSession }) => {
  const [text, setText] = useState('');
  const known = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) for (const t of s.user.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [sessions]);
  const typed = parseTags(text)[0] || '';
  const suggestions = known
    .filter(([t]) => !tags.includes(t) && (!typed || t.includes(typed)))
    .slice(0, 12);
  const full = tags.length >= MAX_TAGS;

  const add = (raw: string) => {
    const next = [...tags];
    for (const t of parseTags(raw)) if (!next.includes(t)) next.push(t);
    if (next.length !== tags.length) onSave(next.slice(0, MAX_TAGS));
    setText('');
  };

  return (
    <div className="tags-tab">
      <div className="tags-col">
        <section className="tags-section">
          <div className="tags-eyebrow">Tags on this session</div>
          {tags.length > 0 ? (
            <div className="tags-chips">
              {tags.map((t) => (
                <TagChip key={t} tag={t} onRemove={() => onSave(tags.filter((x) => x !== t))} />
              ))}
            </div>
          ) : (
            <p className="tags-empty">No tags yet. Tags group related sessions; type #tag in search to find them.</p>
          )}
          <form
            className="tags-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) add(text);
            }}
          >
            <Input
              value={text}
              placeholder={full ? `At most ${MAX_TAGS} tags` : 'Add a tag, e.g. #billing'}
              aria-label="Add a tag"
              disabled={full}
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={full || !typed}>
              Add
            </Button>
          </form>
          {!full && suggestions.length > 0 && (
            <div className="tags-suggest" aria-label="Tags used on other sessions">
              {suggestions.map(([t, n]) => (
                <button key={t} type="button" className="tags-suggest-item" onClick={() => add(t)} title={`Used on ${n} session${n === 1 ? '' : 's'}`}>
                  + #{t}
                </button>
              ))}
            </div>
          )}
        </section>

        {tags.map((t) => {
          const others = sessions.filter((s) => s.id !== sessionId && (s.user.tags || []).includes(t));
          if (others.length === 0) return null;
          return (
            <section key={t} className="tags-section">
              <div className="tags-eyebrow">Also tagged #{t}</div>
              <div className="tags-related">
                {others.map((s) => {
                  const status = sessionStatus(s);
                  return (
                    <button key={s.id} type="button" className="tags-related-row" onClick={() => onSelectSession?.(s.id)}>
                      <StatusDot tone={status.tone} label={status.label} />
                      <span className="tags-related-title">{s.title}</span>
                      <span className="tags-related-meta">
                        {folderName(s.cwd)} · {relativeTime(s.updatedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
