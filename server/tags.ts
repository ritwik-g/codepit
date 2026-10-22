export const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;

/** "#Infra Work " -> "infra-work": lower case, no leading #, spaces become dashes. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_./-]/gu, '')
    .slice(0, MAX_TAG_LENGTH);
}

/** Normalized, without blanks or repeats, in the order given. */
export function normalizeTags(raw: string[]): string[] {
  const tags: string[] = [];
  for (const r of raw) {
    const tag = normalizeTag(r);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}
