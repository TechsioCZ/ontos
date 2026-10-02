import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingContractualDiscountCurrentSetSchema,
  PricingContractualDiscountRevisionSchema,
  PricingContractualDiscountScheduleAcknowledgementSchema,
  PricingContractualDiscountScheduleFingerprintSchema,
  PricingContractualDiscountScheduleSnapshotSchema,
  PricingContractualDiscountSetGenerationVerificationSchema,
  PricingContractualDiscountSetPredicateSchema,
  pricingContractualDiscountSetPredicateRef,
} from '../../src/domain/contractual-discount-set.ts';
import { ScheduledPricingDiscountRevisionSchema } from '../../src/domain/discount.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const observedAt = '2026-09-28T10:00:00.000Z';
const predicate = Schema.decodeSync(PricingContractualDiscountSetPredicateSchema)({
  audiences: [{ counterpartyRef, kind: 'COUNTERPARTY' }],
  basis: { kind: 'WHOLE_PURCHASE' },
  commercialScope: {
    channelId: 'B2B',
    marketId: 'cz-launch',
    sellingLegalEntityId: '33333333-3333-4333-8333-333333333333',
  },
  currencyCode: 'CZK',
  effectiveAt: observedAt,
  tenantId,
});
const predicateRef = pricingContractualDiscountSetPredicateRef(predicate);
const ownerRevision = 'contractual-discount-set:generation:7';
const currentDiscount = Schema.decodeSync(ScheduledPricingDiscountRevisionSchema)({
  definition: {
    discountId: '44444444-4444-4444-8444-444444444444',
    identityKey: {
      audience: { counterpartyRef, kind: 'COUNTERPARTY' },
      basis: { kind: 'WHOLE_PURCHASE' },
      commercialScope: predicate.commercialScope,
      currencyCode: predicate.currencyCode,
      effectKind: 'FIXED_MONETARY_AMOUNT',
      family: 'CONTRACTUAL_DISCOUNT',
      monetaryBoundary: 'PRE_TAX',
      scope: 'WHOLE_PURCHASE',
    },
    revision: {
      configuredEffect: {
        kind: 'FIXED_MONETARY_AMOUNT',
        level: { amount: '100', currencyCode: 'CZK' },
      },
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      revision: 1,
      revisionId: '55555555-5555-4555-8555-555555555555',
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});
const authority = {
  generation: 7,
  observedAt,
  ownerRevision,
  ownerRootRef: `pricing:contractual-discount-set:${tenantId}`,
  predicateRef,
  verificationRef: 'pricing:contractual-discount-set-proof:test',
  verifiedAt: '2026-09-28T10:00:01.000Z',
};
const factProofs = [
  {
    factRef: currentDiscount.definition.discountId,
    factRevisionRef: currentDiscount.definition.revision.revisionId,
    verificationRef: 'pricing:contractual-discount-fact-proof:test',
  },
];
const completenessEvidence = {
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision,
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
};

describe('Contractual Discount complete Current-set contract', () => {
  it('accepts a complete exact set and treats an empty proven set as authoritative absence', () => {
    const decode = Schema.decodeUnknownSync(PricingContractualDiscountCurrentSetSchema, {
      onExcessProperty: 'error',
    });
    expect(
      decode({ authority, completenessEvidence, currentDiscounts: [currentDiscount], factProofs, predicate }),
    ).toMatchObject({ authority, currentDiscounts: [currentDiscount], factProofs, predicate });
    expect(decode({ authority, completenessEvidence, currentDiscounts: [], factProofs: [], predicate })).toMatchObject({
      authority,
      currentDiscounts: [],
      factProofs: [],
      predicate,
    });
  });

  it('rejects partial, drifted, stale, Catalog, and invalid whole-purchase predicates', () => {
    const decodeSet = Schema.decodeUnknownSync(PricingContractualDiscountCurrentSetSchema);
    for (const candidate of [
      {
        authority: { ...authority, generation: 8 },
        completenessEvidence: { ...completenessEvidence, ownerRevision: 'other-generation' },
        currentDiscounts: [currentDiscount],
        factProofs,
        predicate,
      },
      {
        authority,
        completenessEvidence,
        currentDiscounts: [
          {
            ...currentDiscount,
            effectivePeriod: { ...currentDiscount.effectivePeriod, effectiveFrom: '2026-10-02T00:00:00.000Z' },
          },
        ],
        factProofs,
        predicate,
      },
      {
        authority: { ...authority, verifiedAt: completenessEvidence.nextApplicabilityBoundary },
        completenessEvidence,
        currentDiscounts: [currentDiscount],
        factProofs,
        predicate,
      },
    ]) {
      expect(() => decodeSet(candidate)).toThrow();
    }

    expect(
      Schema.is(PricingContractualDiscountSetPredicateSchema)({
        ...predicate,
        audiences: [{ kind: 'CATALOG_PATH', selection: {} }],
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingContractualDiscountSetPredicateSchema)({
        ...predicate,
        audiences: [
          {
            kind: 'PRICE_GROUP',
            priceGroupRef: {
              moduleId: 'pricing.price-group-catalog',
              resourceId: '66666666-6666-4666-8666-666666666666',
              resourceType: 'pricing.price-group-catalog.price-group',
              tenantId,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('carries the root generation on Current verification and makes change a distinct outcome', () => {
    const decode = Schema.decodeUnknownSync(PricingContractualDiscountSetGenerationVerificationSchema);
    expect(
      decode({
        authority,
        outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT',
        verifiedThrough: '2026-09-28T10:05:00.000Z',
      }),
    ).toMatchObject({ authority: { generation: 7, ownerRootRef: authority.ownerRootRef } });
    expect(
      decode({
        outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CHANGED',
        verifiedThrough: '2026-09-28T10:05:00.000Z',
      }),
    ).toMatchObject({ outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CHANGED' });
  });

  it('exposes exact contractual revision history and schedule acknowledgement shapes', () => {
    const scheduledCurrent = {
      ...currentDiscount,
      effectivePeriod: {
        ...currentDiscount.effectivePeriod,
        effectiveTo: '2026-10-01T00:00:00.000Z',
      },
    };
    const futureDiscount = {
      ...currentDiscount,
      definition: {
        ...currentDiscount.definition,
        revision: {
          ...currentDiscount.definition.revision,
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          revision: 2,
          revisionId: '77777777-7777-4777-8777-777777777777',
        },
      },
      effectivePeriod: {
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        effectiveTo: null,
      },
      lineage: {
        correctedRevisionId: null,
        kind: 'SCHEDULED' as const,
        previousRevisionId: currentDiscount.definition.revision.revisionId,
      },
    };
    const schedule = {
      current: scheduledCurrent,
      discountId: currentDiscount.definition.discountId,
      future: [futureDiscount],
      identityKey: currentDiscount.definition.identityKey,
      observedAt,
      revisions: [scheduledCurrent, futureDiscount],
      scheduleRevision: 2,
    };
    const decodeSchedule = Schema.decodeUnknownSync(PricingContractualDiscountScheduleSnapshotSchema, {
      onExcessProperty: 'error',
    });
    const decodedSchedule = decodeSchedule(schedule);
    expect(decodedSchedule.revisions).toHaveLength(2);
    expect(decodedSchedule.future).toEqual([futureDiscount]);
    expect(Schema.is(PricingContractualDiscountRevisionSchema)(futureDiscount)).toBe(true);
    expect(Schema.is(PricingContractualDiscountScheduleFingerprintSchema)('a'.repeat(64))).toBe(true);
    expect(Schema.is(PricingContractualDiscountScheduleFingerprintSchema)('A'.repeat(64))).toBe(false);

    expect(
      Schema.is(PricingContractualDiscountScheduleAcknowledgementSchema)({
        actingPrincipalId: '88888888-8888-4888-8888-888888888888',
        discountId: currentDiscount.definition.discountId,
        fingerprint: 'a'.repeat(64),
        identityKey: currentDiscount.definition.identityKey,
        intendedConfiguredEffect: currentDiscount.definition.revision.configuredEffect,
        intendedEffectivePeriod: {
          effectiveFrom: observedAt,
          effectiveTo: '2026-10-01T00:00:00.000Z',
        },
        intent: 'VALUE_ONLY_CURRENT',
        presentedFuture: [futureDiscount],
        scheduleRevision: 2,
        targetEffectivePeriod: schedule.revisions[0]?.effectivePeriod,
        targetRevisionId: currentDiscount.definition.revision.revisionId,
      }),
    ).toBe(true);
  });

  it('rejects non-contractual revision, history, and acknowledgement identities', () => {
    const catalogIdentity = {
      ...currentDiscount.definition.identityKey,
      audience: {
        kind: 'CATALOG_PATH' as const,
        selection: {
          productRef: {
            moduleId: 'commerce.catalog',
            resourceId: '99999999-9999-4999-8999-999999999999',
            resourceType: 'commerce.catalog.product',
            tenantId,
          },
          variantRef: {
            moduleId: 'commerce.catalog',
            resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            resourceType: 'commerce.catalog.variant',
            tenantId,
          },
        },
      },
      family: 'CATALOG_DISCOUNT' as const,
    };
    const catalogRevision = {
      ...currentDiscount,
      definition: { ...currentDiscount.definition, identityKey: catalogIdentity },
    };
    expect(Schema.is(PricingContractualDiscountRevisionSchema)(catalogRevision)).toBe(false);
    expect(
      Schema.is(PricingContractualDiscountScheduleSnapshotSchema)({
        current: catalogRevision,
        discountId: catalogRevision.definition.discountId,
        future: [],
        identityKey: catalogIdentity,
        observedAt,
        revisions: [catalogRevision],
        scheduleRevision: 1,
      }),
    ).toBe(false);
  });
});
