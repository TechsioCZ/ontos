import type { CoreSearchProjectionDocument } from './projection.ts';
import { normalizeCoreSearchText } from './search-contract.ts';

export const CORE_SEARCH_FORMAT_VERSION = 1;

/** Only a SQL shortlist. Alias groups, periods and authorization still require exact verification. */
export const deriveCoreSearchRepresentation = (document: CoreSearchProjectionDocument) => ({
  searchFormatVersion: CORE_SEARCH_FORMAT_VERSION,
  searchSourceVersion: BigInt(document.projectionVersion),
  searchTextV1: [
    document.title,
    ...document.searchableText,
    ...(document.temporalSearchableText ?? []).map(({ value }) => value),
    ...(document.aliases ?? []).flatMap((alias) => [
      ...alias.searchableText,
      ...(alias.temporalSearchableText ?? []).map(({ value }) => value),
    ]),
  ]
    .map(normalizeCoreSearchText)
    .join('\n'),
});
