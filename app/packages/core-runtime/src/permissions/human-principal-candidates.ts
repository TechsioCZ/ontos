import { and, asc, eq, ilike } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { principals } from '../db/schema.ts';

export class PrincipalCandidatesUnavailable extends Schema.TaggedError<PrincipalCandidatesUnavailable>()(
  'PrincipalCandidatesUnavailable',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}

type HumanPrincipalCandidate = Pick<typeof principals.$inferSelect, 'displayName' | 'principalId'>;

/** Identity metadata only; the calling owner must separately authorize assignment to its exact target. */
export const humanPrincipalCandidatesForTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'select' | 'scope'>,
) => {
  const fields = { displayName: principals.displayName, principalId: principals.principalId };
  const activeHuman = and(
    eq(principals.tenantId, transaction.scope.tenantId),
    eq(principals.status, 'active'),
    eq(principals.kind, 'human'),
  );
  const unavailable = <Failure>(cause: Failure) =>
    new PrincipalCandidatesUnavailable({ cause, reason: 'Principal candidates are unavailable' });
  return {
    find: (principalId: string) =>
      transaction
        .select(fields)
        .from(principals)
        .where(and(activeHuman, eq(principals.principalId, principalId)))
        .limit(1)
        .for('share')
        .pipe(
          Effect.mapError(unavailable),
          Effect.map(([principal]): HumanPrincipalCandidate | undefined => principal),
        ),
    search: (query: string) => {
      const escapedQuery = query
        .replaceAll('\\', String.raw`\\`)
        .replaceAll('%', String.raw`\%`)
        .replaceAll('_', String.raw`\_`);
      return transaction
        .select(fields)
        .from(principals)
        .where(and(activeHuman, ilike(principals.displayName, `%${escapedQuery}%`)))
        .orderBy(asc(principals.displayName), asc(principals.principalId))
        .limit(50)
        .pipe(Effect.mapError(unavailable));
    },
  };
};
