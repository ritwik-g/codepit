import fs from 'node:fs';
import os from 'node:os';
import { Router, type Request, type Response } from 'express';
import { hasAgent } from '../agents/registry.js';
import {
  McpConfigError,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  setMcpServerEnabled,
  toView as maskView,
  updateMcpServer,
} from './config.js';
import { MemoryGraphError, isMemoryServer, readMemoryGraph } from './memory-graph.js';
import type { McpServerConfig, McpServerView } from '../types.js';
import { listPresets, presetToInput } from './presets.js';
import { probeMcpServer } from './probe.js';
import { inspectEcosystems } from './inspect.js';
import { agySyncStatus, syncAgyMcpQuietly } from './agy-sync.js';

export const mcpRouter = Router();

const toView = (server: McpServerConfig): McpServerView => ({ ...maskView(server), memoryGraph: isMemoryServer(server) });

const id = (req: Request) => String(req.params.id);

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof McpConfigError) {
    res.status(err.message === 'MCP server not found' ? 404 : 400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error)?.message || fallback });
}

function checkScope(scope: unknown): void {
  if (scope !== undefined && scope !== 'all' && !hasAgent(scope)) throw new McpConfigError(`Unknown agent: ${String(scope)}`);
}

mcpRouter.get('/servers', (_req, res) => {
  res.json({ servers: listMcpServers().map(toView), agy: agySyncStatus() });
});

// Every change is carried into agy's settings straight away, so Antigravity sees it next time it starts
mcpRouter.use((req, res, next) => {
  if (req.method === 'GET' || req.path.endsWith('/test')) return next();
  res.on('finish', () => {
    if (res.statusCode < 400) syncAgyMcpQuietly();
  });
  next();
});

mcpRouter.post('/servers', (req, res) => {
  try {
    checkScope(req.body?.scope);
    res.json({ server: toView(createMcpServer(req.body ?? {})) });
  } catch (err) {
    fail(res, err, 'Failed to add the MCP server');
  }
});

mcpRouter.post('/servers/from-preset', (req, res) => {
  try {
    const { presetId, inputs, scope } = req.body ?? {};
    checkScope(scope);
    res.json({ server: toView(createMcpServer(presetToInput(String(presetId), inputs, scope ?? 'all'))) });
  } catch (err) {
    fail(res, err, 'Failed to add the preset');
  }
});

mcpRouter.put('/servers/:id', (req, res) => {
  try {
    checkScope(req.body?.scope);
    res.json({ server: toView(updateMcpServer(id(req), req.body ?? {})) });
  } catch (err) {
    fail(res, err, 'Failed to save the MCP server');
  }
});

mcpRouter.patch('/servers/:id/enabled', (req, res) => {
  try {
    res.json({ server: toView(setMcpServerEnabled(id(req), Boolean(req.body?.enabled))) });
  } catch (err) {
    fail(res, err, 'Failed to update the MCP server');
  }
});

mcpRouter.delete('/servers/:id', (req, res) => {
  if (!deleteMcpServer(id(req))) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  res.json({ ok: true });
});

mcpRouter.post('/servers/:id/test', async (req, res) => {
  const server = getMcpServer(id(req));
  if (!server) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  // ${workspace} resolves to the folder the user is looking at, else the home folder
  const cwd = typeof req.body?.cwd === 'string' && fs.existsSync(req.body.cwd) && fs.statSync(req.body.cwd).isDirectory()
    ? req.body.cwd
    : os.homedir();
  res.json({ result: await probeMcpServer(server, cwd), cwd });
});

// Read-only: the file is the server's own MEMORY_FILE_PATH. ?since=<version> answers
// { unchanged: true } until the file changes, so the viewer can poll cheaply.
mcpRouter.get('/servers/:id/memory-graph', (req, res) => {
  const server = getMcpServer(id(req));
  if (!server) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  try {
    const graph = readMemoryGraph(server, typeof req.query.since === 'string' ? req.query.since : undefined);
    res.set('Cache-Control', 'no-store').json(graph ? { graph } : { unchanged: true });
  } catch (err) {
    if (err instanceof MemoryGraphError) res.status(err.status).json({ error: err.message });
    else fail(res, err, 'Failed to read the memory graph');
  }
});

mcpRouter.get('/presets', (_req, res) => {
  res.json({ presets: listPresets() });
});

mcpRouter.get('/ecosystems', async (req, res) => {
  try {
    res.json({ ecosystems: await inspectEcosystems(req.query.refresh === '1') });
  } catch (err) {
    fail(res, err, 'Failed to inspect agent plugins');
  }
});
