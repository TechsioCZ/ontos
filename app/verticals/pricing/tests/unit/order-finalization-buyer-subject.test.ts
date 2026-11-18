import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { PricingCommitmentConfirmationBindingSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { ConfigProvider, Crypto, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  PricingFinalizationAuthorityUnavailable,
  finalizationBuyerMatchesSubject,
  finalizationCallerMatches,
  pricingFinalizationOwnerGateways,
} from '../../src/integrations/order-finalization-owner-gateways.ts';
import { makeFinalCartCandidateWire } from './support/final-cart-candidate.fixture.ts';
import { makeIssue788Binding, makeIssue788CommercialTotal } from './support/issue-788-confirmation.fixture.ts';
import { makeOwnerTransport, ownerBearer, ownerTransportConfiguration } from './support/owner-transport.fixture.ts';

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
    { assertion: Redacted.make('verified-order-source-assertion'), audience: 'commerce-pricing' },
    actorAppId === undefined
      ? undefined
      : { appId: actorAppId, buildMarker: 'finalization-buyer-subject-build', principalId: buyer },
  );

const candidateRoute = (buyerPrincipalId: string) => ({
  path: '/reads/final-cart-candidate',
  respond: () =>
    Response.json(
      makeFinalCartCandidateWire({ buyerPrincipalId, candidateHash, candidateId, legalEntityId, tenantId }),
    ),
});

// The actual gateway guard, delegated Shell client and owner HTTP clients run; only their peers are fakes.
const overTransport = <A, E>(
  program: Effect.Effect<A, E, Crypto.Crypto>,
  transport: ReturnType<typeof makeOwnerTransport>,
) =>
  program.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ownerTransportConfiguration),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => Promise.resolve(transport.answer(input, init))),
  );

const readCandidate = (scope: ReturnType<typeof scopeFor>, transport: ReturnType<typeof makeOwnerTransport>) =>
  overTransport(
    Effect.gen(function* readOwnerCandidate() {
      const crypto = yield* Crypto.Crypto;
      const owners = yield* pricingFinalizationOwnerGateways(scope, revision, crypto);
      return yield* owners.readCandidate(candidateRef, candidateHash);
    }),
    transport,
  );

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
      const transport = makeOwnerTransport(revision, [candidateRoute(buyer)]);
      const candidate = yield* readCandidate(scopeFor('commerce-order'), transport);
      expect(candidate.buyerPrincipalId).toBe(buyer);
      expect(transport.requestsTo('/reads/final-cart-candidate')).toHaveLength(1);
      expect(transport.requestsTo('/reads/final-cart-candidate')[0]?.headers.get('authorization')).toBe(ownerBearer);
      // Pricing asked the Shell for a Cart credential acting for the verified Order request.
      expect(transport.delegations).toMatchObject([
        {
          audience: 'commerce-cart',
          compositionRevision: revision,
          legalEntityScope: 'subject',
          subject: { _tag: 'Assertion', sourceAssertion: 'verified-order-source-assertion' },
        },
      ]);
    }),
  );

  suite.effect('refuses a final candidate that names another buyer', () =>
    Effect.gen(function* refusesForeignBuyer() {
      const transport = makeOwnerTransport(revision, [candidateRoute(otherBuyer)]);
      const failure = yield* Effect.flip(readCandidate(scopeFor('commerce-order'), transport));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      // The owner answer decoded; the gateway refused it because it names another buyer.
      expect(failure).toHaveProperty('cause', 'Cart returned a different immutable final candidate for this buyer');
      expect(transport.requestsTo('/reads/final-cart-candidate')).toHaveLength(1);
    }),
  );

  suite.effect('refuses a session caller without the Order module actor before any owner read', () =>
    Effect.gen(function* refusesSession() {
      const transport = makeOwnerTransport(revision, [candidateRoute(buyer)]);
      const failure = yield* Effect.flip(readCandidate(scopeFor(), transport));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      expect(failure).toHaveProperty('cause', 'The caller is not the Order module acting for its buyer');
      expect(transport.requests).toHaveLength(0);
    }),
  );

  suite.effect('refuses a Customer Context actor even for its own buyer', () =>
    Effect.gen(function* refusesCustomerContext() {
      const transport = makeOwnerTransport(revision, [candidateRoute(buyer)]);
      const failure = yield* Effect.flip(readCandidate(scopeFor('commerce-customer-context'), transport));
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      expect(failure).toHaveProperty('cause', 'The caller is not the Order module acting for its buyer');
      expect(transport.requests).toHaveLength(0);
    }),
  );

  suite.effect('refuses a retained commitment binding whose prepared Order names another buyer', () =>
    Effect.gen(function* refusesForeignBindingBuyer() {
      const binding = makeIssue788Binding(yield* makeIssue788CommercialTotal());
      const prepared = {
        binding: yield* Schema.encodeEffect(PricingCommitmentConfirmationBindingSchema)(binding),
        buyerPrincipalId: otherBuyer,
        cartCandidateHash: candidateHash,
        cartCandidateRef: candidateRef,
        legalEntityId,
        observedAt: '2026-10-24T11:00:00.000Z',
        provenance: 'commerce.order.prepared-pricing-binding.v1',
        tenantId,
        validUntil: '2099-01-01T00:00:00.000Z',
      };
      const transport = makeOwnerTransport(revision, [
        candidateRoute(otherBuyer),
        {
          path: '/reads/prepared-order-pricing-binding',
          respond: () => Response.json(prepared),
        },
      ]);
      const failure = yield* overTransport(
        Effect.gen(function* verifyForeignBinding() {
          const crypto = yield* Crypto.Crypto;
          const owners = yield* pricingFinalizationOwnerGateways(scopeFor('commerce-order'), revision, crypto);
          return yield* Effect.flip(owners.verifyBinding(binding));
        }),
        transport,
      );
      expect(failure).toBeInstanceOf(PricingFinalizationAuthorityUnavailable);
      expect(failure).toHaveProperty('cause', 'The retained permanent Attempt and Bundle no longer match');
      expect(transport.requestsTo('/reads/prepared-order-pricing-binding')).toHaveLength(1);
      expect(transport.requestsTo('/reads/final-cart-candidate')).toHaveLength(0);
      expect(transport.delegations.map(({ audience }) => audience)).toEqual(['commerce-order']);
    }),
  );
});
