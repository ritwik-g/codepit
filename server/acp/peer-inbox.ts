import fs from 'node:fs';

/**
 * Messages other Claude sessions send this one (SendMessage). The ACP adapter drops plain-text
 * user messages from its feed, and a received message is one, so CodePit reads them from the
 * session's own transcript instead: user entries whose `origin.kind` is `peer`.
 */
export interface PeerMessage {
  /** The sender's address, which the agent replies to. */
  from: string;
  fromName?: string;
  text: string;
}

const POLL_MS = 500;

const PEER_MESSAGE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/;

const unescapeAttr = (v: string) =>
  v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The message a transcript entry carries, when it is one another session sent. */
export function peerMessageOf(entry: any): PeerMessage | null {
  const origin = entry?.origin;
  if (entry?.type !== 'user' || origin?.kind !== 'peer') return null;
  const content = entry.message?.content;
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
  // `origin` carries the body and sender; the wrapped text is the fallback
  const wrapped = raw.match(PEER_MESSAGE);
  const attr = (name: string) => {
    const v = wrapped?.[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    return v ? unescapeAttr(v) : undefined;
  };
  const text = (typeof origin.body === 'string' ? origin.body : wrapped?.[2] ?? '').trim();
  if (!text) return null;
  const fromName = typeof origin.name === 'string' && origin.name ? origin.name : attr('from-name');
  const from = (typeof origin.from === 'string' && origin.from) || attr('from') || fromName || 'another session';
  return { from, ...(fromName ? { fromName } : {}), text };
}

/**
 * Follow a session transcript and call `onMessage` for each message from another session
 * appended after this starts, for as long as `alive` says. Returns a function that stops it.
 */
export function watchPeerMessages(file: string, alive: () => boolean, onMessage: (peer: PeerMessage) => void): () => void {
  let offset = 0;
  try {
    offset = fs.statSync(file).size; // what is already there was received before this run
  } catch {
    // not written yet: everything in it will be new
  }
  let partial = '';
  const seen = new Set<string>();
  const read = () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // rewritten
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.includes('"peer"')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const peer = peerMessageOf(entry);
      const key = entry.origin?.msg_id || entry.uuid;
      if (!peer || (key && seen.has(key))) continue;
      if (key) seen.add(key);
      onMessage(peer);
    }
  };
  const timer = setInterval(() => {
    if (!alive()) {
      clearInterval(timer);
      return;
    }
    try {
      read();
    } catch {
      // a transient read error; the next poll tries again
    }
  }, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
