import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PricingCommercialFeeIdentityKey } from '../../src/domain/commercial-fee.ts';

import {
  PricingCommercialFeeCalculationBasisSchema,
  PricingCommercialFeeCalculationInputSchema,
  PricingCommercialFeeCalculationResultSchema,
  PricingCommercialFeeContributionSchema,
  PricingCommercialFeeCurrentResolutionSchema,
  PricingCommercialFeeCurrentSetSchema,
  PricingCommercialFeeDefinitionSchema,
  PricingCommercialFeeFamilySchema,
  PricingCommercialFeeIdentityKeySchema,
  PricingCommercialFeeProductBulkResultSchema,
  PricingCommercialFeeProductBulkRetrySchema,
  PricingCommercialFeeScheduleAcknowledgementSchema,
  PricingCommercialFeeScheduleSnapshotSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
} from '../../src/domain/commercial-fee.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const capturedAt = '2026-09-27T10:00:00.000Z';
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '22222222-2222-4222-8222-222222222222',
};

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.product');
const otherProductRef = catalogRef('18181818-1818-4181-8181-181818181818', 'commerce.catalog.product');
const firstVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const secondVariantRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant');
const laterVariantRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.variant');
const unitRef = catalogRef('77777777-7777-4777-8777-777777777777', 'commerce.catalog.product-unit');
const firstTarget = { productRef, variantRef: firstVariantRef };
const secondTarget = { productRef, variantRef: secondVariantRef };
const laterTarget = { productRef, variantRef: laterVariantRef };
const firstIdentityTarget = { variantRef: firstVariantRef };
const secondIdentityTarget = { variantRef: secondVariantRef };

const perLineIdentity = {
  calculationBasis: { kind: 'FIXED_PER_LINE' as const },
  commercialScope,
  currencyCode: 'CZK',
  family: 'RECYCLING_FEE' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  target: firstIdentityTarget,
};
const perUnitIdentity = {
  ...perLineIdentity,
  calculationBasis: {
    kind: 'FIXED_PER_UNIT' as const,
    unitBasis: { quantity: '1', unitRef },
  },
};

const feeId = '88888888-8888-4888-8888-888888888888';
const feeRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: feeId,
  resourceType: 'commerce.pricing.commercial-fee' as const,
  tenantId,
};
const firstRevisionId = '99999999-9999-4999-8999-999999999999';
const futureRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const definitionFor = ({
  amount = '20',
  catalogProductRef = productRef,
  effectiveFrom = '2026-09-01T00:00:00.000Z',
  identityKey = perLineIdentity,
  revision = 1,
  revisionId = firstRevisionId,
}: {
  readonly amount?: string;
  readonly catalogProductRef?: typeof productRef;
  readonly effectiveFrom?: string;
  readonly identityKey?: PricingCommercialFeeIdentityKey;
  readonly revision?: number;
  readonly revisionId?: string;
} = {}) => ({
  catalogTargetEvidence: {
    capturedAt,
    catalogOwnerRevision: 'catalog-product-targets:773',
    productRef: catalogProductRef,
    snapshotId: 'commercial-fee-product-snapshot:773',
    targetId: `commercial-fee-target:${identityKey.target.variantRef.resourceId}`,
    variantRef: identityKey.target.variantRef,
  },
  feeRef,
  identityKey,
  revision: {
    configuredAmount: { amount, currencyCode: identityKey.currencyCode },
    effectiveFrom,
    revision,
    revisionId,
  },
});

const scheduledRevision = ({
  amount,
  effectiveFrom,
  effectiveTo,
  identityKey = perLineIdentity,
  kind,
  revision,
  revisionId,
}: {
  readonly amount: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: null | string;
  readonly identityKey?: PricingCommercialFeeIdentityKey;
  readonly kind: 'INITIAL' | 'SCHEDULED' | 'VALUE_ONLY_CURRENT';
  readonly revision: number;
  readonly revisionId: string;
}) => ({
  definition: definitionFor({ amount, effectiveFrom, identityKey, revision, revisionId }),
  effectivePeriod: { effectiveFrom, effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind,
    previousRevisionId: kind === 'INITIAL' ? null : firstRevisionId,
  },
});

const current = scheduledRevision({
  amount: '20',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-09-28T00:00:00.000Z',
  kind: 'INITIAL',
  revision: 1,
  revisionId: firstRevisionId,
});
const future = scheduledRevision({
  amount: '25',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  kind: 'SCHEDULED',
  revision: 2,
  revisionId: futureRevisionId,
});

const catalogEvidenceFor = (target: typeof firstTarget) => ({
  assessedAt: capturedAt,
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: target.variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: target.productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: `catalog-membership:${target.variantRef.resourceId}`,
    observedAt: capturedAt,
    productRef: target.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: target.variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection: target,
  status: 'VALID' as const,
});

const snapshotEntryFor = (target: typeof firstTarget, targetId: string) => ({
  catalogEvidence: catalogEvidenceFor(target),
  target,
  targetId,
});
const snapshot = {
  capturedAt,
  catalogOwnerRevision: 'catalog-product-variants:773',
  productRef,
  snapshotId: 'commercial-fee-product-snapshot:773',
  targets: [
    snapshotEntryFor(firstTarget, 'commercial-fee-target:first'),
    snapshotEntryFor(secondTarget, 'commercial-fee-target:second'),
  ],
  targetSetCompleteness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-product-variants:773',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-product:active-variants' },
  },
};

const occurrenceId = 'pricing-demand-occurrence:773';
const catalogHandoff = {
  completeness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-quantity:773',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-variant' },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:issue-773',
  evidence: catalogEvidenceFor(firstTarget),
  hierarchyRevision: 'catalog-hierarchy:773',
  ownerRevision: 'catalog-quantity:773',
  quantity: {
    changed: false,
    notice: null,
    requested: '10',
    resulting: '10',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: firstVariantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: firstVariantRef,
    unitRef,
    unitRuleRevision: 7,
  },
  selection: firstTarget,
  status: 'READY' as const,
  unitRef,
};
const decision = {
  commercialScope,
  currencyCode: 'CZK',
  lines: [{ catalog: catalogHandoff, occurrenceId, pricingBasis: { quantity: '10', unitRef } }],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: capturedAt,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:773',
      decisionRevision: 'commerce-access-decision-revision:773',
    },
    actor: {
      guestEvidenceRef: 'guest-evidence:773',
      guestSessionRef: 'guest-session:773',
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'commerce-settings-decision:773',
      decisionRevision: 'commerce-settings-decision-revision:773',
    },
    contextRef: 'commerce-purchasing-context:773',
    contextRevision: 'customer-context:773',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:773',
      resolutionRevision: 'purchase-currency-resolution-revision:773',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:773',
      guestSessionRef: 'guest-session:773',
      kind: 'GUEST' as const,
    },
  },
  tenantId,
};
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '12121212-1212-4121-8121-121212121212',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionId = '13131313-1313-4131-8131-131313131313';
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const supportVerificationRef = 'pricing:currency-support:proof:773';
const currencySupport = {
  completenessEvidence: {
    observedAt: capturedAt,
    ownerRevision: supportRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: capturedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: capturedAt,
    revalidatedAt: '2026-09-27T10:00:01.000Z',
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt: capturedAt,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [
    {
      factRef: supportRootRef.resourceId,
      factRevisionRef: supportRevisionRef.resourceId,
      verificationRef: supportVerificationRef,
    },
  ],
  generation: 7,
  observedAt: capturedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: 'pricing-currency-support:773',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef: supportVerificationRef,
};

const currentSetFor = (fees: readonly ReturnType<typeof scheduledRevision>[], target = firstIdentityTarget) => {
  const ownerRevision = 'pricing-commercial-fees:773';
  const predicateRef = pricingCommercialFeeCurrentSetPredicateRef({
    commercialScope,
    currencyCode: 'CZK',
    target,
  });
  return {
    commercialScope,
    completenessEvidence: {
      observedAt: capturedAt,
      ownerRevision,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
    },
    currencyCode: 'CZK',
    currentnessEvidence: {
      observedAt: capturedAt,
      ownerRevision,
      predicateRef,
      revalidatedAt: '2026-09-27T10:00:01.000Z',
      verificationMode: 'OWNER_CURRENT_SET_REVALIDATED' as const,
    },
    fees,
    observedAt: capturedAt,
    target,
  };
};

const decodeFamily = Schema.decodeUnknownSync(PricingCommercialFeeFamilySchema, { onExcessProperty: 'error' });
const decodeBasis = Schema.decodeUnknownSync(PricingCommercialFeeCalculationBasisSchema, {
  onExcessProperty: 'error',
});
const decodeIdentity = Schema.decodeUnknownSync(PricingCommercialFeeIdentityKeySchema, {
  onExcessProperty: 'error',
});
const decodeDefinition = Schema.decodeUnknownSync(PricingCommercialFeeDefinitionSchema, {
  onExcessProperty: 'error',
});
const decodeSchedule = Schema.decodeUnknownSync(PricingCommercialFeeScheduleSnapshotSchema, {
  onExcessProperty: 'error',
});
const decodeAcknowledgement = Schema.decodeUnknownSync(PricingCommercialFeeScheduleAcknowledgementSchema, {
  onExcessProperty: 'error',
});
const decodeCurrent = Schema.decodeUnknownSync(PricingCommercialFeeCurrentResolutionSchema, {
  onExcessProperty: 'error',
});
const decodeCurrentSet = Schema.decodeUnknownSync(PricingCommercialFeeCurrentSetSchema, {
  onExcessProperty: 'error',
});
const decodeBulkResult = Schema.decodeUnknownSync(PricingCommercialFeeProductBulkResultSchema, {
  onExcessProperty: 'error',
});
const decodeBulkRetry = Schema.decodeUnknownSync(PricingCommercialFeeProductBulkRetrySchema, {
  onExcessProperty: 'error',
});
const decodeCalculationInput = Schema.decodeUnknownSync(PricingCommercialFeeCalculationInputSchema, {
  onExcessProperty: 'error',
});
const decodeContribution = Schema.decodeUnknownSync(PricingCommercialFeeContributionSchema, {
  onExcessProperty: 'error',
});
const decodeCalculationResult = Schema.decodeUnknownSync(PricingCommercialFeeCalculationResultSchema, {
  onExcessProperty: 'error',
});

describe('Issue #773 Pricing Commercial Fee contract acceptance', () => {
  it('accepts only the two Launch families and fixed bases, with zero valid and negative amounts invalid', () => {
    expect(decodeFamily('RECYCLING_FEE')).toBe('RECYCLING_FEE');
    expect(decodeFamily('COPYRIGHT_FEE')).toBe('COPYRIGHT_FEE');
    for (const forbidden of ['SHIPPING_FEE', 'DELIVERY_FEE', 'PAYMENT_FEE', 'TAX', 'DISCOUNT']) {
      expect(() => decodeFamily(forbidden)).toThrow();
    }

    expect(decodeBasis({ kind: 'FIXED_PER_LINE' })).toEqual({ kind: 'FIXED_PER_LINE' });
    expect(decodeBasis(perUnitIdentity.calculationBasis)).toEqual(perUnitIdentity.calculationBasis);
    expect(() => decodeBasis({ kind: 'FIXED_MONETARY_AMOUNT' })).toThrow();
    expect(() => decodeBasis({ kind: 'FIXED_PER_UNIT' })).toThrow();

    expect(decodeDefinition(definitionFor({ amount: '0' })).revision.configuredAmount.amount).toBe('0');
    expect(() => decodeDefinition(definitionFor({ amount: '-0.01' }))).toThrow();
  });

  it('binds identity to exact Variant, SLE, Channel, Market, currency, and compatible Unit meaning', () => {
    const baseline = decodeIdentity(perUnitIdentity);
    expect(baseline.target).toEqual(firstIdentityTarget);
    expect(baseline.commercialScope).toEqual(commercialScope);
    expect(baseline.currencyCode).toBe('CZK');
    expect(baseline.calculationBasis).toEqual(perUnitIdentity.calculationBasis);

    for (const distinct of [
      { ...perUnitIdentity, target: secondIdentityTarget },
      { ...perUnitIdentity, commercialScope: { ...commercialScope, channelId: 'B2C' as const } },
      { ...perUnitIdentity, commercialScope: { ...commercialScope, marketId: 'sk-launch' } },
      {
        ...perUnitIdentity,
        commercialScope: { ...commercialScope, sellingLegalEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
      { ...perUnitIdentity, currencyCode: 'EUR' },
      { ...perUnitIdentity, family: 'COPYRIGHT_FEE' as const },
      { ...perUnitIdentity, calculationBasis: { kind: 'FIXED_PER_LINE' as const } },
      {
        ...perUnitIdentity,
        calculationBasis: {
          ...perUnitIdentity.calculationBasis,
          unitBasis: {
            quantity: '1',
            unitRef: { ...unitRef, resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          },
        },
      },
    ]) {
      expect(decodeIdentity(distinct)).not.toEqual(baseline);
    }

    expect(() => decodeIdentity({ ...perLineIdentity, target: { productRef } })).toThrow();
    expect(() => decodeIdentity({ ...perLineIdentity, storefrontId: 'storefront:prague' })).toThrow();
  });

  it('keeps generalized native EUR contracts without support activation, FX, or currency relabeling', () => {
    const eurIdentity = { ...perUnitIdentity, currencyCode: 'EUR' };
    expect(decodeIdentity(eurIdentity).currencyCode).toBe('EUR');
    expect(
      decodeDefinition({
        ...definitionFor({ identityKey: eurIdentity }),
        revision: {
          ...definitionFor({ identityKey: eurIdentity }).revision,
          configuredAmount: { amount: '5', currencyCode: 'EUR' },
        },
      }).revision.configuredAmount.currencyCode,
    ).toBe('EUR');
    expect(() => decodeIdentity({ ...eurIdentity, exchangeRate: '25' })).toThrow();
    expect(() => decodeIdentity({ ...eurIdentity, supportedCurrencies: ['CZK', 'EUR'] })).toThrow();
    expect(() =>
      decodeDefinition({
        ...definitionFor({ identityKey: eurIdentity }),
        revision: {
          ...definitionFor({ identityKey: eurIdentity }).revision,
          configuredAmount: { amount: '5', currencyCode: 'CZK' },
        },
      }),
    ).toThrow();
  });

  it('preserves finite Current end, following gap, future Revision, and exact schedule acknowledgement', () => {
    const revisedCurrent = scheduledRevision({
      amount: '22',
      effectiveFrom: current.effectivePeriod.effectiveFrom,
      effectiveTo: current.effectivePeriod.effectiveTo,
      kind: 'VALUE_ONLY_CURRENT',
      revision: 3,
      revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const schedule = decodeSchedule({
      current: revisedCurrent,
      feeRef,
      future: [future],
      identityKey: perLineIdentity,
      observedAt: capturedAt,
      revisions: [revisedCurrent, future],
      scheduleRevision: 3,
    });
    expect(schedule.current?.effectivePeriod).toEqual(current.effectivePeriod);
    expect(schedule.current?.effectivePeriod.effectiveTo).not.toBe(future.effectivePeriod.effectiveFrom);
    expect(schedule.future).toEqual([future]);

    const acknowledgement = {
      actingPrincipalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      feeRef,
      fingerprint: 'a'.repeat(64),
      identityKey: perLineIdentity,
      intendedConfiguredAmount: { amount: '22', currencyCode: 'CZK' },
      intendedEffectivePeriod: {
        effectiveFrom: '2026-09-27T00:00:00.000Z',
        effectiveTo: current.effectivePeriod.effectiveTo,
      },
      intent: 'VALUE_ONLY_CURRENT' as const,
      presentedFuture: [future],
      scheduleRevision: 2,
      targetEffectivePeriod: current.effectivePeriod,
      targetRevisionId: current.definition.revision.revisionId,
    };
    expect(decodeAcknowledgement(acknowledgement).presentedFuture).toEqual([future]);
    expect(
      decodeAcknowledgement({
        ...acknowledgement,
        intendedConfiguredAmount: current.definition.revision.configuredAmount,
        intendedEffectivePeriod: {
          effectiveFrom: current.effectivePeriod.effectiveFrom,
          effectiveTo: '2026-09-27T00:00:00.000Z',
        },
        intent: 'RETIRE_CURRENT',
      }).intent,
    ).toBe('RETIRE_CURRENT');
    expect(() =>
      decodeAcknowledgement({
        ...acknowledgement,
        intendedEffectivePeriod: {
          effectiveFrom: current.effectivePeriod.effectiveFrom,
          effectiveTo: '2026-09-27T00:00:00.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAcknowledgement({
        ...acknowledgement,
        targetEffectivePeriod: { ...current.effectivePeriod, effectiveTo: '2026-09-29T00:00:00.000Z' },
      }),
    ).toThrow();
    expect(() =>
      decodeAcknowledgement({ ...acknowledgement, identityKey: { ...perLineIdentity, target: secondIdentityTarget } }),
    ).toThrow();
  });

  it('conflicts competing truths for one exact family/key while allowing different families to compose', () => {
    const firstDefinition = decodeDefinition(definitionFor());
    const sameVariantDifferentProductEvidence = decodeDefinition(
      definitionFor({
        catalogProductRef: otherProductRef,
        revision: 2,
        revisionId: '19191919-1919-4191-8191-191919191919',
      }),
    );
    expect(sameVariantDifferentProductEvidence.identityKey).toEqual(firstDefinition.identityKey);
    expect(sameVariantDifferentProductEvidence.catalogTargetEvidence.productRef).not.toEqual(
      firstDefinition.catalogTargetEvidence.productRef,
    );
    expect(
      decodeCurrent({
        candidateRevisionIds: [
          firstDefinition.revision.revisionId,
          sameVariantDifferentProductEvidence.revision.revisionId,
        ],
        identityKey: firstDefinition.identityKey,
        observedAt: capturedAt,
        outcome: 'COMMERCIAL_FEE_CURRENT_CONFLICT',
      }).outcome,
    ).toBe('COMMERCIAL_FEE_CURRENT_CONFLICT');

    const recycling = current;
    const copyright = scheduledRevision({
      amount: '5',
      effectiveFrom: current.effectivePeriod.effectiveFrom,
      effectiveTo: current.effectivePeriod.effectiveTo,
      identityKey: { ...perLineIdentity, family: 'COPYRIGHT_FEE' },
      kind: 'INITIAL',
      revision: 1,
      revisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const set = decodeCurrentSet(currentSetFor([recycling, copyright]));
    expect(set.fees.map(({ definition }) => definition.identityKey.family)).toEqual(['RECYCLING_FEE', 'COPYRIGHT_FEE']);
  });

  it('accepts genuine exact absence and rejects unrelated empty-set completeness evidence', () => {
    const exactAbsence = decodeCurrentSet(currentSetFor([]));
    expect(exactAbsence.fees).toEqual([]);

    expect(() =>
      decodeCurrentSet({
        ...currentSetFor([]),
        completenessEvidence: {
          ...currentSetFor([]).completenessEvidence,
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'some-other-owner-predicate' },
        },
      }),
    ).toThrow();
  });

  it('calculates fixed line and unit Fees, then includes their breakdown and total exactly once', () => {
    const copyrightPerUnit = scheduledRevision({
      amount: '5',
      effectiveFrom: current.effectivePeriod.effectiveFrom,
      effectiveTo: current.effectivePeriod.effectiveTo,
      identityKey: { ...perUnitIdentity, family: 'COPYRIGHT_FEE' },
      kind: 'INITIAL',
      revision: 1,
      revisionId: '14141414-1414-4141-8141-141414141414',
    });
    const feeSet = decodeCurrentSet(currentSetFor([current, copyrightPerUnit]));
    const input = decodeCalculationInput({
      baseLineValue: { amount: '100', currencyCode: 'CZK' },
      currencySupport,
      decision,
      feeSet,
      occurrenceId,
      pricePath: {
        priceRef: {
          moduleId: 'commerce.pricing',
          resourceId: '15151515-1515-4151-8151-151515151515',
          resourceType: 'commerce.pricing.price',
          tenantId,
        },
        priceRevisionId: '16161616-1616-4161-8161-161616161616',
        source: 'NO_GROUP_PRICE',
      },
    });
    const perLine = decodeContribution({
      amount: { amount: '20', currencyCode: 'CZK' },
      appliedQuantity: { count: '1', kind: 'LINE' },
      fee: current,
      monetaryBoundary: 'PRE_TAX',
      occurrenceId,
    });
    const perUnit = decodeContribution({
      amount: { amount: '50', currencyCode: 'CZK' },
      appliedQuantity: { kind: 'QUANTITY', quantity: '10', unitRef },
      fee: copyrightPerUnit,
      monetaryBoundary: 'PRE_TAX',
      occurrenceId,
    });
    expect(perLine.amount.amount).toBe('20');
    expect(perUnit.amount.amount).toBe('50');
    expect(() =>
      decodeContribution({
        ...perUnit,
        amount: { amount: '49', currencyCode: 'CZK' },
      }),
    ).toThrow();

    const result = decodeCalculationResult({
      contributions: [perLine, perUnit],
      contributionTotal: { amount: '70', currencyCode: 'CZK' },
      discountableLineBasis: { amount: '170', currencyCode: 'CZK' },
      input,
      outcome: 'COMMERCIAL_FEES_APPLIED',
    });
    expect(result.outcome).toBe('COMMERCIAL_FEES_APPLIED');
    if (result.outcome !== 'COMMERCIAL_FEES_APPLIED') {
      throw new Error('Expected applied Commercial Fees');
    }
    expect(result.contributionTotal.amount).toBe('70');
    expect(result.discountableLineBasis.amount).toBe('170');
    expect(result.contributions.map(({ amount }) => amount.amount)).toEqual(['20', '50']);
    expect(() =>
      decodeCalculationResult({
        ...result,
        discountableLineBasis: { amount: '190', currencyCode: 'CZK' },
      }),
    ).toThrow();

    expect(() =>
      decodeCalculationInput({
        ...input,
        baseLineValue: { amount: '100', currencyCode: 'EUR' },
        decision: { ...decision, currencyCode: 'EUR' },
        feeSet: { ...feeSet, currencyCode: 'EUR', fees: [] },
      }),
    ).toThrow();
  });

  it('freezes Product administration to explicit Variant targets and retries only unresolved targets', () => {
    const operationId = 'commercial-fee-bulk:773';
    const identityFor = (target: typeof firstTarget) => ({
      ...perLineIdentity,
      target: { variantRef: target.variantRef },
    });
    const outcomeIdentityFor = (target: typeof firstTarget, targetId: string) => ({
      operationId,
      snapshotId: snapshot.snapshotId,
      targetId,
      variantTarget: { variantRef: target.variantRef },
    });
    const result = decodeBulkResult({
      operationId,
      outcomes: [
        {
          feeIdentityKey: identityFor(firstTarget),
          feeRef,
          identity: outcomeIdentityFor(firstTarget, 'commercial-fee-target:first'),
          outcome: 'COMMERCIAL_FEE_TARGET_APPLIED',
          revisionId: firstRevisionId,
        },
        {
          feeIdentityKey: identityFor(secondTarget),
          identity: outcomeIdentityFor(secondTarget, 'commercial-fee-target:second'),
          outcome: 'COMMERCIAL_FEE_TARGET_RETRYABLE_FAILURE',
          reason: 'UNKNOWN_COMMIT',
        },
      ],
      snapshot,
    });
    expect(result.snapshot.targets.map(({ target }) => target)).toEqual([firstTarget, secondTarget]);
    expect(
      result.snapshot.targets.some(({ target }) => target.variantRef.resourceId === laterVariantRef.resourceId),
    ).toBe(false);
    expect(
      decodeBulkRetry({
        priorResult: result,
        retryOperationId: 'commercial-fee-bulk:773:retry-1',
        retryTargetIds: ['commercial-fee-target:second'],
      }).retryTargetIds,
    ).toEqual(['commercial-fee-target:second']);
    expect(() =>
      decodeBulkRetry({
        priorResult: result,
        retryOperationId: 'commercial-fee-bulk:773:retry-success',
        retryTargetIds: ['commercial-fee-target:first'],
      }),
    ).toThrow();
    expect(() =>
      decodeBulkResult({
        ...result,
        snapshot: {
          ...snapshot,
          targets: [...snapshot.targets, snapshotEntryFor(laterTarget, 'commercial-fee-target:future')],
        },
      }),
    ).toThrow();
  });
});
