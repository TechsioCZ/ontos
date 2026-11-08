import { Match, Schema } from 'effect';
import type { Array as Arr } from 'effect';

import { RecordKeySchema } from '../ids.ts';
import type { RecordKey } from '../ids.ts';
import { AmountCeilingSchema, HolderSchema } from '../model.ts';
import { AccessTeamIdSchema } from './authority.ts';
import type { AmountCeiling, Holder } from '../model.ts';
import type { AccessTeamId, AuthorityCell } from './authority.ts';
import type { AccessAmount } from './contract.ts';
import { holderEquals, recordSelectorOf } from './selector.ts';

/** One condition of the owner predicate. Every case is a positive SQL comparison, never a negation. */
export const ListAccessConditionSchema = Schema.Union([
  Schema.TaggedStruct('AllInScope', {}),
  Schema.TaggedStruct('AmountWithinCeiling', { ceiling: AmountCeilingSchema }),
  Schema.TaggedStruct('AssignedTo', { holder: HolderSchema }),
  Schema.TaggedStruct('EntrustedTo', { holder: HolderSchema }),
  Schema.TaggedStruct('RecordKeyIn', { recordKeys: Schema.NonEmptyArray(RecordKeySchema) }),
  Schema.TaggedStruct('TeamMemberOf', { teamIds: Schema.NonEmptyArray(AccessTeamIdSchema) }),
]);
export type ListAccessCondition = typeof ListAccessConditionSchema.Type;

/** All conditions of one clause must match (AND). */
export interface ListAccessClause {
  readonly conditions: Arr.NonEmptyReadonlyArray<ListAccessCondition>;
}

/** Any clause of one group may match (OR). */
export interface ListAccessClauseGroup {
  readonly clauses: Arr.NonEmptyReadonlyArray<ListAccessClause>;
}

/**
 * The owner's list filter. Every group must match (AND of OR-sets). An empty `groups` list means
 * every row of the scope is visible; it is only produced when every side is genuinely
 * unconstrained (a side whose cells all reach the whole scope). A side that resolves no usable
 * clause at all produces no predicate, so the caller returns no rows: an authority that cannot
 * describe a single matching row is never widened to "no filter" (guarantee 10, D16, D25).
 */
export interface ListAccessPredicate {
  readonly groups: readonly ListAccessClauseGroup[];
}

/**
 * The owner's row projection for the list predicate contract. Only these columns take part; an
 * absent column (`undefined`, SQL NULL) never matches a condition.
 */
export interface ListRowProjection {
  readonly amount?: AccessAmount;
  readonly assigned?: Holder;
  readonly entrusted?: Holder;
  readonly recordKey: RecordKey;
  readonly teamIds: readonly AccessTeamId[];
}

const conditionMatches = (condition: ListAccessCondition, row: ListRowProjection): boolean =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => true,
      AmountWithinCeiling: ({ ceiling }) =>
        row.amount !== undefined &&
        row.amount.currency === ceiling.currency &&
        row.amount.minor >= 0 &&
        row.amount.minor <= ceiling.limitMinor,
      AssignedTo: ({ holder }) => row.assigned !== undefined && holderEquals(holder, row.assigned),
      EntrustedTo: ({ holder }) => row.entrusted !== undefined && holderEquals(holder, row.entrusted),
      RecordKeyIn: ({ recordKeys }) => recordKeys.includes(row.recordKey),
      TeamMemberOf: ({ teamIds }) => {
        const memberships = new Set(teamIds);
        return row.teamIds.some((teamId) => memberships.has(teamId));
      },
    }),
    Match.exhaustive,
  );

const clauseMatches = (clause: ListAccessClause, row: ListRowProjection): boolean =>
  clause.conditions.every((condition) => conditionMatches(condition, row));

const groupMatches = (group: ListAccessClauseGroup, row: ListRowProjection): boolean =>
  group.clauses.some((clause) => clauseMatches(clause, row));

/** The normative meaning of the contract; owner SQL must be equivalent to this evaluator. */
export const evaluateListAccessPredicate = (predicate: ListAccessPredicate, row: ListRowProjection): boolean =>
  predicate.groups.every((group) => groupMatches(group, row));

/** One resolved authority cell, already narrowed by one cell of the agent's connection ceiling. */
export interface ListAuthorityCell {
  readonly cell: AuthorityCell;
  /** The explicit targets of the one consent cell this clause answers to, when it names any. */
  readonly connectionRecordKeys?: Arr.NonEmptyReadonlyArray<RecordKey>;
  /** The narrower of the grant's ceiling and that consent cell's ceiling. */
  readonly effectiveAmountCeiling?: AmountCeiling;
  readonly holder: Holder;
  readonly teamIds: readonly AccessTeamId[];
}

export interface ListAuthoritySide {
  readonly cells: readonly ListAuthorityCell[];
  readonly holder: Holder;
  readonly teamIds: readonly AccessTeamId[];
}

const nonEmpty = <Value>(values: readonly Value[]): Arr.NonEmptyReadonlyArray<Value> | undefined => {
  const [first, ...rest] = values;
  return first === undefined ? undefined : [first, ...rest];
};

/**
 * The conditions one authority cell contributes. It takes only what it reads, so a record-scoped
 * decision can ask the identical question of one projected record without building a list cell (R5a-7).
 */
type SelectorConditionSource = Pick<ListAuthorityCell, 'holder' | 'teamIds'> & {
  readonly cell: Pick<AuthorityCell, 'selector'>;
};

const selectorConditions = (source: SelectorConditionSource): readonly ListAccessCondition[] =>
  Match.value(source).pipe(
    Match.when(
      ({ cell }) => recordSelectorOf(cell.selector) === 'assigned',
      (): readonly ListAccessCondition[] => [{ _tag: 'AssignedTo', holder: source.holder }],
    ),
    Match.when(
      ({ cell }) => recordSelectorOf(cell.selector) === 'entrusted',
      (): readonly ListAccessCondition[] => [{ _tag: 'EntrustedTo', holder: source.holder }],
    ),
    Match.when(
      ({ cell }) => recordSelectorOf(cell.selector) === 'team',
      (): readonly ListAccessCondition[] => {
        const teamIds = nonEmpty(source.teamIds);
        return teamIds === undefined ? [] : [{ _tag: 'TeamMemberOf', teamIds }];
      },
    ),
    Match.when(
      ({ cell }) => recordSelectorOf(cell.selector) === undefined,
      (): readonly ListAccessCondition[] => {
        const keys: readonly RecordKey[] = Match.value(source.cell.selector).pipe(
          Match.tag('targets', ({ recordKeys }) => recordKeys),
          Match.orElse((): readonly RecordKey[] => []),
        );
        const recordKeys = nonEmpty(keys);
        return recordKeys === undefined ? [] : [{ _tag: 'RecordKeyIn', recordKeys }];
      },
    ),
    Match.orElse((): readonly ListAccessCondition[] => []),
  );

/**
 * Whether ONE authority cell reaches the owner's projection of one record (R5a-7).
 *
 * The list path already decides rows by evaluating `ListAccessPredicate` against exactly this projection
 * (`ListRowProjection`), which the owner fills from its own SQL. A record-scoped decision must ask the
 * same question of the single record it names: v2 writes no `access_record` relation, so a graph tuple
 * cannot be the authority, and asking the graph instead made `list` able to show a row that
 * `decide(target)` refused. Both paths therefore read the owner's projection and nothing else.
 *
 * An absent projection reaches nothing except a scope-wide cell: a missing owner fact is a denial, never
 * an implicit match (O48 fail-closed).
 */
export const cellReachesProjection = (
  cell: SelectorConditionSource,
  projection: ListRowProjection | undefined,
): boolean => {
  const conditions = selectorConditions(cell);
  if (conditions.length === 0) {
    // `all`, and the cell kinds that carry no condition of their own (`team` without members, a
    // `targets` set that the owner already applied), reach the whole scope exactly as they do a list.
    return true;
  }
  return projection !== undefined && conditions.every((condition) => conditionMatches(condition, projection));
};

/** Whether any of the side's cells reaches the record: the record-scoped form of a list side. */
export const sideReachesProjection = (
  side: { readonly cells: readonly SelectorConditionSource[] },
  projection: ListRowProjection | undefined,
): boolean => side.cells.some((cell) => cellReachesProjection(cell, projection));

/**
 * A cell that is record-scoped but answered no record condition (a `team` cell for an actor who is
 * in no team, a `targets` cell with no keys) cannot match any row, so it contributes no clause at
 * all: its amount or target narrowing may never stand in for the record dimension it lacks.
 */
const cellClause = (source: ListAuthorityCell): ListAccessClause | undefined => {
  const recordSelector = recordSelectorOf(source.cell.selector);
  const selectorPart = selectorConditions(source);
  if (recordSelector !== 'all' && selectorPart.length === 0) {
    return undefined;
  }
  const conditions: ListAccessCondition[] = [...selectorPart];
  const connectionKeys = nonEmpty(source.connectionRecordKeys ?? []);
  if (connectionKeys !== undefined) {
    conditions.push({ _tag: 'RecordKeyIn', recordKeys: connectionKeys });
  }
  if (source.effectiveAmountCeiling !== undefined) {
    conditions.push({ _tag: 'AmountWithinCeiling', ceiling: source.effectiveAmountCeiling });
  }
  const conditionList: ListAccessCondition[] = conditions.length === 0 ? [{ _tag: 'AllInScope' }] : conditions;
  const [firstCondition, ...restConditions] = conditionList;
  return firstCondition === undefined ? undefined : { conditions: [firstCondition, ...restConditions] };
};

const isAllInScopeClause = (clause: ListAccessClause): boolean =>
  clause.conditions.some((condition) =>
    Match.value(condition).pipe(
      Match.tag('AllInScope', () => true),
      Match.orElse(() => false),
    ),
  );

/**
 * One side's disjunction, with the two "nothing to say" cases kept apart: a side whose clauses
 * reach the whole scope constrains nothing, while a side with no usable clause matches nothing.
 * Merging them is what turns an empty team into a silent "no filter" (B1).
 */
interface SideDisjunction {
  readonly clauses: readonly ListAccessClause[];
  readonly reachesWholeScope: boolean;
}

const sideDisjunction = (side: ListAuthoritySide): SideDisjunction => {
  const clauses: ListAccessClause[] = [];
  for (const cell of side.cells) {
    const clause = cellClause(cell);
    if (clause !== undefined) {
      clauses.push(clause);
    }
  }
  return { clauses, reachesWholeScope: clauses.some((clause) => isAllInScopeClause(clause)) };
};

/**
 * Turns resolved selectors into the owner's SQL predicate. It is a conjunction of per-side
 * disjunctions because an agent acts only within the intersection of the person's, the agent's and
 * the connection's authority (D22); for a person there is exactly one side. `undefined` means the
 * caller must return no rows.
 */
export const buildListAccessPredicate = (
  sides: Arr.NonEmptyReadonlyArray<ListAuthoritySide>,
): ListAccessPredicate | undefined => {
  const groups: ListAccessClauseGroup[] = [];
  for (const side of sides) {
    if (side.cells.length === 0) {
      return undefined;
    }
    const { clauses, reachesWholeScope } = sideDisjunction(side);
    if (reachesWholeScope) {
      continue;
    }
    const [firstClause, ...restClauses] = clauses;
    if (firstClause === undefined) {
      return undefined;
    }
    groups.push({ clauses: [firstClause, ...restClauses] });
  }
  return { groups };
};
