import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { prepareRetailProfileParty } from '../../src/profile-service-factory.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';

import {
  EnsureRetailCustomerProfilePayloadSchema,
  EnsureRetailCustomerProfileRejected,
} from '../../shared/actions/ensure-retail-customer-profile.ts';
import type {
  ProfilePersistenceDependencies,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../../src/persistence/profile-persistence.ts';
import {
  ProfilePersistenceDependencyFailure,
  profilePersistenceServicesForTransaction,
} from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const partyId = '40000000-0000-4000-8000-000000000004';
const profileId = '50000000-0000-4000-8000-000000000005';
const actionInvocationId = '60000000-0000-4000-8000-000000000006';
const effectiveAt = '2026-09-09T10:00:00.000Z';

const scope: ProfilePersistenceScope = { legalEntityId, principalId, tenantId };
const payload = Schema.decodeUnknownSync(EnsureRetailCustomerProfilePayloadSchema)({
  effectiveAt,
  subject: {
    kind: 'RETAIL',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
  trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
});

const context = {
  actionInvocationId,
  scope: {
    authMethod: 'session' as const,
    correlationId: 'retail-ensure-correlation',
    legalEntityId,
    principalId,
    tenantId,
  },
};

const resultRow = {
  outcome: 'PROFILE_CREATED',
  payload: {
    outcome: 'PROFILE_CREATED',
    profileRef: {
      kind: 'RETAIL',
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    },
    revision: 1,
    state: 'ACTIVE',
  },
};

const transactionWith = (onInvoke: (values: readonly unknown[]) => void): ProfileScopedRoutineInvoker => ({
  invoke: (_routine, values) => {
    onInvoke(values);
    return Effect.succeed([resultRow]);
  },
});

it.effect('requires exact current Party owner evidence before invoking Retail ensure persistence', () => {
  let observedParty: unknown;
  let observedValues: readonly unknown[] = [];
  const services = profilePersistenceServicesForTransaction(
    transactionWith((values) => {
      observedValues = values;
    }),
    scope,
  );
  const prepared: ProfilePersistenceDependencies = {
    resolveRetailParty: (input) => {
      observedParty = input;
      return Effect.succeed({
        outcome: 'CURRENT_PARTY_RESOLVED' as const,
        partyResourceId: partyId,
        partyResourceRevision: '7',
      });
    },
  };

  return services.ensureRetailCustomerProfile.ensure(payload, { ...context, prepared }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(observedParty).toEqual({ partyResourceId: partyId, tenantId });
        expect(observedValues).toEqual([
          partyId,
          '7',
          'AUTHENTICATED',
          effectiveAt,
          'ENSURE_BEFORE_ORDER_ACCEPTANCE',
          actionInvocationId,
          principalId,
        ]);
        expect(result.profileRef.resourceId).toBe(profileId);
      }),
    ),
  );
});

it.effect('does not mutate persistence when Party Registry returns an alias or non-current owner', () => {
  let invoked = false;
  const services = profilePersistenceServicesForTransaction(
    transactionWith(() => {
      invoked = true;
    }),
    scope,
  );
  const prepared: ProfilePersistenceDependencies = {
    resolveRetailParty: () => Effect.succeed({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const }),
  };

  return Effect.flip(services.ensureRetailCustomerProfile.ensure(payload, { ...context, prepared })).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(failure).toBeInstanceOf(EnsureRetailCustomerProfileRejected);
        expect(failure.code).toBe('SUBJECT_NOT_RESOLVED_OR_INVALID');
        expect(invoked).toBe(false);
      }),
    ),
  );
});

it.effect('maps owner unavailability to a retryable dependency rejection', () => {
  const services = profilePersistenceServicesForTransaction(
    transactionWith(() => {}),
    scope,
  );
  const prepared: ProfilePersistenceDependencies = {
    resolveRetailParty: () =>
      Effect.fail(
        new ProfilePersistenceDependencyFailure({
          reason: 'Party Registry unavailable',
        }),
      ),
  };

  return Effect.flip(services.ensureRetailCustomerProfile.ensure(payload, { ...context, prepared })).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(failure.code).toBe('DEPENDENCY_UNAVAILABLE');
        expect(failure.retryable).toBe(true);
      }),
    ),
  );
});

it.effect('reads Party Registry before the marked owner mutation and replays local evidence inside it', () =>
  Effect.gen(function* retailPreparationBoundary() {
    let remoteReads = 0;
    const prepared = yield* prepareRetailProfileParty(payload, {
      ...context,
      compositionRevision: 'a'.repeat(64),
      transaction: () => Effect.die('Retail Party preparation must not open an owner transaction'),
    }).pipe(
      Effect.provideService(PartyRegistryRetailPartyResolverFactory, {
        make: () => () =>
          refuseInsideDatabaseTransaction('module-transport', 'test.party-registry').pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                remoteReads += 1;
              }),
            ),
            Effect.as({
              outcome: 'CURRENT_PARTY_RESOLVED' as const,
              partyResourceId: partyId,
              partyResourceRevision: '7',
            }),
          ),
      }),
    );
    const services = profilePersistenceServicesForTransaction(
      transactionWith(() => {}),
      scope,
    );
    const result = yield* services.ensureRetailCustomerProfile
      .ensure(payload, { ...context, prepared })
      .pipe(insideDatabaseTransaction('test.retail-profile-ensure'));
    expect(result.profileRef.resourceId).toBe(profileId);
    expect(remoteReads).toBe(1);
  }),
);
