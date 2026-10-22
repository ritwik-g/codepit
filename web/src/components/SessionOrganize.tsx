import React, { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button, Icon, Input, StatusDot } from '../ui';
import type { SessionLinkKind, SessionSummary } from '../types';
import { familyRoot, familyTree, folderName, relativeTime, sessionStatus } from './Sidebar';

// Dialogs for organising a session: how long to snooze it, its tags, and the sessions related to it.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The next `hour`:00 on the given weekday offset from today (0 = today), local time. */
export function atHour(daysAhead: number, hour: number): number {
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

export const whenLabel = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });

/** "2026-10-05T18:30" in local time, for a datetime-local input. */
export function toLocalInput(ts: number): string {
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

        <FamilySection sessionId={sessionId} sessions={sessions} onSelectSession={onSelectSession} />
        <LinksSection sessionId={sessionId} sessions={sessions} onSelectSession={onSelectSession} />

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

const RelatedRow: React.FC<{
  session: SessionSummary;
  current?: boolean;
  depth?: number;
  note?: string;
  onSelect?: () => void;
}> = ({ session, current, depth, note, onSelect }) => {
  const status = sessionStatus(session);
  return (
    <button
      type="button"
      className={`tags-related-row ${current ? 'is-current' : ''}`}
      onClick={onSelect}
      disabled={current}
      aria-current={current ? 'true' : undefined}
      style={depth ? { paddingLeft: `calc(var(--space-3) + ${Math.min(depth, 6) * 16}px)` } : undefined}
    >
      <StatusDot tone={status.tone} pulse={status.pulse} label={status.label} />
      <span className="tags-related-title">
        {session.title}
        {current && <span className="tags-related-you"> · this session</span>}
      </span>
      <span className="tags-related-meta">
        {note ? `${note} · ` : ''}
        {session.agentName} · {folderName(session.cwd)} · {relativeTime(session.updatedAt)}
      </span>
    </button>
  );
};

/** The sessions started from the same root as this one, as a tree. */
const FamilySection: React.FC<{ sessionId: string; sessions: SessionSummary[]; onSelectSession?: (id: string) => void }> = ({
  sessionId,
  sessions,
  onSelectSession,
}) => {
  const { order, depth } = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const root = familyRoot(sessionId, byId);
    const members = sessions.filter((s) => familyRoot(s.id, byId) === root);
    return familyTree(root, members);
  }, [sessionId, sessions]);
  const self = sessions.find((s) => s.id === sessionId);
  if (order.length <= 1) {
    // A parent that was deleted still leaves a trace
    if (!self?.spawnedBy) return null;
    return (
      <section className="tags-section">
        <div className="tags-eyebrow">Started by</div>
        <p className="tags-empty">A session that has since been deleted.</p>
      </section>
    );
  }
  return (
    <section className="tags-section">
      <div className="tags-eyebrow">Started together</div>
      <div className="tags-related">
        {order.map((s) => (
          <RelatedRow
            key={s.id}
            session={s}
            current={s.id === sessionId}
            depth={depth.get(s.id)}
            note={s.pendingStart ? 'waiting to start' : undefined}
            onSelect={() => onSelectSession?.(s.id)}
          />
        ))}
      </div>
    </section>
  );
};

const LINK_LABEL: Record<SessionLinkKind, { out: string; in: string }> = {
  related: { out: 'related', in: 'related' },
  'follow-up': { out: 'follows up on', in: 'followed up by' },
  'blocked-by': { out: 'blocked by', in: 'blocks' },
};

/** Links agents recorded between this session and others, both ways. */
const LinksSection: React.FC<{ sessionId: string; sessions: SessionSummary[]; onSelectSession?: (id: string) => void }> = ({
  sessionId,
  sessions,
  onSelectSession,
}) => {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const self = byId.get(sessionId);
  const rows: Array<{ session: SessionSummary; note: string }> = [];
  for (const l of self?.links ?? []) {
    const other = byId.get(l.sessionId);
    if (other) rows.push({ session: other, note: LINK_LABEL[l.kind].out });
  }
  for (const s of sessions) {
    if (s.id === sessionId) continue;
    for (const l of s.links ?? []) if (l.sessionId === sessionId) rows.push({ session: s, note: LINK_LABEL[l.kind].in });
  }
  if (rows.length === 0) return null;
  return (
    <section className="tags-section">
      <div className="tags-eyebrow">Linked</div>
      <div className="tags-related">
        {rows.map((r, i) => (
          <RelatedRow key={`${r.session.id}-${i}`} session={r.session} note={r.note} onSelect={() => onSelectSession?.(r.session.id)} />
        ))}
      </div>
    </section>
  );
};

/** Other sessions related to this one: started together, linked, or sharing a tag. */
export function relatedSessionCount(sessionId: string, sessions: SessionSummary[]): number {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const self = byId.get(sessionId);
  if (!self) return 0;
  const root = familyRoot(sessionId, byId);
  const tags = new Set(self.user.tags ?? []);
  const linked = new Set((self.links ?? []).map((l) => l.sessionId));
  return sessions.filter(
    (s) =>
      s.id !== sessionId &&
      (familyRoot(s.id, byId) === root ||
        linked.has(s.id) ||
        (s.links ?? []).some((l) => l.sessionId === sessionId) ||
        (s.user.tags ?? []).some((t) => tags.has(t)))
  ).length;
}
