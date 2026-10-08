import express, { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { hasAgent, listAgents } from './agents/registry.js';
import { AgentNotRunningError, ElicitationAnswerError, InvalidOptionError, NothingToCompactError, QueuedPromptNotFoundError, RestoreError, ScheduleError, isSafeImportedSessionId, listImportableAgentSessions, sessionManager } from './acp/session-mgr.js';
import { parseAutoCompact } from './compaction.js';
import { isLimitResumeMode, parseScheduleRequest, readLimitResumeMode } from './limit-resume.js';
import { TurnInFlightError } from './acp/client-host.js';
import { searchSessions } from './search.js';
import { getGitInfo } from './git.js';
import { store } from './store.js';
import {
  getVendorSubscriptions,
  saveStoredCredentials,
  getUsageSummary,
  calculateSessionCost,
  refreshClaudeRateLimitsAsync,
} from './subscriptions.js';
import { lanAccess } from './lan.js';
import { describeLanAddresses, getLanHostname } from './network.js';
import { getUploadsDir } from './paths.js';
import { devices } from './devices.js';
import { isHostClient } from './security.js';
import { mcpRouter } from './mcp/routes.js';
import { advertisedOptions, effortChoicesFor, effortError, isEffortValue, isFavoriteList, markNewModels, readFavoriteModels, writeFavoriteModels } from './acp/agent-options.js';
import { refreshCodexRateLimitsAsync } from './codex-limits.js';
import { readWorkflowAgent, readWorkflowRun } from './acp/workflow-run.js';
import type { AgentTask, UserAnnotations } from './types.js';

export const apiRouter = Router();

// @types/express v5 types route params as string | string[]; express v4 always gives a string
const sid = (req: Request): string => String(req.params.id);

// Static directory for uploaded files and pictures (under the app dir, so CODEPIT_APP_DIR isolates it)
apiRouter.use('/attachments', express.static(getUploadsDir()));

// App-level MCP servers, presets and the agents' own plugins and skills
apiRouter.use('/mcp', mcpRouter);

// 1. List registered agents
apiRouter.get('/agents', (req: Request, res: Response) => {
  // Absent param -> undefined so the registry's env default (test mode / CODEPIT_ENABLE_MOCK) applies
  const includeMock = req.query.includeMock === undefined ? undefined : req.query.includeMock === 'true';
  // With the effort and model choices each agent last advertised, so pickers show them before a session starts
  res.json({ agents: listAgents(includeMock).map((a) => ({ ...a, advertised: withNewModels(a.id, advertisedOptions(a.id)) })) });
});

// The "New" badge is worked out when served, so a cached list does not keep it past two weeks
function withNewModels(agentId: string, byModel: ReturnType<typeof advertisedOptions>) {
  if (!byModel) return byModel;
  return Object.fromEntries(Object.entries(byModel).map(([model, opts]) => [model, markNewModels(agentId, opts)]));
}

// Favourite models, shared by every device: ["<agentId>:<model>", ...]
apiRouter.get('/settings/favorite-models', (_req: Request, res: Response) => {
  res.json({ favorites: readFavoriteModels() });
});

apiRouter.put('/settings/favorite-models', (req: Request, res: Response) => {
  const { favorites } = req.body ?? {};
  if (!isFavoriteList(favorites)) {
    res.status(400).json({ error: 'favorites must be a list of "<agentId>:<model>" strings' });
    return;
  }
  writeFavoriteModels(favorites);
  res.json({ favorites: readFavoriteModels() });
});

// What to do when Claude hits its 5-hour usage limit: 'off' | 'ask' | 'auto'
apiRouter.get('/settings/limit-resume', (_req: Request, res: Response) => {
  res.json({ mode: readLimitResumeMode() });
});

apiRouter.put('/settings/limit-resume', (req: Request, res: Response) => {
  const mode = req.body?.mode;
  if (!isLimitResumeMode(mode)) {
    res.status(400).json({ error: "mode must be 'off', 'ask' or 'auto'" });
    return;
  }
  res.json({ mode: sessionManager.setLimitResumeMode(mode) });
});

// 2. List attention-ranked sessions
apiRouter.get('/sessions', (_req: Request, res: Response) => {
  res.json({ sessions: sessionManager.listSessions() });
});

function restoreFailed(res: Response, err: any) {
  res.status(err instanceof RestoreError ? err.status : 500).json({ error: err.message });
}

// 2b. Restore (or dismiss) every agent that was running when CodePit last closed.
// Registered before any /sessions/:id route: DELETE /sessions/:id would otherwise take
// "restore-all" for a session id
apiRouter.post('/sessions/restore-all', async (_req: Request, res: Response) => {
  try {
    res.json(await sessionManager.restoreAllSessions());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/sessions/restore-all', (_req: Request, res: Response) => {
  res.json({ dismissed: sessionManager.dismissAllRestores() });
});

// 3. Discover conversations an agent can continue when creating a new CodePit session.
// Claude and Codex have readable local transcript stores; other resume-capable agents can
// still use a pasted session id, since their stores are intentionally not poked at.
apiRouter.get('/agent-sessions/imports', (req: Request, res: Response) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
  if (!hasAgent(agentId) || !cwd) {
    res.status(400).json({ error: 'agentId and cwd are required' });
    return;
  }
  const targetCwd = path.resolve(cwd.replace(/^~/, os.homedir()));
  let isDir = false;
  try {
    isDir = fs.statSync(targetCwd).isDirectory();
  } catch {
    // missing or unreadable
  }
  if (!isDir) {
    res.status(400).json({ error: `Working directory does not exist: ${targetCwd}` });
    return;
  }
  res.json({ sessions: listImportableAgentSessions(agentId, targetCwd), supportsManualId: agentId !== 'mock' });
});

// 4. Create a new session
apiRouter.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { agentId, cwd, title, initialPrompt, model, importAgentSessionId } = req.body;
    if (!agentId || !cwd) {
      res.status(400).json({ error: 'agentId and cwd are required' });
      return;
    }
    if (!hasAgent(agentId)) {
      res.status(400).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    if (typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd must be a string' });
      return;
    }
    if (importAgentSessionId !== undefined && (typeof importAgentSessionId !== 'string' || !isSafeImportedSessionId(importAgentSessionId.trim()))) {
      res.status(400).json({ error: 'importAgentSessionId must be a valid agent session id' });
      return;
    }
    const targetCwd = path.resolve(cwd.replace(/^~/, os.homedir()));
    let isDir = false;
    try {
      isDir = fs.statSync(targetCwd).isDirectory();
    } catch {
      // missing or unreadable
    }
    if (!isDir) {
      res.status(400).json({ error: `Working directory does not exist: ${targetCwd}` });
      return;
    }
    const session = await sessionManager.createSession({
      agentId,
      cwd: targetCwd,
      title,
      model,
      initialPrompt,
      importAgentSessionId,
    });
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to start agent: ${err?.message || 'unknown error'}` });
  }
});

// 4. Get full session detail
apiRouter.get('/sessions/:id', (req: Request, res: Response) => {
  const session = sessionManager.getSession(sid(req));
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session });
});

// 4b. A Claude workflow run's phases and agents, and one agent's steps (read from its run folder)
function workflowTask(req: Request, res: Response): AgentTask | undefined {
  const session = sessionManager.getSession(sid(req));
  const task = session?.agentTasks?.find((t) => t.id === String(req.params.taskId));
  if (!session || !task || task.kind !== 'workflow') {
    res.status(404).json({ error: 'Workflow not found' });
    return undefined;
  }
  return task;
}

apiRouter.get('/sessions/:id/tasks/:taskId/workflow', (req: Request, res: Response) => {
  const task = workflowTask(req, res);
  if (!task) return;
  res.json({ run: readWorkflowRun(task) ?? null });
});

apiRouter.get('/sessions/:id/tasks/:taskId/workflow/agents/:agentId', (req: Request, res: Response) => {
  const task = workflowTask(req, res);
  if (!task) return;
  const detail = readWorkflowAgent(task, String(req.params.agentId));
  if (!detail) {
    res.status(404).json({ error: 'Agent not found in this workflow run' });
    return;
  }
  res.json(detail);
});

// 5. Send prompt to session
apiRouter.post('/sessions/:id/prompt', async (req: Request, res: Response) => {
  try {
    const { prompt, attachments } = req.body;
    if (!prompt && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: 'prompt or attachment is required' });
      return;
    }
    const id = sid(req);
    if (!store.get(id)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (sessionManager.isTurnInFlight(id)) {
      res.status(409).json({ error: new TurnInFlightError().message });
      return;
    }
    // sendPrompt runs asynchronously in host
    sessionManager.sendPrompt(id, prompt || '', attachments).catch((err) => {
      console.error(`[api] Error executing prompt for ${id}:`, err);
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Queue a prompt behind the running turn (sent at once when the session is free)
apiRouter.post('/sessions/:id/queue', async (req: Request, res: Response) => {
  try {
    const { prompt, attachments } = req.body;
    if (!prompt && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: 'prompt or attachment is required' });
      return;
    }
    if (!store.get(sid(req))) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(await sessionManager.queuePrompt(sid(req), prompt || '', attachments));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const queueError = (res: Response, err: any) =>
  res.status(err instanceof QueuedPromptNotFoundError ? 404 : 500).json({ error: err.message });

apiRouter.patch('/sessions/:id/queue/:queueId', (req: Request, res: Response) => {
  const { prompt } = req.body;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  try {
    const session = sessionManager.updateQueuedPrompt(sid(req), String(req.params.queueId), prompt);
    res.json({ queuedPrompts: session.queuedPrompts });
  } catch (err: any) {
    queueError(res, err);
  }
});

apiRouter.delete('/sessions/:id/queue/:queueId', (req: Request, res: Response) => {
  try {
    const session = sessionManager.removeQueuedPrompt(sid(req), String(req.params.queueId));
    res.json({ queuedPrompts: session.queuedPrompts });
  } catch (err: any) {
    queueError(res, err);
  }
});

apiRouter.post('/sessions/:id/queue/:queueId/send', async (req: Request, res: Response) => {
  try {
    await sessionManager.sendQueuedNow(sid(req), String(req.params.queueId));
    res.json({ ok: true });
  } catch (err: any) {
    queueError(res, err);
  }
});

// 6. Cancel prompt (stop active turn)
apiRouter.post('/sessions/:id/cancel', async (req: Request, res: Response) => {
  try {
    // Which control asked (Stop, End turn), for the log; anything else is recorded as the API
    const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 40) : 'api';
    await sessionManager.cancelPrompt(sid(req), source);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6b. Stop / Park underlying agent subprocess & terminal
apiRouter.post('/sessions/:id/stop', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.stopSessionAgent(sid(req));
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6c. Start / Resume underlying agent subprocess
apiRouter.post('/sessions/:id/start', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.startSessionAgent(sid(req));
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6d. Restore the agent that was running when CodePit last closed; nothing is sent again
apiRouter.post('/sessions/:id/restore', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.restoreSession(sid(req));
    res.json({ session });
  } catch (err: any) {
    restoreFailed(res, err);
  }
});

apiRouter.delete('/sessions/:id/restore', (req: Request, res: Response) => {
  if (!sessionManager.dismissRestore(sid(req))) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ ok: true });
});

// Resume later: { at, prompt? } pauses a running turn and sends prompt at `at`
function scheduleFailed(res: Response, err: any) {
  res.status(err instanceof ScheduleError ? err.status : 500).json({ error: err.message });
}

apiRouter.put('/sessions/:id/scheduled-resume', async (req: Request, res: Response) => {
  const parsed = parseScheduleRequest(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const session = await sessionManager.scheduleResume(sid(req), parsed.at, parsed.prompt);
    res.json({ scheduledResume: session.scheduledResume ?? null });
  } catch (err: any) {
    scheduleFailed(res, err);
  }
});

apiRouter.delete('/sessions/:id/scheduled-resume', (req: Request, res: Response) => {
  try {
    sessionManager.cancelScheduledResume(sid(req));
    res.json({ scheduledResume: null });
  } catch (err: any) {
    scheduleFailed(res, err);
  }
});

apiRouter.post('/sessions/:id/scheduled-resume/now', (req: Request, res: Response) => {
  try {
    sessionManager.resumeNow(sid(req));
    res.json({ ok: true });
  } catch (err: any) {
    scheduleFailed(res, err);
  }
});

// 7. Resolve permission
apiRouter.post('/sessions/:id/permission', async (req: Request, res: Response) => {
  try {
    const { optionId } = req.body;
    if (!optionId) {
      res.status(400).json({ error: 'optionId is required' });
      return;
    }
    const ok = await sessionManager.resolvePermission(sid(req), optionId);
    res.json({ ok });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7b. Answer a form the agent asked for: accept with content, decline (skip it) or cancel
apiRouter.post('/sessions/:id/elicitation', (req: Request, res: Response) => {
  const { requestId, action, content } = req.body || {};
  if (typeof requestId !== 'string' || !requestId) {
    res.status(400).json({ error: 'requestId is required' });
    return;
  }
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
    res.status(400).json({ error: 'action must be accept, decline or cancel' });
    return;
  }
  try {
    sessionManager.resolveElicitation(sid(req), requestId, action, content);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err instanceof ElicitationAnswerError ? err.status : 500).json({ error: err.message });
  }
});

// 8. Failover / Switch agent
apiRouter.post('/sessions/:id/switch', async (req: Request, res: Response) => {
  try {
    const { targetAgentId, model, archivePrevious, inPlace, customPrompt, skipInitialPrompt, contextMode } = req.body;
    if (!targetAgentId) {
      res.status(400).json({ error: 'targetAgentId is required' });
      return;
    }
    if (!hasAgent(targetAgentId)) {
      res.status(400).json({ error: `Unknown agent: ${targetAgentId}` });
      return;
    }
    const newSession = await sessionManager.switchAgent(sid(req), targetAgentId, {
      model,
      archivePrevious: Boolean(archivePrevious),
      inPlace: Boolean(inPlace),
      customPrompt: customPrompt ? String(customPrompt) : undefined,
      skipInitialPrompt: Boolean(skipInitialPrompt),
      contextMode,
    });
    res.json({ session: newSession });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Rollback / Undo turns in conversation
apiRouter.post('/sessions/:id/rollback', async (req: Request, res: Response) => {
  try {
    const { turnId, action } = req.body;
    const result = await sessionManager.rollbackSession(sid(req), {
      turnId,
      action: action || 'revert_to_this',
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compact the session's context; returns once it has started, progress streams over the socket
apiRouter.post('/sessions/:id/compact', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.compactSession(sid(req), { force: req.body?.force === true });
    res.json({ session });
  } catch (err: any) {
    const conflict = err instanceof TurnInFlightError || err instanceof NothingToCompactError || err instanceof AgentNotRunningError;
    res.status(conflict ? 409 : 500).json({ error: err.message });
  }
});

// "Compact when finished": { enabled, thresholdPercent }
apiRouter.put('/sessions/:id/auto-compact', (req: Request, res: Response) => {
  const setting = parseAutoCompact(req.body);
  if (!setting) {
    res.status(400).json({ error: 'Expected { enabled: boolean, thresholdPercent: number between 5 and 95 }' });
    return;
  }
  try {
    const session = sessionManager.setAutoCompact(sid(req), setting);
    res.json({ autoCompact: session.autoCompact });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Update agent / model / effort in-place in current session
apiRouter.patch('/sessions/:id/agent', async (req: Request, res: Response) => {
  try {
    const { agentId, model, effort, contextMode } = req.body;
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!hasAgent(agentId)) {
      res.status(400).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    // Only the shape is checked here: a level the new model lacks falls back to Auto with a note
    if (effort !== undefined && !isEffortValue(effort)) {
      res.status(400).json({ error: 'effort must be a short level name such as auto, low or high' });
      return;
    }
    const session = await sessionManager.setSessionAgent(sid(req), agentId, model, effort, contextMode);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update thinking / reasoning effort in current session
apiRouter.patch('/sessions/:id/effort', async (req: Request, res: Response) => {
  try {
    const { effort } = req.body;
    const current = sessionManager.getSession(sid(req));
    if (!current) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    // Checked against what this agent and model offer, e.g. Claude Opus: low..max, Claude Haiku: none
    const invalid = effortError(effort, effortChoicesFor(current.agentId, current.model, current.agentOptions));
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    const session = await sessionManager.setSessionEffort(sid(req), effort);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Set the agent session aside: the next message starts a new one with a summary, recent turns or nothing
apiRouter.post('/sessions/:id/agent-session/forget', async (req: Request, res: Response) => {
  const { contextMode = 'compact' } = req.body ?? {};
  if (!['compact', 'full', 'none'].includes(contextMode)) {
    res.status(400).json({ error: 'contextMode must be compact, full or none' });
    return;
  }
  try {
    res.json({ session: await sessionManager.forgetAgentSession(sid(req), contextMode) });
  } catch (err: any) {
    res.status(err instanceof TurnInFlightError ? 409 : 500).json({ error: err.message });
  }
});

// Claude's ultrathink (next message) and ultracode (every message, xhigh effort)
apiRouter.put('/sessions/:id/ultra', async (req: Request, res: Response) => {
  const { ultracode, ultrathinkNext } = req.body ?? {};
  if ((ultracode !== undefined && typeof ultracode !== 'boolean') || (ultrathinkNext !== undefined && typeof ultrathinkNext !== 'boolean')) {
    res.status(400).json({ error: 'ultracode and ultrathinkNext must be true or false' });
    return;
  }
  try {
    res.json({ session: await sessionManager.setSessionUltra(sid(req), { ultracode, ultrathinkNext }) });
  } catch (err: any) {
    res.status(err instanceof InvalidOptionError ? 400 : 500).json({ error: err.message });
  }
});

// Approval mode: one of the modes the agent offers (agentOptions.modes)
apiRouter.put('/sessions/:id/mode', async (req: Request, res: Response) => {
  const { mode } = req.body ?? {};
  if (typeof mode !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(mode)) {
    res.status(400).json({ error: 'mode must be a mode id such as default or acceptEdits' });
    return;
  }
  try {
    res.json({ session: await sessionManager.setSessionMode(sid(req), mode) });
  } catch (err: any) {
    res.status(err instanceof InvalidOptionError ? 400 : 500).json({ error: err.message });
  }
});

// Fast mode on or off
apiRouter.put('/sessions/:id/fast-mode', async (req: Request, res: Response) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' });
    return;
  }
  try {
    res.json({ session: await sessionManager.setSessionFastMode(sid(req), enabled) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Update user annotations (priority, pin, snooze, tags, cleanup)
apiRouter.patch('/sessions/:id/annotations', (req: Request, res: Response) => {
  const patch = parseAnnotations(req.body);
  if (typeof patch === 'string') {
    res.status(400).json({ error: patch });
    return;
  }
  const updated = sessionManager.updateAnnotations(sid(req), patch);
  if (!updated) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session: updated });
});

// The user has the session open: its finished turns are seen
apiRouter.post('/sessions/:id/seen', (req: Request, res: Response) => {
  if (!sessionManager.markSeen(sid(req))) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ ok: true });
});

const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;

/** Keeps only the known annotation fields, each of the right type; a string is the reason it was refused. */
export function parseAnnotations(body: unknown): Partial<UserAnnotations> | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected an object';
  const b = body as Record<string, unknown>;
  const out: Partial<UserAnnotations> = {};
  if ('priority' in b) {
    if (b.priority !== null && b.priority !== 'p0' && b.priority !== 'p1' && b.priority !== 'p2') return 'priority must be p0, p1, p2 or null';
    out.priority = b.priority;
  }
  for (const key of ['pinned', 'cleanup', 'autoApprove'] as const) {
    if (key in b) {
      if (typeof b[key] !== 'boolean') return `${key} must be true or false`;
      out[key] = b[key] as boolean;
    }
  }
  if ('snoozedUntil' in b) {
    if (b.snoozedUntil !== null && !(typeof b.snoozedUntil === 'number' && Number.isFinite(b.snoozedUntil))) return 'snoozedUntil must be a time or null';
    out.snoozedUntil = b.snoozedUntil as number | null;
  }
  if ('note' in b) {
    if (typeof b.note !== 'string') return 'note must be text';
    out.note = b.note.slice(0, 2000);
  }
  if ('tags' in b) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')) return 'tags must be a list of text';
    const tags: string[] = [];
    for (const raw of b.tags as string[]) {
      const tag = normalizeTag(raw);
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > MAX_TAGS) return `At most ${MAX_TAGS} tags`;
    out.tags = tags;
  }
  return out;
}

/** "#Infra Work " -> "infra-work": lower case, no leading #, spaces become dashes. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_./-]/gu, '')
    .slice(0, MAX_TAG_LENGTH);
}

// 10. Rename session title
apiRouter.patch('/sessions/:id/title', (req: Request, res: Response) => {
  const session = store.get(sid(req));
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  session.title = req.body.title || session.title;
  session.titleSource = 'user';
  store.save(session);
  res.json({ session });
});

// 11. Delete session
apiRouter.delete('/sessions/:id', (req: Request, res: Response) => {
  const ok = sessionManager.deleteSession(sid(req));
  res.json({ ok });
});

// 12. Search
apiRouter.get('/search', (req: Request, res: Response) => {
  const q = String(req.query.q || '');
  const matches = searchSessions(q);
  res.json({ sessions: matches });
});

// 13. Git info
apiRouter.get('/git', async (req: Request, res: Response) => {
  const cwd = String(req.query.cwd || '');
  const info = await getGitInfo(cwd);
  res.json({ git: info });
});

// 14. Suggest/Pick/Browse folders
apiRouter.get('/folders', (req: Request, res: Response) => {
  const rawPath = String(req.query.path || '').trim();
  const base = path.resolve(rawPath ? rawPath.replace(/^~/, os.homedir()) : os.homedir());
  try {
    if (!fs.existsSync(base)) {
      // A 404 lets the folder browser say the folder doesn't exist instead of
      // showing it as an empty folder.
      res.status(404).json({ error: `There's no folder at ${base}.` });
      return;
    }

    const stat = fs.statSync(base);
    if (!stat.isDirectory()) {
      res.json({
        current: path.dirname(base),
        parent: path.dirname(base) === '/' ? null : path.dirname(path.dirname(base)),
        isGit: false,
        recent: [],
        entries: [],
      });
      return;
    }

    const items = fs.readdirSync(base, { withFileTypes: true });
    const ignored = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'Pods']);
    const dirs = items
      .filter((i) => i.isDirectory() && !i.name.startsWith('.') && !ignored.has(i.name))
      .map((i) => {
        const fullPath = path.join(base, i.name);
        const isGit = fs.existsSync(path.join(fullPath, '.git'));
        return {
          name: i.name,
          path: fullPath,
          isGit,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const isGit = fs.existsSync(path.join(base, '.git'));
    const parent = base === '/' ? null : path.dirname(base);

    // Get recent session workspaces
    const sessions = store.getAll();
    const recentWorkspaces = Array.from(
      new Set(
        sessions
          .map((s) => s.cwd)
          .filter((cwd) => cwd && fs.existsSync(cwd))
      )
    ).slice(0, 8);

    res.json({
      current: base,
      parent,
      isGit,
      recent: recentWorkspaces,
      entries: dirs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to read directory' });
  }
});

// 14b. Native System Folder Picker (macOS Finder dialog)
apiRouter.post('/browse-native-folder', async (_req: Request, res: Response) => {
  if (process.platform !== 'darwin') {
    res.json({ supported: false, error: 'Native folder dialog only available on macOS' });
    return;
  }
  try {
    const script = 'POSIX path of (choose folder with prompt "Select Project Working Directory")';
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 60000 });
    const selected = stdout.trim().replace(/\/$/, '');
    res.json({ supported: true, selected });
  } catch (err: any) {
    if (err.message && (err.message.includes('User canceled') || err.message.includes('-128'))) {
      res.json({ supported: true, canceled: true });
    } else {
      res.json({ supported: false, error: err.message });
    }
  }
});

// 15. Subscriptions & Account Info
apiRouter.get('/subscriptions', (_req: Request, res: Response) => {
  try {
    const subscriptions = getVendorSubscriptions();
    res.json({ subscriptions });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get subscriptions' });
  }
});

// 16. Update Credentials / Auth Config
apiRouter.post('/subscriptions/config', (req: Request, res: Response) => {
  try {
    const { anthropicApiKey, openaiApiKey, geminiApiKey, preferredAuthMode } = req.body;
    const updated = saveStoredCredentials({
      anthropicApiKey,
      openaiApiKey,
      geminiApiKey,
      preferredAuthMode,
    });
    // Never echo raw API keys back to the browser
    res.json({ success: true, credentials: maskCredentials(updated), subscriptions: getVendorSubscriptions() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save credentials' });
  }
});

// 16b. Refresh Provider Rate Limits on Demand
apiRouter.post('/subscriptions/refresh-limits', async (_req: Request, res: Response) => {
  try {
    await Promise.all([refreshClaudeRateLimitsAsync(), refreshCodexRateLimitsAsync()]);
    res.json({ success: true, subscriptions: getVendorSubscriptions() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to refresh limits' });
  }
});

// 17. Aggregated Usage Report across vendors and sessions
apiRouter.get('/usage/summary', (_req: Request, res: Response) => {
  try {
    const summary = getUsageSummary();
    res.json({ usage: summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get usage summary' });
  }
});

// 18. Specific Session Usage Breakdown
apiRouter.get('/sessions/:id/usage', (req: Request, res: Response) => {
  try {
    const session = sessionManager.getSession(sid(req));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const cost = calculateSessionCost(session);
    res.json({
      sessionCost: cost,
      usage: session.usage,
      model: session.model,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get session usage' });
  }
});

// 19. Local Network (LAN) Access Info
async function networkInfo(req: Request) {
  const local = isHostClient(req);
  // Re-reading interfaces rebinds LAN listeners, so only the host machine triggers it
  const lan = local ? await lanAccess.refresh() : lanAccess.status();
  // A name only helps while something is listening on the LAN
  const hostname = lan.enabled ? getLanHostname() : null;
  return {
    port: lan.port,
    host: lan.host,
    lanEnabled: lan.enabled,
    ips: lan.addresses,
    localUrl: `http://127.0.0.1:${lan.port}`,
    // The mDNS name (e.g. my-mac.local): unlike the IPs it survives restarts and DHCP changes
    hostname,
    hostnameUrl: hostname ? `http://${hostname}:${lan.port}` : null,
    // Same addresses, labelled (Wi-Fi, VM bridge...) and best first, for the QR code picker
    lanInterfaces: await describeLanAddresses(lan.addresses),
    lanErrors: lan.errors,
    // Only the machine running the server may change who else can reach it
    canToggle: local && !lan.lockedReason,
    lockedReason: lan.lockedReason,
  };
}

apiRouter.get('/network', async (req: Request, res: Response) => {
  res.json(await networkInfo(req));
});

apiRouter.post('/network/lan', async (req: Request, res: Response) => {
  if (!isHostClient(req)) {
    res.status(403).json({ error: 'LAN access can only be changed on the computer running CodePit' });
    return;
  }
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' });
    return;
  }
  if (lanAccess.status().lockedReason) {
    res.status(409).json({ error: lanAccess.status().lockedReason });
    return;
  }
  try {
    await lanAccess.setEnabled(enabled);
    // Devices waiting to pair had no answer; with LAN off they could not use one anyway
    if (!enabled) devices.cancelPairing();
    res.json(await networkInfo(req));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to change LAN access' });
  }
});

function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function maskCredentials<T>(creds: T): T {
  if (!creds || typeof creds !== 'object') return creds;
  const out: Record<string, unknown> = { ...(creds as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (/key|token|secret/i.test(key)) out[key] = maskSecret(out[key]);
  }
  return out as T;
}
