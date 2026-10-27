import { useCallback, useEffect, useState } from 'react';

/**
 * Where the message box sits, and whether it shrinks to one line while unused. Kept per device in
 * localStorage: the right height depends on the screen and how you sit at it, not on the session.
 */
export type ComposerPosition = 'bottom' | 'top';

export interface ComposerLayout {
  position: ComposerPosition;
  /** Hide the toolbar and keep one line until the box is focused or holds something. */
  compactWhenIdle: boolean;
}

const STORAGE_KEY = 'codepit_composer_layout';
const CHANGE_EVENT = 'codepit-composer-layout-change';
const DEFAULT_LAYOUT: ComposerLayout = { position: 'bottom', compactWhenIdle: false };

export function readComposerLayout(): ComposerLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      position: raw.position === 'top' ? 'top' : 'bottom',
      compactWhenIdle: raw.compactWhenIdle === true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function useComposerLayout(): [ComposerLayout, (patch: Partial<ComposerLayout>) => void] {
  const [layout, setLayout] = useState<ComposerLayout>(readComposerLayout);

  const update = useCallback((patch: Partial<ComposerLayout>) => {
    const next = { ...readComposerLayout(), ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the change still applies until reload
    }
    setLayout(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  // The settings dialog and the session view each hold the hook; keep them in step.
  useEffect(() => {
    const onChange = (e: Event) => setLayout((e as CustomEvent<ComposerLayout>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  return [layout, update];
}
