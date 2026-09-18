import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Context, Effect } from 'effect';

import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../attempts/attempt-persistence.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../attempts/errors.ts';
import { commerceEnrollmentAttemptServiceForPersistence } from '../attempts/attempt-service.ts';
import type {
  CommerceEnrollmentAttemptReconciliationAuthority,
  CommerceEnrollmentAttemptService,
} from '../attempts/attempt-service.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from './owner-transition-driver.ts';
import { commerceEnrollmentOwnerAttemptStoreForFreshService } from './owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerTransitionPreparation,
  CommerceEnrollmentOwnerTransitionPreparationResult,
  CommerceEnrollmentPreparedOwnerBinding,
} from './prepared-owner-authority.ts';

/**
 * Public composition seam for an owner transaction. Core owns the database and transaction
 * lifecycle; Commerce only receives the already scoped executor for one callback. Implementations
 * must start a new database transaction for every `run` call and install `scope` before invoking
 * the callback.
 */
export interface CommerceEnrollmentOwnerTransactionRunnerService {
  readonly run: <Value>(
    scope: OperationalScope,
    operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, CommerceEnrollmentAttemptError>,
  ) => Effect.Effect<Value, CommerceEnrollmentAttemptError>;
}

/** The Context tag that names the runner contract for the root composition that supplies it. */
export class CommerceEnrollmentOwnerTransactionRunner extends Context.Service<
  CommerceEnrollmentOwnerTransactionRunner,
  CommerceEnrollmentOwnerTransactionRunnerService
>()(
  '@app/commerce-customer-context/enrollment/orchestration/owner-transition-production/CommerceEnrollmentOwnerTransactionRunner',
) {}

/**
 * The service is intentionally constructed inside the transaction callback. Capturing a
 * ScopedTransactionExecutor in a long-lived Action or HTTP service would let owner HTTP span the
 * Action transaction; this factory keeps every Attempt phase independently committed.
 */
interface CommerceEnrollmentOwnerAttemptServiceForScopeOptions {
  readonly reconciliationAuthority: CommerceEnrollmentAttemptReconciliationAuthority;
  readonly runner: CommerceEnrollmentOwnerTransactionRunnerService;
  readonly scope: OperationalScope;
}

const makeCommerceEnrollmentOwnerAttemptServiceForScope = (
  // eslint-disable-next-line effect-native/no-dependency-parameters -- The runner is the explicit Core composition seam for this production adapter. expires: 2027-09-17.
  options: CommerceEnrollmentOwnerAttemptServiceForScopeOptions,
): CommerceEnrollmentAttemptService => {
  const { reconciliationAuthority, runner, scope } = options;
  const run = <Value>(
    // oxlint-disable-next-line effect-native/no-dependency-parameters -- This callback is executed against a newly constructed Attempt service inside each fresh transaction. expires: 2027-09-17.
    operation: (service: CommerceEnrollmentAttemptService) => Effect.Effect<Value, CommerceEnrollmentAttemptError>,
  ): Effect.Effect<Value, CommerceEnrollmentAttemptError> =>
    runner.run(scope, (transaction) =>
      operation(
        commerceEnrollmentAttemptServiceForPersistence(
          commerceEnrollmentAttemptPersistenceForTransaction(transaction, scope),
          reconciliationAuthority,
        ),
      ),
    );

  const claimTransition: CommerceEnrollmentAttemptService['claimTransition'] = (input) =>
    run((service) => service.claimTransition(input));
  const read: CommerceEnrollmentAttemptService['read'] = (input) => run((service) => service.read(input));
  const readOwnerOperation: CommerceEnrollmentAttemptService['readOwnerOperation'] = (input) =>
    run((service) => service.readOwnerOperation(input));
  const reconcileOutcome: CommerceEnrollmentAttemptService['reconcileOutcome'] = (input) =>
    run((service) => service.reconcileOutcome(input));
  const recordOutcome: CommerceEnrollmentAttemptService['recordOutcome'] = (input) =>
    run((service) => service.recordOutcome(input));
  const start: CommerceEnrollmentAttemptService['start'] = (input) => run((service) => service.start(input));
  const terminate: CommerceEnrollmentAttemptService['terminate'] = (input) =>
    run((service) => service.terminate(input));
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
 * A fresh service factory for the generic owner driver. `make` itself is cheap; each method on the
 * returned service enters a new transaction through the runner. Reconciliation receives its
 * already verified resolution only for the single reconcile/record phase.
 */
const makeCommerceEnrollmentOwnerAttemptFreshServiceFactory = (
  scope: OperationalScope,
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Core supplies the public transaction runner; this factory only captures the verified composition seam. expires: 2027-09-17.
  runner: CommerceEnrollmentOwnerTransactionRunnerService,
) => ({
  make: (resolution?: ReconcileEnrollmentResolution) =>
    Effect.succeed(
      makeCommerceEnrollmentOwnerAttemptServiceForScope({
        reconciliationAuthority:
          resolution === undefined
            ? unavailableReconciliationAuthority()
            : {
                resolve: () => Effect.succeed(resolution),
              },
        runner,
        scope,
      }),
    ),
});

/**
 * Build the production generic owner store from the fresh per-phase transaction factory. The
 * transaction runner is taken from the Context tag the root composition supplies, so Commerce
 * never captures a Core transaction seam as a long-lived constructor argument.
 */
export const makeCommerceEnrollmentOwnerAttemptStoreForProduction = Effect.fn(
  'CommerceEnrollmentOwnerTransactionRunner.makeOwnerAttemptStore',
)(function* makeOwnerAttemptStoreForProduction(
  scope: OperationalScope,
): Effect.fn.Return<CommerceEnrollmentOwnerAttemptStore, never, CommerceEnrollmentOwnerTransactionRunner> {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  return commerceEnrollmentOwnerAttemptStoreForFreshService(
    makeCommerceEnrollmentOwnerAttemptFreshServiceFactory(scope, runner),
  );
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

const unavailablePreparation: CommerceEnrollmentOwnerTransitionPreparationResult = Object.freeze({
  outcome: 'unavailable' as const,
});

/**
 * Route preparation to an explicitly installed owner port. A missing port fails closed so an
 * Action cannot proceed on a claimed payload without owner evidence. Owner ports must bind the
 * complete input they receive (Actor, Tenant, Attempt, Action/owner invocation, module,
 * transition, revision and digest where present) and return only compact evidence.
 */
export const makeCommerceEnrollmentOwnerTransitionPreparationAuthorityForPorts = (
  ports: readonly CommerceEnrollmentOwnerPreparationPort[],
): CommerceEnrollmentOwnerTransitionPreparation['Service'] =>
  Object.freeze({
    prepare: (input: CommerceEnrollmentPreparedOwnerBinding) => {
      const port = ports.find(
        (candidate) =>
          candidate.ownerModuleKey === input.ownerModuleKey && candidate.transitionKey === input.transitionKey,
      );
      return port === undefined ? Effect.succeed(unavailablePreparation) : port.prepare(input);
    },
  });
