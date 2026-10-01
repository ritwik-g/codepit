import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import { api } from '../../api';
import type { McpServer, MemoryGraph, MemoryGraphEntity } from '../../types';
import { Button, EmptyState, Icon, Input, Segmented, Spinner } from '../../ui';
import { useTheme } from '../../design/theme';
import { Modal } from '../Modal';
import { CopyButton } from '../AgentTurn';
import '../../styles/memgraph.css';

// Read-only view of a memory MCP server's knowledge graph: decisions and action
// items, coloured by their latest status=, with each entity's stamped history.
// Polls the server while open and redraws only when the file changed.

const STATUSES = ['todo', 'in-progress', 'blocked', 'done', 'dismissed'] as const;
const POLL_MS = 3000;
const STORAGE_KEY = 'codepit_memgraph';

type View = 'graph' | 'board';
type GroupBy = 'work' | 'repo' | 'both' | 'none';
interface Prefs {
  view: View;
  groupBy: GroupBy;
  repo: string;
  work: string;
  hideClosed: boolean;
}

const DEFAULT_PREFS: Prefs = { view: 'graph', groupBy: 'work', repo: '', work: '', hideClosed: false };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}

const isDecision = (e: MemoryGraphEntity) => e.type === 'decision';
const isItem = (e: MemoryGraphEntity) => e.type === 'action-item';
const isClosed = (e: MemoryGraphEntity) => e.status === 'done' || e.status === 'dismissed';
const statusKey = (s: string) => ((STATUSES as readonly string[]).includes(s) ? s : 'none');
/** CSS variable for an entity's colour; defined in memgraph.css from the design tokens. */
const colorVar = (e: MemoryGraphEntity) => (isDecision(e) ? '--mg-decision' : `--mg-${statusKey(e.status)}`);
const shortName = (n: string) => n.replace(/^Task:/, '').replace(/^[^:]+:/, '');
const relLabel = (t: string) => t.toLowerCase().replace(/_/g, ' ');
const nodeId = (name: string) => `n:${name}`;

function groupKey(e: MemoryGraphEntity, by: GroupBy): string | null {
  if (by === 'none') return null;
  if (by === 'repo') return e.repo;
  if (by === 'both') return `${e.repo} / ${e.domain}`;
  return e.domain;
}

function formatTime(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ------------------------------------------------------------------ detail panel

const Detail: React.FC<{
  entity: MemoryGraphEntity | undefined;
  graph: MemoryGraph;
  onSelect: (name: string) => void;
}> = ({ entity: e, graph, onSelect }) => {
  const [showJson, setShowJson] = useState(false);
  if (!e) return <div className="mg-detail-empty">Select a node or card to see its history.</div>;
  const out = graph.relations.filter((r) => r.from === e.name);
  const inc = graph.relations.filter((r) => r.to === e.name);
  const json = JSON.stringify(
    {
      entity: { type: 'entity', name: e.name, entityType: e.type, observations: e.observations.map((o) => o.text) },
      relations: [...out, ...inc].map((r) => ({ type: 'relation', from: r.from, to: r.to, relationType: r.type })),
    },
    null,
    2
  );
  return (
    <>
      <h3 className="mg-detail-name">{e.name}</h3>
      <div className="mg-detail-meta">
        <span className="mg-pill" style={{ background: `var(${colorVar(e)})` }}>
          {isDecision(e) ? 'decision' : e.status || e.type || 'no status'}
        </span>
        <span>
          repo <b>{e.repo}</b> · domain <b>{e.domain}</b>
        </span>
      </div>
      <div className="mg-detail-tools">
        <Button size="sm" variant={showJson ? 'secondary' : 'ghost'} icon="hash" onClick={() => setShowJson(!showJson)} aria-pressed={showJson}>
          Inspect JSON
        </Button>
        <CopyButton text={json} label="Copy JSON" withText />
      </div>
      {showJson && <pre className="mg-json">{json}</pre>}
      {(out.length > 0 || inc.length > 0) && (
        <>
          <h4 className="mg-detail-h">Relations</h4>
          <ul className="mg-rels">
            {out.map((r) => (
              <li key={`o:${r.type}:${r.to}`}>
                <button type="button" className="mcp-linkbtn" onClick={() => onSelect(r.to)}>
                  <small>{relLabel(r.type)} →</small> {r.to}
                </button>
              </li>
            ))}
            {inc.map((r) => (
              <li key={`i:${r.type}:${r.from}`}>
                <button type="button" className="mcp-linkbtn" onClick={() => onSelect(r.from)}>
                  <small>← {relLabel(r.type)} by</small> {r.from}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 className="mg-detail-h">History ({e.observations.length})</h4>
      <ol className="mg-obs" reversed>
        {[...e.observations].reverse().map((o, i) => (
          <li key={i}>
            <div className="mg-obs-when">
              {o.ts || '(no stamp)'}
              {o.name && <> · {o.name}</>}
              {o.id && (
                <>
                  {' '}
                  · <code title={o.id}>{o.id.slice(0, 8)}</code>
                </>
              )}
              {o.repo && <> · {o.repo}</>}
            </div>
            <div className="mg-obs-text">{o.text}</div>
          </li>
        ))}
      </ol>
    </>
  );
};

// ------------------------------------------------------------------ board

const BoardCard: React.FC<{ e: MemoryGraphEntity; selected: boolean; onSelect: (n: string) => void }> = ({ e, selected, onSelect }) => (
  <button
    type="button"
    className={`mg-card ${selected ? 'is-selected' : ''}`}
    style={{ borderLeftColor: `var(${colorVar(e)})` }}
    onClick={() => onSelect(e.name)}
  >
    <span className="mg-card-name">{shortName(e.name)}</span>
    <span className="mg-card-sub">
      {e.repo} · {e.domain} · {e.observations.at(-1)?.ts ?? ''}
    </span>
  </button>
);

const Board: React.FC<{
  entities: MemoryGraphEntity[];
  groupBy: GroupBy;
  hideClosed: boolean;
  selected: string | null;
  onSelect: (n: string) => void;
}> = ({ entities, groupBy, hideClosed, selected, onSelect }) => {
  const items = entities.filter(isItem);
  const others = entities.filter((e) => !isItem(e));
  const statusCols = [...STATUSES, 'none'].filter((s) => !(hideClosed && (s === 'done' || s === 'dismissed')));
  const groups = [...new Set(others.map((e) => groupKey(e, groupBy) ?? 'All decisions'))].sort();
  return (
    <div className="mg-board">
      <h3 className="mg-board-title">Action items ({items.length})</h3>
      <div className="mg-cols">
        {statusCols.map((s) => {
          const list = items.filter((e) => statusKey(e.status) === s);
          if (s === 'none' && !list.length) return null;
          return (
            <section key={s} className="mg-col">
              <h4>
                <i className="mg-dot" style={{ background: `var(--mg-${s})` }} />
                {s === 'none' ? 'no status' : s} <span className="mg-count">{list.length}</span>
              </h4>
              {list.map((e) => (
                <BoardCard key={e.name} e={e} selected={selected === e.name} onSelect={onSelect} />
              ))}
            </section>
          );
        })}
      </div>
      {others.length > 0 && (
        <>
          <h3 className="mg-board-title">Decisions and other entities ({others.length})</h3>
          <div className="mg-cols">
            {groups.map((g) => (
              <section key={g} className="mg-col">
                <h4>{g}</h4>
                {others
                  .filter((e) => (groupKey(e, groupBy) ?? 'All decisions') === g)
                  .map((e) => (
                    <BoardCard key={e.name} e={e} selected={selected === e.name} onSelect={onSelect} />
                  ))}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ graph

type Cytoscape = typeof import('cytoscape');
let cytoscapeLoad: Promise<Cytoscape> | null = null;
/** Loaded on first use so the graph library stays out of the main bundle. */
function loadCytoscape(): Promise<Cytoscape> {
  cytoscapeLoad ??= Promise.all([import('cytoscape'), import('cytoscape-fcose')]).then(
    ([cy, fcose]) => {
      cy.default.use(fcose.default);
      return cy.default;
    },
    (err) => {
      // Let the next open try again, e.g. after the app was updated under this page
      cytoscapeLoad = null;
      throw err;
    }
  );
  return cytoscapeLoad;
}

const Graph: React.FC<{
  entities: MemoryGraphEntity[];
  relations: MemoryGraph['relations'];
  groupBy: GroupBy;
  /** Changes when the user changes grouping or filters: lay out afresh and fit, instead of keeping positions. */
  layoutKey: string;
  selected: string | null;
  onSelect: (n: string) => void;
}> = ({ entities, relations, groupBy, layoutKey, selected, onSelect }) => {
  const box = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const sigRef = useRef('');
  const layoutKeyRef = useRef(layoutKey);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [lib, setLib] = useState<Cytoscape | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const { resolved: theme } = useTheme();

  useEffect(() => {
    // cytoscape is a function, so wrap it or React would call it as an updater
    loadCytoscape().then((cy) => setLib(() => cy), (err) => setLibError(err?.message || 'Could not load the graph view'));
    // Cytoscape measures its container once; follow the dialog's size
    const ro = new ResizeObserver(() => cyRef.current?.resize());
    if (box.current) ro.observe(box.current);
    return () => {
      ro.disconnect();
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!lib || !box.current) return;
    const css = (name: string) => getComputedStyle(box.current!).getPropertyValue(name).trim();
    const names = new Set(entities.map((e) => e.name));
    const groups = [...new Set(entities.map((e) => groupKey(e, groupBy)))].filter((g): g is string => g !== null);
    // Prefixed ids, so no entity name can collide with a group or an edge
    const els: ElementDefinition[] = groups.map((g) => ({ data: { id: `g:${g}`, label: g }, classes: 'group' }));
    for (const e of entities) {
      const g = groupKey(e, groupBy);
      els.push({
        data: { id: nodeId(e.name), name: e.name, label: shortName(e.name), parent: g === null ? undefined : `g:${g}`, color: css(colorVar(e)) },
        classes: isDecision(e) ? 'decision' : 'item',
      });
    }
    const edges = new Set<string>();
    for (const r of relations) {
      const id = `e:${JSON.stringify([r.from, r.type, r.to])}`;
      if (names.has(r.from) && names.has(r.to) && !edges.has(id)) {
        edges.add(id);
        els.push({ data: { id, source: nodeId(r.from), target: nodeId(r.to) }, classes: r.type.toLowerCase() });
      }
    }

    // Same nodes and edges as on screen: recolour in place and keep the layout, pan and zoom
    const sig = `${theme}\n` + els.map((x) => `${x.data.id}@${x.data.parent ?? ''}`).sort().join('\n');
    const prevCy = cyRef.current;
    // The user changed grouping or filters: start over. A file change keeps known
    // nodes where they were and seeds new ones next to their group.
    const relayout = layoutKeyRef.current !== layoutKey;
    layoutKeyRef.current = layoutKey;
    if (prevCy && sig === sigRef.current) {
      for (const x of els) if (x.data.color) prevCy.getElementById(x.data.id!).data('color', x.data.color);
      return;
    }
    sigRef.current = sig;

    const prev: Record<string, { x: number; y: number }> = {};
    const view = prevCy && !relayout ? { zoom: prevCy.zoom(), pan: prevCy.pan() } : null;
    if (prevCy) {
      if (!relayout) prevCy.nodes(':childless').forEach((n: NodeSingular) => void (prev[n.id()] = { ...n.position() }));
      prevCy.destroy();
    }
    const nodes = els.filter((x) => x.data.source === undefined && x.classes !== 'group');
    const known = nodes.filter((x) => prev[x.data.id!]);
    for (const x of nodes) {
      if (prev[x.data.id!]) {
        x.position = prev[x.data.id!];
        continue;
      }
      const sib = known.filter((k) => k.data.parent === x.data.parent);
      const base = sib.length
        ? sib.reduce((a, k) => ({ x: a.x + k.position!.x / sib.length, y: a.y + k.position!.y / sib.length }), { x: 0, y: 0 })
        : { x: 0, y: 0 };
      x.position = { x: base.x + (Math.random() - 0.5) * 80, y: base.y + (Math.random() - 0.5) * 80 };
    }
    const fresh = known.length === 0;
    const allKnown = nodes.length > 0 && known.length === nodes.length;

    const cy = lib({
      container: box.current,
      elements: els,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'font-size': 11,
            'min-zoomed-font-size': 6,
            color: css('--text'),
            'text-valign': 'bottom',
            'text-margin-y': 4,
            'text-wrap': 'wrap',
            'text-max-width': '120px',
            'background-color': 'data(color)',
            width: 18,
            height: 18,
          },
        },
        { selector: 'node.decision', style: { shape: 'round-rectangle', width: 26, height: 16 } },
        {
          selector: 'node.group',
          style: {
            'background-color': css('--accent'),
            'background-opacity': 0.05,
            'border-width': 1,
            'border-color': css('--border'),
            shape: 'round-rectangle',
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': -4,
            'font-weight': 600,
            color: css('--text-2'),
            padding: '14px',
          },
        },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': css('--text') } },
        {
          selector: 'edge',
          style: {
            width: 1.4,
            'line-color': css('--mg-edge'),
            'target-arrow-color': css('--mg-edge'),
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
          },
        },
        { selector: 'edge.blocked_by', style: { 'line-style': 'dashed', 'line-color': css('--mg-blocked'), 'target-arrow-color': css('--mg-blocked') } },
        { selector: 'edge.supersedes', style: { 'line-color': css('--mg-decision'), 'target-arrow-color': css('--mg-decision'), width: 2 } },
        { selector: 'edge.spawned', style: { 'line-style': 'dotted' } },
      ],
      layout: allKnown
        ? { name: 'preset', fit: false }
        : ({
            name: 'fcose',
            animate: false,
            quality: 'proof',
            randomize: fresh,
            fit: fresh || !view,
            fixedNodeConstraint: fresh ? undefined : known.map((k) => ({ nodeId: k.data.id, position: k.position })),
            nodeRepulsion: () => 6500,
            idealEdgeLength: () => 60,
            nestingFactor: 0.4,
            gravity: 0.35,
            gravityCompound: 1.2,
            tilingPaddingVertical: 28,
            tilingPaddingHorizontal: 28,
            packComponents: true,
            padding: 30,
            nodeDimensionsIncludeLabels: true,
          } as any),
    });
    if (!fresh && view) {
      cy.zoom(view.zoom);
      cy.pan(view.pan);
    } else {
      // The layout ran before the dialog finished sizing; fit to the real canvas
      cy.resize();
      cy.fit(undefined, 30);
    }
    cy.on('tap', 'node.decision, node.item', (ev) => onSelectRef.current(ev.target.data('name')));
    cyRef.current = cy;
  }, [lib, entities, relations, groupBy, layoutKey, theme]);

  // Mirror the selection (from the board, a relation link or a tap) onto the graph
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(':selected').unselect();
    if (!selected) return;
    const n = cy.getElementById(nodeId(selected));
    if (n.nonempty()) {
      n.select();
      if (!isOnScreen(cy, n)) cy.animate({ center: { eles: n } }, { duration: 250 });
    }
  }, [selected, lib, entities, groupBy, theme]);

  if (libError) return <EmptyState icon="alert" title="Couldn't load the graph view" description={libError} compact />;
  return (
    <div className="mg-graph" ref={box}>
      {!lib && (
        <div className="mg-loading">
          <Spinner size={14} /> Loading the graph…
        </div>
      )}
    </div>
  );
};

function isOnScreen(cy: Core, n: NodeSingular): boolean {
  const p = n.renderedPosition();
  return p.x > 0 && p.y > 0 && p.x < cy.width() && p.y < cy.height();
}

// ------------------------------------------------------------------ dialog

export const MemoryGraphView: React.FC<{ server: McpServer; onClose: () => void }> = ({ server, onClose }) => {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelectedState] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  // On a phone the details sit under the canvas, which takes touch drags for panning
  const setSelected = (name: string) => {
    setSelectedState(name);
    if (window.matchMedia('(max-width: 760px)').matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  };
  const version = useRef<string | undefined>(undefined);

  const setPref = <K extends keyof Prefs>(key: K, value: Prefs[K]) => setPrefs((p) => ({ ...p, [key]: value }));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Private mode: preferences just don't stick
    }
  }, [prefs]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim().toLowerCase()), 180);
    return () => window.clearTimeout(t);
  }, [query]);

  // Poll while open and visible; the server answers `unchanged` until the file changes
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const r = await api.getMemoryGraph(server.id, version.current);
          if (stopped) return;
          if ('graph' in r) {
            version.current = r.graph.version;
            setGraph(r.graph);
          }
          setError(null);
          setLive(true);
        } catch (err: any) {
          if (stopped) return;
          // Keep showing the last graph; only an empty view shows the error in full
          setError(err?.message || 'Could not read the memory graph');
          setLive(false);
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [server.id]);

  const entities = graph?.entities ?? [];
  const repos = useMemo(() => [...new Set(entities.map((e) => e.repo))].sort(), [entities]);
  const works = useMemo(() => [...new Set(entities.map((e) => e.domain))].sort(), [entities]);
  // A saved filter for a repo or domain this graph doesn't have would hide everything
  const repo = repos.includes(prefs.repo) ? prefs.repo : '';
  const work = works.includes(prefs.work) ? prefs.work : '';

  const visible = useMemo(
    () =>
      entities.filter((e) => {
        if (repo && e.repo !== repo) return false;
        if (work && e.domain !== work) return false;
        if (prefs.hideClosed && isClosed(e)) return false;
        if (debounced && !e.name.toLowerCase().includes(debounced) && !e.observations.some((o) => o.text.toLowerCase().includes(debounced)))
          return false;
        return true;
      }),
    [entities, repo, work, prefs.hideClosed, debounced]
  );

  const byName = useMemo(() => new Map(entities.map((e) => [e.name, e])), [entities]);
  const nItems = entities.filter(isItem).length;
  const nDecisions = entities.filter(isDecision).length;

  const description = graph ? (
    <span className="mg-sub">
      <span className="mono" title={graph.file}>
        {graph.file}
      </span>
      <span className={`mg-live ${live ? 'is-ok' : 'is-down'}`} role="status">
        <Icon name={live ? 'circleDot' : 'alert'} size={11} />
        {live ? (graph.exists ? `Live · changed ${formatTime(graph.modified)}` : 'Live · no file yet') : 'Not updating, showing the last graph'}
      </span>
    </span>
  ) : (
    'Decisions and action items your agents have saved.'
  );

  return (
    <Modal nested onClose={onClose} className="mg-dialog" bodyClassName="mg-shell" icon="brain" heading={`${server.name} graph`} description={description}>
      {!graph ? (
        error ? (
          <EmptyState icon="alert" title="Couldn't read the memory graph" description={error} compact />
        ) : (
          <div className="mg-loading">
            <Spinner size={14} /> Reading the graph…
          </div>
        )
      ) : (
        <>
          <div className="mg-toolbar">
            <span className="mg-stats">
              {nDecisions} decisions · {nItems} action items · {graph.relations.length} relations
              {entities.length - nItems - nDecisions > 0 && ` · ${entities.length - nItems - nDecisions} other`}
              {graph.skipped > 0 && ` · ${graph.skipped} unreadable line${graph.skipped === 1 ? '' : 's'}`}
            </span>
            <Segmented<View>
              size="sm"
              label="View"
              value={prefs.view}
              onChange={(v) => setPref('view', v)}
              options={[
                { value: 'graph', label: 'Graph', icon: 'branch' },
                { value: 'board', label: 'Board', icon: 'grid' },
              ]}
            />
            <select className="ui-input mg-select" aria-label="Group by" value={prefs.groupBy} onChange={(ev) => setPref('groupBy', ev.target.value as GroupBy)}>
              <option value="work">Group: work</option>
              <option value="repo">Group: repo</option>
              <option value="both">Group: repo / work</option>
              <option value="none">Group: none</option>
            </select>
            <select className="ui-input mg-select" aria-label="Work" value={work} onChange={(ev) => setPref('work', ev.target.value)}>
              <option value="">All work</option>
              {works.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <select className="ui-input mg-select" aria-label="Repo" value={repo} onChange={(ev) => setPref('repo', ev.target.value)}>
              <option value="">All repos</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Input type="search" className="mg-search" placeholder="Filter by name or text" aria-label="Filter" value={query} onChange={(ev) => setQuery(ev.target.value)} />
            <label className="mg-check">
              <input type="checkbox" checked={prefs.hideClosed} onChange={(ev) => setPref('hideClosed', ev.target.checked)} /> Hide done / dismissed
            </label>
          </div>
          <div className="mg-legend" aria-hidden>
            <span>
              <i className="mg-sq" /> decision
            </span>
            {STATUSES.map((s) => (
              <span key={s}>
                <i className="mg-dot" style={{ background: `var(--mg-${s})` }} /> {s}
              </span>
            ))}
            <span>
              <i className="mg-ln" /> implements
            </span>
            <span>
              <i className="mg-ln is-blocked" /> blocked by
            </span>
            <span>
              <i className="mg-ln is-supersedes" /> supersedes
            </span>
          </div>
          <div className="mg-main">
            <div className="mg-canvas">
              {entities.length === 0 ? (
                <EmptyState
                  icon="brain"
                  title="Nothing saved yet"
                  description={graph.exists ? 'The file has no entities.' : 'The memory server creates this file the first time an agent saves something.'}
                  compact
                />
              ) : visible.length === 0 ? (
                <EmptyState icon="filter" title="Nothing matches the filters" compact />
              ) : prefs.view === 'graph' ? (
                <Graph
                  entities={visible}
                  relations={graph.relations}
                  groupBy={prefs.groupBy}
                  layoutKey={[prefs.groupBy, repo, work, prefs.hideClosed, debounced].join('\n')}
                  selected={selected}
                  onSelect={setSelected}
                />
              ) : (
                <Board entities={visible} groupBy={prefs.groupBy} hideClosed={prefs.hideClosed} selected={selected} onSelect={setSelected} />
              )}
            </div>
            <aside className="mg-detail" aria-label="Details" ref={detailRef}>
              <Detail entity={selected ? byName.get(selected) : undefined} graph={graph} onSelect={setSelected} />
            </aside>
          </div>
        </>
      )}
    </Modal>
  );
};

