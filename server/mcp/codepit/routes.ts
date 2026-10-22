import { Router } from 'express';
import { DEFAULT_CODEPIT_MCP, parseCodepitMcpSettings, readCodepitMcpSettings, writeCodepitMcpSettings } from './settings.js';
import { auditLogFile, readAudit } from './audit.js';
import { codepitMcpEndpoint } from './access.js';
import { listTools } from './tools.js';

// The app's view of CodePit's own MCP server: its settings, its tools and its audit log

export const codepitMcpRouter = Router();

const view = () => {
  const settings = readCodepitMcpSettings();
  return { settings, defaults: DEFAULT_CODEPIT_MCP, reachable: codepitMcpEndpoint() !== null, tools: listTools(settings), auditLog: auditLogFile() };
};

codepitMcpRouter.get('/', (_req, res) => {
  res.json(view());
});

codepitMcpRouter.put('/', (req, res) => {
  const next = parseCodepitMcpSettings(req.body, readCodepitMcpSettings());
  if (typeof next === 'string') {
    res.status(400).json({ error: next });
    return;
  }
  try {
    writeCodepitMcpSettings(next);
  } catch (err: any) {
    res.status(500).json({ error: `Could not save the settings: ${err.message}` });
    return;
  }
  res.json(view());
});

codepitMcpRouter.get('/audit', (req, res) => {
  const limit = Number(req.query.limit) || undefined;
  const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined;
  res.json({ entries: readAudit({ limit, sessionId }) });
});
