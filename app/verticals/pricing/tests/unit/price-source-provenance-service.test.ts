import {
  PriceSourceAssertionInputSchema,
  PriceSourceProvenanceSchema,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  acceptedPriceSourceProvenanceMatches,
  preparePriceSourceEvidence,
  priceSourceFactFingerprint,
} from '../../src/services/price-source-provenance.service.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const actingPrincipalId = '99999999-9999-4999-8999-999999999999';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const identityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2C' as const,
    marketId: 'cz-launch',
    sellingLegalEntityId: '33333333-3333-4333-8333-333333333333',
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: { quantity: '1', unitRef },
};
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const effectiveFrom = '2026-09-27T10:00:00.000Z';
const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
  lineage: { kind: 'INITIAL' },
  mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
  originalAssertion: {
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis: { quantity: '1', unitRef },
  },
  sourceAssertionId: '11111111-1111-4111-8111-111111111111',
  sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
  sourceRecord: {
    sourceChangeCorrelation: 'change-84',
    sourceRecordRef: 'price-row-42',
    sourceRecordVersion: '9',
    sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
  },
  timing: {
    importedAt: '2026-09-27T10:02:00.000Z',
    ownerBusinessEffectiveAt: effectiveFrom,
    sourceEffectiveAt: '2026-09-27T09:55:00.000Z',
  },
});
const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T10:03:00.000Z'));
const monetaryAmount = { amount: '100' as const, currencyCode: 'CZK' as const };

const prepare = (assertion = sourceAssertion) =>
  preparePriceSourceEvidence({
    actingPrincipalId,
    effectiveFrom,
    identityKey,
    monetaryAmount,
    sourceAssertion: assertion,
    tenantId,
    trustedOperationAt,
  });

describe('Price source provenance service', () => {
  it('builds owner evidence with trusted recording context and a delivery-invariant fact fingerprint', () => {
    const prepared = prepare();
    const laterDelivery = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...sourceAssertion,
      timing: { ...sourceAssertion.timing, importedAt: '2026-09-28T10:02:00.000Z' },
    });

    expect(prepared.outcome).toBe('READY_FOR_CANONICAL_WRITE');
    if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
      throw new Error('Expected ready source evidence');
    }
    expect(prepared.evidence.recordedAt).toBe('2026-09-27T10:03:00.000Z');
    expect(prepared.evidence.tenantId).toBe(tenantId);
    expect(priceSourceFactFingerprint(laterDelivery)).toBe(prepared.evidence.sourceFactFingerprint);
  });

  it('injects the trusted actor into correction lineage', () => {
    const correction = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...sourceAssertion,
      lineage: {
        correctedSourceAssertionId: sourceAssertion.sourceAssertionId,
        kind: 'CORRECTION',
        reason: 'Correct the source decimal',
      },
      sourceAssertionId: '11111111-1111-4111-8111-111111111112',
    });
    const prepared = prepare(correction);

    expect(prepared.outcome).toBe('READY_FOR_CANONICAL_WRITE');
    if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
      throw new Error('Expected ready correction evidence');
    }
    expect(prepared.evidence.lineage).toEqual({ ...correction.lineage, actingPrincipalId });
  });

  it('holds gross assertions without authoritative normalization and rejects implicit currency or Unit mapping', () => {
    const gross = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...sourceAssertion,
      originalAssertion: { ...sourceAssertion.originalAssertion, monetaryBoundary: 'TAX_INCLUSIVE' },
    });
    const currencyMismatch = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...sourceAssertion,
      originalAssertion: {
        ...sourceAssertion.originalAssertion,
        monetaryAmount: { amount: '100', currencyCode: 'EUR' },
      },
    });
    const unitMismatch = Schema.decodeSync(PriceSourceAssertionInputSchema)({
      ...sourceAssertion,
      originalAssertion: {
        ...sourceAssertion.originalAssertion,
        unitBasis: { ...sourceAssertion.originalAssertion.unitBasis, quantity: '2' },
      },
    });

    expect(prepare(gross)).toMatchObject({
      outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
      reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
    });
    expect(prepare(currencyMismatch)).toMatchObject({
      outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
      reason: 'CURRENCY_MISMATCH',
    });
    expect(prepare(unitMismatch)).toMatchObject({
      outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
      reason: 'UNIT_AMBIGUOUS',
    });
  });

  it('verifies the exact canonical link while allowing a later delivery of the same fact', () => {
    const prepared = prepare();
    if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
      throw new Error('Expected ready source evidence');
    }
    const storedIdentityKey = {
      ...identityKey,
      unitBasis: { ...identityKey.unitBasis, quantity: '1.000000000' },
    };
    const storedMonetaryAmount = { ...monetaryAmount, amount: '100.000000000' };
    const definition = {
      identityKey: storedIdentityKey,
      priceRef,
      revision: {
        effectiveFrom,
        monetaryAmount: storedMonetaryAmount,
        monetaryBoundary: 'PRE_TAX' as const,
        revision: 1,
        revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    };
    const provenance = Schema.decodeSync(PriceSourceProvenanceSchema)({
      canonicalLink: {
        effectiveFrom,
        identityKey: storedIdentityKey,
        monetaryAmount: storedMonetaryAmount,
        monetaryBoundary: 'PRE_TAX',
        priceRef,
        revision: 1,
        revisionId: definition.revision.revisionId,
      },
      evidence: {
        ...prepared.evidence,
        recordedAt: '2026-09-28T10:03:00.000Z',
        sourceAssertion: {
          ...prepared.evidence.sourceAssertion,
          timing: { ...prepared.evidence.sourceAssertion.timing, importedAt: '2026-09-28T10:02:00.000Z' },
        },
      },
      provenanceRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    expect(acceptedPriceSourceProvenanceMatches({ definition, expectedEvidence: prepared.evidence, provenance })).toBe(
      true,
    );
    expect(
      acceptedPriceSourceProvenanceMatches({
        definition,
        expectedEvidence: prepared.evidence,
        provenance: {
          ...provenance,
          canonicalLink: { ...provenance.canonicalLink, revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        },
      }),
    ).toBe(false);
  });
});
