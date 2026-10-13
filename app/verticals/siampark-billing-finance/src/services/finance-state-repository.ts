import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { FinanceConflict, FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { financeStates } from '../database/schema.ts';

/*
 * The Action/Read adapter over the scoped transaction. It lives apart from the pure transitions in
 * persistence.service.ts so the Outbox Worker bundle, which persists through scoped routines, never
 * pulls the request-time Core runtime into the worker host.
 */
type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const conflict = (reason: string) => new FinanceConflict({ code: 'finance_conflict', reason });
const unavailable = (cause?: Error) =>
  Object.defineProperty(
    new FinancePersistenceUnavailable({
      code: 'finance_persistence_unavailable',
      reason: 'Finance persistence is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );
export const persistenceService = (transaction: Transaction, scope: OperationalScope) => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'A Legal Entity scope is required',
      }),
    );
  }
  const scopeWhere = and(
    eq(financeStates.tenantId, scope.tenantId),
    eq(financeStates.legalEntityId, scope.legalEntityId),
  );
  return Effect.succeed({
    load: () =>
      transaction
        .select()
        .from(financeStates)
        .where(scopeWhere)
        .limit(1)
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.fail(unavailable())
              : Schema.decodeEffect(FinanceStateSchema)(row.state).pipe(
                  Effect.mapError(unavailable),
                  Effect.map((state) => ({ revision: row.revision, state })),
                ),
          ),
        ),
    save: Effect.fn('Finance.save')(function* save(state: FinanceState, expectedRevision: number) {
      const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state).pipe(Effect.mapError(unavailable));
      const now = yield* DateTime.now;
      const rows = yield* transaction
        .update(financeStates)
        .set({ revision: expectedRevision + 1, state: encoded, updatedAt: DateTime.toDateUtc(now) })
        .where(and(scopeWhere, eq(financeStates.revision, expectedRevision)))
        .returning({ revision: financeStates.revision })
        .pipe(Effect.mapError(unavailable));
      const [row] = rows;
      if (row === undefined) {
        return yield* conflict('stale_revision');
      }
      return row.revision;
    }),
  });
};
