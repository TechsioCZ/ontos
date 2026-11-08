import type { OwnerAuthorizationInput } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { retailAccessDecisionRead } from '../../src/api/retail-access-decision.read.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const compositionRevision = 'a'.repeat(64);
const principal = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:retail-decision-permission',
  authMethod: 'session' as const,
  legalEntityId,
  principalId: '66666666-6666-4666-8666-666666666666',
  tenantId,
};
const scope = { ...principal, correlationId: 'retail-decision-permission' };
const input = {
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
  requiredPermission: 'retail.consent.manage',
} as const;
/** The same request with a caller-chosen profile reference; the literals above stay the trusted ones. */
interface RequestedInput {
  readonly profileRef: {
    readonly moduleId: 'commerce.customer-context';
    readonly resourceId: string;
    readonly resourceType: 'commerce.customer-context.retail-customer-profile';
    readonly tenantId: string;
  };
  readonly requiredPermission: 'retail.consent.manage';
}
const ownerFactories = Layer.mergeAll(
  partyRegistryGuestResolverFactoryLive,
  partyRegistryRetailPartyResolverFactoryLive,
  profileCounterpartyRoleEligibilityResolverFactoryLive,
  profileReactivationEligibilityEvaluatorFactoryLive.pipe(Layer.provide(profileReconfirmationPolicyUnavailableLive)),
);
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-22T10:00:00.000Z'));
const runRead = (harness: Effect.Success<ReturnType<typeof makeReadTestHarness>>, requested: RequestedInput) =>
  harness.runtime
    .runRead({
      input: requested,
      principal,
      registration: retailAccessDecisionRead,
      transport: { correlationId: scope.correlationId },
    })
    .pipe(Effect.provide(ownerFactories.pipe(Layer.provide(harness.layer))));

it.layer(NodeCrypto.layer)('retail access decision runtime authorization', (suite) => {
  suite.effect('hands the Retail profile and its capability to the owner rule before the handler runs', () =>
    Effect.gen(function* exactPermissionAdmitted() {
      const ownerInputs: OwnerAuthorizationInput[] = [];
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        compositionRevision,
        executeOwnerQuery: (query) => {
          expect(query.sql).toContain('resolve_retail_principal');
          expect(query.scope).toEqual({ legalEntityId, tenantId });
          expect(query.params).toEqual([tenantId, legalEntityId, profileId, principal.principalId]);
          return Effect.succeed([{ outcome: 'PROFILE_NOT_FOUND', payload: null }]);
        },
        onOwnerAuthorization: (ownerInput) => {
          ownerInputs.push(ownerInput);
          return 'allowed' as const;
        },
        operationTime,
        ownerRegistration: commerceCustomerContextRegistration,
        scope,
      });
      const failure = yield* Effect.flip(runRead(harness, input));

      expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
      // The gate decided the read's own declaration; the owner rule then got the Retail profile and the
      // capability the request asks about, so the profile's own durable state is the second authority (O70).
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(ownerInputs.map((ownerInput) => ownerInput.ownerFacts)).toEqual([
        { retailPermission: input.requiredPermission, retailProfileId: profileId },
      ]);
    }),
  );

  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`${decision} at the gate stops before owner SQL or the handler`, () =>
      Effect.gen(function* deniedAuthority() {
        const harness = yield* makeReadTestHarness({
          access: decision,
          compositionRevision,
          executeOwnerQuery: () => Effect.die('Denied authority must not reach owner SQL'),
          operationTime,
          ownerRegistration: commerceCustomerContextRegistration,
          scope,
        });
        const failure = yield* Effect.flip(runRead(harness, input));

        expect(
          Predicate.isTagged(failure, decision === 'denied' ? 'ReadPermissionDenied' : 'ReadPermissionUnavailable'),
        ).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    );
  }

  // The capability gate answers ALLOWED for every request; the read's own reference checks are the
  // decider (O67-Q1, O70). A request that names a foreign Retail profile or Tenant is refused on
  // that reference, not silently treated as the trusted one.
  for (const foreign of ['profile', 'tenant'] as const) {
    suite.effect(`refuses a foreign ${foreign} reference while the capability gate answers ALLOWED`, () =>
      Effect.gen(function* foreignReferenceRefused() {
        const ownerInputs: OwnerAuthorizationInput[] = [];
        const harness = yield* makeReadTestHarness({
          access: 'allowed',
          compositionRevision,
          executeOwnerQuery: (query) => {
            expect(query.sql).toContain('resolve_retail_principal');
            return Effect.succeed([{ outcome: 'PROFILE_NOT_FOUND', payload: null }]);
          },
          onOwnerAuthorization: (ownerInput) => {
            ownerInputs.push(ownerInput);
            return 'allowed' as const;
          },
          operationTime,
          ownerRegistration: commerceCustomerContextRegistration,
          scope,
        });
        const requested: RequestedInput = {
          ...input,
          profileRef: {
            ...input.profileRef,
            resourceId: foreign === 'profile' ? '77777777-7777-4777-8777-777777777777' : profileId,
            tenantId: foreign === 'tenant' ? '88888888-8888-4888-8888-888888888888' : tenantId,
          },
        };
        const failure = yield* Effect.flip(runRead(harness, requested));

        // The owner rule is handed the request's own profile reference, never a caller-renamed one,
        // and the read's own reference check is what refuses the foreign profile or Tenant.
        expect(ownerInputs.at(-1)?.ownerFacts).toEqual({
          retailPermission: input.requiredPermission,
          retailProfileId: requested.profileRef.resourceId,
        });
        expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
        if (foreign === 'tenant') {
          // The trusted-Tenant comparison refuses before any owner SQL is issued.
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }
      }),
    );
  }
});
