import { Effect } from 'effect';
import type { AuthorizationMutationJournalEntry, AuthorizationMutationState } from './authorization-mutation.ts';
import { canTransitionAuthorizationMutation } from './authorization-mutation.ts';
import { AuthorizationMutationSagaError } from './authorization-mutation-saga-error.ts';
import type {
  BusinessPermissionRelationshipMutationInput,
  BusinessPermissionRelationshipMutationService,
} from './business-permission-mutation.ts';

export { AuthorizationMutationSagaError } from './authorization-mutation-saga-error.ts';
export type { AuthorizationMutationSagaErrorCode } from './authorization-mutation-saga-error.ts';

export interface AuthorizationMutationSagaFinalizer {
  /**
   * Finalize the exact durable intent in an owner-controlled transaction. Implementations must
   * compare the mutation identity and complete idempotently when the requested terminal state is
   * already present.
   */
  readonly finalize: (input: {
    readonly mutationId: string;
    readonly to: 'ACTIVE' | 'REVOKED';
  }) => Effect.Effect<AuthorizationMutationJournalEntry, AuthorizationMutationSagaError>;
}

export interface AuthorizationMutationSagaResult {
  readonly entry: AuthorizationMutationJournalEntry;
  readonly outcome: 'ALREADY_FINAL' | 'FINALIZED';
}

const failure = (
  code: ConstructorParameters<typeof AuthorizationMutationSagaError>[0]['code'],
  reason: string,
  externalMutationMayHaveSucceeded: boolean,
  cause?: unknown,
): AuthorizationMutationSagaError => {
  const error = new AuthorizationMutationSagaError({
    code,
    externalMutationMayHaveSucceeded,
    reason,
    retryable:
      code !== 'authorization_mutation_intent_invalid' && code !== 'authorization_mutation_final_state_invalid',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
      });
};

const desiredState = (operation: AuthorizationMutationJournalEntry['operation']): 'ACTIVE' | 'REVOKED' =>
  operation === 'grant' ? 'ACTIVE' : 'REVOKED';

const expectedPendingState = (
  operation: AuthorizationMutationJournalEntry['operation'],
): 'PENDING_GRANT' | 'PENDING_REVOKE' => (operation === 'grant' ? 'PENDING_GRANT' : 'PENDING_REVOKE');

const sameBusinessTarget = (
  left: AuthorizationMutationJournalEntry['businessTarget'],
  right: AuthorizationMutationJournalEntry['businessTarget'],
): boolean => {
  if (left.kind !== right.kind || left.tenantId !== right.tenantId || left.legalEntityId !== right.legalEntityId) {
    return false;
  }
  if (left.kind === 'counterparty') {
    return right.kind === 'counterparty' && left.counterpartyId === right.counterpartyId;
  }
  if (left.kind === 'counterparty_storefront') {
    return (
      right.kind === 'counterparty_storefront' &&
      left.counterpartyId === right.counterpartyId &&
      left.storefrontId === right.storefrontId
    );
  }
  return right.kind === 'retail_profile' && left.profileId === right.profileId;
};

const validIntentScope = (entry: AuthorizationMutationJournalEntry): boolean =>
  entry.mutationId.length > 0 &&
  entry.principal.principalId.length > 0 &&
  entry.principal.tenantId === entry.businessTarget.tenantId &&
  entry.businessTarget.tenantId.length > 0 &&
  entry.businessTarget.legalEntityId.length > 0 &&
  (entry.businessTarget.kind === 'retail_profile'
    ? entry.businessTarget.profileId.length > 0
    : entry.businessTarget.counterpartyId.length > 0 &&
      (entry.businessTarget.kind === 'counterparty' || entry.businessTarget.storefrontId.length > 0));

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
  sameBusinessTarget(after.businessTarget, before.businessTarget) &&
  after.state === state;

const relationshipInput = (entry: AuthorizationMutationJournalEntry): BusinessPermissionRelationshipMutationInput => {
  const input: BusinessPermissionRelationshipMutationInput = {
    operation: entry.operation,
    permission: entry.permission,
    principal: entry.principal,
    target: entry.businessTarget,
  };
  return entry.businessTarget.kind === 'counterparty_storefront'
    ? { ...input, trustedStorefrontId: entry.businessTarget.storefrontId }
    : input;
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
  function* reconcileCommittedAuthorizationMutationEffect(
    entry: AuthorizationMutationJournalEntry,
    relationship: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
    finalizer: AuthorizationMutationSagaFinalizer,
  ): Effect.fn.Return<AuthorizationMutationSagaResult, AuthorizationMutationSagaError> {
    const terminal = desiredState(entry.operation);
    if (!validIntentScope(entry) || !validReconciliableState(entry)) {
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
      .mutate(relationshipInput(entry))
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
    if (!sameIntent(entry, finalized, terminal)) {
      return yield* failure(
        'authorization_mutation_final_state_invalid',
        'Durable authorization finalization returned a different mutation or state',
        true,
      );
    }
    return { entry: finalized, outcome: 'FINALIZED' };
  },
);
