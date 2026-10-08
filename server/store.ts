import fs from 'node:fs';
import path from 'node:path';
import { getSessionsDir, FILE_MODE, ensurePrivateDir, initStorage } from './paths.js';
import type { AcpSession, UserAnnotations } from './types.js';
import { rankSession } from './rank.js';

function applyRank(session: AcpSession): void {
  const { score, reasons, factors, summary, state } = rankSession(session);
  session.score = score;
  session.reasons = reasons;
  session.rankFactors = factors;
  session.rankSummary = summary;
  session.state = state;
}

/**
 * A busy session is saved on every streamed update, and a long one runs to several MB of
 * JSON, all serialized on the main thread. Writing each save at once rewrote a 13 MB session
 * many times a second (an earlier version of this ran the server out of heap). So a session
 * goes to disk at most once per this interval: a save after a quiet spell is written at once,
 * and the saves that follow it inside the interval are folded into one write at its end.
 */
const WRITE_INTERVAL_MS = 1000;

class SessionStore {
  private sessions = new Map<string, AcpSession>();
  private initialized = false;
  /** Sessions with a write waiting, and the timer that will write them */
  private pendingWrites = new Map<string, NodeJS.Timeout>();
  /** When each session was last written to disk */
  private lastWritten = new Map<string, number>();
  private exitHooked = false;

  init(): void {
    if (this.initialized) return;
    initStorage();

    const sessionsDir = getSessionsDir();
    // Load persisted sessions from sessionsDir
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(sessionsDir, file);
          const raw = fs.readFileSync(filePath, 'utf8');
          const session = JSON.parse(raw) as AcpSession;
          if (session && session.id) {
            applyRank(session);
            this.sessions.set(session.id, session);
          }
        } catch (err) {
          console.warn(`[codepit] Failed to parse session ${file}:`, err);
        }
      }
    } catch {
      // Directory empty or not created yet
    }

    this.initialized = true;
  }

  clear(): void {
    this.flush();
    this.lastWritten.clear();
    this.sessions.clear();
    this.initialized = false;
  }

  getAll(): AcpSession[] {
    this.init();
    return Array.from(this.sessions.values());
  }

  get(id: string): AcpSession | null {
    this.init();
    return this.sessions.get(id) ?? null;
  }

  /**
   * Re-rank and persist a session. `touch: false` keeps updatedAt for bookkeeping writes
   * (background git refresh, snooze expiry) so they do not count as user/agent activity
   * in the recency ranking. `now: true` writes it to disk at once, for changes a crash must
   * not lose (the live mark, a turn starting or ending); other saves are throttled.
   */
  save(session: AcpSession, opts: { touch?: boolean; now?: boolean } = {}): void {
    this.init();
    // Touch first so "Active just now" reflects this write
    if (opts.touch !== false) {
      session.updatedAt = Date.now();
    }
    applyRank(session);

    this.sessions.set(session.id, session);
    if (opts.now) {
      clearTimeout(this.pendingWrites.get(session.id));
      this.pendingWrites.delete(session.id);
      this.persist(session);
    } else {
      this.schedulePersist(session.id);
    }
  }

  /** Write every session (or just `id`) that has a save waiting. Call before reading files or exiting. */
  flush(id?: string): void {
    for (const [sessionId, timer] of [...this.pendingWrites]) {
      if (id !== undefined && sessionId !== id) continue;
      clearTimeout(timer);
      this.pendingWrites.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) this.persist(session);
    }
  }

  private schedulePersist(id: string): void {
    if (this.pendingWrites.has(id)) return; // the waiting write picks up this change
    if (!this.exitHooked) {
      this.exitHooked = true;
      process.once('exit', () => this.flush());
    }
    const wait = (this.lastWritten.get(id) ?? 0) + WRITE_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      const session = this.sessions.get(id);
      if (session) this.persist(session);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingWrites.delete(id);
      const session = this.sessions.get(id);
      if (session) this.persist(session);
    }, wait);
    timer.unref();
    this.pendingWrites.set(id, timer);
  }

  delete(id: string): boolean {
    this.init();
    const removed = this.sessions.delete(id);
    clearTimeout(this.pendingWrites.get(id));
    this.pendingWrites.delete(id);
    this.lastWritten.delete(id);
    if (removed) {
      try {
        const filePath = path.join(getSessionsDir(), `${id}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // ignore delete failure
      }
    }
    return removed;
  }

  updateAnnotations(id: string, updates: Partial<UserAnnotations>): AcpSession | null {
    const session = this.get(id);
    if (!session) return null;

    session.user = {
      ...session.user,
      ...updates,
    };

    this.save(session);
    return session;
  }

  private persist(session: AcpSession): void {
    try {
      const sessionsDir = getSessionsDir();
      ensurePrivateDir(sessionsDir);
      const filePath = path.join(sessionsDir, `${session.id}.json`);
      // Written aside and renamed over the old file, so a crash mid-write never leaves half a session
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(session), {
        mode: FILE_MODE,
        encoding: 'utf8',
      });
      fs.renameSync(tmp, filePath);
      this.lastWritten.set(session.id, Date.now());
    } catch (err) {
      console.error(`[codepit] Failed to persist session ${session.id}:`, err);
    }
  }
}

export const store = new SessionStore();
