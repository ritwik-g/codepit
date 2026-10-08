import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AcpSession, AgentDescriptor, SessionSummary } from '../types';
import { api } from '../api';
import { useEscapeLayer } from '../hooks';
import { LiveTerminalPanel } from './LiveTerminalPanel';
import { ActivityStrip } from './ActivityStrip';
import { UsageTab } from './UsageTab';
import { usageMetrics } from '../pricing';
import { commandOf, isShellCall } from '../toolDisplay';
import { getModelMeta } from './AgentModelPicker';
import { advertisedModelLabel, effortLabel, sessionEffortChoices } from '../effort';
import type { MenuItem } from './Menu';
import { SessionHeader, SessionTabsBar, type WorkspaceTab } from './SessionHeader';
import { ApprovalBanner } from './ApprovalBanner';
import { ElicitationCard } from './ElicitationCard';
import { ConversationView, type RollbackAction } from './ConversationView';
import { Composer } from './Composer';
import { MobileActionSheet } from './MobileActionSheet';
import { isCompacting } from './CompactionCard';
import { ImageLightbox } from './ImageLightbox';
import { nextPriority, runningSubagents } from './sessionMeta';
import { AgentsPanel, agentTaskCounts } from './AgentsView';
import { AgentSessionNavContext, AgentTaskNavContext } from './agentTaskNav';
import { AgentSessionsPanel } from './AgentSessionsView';
import { SnoozeModal, TagsPanel } from './SessionOrganize';
import { RestoreSessionBanner, isRestorable } from './RestorePrompt';
import { ResumeAtModal, ResumeBanner } from './ResumeLater';

// Other areas import these from here.
export { STATE_LABEL, formatTime, nextPriority } from './sessionMeta';

interface SessionDetailProps {
  session: AcpSession;
  agents: AgentDescriptor[];
  onRefresh: () => void;
  onOpenSwitchModal: () => void;
  onOpenSubscriptionsModal?: () => void;
  onOpenMcp?: () => void;
  onBackToList?: () => void;
  onDeleted?: (id: string) => void;
  totalSessionsCount?: number;
  /** Every session: the Tags tab suggests their tags and lists the ones sharing this session's. */
  allSessions?: SessionSummary[];
  onSelectSession?: (id: string) => void;
}

/** The session workspace: header, tabs, conversation / terminal / usage, and the composer. */
export const SessionDetail: React.FC<SessionDetailProps> = ({
  session,
  agents,
  onRefresh,
  onOpenSwitchModal,
  onOpenSubscriptionsModal,
  onOpenMcp,
  onBackToList,
  onDeleted,
  totalSessionsCount,
  allSessions = [],
  onSelectSession,
}) => {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('conversation');
  const [showMobileActions, setShowMobileActions] = useState(false);
  // The restore offer is read from the summaries: the stream's shallow merge never clears a removed key
  const summary = allSessions.find((s) => s.id === session.id);
  const restorable = Boolean(summary && isRestorable(summary));
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [showResumeAt, setShowResumeAt] = useState(false);
  // Read from the summaries too: they always carry it, null once it is sent or cancelled
  const scheduledResume = summary?.scheduledResume ?? null;
  const [promptText, setPromptText] = useState('');
  const [rollingBack, setRollingBack] = useState(false);
  const [requestingCompaction, setRequestingCompaction] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  useEscapeLayer(Boolean(previewImage), () => setPreviewImage(null));
  useEscapeLayer(showMobileActions, () => setShowMobileActions(false));
  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  // Agent tasks open in the focused view of the Subagents tab (empty: its list)
  const [focusedTasks, setFocusedTasks] = useState<string[]>([]);
  const openAgentTasks = useCallback((...ids: string[]) => {
    setFocusedTasks(ids);
    setActiveTab('agents');
  }, []);
  // An agent session opens in the Agents tab, scrolled to and highlighted
  const [focusedAgentSession, setFocusedAgentSession] = useState<string | null>(null);
  const openAgentSession = useCallback((id: string) => {
    setFocusedAgentSession(id);
    setActiveTab('agentSessions');
  }, []);
  const changeTab = useCallback((tab: WorkspaceTab) => {
    setFocusedTasks([]);
    setFocusedAgentSession(null);
    setActiveTab(tab);
  }, []);

  useEffect(() => {
    setPromptText('');
    setFocusedTasks([]);
    setFocusedAgentSession(null);
  }, [session.id]);

  const shellCommandCount = session.turns.reduce(
    (n, t) => n + (t.toolCalls || []).filter((c) => isShellCall(c) && Boolean(commandOf(c))).length,
    0
  );

  // ------------------------------------------------------------- Handlers
  // The transcript is kept, so compacting needs no confirmation; its card shows progress
  const compacting = requestingCompaction || isCompacting(session);
  // As on the server: only what came after the last completed compaction can be compacted
  const compactBoundary = session.turns.reduce(
    (b, t, i) => (t.compaction?.status === 'completed' || (t.role === 'system' && !t.compaction && t.id.startsWith('compact-')) ? i : b),
    -1
  );
  const hasNewToCompact = session.turns.slice(compactBoundary + 1).some((t) => t.role === 'agent');
  const turnBusy = session.state === 'working' || Boolean(session.pendingPermission || session.pendingElicitation);
  const canCompact = hasNewToCompact && !turnBusy;
  const compactBlockedReason = compacting
    ? 'Already compacting'
    : turnBusy
      ? 'Compaction can run once this turn finishes'
      : !hasNewToCompact
        ? compactBoundary >= 0
          ? 'Nothing new since the last compaction'
          : 'Nothing to compact yet'
        : undefined;
  const handleCompactSession = async () => {
    if (compacting || !canCompact) return;
    const stopped = session.isAgentRunning === false;
    if (
      stopped &&
      !confirm(
        'The agent is stopped. Compacting starts it and resends up to 20 recent turns so it can write the summary, which costs tokens.\n\nCompact anyway?'
      )
    ) {
      return;
    }
    setRequestingCompaction(true);
    try {
      await api.compactSession(session.id, { force: stopped });
      onRefresh();
    } catch (err: any) {
      alert(`Could not compact: ${err.message}`);
    } finally {
      setRequestingCompaction(false);
    }
  };

  const handleCancelPrompt = async (source: 'stop' | 'end turn' = 'stop') => {
    // The turn may only be open because it waits on subagents, which the agent stops along with it
    const subagents = runningSubagents(session);
    if (subagents.length > 0) {
      const names = subagents.map((t) => `• ${t.title}`).join('\n');
      const what = source === 'end turn' ? 'Ending the turn' : 'Stopping the turn';
      const count = subagents.length === 1 ? 'the subagent' : `the ${subagents.length} subagents`;
      if (!confirm(`${what} also stops ${count} still running:\n\n${names}\n\nTheir unfinished work is lost. Stop anyway?`)) return;
    }
    try {
      await api.cancelPrompt(session.id, source);
      onRefresh();
    } catch (err: any) {
      alert(`Error cancelling prompt: ${err.message}`);
    }
  };

  const handleStopAgent = async () => {
    try {
      await api.stopSessionAgent(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Error stopping agent: ${err.message}`);
    }
  };

  const handleStartAgent = async () => {
    try {
      await api.startSessionAgent(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Error starting agent: ${err.message}`);
    }
  };

  const handleRestore = async () => {
    if (restoreBusy) return;
    setRestoreBusy(true);
    try {
      await api.restoreSession(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Error restoring agent: ${err.message}`);
      onRefresh();
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleResolvePermission = async (optionId: string) => {
    try {
      await api.resolvePermission(session.id, optionId);
      onRefresh();
    } catch (err: any) {
      alert(`Error resolving permission: ${err.message}`);
    }
  };

  const handleApproveAndAutoApprove = async () => {
    await api.updateAnnotations(session.id, { autoApprove: true });
    const allowOpt = session.pendingPermission?.options.find(
      (o) => !o.optionId.includes('deny') && !o.optionId.includes('reject')
    );
    await handleResolvePermission(allowOpt?.optionId || 'allow');
  };

  const updateAnnotations = async (patch: Parameters<typeof api.updateAnnotations>[1]) => {
    try {
      await api.updateAnnotations(session.id, patch);
      onRefresh();
    } catch (err: any) {
      alert(`Could not update session: ${err.message}`);
    }
  };

  const handleTogglePriority = () => updateAnnotations({ priority: nextPriority(session.user.priority) });
  const handleTogglePin = () => updateAnnotations({ pinned: !session.user.pinned });
  const handleToggleCleanup = () => updateAnnotations({ cleanup: !session.user.cleanup });
  const isSnoozed = Boolean(session.user.snoozedUntil && session.user.snoozedUntil > Date.now());
  // Snoozing drops the session to the bottom of the ranking; the server wakes it
  // automatically when the time is up.
  const handleToggleSnooze = () => (isSnoozed ? updateAnnotations({ snoozedUntil: null }) : setShowSnooze(true));
  const handleToggleAutoApprove = () => updateAnnotations({ autoApprove: !session.user.autoApprove });

  const handleRename = async (next: string): Promise<boolean> => {
    try {
      await api.renameSession(session.id, next);
      onRefresh();
      return true;
    } catch (err: any) {
      alert(`Could not rename session: ${err.message}`);
      return false;
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete session "${session.title}"? This stops its agent and removes its history.`)) return;
    try {
      await api.deleteSession(session.id);
      onDeleted?.(session.id);
    } catch (err: any) {
      alert(`Could not delete session: ${err.message}`);
    }
  };

  const handleRollback = async (turnId?: string, action: RollbackAction = 'revert_to_this') => {
    if (rollingBack) return;
    // Every rewind stops the agent: its own transcript cannot be cut back, so the next message starts a new agent session with a summary
    const what =
      action === 'undo_last'
        ? 'Undo the last message in this conversation?'
        : action === 'revert_to_this'
          ? 'Rewind the conversation to this point? All later messages will be undone.'
          : 'Remove this message and everything after it?';
    const running = session.state === 'working' || session.agentTasks?.some((t) => t.status === 'running') ? ' Anything the agent is running now, including background work, will be stopped.' : '';
    if (!confirm(`${what}\n\nThis also ends the current agent session. Your next message starts a new one that only gets a summary of the conversation, not the agent's own memory.${running}`)) return;

    setRollingBack(true);
    try {
      const res = await api.rollbackSession(session.id, { turnId, action });
      if (res.restoredPrompt) {
        setPromptText(res.restoredPrompt);
        setTimeout(() => promptInputRef.current?.focus(), 50);
      }
      onRefresh();
    } catch (err: any) {
      alert(`Failed to undo: ${err.message}`);
    } finally {
      setRollingBack(false);
    }
  };

  /** Commands the terminal runs itself instead of sending to the agent. */
  const runLocalCommand = async (command: string): Promise<boolean> => {
    switch (command) {
      case '/compact':
        // Handled here either way, so it never goes to the agent; when it cannot run, say why and keep the text
        if (compactBlockedReason) {
          alert(`Could not compact: ${compactBlockedReason}`);
          return true;
        }
        setPromptText('');
        await handleCompactSession();
        return true;
      case '/undo':
        setPromptText('');
        await handleRollback(undefined, 'undo_last');
        return true;
      case '/stop':
        setPromptText('');
        await handleStopAgent();
        return true;
      case '/auto':
      case '/approval':
        setPromptText('');
        await handleToggleAutoApprove();
        return true;
      case '/switch':
        setPromptText('');
        onOpenSwitchModal();
        return true;
      case '/model':
        setPromptText('');
        setShowModelPicker(true);
        return true;
      case '/mcp':
        if (!onOpenMcp) return false;
        setPromptText('');
        onOpenMcp();
        return true;
      case '/stats':
        if (!onOpenSubscriptionsModal) return false;
        setPromptText('');
        onOpenSubscriptionsModal();
        return true;
      default:
        return false;
    }
  };

  // ---------------------------------------------------------------- Usage
  const { pricing, contextTokens, estimatedCost } = usageMetrics(session);

  const currentModelMeta = getModelMeta(session.model || 'sonnet');
  const activeEffort = session.effort || 'auto';
  const efforts = sessionEffortChoices(session, agents);
  const modelName = advertisedModelLabel(session) || currentModelMeta.label || session.model || session.agentName;

  const menuItems: Array<MenuItem | 'divider'> = [
    {
      label: 'Undo last turn',
      icon: 'undo',
      onSelect: () => handleRollback(undefined, 'undo_last'),
      disabled: session.turns.length === 0 || rollingBack,
    },
    {
      label: compacting ? 'Compacting…' : 'Compact context',
      icon: 'archive',
      onSelect: handleCompactSession,
      disabled: !canCompact || compacting,
    },
    { label: isSnoozed ? 'Wake session' : 'Snooze…', icon: 'moon', onSelect: handleToggleSnooze },
    {
      label: scheduledResume?.armed ? 'Change resume time…' : session.state === 'working' ? 'Pause and resume later…' : 'Resume later…',
      icon: 'pause',
      onSelect: () => setShowResumeAt(true),
    },
    { label: session.user.tags?.length ? 'Edit tags' : 'Add tags', icon: 'hash', onSelect: () => changeTab('tags') },
    { label: session.user.cleanup ? 'Unmark cleanup' : 'Mark for cleanup', icon: 'check', onSelect: handleToggleCleanup, hint: 'c' },
    'divider',
    { label: 'Delete session', icon: 'trash', onSelect: handleDelete, danger: true },
  ];

  return (
    <div className="main-view ws-root">
      <SessionHeader
        session={session}
        onRename={handleRename}
        onToggleAutoApprove={handleToggleAutoApprove}
        onOpenSwitchModal={onOpenSwitchModal}
        onStopAgent={handleStopAgent}
        onStartAgent={handleStartAgent}
        restorable={restorable}
        restoring={restoreBusy || Boolean(summary?.restoring)}
        onRestore={handleRestore}
        onTogglePriority={handleTogglePriority}
        onTogglePin={handleTogglePin}
        menuItems={menuItems}
        onBackToList={onBackToList}
        totalSessionsCount={totalSessionsCount}
        onOpenMobileActions={() => setShowMobileActions(true)}
        onOpenMcp={onOpenMcp}
      />

      <SessionTabsBar
        activeTab={activeTab}
        onChange={changeTab}
        shellCommandCount={shellCommandCount}
        contextTokens={contextTokens}
        contextWindow={pricing.contextWindow}
        estimatedCost={estimatedCost}
        agentTasks={agentTaskCounts(session)}
        agentSessionCount={session.agentSessions?.length}
        tagCount={session.user.tags?.length}
      />

      <AgentTaskNavContext.Provider value={openAgentTasks}>
      <AgentSessionNavContext.Provider value={openAgentSession}>
      <div className="ws-body">
        {activeTab === 'agentSessions' ? (
          <AgentSessionsPanel session={session} focusedId={focusedAgentSession} busy={turnBusy || compacting} onChanged={onRefresh} />
        ) : activeTab === 'agents' ? (
          <AgentsPanel
            session={session}
            focusedIds={focusedTasks}
            onOpen={(ids) => openAgentTasks(...ids)}
            onBack={() => setFocusedTasks([])}
            onShowSession={() => changeTab('conversation')}
          />
        ) : activeTab === 'conversation' ? (
          <>
            <ActivityStrip session={session} />
            <ConversationView
              session={session}
              onRollback={handleRollback}
              onPreviewImage={setPreviewImage}
              onCancelPrompt={() => handleCancelPrompt('end turn')}
              onInsertPrompt={(text) => {
                setPromptText(text);
                promptInputRef.current?.focus();
              }}
            />
          </>
        ) : activeTab === 'terminal' ? (
          <LiveTerminalPanel session={session} />
        ) : activeTab === 'tags' ? (
          <TagsPanel
            sessionId={session.id}
            tags={session.user.tags || []}
            sessions={allSessions}
            onSave={(tags) => updateAnnotations({ tags })}
            onSelectSession={onSelectSession}
          />
        ) : (
          <UsageTab
            session={session}
            onOpenSubscriptionsModal={onOpenSubscriptionsModal}
            onCompact={handleCompactSession}
            compacting={compacting}
          />
        )}
      </div>
      </AgentSessionNavContext.Provider>
      </AgentTaskNavContext.Provider>

      <Composer
        session={session}
        agents={agents}
        promptText={promptText}
        setPromptText={setPromptText}
        inputRef={promptInputRef}
        showModelPicker={showModelPicker}
        setShowModelPicker={setShowModelPicker}
        runLocalCommand={runLocalCommand}
        onCancelPrompt={() => handleCancelPrompt('stop')}
        onRefresh={onRefresh}
        onOpenSwitchModal={onOpenSwitchModal}
        above={
          // An approval and a form can both be waiting (e.g. from two subagents): the approval shows first
          session.pendingPermission ? (
            <ApprovalBanner
              permission={session.pendingPermission}
              onResolve={handleResolvePermission}
              onApproveAndAutoApprove={handleApproveAndAutoApprove}
            />
          ) : session.pendingElicitation ? (
            <ElicitationCard
              key={session.pendingElicitation.requestId}
              sessionId={session.id}
              elicitation={session.pendingElicitation}
              onAnswered={onRefresh}
            />
          ) : scheduledResume && session.state !== 'working' ? (
            <ResumeBanner key={session.id} sessionId={session.id} resume={scheduledResume} onPickTime={() => setShowResumeAt(true)} />
          ) : (
            restorable &&
            summary && <RestoreSessionBanner key={session.id} summary={summary} queuedCount={session.queuedPrompts?.length ?? 0} />
          )
        }
      />

      {showSnooze && (
        <SnoozeModal snoozedUntil={session.user.snoozedUntil} onSnooze={(until) => updateAnnotations({ snoozedUntil: until })} onClose={() => setShowSnooze(false)} />
      )}

      {showResumeAt && (
        <ResumeAtModal
          sessionId={session.id}
          working={session.state === 'working'}
          current={scheduledResume}
          fiveHourResetsAt={session.agentId === 'claude' ? session.rateLimits?.fiveHour?.resetsAtMs : undefined}
          onClose={() => setShowResumeAt(false)}
        />
      )}

      {showMobileActions && (
        <MobileActionSheet
          session={session}
          modelLabel={`${modelName}${efforts.length > 0 ? `, ${effortLabel(activeEffort, efforts).toLowerCase()} effort` : ''}`}
          isSnoozed={isSnoozed}
          rollingBack={rollingBack}
          compacting={compacting}
          canCompact={canCompact}
          compactBlockedReason={compactBlockedReason}
          onAutoCompactChanged={onRefresh}
          onClose={() => setShowMobileActions(false)}
          onToggleAutoApprove={handleToggleAutoApprove}
          onOpenModelPicker={() => setShowModelPicker(true)}
          onOpenSwitchModal={onOpenSwitchModal}
          onUndoLast={() => handleRollback(undefined, 'undo_last')}
          onCompact={handleCompactSession}
          onTogglePriority={handleTogglePriority}
          onTogglePin={handleTogglePin}
          onToggleCleanup={handleToggleCleanup}
          onToggleSnooze={handleToggleSnooze}
          onResumeLater={() => setShowResumeAt(true)}
          onEditTags={() => changeTab('tags')}
          onOpenSubscriptionsModal={onOpenSubscriptionsModal}
          onOpenMcp={onOpenMcp}
          onStopAgent={handleStopAgent}
          onStartAgent={handleStartAgent}
          onDelete={handleDelete}
        />
      )}

      {previewImage && <ImageLightbox src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
