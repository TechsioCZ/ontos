import { Schema } from 'effect';

import { parseLegacyKey } from '../../../shared/proposal-key.ts';

const CORE_KEY = /^core:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const SearchValueSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
export const AgentReviewSearchSchema = Schema.Struct({
  davka: Schema.optionalKey(SearchValueSchema),
  navrh: Schema.optionalKey(SearchValueSchema),
});
export type AgentReviewSearch = typeof AgentReviewSearchSchema.Type;
export const AgentReviewSearchQuerySchema = Schema.RecordFromUrlParams.pipe(Schema.decodeTo(AgentReviewSearchSchema));
const firstSearchValue = (value: typeof SearchValueSchema.Type | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : value?.[0];

/** `?davka=<uuid>` (MCP review link) -> `core:<uuid>`, the queue key of that platform batch; otherwise undefined. */
export const batchKeyFromSearch = (search: AgentReviewSearch): string | undefined => {
  const id = firstSearchValue(search.davka);
  if (id === undefined) {
    return undefined;
  }
  if (BATCH_ID.test(id)) {
    return `core:${id.toLowerCase()}`;
  }
  if (CORE_KEY.test(id)) {
    return id.toLowerCase();
  }
  return parseLegacyKey(id) === undefined ? undefined : id;
};

/** Exact proposal in the target batch (not merely the batch that happens to contain it). */
export const itemKeyFromSearch = (search: AgentReviewSearch): string | undefined => {
  const key = firstSearchValue(search.navrh);
  if (key === undefined) {
    return undefined;
  }
  if (CORE_KEY.test(key)) {
    return key.toLowerCase();
  }
  return parseLegacyKey(key) === undefined ? undefined : key;
};
