import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { pricingCurrentMarketEvidenceRead } from '../../src/api/pricing-current-market-evidence.read.ts';
import { commerceMarketCatalogRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const marketId = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const compositionRevision = 'a'.repeat(64);
const at = '2026-09-28T12:00:00.000Z';
const observedAt = '2026-09-28T12:00:00.300Z';
const boundary = '2026-10-01T00:00:00.000Z';
const principal = trustVerifiedGatewayPrincipalContext(
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '55555555-5555-4555-8555-555555555555',
    authContextRef: 'session:market-wire-persistence',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  compositionRevision,
);
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
};
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};
const wireSnapshot = {
  definitionRevisionRef: definitionId,
  effectivePeriod: { endsAt: boundary, startsAt: '2026-01-01T00:00:00.000Z' },
  generation: 9,
  lifecycleRevisionRef: '77777777-7777-4777-8777-777777777777',
  market: {
    channels: ['B2C'],
    definitionRevisionRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: definitionId,
      resourceType: 'commerce.market-catalog.market-definition-revision',
      tenantId,
    },
    effectivePeriod: { endsAt: boundary, startsAt: '2026-01-01T00:00:00.000Z' },
    jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
    lifecycle: 'ACTIVE',
    marketCode: 'CZ_MAIN',
    marketRef,
    purpose: 'Czech commerce',
    revision: 1,
    sellingLegalEntityRef: sellerRef,
    supportedLocales: ['cs-CZ'],
  },
  nextApplicabilityBoundary: boundary,
  observedAt,
  state: 'PRESENT',
};
type MarketSnapshotWireFixture = typeof wireSnapshot;

const readWire = Effect.fn('MarketWireTest.read')(function* readWire(payload: MarketSnapshotWireFixture) {
  const harness = yield* makeReadTestHarness({
    compositionRevision,
    executeOwnerQuery: ({ sql }) => {
      expect(sql).toContain('read_pricing_current_market_evidence');
      return Effect.succeed([{ payload }]);
    },
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: commerceMarketCatalogRegistration,
    permissionDecision: 'allowed',
    scope: { ...principal, correlationId: 'market-wire' },
  });
  const result = yield* harness.runtime.runRead({
    input: {
      commercialScope: { channel: 'B2C', marketRef, sellingLegalEntityRef: sellerRef },
      effectiveAt: at,
      requestedAt: at,
    },
    principal,
    registration: pricingCurrentMarketEvidenceRead,
    transport: { correlationId: 'market-wire' },
  });
  expect(harness.snapshot().ownerQueries).toHaveLength(1);
  return result;
});

it.effect('decodes PostgreSQL JSON timestamps through the original owner factory and public Read lifecycle', () =>
  Effect.scoped(
    Effect.gen(function* validWireSnapshot() {
      const result = yield* readWire(wireSnapshot);
      expect(result.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      if (result.outcome === 'PRICING_MARKET_SOURCE_PRESENT') {
        expect(DateTime.formatIso(result.receipt.authority.observedAt)).toBe(observedAt);
        expect(DateTime.formatIso(result.market.effectivePeriod.startsAt)).toBe(
          wireSnapshot.market.effectivePeriod.startsAt,
        );
        expect(result.market.effectivePeriod.endsAt).toBeDefined();
      }
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

for (const [name, payload] of Object.entries({
  effectiveStart: { ...wireSnapshot, effectivePeriod: { ...wireSnapshot.effectivePeriod, startsAt: 'invalid-date' } },
  nestedEnd: {
    ...wireSnapshot,
    market: {
      ...wireSnapshot.market,
      effectivePeriod: { ...wireSnapshot.market.effectivePeriod, endsAt: 'invalid-date' },
    },
  },
  nestedStart: {
    ...wireSnapshot,
    market: { ...wireSnapshot.market, effectivePeriod: { ...wireSnapshot.effectivePeriod, startsAt: 'invalid-date' } },
  },
  observedAt: { ...wireSnapshot, observedAt: 'invalid-date' },
  reversedPeriod: {
    ...wireSnapshot,
    market: { ...wireSnapshot.market, effectivePeriod: { endsAt: at, startsAt: boundary } },
  },
})) {
  it.effect(`keeps malformed ${name} wire snapshots unavailable`, () =>
    Effect.scoped(
      Effect.gen(function* invalidWireSnapshot() {
        const result = yield* readWire(payload);
        expect(result.outcome).toBe('PRICING_MARKET_SOURCE_UNAVAILABLE');
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );
}
