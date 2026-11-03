import type { SessionSummary } from './types.js';

/**
 * How the sidebar groups sessions. Pure functions with no React or DOM, so the grouping can
 * be tested in Node (scripts/test-sidebar-groups.ts).
 */

export const GROUP_BY_MODES = ['status', 'repo', 'agent', 'tag', 'family'] as const;
export type GroupBy = (typeof GROUP_BY_MODES)[number];

export const isGroupBy = (v: unknown): v is GroupBy => typeof v === 'string' && (GROUP_BY_MODES as readonly string[]).includes(v);

export interface SidebarGroup {
  id: string;
  label: string;
  items: SessionSummary[];
  /** How far each row is indented: its depth under the group's first session. */
  depth?: Map<string, number>;
  /** Shown on hover over the group's heading, e.g. a repo's full path. */
  title?: string;
  /** The agent a group of one agent's sessions belongs to, for its icon. */
  agentId?: string;
}

/** A turn is running, or work the agent started still runs after its turn ended. */
export const isWorking = (s: SessionSummary) => s.state === 'working' || (s.state === 'needs_you' && Boolean(s.workingInBackground));

/** A finished turn the user has not looked at since, while nothing else runs. */
export function isUnseen(s: SessionSummary): boolean {
  if (s.state === 'snoozed' || isWorking(s)) return false;
  return Boolean(s.lastTurnEndedAt && s.lastTurnEndedAt > (s.seenAt || 0));
}

/**
 * Its agent was stopped without the user asking (unused for hours, or not restored after a
 * restart) and nothing in it is new: the reply was read, nothing is asked, no reminder is due.
 * It waits like a parked session rather than counting as needing the user. The user's own Stop
 * parks a session on the server; this is the same for the stops CodePit made.
 */
export function isIdleStopped(s: SessionSummary): boolean {
  return (
    s.state === 'needs_you' &&
    s.isAgentRunning === false &&
    !s.restoring &&
    !s.restore &&
    !s.pendingStart &&
    !s.user.reminder &&
    !s.limitHit &&
    !s.scheduledResume?.armed &&
    !isUnseen(s)
  );
}

export const needsAttention = (s: SessionSummary) =>
  Boolean(s.pendingStart) ||
  (Boolean(s.user.reminder) && s.state !== 'working' && s.state !== 'snoozed') ||
  s.state === 'blocked' ||
  (s.state === 'needs_you' && !s.workingInBackground && !s.scheduledResume?.armed && !isIdleStopped(s)) ||
  s.state === 'crashed';

/**
 * When something new arrived for the user: an approval or question was asked, or a reply came
 * in that they have not read. Undefined when nothing new is waiting.
 */
export function freshAt(s: SessionSummary): number | undefined {
  if (s.state === 'blocked' && (s.hasPendingPermission || s.hasPendingElicitation)) return s.askedAt ?? s.updatedAt;
  if (isUnseen(s)) return s.lastTurnEndedAt;
  return undefined;
}

/** Sessions with something new go first, newest first; the rest keep the order they came in. */
export function freshFirst(items: SessionSummary[]): SessionSummary[] {
  const fresh = items.filter((s) => freshAt(s) !== undefined).sort((a, b) => freshAt(b)! - freshAt(a)!);
  return fresh.length === 0 ? items : [...fresh, ...items.filter((s) => freshAt(s) === undefined)];
}

const baseName = (p: string) => p.split('/').filter(Boolean).pop() || p;

/**
 * The repo a session works in: the main clone, so a worktree joins its repo. Sessions saved
 * before the main clone was recorded use their checkout's root until git info refreshes; a
 * folder outside git is its own group.
 */
export function repoKey(s: Pick<SessionSummary, 'git' | 'cwd'>): string {
  return s.git?.mainRoot || s.git?.repoRoot || s.cwd;
}

/** The agent's display name without the old "(ACP)" suffix. */
const agentLabel = (s: SessionSummary) => s.agentName.replace(/\s*\(ACP\)$/, '') || s.agentId;

/** The session at the top of a session's chain of parents, among the sessions shown. */
export function familyRoot(id: string, byId: Map<string, SessionSummary>): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current)?.spawnedBy?.sessionId;
    if (!parent || !byId.has(parent)) break;
    current = parent;
  }
  return current;
}

/** A family's sessions in tree order (each followed by the sessions it started), with depths. */
export function familyTree(rootId: string, members: SessionSummary[]): { order: SessionSummary[]; depth: Map<string, number> } {
  const children = new Map<string, SessionSummary[]>();
  for (const s of members) {
    const parent = s.spawnedBy?.sessionId;
    if (parent && s.id !== rootId) children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const order: SessionSummary[] = [];
  const depth = new Map<string, number>();
  const byId = new Map(members.map((s) => [s.id, s]));
  const walk = (id: string, d: number) => {
    const s = byId.get(id);
    if (!s || depth.has(id)) return;
    order.push(s);
    depth.set(id, d);
    for (const c of (children.get(id) ?? []).sort((a, b) => a.startedAt - b.startedAt)) walk(c.id, d + 1);
  };
  walk(rootId, 0);
  return { order, depth };
}

/** Sessions bucketed by a key, keeping the order they came in (the server's ranking) inside each bucket. */
function bucket(shown: SessionSummary[], keyOf: (s: SessionSummary) => string): Map<string, SessionSummary[]> {
  const buckets = new Map<string, SessionSummary[]>();
  for (const s of shown) {
    const k = keyOf(s);
    const list = buckets.get(k);
    if (list) list.push(s);
    else buckets.set(k, [s]);
  }
  return buckets;
}

/** Groups with the most recent activity first, so the repo or agent being worked in stays on top. */
const lastActive = (g: SidebarGroup) => Math.max(...g.items.map((s) => s.updatedAt || 0));
const byRecent = (a: SidebarGroup, b: SidebarGroup) => lastActive(b) - lastActive(a) || a.label.localeCompare(b.label);

function repoGroups(shown: SessionSummary[]): SidebarGroup[] {
  const buckets = bucket(shown, repoKey);
  // Two repos with the same folder name are told apart by their parent folder
  const nameCount = new Map<string, number>();
  for (const key of buckets.keys()) nameCount.set(baseName(key), (nameCount.get(baseName(key)) ?? 0) + 1);
  const label = (key: string) => {
    const name = baseName(key);
    if ((nameCount.get(name) ?? 0) < 2) return name;
    const parts = key.split('/').filter(Boolean);
    return parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name;
  };
  return [...buckets.entries()].map(([key, items]) => ({ id: `repo:${key}`, label: label(key), title: key, items })).sort(byRecent);
}

function agentGroups(shown: SessionSummary[]): SidebarGroup[] {
  return [...bucket(shown, (s) => s.agentId).entries()]
    .map(([agentId, items]) => ({ id: `agent:${agentId}`, label: agentLabel(items[0]), agentId, items }))
    .sort(byRecent);
}

function tagGroups(shown: SessionSummary[]): SidebarGroup[] {
  const byTag = new Map<string, SessionSummary[]>();
  const untagged: SessionSummary[] = [];
  for (const s of shown) {
    const tags = s.user.tags ?? [];
    if (tags.length === 0) untagged.push(s);
    for (const t of tags) byTag.set(t, [...(byTag.get(t) ?? []), s]);
  }
  const groups: SidebarGroup[] = [...byTag.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([t, items]) => ({ id: `tag:${t}`, label: `#${t}`, items }));
  if (untagged.length > 0) groups.push({ id: 'tag:', label: 'No tags', items: untagged });
  return groups;
}

function familyGroups(shown: SessionSummary[], all: SessionSummary[]): SidebarGroup[] {
  // Roots come from every session, so a filtered-out parent still holds its family together
  const byId = new Map(all.map((s) => [s.id, s]));
  const families = new Map<string, SessionSummary[]>();
  for (const s of shown) {
    const root = familyRoot(s.id, byId);
    families.set(root, [...(families.get(root) ?? []), s]);
  }
  const groups: SidebarGroup[] = [];
  const alone: SessionSummary[] = [];
  for (const [root, members] of families) {
    if (members.length === 1 && members[0].id === root && !all.some((x) => x.spawnedBy?.sessionId === root)) {
      alone.push(members[0]);
      continue;
    }
    const { order, depth } = familyTree(root, members);
    // Members whose parent is filtered out still show, at the top level
    const rest = members.filter((m) => !depth.has(m.id));
    for (const m of rest) depth.set(m.id, 1);
    groups.push({ id: `family:${root}`, label: byId.get(root)?.title ?? 'Session', items: [...order, ...rest], depth });
  }
  if (alone.length > 0) groups.push({ id: 'family:', label: 'On their own', items: alone });
  return groups;
}

/**
 * The sidebar's groups for a mode. `statusGroups` are the status buckets, which depend on the
 * sidebar's attention rules; `all` is every session, used to keep families together.
 */
export function groupSessions(
  mode: GroupBy,
  shown: SessionSummary[],
  all: SessionSummary[],
  statusGroups: Array<{ id: string; label: string; test: (s: SessionSummary) => boolean }>
): SidebarGroup[] {
  switch (mode) {
    // Inside each group too, what is new comes first; families keep their tree order
    case 'repo':
      return repoGroups(freshFirst(shown));
    case 'agent':
      return agentGroups(freshFirst(shown));
    case 'tag':
      return tagGroups(freshFirst(shown));
    case 'family':
      return familyGroups(shown, all);
    default: {
      // Each session in the first status group it fits, so a due reminder shows under "Needs you" only
      const items = new Map(statusGroups.map((g) => [g.id, [] as SessionSummary[]]));
      for (const s of shown) {
        const g = statusGroups.find((x) => x.test(s));
        if (g) items.get(g.id)!.push(s);
      }
      return statusGroups.map((g) => ({ id: g.id, label: g.label, items: freshFirst(items.get(g.id)!) })).filter((g) => g.items.length > 0);
    }
  }
}
