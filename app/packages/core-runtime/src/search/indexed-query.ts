import { and, asc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';

import { searchIndexEntries } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { CORE_SEARCH_FORMAT_VERSION } from './evidence-codec.ts';
import type { CoreSearchQuery } from './projection.ts';
import { coreSearchResourceTypes, coreSearchTokens, escapeCoreSearchLike } from './search-contract.ts';
import type { CoreSearchAuthorization } from './visibility.ts';
import { searchVisibilitySql } from './visibility.ts';

/** A work budget, not a corpus cap or a public result limit. Overflow must fail closed. */
export const CORE_SEARCH_CANDIDATE_BUDGET = 10_000;

/** A live row whose derived stamp is missing or stale; the query must verify it from its v2 evidence. */
export const coreSearchDerivedStampOutdated = () =>
  or(
    isNull(searchIndexEntries.searchTextV1),
    isNull(searchIndexEntries.searchFormatVersion),
    ne(searchIndexEntries.searchFormatVersion, CORE_SEARCH_FORMAT_VERSION),
    isNull(searchIndexEntries.searchSourceVersion),
    ne(searchIndexEntries.searchSourceVersion, searchIndexEntries.projectionVersion),
  );

/** Necessary conditions only: do not exclude missing, unsupported or stale derived rows.
 * The row's original v2 evidence is decoded and verified by the query runtime afterwards.
 * No temporal/facet predicates here: those require exact grouping and a fixed effectiveAt.
 */
export const coreSearchCandidatePredicate = (input: CoreSearchQuery, authorization?: CoreSearchAuthorization) => {
  const tokens = coreSearchTokens(input.query);
  const resourceTypes = coreSearchResourceTypes(input);
  const table = searchIndexEntries;
  const typePredicate = (() => {
    if (resourceTypes.length === 0) {
      return sql`false`;
    }
    if (resourceTypes.length === 1) {
      return eq(table.sourceResourceType, resourceTypes[0] ?? '');
    }
    return inArray(table.sourceResourceType, resourceTypes);
  })();
  const fallback = coreSearchDerivedStampOutdated();
  const indexed = and(
    eq(table.searchFormatVersion, CORE_SEARCH_FORMAT_VERSION),
    eq(table.searchSourceVersion, table.projectionVersion),
    ...tokens.map((token) => like(table.searchTextV1, `%${escapeCoreSearchLike(token)}%`)),
  );
  return and(
    eq(table.tenantId, input.tenantId),
    eq(table.sourceModuleKey, input.moduleId),
    typePredicate,
    input.selectedLegalEntityId === undefined
      ? isNull(table.legalEntityId)
      : eq(table.legalEntityId, input.selectedLegalEntityId),
    eq(table.deleted, false),
    // Authorization belongs in WHERE, before the candidate bound and before any ordering: a row the
    // caller may not read is never a candidate, so it can neither be counted nor displace a visible
    // one. The assignee is an owner-authored private index fact, never result metadata.
    authorization?.listAccess === undefined
      ? undefined
      : searchVisibilitySql(authorization.listAccess, {
          assignedPrincipalId: sql`${table.facetsJson}->>'assignedPrincipalId'`,
          recordKey: table.sourceResourceId,
        }),
    // Defensive guard for private callers that have not gone through query decoding.
    tokens.length === 0 ? sql`false` : or(fallback, indexed),
  );
};

/** Apply the sentinel limit only after the SQL shortlist, never to the whole owner bucket. */
export const selectCoreSearchCandidates = (
  transaction: CoreTransaction,
  input: CoreSearchQuery,
  authorization?: CoreSearchAuthorization,
) =>
  transaction
    .select()
    .from(searchIndexEntries)
    .where(coreSearchCandidatePredicate(input, authorization))
    // A denied title takes no part in ordering either: the database orders by the resource key the
    // caller may read, so no hidden name is read to choose the candidate window.
    .orderBy(
      ...(authorization?.hiddenTextFields?.includes('title') === true
        ? [asc(searchIndexEntries.sourceResourceId)]
        : [asc(searchIndexEntries.title), asc(searchIndexEntries.sourceResourceId)]),
    )
    .limit(CORE_SEARCH_CANDIDATE_BUDGET + 1);
