import type { CoreSearchProjectionHit } from './projection.ts';
import {
  CORE_SEARCH_RELEVANCE_MAX_SCORE,
  CORE_SEARCH_RELEVANCE_VERSION,
  matchesCoreSearchValues,
  normalizeCoreSearchText,
} from './search-contract.ts';
import type { CoreSearchRelevance } from './search-contract.ts';

export const CORE_SEARCH_RANK_VERSION = 1;

/** Wire scores are higher-is-better and stay in 0..1000; they are not raw rank tiers. */
const CORE_SEARCH_RELEVANCE_SCORES = [CORE_SEARCH_RELEVANCE_MAX_SCORE, 900, 800, 700, 600, 100] as const;

/** Lower is better. Only already-public title / typed identity may improve the tier.
 * Untyped searchable terms (including contacts) deliberately carry no ranking provenance.
 */
export const coreSearchRank = (
  hit: CoreSearchProjectionHit,
  query: Readonly<{ phrase: string; tokens: readonly string[] }>,
): number => {
  if (normalizeCoreSearchText(hit.ref.resourceId) === query.phrase) {
    return 0;
  }
  const title = normalizeCoreSearchText(hit.title).trim().split(/\s+/u).join(' ');
  if (title === query.phrase) {
    return 1;
  }
  if (title.startsWith(query.phrase)) {
    return 2;
  }
  if (title.includes(query.phrase)) {
    return 3;
  }
  return matchesCoreSearchValues([title], query.tokens) ? 4 : 5;
};

/**
 * Explicit adapter from the internal lower-is-better tier to the optional wire relevance.
 * Call it only for a hit whose canonical/current evidence was verified after the SQL shortlist.
 */
export const coreSearchRelevance = (
  hit: CoreSearchProjectionHit,
  query: Readonly<{ phrase: string; tokens: readonly string[] }>,
): CoreSearchRelevance => ({
  score: CORE_SEARCH_RELEVANCE_SCORES[coreSearchRank(hit, query)] ?? 0,
  version: CORE_SEARCH_RELEVANCE_VERSION,
});

const compareIdentity = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

/** Stable full typed-reference tie-break; never rely on shortlist order or host locale. */
export const compareCoreSearchHits = (
  left: CoreSearchProjectionHit,
  right: CoreSearchProjectionHit,
  query: Readonly<{ phrase: string; tokens: readonly string[] }>,
): number =>
  coreSearchRank(left, query) - coreSearchRank(right, query) ||
  compareIdentity(left.title, right.title) ||
  compareIdentity(left.ref.tenantId, right.ref.tenantId) ||
  compareIdentity(left.ref.moduleId, right.ref.moduleId) ||
  compareIdentity(left.ref.resourceType, right.ref.resourceType) ||
  compareIdentity(left.ref.resourceId, right.ref.resourceId);
