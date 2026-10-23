const CORE_KEY = /^core:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `?davka=<uuid>` (MCP review link) -> `core:<uuid>`, the queue key of that platform batch; otherwise undefined. */
export const batchKeyFromSearch = (search: string): string | undefined => {
  const id = new URLSearchParams(search).get('davka');
  if (id === null) return undefined;
  if (BATCH_ID.test(id)) return `core:${id.toLowerCase()}`;
  return CORE_KEY.test(id) ? id.toLowerCase() : undefined;
};

/** Exact proposal in the target batch (not merely the batch that happens to contain it). */
export const itemKeyFromSearch = (search: string): string | undefined => {
  const key = new URLSearchParams(search).get('navrh');
  return key !== null && CORE_KEY.test(key) ? key.toLowerCase() : undefined;
};
