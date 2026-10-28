import type { Request, Response } from 'express';
import { syncAgyMcpQuietly } from './agy-sync.js';
import { getMcpServer } from './config.js';
import { finishSignIn } from './oauth.js';

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f8;color:#1d1d1f}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#6e6e73}
@media (prefers-color-scheme:dark){body{background:#161618;color:#f2f2f3}p{color:#a1a1a6}}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(body)}</p></main></body></html>`;
}

/** The browser's return from an MCP server's sign-in page. */
export async function oauthCallbackHandler(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store').type('html');
  try {
    const serverId = await finishSignIn(req.query);
    syncAgyMcpQuietly();
    const name = getMcpServer(serverId)?.name ?? 'the server';
    res.send(page(`Signed in to ${name}`, 'You can close this tab and go back to CodePit. New agent sessions get the server from now on.'));
  } catch (err: any) {
    res.status(400).send(page('Sign-in failed', err?.message || 'Something went wrong'));
  }
}
