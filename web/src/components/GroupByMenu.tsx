import React, { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../ui';
import { useEscapeLayer } from '../hooks';
import { GROUP_BY_MODES, type GroupBy } from '../sidebarGroups';

const OPTIONS: Record<GroupBy, { label: string; icon: IconName; description: string }> = {
  status: { label: 'Status', icon: 'circleDot', description: 'What each session needs from you' },
  repo: { label: 'Repo', icon: 'folder', description: 'The repository it works in; worktrees join their repo' },
  agent: { label: 'Agent', icon: 'bot', description: 'Claude, Codex, Antigravity and so on' },
  tag: { label: 'Tag', icon: 'hash', description: 'A session with several tags shows under each' },
  family: { label: 'Family', icon: 'branch', description: 'Sessions with the sessions they started' },
};

/** The sidebar's "Group by" picker: a labelled trigger and a list of the grouping modes. */
export const GroupByMenu: React.FC<{ value: GroupBy; onChange: (mode: GroupBy) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEscapeLayer(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') || []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (idx + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (idx - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (next === -1) return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  const current = OPTIONS[value];
  return (
    <div className="group-by-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`group-by-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Group sessions by: ${current.label}`}
        data-testid="group-by-menu"
        onClick={() => setOpen(!open)}
      >
        <span className="group-by-trigger-key">Group by</span>
        <Icon name={current.icon} size={13} />
        <span className="group-by-trigger-value">{current.label}</span>
        <Icon name="chevronDown" size={12} className="group-by-trigger-chevron" />
      </button>
      {open && (
        <div className="group-by-pop" role="menu" aria-label="Group sessions by" ref={listRef} onKeyDown={onListKeyDown}>
          {GROUP_BY_MODES.map((mode) => {
            const o = OPTIONS[mode];
            const checked = mode === value;
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className="group-by-item"
                data-mode={mode}
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <Icon name={o.icon} size={14} className="group-by-item-icon" />
                <span className="group-by-item-text">
                  <span className="group-by-item-label">{o.label}</span>
                  <span className="group-by-item-desc">{o.description}</span>
                </span>
                {checked && <Icon name="check" size={13} className="group-by-item-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
