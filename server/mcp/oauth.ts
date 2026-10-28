import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAppDir, ensurePrivateDir, FILE_MODE } from '../paths.js';
import type { McpOAuthView, McpServerConfig } from '../types.js';

// Signing in to MCP servers that use OAuth (the MCP authorization spec): find the
// authorization server from the 401 the MCP server answers with, register CodePit
// as a client, run the authorization code flow with PKCE in the user's browser
// with a loopback redirect, and keep the tokens fresh. Agents can't do any of this
// over ACP, so they never see these tokens: they reach a signed-in server through
// CodePit's loopback proxy (oauth-proxy.ts), which adds the current access token.

const TIMEOUT_MS = 15_000;
const PENDING_TTL_MS = 10 * 60_000;
// Refresh this long before the token runs out, so a request never leaves with a dying one
const REFRESH_EARLY_MS = 60_000;
const PROTOCOL_VERSION = '2025-06-18';
/**
 * CodePit's client ID metadata document (the MCP spec's preferred registration):
 * an HTTPS URL that is the client ID, serving a JSON description of CodePit.
 * The source is oauth/client-metadata.json in the repo.
 */
export const CLIENT_METADATA_URL = 'https://ritwik-g.github.io/codepit/oauth/client-metadata.json';
const clientMetadataUrl = () => process.env.CODEPIT_OAUTH_CLIENT_METADATA_URL || CLIENT_METADATA_URL;

export class OAuthError extends Error {}

/** Everything kept per server in mcp-oauth.json. */
interface OAuthRecord {
  /** The MCP server URL this sign-in is for; a different URL means signing in again. */
  url: string;
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** How the token endpoint wants the client to prove itself. */
  clientAuth: 'none' | 'client_secret_post' | 'client_secret_basic';
  /** The redirect URI the client was registered with. */
  redirectUri: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  signedInAt?: number;
  /** Set when a refresh was refused: the user has to sign in again. */
  expired?: boolean;
  /** What agents send the proxy for this server. Kept across sign-ins so agy's file stays put. */
  proxyKey: string;
}

interface StoreFile {
  version: 1;
  servers: Record<string, OAuthRecord>;
}

export function getOAuthFile(): string {
  return path.join(getAppDir(), 'mcp-oauth.json');
}

function readStore(): StoreFile {
  try {
    const raw = JSON.parse(fs.readFileSync(getOAuthFile(), 'utf8'));
    if (raw && typeof raw.servers === 'object' && !Array.isArray(raw.servers)) return { version: 1, servers: raw.servers };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn(`[mcp-oauth] ${getOAuthFile()} unreadable, treating as empty: ${err.message}`);
  }
  return { version: 1, servers: {} };
}

function writeStore(store: StoreFile): void {
  ensurePrivateDir(getAppDir());
  const file = getOAuthFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: FILE_MODE, encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

function getRecord(serverId: string): OAuthRecord | undefined {
  return readStore().servers[serverId];
}

function putRecord(serverId: string, record: OAuthRecord): void {
  const store = readStore();
  store.servers[serverId] = record;
  writeStore(store);
}

/** Drop a server's sign-in, e.g. when the server is removed. */
export function forgetOAuth(serverId: string): void {
  const store = readStore();
  if (!store.servers[serverId]) return;
  delete store.servers[serverId];
  writeStore(store);
}

/** Sign out but keep the client registration and proxy key for the next sign-in. */
export function signOut(serverId: string): void {
  const record = getRecord(serverId);
  if (!record) return;
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, signedInAt: _s, expired: _x, ...rest } = record;
  putRecord(serverId, rest);
}

/** OAuth applies to Streamable HTTP servers: the proxy speaks only that transport. */
export const canSignIn = (server: McpServerConfig) => server.transport === 'http';

/** A sign-in that still holds for this server: same URL, and tokens CodePit can use or refresh. */
export function isSignedIn(server: McpServerConfig): boolean {
  const r = getRecord(server.id);
  return Boolean(canSignIn(server) && r && r.url === server.url && r.accessToken && !r.expired);
}

export function oauthView(server: McpServerConfig): McpOAuthView | undefined {
  const r = getRecord(server.id);
  if (!canSignIn(server) || !r || r.url !== server.url || !(r.accessToken || r.expired)) return undefined;
  return {
    signedIn: Boolean(r.accessToken && !r.expired),
    expired: r.expired || undefined,
    issuer: r.issuer,
    signedInAt: r.signedInAt,
    expiresAt: r.expiresAt,
    canRefresh: Boolean(r.refreshToken),
  };
}

// ------------------------------------------------------------------ endpoints

let callbackUrl: string | null = null;
let proxyBase: string | null = null;

/** Set once the server listens. Null proxy base: agents can't reach CodePit on loopback. */
export function setOAuthEndpoints(opts: { callbackUrl: string | null; proxyBase: string | null }): void {
  callbackUrl = opts.callbackUrl;
  proxyBase = opts.proxyBase;
}

/** The URL and header an agent uses to reach a signed-in server, or why it can't. */
export function proxyEntry(server: McpServerConfig): { url: string; headers: Record<string, string> } | { skipped: string } {
  const r = getRecord(server.id);
  if (!proxyBase) return { skipped: 'CodePit is not listening on this machine’s loopback address, which signed-in servers go through' };
  if (!r) return { skipped: 'Not signed in' };
  return { url: `${proxyBase}/${encodeURIComponent(server.id)}`, headers: { Authorization: `Bearer ${r.proxyKey}` } };
}

/** The server a proxy key belongs to, compared in constant time. */
export function checkProxyKey(serverId: string, key: string): boolean {
  const r = getRecord(serverId);
  if (!r) return false;
  const a = Buffer.from(r.proxyKey);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ discovery

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; callers look at the status
  }
  return { status: res.status, json, headers: res.headers };
}

/** `Bearer resource_metadata="…", scope="a b"` → its parameters. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || !/^\s*bearer\b/i.test(header)) return out;
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (let m; (m = re.exec(header)); ) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  return out;
}

/** `https://h/a/b` → [`https://h/.well-known/<name>/a/b`, `https://h/.well-known/<name>`]. */
function wellKnown(base: string, name: string, alsoAppend = false): string[] {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  const out = p ? [`${u.origin}/.well-known/${name}${p}`] : [];
  if (p && alsoAppend) out.push(`${u.origin}${p}/.well-known/${name}`);
  out.push(`${u.origin}/.well-known/${name}`);
  return out;
}

interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface Discovery {
  resource: string;
  scope?: string;
  as: AuthServer;
}

/** Find where to sign in for an MCP server: the spec's flow, with the 2025-03-26 fallbacks. */
export async function discover(server: McpServerConfig): Promise<Discovery> {
  const url = server.url ?? '';
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'authorization'));
  // An unauthenticated initialize: a server that wants OAuth answers 401 and says where to look
  let challenge: Record<string, string> = {};
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'codepit', version: '0.1.0' } },
      }),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 401) challenge = parseWwwAuthenticate(res.headers.get('www-authenticate'));
  } catch (err: any) {
    throw new OAuthError(`Couldn't reach ${url}: ${err?.cause?.message || err.message}`);
  }

  let prm: any = null;
  const prmUrls = [...(challenge.resource_metadata ? [challenge.resource_metadata] : []), ...wellKnown(url, 'oauth-protected-resource')];
  for (const candidate of prmUrls) {
    const r = await fetchJson(candidate).catch(() => null);
    if (r?.status === 200 && r.json && typeof r.json === 'object') {
      prm = r.json;
      break;
    }
  }

  const u = new URL(url);
  const resource = typeof prm?.resource === 'string' ? prm.resource : `${u.origin}${u.pathname}`;
  const issuer: string = Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === 'string' ? prm.authorization_servers[0] : u.origin;

  let as: AuthServer | null = null;
  for (const candidate of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration', true)]) {
    const r = await fetchJson(candidate).catch(() => null);
    if (r?.status === 200 && r.json?.authorization_endpoint && r.json?.token_endpoint) {
      as = r.json;
      break;
    }
  }
  if (!as) {
    // 2025-03-26 servers without metadata: the default endpoints on the MCP server's origin
    if (prm) throw new OAuthError(`Couldn't read the sign-in settings of ${issuer}`);
    as = { issuer: u.origin, authorization_endpoint: `${u.origin}/authorize`, token_endpoint: `${u.origin}/token`, registration_endpoint: `${u.origin}/register` };
  }
  const methods = as.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) throw new OAuthError(`${issuer} doesn't support PKCE with S256, which CodePit requires`);

  const scopes = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(' ') : undefined;
  return { resource, scope: challenge.scope || scopes || undefined, as: { ...as, issuer: as.issuer || issuer } };
}

// ------------------------------------------------------------------ sign-in

interface Pending {
  serverId: string;
  verifier: string;
  record: OAuthRecord;
  /** The server promised to name itself in the redirect (RFC 9207), so a missing or other name is refused. */
  expectIss: boolean;
  createdAt: number;
}

const pending = new Map<string, Pending>();

const b64url = (buf: Buffer) => buf.toString('base64url');

function prunePending(): void {
  for (const [state, p] of pending) if (Date.now() - p.createdAt > PENDING_TTL_MS) pending.delete(state);
}

/** Loopback redirects are what the metadata document lists; ports may differ (RFC 8252). */
const isLoopbackRedirect = (uri: string) => /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?\//.test(uri);

async function register(as: AuthServer, redirectUri: string, scope?: string): Promise<Pick<OAuthRecord, 'clientId' | 'clientSecret' | 'clientAuth'>> {
  // A metadata document needs no registration call: the authorization server reads it from its URL
  if (as.client_id_metadata_document_supported && isLoopbackRedirect(redirectUri)) {
    return { clientId: clientMetadataUrl(), clientAuth: 'none' };
  }
  if (!as.registration_endpoint) {
    throw new OAuthError(`${as.issuer} doesn't let apps register themselves, so CodePit can't sign in to it. Put a token in the headers instead.`);
  }
  const r = await fetchJson(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'CodePit',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    }),
  });
  if (r.status >= 300 || typeof r.json?.client_id !== 'string') {
    throw new OAuthError(`${as.issuer} refused to register CodePit (HTTP ${r.status}${r.json?.error_description ? `: ${r.json.error_description}` : ''})`);
  }
  const method = r.json.token_endpoint_auth_method;
  const clientAuth = method === 'client_secret_basic' || method === 'client_secret_post' ? method : r.json.client_secret ? 'client_secret_post' : 'none';
  return { clientId: r.json.client_id, clientSecret: r.json.client_secret || undefined, clientAuth };
}

/** Start a sign-in: the page to open in the browser. The callback finishes it. */
export async function startSignIn(server: McpServerConfig): Promise<{ authorizeUrl: string }> {
  if (!canSignIn(server)) throw new OAuthError('Sign-in works with Streamable HTTP servers only');
  if (!callbackUrl) throw new OAuthError('CodePit is not listening where a browser on this machine can reach it');
  const found = await discover(server);
  const prev = getRecord(server.id);
  // Reuse the registration when it was made for the same authorization server and redirect
  const client =
    prev && prev.issuer === found.as.issuer && prev.redirectUri === callbackUrl && prev.tokenEndpoint === found.as.token_endpoint
      ? { clientId: prev.clientId, clientSecret: prev.clientSecret, clientAuth: prev.clientAuth }
      : await register(found.as, callbackUrl, found.scope);

  const record: OAuthRecord = {
    url: server.url ?? '',
    resource: found.resource,
    issuer: found.as.issuer,
    authorizationEndpoint: found.as.authorization_endpoint,
    tokenEndpoint: found.as.token_endpoint,
    ...client,
    redirectUri: callbackUrl,
    scope: found.scope,
    proxyKey: prev?.proxyKey ?? b64url(crypto.randomBytes(32)),
  };
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(32));
  prunePending();
  pending.set(state, { serverId: server.id, verifier, record, expectIss: Boolean(found.as.authorization_response_iss_parameter_supported), createdAt: Date.now() });

  const auth = new URL(record.authorizationEndpoint);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', record.clientId);
  auth.searchParams.set('redirect_uri', record.redirectUri);
  auth.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  auth.searchParams.set('resource', record.resource);
  if (record.scope) auth.searchParams.set('scope', record.scope);
  return { authorizeUrl: auth.toString() };
}

async function tokenRequest(record: OAuthRecord, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, resource: record.resource });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (record.clientAuth === 'client_secret_basic' && record.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(record.clientId)}:${encodeURIComponent(record.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', record.clientId);
    if (record.clientAuth === 'client_secret_post' && record.clientSecret) body.set('client_secret', record.clientSecret);
  }
  const r = await fetchJson(record.tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  if (r.status !== 200 || typeof r.json?.access_token !== 'string') {
    const err = new OAuthError(r.json?.error_description || r.json?.error || `The token endpoint answered HTTP ${r.status}`);
    (err as any).code = r.json?.error;
    throw err;
  }
  return r.json;
}

function withTokens(record: OAuthRecord, json: any): OAuthRecord {
  const expiresIn = Number(json.expires_in);
  return {
    ...record,
    accessToken: json.access_token,
    // A refresh answer may leave the refresh token out: the old one still holds
    refreshToken: json.refresh_token || record.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    expired: undefined,
  };
}

/** The browser came back to the redirect URI. Returns the server it signed in to. */
export async function finishSignIn(query: Record<string, unknown>): Promise<string> {
  const state = typeof query.state === 'string' ? query.state : '';
  const p = pending.get(state);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) throw new OAuthError('This sign-in is unknown or has run out of time. Start it again from CodePit.');
  pending.delete(state);
  if (typeof query.error === 'string') {
    throw new OAuthError(typeof query.error_description === 'string' ? query.error_description : `Sign-in refused (${query.error})`);
  }
  // Mix-up defence: the code must come from the server this sign-in was started with
  if ((p.expectIss || typeof query.iss === 'string') && query.iss !== p.record.issuer) {
    throw new OAuthError('The sign-in answer came from a different authorization server than the one asked. Nothing was saved.');
  }
  const code = typeof query.code === 'string' ? query.code : '';
  if (!code) throw new OAuthError('The sign-in page sent no authorization code');
  const json = await tokenRequest(p.record, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.record.redirectUri,
    code_verifier: p.verifier,
  });
  putRecord(p.serverId, { ...withTokens(p.record, json), signedInAt: Date.now() });
  return p.serverId;
}

// ------------------------------------------------------------------ tokens

const refreshing = new Map<string, Promise<string>>();

async function refresh(serverId: string, record: OAuthRecord): Promise<string> {
  let run = refreshing.get(serverId);
  if (!run) {
    run = (async () => {
      try {
        const json = await tokenRequest(record, { grant_type: 'refresh_token', refresh_token: record.refreshToken! });
        const next = withTokens(record, json);
        // Read again: a sign-out while this ran wins
        if (getRecord(serverId)?.accessToken) putRecord(serverId, next);
        return next.accessToken!;
      } catch (err: any) {
        // Refused for good (revoked, expired): the user signs in again. A network error keeps the tokens.
        if (err instanceof OAuthError && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes((err as any).code)) {
          const current = getRecord(serverId);
          if (current) putRecord(serverId, { ...current, accessToken: undefined, refreshToken: undefined, expired: true });
          throw new OAuthError('The sign-in has expired. Sign in again in CodePit’s MCP settings.');
        }
        throw err;
      } finally {
        refreshing.delete(serverId);
      }
    })();
    refreshing.set(serverId, run);
  }
  return run;
}

/**
 * A usable access token for the server, refreshed first when it is about to run
 * out (or always, with `force`, after the server turned the current one down).
 */
export async function accessToken(serverId: string, opts: { force?: boolean } = {}): Promise<string> {
  const record = getRecord(serverId);
  if (!record?.accessToken) {
    throw new OAuthError(record?.expired ? 'The sign-in has expired. Sign in again in CodePit’s MCP settings.' : 'Not signed in');
  }
  const stale = opts.force || (record.expiresAt !== undefined && record.expiresAt - REFRESH_EARLY_MS < Date.now());
  if (!stale) return record.accessToken;
  if (!record.refreshToken) {
    if (opts.force || (record.expiresAt ?? Infinity) < Date.now()) {
      putRecord(serverId, { ...record, accessToken: undefined, expired: true });
      throw new OAuthError('The sign-in has expired. Sign in again in CodePit’s MCP settings.');
    }
    return record.accessToken;
  }
  return refresh(serverId, record);
}
