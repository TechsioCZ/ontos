import { ReadPermissionDenied } from '@app/core-runtime';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Match, Result, Schema } from 'effect';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
export const validSearchPredicate = Schema.is(predicateSchema);

/** Only the predicate Core admitted for this actual search registration can reach owner SQL. */
export const prepareSearchPredicate = (predicate?: ListAccessPredicate) =>
  predicate !== undefined && validSearchPredicate(predicate)
    ? Effect.succeed(predicate)
    : Effect.fail(
        new ReadPermissionDenied({
          code: 'read_permission_denied',
          reason: 'Merchandise search requires its admitted record predicate',
        }),
      );

const conditionSql = (condition: ListAccessCondition, recordKey: SQL): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: () => sql`false`,
      EntrustedTo: () => sql`false`,
      RecordKeyIn: ({ recordKeys }) => inArray(recordKey, [...recordKeys]),
      TeamMemberOf: () => sql`false`,
    }),
    Match.exhaustive,
  );

/** Record keys are the same company-qualified identities the registered Product/Order refs expose. */
export const searchReachSql = (predicate: ListAccessPredicate, recordKey: SQL): SQL => {
  if (!validSearchPredicate(predicate)) {
    return sql`false`;
  }
  return (
    and(
      sql`true`,
      ...predicate.groups.map(
        (group) =>
          or(
            ...group.clauses.map(
              (clause) =>
                and(...clause.conditions.map((condition) => conditionSql(condition, recordKey))) ?? sql`false`,
            ),
          ) ?? sql`false`,
      ),
    ) ?? sql`false`
  );
};

/** Check the returned owner projection too; a malformed or foreign transport row never authorizes a hit. */
export const searchRecordVisible = (
  predicate: ListAccessPredicate,
  row: { readonly id: string; readonly legalEntityId: string; readonly tenantId: string },
  scope: { readonly legalEntityId?: string; readonly tenantId: string },
): boolean => {
  if (
    !validSearchPredicate(predicate) ||
    row.tenantId !== scope.tenantId ||
    row.legalEntityId !== scope.legalEntityId
  ) {
    return false;
  }
  const recordKey = Schema.decodeUnknownResult(RecordKeySchema)(`${row.legalEntityId}.${row.id}`);
  return (
    Result.isSuccess(recordKey) && evaluateListAccessPredicate(predicate, { recordKey: recordKey.success, teamIds: [] })
  );
};
