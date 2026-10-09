import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceSourceAssertionAssessmentSchema,
  PriceSourceEvidenceSchema,
  PriceSourceProvenanceSchema,
  priceSourceFactFingerprintBasisFrom,
} from '../../src/domain/price-source-provenance.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const sourceAssertionId = '11111111-1111-4111-8111-111111111111';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
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
    channelId: 'B2C' as const,
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: { quantity: '1', unitRef },
};
const sourceAssertion = {
  lineage: { kind: 'INITIAL' as const },
  mapping: { mappingContractRef: 'legacy-price-v2', mappingContractVersion: '2.4.0' },
  originalAssertion: {
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    unitBasis: { quantity: '1', unitRef },
  },
  sourceAssertionId,
  sourceAuthority: { sourceAuthorityRef: 'erp-price-owner', sourceAuthorityVersion: '7' },
  sourceRecord: {
    sourceChangeCorrelation: 'change-84',
    sourceRecordRef: 'price-row-42',
    sourceRecordVersion: '9',
    sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
  },
  timing: {
    importedAt: '2026-09-27T10:03:00.000Z',
    ownerBusinessEffectiveAt: '2026-09-27T10:01:00.000Z',
    sourceEffectiveAt: '2026-09-27T10:00:00.000Z',
  },
};
const evidence = {
  lineage: { kind: 'INITIAL' as const },
  recordedAt: '2026-09-27T10:02:00.000Z',
  sourceAssertion,
  sourceFactFingerprint: 'a'.repeat(64),
  tenantId,
};
const provenance = {
  canonicalLink: {
    effectiveFrom: '2026-09-27T10:01:00.000Z',
    identityKey,
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    priceRef: {
      moduleId: 'commerce.pricing' as const,
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.pricing.price' as const,
      tenantId,
    },
    revision: 1,
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  evidence,
  provenanceRef: '88888888-8888-4888-8888-888888888888',
};

const decodeEvidence = Schema.decodeUnknownSync(PriceSourceEvidenceSchema, { onExcessProperty: 'error' });
const decodeProvenance = Schema.decodeUnknownSync(PriceSourceProvenanceSchema, { onExcessProperty: 'error' });
const decodeAssessment = Schema.decodeUnknownSync(PriceSourceAssertionAssessmentSchema, {
  onExcessProperty: 'error',
});

describe('Pricing source provenance contract', () => {
  it('preserves owner-qualified source identity, mapping, authority, original meaning, and separate times', () => {
    expect(decodeEvidence(evidence)).toEqual(evidence);
  });

  it('derives one stable owner-fact basis without assertion or delivery identity', () => {
    const replay = {
      ...sourceAssertion,
      sourceAssertionId: '77777777-7777-4777-8777-777777777777',
      timing: { ...sourceAssertion.timing, importedAt: '2026-09-27T12:00:00.000Z' },
    };
    expect(priceSourceFactFingerprintBasisFrom(replay)).toEqual(priceSourceFactFingerprintBasisFrom(sourceAssertion));
    expect(
      priceSourceFactFingerprintBasisFrom({
        ...sourceAssertion,
        sourceRecord: { ...sourceAssertion.sourceRecord, sourceRecordVersion: '10' },
      }),
    ).not.toEqual(priceSourceFactFingerprintBasisFrom(sourceAssertion));
  });

  it('binds accepted provenance to one exact Price identity and Revision', () => {
    expect(decodeAssessment({ outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED', provenance })).toEqual({
      outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED',
      provenance,
    });
    expect(() =>
      decodeProvenance({
        ...provenance,
        canonicalLink: {
          ...provenance.canonicalLink,
          priceRef: {
            ...provenance.canonicalLink.priceRef,
            tenantId: '77777777-7777-4777-8777-777777777777',
          },
        },
      }),
    ).toThrow();
  });

  it('binds numerically equal database decimals without rewriting original source evidence', () => {
    const databaseCanonical = {
      ...provenance,
      canonicalLink: {
        ...provenance.canonicalLink,
        identityKey: {
          ...identityKey,
          unitBasis: { ...identityKey.unitBasis, quantity: '1.000000000' },
        },
        monetaryAmount: { amount: '100.000000000', currencyCode: 'CZK' },
      },
    };
    const decoded = decodeProvenance(databaseCanonical);

    expect(decoded.evidence.sourceAssertion.originalAssertion.monetaryAmount.amount).toBe('100');
    expect(decoded.evidence.sourceAssertion.originalAssertion.unitBasis.quantity).toBe('1');
    expect(() =>
      decodeProvenance({
        ...databaseCanonical,
        canonicalLink: {
          ...databaseCanonical.canonicalLink,
          monetaryAmount: { amount: '100.000000001', currencyCode: 'CZK' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProvenance({
        ...databaseCanonical,
        canonicalLink: {
          ...databaseCanonical.canonicalLink,
          identityKey: {
            ...databaseCanonical.canonicalLink.identityKey,
            unitBasis: { ...databaseCanonical.canonicalLink.identityKey.unitBasis, quantity: '1.000000001' },
          },
        },
      }),
    ).toThrow();
  });

  it('requires authoritative pre-Tax normalization for a tax-inclusive assertion', () => {
    const taxInclusive = {
      ...provenance,
      evidence: {
        ...evidence,
        sourceAssertion: {
          ...sourceAssertion,
          originalAssertion: {
            ...sourceAssertion.originalAssertion,
            monetaryBoundary: 'TAX_INCLUSIVE' as const,
          },
        },
      },
    };

    expect(() => decodeProvenance(taxInclusive)).toThrow();
    expect(
      decodeProvenance({
        ...taxInclusive,
        canonicalLink: {
          ...taxInclusive.canonicalLink,
          monetaryAmount: { amount: '82.64', currencyCode: 'CZK' },
        },
        evidence: {
          ...taxInclusive.evidence,
          sourceAssertion: {
            ...taxInclusive.evidence.sourceAssertion,
            preTaxNormalization: {
              authority: sourceAssertion.sourceAuthority,
              normalizedMonetaryAmount: { amount: '82.64', currencyCode: 'CZK' },
            },
          },
        },
      }),
    ).toBeDefined();
    expect(() =>
      decodeProvenance({
        ...taxInclusive,
        canonicalLink: {
          ...taxInclusive.canonicalLink,
          monetaryAmount: { amount: '82.64', currencyCode: 'EUR' },
        },
        evidence: {
          ...taxInclusive.evidence,
          sourceAssertion: {
            ...taxInclusive.evidence.sourceAssertion,
            preTaxNormalization: {
              authority: sourceAssertion.sourceAuthority,
              normalizedMonetaryAmount: { amount: '82.64', currencyCode: 'EUR' },
            },
          },
        },
      }),
    ).toThrow();
  });

  it('rejects implicit FX, Unit remapping, and self-referential correction lineage', () => {
    expect(() =>
      decodeProvenance({
        ...provenance,
        evidence: {
          ...evidence,
          sourceAssertion: {
            ...sourceAssertion,
            originalAssertion: {
              ...sourceAssertion.originalAssertion,
              monetaryAmount: { amount: '100', currencyCode: 'EUR' },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProvenance({
        ...provenance,
        evidence: {
          ...evidence,
          sourceAssertion: {
            ...sourceAssertion,
            originalAssertion: {
              ...sourceAssertion.originalAssertion,
              unitBasis: { ...sourceAssertion.originalAssertion.unitBasis, quantity: '2' },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeEvidence({
        ...evidence,
        lineage: {
          actingPrincipalId: '99999999-9999-4999-8999-999999999999',
          correctedSourceAssertionId: sourceAssertionId,
          kind: 'CORRECTION',
          reason: 'Correct source decimal placement',
        },
        sourceAssertion: {
          ...sourceAssertion,
          lineage: {
            correctedSourceAssertionId: sourceAssertionId,
            kind: 'CORRECTION',
            reason: 'Correct source decimal placement',
          },
        },
      }),
    ).toThrow();
  });

  it('keeps known-invalid, held, and unavailable assertions distinct and non-canonical', () => {
    expect(
      decodeAssessment({
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        reason: 'PRODUCT_ONLY_TARGET',
        sourceAssertionId,
      }).outcome,
    ).toBe('PRICE_SOURCE_ASSERTION_KNOWN_INVALID');
    expect(
      decodeAssessment({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
        sourceAssertionId,
      }).outcome,
    ).toBe('PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD');
    expect(
      decodeAssessment({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'CURRENCY_NOT_SUPPORTED_FOR_TENANT',
        sourceAssertionId,
      }).outcome,
    ).toBe('PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD');
    expect(
      decodeAssessment({
        dependency: 'SOURCE_AUTHORITY',
        outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
        retryable: true,
        sourceAssertionId,
      }).outcome,
    ).toBe('PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE');
  });

  it('rejects Product-only, Market-less, web-specific, and ambiguous assertions as typed outcomes', () => {
    for (const reason of [
      'PRODUCT_ONLY_TARGET',
      'MARKET_MISSING',
      'STOREFRONT_AS_PRICE_SELECTOR',
      'VARIANT_AMBIGUOUS',
      'UNIT_AMBIGUOUS',
    ] as const) {
      expect(
        decodeAssessment({ outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID', reason, sourceAssertionId }),
      ).toBeDefined();
    }
    expect(() =>
      decodeAssessment({
        outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED',
        provenance,
        storefrontId: 'web-cz',
      }),
    ).toThrow();
  });
});
