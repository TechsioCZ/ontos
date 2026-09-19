import { ActionAuthorizationPreflightDatabase, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import type { ActionAuthorizationPreflightTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';

import type {
  CommerceEnrollmentOwnerScope,
  EnrollmentAttemptScopedRoutineInvoker,
} from '../attempts/attempt-persistence.ts';
import { CommerceEnrollmentAttemptErrorSchema, CommerceEnrollmentAttemptUnavailable } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from './owner-transition-production.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from './owner-transition-production.ts';

/**
 * A transaction that did not complete is retryable and never a definitive owner denial: the
 * SECURITY DEFINER Attempt routines are the only authority on whether a transition happened.
 */
const transactionUnavailable = <Cause>(cause: Cause): CommerceEnrollmentAttemptError =>
  Object.defineProperty(
    new CommerceEnrollmentAttemptUnavailable({
      code: 'attempt_unavailable',
      reason: 'The durable Enrollment Attempt transaction could not be completed',
      retryable: true,
    }),
    'cause',
    { configurable: false, enumerable: false, value: cause },
  );

/**
 * The operational scope is installed as transaction-local settings, so the Attempt routines verify
 * the exact Tenant they were handed and every row stays inside its own tenant policy.
 */
const installOwnerScope = (transaction: ActionAuthorizationPreflightTransaction, scope: CommerceEnrollmentOwnerScope) =>
  transaction.execute(
    sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
    'objects',
  );

const ownerRoutineInvoker = (
  transaction: ActionAuthorizationPreflightTransaction,
  scope: CommerceEnrollmentOwnerScope,
): EnrollmentAttemptScopedRoutineInvoker =>
  scopedRoutineInvokerFromTransaction((statement) => transaction.execute(statement, 'objects'), scope);

const runScopedOwnerPhase = <Value>(
  transaction: ActionAuthorizationPreflightTransaction,
  scope: CommerceEnrollmentOwnerScope,
  operation: (invoker: EnrollmentAttemptScopedRoutineInvoker) => Effect.Effect<Value, CommerceEnrollmentAttemptError>,
): Effect.Effect<Value, CommerceEnrollmentAttemptError> =>
  installOwnerScope(transaction, scope).pipe(
    Effect.flatMap(() => operation(ownerRoutineInvoker(transaction, scope))),
    Effect.mapError((failure) =>
      Schema.is(CommerceEnrollmentAttemptErrorSchema)(failure) ? failure : transactionUnavailable(failure),
    ),
  );

/**
 * One owner phase, one transaction, on the vertical's own governed database connection. Nothing
 * here touches the Commerce portal-auth provider pool: the Enrollment Attempt journal is
 * Commerce-owned business state, not provider state, and it must never share a transaction with
 * the governed Action that prepared the owner binding.
 */
export const CommerceEnrollmentOwnerTransactionRunnerLive = Layer.effect(
  CommerceEnrollmentOwnerTransactionRunner,
  Effect.gen(function* makeCommerceEnrollmentOwnerTransactionRunnerLive() {
    const database = yield* ActionAuthorizationPreflightDatabase;
    const run: CommerceEnrollmentOwnerTransactionRun = (scope, operation) =>
      database
        .transaction((transaction) => runScopedOwnerPhase(transaction, scope, operation))
        .pipe(
          Effect.mapError((failure) =>
            Schema.is(CommerceEnrollmentAttemptErrorSchema)(failure) ? failure : transactionUnavailable(failure),
          ),
        );
    return { run };
  }),
);
