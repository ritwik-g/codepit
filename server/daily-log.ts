import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensurePrivateDir, FILE_MODE, getLogDir } from './paths.js';

/**
 * A JSON-lines log kept as one file per UTC day under <app dir>/logs: <name>-YYYY-MM-DD.jsonl.
 * Days older than a week are gzipped, days older than 60 are deleted, so the log neither grows
 * without bound nor loses last week to a busy day. The tidy-up runs on the first write or read
 * of each day. Files are owner-only. Each entry is an object with an ISO `at`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const COMPRESS_AFTER_DAYS = 7;
export const DELETE_AFTER_DAYS = 60;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface ReadOptions<T> {
  /** Only entries at or after this time (ms). */
  since?: number;
  limit?: number;
  filter?: (entry: T) => boolean;
}

export class DailyLog<T extends { at: string }> {
  private tidiedDay = '';

  /** `legacy`: files of the old single-file log, oldest first, moved into the daily files on the first tidy-up. */
  constructor(private readonly name: string, private readonly legacy: string[] = []) {}

  /** Where the log lives, for the UI: the folder and the file pattern. */
  get location(): string {
    return path.join(getLogDir(), `${this.name}-YYYY-MM-DD.jsonl`);
  }

  append(entry: T): void {
    try {
      const dir = getLogDir();
      ensurePrivateDir(dir);
      this.tidy();
      fs.appendFileSync(path.join(dir, `${this.name}-${dayOf(Date.parse(entry.at))}.jsonl`), JSON.stringify(entry) + '\n', { mode: FILE_MODE });
    } catch (err: any) {
      console.warn(`[${this.name}] Could not write the log: ${err.message}`);
    }
  }

  /** Newest first. */
  read(opts: ReadOptions<T> = {}): T[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
    const sinceDay = opts.since !== undefined ? dayOf(opts.since) : '';
    this.tidy();
    const out: T[] = [];
    for (const { file, day } of this.files()) {
      if (day < sinceDay) break;
      const lines = this.readFile(file).split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i].trim()) continue;
        let entry: T;
        try {
          entry = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (opts.since !== undefined && Date.parse(entry.at) < opts.since) continue;
        if (opts.filter && !opts.filter(entry)) continue;
        out.push(entry);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Gzip days past a week, delete days past 60, and fold in the old single-file log. Once a day unless `now` is given. */
  tidy(at?: number): void {
    const now = at ?? Date.now();
    const today = dayOf(now);
    if (at === undefined && this.tidiedDay === today) return;
    this.tidiedDay = today;
    const dir = getLogDir();
    try {
      this.migrateLegacy(dir);
      const compressBefore = dayOf(now - COMPRESS_AFTER_DAYS * DAY_MS);
      const deleteBefore = dayOf(now - DELETE_AFTER_DAYS * DAY_MS);
      for (const { file, day, gz } of this.files()) {
        if (day < deleteBefore) {
          fs.rmSync(file, { force: true });
        } else if (day < compressBefore && !gz) {
          const tmp = `${file}.gz.tmp`;
          fs.writeFileSync(tmp, zlib.gzipSync(fs.readFileSync(file)), { mode: FILE_MODE });
          fs.renameSync(tmp, `${file}.gz`);
          fs.rmSync(file);
        }
      }
    } catch (err: any) {
      console.warn(`[${this.name}] Could not tidy the log: ${err.message}`);
    }
  }

  /** This log's day files, newest first; a day gzipped and not yet removed counts once. */
  private files(): Array<{ file: string; day: string; gz: boolean }> {
    const dir = getLogDir();
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const re = new RegExp(`^${this.name}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl(\\.gz)?$`);
    const byDay = new Map<string, { file: string; day: string; gz: boolean }>();
    for (const n of names) {
      const m = n.match(re);
      if (!m) continue;
      const gz = Boolean(m[2]);
      // Mid-compression both exist: the plain file is the complete one
      if (byDay.has(m[1]) && gz) continue;
      byDay.set(m[1], { file: path.join(dir, n), day: m[1], gz });
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  private readFile(file: string): string {
    try {
      const buf = fs.readFileSync(file);
      return file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    } catch {
      return '';
    }
  }

  private migrateLegacy(dir: string): void {
    // Listed oldest first (the rotated file, then the current one), so each day's lines stay in order
    for (const old of this.legacy) {
      const file = path.join(dir, old);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const byDay = new Map<string, string[]>();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const at = Date.parse(JSON.parse(line).at);
          if (Number.isNaN(at)) continue;
          const day = dayOf(at);
          byDay.set(day, [...(byDay.get(day) ?? []), line]);
        } catch {
          // a torn line
        }
      }
      for (const [day, lines] of byDay) {
        fs.appendFileSync(path.join(dir, `${this.name}-${day}.jsonl`), lines.join('\n') + '\n', { mode: FILE_MODE });
      }
      fs.rmSync(file);
    }
  }
}
