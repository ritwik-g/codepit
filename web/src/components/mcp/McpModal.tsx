import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { SessionSummary } from '../../types';
import type { AgentDescriptor, AgySyncEntry, AgySyncStatus, EcosystemReport, McpPreset, McpProbeResult, McpServer, McpServerInput } from '../../types';
import { Badge, Button, EmptyState, Icon, Segmented, Spinner, Switch, Tabs, type IconName } from '../../ui';
import { Modal } from '../Modal';
import { Menu } from '../Menu';
import { AgentFitBadges, McpServerForm, TRANSPORT_LABEL, agentFit } from './McpServerForm';
import { McpCatalog } from './McpCatalog';
import { McpEcosystems } from './McpEcosystems';
import { MemoryGraphView } from './MemoryGraphView';
import { CodepitServerPanel } from './CodepitServerPanel';
import '../../styles/mcp.css';

export type McpTab = 'installed' | 'add' | 'codepit' | 'plugins';

const TAB_LABEL: Record<McpTab, string> = {
  installed: 'Installed',
  add: 'Add a server',
  codepit: 'CodePit server',
  plugins: 'Agent plugins and skills',
};

type Probe = { running: boolean; result?: McpProbeResult; cwd?: string };
/** A sign-in waiting on the browser: the page it was sent to, to open again if the first didn't. */
type SignIn = { starting: boolean; authorizeUrl?: string };

const SIGN_IN_POLL_MS = 2000;
// The callback forgets a sign-in after ten minutes, so stop looking then
const SIGN_IN_WAIT_MS = 10 * 60_000;

/** The line under a server's name: its command line or URL. */
const target = (s: McpServer) => (s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url ?? '');

const PRESET_ICON: Record<string, IconName> = {
  filesystem: 'folder',
  github: 'branch',
  memory: 'brain',
  'brave-search': 'globe',
  sqlite: 'database',
  postgres: 'database',
};

const ProbeStatus: React.FC<{ probe?: Probe }> = ({ probe }) => {
  const [showTools, setShowTools] = useState(false);
  if (!probe) return null;
  if (probe.running) {
    return (
      <div className="mcp-probe" role="status">
        <Spinner size={11} /> Connecting… the first run of npx or uvx can take a minute while it downloads.
      </div>
    );
  }
  const r = probe.result!;
  if (!r.ok) {
    return (
      <div className="mcp-probe tone-danger" role="status">
        <Icon name="xCircle" size={13} />
        <pre className="mcp-probe-error">{r.error}</pre>
      </div>
    );
  }
  const tools = r.tools ?? [];
  return (
    <div className="mcp-probe tone-ok">
      <Icon name="checkCircle" size={13} />
      <span role="status">
        Connected{r.server?.name ? ` to ${r.server.name}${r.server.version ? ` ${r.server.version}` : ''}` : ''} in{' '}
        {(r.durationMs / 1000).toFixed(1)}s.{' '}
        <button type="button" className="mcp-linkbtn" onClick={() => setShowTools(!showTools)} aria-expanded={showTools}>
          {tools.length} tool{tools.length === 1 ? '' : 's'}
        </button>
        {r.error && <span className="mcp-probe-warn"> {r.error}</span>}
      </span>
      {showTools && tools.length > 0 && (
        <ul className="mcp-tools">
          {tools.map((t) => (
            <li key={t.name} title={t.description}>
              <code>{t.name}</code>
              {t.description && <span className="mcp-tools-desc">{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ServerRow: React.FC<{
  server: McpServer;
  agents: AgentDescriptor[];
  probe?: Probe;
  /** Agents that already configure an MCP server with this name themselves. */
  clashes: string[];
  /** Where this server stands in agy's settings, when it is meant for Antigravity. */
  agy?: AgySyncEntry | { state: 'error'; reason: string };
  signIn?: SignIn;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
  /** Set for memory servers: opens their knowledge graph. */
  onViewGraph?: () => void;
}> = ({ server, agents, probe, clashes, agy, signIn, onToggle, onTest, onEdit, onDelete, onSignIn, onCancelSignIn, onSignOut, onViewGraph }) => {
  const fits = agentFit(server, agents);
  // Sign-in is for Streamable HTTP servers; offered up front once a test is turned down or a sign-in lapses
  const canSignIn = server.transport === 'http';
  const signedIn = Boolean(server.oauth?.signedIn);
  const offerSignIn = canSignIn && !signedIn && !signIn && (server.oauth?.expired || (probe?.result && !probe.result.ok && probe.result.authRequired));
  return (
    <li className={`mcp-server ${server.enabled ? '' : 'is-off'}`}>
      <span className="mcp-server-icon" aria-hidden>
        <Icon name={PRESET_ICON[server.presetId ?? ''] ?? (server.transport === 'stdio' ? 'terminal' : 'globe')} size={16} />
      </span>
      <div className="mcp-server-main">
        <div className="mcp-server-top">
          <span className="mcp-server-name mono">{server.name}</span>
          <Badge mono>{TRANSPORT_LABEL[server.transport]}</Badge>
          {!server.enabled && <Badge>Off</Badge>}
          {signedIn && (
            <Badge tone="ok" icon="lock" title={`Signed in with ${server.oauth!.issuer}`}>
              Signed in
            </Badge>
          )}
          {server.oauth?.expired && (
            <Badge tone="warn" icon="unlock">
              Sign-in expired
            </Badge>
          )}
        </div>
        <div className="mcp-server-target mono" title={target(server)}>
          {target(server)}
        </div>
        <div className="mcp-server-fit">
          <AgentFitBadges fits={fits} />
        </div>
        {agy && agy.state !== 'synced' && (
          <div className="mcp-note tone-warn">
            <Icon name="alert" size={13} />
            <div>
              Not in Antigravity's settings. {agy.reason}
            </div>
          </div>
        )}
        {clashes.length > 0 && (
          <div className="mcp-note tone-warn">
            <Icon name="alert" size={13} />
            <div>
              {clashes.join(' and ')} already {clashes.length === 1 ? 'has' : 'have'} its own MCP server called <code>{server.name}</code>, so
              the tool names would collide. Rename this one, for example to <code>{server.name}-2</code>.
            </div>
          </div>
        )}
        {signIn && (
          <div className="mcp-note" role="status">
            <Spinner size={11} />
            <div>
              {signIn.starting ? (
                'Finding where to sign in…'
              ) : (
                <>
                  Finish signing in in your browser.{' '}
                  <a className="mcp-linkbtn" href={signIn.authorizeUrl} target="_blank" rel="noreferrer">
                    Open the sign-in page again
                  </a>{' '}
                  ·{' '}
                  <button type="button" className="mcp-linkbtn" onClick={onCancelSignIn}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {/* The last test's 401 is what the sign-in is fixing, so it steps aside meanwhile */}
        {!signIn && <ProbeStatus probe={probe} />}
      </div>
      <div className="mcp-server-actions">
        <Switch checked={server.enabled} onChange={onToggle} label={<span className="sr-only">Use {server.name}</span>} />
        {onViewGraph && (
          <Button size="sm" variant="ghost" icon="branch" onClick={onViewGraph}>
            Graph
          </Button>
        )}
        {offerSignIn ? (
          <Button size="sm" variant="primary" icon="key" onClick={onSignIn}>
            Sign in
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="zap" onClick={onTest} loading={probe?.running}>
            Test
          </Button>
        )}
        <Menu
          label={`More actions for ${server.name}`}
          size="sm"
          items={[
            { label: 'Edit', icon: 'edit', onSelect: onEdit },
            { label: 'Test connection', icon: 'zap', onSelect: onTest, disabled: probe?.running },
            ...(canSignIn
              ? [
                  signedIn
                    ? { label: 'Sign out', icon: 'logout' as IconName, onSelect: onSignOut }
                    : { label: server.oauth?.expired ? 'Sign in again' : 'Sign in with OAuth', icon: 'key' as IconName, onSelect: onSignIn, disabled: Boolean(signIn) },
                ]
              : []),
            ...(onViewGraph ? [{ label: 'View graph', icon: 'branch' as IconName, onSelect: onViewGraph }] : []),
            'divider',
            { label: 'Remove', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </div>
    </li>
  );
};

export const McpModal: React.FC<{
  agents: AgentDescriptor[];
  /** Folder the Test button uses for ${workspace}: the open session's, if any. */
  workspace?: string;
  initialTab?: McpTab;
  /** For the CodePit server's audit log: session titles, and opening one. */
  sessions?: SessionSummary[];
  onSelectSession?: (id: string) => void;
  onClose: () => void;
  /** Called whenever the saved server list changes, so the sidebar count stays right. */
  onServersChange: (servers: McpServer[]) => void;
}> = ({ agents, workspace, initialTab = 'installed', sessions = [], onSelectSession, onClose, onServersChange }) => {
  const [tab, setTab] = useState<McpTab>(initialTab);
  const [addMode, setAddMode] = useState<'catalog' | 'custom'>('catalog');
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [agyStatus, setAgyStatus] = useState<AgySyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presets, setPresets] = useState<McpPreset[] | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [ecosystems, setEcosystems] = useState<EcosystemReport[] | null>(null);
  const [ecoError, setEcoError] = useState<string | null>(null);
  const [ecoRefreshing, setEcoRefreshing] = useState(false);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [signIns, setSignIns] = useState<Record<string, SignIn>>({});
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServer | null>(null);
  const [graphOf, setGraphOf] = useState<McpServer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Every change derives from the latest list, so overlapping requests can't undo each other
  const update = (fn: (prev: McpServer[]) => McpServer[]) => setServers((prev) => fn(prev ?? []));
  const replace = (server: McpServer) => update((prev) => prev.map((x) => (x.id === server.id ? server : x)));

  const reportServers = useRef(onServersChange);
  reportServers.current = onServersChange;
  useEffect(() => {
    if (servers) reportServers.current(servers);
  }, [servers]);

  // The server syncs agy's settings after every change; read back where each server landed
  const listLoaded = useRef(false);
  useEffect(() => {
    if (!servers) return;
    if (!listLoaded.current) {
      listLoaded.current = true;
      return;
    }
    api
      .getMcpServers()
      .then((r) => setAgyStatus(r.agy ?? null))
      .catch(() => {});
  }, [servers]);

  useEffect(() => {
    api
      .getMcpServers()
      .then((r) => {
        setServers(r.servers);
        setAgyStatus(r.agy ?? null);
      })
      .catch((err) => setLoadError(err.message));
    api
      .getMcpPresets()
      .then((r) => setPresets(r.presets))
      .catch((err) => setPresetError(err.message));
  }, []);

  const loadEcosystems = useCallback((refresh: boolean) => {
    setEcoRefreshing(true);
    setEcoError(null);
    api
      .getEcosystems(refresh)
      .then((r) => setEcosystems(r.ecosystems))
      .catch((err) => setEcoError(err.message))
      .finally(() => setEcoRefreshing(false));
  }, []);

  // Loaded up front too: the Installed tab uses it to spot name clashes with the agents' own servers
  useEffect(() => {
    loadEcosystems(false);
  }, [loadEcosystems]);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  };

  const run = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err: any) {
      setActionError(err?.message || 'Something went wrong');
    }
  };

  /** Where a server meant for Antigravity stands in agy's settings; nothing for the others. */
  const agyFor = (s: McpServer): AgySyncEntry | { state: 'error'; reason: string } | undefined => {
    if (!agyStatus?.available || !s.enabled || !agentFit(s, agents).some((f) => f.agent.id === 'antigravity')) return undefined;
    if (agyStatus.error) return { state: 'error', reason: agyStatus.error };
    return agyStatus.entries.find((e) => e.serverId === s.id);
  };

  // Latest test run per server; an edit or removal bumps it so an older answer is dropped
  const probeRuns = useRef<Record<string, number>>({});
  const forgetProbe = (id: string) => {
    probeRuns.current[id] = (probeRuns.current[id] ?? 0) + 1;
    setProbes(({ [id]: _drop, ...rest }) => rest);
  };

  const test = (s: McpServer) => {
    const runId = (probeRuns.current[s.id] ?? 0) + 1;
    probeRuns.current[s.id] = runId;
    const settle = (probe: Probe) => {
      if (probeRuns.current[s.id] === runId) setProbes((p) => ({ ...p, [s.id]: probe }));
    };
    setProbes((p) => ({ ...p, [s.id]: { running: true } }));
    api
      .testMcpServer(s.id, workspace)
      .then((r) => settle({ running: false, result: r.result, cwd: r.cwd }))
      .catch((err) => settle({ running: false, result: { ok: false, error: err.message, durationMs: 0 } }));
  };

  // One poll per sign-in waiting on the browser; cancelling or closing the dialog stops it
  const signInPolls = useRef<Record<string, number>>({});
  const stopSignIn = (id: string) => {
    window.clearInterval(signInPolls.current[id]);
    delete signInPolls.current[id];
    setSignIns(({ [id]: _drop, ...rest }) => rest);
  };
  useEffect(() => () => Object.values(signInPolls.current).forEach((t) => window.clearInterval(t)), []);

  const signIn = (s: McpServer) => {
    if (signInPolls.current[s.id]) return;
    // Opened now, while the click still counts as a user gesture, so a browser doesn't block it.
    // The desktop app hands pages to the system browser and gives back no window.
    const popup = window.open('', '_blank');
    setSignIns((p) => ({ ...p, [s.id]: { starting: true } }));
    setActionError(null);
    const before = s.oauth?.signedInAt ?? 0;
    const startedAt = Date.now();
    signInPolls.current[s.id] = window.setInterval(() => {
      if (Date.now() - startedAt > SIGN_IN_WAIT_MS) {
        stopSignIn(s.id);
        setActionError(`The sign-in to ${s.name} ran out of time. Try again.`);
        return;
      }
      api
        .getMcpServers()
        .then((r) => {
          const next = r.servers.find((x) => x.id === s.id);
          if (!next?.oauth?.signedIn || (next.oauth.signedInAt ?? 0) <= before || !signInPolls.current[s.id]) return;
          stopSignIn(s.id);
          replace(next);
          setAgyStatus(r.agy ?? null);
          flash(`Signed in to ${s.name}. New agent sessions get it from now on.`);
          test(next);
        })
        .catch(() => {});
    }, SIGN_IN_POLL_MS);
    api
      .startMcpSignIn(s.id)
      .then(({ authorizeUrl }) => {
        if (!signInPolls.current[s.id]) return popup?.close();
        setSignIns((p) => ({ ...p, [s.id]: { starting: false, authorizeUrl } }));
        if (popup && !popup.closed) popup.location.href = authorizeUrl;
        else window.open(authorizeUrl, '_blank', 'noopener');
      })
      .catch((err) => {
        popup?.close();
        stopSignIn(s.id);
        setActionError(`Couldn't sign in to ${s.name}: ${err.message}`);
      });
  };

  const signOut = (s: McpServer) =>
    run(async () => {
      const r = await api.signOutMcpServer(s.id);
      replace(r.server);
      forgetProbe(s.id);
      flash(`Signed out of ${s.name}.`);
    });

  const added = (server: McpServer) => {
    update((prev) => [...prev, server]);
    setTab('installed');
    flash(`Added ${server.name}. New agent sessions get it from now on.`);
    test(server);
  };

  const list = servers ?? [];
  const activeCount = list.filter((s) => s.enabled).length;

  return (
    <Modal
      onClose={onClose}
      size="lg"
      className="mcp-dialog"
      bodyClassName="mcp-shell"
      icon="plug"
      heading="MCP and plugins"
      description="Tools your agents can use. Servers added here are given to every new session of the agents they're set for."
      footerStart={
        <span className={`mcp-foot ${notice ? '' : 'is-hint'}`} role="status">
          {notice ? (
            <>
              <Icon name="checkCircle" size={13} /> {notice}
            </>
          ) : (
            'Changes apply when an agent starts. Stop and start a running agent to pick them up.'
          )}
        </span>
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Tabs<McpTab>
        className="mcp-tabs"
        label="MCP and plugins"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'installed', label: TAB_LABEL.installed, icon: 'plug', count: list.length },
          { id: 'add', label: TAB_LABEL.add, icon: 'plus' },
          { id: 'codepit', label: TAB_LABEL.codepit, icon: 'layers' },
          { id: 'plugins', label: TAB_LABEL.plugins, icon: 'package' },
        ]}
      />

      <div className="mcp-body" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {actionError && (
          <div className="mcp-note tone-danger" role="alert">
            <Icon name="alert" size={14} />
            <div>{actionError}</div>
          </div>
        )}

        {tab === 'installed' &&
          (loadError ? (
            <EmptyState icon="alert" title="Couldn't load your MCP servers" description={loadError} compact />
          ) : !servers ? (
            <div className="mcp-loading">
              <Spinner size={14} /> Loading…
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon="plug"
              title="No MCP servers yet"
              description="Add one from the catalog, like Filesystem or GitHub, or connect your own."
              action={
                <Button variant="primary" icon="plus" onClick={() => setTab('add')}>
                  Add a server
                </Button>
              }
            />
          ) : (
            <>
              <div className="mcp-summary">
                <span>
                  <strong>{activeCount}</strong> of {list.length} on
                </span>
                <Button size="sm" variant="secondary" icon="plus" onClick={() => setTab('add')}>
                  Add a server
                </Button>
              </div>
              <ul className="mcp-servers">
                {list.map((s) => (
                  <ServerRow
                    key={s.id}
                    server={s}
                    agents={agents}
                    probe={probes[s.id]}
                    clashes={(ecosystems ?? [])
                      .filter((e) => agentFit(s, agents).some((f) => f.ok && f.agent.id === e.agentId))
                      .filter((e) => e.mcpServers.some((m) => m.name.toLowerCase() === s.name.toLowerCase()))
                      .map((e) => e.name)}
                    onToggle={(enabled) =>
                      run(async () => {
                        const r = await api.setMcpServerEnabled(s.id, enabled);
                        replace(r.server);
                      })
                    }
                    agy={agyFor(s)}
                    signIn={signIns[s.id]}
                    onSignIn={() => signIn(s)}
                    onCancelSignIn={() => stopSignIn(s.id)}
                    onSignOut={() => signOut(s)}
                    onTest={() => test(s)}
                    onEdit={() => setEditing(s)}
                    onDelete={() => setConfirmDelete(s)}
                    onViewGraph={s.memoryGraph ? () => setGraphOf(s) : undefined}
                  />
                ))}
              </ul>
            </>
          ))}

        {tab === 'add' && (
          <>
            <Segmented<'catalog' | 'custom'>
              label="How to add"
              value={addMode}
              onChange={setAddMode}
              options={[
                { value: 'catalog', label: 'Catalog', icon: 'grid' },
                { value: 'custom', label: 'Custom server', icon: 'settings' },
              ]}
            />
            {addMode === 'catalog' ? (
              <McpCatalog
                presets={presets}
                error={presetError}
                servers={list}
                agents={agents}
                onManage={() => setTab('installed')}
                onAdd={async (preset, inputs, scope) => added((await api.addMcpPreset(preset.id, inputs, scope)).server)}
              />
            ) : (
              <McpServerForm
                agents={agents}
                submitLabel="Add server"
                onSubmit={async (data: McpServerInput) => added((await api.createMcpServer(data)).server)}
              />
            )}
          </>
        )}

        {tab === 'codepit' && <CodepitServerPanel agents={agents} sessions={sessions} onSelectSession={onSelectSession} />}

        {tab === 'plugins' && (
          <McpEcosystems ecosystems={ecosystems} error={ecoError} refreshing={ecoRefreshing} onRefresh={() => loadEcosystems(true)} />
        )}
      </div>

      {editing && (
        <Modal nested onClose={() => setEditing(null)} size="md" icon="edit" heading={`Edit ${editing.name}`}>
          <McpServerForm
            agents={agents}
            initial={editing}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (data) => {
              const r = await api.updateMcpServer(editing.id, data);
              replace(r.server);
              forgetProbe(editing.id);
              setEditing(null);
              flash(`Saved ${r.server.name}.`);
            }}
          />
        </Modal>
      )}

      {graphOf && <MemoryGraphView server={graphOf} onClose={() => setGraphOf(null)} />}

      {confirmDelete && (
        <Modal
          nested
          onClose={() => setConfirmDelete(null)}
          size="sm"
          icon="trash"
          heading={`Remove ${confirmDelete.name}?`}
          description="New agent sessions stop getting its tools. Running agents keep them until they restart."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={() =>
                  run(async () => {
                    await api.deleteMcpServer(confirmDelete.id);
                    const gone = confirmDelete.id;
                    update((prev) => prev.filter((x) => x.id !== gone));
                    forgetProbe(gone);
                    flash(`Removed ${confirmDelete.name}.`);
                    setConfirmDelete(null);
                  })
                }
              >
                Remove
              </Button>
            </>
          }
        >
          {null}
        </Modal>
      )}
    </Modal>
  );
};
