import { DailyLog } from './daily-log.js';

/**
 * What happened to sessions and their agents, and what sessions did to each other: messages
 * between sessions (CodePit's send_to_session and Claude's SendMessage, failed ones
 * included), every agent start, stop, failed start and exit, sessions created and deleted,
 * and settings changed. Kept as daily files (logs/events-YYYY-MM-DD.jsonl), gzipped after a
 * week and deleted after 60 days. Message text is kept as a short preview only.
 */

const PREVIEW = 200;

export type SessionEventKind =
  | 'message.sent'
  | 'message.refused'
  | 'message.received'
  | 'agent.started'
  | 'agent.stopped'
  | 'agent.failed'
  | 'agent.exited'
  | 'session.created'
  | 'session.deleted'
  | 'setting.changed';

export type EventCategory = 'messages' | 'agents' | 'sessions';
export const EVENT_CATEGORIES: EventCategory[] = ['messages', 'agents', 'sessions'];

export const categoryOf = (kind: string): EventCategory =>
  kind.startsWith('message.') ? 'messages' : kind.startsWith('agent.') ? 'agents' : 'sessions';

/** A session the event concerns: a CodePit session, or only the Claude name a sender gave. */
export interface EventParty {
  sessionId?: string;
  title?: string;
  /** The Claude session name, when known (for messages, the address used). */
  name?: string;
}

export interface SessionEvent {
  at: string;
  kind: SessionEventKind;
  /** The session an agent.* or session.* event is about. */
  session?: EventParty;
  /** For messages: send_to_session (CodePit) or SendMessage (Claude). */
  via?: 'codepit' | 'claude';
  from?: EventParty;
  to?: EventParty;
  /** For a message: sent at once, queued behind a turn, or sent after starting a stopped agent. */
  delivery?: 'sent' | 'queued' | 'started';
  /** Why an agent started or stopped, or who created a session, in words. */
  reason?: string;
  /** For an idle stop: the setting's hours at the time. */
  idleHours?: number;
  agentId?: string;
  /** For agent.started: it continued the earlier agent session rather than starting a new one. */
  resumed?: boolean;
  setting?: { name: string; from: unknown; to: unknown };
  error?: string;
  preview?: string;
  /** Every CodePit session the event concerns, for reading one session's events. */
  sessions: string[];
}

export const preview = (text: string) => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
};

const log = new DailyLog<SessionEvent>('events', ['events.1.jsonl', 'events.jsonl']);

export function logEvent(event: Omit<SessionEvent, 'at' | 'sessions'>): void {
  const sessions = [...new Set([event.session?.sessionId, event.from?.sessionId, event.to?.sessionId].filter((s): s is string => Boolean(s)))];
  log.append({ at: new Date().toISOString(), ...event, sessions });
}

/** A setting changed from the app; nothing is logged when it did not change. */
export function logSettingChange(name: string, from: unknown, to: unknown): void {
  if (JSON.stringify(from) === JSON.stringify(to)) return;
  logEvent({ kind: 'setting.changed', setting: { name, from, to } });
}

/** The newest events first, filtered by session, category and age. */
export function readEvents(opts: { limit?: number; sessionId?: string; categories?: EventCategory[]; sinceDays?: number } = {}): SessionEvent[] {
  const since = opts.sinceDays !== undefined ? Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000 : undefined;
  return log.read({
    limit: opts.limit,
    since,
    filter: (e) =>
      (!opts.sessionId || Boolean(e.sessions?.includes(opts.sessionId))) && (!opts.categories?.length || opts.categories.includes(categoryOf(e.kind))),
  });
}

export const eventLogLocation = () => log.location;
export const tidyEventLog = (now?: number) => log.tidy(now);
