import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentDescriptor, CodepitAuditEntry, CodepitMcpSettings, CodepitMcpView, SessionSummary } from '../../types';
import { Badge, Button, EmptyState, Icon, Input, SectionHeader, Segmented, Spinner, Switch } from '../../ui';
import { relativeTime } from '../Sidebar';

/**
 * CodePit's own MCP server: lets the agents CodePit runs start, find, tag and link
 * sessions. Its switches, its limits, and the audit log of every call made to it.
 */
export const CodepitServerPanel: React.FC<{
  agents: AgentDescriptor[];
  sessions: SessionSummary[];
  onSelectSession?: (id: string) => void;
}> = ({ agents, sessions, onSelectSession }) => {
  const [view, setView] = useState<CodepitMcpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<CodepitAuditEntry[] | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    api
      .getCodepitMcp()
      .then(setView)
      .catch((err) => setError(err.message));
  }, []);

  const loadAudit = useCallback(() => {
    setAuditBusy(true);
    api
      .getCodepitAudit({ limit: 100 })
      .then((r) => setAudit(r.entries))
      .catch((err) => setError(err.message))
      .finally(() => setAuditBusy(false));
  }, []);
  useEffect(loadAudit, [loadAudit]);

  const save = async (changes: Partial<CodepitMcpSettings>) => {
    setError(null);
    // Shown at once; the saved settings replace it, or a refusal puts the old ones back
    const before = view;
    if (view) setView({ ...view, settings: { ...view.settings, ...changes } });
    try {
      setView(await api.updateCodepitMcp(changes));
    } catch (err: any) {
      setView(before);
      setError(err?.message || 'Could not save');
    }
  };

  if (!view) {
    return error ? (
      <EmptyState icon="alert" title="Couldn't load CodePit's MCP server" description={error} compact />
    ) : (
      <div className="mcp-loading">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  const s = view.settings;
  // Only agents that take an HTTP MCP server can be handed this one
  const httpAgents = agents.filter((a) => a.mcpSupport?.transports.includes('http') && !a.mcpSupport.via);
  const titleOf = (id: string) => sessions.find((x) => x.id === id)?.title;

  return (
    <div className="cpm">
      {error && (
        <div className="mcp-note tone-danger" role="alert">
          <Icon name="alert" size={14} />
          <div>{error}</div>
        </div>
      )}

      <section className="cpm-card">
        <Switch
          checked={s.enabled}
          onChange={(enabled) => save({ enabled })}
          label="Let agents manage sessions"
          description="Gives each new agent session a codepit MCP server: it can start sessions to hand work to, look sessions up by name or agent session id, check on them, and tag and link them. Every call is logged below."
        />
        {s.enabled && !view.reachable && (
          <div className="mcp-note tone-warn">
            <Icon name="alert" size={13} />
            <div>CodePit is not listening on this machine's loopback address, so agents can't reach the server.</div>
          </div>
        )}
        <div className="cpm-hint">Agents pick this up when they next start. Stop and start a running agent to give it the tools now.</div>
      </section>

      <section className="cpm-card" aria-disabled={!s.enabled}>
        <SectionHeader title="Agents" description="Sessions of these agents get the server." />
        <div className="cpm-agents">
          {httpAgents.map((a) => (
            <Switch
              key={a.id}
              checked={s.agents.includes(a.id)}
              onChange={(on) => save({ agents: on ? [...s.agents, a.id] : s.agents.filter((x) => x !== a.id) })}
              label={a.name}
            />
          ))}
        </div>
      </section>

      <section className="cpm-card">
        <SectionHeader title="New sessions an agent starts" />
        <div className="cpm-row">
          <div className="cpm-row-text">
            <div className="cpm-row-label">Start</div>
            <div className="cpm-row-desc">
              {s.startMode === 'ask'
                ? 'Each one waits in the sidebar under Needs you, with its prompt, until you start it.'
                : 'They start at once. An agent can still choose to leave one for you to start.'}
            </div>
          </div>
          <Segmented<'ask' | 'auto'>
            label="When a new session starts"
            size="sm"
            value={s.startMode}
            onChange={(startMode) => save({ startMode })}
            options={[
              { value: 'ask', label: 'Wait for me' },
              { value: 'auto', label: 'At once' },
            ]}
          />
        </div>
        <Switch
          checked={s.inheritTags}
          onChange={(inheritTags) => save({ inheritTags })}
          label="Copy the parent's tags"
          description="The default; the agent can leave them off or add others."
        />
        <Switch
          checked={s.allowMessaging}
          onChange={(allowMessaging) => save({ allowMessaging })}
          label="Let sessions message each other"
          description="Adds send_to_session: an agent can send a prompt into any other session, starting its agent again if it was stopped. Claude's SendMessage only reaches running sessions. Every message is in the event log."
        />
        <div className="cpm-limits">
          <LimitField label="Levels deep" hint="Sessions starting sessions" value={s.maxDepth} min={1} max={10} onSave={(maxDepth) => save({ maxDepth })} />
          <LimitField label="Per session" hint="Sessions one session may start" value={s.maxChildren} min={1} max={100} onSave={(maxChildren) => save({ maxChildren })} />
        </div>
      </section>

      <section className="cpm-card">
        <SectionHeader
          title="Tools"
          actions={
            <button type="button" className="mcp-linkbtn" onClick={() => setShowTools(!showTools)} aria-expanded={showTools}>
              {showTools ? 'Hide' : `Show ${view.tools.length}`}
            </button>
          }
        />
        {showTools && (
          <ul className="mcp-tools cpm-tools">
            {view.tools.map((t) => (
              <li key={t.name} title={t.description}>
                <code>{t.name}</code>
                <span className="mcp-tools-desc">{t.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cpm-card">
        <SectionHeader
          title="Audit log"
          description={<span className="mono cpm-path">{view.auditLog}</span>}
          actions={
            <Button size="sm" variant="ghost" icon="refresh" onClick={loadAudit} loading={auditBusy}>
              Refresh
            </Button>
          }
        />
        {!audit ? (
          <div className="mcp-loading">
            <Spinner size={14} /> Loading…
          </div>
        ) : audit.length === 0 ? (
          <p className="cpm-hint">No calls yet.</p>
        ) : (
          <ul className="cpm-audit">
            {audit.map((e, i) => (
              <li key={`${e.at}-${i}`} className={`cpm-audit-row ${e.ok ? '' : 'is-refused'}`}>
                <span className="cpm-audit-time" title={new Date(e.at).toLocaleString()}>
                  {relativeTime(Date.parse(e.at))}
                </span>
                <span className="cpm-audit-main">
                  <span className="cpm-audit-top">
                    <code>{e.tool ?? e.method}</code>
                    {!e.ok && <Badge tone="danger">Refused</Badge>}
                    {e.caller ? (
                      <button type="button" className="mcp-linkbtn" onClick={() => onSelectSession?.(e.caller!.sessionId)} disabled={!titleOf(e.caller.sessionId)}>
                        {titleOf(e.caller.sessionId) ?? e.caller.title ?? e.caller.sessionId}
                      </button>
                    ) : (
                      <span className="cpm-hint">no valid session token</span>
                    )}
                  </span>
                  {e.error && <span className="cpm-audit-error">{e.error}</span>}
                  {e.ok && e.sessions && e.sessions.some((id) => id !== e.caller?.sessionId) && (
                    <span className="cpm-audit-sessions">
                      →{' '}
                      {e.sessions
                        .filter((id) => id !== e.caller?.sessionId)
                        .map((id) => (
                          <button key={id} type="button" className="mcp-linkbtn" onClick={() => onSelectSession?.(id)} disabled={!titleOf(id)}>
                            {titleOf(id) ?? `${id} (deleted)`}
                          </button>
                        ))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

const LimitField: React.FC<{ label: string; hint: string; value: number; min: number; max: number; onSave: (v: number) => void }> = ({
  label,
  hint,
  value,
  min,
  max,
  onSave,
}) => {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= min && n <= max) {
      if (n !== value) onSave(n);
    } else setText(String(value));
  };
  return (
    <label className="cpm-limit">
      <span className="cpm-row-label">{label}</span>
      <span className="cpm-row-desc">{hint}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
};
