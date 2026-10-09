import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExternalPriceSourceAuthorityGrantSchema,
  ExternalPriceInputBoundary,
  ExternalPriceInputBoundaryLive,
  ExternalPriceSourceAuthority,
  makeExternalPriceInputBoundary,
} from '../../src/services/external-price-input-boundary.service.ts';
import type {
  ExternalPriceSourceAuthorityAssessment,
  ExternalPriceSourceAuthorityGrant,
} from '../../src/services/external-price-input-boundary.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const operationAt = '2026-09-29T10:00:00.000Z';
const unitBasis = {
  quantity: '1',
  unitRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.product-unit' as const,
    tenantId,
  },
};
const identityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2B' as const,
    marketId: 'cz-market',
    sellingLegalEntityId: legalEntityId,
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis,
};
const assertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
  lineage: { kind: 'INITIAL' },
  mapping: { mappingContractRef: 'erp-price-exact-key', mappingContractVersion: '4' },
  originalAssertion: {
    monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis,
  },
  sourceAssertionId: '66666666-6666-4666-8666-666666666666',
  sourceAuthority: { sourceAuthorityRef: 'pricing-governed-erp-feed', sourceAuthorityVersion: '9' },
  sourceRecord: {
    sourceChangeCorrelation: 'erp-change-803',
    sourceRecordRef: 'erp-price-row-42',
    sourceRecordVersion: '11',
    sourceSystem: { ownerModuleId: 'external.erp', sourceSystemRef: 'erp-transport' },
  },
  timing: {
    importedAt: '2026-09-29T09:59:00.000Z',
    ownerBusinessEffectiveAt: '2026-09-29T09:00:00.000Z',
    sourceEffectiveAt: '2026-09-29T08:55:00.000Z',
  },
});
const grant = Schema.decodeSync(ExternalPriceSourceAuthorityGrantSchema)({
  authority: assertion.sourceAuthority,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
  exactIdentityKey: identityKey,
  family: 'PRICE',
  mapping: assertion.mapping,
  ownerModuleId: 'commerce.pricing',
  schemaVersion: '1',
  verificationRef: 'pricing-source-authority-proof-803',
  verifiedAt: operationAt,
});
const request = {
  actingPrincipalId: '77777777-7777-4777-8777-777777777777',
  effectiveFrom: assertion.timing.ownerBusinessEffectiveAt,
  identityKey,
  monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
  sourceAssertion: assertion,
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationAt)),
};

const boundaryFor = (assessment: ExternalPriceSourceAuthorityAssessment) =>
  makeExternalPriceInputBoundary({ assess: () => Effect.succeed(assessment) });

describe('Pricing Source Authority and external Price input boundary', () => {
  it.effect('accepts only a Pricing-owned grant for the exact authority, mapping, key, and effective instant', () =>
    Effect.gen(function* exactGrant() {
      const result = yield* boundaryFor({ grant, outcome: 'AUTHORITY_GRANTED' }).assess(request);

      expect(result.outcome).toBe('READY_FOR_CANONICAL_WRITE');
      if (result.outcome === 'READY_FOR_CANONICAL_WRITE') {
        expect(result.evidence.sourceAssertion.sourceRecord.sourceSystem).toEqual({
          ownerModuleId: 'external.erp',
          sourceSystemRef: 'erp-transport',
        });
        expect(result.evidence.sourceAssertion.sourceAuthority).toEqual(grant.authority);
        expect(result.evidence.sourceAssertion.mapping).toEqual(grant.mapping);
      }
    }),
  );

  it.effect('uses the live boundary layer backed by the configured Pricing authority port', () =>
    Effect.scoped(
      Effect.gen(function* liveAuthorityPort() {
        const context = yield* Layer.build(
          ExternalPriceInputBoundaryLive.pipe(
            Layer.provide(
              Layer.succeed(ExternalPriceSourceAuthority, {
                assess: () => Effect.succeed({ grant, outcome: 'AUTHORITY_GRANTED' }),
              }),
            ),
          ),
        );
        const boundary = Context.get(context, ExternalPriceInputBoundary);
        const result = yield* boundary.assess(request);

        expect(result.outcome).toBe('READY_FOR_CANONICAL_WRITE');
      }),
    ),
  );

  it.effect('rejects a grant for another exact key even when amount and transport source are identical', () =>
    Effect.gen(function* exactKeyCollision() {
      const wrongGrant: ExternalPriceSourceAuthorityGrant = {
        ...grant,
        exactIdentityKey: {
          ...grant.exactIdentityKey,
          commercialScope: { ...grant.exactIdentityKey.commercialScope, marketId: 'different-market' },
        },
      };
      const result = yield* boundaryFor({ grant: wrongGrant, outcome: 'AUTHORITY_GRANTED' }).assess(request);

      expect(result).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        reason: 'MAPPING_REJECTED',
        sourceAssertionId: assertion.sourceAssertionId,
      });
    }),
  );

  it.effect('keeps unresolved authority, registry outage, and gross-only evidence as distinct outcomes', () =>
    Effect.gen(function* closedOutcomes() {
      const unresolved = yield* boundaryFor({ outcome: 'AUTHORITY_UNRESOLVED', reason: 'AUTHORITY' }).assess(request);
      const unavailable = yield* boundaryFor({
        dependency: 'MAPPING_REGISTRY',
        outcome: 'AUTHORITY_UNAVAILABLE',
      }).assess(request);
      const grossAssertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
        ...assertion,
        originalAssertion: { ...assertion.originalAssertion, monetaryBoundary: 'TAX_INCLUSIVE' },
      });
      const grossResult = yield* boundaryFor({ grant, outcome: 'AUTHORITY_GRANTED' }).assess({
        ...request,
        sourceAssertion: grossAssertion,
      });

      expect(unresolved).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'SOURCE_AUTHORITY_UNRESOLVED',
      });
      expect(unavailable).toMatchObject({
        dependency: 'MAPPING_REGISTRY',
        outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
      expect(grossResult).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
      });
    }),
  );
});
