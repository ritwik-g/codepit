import type {
  AcpSession,
  AutoCompactSetting,
  AgentDescriptor,
  EcosystemReport,
  ElicitationAction,
  ElicitationValue,
  McpPreset,
  McpProbeResult,
  McpServer,
  McpServerInput,
  MemoryGraph,
  QueuedPrompt,
  FileAttachment,
  SessionCostDetail,
  SessionSummary,
  StoredCredentials,
  ThinkingEffort,
  UsageReport,
  UserAnnotations,
  VendorSubscriptionInfo, AgySyncStatus, WorkflowRunInfo, WorkflowAgentDetail } from './types';

/** Thrown for a non-2xx reply, with the status so callers need not parse the message. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 'use-app': a browser on the host machine, where only the CodePit app gets in. */
    readonly reason?: string
  ) {
    super(message);
  }
}

/** True for a 401: this browser is not (or no longer) a paired device. */
export const isUnauthorized = (err: unknown) => err instanceof HttpError && err.status === 401;

// A paired device signs in with its HttpOnly cookie, which the browser sends by itself
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new HttpError(errorData.error || `HTTP ${res.status}: ${res.statusText}`, res.status, errorData.reason);
  }

  return res.json();
}

export const api = {
  getMcpServers: () => request<{ servers: McpServer[]; agy?: AgySyncStatus }>('/api/mcp/servers'),
  createMcpServer: (data: McpServerInput) =>
    request<{ server: McpServer }>('/api/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  addMcpPreset: (presetId: string, inputs: Record<string, string>, scope: string) =>
    request<{ server: McpServer }>('/api/mcp/servers/from-preset', {
      method: 'POST',
      body: JSON.stringify({ presetId, inputs, scope }),
    }),
  updateMcpServer: (id: string, data: McpServerInput) =>
    request<{ server: McpServer }>(`/api/mcp/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  setMcpServerEnabled: (id: string, enabled: boolean) =>
    request<{ server: McpServer }>(`/api/mcp/servers/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteMcpServer: (id: string) => request<{ ok: boolean }>(`/api/mcp/servers/${id}`, { method: 'DELETE' }),
  testMcpServer: (id: string, cwd?: string) =>
    request<{ result: McpProbeResult; cwd: string }>(`/api/mcp/servers/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ cwd }),
    }),
  getMemoryGraph: (id: string, since?: string) =>
    request<{ graph: MemoryGraph } | { unchanged: true }>(
      `/api/mcp/servers/${id}/memory-graph${since ? `?since=${encodeURIComponent(since)}` : ''}`
    ),
  getMcpPresets: () => request<{ presets: McpPreset[] }>('/api/mcp/presets'),
  getEcosystems: (refresh = false) =>
    request<{ ecosystems: EcosystemReport[] }>(`/api/mcp/ecosystems${refresh ? '?refresh=1' : ''}`),
  getAgents: () => request<{ agents: AgentDescriptor[] }>('/api/agents'),
  getSessions: () => request<{ sessions: SessionSummary[] }>('/api/sessions'),
  getSession: (id: string) => request<{ session: AcpSession }>(`/api/sessions/${id}`),
  getWorkflowRun: (id: string, taskId: string) =>
    request<{ run: WorkflowRunInfo | null }>(`/api/sessions/${id}/tasks/${encodeURIComponent(taskId)}/workflow`),
  getWorkflowAgent: (id: string, taskId: string, agentId: string) =>
    request<WorkflowAgentDetail>(`/api/sessions/${id}/tasks/${encodeURIComponent(taskId)}/workflow/agents/${encodeURIComponent(agentId)}`),
  getImportableAgentSessions: (agentId: string, cwd: string) =>
    request<{
      sessions: Array<{ id: string; agentId: string; label: string; updatedAt: number; transcriptPath?: string }>;
      supportsManualId: boolean;
    }>(`/api/agent-sessions/imports?agentId=${encodeURIComponent(agentId)}&cwd=${encodeURIComponent(cwd)}`),
  createSession: (data: { agentId: string; cwd: string; title?: string; initialPrompt?: string; model?: string; importAgentSessionId?: string }) =>
    request<{ session: AcpSession }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendPrompt: (id: string, prompt: string, attachments?: FileAttachment[]) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt, attachments }),
    }),
  /** Sends at once when the session is free, otherwise waits behind the running turn. */
  queuePrompt: (id: string, prompt: string, attachments?: FileAttachment[]) =>
    request<{ queued: boolean }>(`/api/sessions/${id}/queue`, {
      method: 'POST',
      body: JSON.stringify({ prompt, attachments }),
    }),
  updateQueuedPrompt: (id: string, queueId: string, prompt: string) =>
    request<{ queuedPrompts: QueuedPrompt[] }>(`/api/sessions/${id}/queue/${queueId}`, {
      method: 'PATCH',
      body: JSON.stringify({ prompt }),
    }),
  removeQueuedPrompt: (id: string, queueId: string) =>
    request<{ queuedPrompts: QueuedPrompt[] }>(`/api/sessions/${id}/queue/${queueId}`, {
      method: 'DELETE',
    }),
  sendQueuedNow: (id: string, queueId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/queue/${queueId}/send`, {
      method: 'POST',
    }),
  cancelPrompt: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/cancel`, {
      method: 'POST',
    }),
  stopSessionAgent: (id: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/stop`, {
      method: 'POST',
    }),
  startSessionAgent: (id: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/start`, {
      method: 'POST',
    }),
  resolvePermission: (id: string, optionId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/permission`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
    }),
  answerElicitation: (id: string, requestId: string, action: ElicitationAction, content?: Record<string, ElicitationValue>) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/elicitation`, {
      method: 'POST',
      body: JSON.stringify({ requestId, action, content }),
    }),
  switchAgent: (
    id: string,
    targetAgentId: string,
    opts?: {
      model?: string;
      archivePrevious?: boolean;
      inPlace?: boolean;
      customPrompt?: string;
      skipInitialPrompt?: boolean;
      contextMode?: 'compact' | 'full' | 'none';
    }
  ) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/switch`, {
      method: 'POST',
      body: JSON.stringify({ targetAgentId, ...opts }),
    }),
  rollbackSession: (
    id: string,
    opts: {
      turnId?: string;
      action: 'revert_to_this' | 'revert_before_this' | 'undo_last';
    }
  ) =>
    request<{ session: AcpSession; restoredPrompt?: string }>(`/api/sessions/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /** force: compact a stopped agent anyway, which resends recent turns for it to summarise. */
  compactSession: (id: string, opts: { force?: boolean } = {}) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/compact`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  setAutoCompact: (id: string, setting: AutoCompactSetting) =>
    request<{ autoCompact: AutoCompactSetting }>(`/api/sessions/${id}/auto-compact`, {
      method: 'PUT',
      body: JSON.stringify(setting),
    }),
  setSessionAgent: (
    id: string,
    agentId: string,
    model?: string,
    effort?: string,
    contextMode?: 'compact' | 'full' | 'none'
  ) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/agent`, {
      method: 'PATCH',
      body: JSON.stringify({ agentId, model, effort, contextMode }),
    }),
  setSessionEffort: (id: string, effort: ThinkingEffort) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/effort`, {
      method: 'PATCH',
      body: JSON.stringify({ effort }),
    }),
  /** An approval mode the agent offers (agentOptions.modes); turns off this app's auto-approve. */
  setSessionMode: (id: string, mode: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/mode`, { method: 'PUT', body: JSON.stringify({ mode }) }),
  /** Claude's ultrathink (next message only) and ultracode (every message, at xhigh effort). */
  setSessionUltra: (id: string, opts: { ultracode?: boolean; ultrathinkNext?: boolean }) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/ultra`, { method: 'PUT', body: JSON.stringify(opts) }),
  /** Set the agent session aside: the next message starts a new one, handed the conversation per contextMode. */
  forgetAgentSession: (id: string, contextMode: 'compact' | 'full' | 'none') =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/agent-session/forget`, { method: 'POST', body: JSON.stringify({ contextMode }) }),
  setSessionFastMode: (id: string, enabled: boolean) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/fast-mode`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  /** Starred models, "<agentId>:<model>", shared by every device. */
  getFavoriteModels: () => request<{ favorites: string[] }>('/api/settings/favorite-models'),
  setFavoriteModels: (favorites: string[]) =>
    request<{ favorites: string[] }>('/api/settings/favorite-models', { method: 'PUT', body: JSON.stringify({ favorites }) }),
  updateAnnotations: (id: string, updates: Partial<UserAnnotations>) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/annotations`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),
  markSeen: (id: string) => request<{ ok: true }>(`/api/sessions/${id}/seen`, { method: 'POST' }),
  renameSession: (id: string, title: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, {
      method: 'DELETE',
    }),
  search: (query: string) =>
    request<{ sessions: AcpSession[] }>(`/api/search?q=${encodeURIComponent(query)}`),
  getFolders: (basePath?: string) =>
    request<{
      current: string;
      parent: string | null;
      isGit: boolean;
      recent: string[];
      entries: { name: string; path: string; isGit: boolean }[];
    }>(`/api/folders?path=${encodeURIComponent(basePath || '')}`),
  browseNativeFolder: () =>
    request<{ supported: boolean; selected?: string; canceled?: boolean; error?: string }>(
      '/api/browse-native-folder',
      { method: 'POST' }
    ),
  getSubscriptions: () =>
    request<{ subscriptions: Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> }>(
      '/api/subscriptions'
    ),
  saveSubscriptionsConfig: (creds: Partial<StoredCredentials>) =>
    request<{ success: boolean; credentials: StoredCredentials; subscriptions: Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> }>(
      '/api/subscriptions/config',
      {
        method: 'POST',
        body: JSON.stringify(creds),
      }
    ),
  refreshRateLimits: () =>
    request<{ success: boolean; subscriptions: Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> }>(
      '/api/subscriptions/refresh-limits',
      {
        method: 'POST',
      }
    ),
  getUsageSummary: () =>
    request<{ usage: UsageReport }>('/api/usage/summary'),
  getSessionUsage: (id: string) =>
    request<{ sessionCost: SessionCostDetail; usage: any; model?: string }>(`/api/sessions/${id}/usage`),
  getNetworkInfo: () => request<NetworkInfo>('/api/network'),
  setLanAccess: (enabled: boolean) =>
    request<NetworkInfo>('/api/network/lan', { method: 'POST', body: JSON.stringify({ enabled }) }),

  // Pairing: the first three are for the device asking to be let in
  requestPairing: (data: { ticket?: string; standalone?: boolean }) =>
    request<PairingStart>('/api/pair/request', { method: 'POST', body: JSON.stringify(data) }),
  pollPairing: (id: string, secret: string) =>
    request<{ status: PairingStatus; device?: { id: string; name: string } }>(
      `/api/pair/request/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`
    ),
  renamePairingRequest: (id: string, secret: string, name: string) =>
    request<{ name: string }>(`/api/pair/request/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ secret, name }),
    }),
  // The host's side
  createPairingTicket: () => request<PairingTicket>('/api/pair/ticket', { method: 'POST' }),
  getDevices: () => request<{ devices: PairedDevice[]; pending: PairingRequestInfo[] }>('/api/devices'),
  approvePairing: (by: { code: string } | { requestId: string }) =>
    request<{ device: PairedDevice }>('/api/pair/approve', { method: 'POST', body: JSON.stringify(by) }),
  denyPairing: (requestId: string) =>
    request<{ ok: boolean }>('/api/pair/deny', { method: 'POST', body: JSON.stringify({ requestId }) }),
  revokeDevice: (id: string) => request<{ ok: boolean }>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  renameDevice: (id: string, name: string) =>
    request<{ device: PairedDevice }>(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  // A paired device about itself
  getSelfDevice: () => request<{ local: boolean; device?: PairedDevice | null }>('/api/devices/self'),
  forgetSelfDevice: () => request<{ ok: boolean }>('/api/devices/self', { method: 'DELETE' }),
};

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingStart {
  requestId: string;
  /** Six digits the person types on the host. */
  code: string;
  pollSecret: string;
  name: string;
  /** Opened from the host's QR code, so the host can allow it with one click. */
  viaTicket: boolean;
  /** A ticket was given but was used or had expired; the code still works. */
  ticketRejected: boolean;
  expiresAt: number;
}

export interface PairingTicket {
  ticket: string;
  expiresAt: number;
  /** One pairing link per network, best first. */
  lanInterfaces: Array<LanInterface & { url: string }>;
  /** The computer's mDNS name (e.g. my-mac.local), or null when it has none. */
  hostname: string | null;
  /** Pairing link by that name: it keeps working when the IP changes. */
  hostnameUrl: string | null;
}

export interface PairedDevice {
  id: string;
  name: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  /** When the device loses access if it is not used before then. */
  expiresAt: number;
}

export interface PairingRequestInfo {
  id: string;
  name: string;
  ip: string;
  viaTicket: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface LanInterface {
  address: string;
  /** OS interface name, e.g. en0 or bridge100. */
  name: string;
  kind: 'wifi' | 'ethernet' | 'other' | 'vpn' | 'virtual';
  /** Plain-words network name, e.g. "Wi-Fi". */
  label: string;
}

export interface NetworkInfo {
  port: number;
  /** Addresses LAN devices can reach the server on right now. */
  ips: string[];
  localUrl: string;
  /** The computer's mDNS name (e.g. my-mac.local), or null when it has none or LAN is off. */
  hostname: string | null;
  /** Address by that name: it keeps working when the IP changes. */
  hostnameUrl: string | null;
  /** The same addresses, labelled by network and ordered best first (Wi-Fi before VM bridges). */
  lanInterfaces: LanInterface[];
  lanEnabled: boolean;
  host: string;
  /** Interfaces that could not be listened on, with the reason. */
  lanErrors: { address: string; error: string }[];
  /** False when viewed from another device, or when HOST fixes the setting. */
  canToggle: boolean;
  lockedReason?: string;
}

/**
 * True when the page is served to the machine running the server. The native
 * Finder picker opens on the host's screen, so it is only offered there.
 */
export function isHostMachine(): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);
}

export function wsUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export interface LiveSocket {
  close: () => void;
}

/**
 * Opens the event socket and keeps it open: when the server restarts or the
 * network drops, it reconnects with capped exponential backoff. onOpen fires on
 * every (re)connect so callers can refetch whatever they missed while offline.
 */
export function connectWebSocket(
  onMessage: (msg: any) => void,
  onOpen?: () => void,
  /** Gets the close code: 4401 means this device's access was just revoked. */
  onClose?: (code: number) => void
): LiveSocket {
  let ws: WebSocket | null = null;
  let closedByCaller = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    ws = new WebSocket(wsUrl('/ws'));
    ws.onopen = () => {
      attempt = 0;
      onOpen?.();
    };
    ws.onclose = (event) => {
      if (closedByCaller) return;
      onClose?.(event.code);
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(open, delay);
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed frames
      }
    };
  };

  open();

  return {
    close: () => {
      closedByCaller = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
