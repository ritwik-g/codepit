import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, FILE_MODE, getLogDir } from './paths.js';

/**
 * What sessions did to each other and what CodePit did to agents on its own: messages sent
 * between sessions (CodePit's send_to_session and Claude's SendMessage, refused ones
 * included), messages a session received, and agents stopped. One JSON object per line in
 * <app dir>/logs/events.jsonl, owner-only, rotated to events.1.jsonl past 5 MB. Message
 * text is kept as a short preview only.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW = 200;
const FILE = 'events.jsonl';
const ROTATED = 'events.1.jsonl';

export type SessionEventKind = 'message.sent' | 'message.refused' | 'message.received' | 'agent.stopped';

/** One end of a message: a CodePit session, or only the Claude name a sender gave. */
export interface EventParty {
  sessionId?: string;
  title?: string;
  /** The Claude session name, when the message was addressed by one. */
  name?: string;
}

export interface SessionEvent {
  at: string;
  kind: SessionEventKind;
  /** send_to_session (CodePit) or SendMessage (Claude). */
  via?: 'codepit' | 'claude';
  from?: EventParty;
  to?: EventParty;
  /** For a message: sent at once, queued behind a turn, or sent after starting a stopped agent. */
  delivery?: 'sent' | 'queued' | 'started';
  error?: string;
  preview?: string;
  /** For agent.stopped: 'idle' (with the hours) or 'user'. */
  reason?: 'idle' | 'user';
  idleHours?: number;
  /** Every CodePit session the event concerns, for reading one session's events. */
  sessions: string[];
}

export const preview = (text: string) => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
};

export function logEvent(event: Omit<SessionEvent, 'at' | 'sessions'>): void {
  const sessions = [...new Set([event.from?.sessionId, event.to?.sessionId].filter((s): s is string => Boolean(s)))];
  try {
    const dir = getLogDir();
    ensurePrivateDir(dir);
    const file = path.join(dir, FILE);
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, ROTATED));
    } catch {
      // no log yet
    }
    const line: SessionEvent = { at: new Date().toISOString(), ...event, sessions };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: FILE_MODE });
  } catch (err: any) {
    console.warn(`[events] Could not write the event log: ${err.message}`);
  }
}

/** The newest events first, optionally only those concerning one session. */
export function readEvents(opts: { limit?: number; sessionId?: string } = {}): SessionEvent[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const dir = getLogDir();
  const out: SessionEvent[] = [];
  for (const name of [FILE, ROTATED]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i].trim()) continue;
      let event: SessionEvent;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (opts.sessionId && !event.sessions?.includes(opts.sessionId)) continue;
      out.push(event);
    }
    if (out.length >= limit) break;
  }
  return out;
}

export const eventLogFile = () => path.join(getLogDir(), FILE);
