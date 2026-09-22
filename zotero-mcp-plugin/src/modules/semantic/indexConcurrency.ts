/** Limit simultaneous item indexing and PDF extraction workers. */
export const INDEX_CONCURRENCY_PREF = 'extensions.zotero.zotero-mcp-plugin.semantic.indexConcurrency';
export const DEFAULT_INDEX_CONCURRENCY = 5;
export const MIN_INDEX_CONCURRENCY = 1;
export const MAX_INDEX_CONCURRENCY = 1000;

declare let Zotero: any;

export function parseIndexConcurrency(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) {
    return null;
  }
  const concurrency = Number(value);
  return Number.isInteger(concurrency) &&
    concurrency >= MIN_INDEX_CONCURRENCY &&
    concurrency <= MAX_INDEX_CONCURRENCY
    ? concurrency
    : null;
}

export function getIndexConcurrency(): number {
  try {
    return parseIndexConcurrency(Zotero.Prefs.get(INDEX_CONCURRENCY_PREF, true))
      ?? DEFAULT_INDEX_CONCURRENCY;
  } catch {
    return DEFAULT_INDEX_CONCURRENCY;
  }
}
