import { evaluateListAccessPredicate, ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Match, Schema } from 'effect';
import type { Tag } from '../../shared/apis/records.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
export const validRecordPredicate = Schema.is(predicateSchema);

export const recordVisible = (predicate: ListAccessPredicate, row: Pick<Tag, 'id'>, _tenantId: string) =>
  validRecordPredicate(predicate) &&
  evaluateListAccessPredicate(predicate, {
    recordKey: RecordKeySchema.make(row.id),
    teamIds: [],
  });

const conditionSql = (condition: ListAccessCondition, row: SQL, _tenantId: string): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: () => sql`false`,
      EntrustedTo: () => sql`false`,
      RecordKeyIn: ({ recordKeys }) =>
        sql`${row}->>'id' in (${sql.join(
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
      sql`true`,
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
