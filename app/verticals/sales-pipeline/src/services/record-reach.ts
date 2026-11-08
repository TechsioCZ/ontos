import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Match, Predicate } from 'effect';
import type { Opportunity } from '../../shared/model/opportunity.ts';

/** The row's entrusted identity is owner data, never the current reader or an employee-id guess. */
export const opportunityVisible = (
  predicate: ListAccessPredicate,
  opportunity: Pick<Opportunity, 'amountMinor' | 'currency' | 'entrustedPrincipalRef' | 'id'>,
  tenantId: string,
) => {
  const row = {
    amount: { currency: opportunity.currency, minor: opportunity.amountMinor },
    recordKey: RecordKeySchema.make(opportunity.id),
    teamIds: [],
  };
  return evaluateListAccessPredicate(
    predicate,
    opportunity.entrustedPrincipalRef?.tenantId === tenantId
      ? {
          ...row,
          entrusted: {
            _tag: 'Principal' as const,
            principalId: PrincipalIdSchema.make(opportunity.entrustedPrincipalRef.principalId),
          },
        }
      : row,
  );
};

const conditionSql = (condition: ListAccessCondition, row: SQL, tenantId: string): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: ({ ceiling }) =>
        sql`(${row}->>'currency' = ${ceiling.currency} and (${row}->>'amountMinor')::numeric between 0 and ${ceiling.limitMinor})`,
      AssignedTo: () => sql`false`,
      EntrustedTo: ({ holder }) =>
        Predicate.isTagged(holder, 'Principal')
          ? sql`(${row}->'entrustedPrincipalRef'->>'tenantId' = ${tenantId} and ${row}->'entrustedPrincipalRef'->>'principalId' = ${holder.principalId})`
          : sql`false`,
      RecordKeyIn: ({ recordKeys }) =>
        sql`${row}->>'id' in (${sql.join(
          recordKeys.map((key) => sql`${key}`),
          sql`, `,
        )})`,
      TeamMemberOf: () => sql`false`,
    }),
    Match.exhaustive,
  );

/** Exact AND-of-OR-of-AND predicate in owner SQL, before the JSONB opportunities leave PostgreSQL. */
export const opportunityReachSql = (predicate: ListAccessPredicate, row: SQL, tenantId: string): SQL =>
  and(
    ...predicate.groups.map(
      (group) =>
        or(
          ...group.clauses.map(
            (clause) =>
              and(...clause.conditions.map((condition) => conditionSql(condition, row, tenantId))) ?? sql`false`,
          ),
        ) ?? sql`false`,
    ),
  ) ?? sql`true`;
