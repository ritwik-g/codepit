import crypto from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import { readCodepitMcpSettings } from './settings.js';

// Who may call CodePit's MCP server. Each CodePit session gets its own bearer token,
// handed to its agent with the server's URL; the server knows the caller from the
// token alone. Tokens live in memory only: agents are child processes of this run,
// and every start sends the server again (session/new and session/resume alike).

export const CODEPIT_MCP_NAME = 'codepit';

let endpointUrl: string | null = null;
const tokenToSession = new Map<string, string>();
const sessionToToken = new Map<string, string>();

/** Set once the server listens; null when it is not reachable on loopback. */
export function setCodepitMcpEndpoint(url: string | null): void {
  endpointUrl = url;
}

export function codepitMcpEndpoint(): string | null {
  return endpointUrl;
}

/** The session's token, the same one for as long as this run of CodePit lasts. */
export function tokenFor(sessionId: string): string {
  let token = sessionToToken.get(sessionId);
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    sessionToToken.set(sessionId, token);
    tokenToSession.set(token, sessionId);
  }
  return token;
}

/** The CodePit session a token belongs to. */
export function sessionForToken(token: string): string | null {
  return tokenToSession.get(token) ?? null;
}

export function revokeToken(sessionId: string): void {
  const token = sessionToToken.get(sessionId);
  if (!token) return;
  sessionToToken.delete(sessionId);
  tokenToSession.delete(token);
}

/**
 * The server entry for an agent session, or why it is left out (undefined: not
 * turned on for this agent, so nothing is said about it).
 */
export function codepitMcpEntry(
  sessionId: string,
  agentId: string,
  caps: { http?: boolean } | undefined,
  takenNames: string[]
): { server: acp.McpServer } | { skipped: string } | undefined {
  const settings = readCodepitMcpSettings();
  if (!settings.enabled || !settings.agents.includes(agentId)) return undefined;
  if (!endpointUrl) return { skipped: 'CodePit is not listening on this machine’s loopback address' };
  if (!caps?.http) return { skipped: 'This agent does not accept HTTP MCP servers' };
  if (takenNames.some((n) => n.toLowerCase() === CODEPIT_MCP_NAME)) return { skipped: `Another MCP server is already called ${CODEPIT_MCP_NAME}` };
  return {
    server: {
      type: 'http',
      name: CODEPIT_MCP_NAME,
      url: endpointUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${tokenFor(sessionId)}` }],
    },
  };
}
