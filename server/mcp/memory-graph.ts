import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, MemoryGraph, MemoryGraphEntity, MemoryGraphObservation, MemoryGraphRelation } from '../types.js';
import { WORKSPACE_VAR } from './config.js';

// Read-only view of a memory MCP server's knowledge graph (the JSONL file
// @modelcontextprotocol/server-memory writes). The file path comes only from
// the saved server's MEMORY_FILE_PATH, never from the request; it must be a
// .jsonl or .json file, only entity and relation rows are returned, and the
// version is the file's size and mtime rather than a hash of its content, so
// this can't be used to read or fingerprint other files.

const MEMORY_PACKAGE = '@modelcontextprotocol/server-memory';
const MAX_BYTES = 32 * 1024 * 1024;

// Observation stamps: [YYYY-MM-DD HH:MM] [repo:x] [name:y] [id:z] text
const STAMP = /^\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*((?:\[[a-z]+:[^\]]*\]\s*)*)([\s\S]*)$/;
const TAG = /\[([a-z]+):([^\]]*)\]/g;
// Older stamps: [session:<name> <id>]
const LEGACY = /^(.*)\s([0-9a-f]{8}-[0-9a-f-]{27,})$/;
// The protocol writes status= straight after the stamp; elsewhere it is just prose
const STATUS = /^status=([a-z-]+)/;

export class MemoryGraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A stdio server that runs the reference memory server. */
export function isMemoryServer(server: McpServerConfig): boolean {
  return server.transport === 'stdio' && (server.args ?? []).some((a) => a === MEMORY_PACKAGE || a.startsWith(`${MEMORY_PACKAGE}@`));
}

export function memoryFilePath(server: McpServerConfig): string {
  if (!isMemoryServer(server)) throw new MemoryGraphError('This server is not a memory server', 400);
  const file = server.env?.MEMORY_FILE_PATH?.trim();
  if (!file) throw new MemoryGraphError('Set MEMORY_FILE_PATH on this server to view its graph. Without it the memory server keeps its file inside the npx cache.', 400);
  if (file.includes(WORKSPACE_VAR)) throw new MemoryGraphError(`MEMORY_FILE_PATH uses ${WORKSPACE_VAR}, so each session has its own file and there is no single graph to show.`, 400);
  if (!path.isAbsolute(file)) throw new MemoryGraphError('MEMORY_FILE_PATH must be an absolute path to view its graph.', 400);
  if (!/\.jsonl?$/i.test(file)) throw new MemoryGraphError('MEMORY_FILE_PATH must end in .jsonl or .json to view its graph.', 400);
  return file;
}

export function parseObservation(raw: string): MemoryGraphObservation {
  const m = STAMP.exec(raw);
  if (!m) return { ts: '', repo: '', name: '', id: '', text: raw };
  const tags: Record<string, string> = {};
  for (const [, k, v] of m[2].matchAll(TAG)) tags[k] = v;
  if (tags.session && !tags.name) {
    const lm = LEGACY.exec(tags.session);
    if (lm) [tags.name, tags.id] = [lm[1], lm[2]];
  }
  return { ts: m[1], repo: tags.repo ?? '', name: tags.name ?? '', id: tags.id ?? '', text: m[3].trim() };
}

export function parseMemoryGraph(text: string): Pick<MemoryGraph, 'entities' | 'relations' | 'skipped'> {
  // Keyed, so a repeated row (hand edit, two writers) replaces the earlier one instead of duplicating it
  const entities = new Map<string, MemoryGraphEntity>();
  const relations = new Map<string, MemoryGraphRelation>();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      // A half-written last line while the server saves, or not a graph file at all
      skipped++;
      continue;
    }
    if (row?.type === 'entity' && typeof row.name === 'string') {
      const raw: string[] = Array.isArray(row.observations) ? row.observations.filter((o: unknown) => typeof o === 'string') : [];
      const obs = raw.map(parseObservation);
      // The latest status= wins
      let status = '';
      for (const o of obs) status = STATUS.exec(o.text)?.[1] ?? status;
      const repo = [...obs].reverse().find((o) => o.repo)?.repo || 'unknown';
      const parts = row.name.split(':');
      const domain = parts[0] === 'Task' && parts.length > 2 ? parts[1] : parts[0];
      entities.set(row.name, { name: row.name, type: String(row.entityType ?? ''), status, repo, domain, observations: obs });
    } else if (row?.type === 'relation' && typeof row.from === 'string' && typeof row.to === 'string') {
      const rel = { from: row.from, to: row.to, type: String(row.relationType ?? '') };
      relations.set(JSON.stringify([rel.from, rel.type, rel.to]), rel);
    } else {
      skipped++;
    }
  }
  return { entities: [...entities.values()], relations: [...relations.values()], skipped };
}

/**
 * The graph, or `null` when the file still has the version the caller already holds.
 * A missing file is an empty graph: the memory server creates it on its first write.
 */
export function readMemoryGraph(server: McpServerConfig, since?: string): MemoryGraph | null {
  const file = memoryFilePath(server);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw new MemoryGraphError(`Can't read the memory file (${err?.code ?? 'error'})`, 500);
    return { file, exists: false, version: 'missing', modified: null, entities: [], relations: [], skipped: 0 };
  }
  if (!stat.isFile()) throw new MemoryGraphError(`${file} is not a file`, 400);
  if (stat.size > MAX_BYTES) throw new MemoryGraphError(`${file} is larger than ${MAX_BYTES / 1024 / 1024} MB`, 413);
  // Checked before reading, so an unchanged file costs one stat per poll
  const version = `${stat.size}-${stat.mtimeMs}`;
  if (since && since === version) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    throw new MemoryGraphError(`Can't read the memory file (${err?.code ?? 'error'})`, 500);
  }
  return { file, exists: true, version, modified: stat.mtimeMs, ...parseMemoryGraph(text) };
}
