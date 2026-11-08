import { evaluateListAccessPredicate, ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Match, Predicate, Schema } from 'effect';
import type { Activity } from '../../shared/apis/records.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
export const validRecordPredicate = Schema.is(predicateSchema);

export const recordVisible = (
  predicate: ListAccessPredicate,
  row: Pick<Activity, 'ref' | 'ownerPrincipalRef'>,
  tenantId: string,
) => {
  if (!validRecordPredicate(predicate) || row.ref.tenantId !== tenantId) {
    return false;
  }
  let projection: Parameters<typeof evaluateListAccessPredicate>[1] = {
    recordKey: RecordKeySchema.make(row.ref.resourceId),
    teamIds: [],
  };
  if (row.ownerPrincipalRef?.tenantId === tenantId) {
    projection = {
      ...projection,
      assigned: { _tag: 'Principal', principalId: PrincipalIdSchema.make(row.ownerPrincipalRef.principalId) },
    };
  }
  return evaluateListAccessPredicate(predicate, projection);
};

const conditionSql = (condition: ListAccessCondition, row: SQL, tenantId: string): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: ({ holder }) =>
        Predicate.isTagged(holder, 'Principal')
          ? sql`(${row}->'ownerPrincipalRef'->>'tenantId' = ${tenantId} and ${row}->'ownerPrincipalRef'->>'principalId' = ${holder.principalId})`
          : sql`false`,
      EntrustedTo: () => sql`false`,
      RecordKeyIn: ({ recordKeys }) =>
        sql`${row}->'ref'->>'resourceId' in (${sql.join(
          recordKeys.map((key) => sql`${key}`),
          sql`, `,
        )})`,
      TeamMemberOf: () => sql`false`,
    }),
    Match.exhaustive,
  );

/** Preserve every AND/OR restriction. Unsupported owner facts match no records. */
export const recordReachSql = (predicate: ListAccessPredicate, row: SQL, tenantId: string): SQL => {
  if (!validRecordPredicate(predicate)) {
    return sql`false`;
  }
  return (
    and(
      sql`${row}->'ref'->>'tenantId' = ${tenantId}`,
      ...predicate.groups.map(
        (group) =>
          or(
            ...group.clauses.map(
              (clause) =>
                and(...clause.conditions.map((condition) => conditionSql(condition, row, tenantId))) ?? sql`false`,
            ),
          ) ?? sql`false`,
      ),
    ) ?? sql`false`
  );
};
