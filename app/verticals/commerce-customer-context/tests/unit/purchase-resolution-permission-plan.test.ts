import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { invoiceRecipientResolutionRead } from '../../src/api/invoice-recipient-resolution.read.ts';
import { deliveryDestinationResolutionRead } from '../../src/api/delivery-destination-resolution.read.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

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
const retailFacts = { retailPermission: 'retail.address_book.use', retailProfileId: profileId } as const;
const counterpartyFacts = { counterpartyId } as const;
/** Each positive case names the exact owner-fact bag its subject must publish (O67-Q1, O70). */
const inputs = {
  counterparty: {
    facts: counterpartyFacts,
    input: { purchasingContext, subject: { kind: 'PROFILE', profile: counterpartyProfile } },
  },
  counterpartySaved: {
    facts: counterpartyFacts,
    input: {
      explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef },
      purchasingContext,
      subject: { kind: 'PROFILE', profile: counterpartyProfile },
    },
  },
  guest: {
    facts: {},
    input: {
      purchasingContext,
      subject: { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' },
    },
  },
  oneTime: {
    facts: retailFacts,
    input: {
      explicitChoice: {
        choiceEvidenceRef: 'one-time-proof',
        kind: 'ONE_TIME',
        postalAddress: { addressLine1: '1 Unit Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
      },
      purchasingContext,
      subject: { kind: 'PROFILE', profile },
    },
  },
  profile: { facts: retailFacts, input: { purchasingContext, subject: { kind: 'PROFILE', profile } } },
  saved: {
    facts: retailFacts,
    input: {
      explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef },
      purchasingContext,
      subject: { kind: 'PROFILE', profile },
    },
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

const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T10:00:00.000Z'));

it.layer(NodeCrypto.layer)('purchase resolution conditional authority', (suite) => {
  for (const read of reads) {
    const positiveInputs =
      read.name === 'Delivery'
        ? {
            ...inputs,
            pickup: {
              facts: retailFacts,
              input: {
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
              },
            },
          }
        : inputs;
    for (const [name, { facts, input }] of Object.entries(positiveInputs)) {
      suite.effect(`${read.name} ${name} reaches its original handler after the one gate and its owner rule`, () =>
        Effect.gen(function* reachesOwnerBoundary() {
          const ownerFactsSeen: (Readonly<Record<string, string>> | undefined)[] = [];
          const harness = yield* makeReadTestHarness({
            access: 'allowed',
            compositionRevision,
            executeOwnerQuery: () => Effect.die('Unexpected owner SQL before missing Current evidence'),
            onOwnerAuthorization: (ownerInput) => {
              ownerFactsSeen.push(ownerInput.ownerFacts);
              return 'allowed' as const;
            },
            operationTime,
            ownerRegistration: commerceCustomerContextRegistration,
            scope,
          });
          const failure = yield* Effect.flip(read.run(harness.runtime, input));
          expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
          // One owner rule per request, named by exactly the record the subject is about.
          expect(ownerFactsSeen).toEqual([facts]);
          expect(harness.snapshot().evidenceWrites).toBe(0);
        }),
      );
    }
    for (const decision of ['denied', 'unavailable'] as const) {
      suite.effect(`${read.name} fails closed when the gate answers ${decision}`, () =>
        Effect.gen(function* gateConjunction() {
          const harness = yield* makeReadTestHarness({
            access: decision,
            compositionRevision,
            executeOwnerQuery: () => Effect.die('Denied authority must not read owner SQL'),
            operationTime,
            ownerRegistration: commerceCustomerContextRegistration,
            scope,
          });
          const failure = yield* Effect.flip(read.run(harness.runtime, inputs.saved.input));
          expect(
            Predicate.isTagged(failure, decision === 'denied' ? 'ReadPermissionDenied' : 'ReadPermissionUnavailable'),
          ).toBe(true);
          expect(harness.snapshot().ownerQueries).toEqual([]);
          expect(harness.snapshot().stages).not.toContain('handler_executed');
        }),
      );
    }
    suite.effect(`${read.name} fails closed when the owner rule denies the named record`, () =>
      Effect.gen(function* ownerDenied() {
        const harness = yield* makeReadTestHarness({
          access: 'allowed',
          compositionRevision,
          executeOwnerQuery: () => Effect.die('Owner denial must not read owner SQL'),
          onOwnerAuthorization: () => 'denied' as const,
          operationTime,
          ownerRegistration: commerceCustomerContextRegistration,
          scope,
        });
        const failure = yield* Effect.flip(read.run(harness.runtime, inputs.saved.input));
        expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    );
  }
});
