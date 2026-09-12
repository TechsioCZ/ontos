import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AuthorizationMutationJournalEntry } from '../../src/permissions/authorization-mutation.ts';
import {
  AuthorizationMutationSagaError,
  reconcileCommittedAuthorizationMutation,
} from '../../src/permissions/authorization-mutation-saga.ts';
import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import { BusinessPermissionMutationUnavailable } from '../../src/permissions/business-permission-mutation-error.ts';

const permission = Schema.decodeSync(BusinessPermissionCodeSchema)('counterparty.access.manage');
const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';

const intent = (
  operation: 'grant' | 'revoke' = 'grant',
  state: AuthorizationMutationJournalEntry['state'] = operation === 'grant' ? 'PENDING_GRANT' : 'PENDING_REVOKE',
): AuthorizationMutationJournalEntry => ({
  attemptCount: 0,
  businessTarget: {
    counterpartyId: 'counterparty-one',
    kind: 'counterparty_storefront',
    legalEntityId,
    storefrontId: 'storefront-one',
    tenantId,
  },
  correlationId: 'correlation-one',
  mutationId: 'mutation-one',
  operation,
  permission,
  principal: { principalId, tenantId },
  state,
});

it.effect('does not call an external capability for an invalid or mismatched durable intent', () =>
  Effect.gen(function* rejectInvalidIntent() {
    let mutations = 0;
    let finalizations = 0;
    const failure = yield* Effect.flip(
      reconcileCommittedAuthorizationMutation(
        {
          ...intent(),
          principal: {
            principalId,
            tenantId: '50000000-0000-4000-8000-000000000001',
          },
        },
        {
          mutate: () =>
            Effect.sync(() => {
              mutations += 1;
            }),
        },
        {
          finalize: () =>
            Effect.sync(() => {
              finalizations += 1;
              return intent('grant', 'ACTIVE');
            }),
        },
      ),
    );
    expect(failure).toBeInstanceOf(AuthorizationMutationSagaError);
    expect(failure.code).toBe('authorization_mutation_intent_invalid');
    expect(failure.externalMutationMayHaveSucceeded).toBe(false);
    expect(mutations).toBe(0);
    expect(finalizations).toBe(0);
  }),
);

it.effect('applies only the exact persisted storefront scope and finalizes the same mutation', () =>
  Effect.gen(function* finalizeGrant() {
    const writes: unknown[] = [];
    const result = yield* reconcileCommittedAuthorizationMutation(
      intent(),
      {
        mutate: (input) =>
          Effect.sync(() => {
            writes.push(input);
          }),
      },
      { finalize: () => Effect.succeed(intent('grant', 'ACTIVE')) },
    );
    expect(result.outcome).toBe('FINALIZED');
    expect(result.entry.state).toBe('ACTIVE');
    expect(writes).toEqual([
      {
        operation: 'grant',
        permission,
        principal: { principalId, tenantId },
        target: intent().businessTarget,
        trustedStorefrontId: 'storefront-one',
      },
    ]);
  }),
);

it.effect('leaves the durable intent retryable when the relationship acknowledgement is ambiguous', () =>
  Effect.gen(function* retainIntentAfterMutationFailure() {
    let finalizations = 0;
    const failure = yield* Effect.flip(
      reconcileCommittedAuthorizationMutation(
        intent(),
        {
          mutate: () =>
            Effect.fail(
              new BusinessPermissionMutationUnavailable({
                reason: 'sanitized unavailable',
              }),
            ),
        },
        {
          finalize: () =>
            Effect.sync(() => {
              finalizations += 1;
              return intent('grant', 'ACTIVE');
            }),
        },
      ),
    );
    expect(failure.code).toBe('authorization_mutation_relationship_indeterminate');
    expect(failure.externalMutationMayHaveSucceeded).toBe(true);
    expect(failure.retryable).toBe(true);
    expect(finalizations).toBe(0);
  }),
);

it.effect('repeats an idempotent external write after a crash before durable finalization', () =>
  Effect.gen(function* recoverAfterExternalWrite() {
    const relationships = new Set<string>();
    let writes = 0;
    const relationship = {
      mutate: () =>
        Effect.sync(() => {
          writes += 1;
          relationships.add('exact-tuple');
        }),
    };
    const first = yield* Effect.flip(
      reconcileCommittedAuthorizationMutation(intent(), relationship, {
        finalize: () =>
          Effect.fail(
            new AuthorizationMutationSagaError({
              code: 'authorization_mutation_finalization_indeterminate',
              externalMutationMayHaveSucceeded: true,
              reason: 'simulated crash before DB acknowledgement',
              retryable: true,
            }),
          ),
      }),
    );
    expect(first.code).toBe('authorization_mutation_finalization_indeterminate');
    expect(first.externalMutationMayHaveSucceeded).toBe(true);
    expect(relationships.size).toBe(1);

    const retried = yield* reconcileCommittedAuthorizationMutation(intent(), relationship, {
      finalize: () => Effect.succeed(intent('grant', 'ACTIVE')),
    });
    expect(retried.outcome).toBe('FINALIZED');
    expect(writes).toBe(2);
    expect(relationships.size).toBe(1);
  }),
);

it.effect('does not repeat the external write after an ambiguous finalization actually committed', () =>
  Effect.gen(function* resolveCommittedFinalization() {
    let writes = 0;
    const result = yield* reconcileCommittedAuthorizationMutation(
      intent('revoke', 'REVOKED'),
      {
        mutate: () =>
          Effect.sync(() => {
            writes += 1;
          }),
      },
      { finalize: () => Effect.die('must not finalize a terminal intent') },
    );
    expect(result.outcome).toBe('ALREADY_FINAL');
    expect(result.entry.state).toBe('REVOKED');
    expect(writes).toBe(0);
  }),
);

it.effect('rejects a finalizer response for another tuple without claiming success', () =>
  Effect.gen(function* rejectDifferentFinalState() {
    const failure = yield* Effect.flip(
      reconcileCommittedAuthorizationMutation(
        intent(),
        { mutate: () => Effect.void },
        {
          finalize: () =>
            Effect.succeed({
              ...intent('grant', 'ACTIVE'),
              businessTarget: {
                ...intent().businessTarget,
                counterpartyId: 'counterparty-two',
              },
            }),
        },
      ),
    );
    expect(failure.code).toBe('authorization_mutation_final_state_invalid');
    expect(failure.externalMutationMayHaveSucceeded).toBe(true);
    expect(failure.retryable).toBe(false);
  }),
);

it.effect('applies the exact retail profile target without inventing storefront scope', () =>
  Effect.gen(function* reconcileRetailProfile() {
    const retailIntent: AuthorizationMutationJournalEntry = {
      ...intent(),
      businessTarget: {
        kind: 'retail_profile',
        legalEntityId,
        profileId: 'retail-profile-one',
        tenantId,
      },
    };
    const writes: unknown[] = [];
    const result = yield* reconcileCommittedAuthorizationMutation(
      retailIntent,
      {
        mutate: (input) =>
          Effect.sync(() => {
            writes.push(input);
          }),
      },
      {
        finalize: () =>
          Effect.succeed({
            ...retailIntent,
            state: 'ACTIVE',
          }),
      },
    );
    expect(result.outcome).toBe('FINALIZED');
    expect(writes).toEqual([
      {
        operation: 'grant',
        permission,
        principal: { principalId, tenantId },
        target: retailIntent.businessTarget,
      },
    ]);
  }),
);
