import { store } from './store.js';
import type { AcpSession } from './types.js';

export function searchSessions(query: string): AcpSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return store.getAll();

  const terms = q.split(/\s+/).filter(Boolean);
  const all = store.getAll();

  return all.filter((s) => {
    // Searchable text corpus for this session
    const corpusParts: string[] = [
      s.title,
      s.agentName,
      s.agentId,
      s.cwd,
      s.lastPrompt,
      s.recap,
      s.git?.branch ?? '',
      ...(s.user.tags || []),
      s.user.priority ?? '',
      s.state,
    ];

    // Include message turns and tool calls
    for (const turn of s.turns) {
      if (turn.content) corpusParts.push(turn.content);
      if (turn.thoughts) corpusParts.push(turn.thoughts);
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          corpusParts.push(tc.title);
          if (tc.output) corpusParts.push(tc.output.slice(0, 1000));
        }
      }
    }

    const corpus = corpusParts.join(' ').toLowerCase();
    return terms.every((term) => corpus.includes(term));
  });
}

export interface TranscriptHit {
  id: string;
  snippet?: string;
}

/**
 * What the command palette needs for transcript matches: the id and a short
 * excerpt, not the whole session. A short query matches nearly every session,
 * and sending each one's full transcript stalls the app while typing.
 */
export function searchTranscripts(query: string, limit: number): TranscriptHit[] {
  if (!query.trim()) return [];
  return searchSessions(query)
    .slice(0, limit)
    .map((s) => ({ id: s.id, snippet: transcriptSnippet(s, query) }));
}

/** A short excerpt around the first transcript hit for the query. */
function transcriptSnippet(session: AcpSession, query: string): string | undefined {
  const term = query.trim().toLowerCase().split(/\s+/)[0];
  if (!term) return undefined;
  const texts: string[] = [];
  for (const turn of session.turns) {
    if (turn.content) texts.push(turn.content);
    for (const tc of turn.toolCalls || []) texts.push(tc.title);
  }
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, ' ');
    const i = text.toLowerCase().indexOf(term);
    if (i === -1) continue;
    // Start and end on word boundaries so the excerpt doesn't open mid-word.
    let start = Math.max(0, i - 36);
    if (start > 0) {
      const space = text.indexOf(' ', start);
      start = space !== -1 && space < i ? space + 1 : start;
    }
    let end = Math.min(text.length, i + term.length + 60);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      end = space > i + term.length ? space : end;
    }
    return `${start > 0 ? '… ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' …' : ''}`;
  }
  return undefined;
}
