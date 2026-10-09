import type {
  PricingDiscountAudienceEvidenceBinding,
  PricingDiscountCurrentResolution,
} from '@app/pricing-contracts/domain/discount';
import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountApplicabilityRejected,
  interpretPricingDiscountApplicability,
} from '../../src/services/discount-applicability.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const observedAt = '2026-09-27T10:00:00.000Z';
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
const variantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const unitRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.product-unit');
const catalogSelection = { productRef, variantRef };
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const counterpartyAudience = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
};
const noGroupPricePath = {
  kind: 'NO_GROUP_PRICE' as const,
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  priceRevisionId: '99999999-9999-4999-8999-999999999999',
};
const supportObservedAt = '2026-09-27T10:00:01.000Z';
const supportRootId = '14141414-1414-4141-8141-141414141414';
const supportRevisionId = '15151515-1515-4151-8151-151515151515';
const supportVerificationRef = 'pricing:currency-support:owner-proof:771';
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
};
const launchCurrencySupport = {
  completenessEvidence: {
    observedAt: supportObservedAt,
    ownerRevision: supportRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: observedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: supportObservedAt,
    revalidatedAt: '2026-09-27T10:00:02.000Z',
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt: observedAt,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [
    {
      factRef: supportRootId,
      factRevisionRef: supportRevisionId,
      verificationRef: supportVerificationRef,
    },
  ],
  generation: 4,
  observedAt: supportObservedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: 'pricing-currency-support:771',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef: supportVerificationRef,
} satisfies CurrentSupportedCurrenciesSuccess;

const groupIdentity = {
  audience: { kind: 'PRICE_GROUP' as const, priceGroupRef },
  basis: {
    catalogSelection,
    kind: 'VARIANT_LINE' as const,
    unitBasis: { quantity: '1', unitRef },
  },
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'PERCENTAGE' as const,
  family: 'CONTRACTUAL_DISCOUNT' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  scope: 'VARIANT_LINE' as const,
};
const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: observedAt,
  verifiedAt: '2026-09-27T10:00:01.000Z',
} as const;
const assignmentResolution = {
  _tag: 'ASSIGNED' as const,
  assignmentRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.customer-context.customer-price-group-assignment' as const,
    tenantId,
  },
  assignmentRevision: 3,
  compatibility: compatibilityEvidence,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  priceGroupRef,
};
const groupBinding = {
  applicabilityBasis: {
    basis: groupIdentity.basis,
    commercialScope,
    currencyCode: 'CZK',
    observedAt,
  },
  basePricePath: noGroupPricePath,
  evidence: {
    audience: groupIdentity.audience,
    interpretation: {
      _tag: 'ASSIGNED' as const,
      assignmentResolution,
      basis: {
        catalogSelection,
        commercialScope,
        currencyCode: 'CZK',
        unitBasis: { quantity: '1', unitRef },
      },
      compatibilityEvidence,
      discountAudience: groupIdentity.audience,
      priceGroupRef,
      priceSelector: { kind: 'PRICE_GROUP' as const, priceGroupRef },
    },
    kind: 'PRICE_GROUP_OWNER_EVIDENCE' as const,
  },
  identityKey: groupIdentity,
} satisfies PricingDiscountAudienceEvidenceBinding;

const groupScheduledRevision = {
  definition: {
    discountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    identityKey: groupIdentity,
    revision: {
      configuredEffect: { kind: 'PERCENTAGE' as const, level: '10' },
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      revision: 1,
      revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
};

const groupCurrent = {
  observedAt,
  outcome: 'DISCOUNT_CURRENT' as const,
  revision: groupScheduledRevision,
} satisfies PricingDiscountCurrentResolution;

const wholeIdentity = {
  audience: counterpartyAudience,
  basis: { kind: 'WHOLE_PURCHASE' as const },
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'FIXED_MONETARY_AMOUNT' as const,
  family: 'CONTRACTUAL_DISCOUNT' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  scope: 'WHOLE_PURCHASE' as const,
};
const wholeBinding = {
  applicabilityBasis: {
    basis: wholeIdentity.basis,
    commercialScope,
    currencyCode: 'CZK',
    observedAt,
  },
  basePricePath: noGroupPricePath,
  evidence: {
    audience: counterpartyAudience,
    kind: 'COUNTERPARTY_OWNER_EVIDENCE' as const,
    observedAt,
    ownerRevision: 'party-registry:counterparty:771',
    source: 'PARTY_REGISTRY' as const,
  },
  identityKey: wholeIdentity,
} satisfies PricingDiscountAudienceEvidenceBinding;
const wholeScheduledRevision = {
  definition: {
    discountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    identityKey: wholeIdentity,
    revision: {
      configuredEffect: {
        kind: 'FIXED_MONETARY_AMOUNT' as const,
        level: { amount: '100', currencyCode: 'CZK' },
      },
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      revision: 1,
      revisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
};
const wholeCurrent = {
  observedAt,
  outcome: 'DISCOUNT_CURRENT' as const,
  revision: wholeScheduledRevision,
} satisfies PricingDiscountCurrentResolution;
const eurWholeIdentity = { ...wholeIdentity, currencyCode: 'EUR' };
const eurWholeBinding = {
  ...wholeBinding,
  applicabilityBasis: { ...wholeBinding.applicabilityBasis, currencyCode: 'EUR' },
  identityKey: eurWholeIdentity,
} satisfies PricingDiscountAudienceEvidenceBinding;
const eurWholeCurrent = {
  ...wholeCurrent,
  revision: {
    ...wholeCurrent.revision,
    definition: {
      ...wholeCurrent.revision.definition,
      identityKey: eurWholeIdentity,
      revision: {
        ...wholeCurrent.revision.definition.revision,
        configuredEffect: {
          kind: 'FIXED_MONETARY_AMOUNT' as const,
          level: { amount: '100', currencyCode: 'EUR' },
        },
      },
    },
  },
} satisfies PricingDiscountCurrentResolution;

describe('Issue #771 Pricing Discount applicability runtime acceptance', () => {
  it.effect('retains proven Group audience when the actual base Price path is NO_GROUP_PRICE', () =>
    Effect.gen(function* retainsIndependentAudience() {
      const result = yield* interpretPricingDiscountApplicability({
        audienceBinding: groupBinding,
        currencySupport: launchCurrencySupport,
        currentResolution: groupCurrent,
      });

      expect(result).toMatchObject({
        applicationCount: 'ONCE_PER_STABLE_LINE',
        basePricePath: { kind: 'NO_GROUP_PRICE' },
        evidence: {
          audience: { kind: 'PRICE_GROUP', priceGroupRef },
          kind: 'PRICE_GROUP_OWNER_EVIDENCE',
        },
        outcome: 'DISCOUNT_APPLICABLE',
      });
      if (result.outcome !== 'DISCOUNT_APPLICABLE') {
        throw new Error('fixture must resolve as applicable');
      }
      expect(result.definition.identityKey.audience).toEqual(groupIdentity.audience);
    }),
  );

  it.effect('returns conflicts explicitly and rejects Current evidence from another observation', () =>
    Effect.gen(function* preservesCurrentnessEvidence() {
      const conflict = yield* interpretPricingDiscountApplicability({
        audienceBinding: groupBinding,
        currencySupport: launchCurrencySupport,
        currentResolution: {
          candidateRevisionIds: [
            groupScheduledRevision.definition.revision.revisionId,
            '10101010-1010-4101-8101-101010101010',
          ],
          identityKey: groupIdentity,
          observedAt,
          outcome: 'DISCOUNT_CURRENT_CONFLICT',
        },
      });
      expect(conflict.outcome).toBe('DISCOUNT_CONFLICT');

      const rejected = yield* Effect.flip(
        interpretPricingDiscountApplicability({
          audienceBinding: groupBinding,
          currencySupport: launchCurrencySupport,
          currentResolution: { ...groupCurrent, observedAt: '2026-09-27T10:00:01.000Z' },
        }),
      );
      expect(rejected).toBeInstanceOf(PricingDiscountApplicabilityRejected);
      expect(rejected).toMatchObject({ code: 'CURRENT_RESOLUTION_MISMATCH' });
    }),
  );

  it.effect('decodes generalized EUR facts but activates only exact Current tenant-supported currency', () =>
    Effect.gen(function* enforcesTenantCurrencySupport() {
      const unsupported = yield* Effect.flip(
        interpretPricingDiscountApplicability({
          audienceBinding: eurWholeBinding,
          currencySupport: launchCurrencySupport,
          currentResolution: eurWholeCurrent,
        }),
      );
      expect(unsupported).toMatchObject({ code: 'CURRENCY_UNSUPPORTED' });

      const incomplete = yield* Effect.flip(
        interpretPricingDiscountApplicability({
          audienceBinding: groupBinding,
          currencySupport: {
            ...launchCurrencySupport,
            completenessEvidence: {
              ...launchCurrencySupport.completenessEvidence,
              ownerRevision: '16161616-1616-4161-8161-161616161616',
            },
          },
          currentResolution: groupCurrent,
        }),
      );
      expect(incomplete).toMatchObject({ code: 'CURRENCY_SUPPORT_INVALID' });

      const foreignTenantId = '17171717-1717-4171-8171-171717171717';
      const foreignSupportRootRef = { ...supportRootRef, tenantId: foreignTenantId };
      const foreignSupportRevisionRef = {
        ...supportRevisionRef,
        tenantId: foreignTenantId,
      };
      const foreignVerificationRef = 'pricing:currency-support:foreign-owner-proof:771';
      const mismatched = yield* Effect.flip(
        interpretPricingDiscountApplicability({
          audienceBinding: groupBinding,
          currencySupport: {
            ...launchCurrencySupport,
            completenessEvidence: {
              ...launchCurrencySupport.completenessEvidence,
              scope: {
                kind: 'EXACT_PREDICATE',
                predicateRef: `commerce.pricing.current-supported-currencies:${foreignTenantId}`,
              },
            },
            currentnessEvidence: {
              ...launchCurrencySupport.currentnessEvidence,
              supportRevisionRef: foreignSupportRevisionRef,
              supportRootRef: foreignSupportRootRef,
            },
            factProofs: [
              {
                factRef: foreignSupportRootRef.resourceId,
                factRevisionRef: foreignSupportRevisionRef.resourceId,
                verificationRef: foreignVerificationRef,
              },
            ],
            supportRevisionRef: foreignSupportRevisionRef,
            supportRootRef: foreignSupportRootRef,
            tenantId: foreignTenantId,
            verificationRef: foreignVerificationRef,
          },
          currentResolution: groupCurrent,
        }),
      );
      expect(mismatched).toMatchObject({ code: 'CURRENCY_SUPPORT_MISMATCH' });
    }),
  );

  it.effect(
    'uses exact generalized currency, filters non-positive and non-merchandise lines, and never allocates',
    () =>
      Effect.gen(function* evaluatesWholePurchase() {
        const applicable = yield* interpretPricingDiscountApplicability({
          audienceBinding: wholeBinding,
          currencySupport: launchCurrencySupport,
          currentResolution: wholeCurrent,
          wholePurchaseIntermediates: [
            {
              amount: { amount: '0', currencyCode: 'CZK' },
              occurrenceId: 'pricing-line:zero',
              recipientKind: 'MERCHANDISE',
            },
            {
              amount: { amount: '-5', currencyCode: 'CZK' },
              occurrenceId: 'pricing-line:negative',
              recipientKind: 'MERCHANDISE',
            },
            {
              amount: { amount: '999', currencyCode: 'CZK' },
              occurrenceId: 'pricing-line:shipping',
              recipientKind: 'SHIPPING',
            },
            {
              amount: { amount: '100.01', currencyCode: 'CZK' },
              occurrenceId: 'pricing-line:eligible',
              recipientKind: 'MERCHANDISE',
            },
          ],
        });
        expect(applicable).toMatchObject({
          applicability: {
            basis: {
              currencyCode: 'CZK',
              eligibleAmount: '100.01',
              recipients: [{ occurrenceId: 'pricing-line:eligible' }],
            },
            contribution: { amount: '-100', currencyCode: 'CZK' },
            outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
          },
          applicationCount: 'ONCE_PER_PRICING_DECISION',
          outcome: 'DISCOUNT_APPLICABLE',
        });
        expect('allocations' in applicable).toBe(false);

        const equal = yield* interpretPricingDiscountApplicability({
          audienceBinding: wholeBinding,
          currencySupport: launchCurrencySupport,
          currentResolution: wholeCurrent,
          wholePurchaseIntermediates: [
            {
              amount: { amount: '100', currencyCode: 'CZK' },
              occurrenceId: 'pricing-line:equal',
              recipientKind: 'MERCHANDISE',
            },
          ],
        });
        expect(equal.outcome).toBe('DISCOUNT_NOT_APPLICABLE');

        const currencyRejected = yield* Effect.flip(
          interpretPricingDiscountApplicability({
            audienceBinding: wholeBinding,
            currencySupport: launchCurrencySupport,
            currentResolution: wholeCurrent,
            wholePurchaseIntermediates: [
              {
                amount: { amount: '101', currencyCode: 'EUR' },
                occurrenceId: 'pricing-line:foreign-currency',
                recipientKind: 'MERCHANDISE',
              },
            ],
          }),
        );
        expect(currencyRejected).toMatchObject({ code: 'CURRENCY_MISMATCH' });
      }),
  );
});
