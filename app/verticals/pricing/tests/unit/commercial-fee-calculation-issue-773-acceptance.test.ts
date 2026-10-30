import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import type {
  PricingCommercialFeeCalculationInput,
  ScheduledPricingCommercialFeeRevision,
} from '@app/pricing-contracts/domain/commercial-fee';
import {
  PricingCommercialFeeCalculationInputSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
} from '@app/pricing-contracts/domain/commercial-fee';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialFees } from '../../src/services/commercial-fee-calculation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-27T10:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const otherProductRef = {
  ...productRef,
  resourceId: '18181818-1818-4181-8181-181818181818',
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const occurrenceId = 'original-commercial-fee-line:773';
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
};
const decision = Schema.decodeSync(PricingDecisionSchema)({
  commercialScope,
  currencyCode: 'CZK',
  lines: [
    {
      catalog: {
        completeness: {
          observedAt: operationTime,
          ownerRevision: 'catalog-quantity:773',
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-quantity:exact-selection' },
        },
        divisible: false,
        equivalentSelectionKey: 'catalog-selection:issue-773',
        evidence: {
          assessedAt: operationTime,
          basis: [
            { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
            { role: 'VARIANT', source: { resourceRef: variantRef, revision: 2 } },
            {
              provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
              role: 'PRODUCT_TYPE_UNTYPED_DECISION',
              source: { resourceRef: productRef, revision: 1 },
            },
          ],
          membership: {
            attestationId: '66666666-6666-4666-8666-666666666666',
            observedAt: operationTime,
            productRef,
            source: 'CATALOG_OWNER_CURRENT_READ',
            variant: { resourceRef: variantRef, revision: 2 },
          },
          purpose: 'PRICING',
          selection: { productRef, variantRef },
          status: 'VALID',
        },
        hierarchyRevision: 'catalog-hierarchy:773',
        ownerRevision: 'catalog-quantity:773',
        quantity: {
          changed: false,
          notice: null,
          requested: '10',
          resulting: '10',
          rounding: 'HALF_UP',
          status: 'VALID',
          step: '1',
          targetId: variantRef.resourceId,
          tenantId,
          unitId: unitRef.resourceId,
          unitRuleRevision: 7,
        },
        quantityBasis: {
          targetDivisibilityRevision: 3,
          targetRef: variantRef,
          unitRef,
          unitRuleRevision: 7,
        },
        selection: { productRef, variantRef },
        status: 'READY',
        unitRef,
      },
      occurrenceId,
      pricingBasis: { quantity: '10', unitRef },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:773',
      decisionRevision: 'purchase-access-decision-revision:773',
    },
    actor: {
      guestEvidenceRef: 'guest-evidence:773',
      guestSessionRef: 'guest-session:773',
      kind: 'GUEST',
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:773',
      decisionRevision: 'purchase-commercial-settings-revision:773',
    },
    contextRef: 'purchase:773',
    contextRevision: 'purchase:773:1',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:773',
      resolutionRevision: 'purchase-currency-resolution-revision:773',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:773',
      guestSessionRef: 'guest-session:773',
      kind: 'GUEST',
    },
  },
  tenantId,
});

const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const supportVerificationRef = 'pricing:currency-support:proof:773';
const currencySupport = {
  completenessEvidence: {
    observedAt: operationTime,
    ownerRevision: supportRevisionRef.resourceId,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: operationTime,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: operationTime,
    revalidatedAt: '2026-09-27T10:00:01.000Z',
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt: operationTime,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [
    {
      factRef: supportRootRef.resourceId,
      factRevisionRef: supportRevisionRef.resourceId,
      verificationRef: supportVerificationRef,
    },
  ],
  generation: 4,
  observedAt: operationTime,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: 'pricing-currency-support:773',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef: supportVerificationRef,
} satisfies CurrentSupportedCurrenciesSuccess;

const fee = ({
  amount,
  basis = 'FIXED_PER_LINE',
  family,
  feeId,
  revisionId,
}: {
  readonly amount: string;
  readonly basis?: 'FIXED_PER_LINE' | 'FIXED_PER_UNIT';
  readonly family: 'COPYRIGHT_FEE' | 'RECYCLING_FEE';
  readonly feeId: string;
  readonly revisionId: string;
}): ScheduledPricingCommercialFeeRevision => ({
  definition: {
    catalogTargetEvidence: {
      capturedAt: operationTime,
      catalogOwnerRevision: 'catalog-product-targets:773',
      productRef,
      snapshotId: 'pricing-commercial-fee-product-snapshot:773',
      targetId: `pricing-commercial-fee-variant:${variantRef.resourceId}`,
      variantRef,
    },
    feeRef: {
      moduleId: 'commerce.pricing',
      resourceId: feeId,
      resourceType: 'commerce.pricing.commercial-fee',
      tenantId,
    },
    identityKey: {
      calculationBasis:
        basis === 'FIXED_PER_LINE'
          ? { kind: 'FIXED_PER_LINE' }
          : { kind: 'FIXED_PER_UNIT', unitBasis: { quantity: '1', unitRef } },
      commercialScope,
      currencyCode: 'CZK',
      family,
      monetaryBoundary: 'PRE_TAX',
      target: { variantRef },
    },
    revision: {
      configuredAmount: { amount, currencyCode: 'CZK' },
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      revision: 1,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});

const requestFor = (fees: readonly ScheduledPricingCommercialFeeRevision[]): PricingCommercialFeeCalculationInput => {
  const feeSetIdentity = {
    commercialScope,
    currencyCode: 'CZK',
    target: { variantRef },
  } as const;
  const ownerRevision = 'commercial-fees:773';
  const predicateRef = pricingCommercialFeeCurrentSetPredicateRef(feeSetIdentity);
  return {
    baseLineValue: { amount: '100', currencyCode: 'CZK' },
    currencySupport,
    decision,
    feeSet: {
      ...feeSetIdentity,
      completenessEvidence: {
        observedAt: operationTime,
        ownerRevision,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currentnessEvidence: {
        observedAt: operationTime,
        ownerRevision,
        predicateRef,
        revalidatedAt: '2026-09-27T10:00:01.000Z',
        verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
      },
      fees,
      observedAt: operationTime,
    },
    occurrenceId,
    pricePath: {
      priceRef: {
        moduleId: 'commerce.pricing',
        resourceId: '99999999-9999-4999-8999-999999999999',
        resourceType: 'commerce.pricing.price',
        tenantId,
      },
      priceRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: 'PRICE_GROUP_PRICE',
    },
    quantityTierRevisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
};

describe('Issue #773 Pricing Commercial Fee runtime acceptance', () => {
  it.effect('accepts truthful later Fee observation for nonempty and proven empty sets (#1242)', () =>
    Effect.gen(function* latencyIsNotStale() {
      const configured = fee({
        amount: '20',
        family: 'RECYCLING_FEE',
        feeId: '12420000-0000-4000-8000-000000000001',
        revisionId: '12420000-0000-4000-8000-000000000002',
      });
      for (const fees of [[], [configured]]) {
        const original = requestFor(fees);
        const observedAt = '2026-09-27T10:00:00.250Z';
        const input = {
          ...original,
          feeSet: {
            ...original.feeSet,
            completenessEvidence: { ...original.feeSet.completenessEvidence, observedAt },
            currentnessEvidence: { ...original.feeSet.currentnessEvidence, observedAt },
            observedAt,
          },
        };
        const result = yield* calculatePricingCommercialFees(input);
        expect(result).toMatchObject({
          contributionTotal: { amount: fees.length === 0 ? '0' : '20', currencyCode: 'CZK' },
          discountableLineBasis: { amount: fees.length === 0 ? '100' : '120', currencyCode: 'CZK' },
          input: { decision: { operationTime }, feeSet: { observedAt } },
          outcome: 'COMMERCIAL_FEES_APPLIED',
        });
      }
    }),
  );

  it.effect('accepts native-shaped later Currency Support evaluation and preserves stale controls (#1242)', () =>
    Effect.gen(function* nativeCurrencySupportObservation() {
      const request = requestFor([]);
      const observedAt = '2026-09-27T10:00:00.250Z';
      const support = yield* Schema.decodeEffect(CurrentSupportedCurrenciesSuccessSchema)({
        ...request.currencySupport,
        completenessEvidence: { ...request.currencySupport.completenessEvidence, observedAt },
        currentnessEvidence: {
          ...request.currencySupport.currentnessEvidence,
          evaluatedAt: observedAt,
          observedAt,
        },
        observedAt,
      });
      const input = yield* Schema.decodeEffect(PricingCommercialFeeCalculationInputSchema)({
        ...request,
        currencySupport: support,
      });
      expect(yield* calculatePricingCommercialFees(input)).toMatchObject({
        contributionTotal: { amount: '0', currencyCode: 'CZK' },
        input: { currencySupport: { currentnessEvidence: { evaluatedAt: observedAt }, effectiveAt: operationTime } },
        outcome: 'COMMERCIAL_FEES_APPLIED',
      });
      for (const currentnessEvidence of [
        { ...support.currentnessEvidence, evaluatedAt: '2026-09-27T09:59:59.999Z' },
        { ...support.currentnessEvidence, evaluationMode: 'HISTORICAL_AS_OF' as const },
      ]) {
        expect(
          yield* calculatePricingCommercialFees({
            ...input,
            currencySupport: { ...support, currentnessEvidence },
          }),
        ).toMatchObject({ outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED', reason: 'STALE_CURRENT_SET' });
      }
      for (const invalidSupport of [
        { ...support, currentnessEvidence: { ...support.currentnessEvidence, revalidatedAt: operationTime } },
        {
          ...support,
          completenessEvidence: {
            ...support.completenessEvidence,
            nextApplicabilityBoundary: observedAt,
          },
          nextApplicabilityBoundary: observedAt,
        },
      ]) {
        expect(
          yield* calculatePricingCommercialFees({ ...input, currencySupport: invalidSupport }).pipe(Effect.flip),
        ).toMatchObject({ code: 'CALCULATION_REQUEST_INVALID' });
      }
    }),
  );

  it.effect('keeps incoherent observations, effectivity, revalidation and boundary failures typed (#1242)', () =>
    Effect.gen(function* actualStaleControls() {
      const configured = fee({
        amount: '20',
        family: 'RECYCLING_FEE',
        feeId: '12420000-0000-4000-8000-000000000003',
        revisionId: '12420000-0000-4000-8000-000000000004',
      });
      const request = requestFor([configured]);
      const original = request.feeSet;
      const later = '2026-09-27T10:00:00.250Z';
      const currentSet = {
        ...original,
        completenessEvidence: { ...original.completenessEvidence, observedAt: later },
        currentnessEvidence: { ...original.currentnessEvidence, observedAt: later },
        observedAt: later,
      };
      const invalidSets = [
        { ...original, observedAt: '2026-09-27T09:59:59.999Z' },
        { ...currentSet, completenessEvidence: original.completenessEvidence },
        { ...currentSet, currentnessEvidence: original.currentnessEvidence },
        { ...currentSet, currentnessEvidence: { ...currentSet.currentnessEvidence, revalidatedAt: operationTime } },
        {
          ...currentSet,
          completenessEvidence: { ...currentSet.completenessEvidence, nextApplicabilityBoundary: later },
        },
        {
          ...currentSet,
          fees: [{ ...configured, effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.100Z', effectiveTo: null } }],
        },
        {
          ...currentSet,
          fees: [{ ...configured, effectivePeriod: { ...configured.effectivePeriod, effectiveTo: operationTime } }],
        },
      ];
      for (const feeSet of invalidSets) {
        expect(yield* calculatePricingCommercialFees({ ...request, feeSet })).toEqual({
          occurrenceId,
          outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
          reason: 'STALE_CURRENT_SET',
        });
      }
    }),
  );

  it.effect('applies +20 per line and +50 per ten Units once while retaining Price and Tier evidence', () =>
    Effect.gen(function* exactArithmetic() {
      const fixedLine = fee({
        amount: '20',
        family: 'RECYCLING_FEE',
        feeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      });
      const fixedUnit = fee({
        amount: '5',
        basis: 'FIXED_PER_UNIT',
        family: 'COPYRIGHT_FEE',
        feeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        revisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });

      const result = yield* calculatePricingCommercialFees(requestFor([fixedLine, fixedUnit]));

      expect(result).toMatchObject({
        contributions: [
          { amount: { amount: '20', currencyCode: 'CZK' }, appliedQuantity: { count: '1', kind: 'LINE' } },
          {
            amount: { amount: '50', currencyCode: 'CZK' },
            appliedQuantity: { kind: 'QUANTITY', quantity: '10', unitRef },
          },
        ],
        contributionTotal: { amount: '70', currencyCode: 'CZK' },
        discountableLineBasis: { amount: '170', currencyCode: 'CZK' },
        outcome: 'COMMERCIAL_FEES_APPLIED',
      });
      if (result.outcome !== 'COMMERCIAL_FEES_APPLIED') {
        throw new Error('Expected applied Commercial Fees');
      }
      expect(result.input.pricePath.source).toBe('PRICE_GROUP_PRICE');
      expect(result.input.quantityTierRevisionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      expect(result.contributions.every((contribution) => contribution.occurrenceId === occurrenceId)).toBe(true);
    }),
  );

  it.effect('returns typed conflict for two competing same-family exact-key truths', () =>
    Effect.gen(function* exactConflict() {
      const first = fee({
        amount: '1',
        family: 'RECYCLING_FEE',
        feeId: '12121212-1212-4121-8121-121212121212',
        revisionId: '13131313-1313-4131-8131-131313131313',
      });
      const second = {
        ...first,
        definition: {
          ...first.definition,
          catalogTargetEvidence: {
            ...first.definition.catalogTargetEvidence,
            productRef: otherProductRef,
          },
          feeRef: { ...first.definition.feeRef, resourceId: '14141414-1414-4141-8141-141414141414' },
          revision: {
            ...first.definition.revision,
            configuredAmount: { amount: '999', currencyCode: 'CZK' },
            revisionId: '15151515-1515-4151-8151-151515151515',
          },
        },
      } satisfies ScheduledPricingCommercialFeeRevision;

      const result = yield* calculatePricingCommercialFees(requestFor([first, second]));

      expect(result).toMatchObject({
        candidateRevisionIds: ['13131313-1313-4131-8131-131313131313', '15151515-1515-4151-8151-151515151515'],
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_CONFLICT',
      });
      expect(second.definition.identityKey).toEqual(first.definition.identityKey);
      expect(second.definition.catalogTargetEvidence.productRef).not.toEqual(
        first.definition.catalogTargetEvidence.productRef,
      );
    }),
  );

  it.effect('accepts exact proven absence and rejects unrelated predicate or owner-revision evidence', () =>
    Effect.gen(function* exactAbsenceOnly() {
      const request = requestFor([]);
      const exactAbsence = yield* calculatePricingCommercialFees(request);
      expect(exactAbsence).toMatchObject({
        contributions: [],
        contributionTotal: { amount: '0', currencyCode: 'CZK' },
        discountableLineBasis: { amount: '100', currencyCode: 'CZK' },
        outcome: 'COMMERCIAL_FEES_APPLIED',
      });

      const unrelated = yield* calculatePricingCommercialFees({
        ...request,
        feeSet: {
          ...request.feeSet,
          completenessEvidence: {
            ...request.feeSet.completenessEvidence,
            ownerRevision: 'unrelated-owner-revision',
            scope: { kind: 'EXACT_PREDICATE', predicateRef: 'some-other-owner-predicate' },
          },
        },
      });
      expect(unrelated).toEqual({
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
        reason: 'UNVERIFIABLE_CURRENT_SET',
      });
    }),
  );

  it.effect('never treats generalized EUR contracts as Launch currency support', () =>
    Effect.gen(function* failClosedBoundaries() {
      const configured = fee({
        amount: '5',
        family: 'COPYRIGHT_FEE',
        feeId: '16161616-1616-4161-8161-161616161616',
        revisionId: '17171717-1717-4171-8171-171717171717',
      });
      const request = requestFor([configured]);
      const unsupported = yield* calculatePricingCommercialFees({
        ...request,
        currencySupport: { ...request.currencySupport, supportedCurrencies: ['EUR'] },
      });
      expect(unsupported).toEqual({
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
        reason: 'CURRENCY_UNSUPPORTED',
      });
    }),
  );
});
