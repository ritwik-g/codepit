import React, { useState } from 'react';
import { api } from '../api';
import type { AcpSession, SessionSummary } from '../types';
import { Button, Icon, Textarea } from '../ui';

/**
 * A session another session asked for, waiting for the user: its prompt, which can be
 * edited first, and Start or Discard.
 */
export const PendingStartCard: React.FC<{
  session: AcpSession;
  requestedBy?: SessionSummary;
  onSelectSession?: (id: string) => void;
  onStarted: () => void;
  onDiscarded: () => void;
}> = ({ session, requestedBy, onSelectSession, onStarted, onDiscarded }) => {
  const pending = session.pendingStart!;
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(pending.prompt);
  const [busy, setBusy] = useState<'start' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: 'start' | 'discard', fn: () => Promise<unknown>, done: () => void) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      done();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ws-approval ws-restore ws-pending-start" role="region" aria-label="Session waiting to start">
      <span className="ws-approval-icon" aria-hidden>
        <Icon name="play" size={16} />
      </span>
      <div className="ws-approval-body">
        <div className="ws-approval-kicker">Waiting for you to start it</div>
        <div className="ws-restore-text">
          {requestedBy ? (
            <button type="button" className="mcp-linkbtn" onClick={() => onSelectSession?.(requestedBy.id)}>
              {requestedBy.title}
            </button>
          ) : (
            'Another session'
          )}{' '}
          asked for this session. Start runs {session.agentName} in {session.cwd} with this prompt.
        </div>
        {editing ? (
          <Textarea className="ws-pending-prompt" value={prompt} rows={8} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt to start with" />
        ) : (
          <pre className="ws-pending-prompt is-preview">{prompt}</pre>
        )}
        {error && <div className="ws-restore-error">{error}</div>}
      </div>
      <div className="ws-approval-actions">
        <span className="ws-approval-main">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            loading={busy === 'discard'}
            onClick={() => {
              if (!confirm(`Discard "${session.title}"? It is deleted without running.`)) return;
              run('discard', () => api.discardPendingSession(session.id), onDiscarded);
            }}
          >
            Discard
          </Button>
          {!editing && (
            <Button variant="ghost" size="sm" icon="edit" disabled={busy !== null} onClick={() => setEditing(true)}>
              Edit prompt
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="play"
            loading={busy === 'start'}
            disabled={busy !== null || !prompt.trim()}
            onClick={() => run('start', () => api.startPendingSession(session.id, prompt === pending.prompt ? undefined : prompt), onStarted)}
          >
            Start
          </Button>
        </span>
      </div>
    </section>
  );
};
