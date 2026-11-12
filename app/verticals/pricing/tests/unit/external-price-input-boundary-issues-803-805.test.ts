import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import { DefinePricePayloadSchema } from '../../shared/actions/define-price.ts';
import { priceSourceFactFingerprint } from '../../src/services/price-source-provenance.service.ts';
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
  it.effect('C14 internal source conformance keeps every full Price key dimension exact', () =>
    Effect.gen(function* c14FullKeyConformance() {
      const changedKeys = [
        { ...identityKey, currencyCode: 'EUR' },
        { ...identityKey, commercialScope: { ...identityKey.commercialScope, channelId: 'B2C' as const } },
        { ...identityKey, commercialScope: { ...identityKey.commercialScope, marketId: 'other-market' } },
        {
          ...identityKey,
          commercialScope: {
            ...identityKey.commercialScope,
            sellingLegalEntityId: '22222222-2222-4222-8222-222222222223',
          },
        },
        { ...identityKey, unitBasis: { ...unitBasis, quantity: '2' } },
        {
          ...identityKey,
          catalogSelection: {
            ...identityKey.catalogSelection,
            variantRef: {
              ...identityKey.catalogSelection.variantRef,
              resourceId: '55555555-5555-4555-8555-555555555556',
            },
          },
        },
        {
          ...identityKey,
          priceGroupSelector: {
            kind: 'PRICE_GROUP' as const,
            priceGroupRef: {
              moduleId: 'pricing.price-group-catalog' as const,
              resourceId: '88888888-8888-4888-8888-888888888888',
              resourceType: 'pricing.price-group-catalog.price-group' as const,
              tenantId,
            },
          },
        },
      ];
      for (const changedKey of changedKeys) {
        const exactKey = yield* Schema.decodeUnknownEffect(PriceIdentityKeySchema)(changedKey);
        const outcome = yield* boundaryFor({ grant, outcome: 'AUTHORITY_GRANTED' }).assess({
          ...request,
          identityKey: exactKey,
        });
        expect(outcome).toMatchObject({ outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID', reason: 'MAPPING_REJECTED' });
      }
    }),
  );

  it('C14 source provenance isolates issuer, record revision and mapping while preserving delivery replay', () => {
    const original = priceSourceFactFingerprint(assertion);
    const otherIssuer = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...assertion,
      sourceRecord: {
        ...assertion.sourceRecord,
        sourceSystem: { ...assertion.sourceRecord.sourceSystem, sourceSystemRef: 'internal-other-issuer' },
      },
    });
    const otherRevision = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...assertion,
      sourceRecord: { ...assertion.sourceRecord, sourceRecordVersion: '12' },
    });
    const laterDelivery = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...assertion,
      timing: { ...assertion.timing, importedAt: '2026-09-30T09:59:00.000Z' },
    });
    expect(priceSourceFactFingerprint(otherIssuer)).not.toBe(original);
    expect(priceSourceFactFingerprint(otherRevision)).not.toBe(original);
    expect(priceSourceFactFingerprint(laterDelivery)).toBe(original);
  });

  it('C14 rejects missing Unit and amount basis before any native owner effect', () => {
    const { unitBasis: omittedUnit, ...incompleteKey } = identityKey;
    expect(omittedUnit).toEqual(unitBasis);
    expect(Schema.is(PriceIdentityKeySchema)(incompleteKey)).toBe(false);
    const { monetaryBoundary: omittedBoundary, ...incompleteOriginal } = assertion.originalAssertion;
    expect(omittedBoundary).toBe('PRE_TAX');
    expect(Schema.is(PriceSourceAssertionInputSchema)({ ...assertion, originalAssertion: incompleteOriginal })).toBe(
      false,
    );
    expect(
      Schema.is(DefinePricePayloadSchema)({
        effectiveFrom: request.effectiveFrom,
        identityKey,
        monetaryAmount: { amount: '125.50', currencyCode: 'EUR' },
        priceRef: {
          moduleId: 'commerce.pricing',
          resourceId: '99999999-9999-4999-8999-999999999999',
          resourceType: 'commerce.pricing.price',
          tenantId,
        },
        reason: 'Internal C14 currency mismatch control.',
        sourceAssertion: assertion,
      }),
    ).toBe(false);
  });
});
