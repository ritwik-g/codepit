import fs from 'node:fs';
import { ensurePrivateDir, getAppDir, getSettingsFile, FILE_MODE } from './paths.js';
import type { LimitResumeMode, ScheduledResume } from './types.js';

// Resuming a session later: after Claude stops a turn on its 5-hour usage limit, or at a
// time the user picked when pausing it. What is sent is an ordinary message, so the agent
// session carries on with everything it had.

/** Sent when a session resumes, unless the user wrote something else. */
export const RESUME_PROMPT = 'Continue from where you left off.';
export const DEFAULT_LIMIT_RESUME: LimitResumeMode = 'ask';
/** Wait this long past the reset: the window can take a moment to open on Anthropic's side. */
export const RESUME_BUFFER_MS = 60_000;
/** Limit resumes in a row that hit the limit again straight away before it stops resuming by itself. */
export const MAX_LIMIT_STREAK = 3;
/** A 5-hour window resets at most this far away; a limit resetting later is a longer one. */
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60_000 + 15 * 60_000;
/** The longest a manual pause may run. */
const MAX_PAUSE_MS = 30 * 24 * 60 * 60_000;
const MAX_PROMPT_CHARS = 20_000;

export type LimitWindow = 'five_hour' | 'weekly' | 'credits' | 'unknown';

export interface UsageLimitHit {
  window: LimitWindow;
  /** Claude's own words, without the "Internal error: " the protocol puts in front. */
  message: string;
  resetsAt?: number;
}

/** A rate-limit event from Claude saying the account is out of a window. */
export interface RejectedLimit {
  type?: string;
  resetsAt?: number;
  /** When it arrived. */
  seenAt: number;
}

// Claude Code's usage-limit messages (the SDK's USAGE_LIMIT_ERROR_PREFIXES, plus the
// older "Claude AI usage limit reached|<epoch seconds>")
const LIMIT_RE = /(You['’]ve hit your|You['’]ve reached your|You['’]re out of (?:usage credits|extra usage)|Your org is out of usage|Your seat type doesn['’]t include|Your usage allocation has been disabled|Your group['’]s usage limit|requires usage credits|usage limit reached)/i;

/** Claude's usage-limit message in an error's text, or null when the error is something else. */
export function parseUsageLimit(text: string | undefined | null, now = Date.now()): UsageLimitHit | null {
  if (!text) return null;
  const found = LIMIT_RE.exec(text);
  if (!found) return null;
  const message = text.slice(found.index).trim();
  let window: LimitWindow = 'unknown';
  if (/credits|extra usage|org is out|seat type|allocation|usage limit is set/i.test(message)) window = 'credits';
  else if (/\bweek(ly)?\b|\b(opus|sonnet|fable|haiku)\b[^·|]*limit/i.test(message)) window = 'weekly';
  else if (/session limit|5[- ]hour|five[- ]hour/i.test(message)) window = 'five_hour';
  const epoch = /\|\s*(\d{10,13})\b/.exec(message);
  const resetsAt = epoch
    ? Number(epoch[1]) * (epoch[1].length === 10 ? 1000 : 1)
    : parseResetTime(/resets?\s+(?:at\s+)?([^\n]+)/i.exec(message)?.[1] || '', now);
  return { window, message, ...(resetsAt ? { resetsAt } : {}) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_RE = /(?:\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** The wall-clock date and time at `ms` in a time zone. */
function wallClock(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, Number(p.value)])
  );
  return { y: parts.year, mo: parts.month - 1, d: parts.day, h: parts.hour % 24, mi: parts.minute };
}

/** The epoch time of a wall-clock time in a time zone (month 0-based; days past the month's end roll over). */
function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const asUtc = Date.UTC(y, mo, d, h, mi);
  const offsetAt = (ms: number) => {
    const w = wallClock(ms, timeZone);
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = asUtc - offsetAt(asUtc);
  // Again from the first guess, in case a DST change lies between the two
  return asUtc - offsetAt(first);
}

/**
 * A reset time the way Claude writes it, as an epoch time: "3:40pm (Asia/Calcutta)",
 * "3pm", "Oct 9, 10am (Europe/Paris)" or "Oct 4 at 3:30pm (Asia/Calcutta)". A time with no
 * date is the next one to come. Undefined when the text holds no time.
 */
export function parseResetTime(text: string, now = Date.now(), defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | undefined {
  const m = RESET_RE.exec(text);
  if (!m) return undefined;
  const [, mon, day, hour, minute, ampm, zone] = m;
  const h12 = Number(hour);
  if (h12 < 1 || h12 > 12) return undefined;
  const h = (h12 % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  const mi = minute ? Number(minute) : 0;
  if (mi > 59) return undefined;
  const tz = validZone(zone?.trim()) || defaultZone;
  const today = wallClock(now, tz);
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase());
    let at = fromWallClock(today.y, mo, Number(day), h, mi, tz);
    // "Jan 2" seen in late December is next year's
    if (at < now - 180 * 24 * 60 * 60_000) at = fromWallClock(today.y + 1, mo, Number(day), h, mi, tz);
    return at;
  }
  let at = fromWallClock(today.y, today.mo, today.d, h, mi, tz);
  if (at <= now - 60_000) at = fromWallClock(today.y, today.mo, today.d + 1, h, mi, tz);
  return at;
}

export interface LimitResumeInput {
  hit: UsageLimitHit;
  mode: LimitResumeMode;
  now: number;
  /** Claude's latest rate-limit event saying a window is exhausted, if one came in this turn. */
  rejected?: RejectedLimit;
  /** The 5-hour window's reset as last read from Claude's /usage. */
  fiveHourResetsAt?: number;
  /** Limit resumes in a row that hit the limit again straight away. */
  streak: number;
}

/**
 * What to do about a turn Claude stopped on a usage limit: a resume to schedule (armed under
 * "Auto", waiting for a yes under "Ask"), or null when the setting is off or the limit is
 * not the 5-hour one.
 */
export function decideLimitResume({ hit, mode, now, rejected, fiveHourResetsAt, streak }: LimitResumeInput): ScheduledResume | null {
  if (mode === 'off') return null;
  const recentRejection = rejected && now - rejected.seenAt < 10 * 60_000 ? rejected : undefined;
  let window = hit.window;
  if (window === 'unknown' && recentRejection?.type) {
    if (recentRejection.type === 'five_hour') window = 'five_hour';
    else if (recentRejection.type.startsWith('seven_day')) window = 'weekly';
  }
  if (window === 'weekly' || window === 'credits') return null;
  const fromEvent = recentRejection?.type === 'five_hour' ? recentRejection.resetsAt : undefined;
  const candidates = [fromEvent, hit.resetsAt, fiveHourResetsAt].filter((t): t is number => typeof t === 'number' && t > now);
  const resetsAt = candidates[0];
  // A limit that does not say which: the 5-hour one when it resets within a 5-hour window
  if (window === 'unknown' && !(resetsAt && resetsAt - now <= FIVE_HOUR_WINDOW_MS)) return null;
  const at = resetsAt ? resetsAt + RESUME_BUFFER_MS : undefined;
  const tooMany = streak >= MAX_LIMIT_STREAK;
  return {
    reason: 'limit',
    ...(at ? { at, resetsAt } : {}),
    armed: mode === 'auto' && Boolean(at) && !tooMany,
    prompt: RESUME_PROMPT,
    createdAt: now,
    limitMessage: hit.message,
    ...(tooMany
      ? { note: `It resumed ${streak} times and hit the limit again straight away each time, so it waits for you now.` }
      : !at
        ? { note: 'Claude did not say when the limit resets. Pick a time to resume.' }
        : {}),
  };
}

/** A pause or resume time from the API, or why it is not a valid one. */
export function parseScheduleRequest(body: unknown, now = Date.now()): { at: number; prompt: string } | { error: string } {
  const b = (body ?? {}) as { at?: unknown; prompt?: unknown };
  if (typeof b.at !== 'number' || !Number.isFinite(b.at)) return { error: 'at must be a time in milliseconds' };
  if (b.at < now - 60_000) return { error: 'That time has already passed' };
  if (b.at > now + MAX_PAUSE_MS) return { error: 'Pick a time within the next 30 days' };
  if (b.prompt !== undefined && typeof b.prompt !== 'string') return { error: 'prompt must be text' };
  const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim() : RESUME_PROMPT;
  if (prompt.length > MAX_PROMPT_CHARS) return { error: `The message is over ${MAX_PROMPT_CHARS} characters` };
  return { at: Math.round(b.at), prompt };
}

export function isLimitResumeMode(v: unknown): v is LimitResumeMode {
  return v === 'off' || v === 'ask' || v === 'auto';
}

/** What to do when Claude hits its 5-hour limit, for every session; kept in settings.json. */
export function readLimitResumeMode(): LimitResumeMode {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    return isLimitResumeMode(parsed?.limitResume) ? parsed.limitResume : DEFAULT_LIMIT_RESUME;
  } catch {
    return DEFAULT_LIMIT_RESUME;
  }
}

export function writeLimitResumeMode(mode: LimitResumeMode): void {
  ensurePrivateDir(getAppDir());
  const file = getSettingsFile();
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed;
  } catch {
    // no settings yet
  }
  fs.writeFileSync(file, JSON.stringify({ ...current, limitResume: mode }, null, 2), { mode: FILE_MODE });
}
