import React, { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../types';
import { VendorIcon } from './VendorLogos';
import { Badge, Button, Icon, IconButton, Input, Kbd, Spinner, StatusDot, type Tone } from '../ui';
import { ThemeMenu } from './ThemeMenu';
import { BrandMark } from './BrandMark';
import { formatTokens, sessionPricing } from '../pricing';
import { api } from '../api';
import { RestoreAllBar, isRestorable } from './RestorePrompt';

// ------------------------------------------------------------------ helpers
// Shared by the sidebar, the command palette and the home dashboard.

/** Modifier key label for shortcuts: the Command glyph on Apple devices, Ctrl elsewhere. */
export const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

export interface SessionStatus {
  label: string;
  tone: Tone;
  pulse: boolean;
}

/** Label and tone for a session's state, per the table in DESIGN.md. */
export function sessionStatus(
  s: Pick<SessionSummary, 'state' | 'isAgentRunning' | 'compacting' | 'workingInBackground'> &
    Partial<Pick<SessionSummary, 'hasPendingPermission' | 'hasPendingElicitation' | 'restore'>>
): SessionStatus {
  if (s.compacting && s.state !== 'blocked') return { label: 'Compacting', tone: 'accent', pulse: true };
  // Its agent was running when CodePit closed: offered back with Restore
  if (s.restore && s.isAgentRunning === false && s.state !== 'blocked') return { label: 'Was running', tone: 'warn', pulse: false };
  if (s.isAgentRunning === false && s.state !== 'crashed' && s.state !== 'blocked') {
    return { label: 'Agent stopped', tone: 'neutral', pulse: false };
  }
  if (s.workingInBackground && s.state === 'needs_you') return { label: 'Working in background', tone: 'accent', pulse: true };
  switch (s.state) {
    case 'blocked':
      // Blocked on a question rather than an approval
      if (s.hasPendingElicitation && !s.hasPendingPermission) return { label: 'Needs your answer', tone: 'danger', pulse: false };
      return { label: 'Needs approval', tone: 'danger', pulse: false };
    case 'needs_you':
      return { label: 'Your turn', tone: 'warn', pulse: false };
    case 'working':
      return { label: 'Working', tone: 'accent', pulse: true };
    case 'snoozed':
      return { label: 'Snoozed', tone: 'info', pulse: false };
    case 'crashed':
      return { label: 'Crashed', tone: 'danger', pulse: false };
    case 'parked':
      return { label: 'Parked', tone: 'neutral', pulse: false };
    default:
      return { label: 'Idle', tone: 'neutral', pulse: false };
  }
}

export const needsAttention = (s: SessionSummary) =>
  s.state === 'blocked' || (s.state === 'needs_you' && !s.workingInBackground) || s.state === 'crashed';

/** A finished turn the user has not looked at since, while nothing else runs. */
export function isUnseen(s: SessionSummary): boolean {
  if (s.state === 'snoozed' || isWorking(s)) return false;
  return Boolean(s.lastTurnEndedAt && s.lastTurnEndedAt > (s.seenAt || 0));
}

/** Text filter: words match title, folder, agent, branch or a tag; "#tag" matches tags only. */
export function matchesFilter(s: SessionSummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tags = s.user.tags || [];
  return words.every((w) => {
    if (w.startsWith('#')) return w.length === 1 || tags.some((t) => t.startsWith(w.slice(1)));
    return (
      s.title.toLowerCase().includes(w) ||
      s.cwd.toLowerCase().includes(w) ||
      s.agentName.toLowerCase().includes(w) ||
      Boolean(s.git?.branch && s.git.branch.toLowerCase().includes(w)) ||
      tags.some((t) => t.includes(w))
    );
  });
}

/** "38m", "2h", "<1m". */
function shortDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

/** Context use and the estimated prompt-cache time left, for the line under a session's title. */
export function sessionVitals(s: SessionSummary, now: number): { context?: string; contextTone?: Tone; cache?: string; cacheTone?: Tone; cacheTitle?: string } {
  const out: ReturnType<typeof sessionVitals> = {};
  const used = s.contextTokens || 0;
  if (used > 0) {
    const window = sessionPricing({ agentId: s.agentId, model: s.model, contextWindow: s.contextWindow }).contextWindow;
    const pct = Math.min(100, Math.round((used / window) * 100));
    out.context = `ctx ${pct}% · ${formatTokens(used)}/${formatTokens(window)}`;
    out.contextTone = pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : 'neutral';
  }
  if (s.cacheExpiresAt) {
    if (isWorking(s)) {
      out.cache = 'cache warm';
      out.cacheTone = 'neutral';
    } else {
      const left = s.cacheExpiresAt - now;
      out.cache = left > 0 ? `cache ${shortDuration(left)}` : 'cache cold';
      out.cacheTone = left <= 0 ? 'neutral' : left < 5 * 60_000 ? 'warn' : 'ok';
    }
    out.cacheTitle = `Estimated: the prompt cache lapses at ${new Date(s.cacheExpiresAt).toLocaleTimeString()}. A reply after that re-reads the whole context at full price.`;
  }
  return out;
}

/** A turn is running, or work the agent started still runs after its turn ended. */
export const isWorking = (s: SessionSummary) => s.state === 'working' || (s.state === 'needs_you' && Boolean(s.workingInBackground));

/** Previews are one line of plain text; drop markdown markers. */
export function plainText(md: string | undefined): string {
  return (md || '')
    .replace(/```[\w-]*/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() || cwd;

export const shortModel = (model?: string) => model?.replace(/^claude-/, '').replace(/^gemini-/, '');

/**
 * The line under a session's title: the pending approval or question, else the
 * recap or last prompt. `approval` marks either kind of request; `question` the second.
 */
export function sessionPreview(s: SessionSummary): { text: string; approval: boolean; question: boolean } {
  if (s.hasPendingPermission && s.pendingPermissionTitle) {
    return { text: `Approve: ${s.pendingPermissionTitle}`, approval: true, question: false };
  }
  if (s.hasPendingElicitation && s.pendingElicitationTitle) {
    return { text: `Answer: ${s.pendingElicitationTitle}`, approval: true, question: true };
  }
  return { text: plainText(s.recap || s.lastPrompt), approval: false, question: false };
}

const PRIORITY_TONE: Record<string, Tone> = { p0: 'danger', p1: 'warn', p2: 'neutral' };

export const PriorityBadge: React.FC<{ priority: SessionSummary['user']['priority'] }> = ({ priority }) =>
  priority ? (
    <Badge tone={PRIORITY_TONE[priority]} className="shell-prio" title={`Priority ${priority.toUpperCase()}`}>
      {priority.toUpperCase()}
    </Badge>
  ) : null;

/** Vendor mark, folder, branch and model. */
export const SessionMeta: React.FC<{ session: SessionSummary; showModel?: boolean }> = ({ session, showModel = true }) => {
  const model = shortModel(session.model);
  return (
    <span className="shell-meta">
      <VendorIcon agentId={session.agentId} size={12} />
      <span className="shell-meta-item" title={session.cwd}>
        {folderName(session.cwd)}
      </span>
      {session.git?.branch && (
        <span className="shell-meta-item" title={`Branch ${session.git.branch}`}>
          <Icon name="branch" size={11} />
          <span className="shell-meta-text">{session.git.branch}</span>
          {session.git.uncommittedFiles > 0 && (
            <span className="shell-meta-dirty" title={`${session.git.uncommittedFiles} uncommitted files`}>
              +{session.git.uncommittedFiles}
            </span>
          )}
        </span>
      )}
      {showModel && model && <span className="shell-meta-item mono shell-meta-model">{model}</span>}
    </span>
  );
};

// ------------------------------------------------------------------ sidebar

type FilterTab = 'all' | 'needs_you' | 'active' | 'cleanup';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onGoHome: () => void;
  onOpenNewModal: () => void;
  onOpenPalette: () => void;
  onOpenSubscriptionsModal: () => void;
  onOpenNetworkModal: () => void;
  onOpenMcpModal: () => void;
  /** MCP servers switched on, shown next to the MCP entry. */
  mcpActiveCount: number;
  hasActiveSession?: boolean;
  activeSessionTitle?: string;
  onReturnToActiveSession?: () => void;
}

const COLLAPSED_KEY = 'codepit_sidebar_collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const GROUPS: Array<{ id: string; label: string; test: (s: SessionSummary) => boolean }> = [
  { id: 'needs_you', label: 'Needs you', test: needsAttention },
  { id: 'working', label: 'Working', test: isWorking },
  { id: 'parked', label: 'Parked', test: (s) => s.state === 'parked' },
  { id: 'quiet', label: 'Idle', test: (s) => s.state === 'quiet' },
  { id: 'snoozed', label: 'Snoozed', test: (s) => s.state === 'snoozed' },
];

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  selectedId,
  onSelectSession,
  onGoHome,
  onOpenNewModal,
  onOpenPalette,
  onOpenSubscriptionsModal,
  onOpenNetworkModal,
  onOpenMcpModal,
  mcpActiveCount,
  hasActiveSession,
  activeSessionTitle,
  onReturnToActiveSession,
}) => {
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  // Cache countdowns move on their own
  const now = useNow(30_000);

  useEffect(() => {
    if (filterOpen) filterRef.current?.focus();
  }, [filterOpen]);

  const textFiltered = filterText ? sessions.filter((s) => matchesFilter(s, filterText)) : sessions;

  // Sessions marked for cleanup leave every view but the Cleanup tab.
  // Tab counts come from the text-filtered set, so they stay put while switching tabs.
  const tabs: Array<{ id: FilterTab; label: string; test: (s: SessionSummary) => boolean }> = [
    { id: 'all', label: 'All', test: (s) => !s.user.cleanup },
    { id: 'needs_you', label: 'Needs you', test: (s) => !s.user.cleanup && needsAttention(s) },
    { id: 'active', label: 'Active', test: (s) => !s.user.cleanup && (needsAttention(s) || isWorking(s)) },
    { id: 'cleanup', label: 'Cleanup', test: (s) => s.user.cleanup },
  ];
  const activeTab = tabs.find((t) => t.id === filterTab)!;
  const filteredSessions = textFiltered.filter(activeTab.test);
  const groups = GROUPS.map((g) => ({ ...g, items: filteredSessions.filter(g.test) })).filter((g) => g.items.length > 0);
  const isHome = selectedId === null;

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sb-head">
        <button type="button" className="sb-brand" onClick={onGoHome} title="Home">
          <BrandMark />
          <span className="sb-brand-name">CodePit</span>
        </button>
        <div className="sb-head-actions">
          <IconButton
            icon="filter"
            label={filterOpen ? 'Hide the text filter' : 'Filter sessions by text'}
            size="sm"
            active={filterOpen || Boolean(filterText)}
            onClick={() => {
              if (filterOpen) setFilterText('');
              setFilterOpen(!filterOpen);
            }}
          />
          <span className="sb-head-mobile">
            <IconButton icon="search" label="Search and commands" onClick={onOpenPalette} />
            <Button variant="primary" size="sm" icon="plus" onClick={onOpenNewModal}>
              New
            </Button>
          </span>
        </div>
      </div>

      <nav className="sb-actions" aria-label="Workspace">
        <button type="button" className="sb-action" onClick={onOpenNewModal} title="Start a new agent session">
          <Icon name="plus" size={15} className="sb-action-icon" />
          <span className="sb-action-label">New session</span>
          <span className="sb-action-keys" aria-hidden>
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>N</Kbd>
          </span>
        </button>
        <button type="button" className="sb-action" onClick={onOpenPalette} title="Search sessions and run commands">
          <Icon name="search" size={15} className="sb-action-icon" />
          <span className="sb-action-label">Search</span>
          <span className="sb-action-keys" aria-hidden>
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <button
          type="button"
          className={`sb-action sb-action-home ${isHome ? 'is-current' : ''}`}
          onClick={onGoHome}
          aria-current={isHome ? 'page' : undefined}
        >
          <Icon name="home" size={15} className="sb-action-icon" />
          <span className="sb-action-label">Home</span>
        </button>
        <button
          type="button"
          className="sb-action"
          onClick={onOpenMcpModal}
          title="MCP servers your agents can use, and each agent's plugins and skills"
        >
          <Icon name="plug" size={15} className="sb-action-icon" />
          <span className="sb-action-label">MCP and plugins</span>
          {mcpActiveCount > 0 && (
            <span className="sb-action-count" aria-label={`${mcpActiveCount} MCP server${mcpActiveCount === 1 ? '' : 's'} on`}>
              {mcpActiveCount}
            </span>
          )}
        </button>
      </nav>

      <div className="sb-filters">
        <div className="sb-tabs" role="tablist" aria-label="Filter sessions">
          {tabs.map((t) => {
            const count = textFiltered.filter(t.test).length;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === filterTab}
                className={`sb-tab ${t.id === filterTab ? 'is-selected' : ''}`}
                onClick={() => setFilterTab(t.id)}
              >
                {t.label}
                {count > 0 && <span className={`sb-tab-count ${t.id === 'needs_you' ? 'is-alert' : ''}`}>{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {filterOpen && (
        <div className="sb-filter-input">
          <Input
            ref={filterRef}
            type="text"
            placeholder="Filter by title, folder, branch or #tag"
            aria-label="Filter sessions by text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('');
                setFilterOpen(false);
              }
            }}
          />
        </div>
      )}

      {hasActiveSession && onReturnToActiveSession && (
        <button type="button" className="sb-return" onClick={onReturnToActiveSession}>
          <span className="sb-return-text">
            Back to <strong>{activeSessionTitle || 'the open session'}</strong>
          </span>
          <Icon name="chevronRight" size={15} />
        </button>
      )}

      {/* Every session, not the filtered ones: the count does not depend on the tab or the filter */}
      <RestoreAllBar sessions={sessions} />

      <div className="sb-list">
        {groups.map((g) => {
          // A text filter shows every match, folded or not
          const isCollapsed = collapsed.has(g.id) && !filterText;
          const unseen = isCollapsed ? g.items.filter((s) => isUnseen(s)).length : 0;
          return (
            <section key={g.id} className={`sb-group ${isCollapsed ? 'is-collapsed' : ''}`} aria-label={g.label}>
              <button
                type="button"
                className="sb-group-label"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroup(g.id)}
                title={isCollapsed ? `Show ${g.label.toLowerCase()} sessions` : `Hide ${g.label.toLowerCase()} sessions`}
              >
                <Icon name="chevronDown" size={11} className="sb-group-chevron" />
                <span>{g.label}</span>
                <span className="sb-group-count">{g.items.length}</span>
                {unseen > 0 && (
                  <span className="sb-group-unseen" title={`${unseen} finished since you last looked`}>
                    {unseen} new
                  </span>
                )}
              </button>
              {!isCollapsed &&
                g.items.map((s) => (
                  <SessionRow key={s.id} session={s} now={now} isSelected={s.id === selectedId} onSelect={() => onSelectSession(s.id)} />
                ))}
            </section>
          );
        })}

        {filteredSessions.length === 0 && (
          <div className="sb-list-empty">
            {sessions.length === 0 ? (
              <>
                <span>No sessions yet.</span>
                <Button variant="ghost" size="sm" icon="plus" onClick={onOpenNewModal}>
                  Start your first session
                </Button>
              </>
            ) : filterText ? (
              <span>No sessions match "{filterText}".</span>
            ) : (
              <span>Nothing here right now.</span>
            )}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <button
          type="button"
          className="sb-foot-btn"
          data-testid="lan-access"
          onClick={onOpenNetworkModal}
          title="Open this workspace from another device on your network"
        >
          <Icon name="wifi" size={14} />
          <span>LAN access</span>
        </button>
        <div className="sb-foot-right">
          <ThemeMenu />
          <span className="sb-foot-mcp">
            <IconButton icon="plug" label="MCP and plugins" size="sm" onClick={onOpenMcpModal} />
            {mcpActiveCount > 0 && (
              <span className="sb-foot-mcp-count" aria-hidden>
                {mcpActiveCount}
              </span>
            )}
          </span>
          <IconButton
            icon="card"
            label="Subscriptions and usage"
            size="sm"
            onClick={onOpenSubscriptionsModal}
            title="Subscriptions, credentials and usage across vendors"
          />
        </div>
      </div>
    </aside>
  );
};

const SessionRow: React.FC<{
  session: SessionSummary;
  now: number;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ session, now, isSelected, onSelect }) => {
  const status = sessionStatus(session);
  const preview = sessionPreview(session);
  const vitals = sessionVitals(session, now);
  // The open session counts as seen; the ring is for the others
  const unseen = !isSelected && isUnseen(session);
  return (
    <div
      className={`sb-row ${isSelected ? 'is-selected' : ''}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
      data-session-id={session.id}
      title={session.rankSummary || undefined}
    >
      <div className="sb-row-top">
        <span className={`sb-row-dot ${unseen ? 'is-unseen' : ''}`} title={unseen ? `${status.label} · finished since you last looked` : status.label}>
          <StatusDot tone={status.tone} pulse={status.pulse} label={unseen ? `${status.label}, new` : status.label} />
          {unseen && (
            <svg className="sb-row-ring" viewBox="0 0 16 16" aria-hidden>
              <circle cx="8" cy="8" r="6.5" pathLength={100} />
            </svg>
          )}
        </span>
        <span className="sb-row-title">{session.title}</span>
        {session.user.pinned && (
          <span className="sb-row-pin" title="Pinned">
            <Icon name="pin" size={11} />
          </span>
        )}
        <PriorityBadge priority={session.user.priority} />
        {isRestorable(session) && <RowRestoreButton session={session} />}
        <span className="sb-row-time" title={new Date(session.updatedAt).toLocaleString()}>
          {relativeTime(session.updatedAt)}
        </span>
      </div>
      <div className="sb-row-meta">
        <SessionMeta session={session} />
      </div>
      {preview.approval ? (
        <div className="sb-row-preview is-approval" title={preview.text}>
          {preview.text}
        </div>
      ) : (
        (vitals.context || vitals.cache) && (
          <div className="sb-row-vitals">
            {vitals.context && <span className={`sb-vital tone-${vitals.contextTone}`}>{vitals.context}</span>}
            {vitals.context && vitals.cache && <span className="sb-vital-sep" aria-hidden>·</span>}
            {vitals.cache && (
              <span className={`sb-vital tone-${vitals.cacheTone}`} title={vitals.cacheTitle}>
                {vitals.cache}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
};

/** Restore the row's agent without opening the session; the row's own click and keys are not triggered. */
const RowRestoreButton: React.FC<{ session: SessionSummary }> = ({ session }) => {
  const [busy, setBusy] = useState(false);
  if (busy || session.restoring) {
    return (
      <span className="sb-row-restore is-busy" title="Restoring the agent" role="status" aria-label="Restoring the agent">
        <Spinner size={12} />
      </span>
    );
  }
  return (
    <IconButton
      icon="play"
      size="sm"
      tone="warn"
      className="sb-row-restore"
      label="Restore agent"
      title={session.restore?.error ? `Restore agent (last try failed: ${session.restore.error})` : 'Restore agent: start the agent that was running when CodePit closed'}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await api.restoreSession(session.id);
        } catch (err: any) {
          // Said out loud: a row's title is hover-only, and phones never show it
          alert(`Could not restore "${session.title}": ${err?.message || err}`);
        } finally {
          setBusy(false);
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
};
