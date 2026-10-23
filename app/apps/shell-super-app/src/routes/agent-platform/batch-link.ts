import { parseLegacyKey } from '../../../api/agent-platform/legacy-normalize.ts';

const CORE_KEY = /^core:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `?davka=<uuid>` (MCP review link) -> `core:<uuid>`, the queue key of that platform batch; otherwise undefined. */
export const batchKeyFromSearch = (search: string): string | undefined => {
  const id = new URLSearchParams(search).get('davka');
  if (id === null) return undefined;
  if (BATCH_ID.test(id)) return `core:${id.toLowerCase()}`;
  if (CORE_KEY.test(id)) return id.toLowerCase();
  return parseLegacyKey(id) === undefined ? undefined : id;
};

/** Exact proposal in the target batch (not merely the batch that happens to contain it). */
export const itemKeyFromSearch = (search: string): string | undefined => {
  const key = new URLSearchParams(search).get('navrh');
  if (key === null) return undefined;
  if (CORE_KEY.test(key)) return key.toLowerCase();
  return parseLegacyKey(key) === undefined ? undefined : key;
};
