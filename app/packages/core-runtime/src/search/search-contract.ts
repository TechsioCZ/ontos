import { Result, Schema } from 'effect';

export const normalizeCoreSearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replaceAll(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLocaleLowerCase('und');

export const coreSearchTokens = (query: string): readonly string[] => [
  ...new Set(normalizeCoreSearchText(query).trim().split(/\s+/u).filter(Boolean)),
];

/** One optional multi-type selector is capped so a broad query stays a bounded work request. */
export const CORE_SEARCH_MAX_RESOURCE_TYPES = 64;

/** Accept the legacy single type and the additive multi-type selector, without duplicate predicates. */
export const coreSearchResourceTypes = (
  query: Readonly<{ readonly resourceType?: string; readonly resourceTypes?: readonly string[] }>,
): readonly string[] => [
  ...new Set([...(query.resourceType === undefined ? [] : [query.resourceType]), ...(query.resourceTypes ?? [])]),
];

export const CORE_SEARCH_RELEVANCE_VERSION = '1' as const;
export const CORE_SEARCH_RELEVANCE_MAX_SCORE = 1000;

/** Optional wire relevance. A higher score is better; it is never a raw rank tier. */
export const CoreSearchRelevanceSchema = Schema.Struct({
  score: Schema.Int.check(Schema.isBetween({ maximum: CORE_SEARCH_RELEVANCE_MAX_SCORE, minimum: 0 })),
  version: Schema.Literal(CORE_SEARCH_RELEVANCE_VERSION),
});
export type CoreSearchRelevance = typeof CoreSearchRelevanceSchema.Type;

const queryText = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) => coreSearchTokens(value).length > 0),
);

export const CoreSearchQueryTextSchema = queryText;

/** Shared validated interpretation; normalization-only input must never become match-all. */
export const parseCoreSearchQuery = (text: string) =>
  Schema.decodeUnknownResult(queryText)(text).pipe(
    Result.map((value) => ({
      phrase: normalizeCoreSearchText(value).trim().split(/\s+/u).join(' '),
      tokens: coreSearchTokens(value),
    })),
  );

export const matchesCoreSearchValues = (values: readonly string[], tokens: readonly string[]): boolean => {
  if (tokens.length === 0) {
    return false;
  }
  const normalized = values.map(normalizeCoreSearchText);
  return tokens.every((token) => normalized.some((value) => value.includes(token)));
};

/** PostgreSQL LIKE must treat pasted identifiers as text, never as wildcard syntax. */
export const escapeCoreSearchLike = (value: string): string => value.replaceAll(/[\\%_]/gu, String.raw`\$&`);
