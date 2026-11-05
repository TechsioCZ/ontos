import type { AnyColumn, SQL } from 'drizzle-orm';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { Match } from 'effect';

import type { ListAccessCondition, ListAccessPredicate, ListRowProjection } from '../access/decision/list-access.ts';
import { evaluateListAccessPredicate } from '../access/decision/list-access.ts';
import { PrincipalIdSchema, RecordKeySchema } from '../access/ids.ts';

/**
 * The projection text surfaces a search caller's field grants may deny (O17). A denied surface takes
 * no part in matching, ordering or result metadata, so a hidden personal name cannot be inferred
 * from a hit, from the number of hits, from their order, or from a hit-dependent failure (O25).
 * A tag covers its surface everywhere it appears: `searchableText` includes every alias's
 * `searchableText`, and `temporalSearchableText` every alias's temporal text.
 */
export const CORE_SEARCH_TEXT_FIELDS = ['searchableText', 'temporalSearchableText', 'title'] as const;
export type CoreSearchTextField = (typeof CORE_SEARCH_TEXT_FIELDS)[number];

/**
 * What the caller's own gate already decided about one search query. Both parts are answers the
 * owner supplies, never facts Core Search infers: Core owns the index, not the authority.
 */
export interface CoreSearchAuthorization {
  /**
   * The text surfaces this caller's field grants deny. Absent means the owner declared no field
   * grant over this search, so every surface stays matchable exactly as it was.
   */
  readonly hiddenTextFields?: readonly CoreSearchTextField[];
  /**
   * The owner's row filter (D16, O25). It is applied inside the owner query, before matching,
   * ordering, counting and limiting, so a row the caller may not read never becomes a candidate.
   */
  readonly listAccess?: ListAccessPredicate;
}

/** The only owner facts Core Search records for one document's row visibility. */
export interface SearchVisibilityRow {
  readonly assignedPrincipalId?: string | undefined;
  readonly recordKey: string;
}

/** The indexed columns a row filter can address. */
export interface SearchVisibilityColumns {
  /** The owner-authored assignee, read from the persisted projection payload. */
  readonly assignedPrincipalId: SQL;
  readonly recordKey: AnyColumn;
}

const rowProjection = (row: SearchVisibilityRow): ListRowProjection =>
  row.assignedPrincipalId === undefined
    ? { recordKey: RecordKeySchema.make(row.recordKey), teamIds: [] }
    : {
        assigned: { _tag: 'Principal', principalId: PrincipalIdSchema.make(row.assignedPrincipalId) },
        recordKey: RecordKeySchema.make(row.recordKey),
        teamIds: [],
      };

/**
 * The in-memory mirror of `searchVisibilitySql`. Both answer the normative evaluator, so a store
 * that cannot project an owner dimension denies the row instead of widening the filter.
 */
export const searchRowVisible = (predicate: ListAccessPredicate, row: SearchVisibilityRow): boolean =>
  evaluateListAccessPredicate(predicate, rowProjection(row));

/** One condition as a positive SQL comparison; an unprojected owner dimension is false, never true. */
const conditionSql = (condition: ListAccessCondition, columns: SearchVisibilityColumns): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      // Core Search records no amount, entrustment or team membership, so no row can match.
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: ({ holder }) =>
        Match.value(holder).pipe(
          // `holderEquals` namespaces the holder id (`principal:` / `agent:`), so an agent holder can
          // never equal the assignee principal this index records.
          Match.tags({
            Agent: () => sql`false`,
            Principal: ({ principalId }) => eq(columns.assignedPrincipalId, principalId),
          }),
          Match.exhaustive,
        ),
      EntrustedTo: () => sql`false`,
      RecordKeyIn: ({ recordKeys }) => inArray(columns.recordKey, [...recordKeys]),
      TeamMemberOf: () => sql`false`,
    }),
    Match.exhaustive,
  );

/** All conditions of one clause match (AND); a clause that describes nothing matches nothing. */
const clauseSql = (conditions: readonly ListAccessCondition[], columns: SearchVisibilityColumns): SQL => {
  const [first, ...rest] = conditions;
  return first === undefined
    ? sql`false`
    : (and(...[first, ...rest].map((condition) => conditionSql(condition, columns))) ?? sql`false`);
};

/** Any clause of one group may match (OR); a group that describes nothing matches nothing. */
const groupSql = (
  clauses: readonly { readonly conditions: readonly ListAccessCondition[] }[],
  columns: SearchVisibilityColumns,
): SQL => {
  const [first, ...rest] = clauses;
  return first === undefined
    ? sql`false`
    : (or(...[first, ...rest].map((clause) => clauseSql(clause.conditions, columns))) ?? sql`false`);
};

/**
 * The owner's `ListAccessPredicate` as a parameterized SQL visibility clause, equivalent to
 * `evaluateListAccessPredicate`: every group must match (AND of OR-sets), an empty `groups` list
 * means every row of the scope is visible, and a group or clause that cannot describe a row denies
 * instead of widening.
 */
export const searchVisibilitySql = (predicate: ListAccessPredicate, columns: SearchVisibilityColumns): SQL => {
  const [first, ...rest] = predicate.groups;
  return first === undefined
    ? sql`true`
    : (and(...[first, ...rest].map((group) => groupSql(group.clauses, columns))) ?? sql`false`);
};
