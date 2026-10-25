import fs from 'node:fs';
import { ensurePrivateDir, getAppDir, getSettingsFile, FILE_MODE } from './paths.js';

/**
 * Stopping agents left idle: each running agent (claude and the MCP servers it starts) holds
 * hundreds of MB, so one nobody has used in this many hours is stopped. The next message
 * starts it again and continues the same agent session. 0 is off.
 */
export const IDLE_STOP_CHOICES = [0, 12, 24, 48, 72] as const;
export const DEFAULT_IDLE_STOP_HOURS = 48;
/** Agents stopped per poll, so a backlog after the setting is lowered is not one burst of kills. */
export const IDLE_STOPS_PER_TICK = 3;

export function isIdleStopHours(v: unknown): v is number {
  return typeof v === 'number' && (IDLE_STOP_CHOICES as readonly number[]).includes(v);
}

/** The idle hours after which a running agent is stopped, for every session; kept in settings.json. */
export function readIdleStopHours(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    return isIdleStopHours(parsed?.idleStopHours) ? parsed.idleStopHours : DEFAULT_IDLE_STOP_HOURS;
  } catch {
    return DEFAULT_IDLE_STOP_HOURS;
  }
}

export function writeIdleStopHours(hours: number): void {
  ensurePrivateDir(getAppDir());
  const file = getSettingsFile();
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed;
  } catch {
    // no settings yet
  }
  fs.writeFileSync(file, JSON.stringify({ ...current, idleStopHours: hours }, null, 2), { mode: FILE_MODE });
}

export function idleLabel(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`;
}
