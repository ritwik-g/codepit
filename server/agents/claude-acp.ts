/**
 * Runs Claude's ACP adapter with one change: each session's output is read from the moment
 * the session opens, not from its first prompt.
 *
 *   claude-acp <adapter's dist/index.js> [args...]
 *
 * The adapter starts the loop that forwards the agent's output on the first prompt it is
 * sent. Before that, a turn the agent starts on its own (a message from another session,
 * a background task finishing) runs unseen: nothing shows until the user sends something,
 * and then all of it arrives at once. Starting that loop when a session is created, resumed
 * or loaded puts the agent in the state it is in after any prompt has ended, which the
 * adapter already handles.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: claude-acp <claude-agent-acp dist/index.js> [args...]');
  process.exit(2);
}

const { ClaudeAcpAgent } = await import(pathToFileURL(path.join(path.dirname(path.resolve(entry)), 'acp-agent.js')).href);
const proto = ClaudeAcpAgent?.prototype;

if (typeof proto?.ensureConsumer === 'function') {
  for (const method of ['newSession', 'resumeSession', 'loadSession', 'unstable_forkSession']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = async function (this: any, params: any) {
      const result = await original.call(this, params);
      const id = result?.sessionId ?? params?.sessionId;
      const session = id ? this.sessions?.[id] : undefined;
      if (session && !session.consumer) this.ensureConsumer(session, id);
      return result;
    };
  }
} else {
  // A newer adapter that renamed it: run it unchanged, output then waits for a prompt as before
  console.error('[claude-acp] ensureConsumer not found; running the adapter unchanged');
}

// The adapter sees the argv it would have had if run directly: [execPath, entry, ...args]
process.argv.splice(1, 1);
await import(pathToFileURL(path.resolve(entry)).href);
