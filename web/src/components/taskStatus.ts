import { useEffect, useState } from 'react';
import type { AgentTaskStatus } from '../types';
import type { Tone } from '../ui';

/** How a subagent, workflow agent or background task stands, as a label and badge tone. */
export const STATUS: Record<AgentTaskStatus, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'accent' },
  completed: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

/** Ticks once a second while `active`, so running durations count up. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
