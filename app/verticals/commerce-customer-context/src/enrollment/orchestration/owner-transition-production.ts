import { Context, Effect } from 'effect';

import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import type {
  CommerceEnrollmentOwnerScope,
  DueEnrollmentAttempt,
  EnrollmentAttemptScopedRoutineInvoker,
  EnrollmentDueWorkExecution,
  ListDueEnrollmentAttemptsInput,
  RecordEnrollmentSweepInput,
} from '../attempts/attempt-persistence.ts';
import {
  commerceEnrollmentAttemptPersistenceForTransaction,
  commerceEnrollmentDueWorkForExecution,
} from '../attempts/attempt-persistence.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../attempts/errors.ts';
import { commerceEnrollmentAttemptServiceForPersistence } from '../attempts/attempt-service.ts';
import type {
  CommerceEnrollmentAttemptReconciliationAuthority,
  CommerceEnrollmentAttemptService,
} from '../attempts/attempt-service.ts';
import { commerceEnrollmentCompletionAuthorityForPersistence } from './completion.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from './owner-transition-driver.ts';
import { commerceEnrollmentOwnerAttemptStoreForFreshService } from './owner-transition-driver.ts';
import { ownerPreparationUnavailable } from './prepared-owner-authority.ts';
import type {
  CommerceEnrollmentOwnerTransitionPreparation,
  CommerceEnrollmentOwnerTransitionPreparationResult,
  CommerceEnrollmentPreparedOwnerBinding,
} from './prepared-owner-authority.ts';

/**
 * One owner phase, one transaction. A deployment owns the database and transaction lifecycle;
 * Commerce only receives the already scoped Attempt routine invoker for one callback.
 * Implementations must start a new database transaction for every call and install `scope` as
 * transaction-local settings before invoking the callback.
 */
export type CommerceEnrollmentOwnerTransactionRun = <Value>(
  scope: CommerceEnrollmentOwnerScope,
  operation: (
    transaction: EnrollmentAttemptScopedRoutineInvoker,
  ) => Effect.Effect<Value, CommerceEnrollmentAttemptError>,
) => Effect.Effect<Value, CommerceEnrollmentAttemptError>;

/**
 * One worker tick, one transaction, with no operational scope installed. It is the same governed
 * connection `run` opens, minus the Tenant: the cross-Tenant due-work routine is the one Attempt
 * surface that answers before any Tenant is known, and it refuses a transaction that installed one.
 * A deployment implements this by opening a transaction and handing over SQL execution unscoped.
 */
export type CommerceEnrollmentWorkerTransactionRun = <Value>(
  operation: (execute: EnrollmentDueWorkExecution) => Effect.Effect<Value, CommerceEnrollmentAttemptError>,
) => Effect.Effect<Value, CommerceEnrollmentAttemptError>;

/** Public composition seam for an owner transaction. */
export interface CommerceEnrollmentOwnerTransactionRunnerService {
  readonly run: CommerceEnrollmentOwnerTransactionRun;
  readonly runWorker: CommerceEnrollmentWorkerTransactionRun;
}

/** The Context tag that names the runner contract for the root composition that supplies it. */
export class CommerceEnrollmentOwnerTransactionRunner extends Context.Service<
  CommerceEnrollmentOwnerTransactionRunner,
  CommerceEnrollmentOwnerTransactionRunnerService
>()(
  '@app/commerce-customer-context/enrollment/orchestration/owner-transition-production/CommerceEnrollmentOwnerTransactionRunner',
) {}

const unavailableReconciliationAuthority = (): CommerceEnrollmentAttemptReconciliationAuthority => ({
  resolve: (input) =>
    Effect.fail(
      new CommerceEnrollmentAttemptUnavailable({
        attemptId: input.portalEnrollmentAttemptId,
        code: 'attempt_unavailable',
        reason: 'An owner reconciliation authority is required for this Attempt phase',
        retryable: true,
      }),
    ),
});

/**
 * The Attempt service is intentionally constructed inside the transaction callback. Capturing a
 * transaction-bound invoker in a long-lived Action or HTTP service would let owner HTTP span the
 * Attempt transaction; this keeps every Attempt phase independently committed.
 */
const attemptServiceForScope = (
  scope: CommerceEnrollmentOwnerScope,
  run: CommerceEnrollmentOwnerTransactionRun,
  reconciliationAuthority: CommerceEnrollmentAttemptReconciliationAuthority,
): CommerceEnrollmentAttemptService => {
  const attemptFor = (transaction: EnrollmentAttemptScopedRoutineInvoker) => {
    const persistence = commerceEnrollmentAttemptPersistenceForTransaction(transaction, scope);
    return commerceEnrollmentAttemptServiceForPersistence(
      persistence,
      reconciliationAuthority,
      commerceEnrollmentCompletionAuthorityForPersistence(persistence),
    );
  };

  const claimTransition: CommerceEnrollmentAttemptService['claimTransition'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).claimTransition(input));
  const read: CommerceEnrollmentAttemptService['read'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).read(input));
  const readOwnerOperation: CommerceEnrollmentAttemptService['readOwnerOperation'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).readOwnerOperation(input));
  const reconcileOutcome: CommerceEnrollmentAttemptService['reconcileOutcome'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).reconcileOutcome(input));
  const recordOutcome: CommerceEnrollmentAttemptService['recordOutcome'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).recordOutcome(input));
  const start: CommerceEnrollmentAttemptService['start'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).start(input));
  const terminate: CommerceEnrollmentAttemptService['terminate'] = (input) =>
    run(scope, (transaction) => attemptFor(transaction).terminate(input));

  return Object.freeze({
    claimTransition,
    read,
    readOwnerOperation,
    reconcileOutcome,
    recordOutcome,
    start,
    terminate,
  });
};

/**
 * Build the production generic owner store from a transaction-runner function. `make` itself is
 * cheap; each method on the returned service enters a new transaction. Reconciliation receives its
 * already verified resolution only for the single reconcile/record phase.
 */
export const commerceEnrollmentOwnerAttemptStoreForRun = (
  scope: CommerceEnrollmentOwnerScope,
  run: CommerceEnrollmentOwnerTransactionRun,
): CommerceEnrollmentOwnerAttemptStore =>
  commerceEnrollmentOwnerAttemptStoreForFreshService({
    make: (resolution?: ReconcileEnrollmentResolution) =>
      Effect.succeed(
        attemptServiceForScope(
          scope,
          run,
          resolution === undefined
            ? unavailableReconciliationAuthority()
            : { resolve: () => Effect.succeed(resolution) },
        ),
      ),
  });

/**
 * The transaction runner is taken from the Context tag the root composition supplies, so Commerce
 * never captures a transaction seam as a long-lived constructor argument.
 */
export const makeCommerceEnrollmentOwnerAttemptStoreForProduction = Effect.fn(
  'CommerceEnrollmentOwnerTransactionRunner.makeOwnerAttemptStore',
)(function* makeOwnerAttemptStoreForProduction(
  scope: CommerceEnrollmentOwnerScope,
): Effect.fn.Return<CommerceEnrollmentOwnerAttemptStore, never, CommerceEnrollmentOwnerTransactionRunner> {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  return commerceEnrollmentOwnerAttemptStoreForRun(scope, runner.run);
});

/**
 * The durable due-work surface, kept apart from the per-Attempt owner store on purpose: every
 * method there is addressed by an Attempt identity the caller already holds, and this one exists
 * precisely for the Attempts nobody holds an identity for any more — including Attempts of Tenants
 * this process has never served, which is why it carries no scope at all.
 */
// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The store is built for one worker transaction at the call site, exactly as the owner attempt store is; it is not an ambient service. expires: 2027-09-17.
export interface CommerceEnrollmentDueAttemptStore {
  readonly listDue: (
    input: ListDueEnrollmentAttemptsInput,
  ) => Effect.Effect<readonly DueEnrollmentAttempt[], CommerceEnrollmentAttemptError>;
  readonly recordSweep: (input: RecordEnrollmentSweepInput) => Effect.Effect<number, CommerceEnrollmentAttemptError>;
}

/** One listing, one worker transaction, on the same governed connection every owner phase uses. */
export const commerceEnrollmentDueAttemptStoreForRun = (
  runWorker: CommerceEnrollmentWorkerTransactionRun,
): CommerceEnrollmentDueAttemptStore => ({
  listDue: (input) => runWorker((execute) => commerceEnrollmentDueWorkForExecution(execute).listDue(input)),
  recordSweep: (input) => runWorker((execute) => commerceEnrollmentDueWorkForExecution(execute).recordSweep(input)),
});

/** A public owner adapter for preparing exact Action bindings before ordinary Core authorization. */
// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This is the explicit owner adapter contract supplied to the preparation router; it is not an ambient service. expires: 2027-09-17.
export interface CommerceEnrollmentOwnerPreparationPort {
  readonly ownerModuleKey: CommerceEnrollmentPreparedOwnerBinding['ownerModuleKey'];
  readonly prepare: (
    input: CommerceEnrollmentPreparedOwnerBinding,
  ) => Effect.Effect<CommerceEnrollmentOwnerTransitionPreparationResult>;
  readonly transitionKey: CommerceEnrollmentPreparedOwnerBinding['transitionKey'];
}

const preparationRegistryKey = (
  binding: Pick<CommerceEnrollmentPreparedOwnerBinding, 'ownerModuleKey' | 'transitionKey'>,
): string => `${binding.ownerModuleKey}/${binding.transitionKey}`;

/**
 * Route preparation to an explicitly installed owner port. A missing port fails closed so an
 * Action cannot proceed on a claimed payload without owner evidence. Owner ports must bind the
 * complete input they receive (Actor, Tenant, Attempt, Action/owner invocation, module,
 * transition, revision and digest where present) and return only compact evidence.
 *
 * The earliest port declared for a transition owns it: a pair an owner-authoritative port already
 * installs is never shadowed by a later, journey-derived one.
 */
export const commerceEnrollmentOwnerTransitionPreparationAuthorityForPorts = (
  ports: readonly CommerceEnrollmentOwnerPreparationPort[],
): CommerceEnrollmentOwnerTransitionPreparation['Service'] => {
  // `Map` keeps the last entry written for a key, so the reversal is what makes the first win.
  const registry = new Map(ports.map((port) => [preparationRegistryKey(port), port] as const).toReversed());
  return Object.freeze({
    prepare: (input: CommerceEnrollmentPreparedOwnerBinding) => {
      const port = registry.get(preparationRegistryKey(input));
      return port === undefined ? Effect.succeed(ownerPreparationUnavailable) : port.prepare(input);
    },
  });
};
