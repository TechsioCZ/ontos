import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import type {
  PricingCommercialFeeCalculationInput,
  ScheduledPricingCommercialFeeRevision,
} from '@app/pricing-contracts/domain/commercial-fee';
import { pricingCommercialFeeCurrentSetPredicateRef } from '@app/pricing-contracts/domain/commercial-fee';
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
const occurrenceId = 'original-fee-line';
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
          ownerRevision: 'catalog-quantity:17',
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-quantity:exact-selection' },
        },
        divisible: false,
        equivalentSelectionKey: 'catalog-selection:exact',
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
        hierarchyRevision: 'catalog-hierarchy:9',
        ownerRevision: 'catalog-quantity:17',
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
  unitQuantity = '1',
}: {
  readonly amount: string;
  readonly basis?: 'FIXED_PER_LINE' | 'FIXED_PER_UNIT';
  readonly family: 'COPYRIGHT_FEE' | 'RECYCLING_FEE';
  readonly feeId: string;
  readonly revisionId: string;
  readonly unitQuantity?: string;
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
          : { kind: 'FIXED_PER_UNIT', unitBasis: { quantity: unitQuantity, unitRef } },
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
  const predicateRef = pricingCommercialFeeCurrentSetPredicateRef(feeSetIdentity);
  return {
    baseLineValue: { amount: '100', currencyCode: 'CZK' },
    currencySupport,
    decision,
    feeSet: {
      ...feeSetIdentity,
      completenessEvidence: {
        observedAt: operationTime,
        ownerRevision: 'commercial-fees:773',
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currentnessEvidence: {
        observedAt: operationTime,
        ownerRevision: 'commercial-fees:773',
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

describe('Pricing Commercial Fee calculation service', () => {
  it.effect('composes different families and includes each Fee exactly once in the Discountable Line Basis', () =>
    Effect.gen(function* composesFees() {
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
          {
            amount: { amount: '20', currencyCode: 'CZK' },
            appliedQuantity: { count: '1', kind: 'LINE' },
            fee: fixedLine,
            occurrenceId,
          },
          {
            amount: { amount: '50', currencyCode: 'CZK' },
            appliedQuantity: { kind: 'QUANTITY', quantity: '10', unitRef },
            fee: fixedUnit,
            occurrenceId,
          },
        ],
        contributionTotal: { amount: '70', currencyCode: 'CZK' },
        discountableLineBasis: { amount: '170', currencyCode: 'CZK' },
        outcome: 'COMMERCIAL_FEES_APPLIED',
      });
      if (result.outcome === 'COMMERCIAL_FEES_APPLIED') {
        expect(result.input.pricePath.source).toBe('PRICE_GROUP_PRICE');
        expect(result.input.quantityTierRevisionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      }
    }),
  );

  it.effect('returns an exact-key conflict without selecting a winner', () =>
    Effect.gen(function* reportsConflict() {
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
          feeRef: { ...first.definition.feeRef, resourceId: '14141414-1414-4141-8141-141414141414' },
          revision: {
            ...first.definition.revision,
            configuredAmount: { amount: '999', currencyCode: 'CZK' },
            revisionId: '15151515-1515-4151-8151-151515151515',
          },
        },
      } satisfies ScheduledPricingCommercialFeeRevision;

      const result = yield* calculatePricingCommercialFees(requestFor([first, second]));

      expect(result).toEqual({
        candidateRevisionIds: ['13131313-1313-4131-8131-131313131313', '15151515-1515-4151-8151-151515151515'],
        identityKey: first.definition.identityKey,
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_CONFLICT',
      });
    }),
  );

  it.effect('omits a valid zero Fee contribution without changing the basis', () =>
    Effect.gen(function* preservesZero() {
      const zero = fee({
        amount: '0',
        family: 'RECYCLING_FEE',
        feeId: '16161616-1616-4161-8161-161616161616',
        revisionId: '17171717-1717-4171-8171-171717171717',
      });

      const result = yield* calculatePricingCommercialFees(requestFor([zero]));

      expect(result).toMatchObject({
        contributions: [],
        contributionTotal: { amount: '0', currencyCode: 'CZK' },
        discountableLineBasis: { amount: '100', currencyCode: 'CZK' },
        outcome: 'COMMERCIAL_FEES_APPLIED',
      });
    }),
  );

  it.effect('accepts an empty set only when exact owner evidence proves absence', () =>
    Effect.gen(function* acceptsProvenAbsence() {
      const result = yield* calculatePricingCommercialFees(requestFor([]));

      expect(result).toMatchObject({
        contributions: [],
        contributionTotal: { amount: '0', currencyCode: 'CZK' },
        discountableLineBasis: { amount: '100', currencyCode: 'CZK' },
        outcome: 'COMMERCIAL_FEES_APPLIED',
      });
    }),
  );

  it.effect('rejects an empty set backed by unrelated generic completeness evidence', () =>
    Effect.gen(function* rejectsUnrelatedEvidence() {
      const request = requestFor([]);
      const result = yield* calculatePricingCommercialFees({
        ...request,
        feeSet: {
          ...request.feeSet,
          completenessEvidence: {
            ...request.feeSet.completenessEvidence,
            scope: { kind: 'EXACT_PREDICATE', predicateRef: 'some-other-owner-predicate' },
          },
        },
      });

      expect(result).toEqual({
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
        reason: 'UNVERIFIABLE_CURRENT_SET',
      });
    }),
  );

  it.effect('rejects an empty set when currentness revalidation names another owner Revision', () =>
    Effect.gen(function* rejectsMismatchedCurrentness() {
      const request = requestFor([]);
      const result = yield* calculatePricingCommercialFees({
        ...request,
        feeSet: {
          ...request.feeSet,
          currentnessEvidence: {
            ...request.feeSet.currentnessEvidence,
            ownerRevision: 'commercial-fees:unrelated-revision',
          },
        },
      });

      expect(result).toEqual({
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
        reason: 'UNVERIFIABLE_CURRENT_SET',
      });
    }),
  );

  it.effect('fails closed when even a zero per-unit Fee uses a different Unit', () =>
    Effect.gen(function* rejectsUnitMismatch() {
      const incompatible = fee({
        amount: '0',
        basis: 'FIXED_PER_UNIT',
        family: 'COPYRIGHT_FEE',
        feeId: '18181818-1818-4181-8181-181818181818',
        revisionId: '19191919-1919-4191-8191-191919191919',
      });
      if (incompatible.definition.identityKey.calculationBasis.kind !== 'FIXED_PER_UNIT') {
        return;
      }
      const mismatched = {
        ...incompatible,
        definition: {
          ...incompatible.definition,
          identityKey: {
            ...incompatible.definition.identityKey,
            calculationBasis: {
              ...incompatible.definition.identityKey.calculationBasis,
              unitBasis: {
                ...incompatible.definition.identityKey.calculationBasis.unitBasis,
                unitRef: {
                  ...unitRef,
                  resourceId: '20202020-2020-4202-8202-202020202020',
                },
              },
            },
          },
        },
      } satisfies ScheduledPricingCommercialFeeRevision;

      const result = yield* calculatePricingCommercialFees(requestFor([mismatched]));

      expect(result).toEqual({
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
        reason: 'QUANTITY_BASIS_MISMATCH',
      });
    }),
  );

  it.effect('fails closed when Current tenant support does not enable the Decision currency', () =>
    Effect.gen(function* rejectsUnsupportedCurrency() {
      const configured = fee({
        amount: '5',
        family: 'COPYRIGHT_FEE',
        feeId: '21212121-2121-4212-8212-212121212121',
        revisionId: '22222222-2222-4222-8222-222222222222',
      });
      const request = requestFor([configured]);

      const result = yield* calculatePricingCommercialFees({
        ...request,
        currencySupport: { ...request.currencySupport, supportedCurrencies: ['EUR'] },
      });

      expect(result).toEqual({
        occurrenceId,
        outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
        reason: 'CURRENCY_UNSUPPORTED',
      });
    }),
  );
});
