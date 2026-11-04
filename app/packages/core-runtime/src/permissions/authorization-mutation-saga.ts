import { Effect } from 'effect';
import type { AuthorizationMutationJournalEntry, AuthorizationMutationState } from './authorization-mutation.ts';
import { canTransitionAuthorizationMutation } from './authorization-mutation.ts';
import { AuthorizationMutationSagaError } from './authorization-mutation-saga-error.ts';
import { isOwnerPermissionAccessTargetMetadataValid } from './context-access.ts';
import type { OwnerPermissionAccessTarget } from './context-access.ts';
import type {
  BusinessPermissionRelationshipMutationInput,
  BusinessPermissionRelationshipMutationService,
} from './business-permission-mutation.ts';

export { AuthorizationMutationSagaError } from './authorization-mutation-saga-error.ts';
export type { AuthorizationMutationSagaErrorCode } from './authorization-mutation-saga-error.ts';

export interface AuthorizationMutationSagaFinalizer<Target extends object = object> {
  /**
   * Finalize the exact durable intent in an owner-controlled transaction. Implementations must
   * compare the mutation identity and complete idempotently when the requested terminal state is
   * already present.
   */
  readonly finalize: (input: {
    readonly mutationId: string;
    readonly to: 'ACTIVE' | 'REVOKED';
  }) => Effect.Effect<AuthorizationMutationJournalEntry<Target>, AuthorizationMutationSagaError>;
}

export interface AuthorizationMutationSagaResult<Target extends object = object> {
  readonly entry: AuthorizationMutationJournalEntry<Target>;
  readonly outcome: 'ALREADY_FINAL' | 'FINALIZED';
}

const failure = (
  code: ConstructorParameters<typeof AuthorizationMutationSagaError>[0]['code'],
  reason: string,
  externalMutationMayHaveSucceeded: boolean,
  cause?: unknown,
): AuthorizationMutationSagaError =>
  new AuthorizationMutationSagaError({
    cause,
    code,
    externalMutationMayHaveSucceeded,
    reason,
    retryable:
      code !== 'authorization_mutation_intent_invalid' && code !== 'authorization_mutation_final_state_invalid',
  });

const desiredState = (operation: AuthorizationMutationJournalEntry['operation']): 'ACTIVE' | 'REVOKED' =>
  operation === 'grant' ? 'ACTIVE' : 'REVOKED';

const expectedPendingState = (
  operation: AuthorizationMutationJournalEntry['operation'],
): 'PENDING_GRANT' | 'PENDING_REVOKE' => (operation === 'grant' ? 'PENDING_GRANT' : 'PENDING_REVOKE');

const validIntentScope = (entry: AuthorizationMutationJournalEntry, target: OwnerPermissionAccessTarget): boolean =>
  isOwnerPermissionAccessTargetMetadataValid(target) &&
  entry.mutationId.length > 0 &&
  entry.principal.principalId.length > 0 &&
  entry.principal.tenantId === target.scope.tenantId &&
  entry.permission === target.definition.key;

const validReconciliableState = (entry: AuthorizationMutationJournalEntry): boolean => {
  const terminal = desiredState(entry.operation);
  return (
    entry.state === terminal ||
    entry.state === expectedPendingState(entry.operation) ||
    entry.state === 'RECONCILIATION_REQUIRED'
  );
};

const sameIntent = (
  before: AuthorizationMutationJournalEntry,
  after: AuthorizationMutationJournalEntry,
  state: AuthorizationMutationState,
): boolean =>
  after.mutationId === before.mutationId &&
  after.operation === before.operation &&
  after.permission === before.permission &&
  after.principal.tenantId === before.principal.tenantId &&
  after.principal.principalId === before.principal.principalId &&
  after.correlationId === before.correlationId &&
  after.state === state;

const relationshipInput = (
  entry: AuthorizationMutationJournalEntry,
  target: OwnerPermissionAccessTarget,
): BusinessPermissionRelationshipMutationInput => {
  const input = { operation: entry.operation, principal: entry.principal, target };
  return target.requiredStorefrontId === undefined
    ? input
    : { ...input, trustedStorefrontId: target.requiredStorefrontId };
};

/**
 * Reconciles one independently committed authorization intent.
 *
 * The owner must call this only after the Action transaction that created the intent has
 * committed. The relationship write is deliberately idempotent. If it succeeds or has an
 * ambiguous acknowledgement and durable finalization then fails, the original intent remains the
 * recovery anchor and a retry safely repeats the exact relationship write.
 */
export const reconcileCommittedAuthorizationMutation = Effect.fn('AuthorizationMutationSaga.reconcileCommitted')(
  function* reconcileCommittedAuthorizationMutationEffect<Target extends object>(
    entry: AuthorizationMutationJournalEntry<Target>,
    relationship: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
    finalizer: AuthorizationMutationSagaFinalizer<Target>,
    prepareTarget: (entry: AuthorizationMutationJournalEntry<Target>) => OwnerPermissionAccessTarget | undefined,
  ): Effect.fn.Return<AuthorizationMutationSagaResult<Target>, AuthorizationMutationSagaError> {
    const terminal = desiredState(entry.operation);
    const target = yield* Effect.try({
      catch: (cause) =>
        failure(
          'authorization_mutation_intent_invalid',
          'The owner authorization mutation target cannot be verified',
          false,
          cause,
        ),

      try: () => prepareTarget(entry),
    });
    if (target === undefined || !validIntentScope(entry, target) || !validReconciliableState(entry)) {
      return yield* failure(
        'authorization_mutation_intent_invalid',
        'The durable authorization mutation intent is invalid or conflicts with its operation',
        false,
      );
    }
    if (entry.state === terminal) {
      return { entry, outcome: 'ALREADY_FINAL' };
    }
    if (!canTransitionAuthorizationMutation(entry.state, terminal)) {
      return yield* failure(
        'authorization_mutation_intent_invalid',
        'The durable authorization mutation intent cannot enter its requested terminal state',
        false,
      );
    }

    yield* relationship
      .mutate(relationshipInput(entry, target))
      .pipe(
        Effect.mapError((cause) =>
          failure(
            'authorization_mutation_relationship_indeterminate',
            'The authorization relationship mutation remains indeterminate and must be retried',
            true,
            cause,
          ),
        ),
      );

    const finalized = yield* finalizer
      .finalize({ mutationId: entry.mutationId, to: terminal })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            'authorization_mutation_finalization_indeterminate',
            'The relationship may be current but durable authorization finalization is indeterminate',
            true,
            cause,
          ),
        ),
      );
    const finalizedTarget = yield* Effect.try({
      catch: (cause) =>
        failure(
          'authorization_mutation_final_state_invalid',
          'The owner authorization finalization target cannot be verified',
          true,
          cause,
        ),

      try: () => prepareTarget(finalized),
    });
    if (
      finalizedTarget === undefined ||
      !validIntentScope(finalized, finalizedTarget) ||
      finalizedTarget.contract !== target.contract ||
      finalizedTarget.definition !== target.definition ||
      finalizedTarget.key !== target.key ||
      finalizedTarget.objectId !== target.objectId ||
      !sameIntent(entry, finalized, terminal)
    ) {
      return yield* failure(
        'authorization_mutation_final_state_invalid',
        'Durable authorization finalization returned a different mutation or state',
        true,
      );
    }
    return { entry: finalized, outcome: 'FINALIZED' };
  },
);
