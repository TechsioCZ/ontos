import { evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Match } from 'effect';
import type { Task } from '../../shared/apis/records.ts';

export const taskVisible = (predicate: ListAccessPredicate, task: Task, tenantId: string) => {
  if (task.ref.tenantId !== tenantId) {
    return false;
  }
  const row = { recordKey: RecordKeySchema.make(task.ref.resourceId), teamIds: [] };
  if (task.ownerPrincipalRef?.tenantId === tenantId) {
    return evaluateListAccessPredicate(predicate, {
      ...row,
      assigned: { _tag: 'Principal', principalId: PrincipalIdSchema.make(task.ownerPrincipalRef.principalId) },
    });
  }
  return evaluateListAccessPredicate(predicate, row);
};

const conditionSql = (condition: ListAccessCondition, row: SQL, tenantId: string): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: ({ holder }) =>
        Match.value(holder).pipe(
          Match.tags({
            Agent: () => sql`false`,
            Principal: ({ principalId }) =>
              sql`(${row}->'ownerPrincipalRef'->>'tenantId' = ${tenantId} and ${row}->'ownerPrincipalRef'->>'principalId' = ${principalId})`,
          }),
          Match.exhaustive,
        ),
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

/** Keep the engine's AND-of-OR-of-AND structure, including explicit target ceilings. */
export const taskReachSql = (predicate: ListAccessPredicate, row: SQL, tenantId: string): SQL =>
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
  ) ?? sql`false`;
