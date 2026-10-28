import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { getRemoteAddress, isLoopbackAddress } from '../security.js';
import { getMcpServer } from './config.js';
import { OAuthError, accessToken, checkProxyKey, isSignedIn } from './oauth.js';

/**
 * Agents reach a server CodePit signed in to through here: /mcp-oauth/<server id>.
 * Like CodePit's own MCP endpoint it sits outside the /api gate and takes only
 * loopback requests with no Origin header, carrying the server's proxy key. The
 * request goes on to the real server with the current access token, refreshed
 * (and the request sent once more) when the server turns the token down.
 */

const MAX_BODY = 4 * 1024 * 1024;
// Headers of the Streamable HTTP transport that go through in each direction
const FORWARD_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARD_RESPONSE = ['content-type', 'mcp-session-id', 'cache-control'];

const rpcError = (message: string) => ({ jsonrpc: '2.0', id: null, error: { code: -32001, message } });

async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function oauthProxyHandler(req: Request, res: Response): Promise<void> {
  if (!isLoopbackAddress(getRemoteAddress(req)) || req.headers.origin) {
    res.status(403).json(rpcError('Only agents on this machine may use this endpoint'));
    return;
  }
  const serverId = String(req.params.id);
  const key = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? '';
  const server = getMcpServer(serverId);
  if (!server || !key || !checkProxyKey(serverId, key)) {
    res.status(401).json(rpcError('Unknown server or key'));
    return;
  }
  if (!server.enabled || !isSignedIn(server)) {
    res.status(401).json(rpcError(`CodePit is not signed in to ${server.name}. Sign in from CodePit’s MCP settings.`));
    return;
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.headers ?? {})) if (k.toLowerCase() !== 'authorization') base[k] = v;
  for (const name of FORWARD_REQUEST) {
    const v = req.headers[name];
    if (typeof v === 'string') base[name] = v;
  }

  // The agent hanging up ends the upstream request, long-lived event streams included
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const send = async (force: boolean) =>
    fetch(server.url!, {
      method: req.method,
      headers: { ...base, Authorization: `Bearer ${await accessToken(serverId, { force })}` },
      body: body?.length ? new Uint8Array(body) : undefined,
      signal: controller.signal,
    });

  let upstream: globalThis.Response;
  try {
    upstream = await send(false);
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      upstream = await send(true);
    }
  } catch (err: any) {
    if (controller.signal.aborted) return;
    const message = err instanceof OAuthError ? `${server.name}: ${err.message}` : `Couldn't reach ${server.name}: ${err?.cause?.message || err.message}`;
    res.status(err instanceof OAuthError ? 401 : 502).json(rpcError(message));
    return;
  }

  // WWW-Authenticate stays behind: the agent would try to sign in itself, which it can't
  res.status(upstream.status);
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v) res.setHeader(name, v);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  Readable.fromWeb(upstream.body as any)
    .on('error', () => res.destroy())
    .pipe(res);
}
