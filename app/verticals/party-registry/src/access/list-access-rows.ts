import { evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate, ListRowProjection } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';

/** One owner row as the gate's predicate sees it: its immutable record id and, when projected, its assignee. */
export interface ListAccessRow {
  readonly assignedPrincipalId?: string;
  readonly recordKey: string;
}

/**
 * The owner's projection of one row (D16, O25). Only the record's own id and its owner column take
 * part; a row that projects no assignee simply has none, so an `assigned` clause can never match it
 * (O10). Branding at this seam is what lets Core's evaluator read the row without re-checking it.
 */
const projectionOf = (row: ListAccessRow): ListRowProjection => {
  const principalId = row.assignedPrincipalId;
  const base = { recordKey: RecordKeySchema.make(row.recordKey), teamIds: [] as const };
  return principalId === undefined
    ? base
    : { ...base, assigned: { _tag: 'Principal' as const, principalId: PrincipalIdSchema.make(principalId) } };
};

/**
 * The owner's rows the caller may see, in the order the owner selected them. An absent predicate
 * means the read is not row-scoped, so nothing is filtered; every other answer is applied by Core's
 * own evaluator, so the owner never restates the predicate contract (guarantee 10, D16, O25).
 */
export const rowsVisibleToListAccess = <Row>(input: {
  readonly filter: ListAccessPredicate | undefined;
  readonly row: (row: Row) => ListAccessRow;
  readonly rows: readonly Row[];
}): readonly Row[] => {
  const { filter } = input;
  return filter === undefined
    ? input.rows
    : input.rows.filter((row) => evaluateListAccessPredicate(filter, projectionOf(input.row(row))));
};
