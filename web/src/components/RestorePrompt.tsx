import React, { useState } from 'react';
import type { SessionSummary } from '../types';
import { api } from '../api';
import { Button, Icon, Spinner } from '../ui';

// Agents that were running when CodePit last closed (quit, crash or update) are offered
// back here. Nothing restarts on its own: a click starts the agent, continuing its agent
// session where it can, and asks it to carry on with any work the close cut short.

/** The session's agent was running when CodePit closed and can be started again. */
export const isRestorable = (s: SessionSummary) => Boolean(s.restore) && !s.user.cleanup && s.isAgentRunning !== true;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sidebar strip: restore or dismiss every agent that was running, whatever tab or filter is on. */
export const RestoreAllBar: React.FC<{ sessions: SessionSummary[] }> = ({ sessions }) => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const restorable = sessions.filter(isRestorable);
  const n = restorable.length;
  if (n === 0 && !result) return null;

  const restoreAll = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { failed } = await api.restoreAllSessions();
      if (failed.length > 0) {
        const list = failed.map((f) => `${f.title} (${f.error})`).join(', ');
        setResult(`${failed.length} could not start: ${list}`);
      }
    } catch (err: any) {
      setResult(`Could not restore: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const dismissAll = async () => {
    if (n > 1 && !confirm(`Stop offering these ${n} agents back? Their conversations stay; a message starts any of them again.`)) return;
    setBusy(true);
    setResult(null);
    try {
      await api.dismissAllRestores();
    } catch (err: any) {
      setResult(`Could not dismiss: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-restore" aria-label="Restore agents">
      {n > 0 && (
        <div className="sb-restore-row">
          <span className="sb-restore-text">
            {busy ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
            <span>{plural(n, 'agent was', 'agents were')} running when CodePit closed</span>
          </span>
          <span className="sb-restore-actions">
            <Button size="sm" variant="primary" icon="play" disabled={busy} onClick={restoreAll}>
              Restore all ({n})
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={dismissAll}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
      {result && (
        <div className="sb-restore-result" role="status">
          <span>{result}</span>
          <button type="button" className="sb-restore-close" aria-label="Hide" onClick={() => setResult(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
    </div>
  );
};

/** The card above the composer of a session whose agent was running when CodePit closed. */
export const RestoreSessionBanner: React.FC<{ summary: SessionSummary; queuedCount: number }> = ({ summary, queuedCount }) => {
  const [busy, setBusy] = useState<'restore' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offer = summary.restore;
  if (!offer) return null;
  const restoring = Boolean(summary.restoring) || busy === 'restore';

  const run = async (key: 'restore' | 'dismiss', fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  // A failed start the server kept with the offer; one from this click shows once
  const shownError = error || offer.error;
  const background = offer.backgroundInterrupted ?? 0;
  const interrupted = [
    offer.turnInterrupted ? 'in the middle of a turn' : '',
    background > 0 ? `with ${plural(background, 'subagent or background task', 'subagents or background tasks')} running` : '',
  ].filter(Boolean).join(' and ');
  return (
    <section className="ws-approval ws-restore" role="region" aria-label="Restore agent">
      <span className="ws-approval-icon" aria-hidden>
        <Icon name="refresh" size={16} />
      </span>
      <div className="ws-approval-body">
        <div className="ws-approval-kicker">Agent was running</div>
        <div className="ws-restore-text">
          The agent was running when CodePit closed{interrupted ? `, ${interrupted}` : ''}. Restore starts it again and{' '}
          {offer.continues ? 'continues the same agent session' : 'starts a new agent session with a summary of this conversation'}.{' '}
          {interrupted
            ? `It is then asked to continue from where it stopped${queuedCount > 0 ? `, and ${plural(queuedCount, 'queued message goes', 'queued messages go')} after that` : ''}.`
            : `Nothing is sent${queuedCount > 0 ? `, and ${plural(queuedCount, 'queued message stays', 'queued messages stay')} paused` : ''}.`}
        </div>
        {shownError && <div className="ws-restore-error">Could not start: {shownError}</div>}
      </div>
      <div className="ws-approval-actions">
        <span className="ws-approval-main">
          <Button
            variant="ghost"
            size="sm"
            disabled={restoring || busy !== null}
            loading={busy === 'dismiss'}
            onClick={() => run('dismiss', () => api.dismissRestore(summary.id))}
            title="Stop offering it; a message still starts the agent"
          >
            Dismiss
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="play"
            loading={restoring}
            disabled={busy !== null}
            onClick={() => run('restore', () => api.restoreSession(summary.id))}
          >
            Restore
          </Button>
        </span>
      </div>
    </section>
  );
};
