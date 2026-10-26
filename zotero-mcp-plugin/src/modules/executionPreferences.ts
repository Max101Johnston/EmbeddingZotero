const PREFIX = "extensions.zotero.zotero-mcp-plugin.execution.";
export const SEARCH_WORKERS_PREF = PREFIX + "searchWorkers";
export const DEFAULT_SEARCH_WORKERS = 4;

function integerInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : null;
}

export const parseSearchWorkers = (value: unknown): number | null =>
  integerInRange(value, 1, 32);

export function getSearchWorkers(): number {
  try {
    return (
      parseSearchWorkers(Zotero.Prefs.get(SEARCH_WORKERS_PREF, true)) ??
      DEFAULT_SEARCH_WORKERS
    );
  } catch {
    return DEFAULT_SEARCH_WORKERS;
  }
}
