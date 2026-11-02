import { ContextAccess, TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { ContextAccessService, ReadRuntimeService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { invoiceRecipientResolutionRead } from '../../src/api/invoice-recipient-resolution.read.ts';
import { deliveryDestinationResolutionRead } from '../../src/api/delivery-destination-resolution.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const addressId = '44444444-4444-4444-8444-444444444444';
const compositionRevision = 'a'.repeat(64);
const principal = trustVerifiedGatewayPrincipalContext(
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '55555555-5555-4555-8555-555555555555',
    authContextRef: 'better-auth-session:purchase-permission',
    authMethod: 'session',
    legalEntityId,
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
    trustedStorefrontId: 'storefront-1',
  }),
  compositionRevision,
);
const scope = { ...principal, correlationId: 'purchase-resolution-plan', trustedStorefrontId: 'storefront-1' };
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const savedAddressRef = {
  moduleId: 'commerce.customer-context',
  resourceId: addressId,
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
} as const;
const purchasingContext = {
  cartId: 'cart-1',
  channelId: 'web',
  expectedProposalRevision: 1,
  expectedSourceRevisions: [{ revision: '1', source: 'cart' }],
  marketId: 'cz',
  sellingLegalEntityId: legalEntityId,
  storefrontId: scope.trustedStorefrontId,
  tenantId,
};
const counterpartyId = '77777777-7777-4777-8777-777777777777';
const counterpartyProfile = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  kind: 'COUNTERPARTY',
  profileRef: { ...profile.profileRef, resourceType: 'commerce.customer-context.counterparty-purchasing-profile' },
} as const;
const inputs = {
  counterparty: { purchasingContext, subject: { kind: 'PROFILE', profile: counterpartyProfile } },
  counterpartySaved: {
    explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef },
    purchasingContext,
    subject: { kind: 'PROFILE', profile: counterpartyProfile },
  },
  guest: {
    purchasingContext,
    subject: { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' },
  },
  oneTime: {
    explicitChoice: {
      choiceEvidenceRef: 'one-time-proof',
      kind: 'ONE_TIME',
      postalAddress: { addressLine1: '1 Unit Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
    },
    purchasingContext,
    subject: { kind: 'PROFILE', profile },
  },
  profile: { purchasingContext, subject: { kind: 'PROFILE', profile } },
  saved: {
    explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef },
    purchasingContext,
    subject: { kind: 'PROFILE', profile },
  },
} as const;
type Input = Readonly<object>;
const reads = [
  {
    name: 'Invoice',
    run: (runtime: ReadRuntimeService, input: Input) =>
      runtime
        .runRead({
          input,
          principal,
          registration: invoiceRecipientResolutionRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(Effect.asVoid),
  },
  {
    name: 'Delivery',
    run: (runtime: ReadRuntimeService, input: Input) =>
      runtime
        .runRead({
          input,
          principal,
          registration: deliveryDestinationResolutionRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(Effect.asVoid),
  },
];

it.layer(NodeCrypto.layer)('purchase resolution conditional authority', (suite) => {
  for (const read of reads) {
    const positiveInputs =
      read.name === 'Delivery'
        ? {
            ...inputs,
            pickup: {
              explicitChoice: {
                kind: 'PICKUP',
                pickupDestinationRef: {
                  moduleId: 'fulfillment',
                  resourceId: 'pickup-1',
                  resourceType: 'fulfillment.pickup-destination',
                  tenantId,
                },
              },
              purchasingContext,
              subject: { kind: 'PROFILE', profile },
            } as const,
          }
        : inputs;
    for (const [name, input] of Object.entries(positiveInputs)) {
      suite.effect(`${read.name} ${name} reaches its original handler after the exact permission plan`, () =>
        Effect.gen(function* reachesOwnerBoundary() {
          const calls: string[] = [];
          const harness = yield* makeReadTestHarness({
            businessPermissionDecision: (target) => {
              calls.push('business');
              if (input.subject.kind === 'PROFILE') {
                expect(target).toMatchObject(
                  input.subject.profile.kind === 'COUNTERPARTY'
                    ? {
                        permission: 'counterparty.address_book.use',
                        target: { counterpartyId, kind: 'counterparty', legalEntityId, tenantId },
                      }
                    : {
                        permission: 'retail.address_book.use',
                        target: { kind: 'retail_profile', legalEntityId, profileId, tenantId },
                      },
                );
              }
              return 'allowed';
            },
            compositionRevision,
            executeOwnerQuery: () => Effect.die('Unexpected owner SQL before missing Current evidence'),
            operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T10:00:00.000Z')),
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          });
          const contextAccess = Context.get(yield* Layer.build(harness.layer), ContextAccess);
          const checkResources: ContextAccessService['resources'] = ({ resources }) =>
            Effect.succeed(
              resources.map((resource) => {
                calls.push(resource.resourceId);
                return {
                  decision: 'allowed' as const,
                  key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
                };
              }),
            );
          Object.assign(contextAccess, { resources: checkResources });
          const failure = yield* Effect.flip(read.run(harness.runtime, input));
          expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
          expect(calls).toEqual(
            input.subject.kind === 'GUEST'
              ? []
              : [
                  'business',
                  profileId,
                  ...('explicitChoice' in input && input.explicitChoice.kind === 'SAVED_ADDRESS' ? [addressId] : []),
                ],
          );
          expect(harness.snapshot().evidenceWrites).toBe(0);
        }),
      );
    }
    for (const deniedId of [profileId, addressId]) {
      for (const decision of ['denied', 'unavailable'] as const) {
        suite.effect(`${read.name} requires the independent ${decision} resource read for ${deniedId}`, () =>
          Effect.gen(function* resourceConjunction() {
            const harness = yield* makeReadTestHarness({
              compositionRevision,
              executeOwnerQuery: () => Effect.die('Denied plan must not read owner SQL'),
              operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T10:00:00.000Z')),
              ownerAuthorizationDecision: 'allowed',
              permissionDecision: 'allowed',
              scope,
            });
            const contextAccess = Context.get(yield* Layer.build(harness.layer), ContextAccess);
            const checkResources: ContextAccessService['resources'] = ({ resources }) =>
              Effect.succeed(
                resources.map((resource) => ({
                  decision: resource.resourceId === deniedId ? decision : ('allowed' as const),
                  key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
                })),
              );
            Object.assign(contextAccess, { resources: checkResources });
            const failure = yield* Effect.flip(read.run(harness.runtime, inputs.saved));
            expect(
              Predicate.isTagged(failure, decision === 'denied' ? 'ReadPermissionDenied' : 'ReadPermissionUnavailable'),
            ).toBe(true);
          }),
        );
      }
    }
    for (const decision of ['denied', 'unavailable'] as const) {
      suite.effect(`${read.name} fails closed when the business requirement is ${decision}`, () =>
        Effect.gen(function* businessConjunction() {
          const harness = yield* makeReadTestHarness({
            businessPermissionDecision: () => decision,
            compositionRevision,
            executeOwnerQuery: () => Effect.die('Denied business plan must not read owner SQL'),
            operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T10:00:00.000Z')),
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          });
          const failure = yield* Effect.flip(read.run(harness.runtime, inputs.saved));
          expect(
            Predicate.isTagged(failure, decision === 'denied' ? 'ReadPermissionDenied' : 'ReadPermissionUnavailable'),
          ).toBe(true);
        }),
      );
    }
  }
});
