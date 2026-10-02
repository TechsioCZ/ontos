import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceSourceAssertionAssessmentSchema,
  PriceSourceEvidenceSchema,
  PriceSourceProvenanceSchema,
} from '../../src/domain/price-source-provenance.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const initialAssertionId = '11111111-1111-4111-8111-111111111111';
const correctionAssertionId = '11111111-1111-4111-8111-111111111112';
const supersessionAssertionId = '11111111-1111-4111-8111-111111111113';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const canonicalIdentity = {
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
const canonicalLink = {
  effectiveFrom: '2026-09-27T10:01:00.000Z',
  identityKey: canonicalIdentity,
  monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
  monetaryBoundary: 'PRE_TAX' as const,
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  revision: 1,
  revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const sourceAuthority = {
  sourceAuthorityRef: 'pricing-owner-authority',
  sourceAuthorityVersion: 'authority-v3',
};
const sourceAssertion = {
  lineage: { kind: 'INITIAL' as const },
  mapping: {
    mappingContractRef: 'erp-price-to-canonical-price',
    mappingContractVersion: 'mapping-v5',
  },
  originalAssertion: {
    monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    unitBasis: { quantity: '1', unitRef },
  },
  sourceAssertionId: initialAssertionId,
  sourceAuthority,
  sourceRecord: {
    sourceChangeCorrelation: 'erp-change-40',
    sourceRecordRef: 'erp-price-row-19',
    sourceRecordVersion: 'row-version-7',
    sourceSystem: {
      ownerModuleId: 'commerce.pricing',
      sourceSystemRef: 'erp-pricing-eu',
    },
  },
  timing: {
    importedAt: '2026-09-27T10:03:00.000Z',
    ownerBusinessEffectiveAt: '2026-09-27T10:01:00.000Z',
    sourceEffectiveAt: '2026-09-27T10:00:00.000Z',
  },
};
const initialEvidence = {
  lineage: { kind: 'INITIAL' as const },
  recordedAt: '2026-09-27T10:02:00.000Z',
  sourceAssertion,
  sourceFactFingerprint: 'a'.repeat(64),
  tenantId,
};
const initialProvenance = {
  canonicalLink,
  evidence: initialEvidence,
  provenanceRef: '77777777-7777-4777-8777-777777777777',
};

const decodeEvidence = Schema.decodeUnknownSync(PriceSourceEvidenceSchema, { onExcessProperty: 'error' });
const decodeProvenance = Schema.decodeUnknownSync(PriceSourceProvenanceSchema, { onExcessProperty: 'error' });
const decodeAssessment = Schema.decodeUnknownSync(PriceSourceAssertionAssessmentSchema, {
  onExcessProperty: 'error',
});

describe('Issue #760 Price source provenance acceptance', () => {
  it('links every exact mapping dimension and immutable source meaning to one Price Revision', () => {
    const decoded = decodeProvenance(initialProvenance);

    expect(decoded.canonicalLink).toEqual(canonicalLink);
    expect(decoded.canonicalLink.identityKey).toEqual(canonicalIdentity);
    expect(decoded.evidence).toEqual(initialEvidence);
    expect(decoded.evidence.sourceAssertion.timing).toEqual({
      importedAt: '2026-09-27T10:03:00.000Z',
      ownerBusinessEffectiveAt: '2026-09-27T10:01:00.000Z',
      sourceEffectiveAt: '2026-09-27T10:00:00.000Z',
    });
    expect(decoded.evidence.recordedAt).toBe('2026-09-27T10:02:00.000Z');
  });

  it('keeps a retry of the same qualified source fact on the same fingerprint, identity, and Revision', () => {
    const first = decodeProvenance(initialProvenance);
    const retry = decodeProvenance({
      ...initialProvenance,
      evidence: {
        ...initialEvidence,
        recordedAt: '2026-09-27T10:11:00.000Z',
        sourceAssertion: {
          ...sourceAssertion,
          timing: { ...sourceAssertion.timing, importedAt: '2026-09-27T10:10:00.000Z' },
        },
      },
    });

    expect(retry.evidence.sourceAssertion.sourceAssertionId).toBe(first.evidence.sourceAssertion.sourceAssertionId);
    expect(retry.evidence.sourceFactFingerprint).toBe(first.evidence.sourceFactFingerprint);
    expect(retry.canonicalLink).toEqual(first.canonicalLink);
    expect(retry.provenanceRef).toBe(first.provenanceRef);
  });

  it('retains correction and supersession evidence instead of rewriting predecessor lineage', () => {
    const correctionAssertion = {
      ...sourceAssertion,
      lineage: {
        correctedSourceAssertionId: initialAssertionId,
        kind: 'CORRECTION' as const,
        reason: 'Correct misplaced decimal point',
      },
      sourceAssertionId: correctionAssertionId,
      sourceRecord: {
        ...sourceAssertion.sourceRecord,
        sourceChangeCorrelation: 'erp-change-41',
        sourceRecordVersion: 'row-version-8',
      },
    };
    const correctionEvidence = {
      ...initialEvidence,
      lineage: {
        actingPrincipalId: '99999999-9999-4999-8999-999999999999',
        correctedSourceAssertionId: initialAssertionId,
        kind: 'CORRECTION' as const,
        reason: 'Correct misplaced decimal point',
      },
      sourceAssertion: correctionAssertion,
      sourceFactFingerprint: 'b'.repeat(64),
    };
    const supersessionEvidence = {
      ...correctionEvidence,
      lineage: {
        actingPrincipalId: '99999999-9999-4999-8999-999999999999',
        kind: 'SUPERSESSION' as const,
        reason: 'Source owner issued the next effective fact',
        supersededSourceAssertionId: correctionAssertionId,
      },
      sourceAssertion: {
        ...correctionAssertion,
        lineage: {
          kind: 'SUPERSESSION' as const,
          reason: 'Source owner issued the next effective fact',
          supersededSourceAssertionId: correctionAssertionId,
        },
        sourceAssertionId: supersessionAssertionId,
        sourceRecord: {
          ...correctionAssertion.sourceRecord,
          sourceChangeCorrelation: 'erp-change-42',
          sourceRecordVersion: 'row-version-9',
        },
      },
      sourceFactFingerprint: 'c'.repeat(64),
    };

    expect(decodeEvidence(initialEvidence).sourceAssertion.lineage).toEqual({ kind: 'INITIAL' });
    expect(decodeEvidence(correctionEvidence).sourceAssertion.lineage).toEqual(correctionAssertion.lineage);
    expect(decodeEvidence(supersessionEvidence).sourceAssertion.lineage).toEqual(
      supersessionEvidence.sourceAssertion.lineage,
    );
  });

  it('never promotes source row identity, delivery order, or import time into the Price key or winner', () => {
    const laterDelivery = decodeProvenance({
      ...initialProvenance,
      evidence: {
        ...initialEvidence,
        recordedAt: '2026-12-01T00:01:00.000Z',
        sourceAssertion: {
          ...sourceAssertion,
          sourceRecord: {
            ...sourceAssertion.sourceRecord,
            sourceRecordRef: 'erp-price-row-999',
            sourceRecordVersion: 'row-version-999',
          },
          timing: { ...sourceAssertion.timing, importedAt: '2026-12-01T00:00:00.000Z' },
        },
      },
    });

    expect(laterDelivery.canonicalLink).toEqual(canonicalLink);
    for (const nonIdentityField of [
      { importedAt: '2026-12-01T00:00:00.000Z' },
      { sourceRecordRef: 'erp-price-row-999' },
      { sourceRecordVersion: 'row-version-999' },
      { sourceRowOrder: 999 },
    ]) {
      expect(() =>
        decodeProvenance({
          ...initialProvenance,
          canonicalLink: {
            ...canonicalLink,
            identityKey: { ...canonicalIdentity, ...nonIdentityField },
          },
        }),
      ).toThrow();
    }
  });

  it('fails closed for Product-only, Market-less, Storefront-specific, ambiguous, and duplicate assertions', () => {
    const { variantRef: _variantRef, ...productOnly } = canonicalIdentity.catalogSelection;
    const { marketId: _marketId, ...marketlessScope } = canonicalIdentity.commercialScope;
    for (const invalidIdentity of [
      { ...canonicalIdentity, catalogSelection: productOnly },
      { ...canonicalIdentity, commercialScope: marketlessScope },
      {
        ...canonicalIdentity,
        commercialScope: { ...canonicalIdentity.commercialScope, storefrontId: 'web-cz' },
      },
    ]) {
      expect(() =>
        decodeAssessment({
          outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED',
          provenance: {
            ...initialProvenance,
            canonicalLink: { ...canonicalLink, identityKey: invalidIdentity },
          },
        }),
      ).toThrow();
    }

    for (const outcome of [
      {
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID' as const,
        reason: 'VARIANT_AMBIGUOUS' as const,
        sourceAssertionId: initialAssertionId,
      },
      {
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD' as const,
        reason: 'DUPLICATE_CORRELATION_HELD' as const,
        sourceAssertionId: initialAssertionId,
      },
      {
        dependency: 'CURRENCY_SUPPORT' as const,
        outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE' as const,
        retryable: true as const,
        sourceAssertionId: initialAssertionId,
      },
    ]) {
      expect(decodeAssessment(outcome)).toEqual(outcome);
      expect(() => decodeAssessment({ ...outcome, provenance: initialProvenance })).toThrow();
    }
  });

  it('retains generalized EUR input but cannot accept FX or gross input without authoritative normalization', () => {
    const eurEvidence = {
      ...initialEvidence,
      sourceAssertion: {
        ...sourceAssertion,
        originalAssertion: {
          ...sourceAssertion.originalAssertion,
          monetaryAmount: { amount: '125.50', currencyCode: 'EUR' },
        },
      },
    };
    expect(decodeEvidence(eurEvidence).sourceAssertion.originalAssertion.monetaryAmount.currencyCode).toBe('EUR');
    expect(() => decodeProvenance({ ...initialProvenance, evidence: eurEvidence })).toThrow();

    const grossWithoutNormalization = {
      ...initialProvenance,
      evidence: {
        ...initialEvidence,
        sourceAssertion: {
          ...sourceAssertion,
          originalAssertion: {
            ...sourceAssertion.originalAssertion,
            monetaryBoundary: 'TAX_INCLUSIVE' as const,
          },
        },
      },
    };
    expect(() => decodeProvenance(grossWithoutNormalization)).toThrow();
    expect(
      decodeAssessment({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
        sourceAssertionId: initialAssertionId,
      }),
    ).toBeDefined();
  });
});
