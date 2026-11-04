/** Shorter queries answer with no results and never read the owner. */
export const SEARCH_QUERY_MIN_LENGTH = 2;
/** Longer text is cut to this many characters, never rejected. */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/** The trimmed query the public search forwards to the owner; non-text input is an empty query. */
export function searchQueryText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, SEARCH_QUERY_MAX_LENGTH) : "";
}
