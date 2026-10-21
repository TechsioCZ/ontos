const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `?davka=<uuid>` (MCP review link) -> `core:<uuid>`, the queue key of that platform batch; otherwise undefined. */
export const batchKeyFromSearch = (search: string): string | undefined => {
  const id = new URLSearchParams(search).get('davka');
  return id !== null && BATCH_ID.test(id) ? `core:${id.toLowerCase()}` : undefined;
};
