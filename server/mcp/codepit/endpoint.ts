import type { Request, Response } from 'express';
import { getRemoteAddress, isLoopbackAddress } from '../../security.js';
import { store } from '../../store.js';
import { writeAudit, type AuditCaller } from './audit.js';
import { sessionForToken } from './access.js';
import { readCodepitMcpSettings } from './settings.js';
import { ToolError, callTool, listTools } from './tools.js';
import type { AcpSession } from '../../types.js';

/**
 * CodePit's own MCP server (Streamable HTTP, answering every request with JSON, no
 * event stream). It sits outside the /api gate on purpose: agents are not the app and
 * carry no app key. Instead a request must come from this machine's loopback address,
 * must not come from a browser page (no Origin header), and must carry the bearer token
 * of a CodePit session, which is who the call is made as. A token opens nothing else.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'CodePit is the app running this session. Its tools start new sessions to hand work to (create_session), find and check on other ' +
  'sessions by CodePit id, title, agent session id or Claude session name (list_sessions, find_session, get_session), tag and link ' +
  'sessions so related work is grouped (tag_session, link_sessions), and tell this session who it is (whoami). Every call is recorded ' +
  "in CodePit's audit log.";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function callerOf(s: AcpSession): AuditCaller {
  return { sessionId: s.id, title: s.title, agentId: s.agentId, agentSessionId: s.agentSessionId };
}

async function handle(msg: RpcMessage, caller: AcpSession): Promise<object | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isRequest ? rpcError(msg.id, -32600, 'Invalid request') : null;
  // Notifications (initialized, cancelled) need no answer
  if (!isRequest) return null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codepit', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: listTools() });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = msg.params?.arguments;
      const started = Date.now();
      const settings = readCodepitMcpSettings();
      try {
        if (!settings.enabled) throw new ToolError("CodePit's MCP server has been turned off in CodePit");
        const out = await callTool(caller, name, args, settings);
        writeAudit({ caller: callerOf(caller), method: msg.method, tool: name, args, ok: true, sessions: out.sessions, ms: Date.now() - started });
        return reply({ content: [{ type: 'text', text: JSON.stringify(out.result, null, 2) }], structuredContent: out.result });
      } catch (err: any) {
        const message = err instanceof ToolError ? err.message : `CodePit failed: ${err?.message || err}`;
        if (!(err instanceof ToolError)) console.error(`[codepit-mcp] ${name} failed:`, err);
        writeAudit({ caller: callerOf(caller), method: msg.method, tool: name, args, ok: false, error: message, ms: Date.now() - started });
        return reply({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function codepitMcpHandler(req: Request, res: Response): Promise<void> {
  const refuse = (status: number, error: string, caller?: AcpSession) => {
    writeAudit({ ...(caller ? { caller: callerOf(caller) } : {}), method: `${req.method} ${req.path}`, ok: false, error });
    res.status(status).json({ error });
  };
  if (!isLoopbackAddress(getRemoteAddress(req))) return refuse(403, 'Only reachable from this machine');
  if (req.headers.origin) return refuse(403, 'Not for browser pages');
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const sessionId = token ? sessionForToken(token) : null;
  const caller = sessionId ? store.get(sessionId) : null;
  if (!caller) return refuse(401, 'Unknown or missing session token');
  if (req.method !== 'POST') {
    // No server-initiated stream and no session to end
    res.status(405).set('Allow', 'POST').end();
    return;
  }
  const body = req.body;
  const batch = Array.isArray(body);
  const messages: RpcMessage[] = batch ? body : [body];
  if (messages.length === 0 || messages.length > 50) {
    res.status(400).json(rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const replies = (await Promise.all(messages.map((m) => handle(m ?? {}, caller)))).filter((r): r is object => r !== null);
  if (replies.length === 0) {
    res.status(202).end();
    return;
  }
  res.json(batch ? replies : replies[0]);
}
