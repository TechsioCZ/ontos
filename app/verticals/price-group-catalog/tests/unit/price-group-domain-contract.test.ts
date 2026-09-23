import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ExpectedPriceGroupCurrentEvidenceSchema,
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupCompatibilityEvidenceSchema,
  PriceGroupCurrentEvidenceSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupEffectivePeriodSchema,
  PriceGroupLifecycleSchema,
  StablePriceGroupRefSchema,
  priceGroupPeriodContains,
} from '../../shared/domain/price-group.ts';
import { PriceGroupCurrentnessFailure } from '../../shared/domain/price-group-errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const period = {
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: '2027-01-01T00:00:00.000Z',
};
const provenance = {
  actionInvocationId: '44444444-4444-4444-8444-444444444444',
  actorPrincipalId: '55555555-5555-4555-8555-555555555555',
  reason: 'Approved clarification of the existing dealer classification.',
  trustedAt: '2026-09-23T12:00:00.000Z',
};
const definition = {
  acceptedCatalogRevision: 7,
  classificationPurpose: 'Classifies customers eligible for the dealer pricing path.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
  created: provenance,
  definitionRevisionId,
  description: 'Dealer classification for approved resellers.',
  displayName: 'Dealer',
  effectivePeriod: period,
  meaningFingerprint: 'a'.repeat(64),
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
};

describe('Price Group identity, definition, and lifecycle contracts', () => {
  it('keeps stable identity tenant-scoped and independent from business code', () => {
    const decode = Schema.decodeUnknownSync(StablePriceGroupRefSchema, { onExcessProperty: 'error' });

    expect(decode(priceGroupRef)).toEqual(priceGroupRef);
    expect(() => decode({ ...priceGroupRef, resourceId: 'DEALER' })).toThrow();
    expect(() => decode({ ...priceGroupRef, businessCode: 'DEALER' })).toThrow();
    expect(() => decode({ ...priceGroupRef, tenantId: 'not-a-tenant-id' })).toThrow();
  });

  it('accepts immutable revisions only with a valid predecessor chain and exact contract support', () => {
    const decode = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema);

    expect(decode(definition)).toMatchObject({ definitionRevisionId, revisionNumber: 1 });
    expect(() => decode({ ...definition, previousDefinitionRevisionId: definitionRevisionId })).toThrow();
    expect(() =>
      decode({
        ...definition,
        compatibilityContracts: [...definition.compatibilityContracts, ...definition.compatibilityContracts],
      }),
    ).toThrow();
  });

  it('uses non-empty half-open periods without a technical winner-selection rule', () => {
    const decode = Schema.decodeUnknownSync(PriceGroupEffectivePeriodSchema);

    expect(decode(period)).toEqual(period);
    expect(priceGroupPeriodContains(period, period.effectiveFrom)).toBe(true);
    expect(priceGroupPeriodContains(period, period.effectiveTo)).toBe(false);
    expect(() => decode({ effectiveFrom: period.effectiveTo, effectiveTo: period.effectiveFrom })).toThrow();
    expect(() => decode({ effectiveFrom: period.effectiveFrom, effectiveTo: period.effectiveFrom })).toThrow();
  });

  it('models ACTIVE to RETIRED as the only lifecycle and requires terminal retirement evidence', () => {
    const decode = Schema.decodeUnknownSync(PriceGroupLifecycleSchema);

    expect(decode({ activeFrom: period.effectiveFrom, retiredAt: null, state: 'ACTIVE' })).toMatchObject({
      state: 'ACTIVE',
    });
    expect(decode({ activeFrom: period.effectiveFrom, retiredAt: period.effectiveTo, state: 'RETIRED' })).toMatchObject(
      { state: 'RETIRED' },
    );
    expect(() => decode({ activeFrom: period.effectiveFrom, retiredAt: null, state: 'RETIRED' })).toThrow();
    expect(() => decode({ activeFrom: period.effectiveFrom, retiredAt: null, state: 'REACTIVATED' })).toThrow();
  });
});

describe('Price Group currentness and compatibility evidence', () => {
  it('binds current and expected-current evidence to an exact revision and catalog fence', () => {
    const current = {
      catalogRevision: 7,
      definitionEffectivePeriod: period,
      definitionRevisionId,
      definitionRevisionNumber: 1,
      meaningFingerprint: 'a'.repeat(64),
      observedAt: period.effectiveFrom,
      priceGroupRef,
    };

    expect(Schema.decodeUnknownSync(PriceGroupCurrentEvidenceSchema)(current)).toMatchObject({ catalogRevision: 7 });
    expect(
      Schema.decodeUnknownSync(ExpectedPriceGroupCurrentEvidenceSchema)({
        catalogRevision: current.catalogRevision,
        definitionRevisionId,
        definitionRevisionNumber: 1,
        meaningFingerprint: current.meaningFingerprint,
        priceGroupRef,
      }),
    ).toMatchObject({ definitionRevisionId });
    expect(() =>
      Schema.decodeUnknownSync(PriceGroupCurrentEvidenceSchema)({ ...current, observedAt: period.effectiveTo }),
    ).toThrow();
  });

  it('binds compatibility to the exact Price Group, revision, contract, and trusted operation time', () => {
    const evidence = {
      catalogRevision: 7,
      definitionEffectivePeriod: period,
      definitionRevisionId,
      definitionRevisionNumber: 1,
      meaningFingerprint: 'a'.repeat(64),
      priceGroupRef,
      requiredContract: definition.compatibilityContracts[0],
      trustedOperationAt: '2026-11-01T00:00:00.000Z',
      verifiedAt: '2026-11-01T00:00:01.000Z',
    };

    expect(Schema.decodeUnknownSync(PriceGroupCompatibilityEvidenceSchema)(evidence)).toMatchObject({
      definitionRevisionId,
      requiredContract: { version: 1 },
    });
    expect(() =>
      Schema.decodeUnknownSync(PriceGroupCompatibilityEvidenceSchema)({
        ...evidence,
        trustedOperationAt: period.effectiveTo,
      }),
    ).toThrow();

    const decodeDecision = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema);
    expect(decodeDecision({ evidence, kind: 'USABLE' }).kind).toBe('USABLE');
    expect(() => decodeDecision({ kind: 'UNUSABLE', priceGroupRef, reasonCode: 'OWNER_UNAVAILABLE' })).toThrow();
  });

  it('keeps zero, multiple, and unverifiable currentness as typed failures', () => {
    const failure = new PriceGroupCurrentnessFailure({
      candidateDefinitionRevisionIds: [],
      code: 'price_group_currentness_failure',
      priceGroupRef: Schema.decodeUnknownSync(StablePriceGroupRefSchema)(priceGroupRef),
      reason: 'ZERO_CURRENT_DEFINITIONS',
    });

    expect(Schema.is(PriceGroupCurrentnessFailure)(failure)).toBe(true);
    expect(failure.reason).toBe('ZERO_CURRENT_DEFINITIONS');
  });
});
