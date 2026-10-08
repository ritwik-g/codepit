import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AcpSession, AgentDescriptor, AgentTask, AgentTaskTextDelta, McpServer, SessionSummary } from './types';
import { api, connectWebSocket, isUnauthorized, type PairingRequestInfo } from './api';
import { Sidebar } from './components/Sidebar';
import { SessionDetail, nextPriority } from './components/SessionDetail';
import { NewSessionModal } from './components/NewSessionModal';
import { SwitchAgentModal } from './components/SwitchAgentModal';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { HomeDashboard } from './components/HomeDashboard';
import { BrandMark } from './components/BrandMark';
import { SubscriptionsUsageModal } from './components/SubscriptionsUsageModal';
import { NetworkModal } from './components/NetworkModal';
import { PairScreen } from './components/PairScreen';
import { McpModal } from './components/mcp/McpModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MOD_KEY, isUnseen, needsAttention } from './components/Sidebar';
import { askForNotificationsOnFirstGesture, notificationsEnabled, notificationsSupported, sessionAlert, setNotificationsEnabled, showAlert } from './notify';
import { useTheme } from './design/theme';
import { Button, Icon, IconButton, Spinner } from './ui';

/** Session ids in the order the sidebar shows them, honouring its filters and grouping. */
function visibleSessionOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.sidebar [data-session-id]')).map(
    (el) => el.dataset.sessionId!
  );
}

/** Append one streamed chunk of a subagent's text or reasoning to its task (and, for a reply, its spawning call). */
function applyTaskText(prev: AcpSession, d: AgentTaskTextDelta): AcpSession {
  let next = prev;
  const tasks = prev.agentTasks || [];
  const ti = tasks.findIndex((t) => t.id === d.taskId);
  if (ti !== -1) {
    const task = tasks[ti];
    const segments = [...(task.segments || [])];
    const si = segments.findIndex((seg) => seg.id === d.segmentId);
    const seg = segments[si];
    if (seg && seg.kind !== 'tool') segments[si] = { ...seg, text: seg.text + d.text };
    else if (d.kind === 'text') segments.push({ kind: 'text', id: d.segmentId, text: d.text, messageId: d.messageId });
    else segments.push({ kind: 'thought', id: d.segmentId, text: d.text });
    const nextTasks = [...tasks];
    nextTasks[ti] = { ...task, segments };
    next = { ...next, agentTasks: nextTasks };
  }
  if (d.toolCallId) {
    const turnIdx = prev.turns.findIndex((t) => t.toolCalls?.some((c) => c.id === d.toolCallId));
    if (turnIdx !== -1) {
      const turns = [...prev.turns];
      const turn = turns[turnIdx];
      turns[turnIdx] = {
        ...turn,
        toolCalls: turn.toolCalls!.map((c) => (c.id === d.toolCallId ? { ...c, subagentText: (c.subagentText || '') + d.text } : c)),
      };
      next = { ...next, turns };
    }
  }
  return next;
}

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<AcpSession | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  // Agent to preselect in the new-session dialog (from a home quick-start card).
  const [newSessionAgentId, setNewSessionAgentId] = useState<string | null>(null);
  const [showSubscriptionsModal, setShowSubscriptionsModal] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  // Saved MCP servers, for the sidebar's count of the ones switched on
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [authError, setAuthError] = useState(false);
  // A device asking the host to let it in; only the host's own page hears of these
  const [pairingToast, setPairingToast] = useState<PairingRequestInfo | null>(null);
  // Bumped when devices or pairing requests change, so an open LAN dialog reloads them
  const [devicesVersion, setDevicesVersion] = useState(0);
  // Start on the list: with nothing selected yet, the session pane on mobile is a dead end.
  const [mobileView, setMobileView] = useState<'list' | 'session'>('list');
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const { resolved: resolvedTheme, preference: themePreference, setPreference: setThemePreference } = useTheme();
  const [notifyOn, setNotifyOn] = useState(notificationsEnabled);
  // Keep asynchronous work tied to the session that is currently wanted, rather
  // than the session that happened to be selected when a request began.
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const detailRequestRef = useRef<AbortController | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
      setAuthError(false);
      setOffline(false);
      const currentSelectedId = selectedIdRef.current;
      if (currentSelectedId && !res.sessions.some((s) => s.id === currentSelectedId)) {
        // The open session was deleted (here or from another tab/device).
        const nextId = res.sessions[0]?.id ?? null;
        selectedIdRef.current = nextId;
        detailRequestRef.current?.abort();
        setActiveSession(null);
        setSelectedId(nextId);
      } else if (currentSelectedId) {
        const match = res.sessions.find((s) => s.id === currentSelectedId);
        if (match) {
          setActiveSession((prev) => {
            if (!prev || prev.id !== currentSelectedId) return prev;
            if (prev.state !== match.state) {
              return { ...prev, state: match.state };
            }
            return prev;
          });
        }
      }
    } catch (err: any) {
      console.error('[App] Failed to fetch sessions:', err);
      if (isUnauthorized(err)) {
        setAuthError(true);
      } else {
        setOffline(true);
      }
    }
  }, []);

  const fetchSessionDetail = useCallback(async (id: string) => {
    detailRequestRef.current?.abort();
    const request = new AbortController();
    detailRequestRef.current = request;
    try {
      const res = await api.getSession(id, request.signal);
      // A slower response for an earlier tap must never replace the session the
      // user selected most recently. This is especially noticeable over LAN.
      if (request.signal.aborted || detailRequestRef.current !== request || selectedIdRef.current !== id) return;
      setActiveSession(res.session);
    } catch (err: any) {
      if (request.signal.aborted || err?.name === 'AbortError') return;
      console.error(`[App] Failed to fetch session detail for ${id}:`, err);
      if (isUnauthorized(err)) {
        setAuthError(true);
      }
    } finally {
      if (detailRequestRef.current === request) detailRequestRef.current = null;
    }
  }, []);

  const selectSession = useCallback((id: string) => {
    if (selectedIdRef.current !== id) {
      // Cancel a potentially very large old transcript immediately; waiting for
      // its body to download/parse made fast taps on mobile feel unresponsive.
      selectedIdRef.current = id;
      detailRequestRef.current?.abort();
      setActiveSession((prev) => (prev?.id === id ? prev : null));
    }
    setSelectedId(id);
    setMobileView('session');
  }, []);

  useEffect(() => () => detailRequestRef.current?.abort(), []);

  // Initial load
  useEffect(() => {
    Promise.all([
      api.getAgents().then((res) => setAgents(res.agents)).catch((err) => {
        if (isUnauthorized(err)) setAuthError(true);
      }),
      fetchSessions(),
      // The count is a nicety; never hold up the first paint or fail the load over it
      api.getMcpServers().then((res) => setMcpServers(res.servers)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [fetchSessions]);

  // System notifications: a turn finished, or the agent asks something. Not for the session
  // the user is looking at right now.
  const prevSessionsRef = useRef<Map<string, SessionSummary>>(new Map());
  useEffect(() => askForNotificationsOnFirstGesture(), []);
  useEffect(() => {
    const prev = prevSessionsRef.current;
    const first = prev.size === 0;
    for (const s of sessions) {
      const alert = first ? null : sessionAlert(prev.get(s.id), s);
      if (!alert) continue;
      const looking = document.visibilityState === 'visible' && document.hasFocus() && selectedIdRef.current === s.id;
      if (!looking) {
        showAlert(alert, () => {
          selectSession(s.id);
        });
      }
    }
    prevSessionsRef.current = new Map(sessions.map((s) => [s.id, s]));
  }, [sessions, selectSession]);

  // The open session's finished turn counts as seen while the window is in front
  const selectedUnseen = sessions.some((s) => s.id === selectedId && isUnseen(s));
  useEffect(() => {
    if (!selectedId || !selectedUnseen) return;
    const mark = () => {
      if (document.visibilityState === 'visible') api.markSeen(selectedId).catch(() => {});
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [selectedId, selectedUnseen]);

  // Load session detail on selection change
  useEffect(() => {
    if (selectedId) {
      fetchSessionDetail(selectedId);
    } else {
      setActiveSession(null);
    }
  }, [selectedId, fetchSessionDetail]);

  // Periodic background check to prevent state drift
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  // WebSocket reactive updates
  useEffect(() => {
    let wasOffline = false;
    const ws = connectWebSocket((msg) => {
      const currentSelectedId = selectedIdRef.current;
      if (msg.type === 'sessionsUpdated' && Array.isArray(msg.sessions)) {
        setSessions(msg.sessions);
        if (currentSelectedId) {
          const match = msg.sessions.find((s: SessionSummary) => s.id === currentSelectedId);
          if (!match) {
            const nextId = msg.sessions[0]?.id ?? null;
            selectedIdRef.current = nextId;
            detailRequestRef.current?.abort();
            setActiveSession(null);
            setSelectedId(nextId);
          } else {
            setActiveSession((prev) => {
              if (!prev || prev.id !== currentSelectedId) return prev;
              if (prev.state !== match.state) {
                return { ...prev, state: match.state };
              }
              return prev;
            });
          }
        }
      } else if (msg.type === 'sessionStream' || ['thought', 'message', 'toolCall', 'toolCallUpdate', 'turnCompleted'].includes(msg.type)) {
        // An agent reported its models and effort levels; the server cached them on its descriptor
        if (msg.event === 'agentOptions') {
          api.getAgents().then((res) => setAgents(res.agents)).catch(() => {});
        }
        if (currentSelectedId && msg.sessionId === currentSelectedId) {
          if (msg.session) {
            setActiveSession((prev) => (prev && prev.id === currentSelectedId ? { ...prev, ...msg.session } : prev));
          }
          if (msg.turn) {
            setActiveSession((prev) => {
              if (!prev || prev.id !== msg.sessionId) return prev;
              const turns = [...prev.turns];
              const idx = turns.findIndex((t) => t.id === msg.turn.id);
              let turn = idx !== -1 ? { ...turns[idx], ...msg.turn } : msg.turn;
              // Tool events carry the turn without its calls (a long turn's are megabytes); the one call that changed comes alone
              if (msg.toolCall && !msg.turn.toolCalls) {
                const calls = [...(turn.toolCalls || [])];
                const at = calls.findIndex((c) => c.id === msg.toolCall.id);
                if (at === -1) calls.push(msg.toolCall);
                else calls[at] = msg.toolCall;
                turn = { ...turn, toolCalls: calls };
              }
              if (idx !== -1) turns[idx] = turn;
              else turns.push(turn);
              return { ...prev, turns };
            });
          }
          if (Array.isArray(msg.agentTasks) || Array.isArray(msg.removedAgentTaskIds)) {
            // Only the tasks that changed are sent; replace them by id, and drop any merged away
            setActiveSession((prev) => {
              if (!prev || prev.id !== msg.sessionId) return prev;
              const removed = new Set<string>(msg.removedAgentTaskIds || []);
              const tasks = (prev.agentTasks || []).filter((x) => !removed.has(x.id));
              for (const t of (msg.agentTasks || []) as AgentTask[]) {
                const idx = tasks.findIndex((x) => x.id === t.id);
                if (idx === -1) tasks.push(t);
                else tasks[idx] = t;
              }
              return { ...prev, agentTasks: tasks };
            });
          }
          if (msg.taskText) {
            setActiveSession((prev) => (prev && prev.id === msg.sessionId ? applyTaskText(prev, msg.taskText as AgentTaskTextDelta) : prev));
          }
          if (msg.event === 'rateLimits' || msg.rateLimits) {
            setActiveSession((prev) => (prev && prev.id === msg.sessionId ? { ...prev, rateLimits: msg.rateLimits || prev.rateLimits } : prev));
          }
          if (msg.event === 'promptSuggestion' || msg.promptSuggestion) {
            setActiveSession((prev) => (prev && prev.id === currentSelectedId ? { ...prev, promptSuggestion: msg.promptSuggestion || prev.promptSuggestion } : prev));
          }
          if (['thought', 'message', 'toolCall', 'toolCallUpdate'].includes(msg.event || msg.type)) {
            setActiveSession((prev) => (prev && prev.id === currentSelectedId && prev.state !== 'working' ? { ...prev, state: 'working' } : prev));
          }
          if (['turnCompleted', 'sessionStopped', 'sessionStarted', 'sessionSwitched', 'sessionCompacted', 'sessionRollback', 'backgroundSettled', 'resumed'].includes(msg.event || msg.type)) {
            if (msg.event === 'turnCompleted' || msg.type === 'turnCompleted') {
              setActiveSession((prev) => (prev && prev.id === currentSelectedId ? { ...prev, state: 'needs_you' } : prev));
            }
            fetchSessionDetail(currentSelectedId);
            fetchSessions();
          }
        }
      } else if (['permissionRequested', 'permissionResolved', 'elicitationRequested', 'elicitationResolved'].includes(msg.type)) {
        if (currentSelectedId && msg.sessionId === currentSelectedId) {
          fetchSessionDetail(currentSelectedId);
          fetchSessions();
        }
      } else if (msg.type === 'claudeRateLimits' && msg.rateLimits) {
        // Claude's plan limits are account-wide, so a Claude session's Usage tab follows them live
        setActiveSession((prev) => (prev && prev.agentId === 'claude' ? { ...prev, rateLimits: msg.rateLimits } : prev));
      } else if (msg.type === 'pairingRequest' && msg.request) {
        setPairingToast(msg.request as PairingRequestInfo);
      } else if (msg.type === 'devicesChanged') {
        setDevicesVersion((v) => v + 1);
      }
    }, () => {
      // Reconnected: resync everything streamed while the socket was down.
      if (wasOffline) {
        wasOffline = false;
        setOffline(false);
        fetchSessions();
        const currentSelectedId = selectedIdRef.current;
        if (currentSelectedId) fetchSessionDetail(currentSelectedId);
      }
    }, (code) => {
      // This device's access was revoked from the host: back to the pair screen at once
      if (code === 4401) {
        setAuthError(true);
        return;
      }
      wasOffline = true;
      setOffline(true);
    });

    return () => {
      ws.close();
    };
  }, [fetchSessionDetail, fetchSessions]);

  // A pairing request lasts five minutes; so does its toast
  useEffect(() => {
    if (!pairingToast) return;
    const timer = setTimeout(() => setPairingToast(null), Math.max(0, pairingToast.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pairingToast]);

  const anyModalOpen =
    showNewModal || showSwitchModal || showPalette || showSubscriptionsModal || showNetworkModal || showMcpModal;

  const openNewSession = useCallback((agentId?: string) => {
    setNewSessionAgentId(agentId ?? null);
    setShowNewModal(true);
  }, []);

  const goHome = useCallback(() => {
    selectedIdRef.current = null;
    detailRequestRef.current?.abort();
    setSelectedId(null);
    setActiveSession(null);
    setMobileView('list');
  }, []);

  /** Update the open session's pin, priority or cleanup mark, then refresh. */
  const annotate = useCallback(
    (updates: Parameters<typeof api.updateAnnotations>[1], what: string) => {
      if (!selectedId) return;
      api
        .updateAnnotations(selectedId, updates)
        .then(() => {
          fetchSessions();
          fetchSessionDetail(selectedId);
        })
        .catch((err) => alert(`Could not update ${what}: ${err.message}`));
    },
    [selectedId, fetchSessions, fetchSessionDetail]
  );

  // Show how many sessions need the user in the tab title.
  useEffect(() => {
    const n = sessions.filter(needsAttention).length;
    document.title = n > 0 ? `(${n}) CodePit` : 'CodePit';
  }, [sessions]);

  const handleDeleted = useCallback(
    (deletedId: string) => {
      // Move to the neighbouring session in sidebar order rather than leaving the
      // deleted one on screen.
      const order = visibleSessionOrder();
      const idx = order.indexOf(deletedId);
      const remaining = order.filter((id) => id !== deletedId);
      const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)] ?? null;
      if (next) selectSession(next);
      else goHome();
      fetchSessions();
    },
    [fetchSessions, goHome, selectSession]
  );

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc must close a modal even while focus is in one of its inputs.
        setShowNewModal(false);
        setShowSwitchModal(false);
        setShowPalette(false);
        setShowSubscriptionsModal(false);
        setShowNetworkModal(false);
        setShowMcpModal(false);
        return;
      }

      if (e.key.toLowerCase() === 'n' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openNewSession();
        return;
      }

      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        // Toggles the palette from anywhere, but doesn't stack it over another dialog.
        e.preventDefault();
        if (showPalette) setShowPalette(false);
        else if (!anyModalOpen) setShowPalette(true);
        return;
      }

      // Everything below is a bare single-key shortcut: never steal Cmd/Ctrl/Alt
      // combos (Cmd+C must copy, not toggle cleanup), typing, or keys meant for a modal.
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (target?.closest?.('.xterm')) return;
      if (anyModalOpen) return;

      if (e.key === '/') {
        e.preventDefault();
        setShowPalette(true);
      } else if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        // Arrows navigate only from the page or the sidebar, so they still scroll
        // the conversation when it has focus.
        const isArrow = e.key.startsWith('Arrow');
        if (isArrow && target !== document.body && !target?.closest?.('.sidebar')) return;
        e.preventDefault();
        const order = visibleSessionOrder();
        if (order.length === 0) return;
        const idx = selectedId ? order.indexOf(selectedId) : -1;
        const nextIdx =
          e.key === 'j' || e.key === 'ArrowDown'
            ? idx === -1 || idx === order.length - 1 ? 0 : idx + 1
            : idx <= 0 ? order.length - 1 : idx - 1;
        const nextId = order[nextIdx];
        selectSession(nextId);
        document.querySelector(`[data-session-id="${CSS.escape(nextId)}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && selectedId) {
        setMobileView('session');
      } else if (e.key === 'p' && selectedId && activeSession) {
        annotate({ priority: nextPriority(activeSession.user.priority) }, 'priority');
      } else if (e.key === 'c' && selectedId && activeSession) {
        annotate({ cleanup: !activeSession.user.cleanup }, 'cleanup mark');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, activeSession, anyModalOpen, showPalette, openNewSession, annotate, selectSession]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];
    const current = activeSession && activeSession.id === selectedId ? activeSession : null;
    if (current) {
      const next = nextPriority(current.user.priority);
      list.push(
        {
          id: 'switch-agent',
          label: 'Switch agent',
          icon: 'swap',
          group: 'Current session',
          keywords: 'change vendor model handoff',
          run: () => setShowSwitchModal(true),
        },
        {
          id: 'pin',
          label: current.user.pinned ? 'Unpin session' : 'Pin session',
          icon: 'pin',
          group: 'Current session',
          keywords: 'pin unpin favourite',
          run: () => annotate({ pinned: !current.user.pinned }, 'pin'),
        },
        {
          id: 'priority',
          label: next ? `Set priority to ${next.toUpperCase()}` : 'Clear priority',
          icon: 'star',
          group: 'Current session',
          keywords: 'priority p0 p1 p2 importance',
          shortcut: ['p'],
          run: () => annotate({ priority: next }, 'priority'),
        },
        {
          id: 'cleanup',
          label: current.user.cleanup ? 'Unmark for cleanup' : 'Mark for cleanup',
          icon: 'archive',
          group: 'Current session',
          keywords: 'cleanup archive done tidy',
          shortcut: ['c'],
          run: () => annotate({ cleanup: !current.user.cleanup }, 'cleanup mark'),
        }
      );
    }
    list.push({
      id: 'new',
      label: 'New session',
      icon: 'plus',
      group: 'Actions',
      keywords: 'start create launch agent',
      shortcut: [MOD_KEY, 'N'],
      run: () => openNewSession(),
    });
    if (selectedId) {
      list.push({ id: 'home', label: 'Go to home', icon: 'home', group: 'Actions', keywords: 'dashboard overview', run: goHome });
    }
    const other = resolvedTheme === 'dark' ? 'light' : 'dark';
    list.push({
      id: 'theme',
      label: `Switch to ${other} theme`,
      icon: other === 'light' ? 'sun' : 'moon',
      group: 'Actions',
      keywords: 'toggle theme appearance dark light mode',
      run: () => setThemePreference(other),
    });
    if (themePreference !== 'system') {
      list.push({
        id: 'theme-system',
        label: 'Use system theme',
        icon: 'monitor',
        group: 'Actions',
        keywords: 'theme appearance auto os',
        run: () => setThemePreference('system'),
      });
    }
    if (notificationsSupported()) {
      list.push({
        id: 'notifications',
        label: notifyOn ? 'Turn off notifications' : 'Turn on notifications',
        icon: 'bell',
        group: 'Actions',
        keywords: 'notify alert finished question approval desktop system',
        run: () => {
          setNotificationsEnabled(!notifyOn).then(setNotifyOn);
        },
      });
    }
    list.push(
      {
        id: 'lan',
        label: 'Open LAN access',
        icon: 'wifi',
        group: 'Actions',
        keywords: 'network phone device pair pairing qr code revoke share url',
        run: () => setShowNetworkModal(true),
      },
      {
        id: 'mcp',
        label: 'Open MCP servers and plugins',
        icon: 'plug',
        group: 'Actions',
        keywords: 'mcp tools servers plugins skills github filesystem memory search database',
        run: () => setShowMcpModal(true),
      },
      {
        id: 'subscriptions',
        label: 'Open subscriptions and usage',
        icon: 'card',
        group: 'Actions',
        keywords: 'settings billing credentials cost plan limits',
        run: () => setShowSubscriptionsModal(true),
      }
    );
    for (const a of agents) {
      list.push({
        id: `new-${a.id}`,
        label: `New ${a.name} session`,
        icon: 'plus',
        group: 'Actions',
        keywords: `start ${a.id} ${a.provider}`,
        searchOnly: true,
        run: () => openNewSession(a.id),
      });
    }
    return list;
  }, [activeSession, selectedId, agents, resolvedTheme, themePreference, notifyOn, annotate, openNewSession, goHome, setThemePreference]);

  // Not paired, or revoked while open: a 401 is final, whatever is already on screen
  if (authError) {
    return <PairScreen />;
  }

  if (loading && sessions.length === 0) {
    return <AppSkeleton />;
  }

  const newSessionAgents =
    newSessionAgentId && agents.some((a) => a.id === newSessionAgentId)
      ? // NewSessionModal preselects the first agent, so put the chosen one first.
        [...agents.filter((a) => a.id === newSessionAgentId), ...agents.filter((a) => a.id !== newSessionAgentId)]
      : agents;

  return (
    <div className={`app-container mobile-view-${mobileView}`}>
      <Sidebar
        sessions={sessions}
        selectedId={selectedId}
        onSelectSession={selectSession}
        onGoHome={goHome}
        onOpenNewModal={() => openNewSession()}
        onOpenPalette={() => setShowPalette(true)}
        onOpenSubscriptionsModal={() => setShowSubscriptionsModal(true)}
        onOpenNetworkModal={() => setShowNetworkModal(true)}
        onOpenMcpModal={() => setShowMcpModal(true)}
        mcpActiveCount={mcpServers.filter((s) => s.enabled).length}
        hasActiveSession={Boolean(activeSession)}
        activeSessionTitle={activeSession?.title}
        onReturnToActiveSession={() => setMobileView('session')}
      />

      {activeSession?.id === selectedId ? (
        <ErrorBoundary resetKey={activeSession.id} onLeave={{ label: 'Go to home', run: goHome }}>
          <SessionDetail
            session={activeSession}
            agents={agents}
            onRefresh={() => {
              fetchSessions();
              if (selectedId) fetchSessionDetail(selectedId);
            }}
            onOpenSwitchModal={() => setShowSwitchModal(true)}
            onOpenSubscriptionsModal={() => setShowSubscriptionsModal(true)}
            onOpenMcp={() => setShowMcpModal(true)}
            onBackToList={() => setMobileView('list')}
            onDeleted={handleDeleted}
            totalSessionsCount={sessions.length}
            allSessions={sessions}
            onSelectSession={selectSession}
          />
        </ErrorBoundary>
      ) : selectedId ? (
        <MainSkeleton />
      ) : (
        <ErrorBoundary resetKey="home">
          <HomeDashboard
            sessions={sessions}
            agents={agents}
            onSelectSession={selectSession}
            onNewSession={openNewSession}
            onOpenPalette={() => setShowPalette(true)}
          />
        </ErrorBoundary>
      )}

      {offline && (
        <div className="conn-toast" role="status">
          <Spinner size={13} />
          <span className="conn-toast-text">
            <strong>Connection lost.</strong> Reconnecting to the server…
          </span>
        </div>
      )}

      {pairingToast && !showNetworkModal && (
        <div className="conn-toast pair-toast" role="status">
          <Icon name="monitor" size={14} />
          <span className="conn-toast-text">
            <strong>{pairingToast.name}</strong> wants access
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setPairingToast(null);
              setShowNetworkModal(true);
            }}
          >
            Review
          </Button>
          <IconButton icon="x" label="Dismiss" size="sm" onClick={() => setPairingToast(null)} />
        </div>
      )}

      {showNewModal && (
        <NewSessionModal
          agents={newSessionAgents}
          onClose={() => setShowNewModal(false)}
          onCreated={(newId) => {
            setShowNewModal(false);
            fetchSessions().then(() => {
              selectSession(newId);
            });
          }}
        />
      )}

      {showSwitchModal && activeSession && (
        <SwitchAgentModal
          currentSession={activeSession}
          agents={agents}
          onClose={() => setShowSwitchModal(false)}
          onSwitched={(newId) => {
            setShowSwitchModal(false);
            fetchSessions().then(() => {
              selectSession(newId);
            });
          }}
        />
      )}

      {showPalette && (
        <CommandPalette
          sessions={sessions}
          currentSessionId={selectedId}
          actions={paletteActions}
          onClose={() => setShowPalette(false)}
          onSelectSession={selectSession}
        />
      )}

      {showSubscriptionsModal && (
        <SubscriptionsUsageModal
          onClose={() => setShowSubscriptionsModal(false)}
          onSelectSession={(id) => {
            selectSession(id);
            setShowSubscriptionsModal(false);
          }}
        />
      )}

      {showNetworkModal && <NetworkModal devicesVersion={devicesVersion} onClose={() => setShowNetworkModal(false)} />}

      {showMcpModal && (
        <McpModal
          agents={agents}
          workspace={activeSession?.cwd}
          onClose={() => setShowMcpModal(false)}
          onServersChange={setMcpServers}
        />
      )}
    </div>
  );
};

/** Placeholder for the main pane while a session loads. */
const MainSkeleton: React.FC = () => (
  <div className="main-skeleton" aria-busy="true" aria-label="Loading session">
    <div className="skel-header">
      <span className="skel skel-dot" />
      <span className="skel skel-line w-30" />
      <span className="skel skel-line w-10 push" />
    </div>
    <div className="skel-body">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skel-block">
          <span className="skel skel-line w-15" />
          <span className="skel skel-line w-70" />
          <span className="skel skel-line w-45" />
        </div>
      ))}
    </div>
  </div>
);

/** First paint while sessions load: the shell's shape, without content. */
const AppSkeleton: React.FC = () => (
  <div className="app-container mobile-view-list" aria-busy="true" aria-label="Loading CodePit">
    <aside className="sidebar sidebar-skeleton" aria-hidden>
      <div className="sb-head">
        <span className="sb-brand">
          <BrandMark />
          <span className="sb-brand-name">CodePit</span>
        </span>
      </div>
      <div className="skel-side">
        <span className="skel skel-row-lg" />
        <span className="skel skel-row-lg" />
        <span className="skel skel-line w-40" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel-session">
            <span className="skel skel-line w-70" />
            <span className="skel skel-line w-45" />
          </div>
        ))}
      </div>
    </aside>
    <div className="main-skeleton main-home">
      <div className="skel-home">
        <span className="skel skel-title" />
        <span className="skel skel-line w-40" />
        <div className="skel-cards">
          <span className="skel skel-card" />
          <span className="skel skel-card" />
          <span className="skel skel-card" />
        </div>
      </div>
    </div>
  </div>
);
