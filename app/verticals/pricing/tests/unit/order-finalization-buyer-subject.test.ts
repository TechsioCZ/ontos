import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Crypto, DateTime, Effect, Redacted, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import {
  PricingFinalizationAuthorityUnavailable,
  finalizationBuyerMatchesSubject,
  finalizationCallerMatches,
  pricingFinalizationOwnerGateways,
} from '../../src/integrations/order-finalization-owner-gateways.ts';
import { makeIssue788Binding, makeIssue788CommercialTotal } from './support/issue-788-confirmation.fixture.ts';

// Owner executors are replaced at the wire boundary; the gateway guard, buyer checks and candidate
// reads run as shipped.
const stubs = rs.hoisted(() => ({
  binding: (): Effect.Effect<unknown> => Effect.die('binding executor is not stubbed'),
  bindingCalls: 0,
  candidate: (): Effect.Effect<unknown> => Effect.die('candidate executor is not stubbed'),
  candidateCalls: 0,
}));

rs.mock('../../src/integrations/owner-gateway-connection.ts', () => ({
  ...rs.requireActual('../../src/integrations/owner-gateway-connection.ts'),
  acquireOwnerGatewayConnection: () =>
    Effect.succeed({ baseUrl: new URL('https://owner.example.test'), credential: Redacted.make('Bearer owner') }),
}));
rs.mock('@app/commerce-cart-finalization-contracts/final-candidate/client', () => ({
  ...rs.requireActual('@app/commerce-cart-finalization-contracts/final-candidate/client'),
  executeFinalCartCandidateWithAuthorization: () => stubs.candidate(),
}));
rs.mock('@app/commerce-order-contracts/prepared-order-pricing-binding/client', () => ({
  ...rs.requireActual('@app/commerce-order-contracts/prepared-order-pricing-binding/client'),
  executePreparedOrderPricingBindingWithAuthorization: () => stubs.binding(),
}));

const buyer = '11111111-1111-4111-8111-111111111111';
const otherBuyer = '22222222-2222-4222-8222-222222222222';
const tenantId = '33333333-3333-4333-8333-333333333333';
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const candidateId = '55555555-5555-4555-8555-555555555555';
const candidateHash = 'a'.repeat(64);
const revision = 'b'.repeat(64);
const candidateRef = {
  moduleId: 'commerce.cart',
  resourceId: candidateId,
  resourceType: 'commerce.cart.final-cart-candidate',
  tenantId,
} as const;

const scopeFor = (actorAppId?: string) =>
  trustVerifiedGatewayPrincipalContext(
    {
      ...Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '66666666-6666-4666-8666-666666666666',
        authContextRef: 'better-auth-session:finalization-buyer-subject',
        authMethod: 'session',
        legalEntityId,
        principalId: buyer,
        tenantId,
      }),
      correlationId: 'finalization-buyer-subject',
    },
    revision,
    undefined,
    actorAppId === undefined
      ? undefined
      : { appId: actorAppId, buildMarker: 'finalization-buyer-subject-build', principalId: buyer },
  );

const candidateFor = (buyerPrincipalId: string) => ({
  buyerPrincipalId,
  candidateHash,
  candidateRef: { ...candidateRef },
  legalEntityId,
  tenantId,
});

const stubCandidate = (buyerPrincipalId: string) => {
  stubs.candidate = () =>
    Effect.sync(() => {
      stubs.candidateCalls += 1;
    }).pipe(Effect.as(candidateFor(buyerPrincipalId)));
};

const readCandidate = (scope: ReturnType<typeof scopeFor>) =>
  Effect.gen(function* readOwnerCandidate() {
    const crypto = yield* Crypto.Crypto;
    const owners = yield* pricingFinalizationOwnerGateways(scope, revision, crypto);
    return yield* owners.readCandidate(candidateRef, candidateHash);
  });

it('admits finalization evidence only for the buyer the verified subject acts for', () => {
  expect(finalizationBuyerMatchesSubject(buyer, buyer)).toBe(true);
  expect(finalizationBuyerMatchesSubject(otherBuyer, buyer)).toBe(false);
});

it('admits finalization owner evidence only through the Order module actor', () => {
  expect(finalizationCallerMatches({ appId: 'commerce-order' })).toBe(true);
  expect(finalizationCallerMatches({ appId: 'commerce-customer-context' })).toBe(false);
  expect(finalizationCallerMatches({ appId: 'commerce-order-other' })).toBe(false);
  expect(finalizationCallerMatches()).toBe(false);
});

it.layer(NodeCrypto.layer)('Order finalization owner gateways act for the buyer through the Order module', (suite) => {
  suite.effect('admits an Order actor reading its own buyer final candidate', () =>
    Effect.gen(function* admitsOrderBuyer() {
      stubs.candidateCalls = 0;
      stubCandidate(buyer);
      const candidate = yield* readCandidate(scopeFor('commerce-order'));
      expect(candidate.buyerPrincipalId).toBe(buyer);
      expect(stubs.candidateCalls).toBe(1);
    }),
  );

  suite.effect('refuses a final candidate that names another buyer', () =>
    Effect.gen(function* refusesForeignBuyer() {
      stubCandidate(otherBuyer);
      const failure = yield* Effect.flip(readCandidate(scopeFor('commerce-order')));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
    }),
  );

  suite.effect('refuses a session caller without the Order module actor before any owner read', () =>
    Effect.gen(function* refusesSession() {
      stubs.candidateCalls = 0;
      stubCandidate(buyer);
      const failure = yield* Effect.flip(readCandidate(scopeFor()));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      expect(stubs.candidateCalls).toBe(0);
    }),
  );

  suite.effect('refuses a Customer Context actor even for its own buyer', () =>
    Effect.gen(function* refusesCustomerContext() {
      stubs.candidateCalls = 0;
      stubCandidate(buyer);
      const failure = yield* Effect.flip(readCandidate(scopeFor('commerce-customer-context')));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      expect(stubs.candidateCalls).toBe(0);
    }),
  );

  suite.effect('refuses a retained commitment binding whose prepared Order names another buyer', () =>
    Effect.gen(function* refusesForeignBindingBuyer() {
      const binding = makeIssue788Binding(yield* makeIssue788CommercialTotal());
      stubs.bindingCalls = 0;
      stubs.binding = () =>
        Effect.sync(() => {
          stubs.bindingCalls += 1;
        }).pipe(
          Effect.as({
            binding,
            buyerPrincipalId: otherBuyer,
            cartCandidateHash: candidateHash,
            cartCandidateRef: candidateRef,
            legalEntityId,
            observedAt: DateTime.makeUnsafe('2026-10-24T11:00:00.000Z'),
            tenantId,
            validUntil: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'),
          }),
        );
      const crypto = yield* Crypto.Crypto;
      const owners = yield* pricingFinalizationOwnerGateways(scopeFor('commerce-order'), revision, crypto);
      const failure = yield* Effect.flip(owners.verifyBinding(binding));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      expect(stubs.bindingCalls).toBe(1);
    }),
  );
});
