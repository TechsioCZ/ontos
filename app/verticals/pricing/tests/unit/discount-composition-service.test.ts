import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import type {
  PricingDiscountCompositionCandidate,
  PricingDiscountCompositionRequest,
} from '@app/pricing-contracts/domain/discount-composition';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountCompositionRejected,
  composePricingDiscounts,
} from '../../src/services/discount-composition.service.ts';

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
const selection = { productRef, variantRef };
const occurrenceId = 'original-merchandise-line';
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
};
const decision = Schema.decodeSync(PricingDecisionSchema)({
  commercialScope,
  currencyCode: 'CZK' as const,
  lines: [
    {
      catalog: {
        completeness: {
          observedAt: operationTime,
          ownerRevision: 'catalog-quantity:17',
          scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
        },
        divisible: false,
        equivalentSelectionKey: 'catalog-selection:exact',
        evidence: {
          assessedAt: operationTime,
          basis: [
            { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
            { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
            {
              provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
              role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
              source: { resourceRef: productRef, revision: 1 },
            },
          ],
          membership: {
            attestationId: '66666666-6666-4666-8666-666666666666',
            observedAt: operationTime,
            productRef,
            source: 'CATALOG_OWNER_CURRENT_READ' as const,
            variant: { resourceRef: variantRef, revision: 2 },
          },
          purpose: 'PRICING' as const,
          selection,
          status: 'VALID' as const,
        },
        hierarchyRevision: 'catalog-hierarchy:9',
        ownerRevision: 'catalog-quantity:17',
        quantity: {
          changed: false,
          notice: null,
          requested: '5',
          resulting: '5',
          rounding: 'HALF_UP' as const,
          status: 'VALID' as const,
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
        selection,
        status: 'READY' as const,
        unitRef,
      },
      occurrenceId,
      pricingBasis: { quantity: '5', unitRef },
    },
  ],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:772',
      decisionRevision: 'purchase-access-decision-revision:772',
    },
    actor: {
      guestEvidenceRef: 'guest-evidence:772',
      guestSessionRef: 'guest-session:772',
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:772',
      decisionRevision: 'purchase-commercial-settings-revision:772',
    },
    contextRef: 'purchase:772',
    contextRevision: 'purchase:772:1',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:772',
      resolutionRevision: 'purchase-currency-resolution-revision:772',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:772',
      guestSessionRef: 'guest-session:772',
      kind: 'GUEST' as const,
    },
  },
  tenantId,
});

const supportRootId = '77777777-7777-4777-8777-777777777777';
const supportRevisionId = '88888888-8888-4888-8888-888888888888';
const supportVerificationRef = 'currency-support-owner-proof:discount-composition:772';
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
const currencySupport = {
  completenessEvidence: {
    observedAt: operationTime,
    ownerRevision: supportRevisionId,
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
      factRef: supportRootId,
      factRevisionRef: supportRevisionId,
      verificationRef: supportVerificationRef,
    },
  ],
  generation: 4,
  observedAt: operationTime,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: 'pricing-currency-support:772',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef: supportVerificationRef,
} satisfies CurrentSupportedCurrenciesSuccess;

const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const basePricePath = {
  kind: 'PRICE_GROUP_PRICE' as const,
  priceGroupRef,
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  priceRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const makeLineCandidate = ({
  discountId,
  effect,
  revisionId,
}: {
  readonly discountId: string;
  readonly effect:
    | { readonly kind: 'PERCENTAGE'; readonly level: string }
    | {
        readonly kind: 'FIXED_MONETARY_AMOUNT';
        readonly level: { readonly amount: string; readonly currencyCode: string };
      };
  readonly revisionId: string;
}): Extract<PricingDiscountCompositionCandidate, { readonly kind: 'VARIANT_LINE' }> => {
  const identityKey = {
    audience: { counterpartyRef, kind: 'COUNTERPARTY' as const },
    basis: {
      catalogSelection: selection,
      kind: 'VARIANT_LINE' as const,
      unitBasis: { quantity: '5', unitRef },
    },
    commercialScope,
    currencyCode: 'CZK',
    effectKind: effect.kind,
    family: 'CONTRACTUAL_DISCOUNT' as const,
    monetaryBoundary: 'PRE_TAX' as const,
    scope: 'VARIANT_LINE' as const,
  };
  const definition = {
    discountId,
    identityKey,
    revision: { configuredEffect: effect, effectiveFrom: '2026-09-01T00:00:00.000Z', revision: 1, revisionId },
  };
  return {
    applicationCount: 'ONCE_PER_STABLE_LINE',
    audienceBinding: {
      applicabilityBasis: { basis: identityKey.basis, commercialScope, currencyCode: 'CZK', observedAt: operationTime },
      basePricePath,
      evidence: {
        audience: identityKey.audience,
        kind: 'COUNTERPARTY_OWNER_EVIDENCE',
        observedAt: operationTime,
        ownerRevision: 'party-registry:772',
        source: 'PARTY_REGISTRY',
      },
      identityKey,
    },
    definition,
    kind: 'VARIANT_LINE',
    layer: 'COUNTERPARTY_CONTRACTUAL',
    occurrenceId,
    outcome: 'DISCOUNT_APPLICABLE',
  };
};

const makeWholePurchaseCandidate = (): Extract<
  PricingDiscountCompositionCandidate,
  { readonly kind: 'WHOLE_PURCHASE' }
> => {
  const identityKey = {
    audience: { counterpartyRef, kind: 'COUNTERPARTY' as const },
    basis: { kind: 'WHOLE_PURCHASE' as const },
    commercialScope,
    currencyCode: 'CZK',
    effectKind: 'FIXED_MONETARY_AMOUNT' as const,
    family: 'CONTRACTUAL_DISCOUNT' as const,
    monetaryBoundary: 'PRE_TAX' as const,
    scope: 'WHOLE_PURCHASE' as const,
  };
  const definition = {
    discountId: '17171717-1717-4171-8171-171717171717',
    identityKey,
    revision: {
      configuredEffect: {
        kind: 'FIXED_MONETARY_AMOUNT' as const,
        level: { amount: '100', currencyCode: 'CZK' },
      },
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      revision: 1,
      revisionId: '18181818-1818-4181-8181-181818181818',
    },
  };
  const audienceBinding = {
    applicabilityBasis: { basis: identityKey.basis, commercialScope, currencyCode: 'CZK', observedAt: operationTime },
    basePricePath,
    evidence: {
      audience: identityKey.audience,
      kind: 'COUNTERPARTY_OWNER_EVIDENCE' as const,
      observedAt: operationTime,
      ownerRevision: 'party-registry:772',
      source: 'PARTY_REGISTRY' as const,
    },
    identityKey,
  };
  return {
    applicability: {
      basis: {
        currencyCode: 'CZK',
        eligibleAmount: '820',
        recipients: [
          {
            intermediateValue: { amount: '820', currencyCode: 'CZK' },
            occurrenceId,
            recipientKind: 'MERCHANDISE',
          },
        ],
      },
      contribution: { amount: '-100', currencyCode: 'CZK' },
      definition,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
    },
    applicationCount: 'ONCE_PER_PRICING_DECISION',
    audienceBinding,
    decision,
    definition,
    kind: 'WHOLE_PURCHASE',
    layer: 'COUNTERPARTY_WHOLE_PURCHASE',
    outcome: 'DISCOUNT_APPLICABLE',
  };
};

const requestFor = (candidates: readonly PricingDiscountCompositionCandidate[]): PricingDiscountCompositionRequest => {
  const wholePurchaseCandidate = candidates.find((candidate) => candidate.kind === 'WHOLE_PURCHASE');
  const request = {
    candidates,
    currencySupport,
    decision,
    lineBases: [
      {
        amount: { amount: '1000', currencyCode: 'CZK' },
        applicablePricingFeeTotal: { amount: '100', currencyCode: 'CZK' },
        baseLineValue: { amount: '900', currencyCode: 'CZK' },
        occurrenceId,
      },
    ],
  };
  return wholePurchaseCandidate?.applicability.outcome === 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE'
    ? { ...request, wholePurchaseBasis: wholePurchaseCandidate.applicability.basis }
    : request;
};

describe('Pricing Discount composition service', () => {
  it.effect('applies the same Discount revision once to each distinct stable occurrence', () =>
    Effect.gen(function* composesDistinctOccurrences() {
      const firstCandidate = makeLineCandidate({
        discountId: '19191919-1919-4191-8191-191919191919',
        effect: { kind: 'PERCENTAGE', level: '10' },
        revisionId: '20202020-2020-4202-8202-202020202020',
      });
      const secondOccurrenceId = 'second-original-merchandise-line';
      const secondCandidate = { ...firstCandidate, occurrenceId: secondOccurrenceId };
      const [firstDecisionLine] = decision.lines;
      if (firstDecisionLine === undefined) {
        return yield* Effect.die(new Error('Discount composition fixture requires one decision line'));
      }
      const twoLineDecision = yield* Schema.decodeEffect(PricingDecisionSchema)({
        ...decision,
        lines: [firstDecisionLine, { ...firstDecisionLine, occurrenceId: secondOccurrenceId }],
      });
      const request: PricingDiscountCompositionRequest = {
        candidates: [firstCandidate, secondCandidate],
        currencySupport,
        decision: twoLineDecision,
        lineBases: [
          {
            amount: { amount: '1000', currencyCode: 'CZK' },
            applicablePricingFeeTotal: { amount: '100', currencyCode: 'CZK' },
            baseLineValue: { amount: '900', currencyCode: 'CZK' },
            occurrenceId,
          },
          {
            amount: { amount: '500', currencyCode: 'CZK' },
            applicablePricingFeeTotal: { amount: '0', currencyCode: 'CZK' },
            baseLineValue: { amount: '500', currencyCode: 'CZK' },
            occurrenceId: secondOccurrenceId,
          },
        ],
      };

      const result = yield* composePricingDiscounts(request);

      expect(result).toMatchObject({
        lineContributions: [
          { amount: { amount: '-100' }, candidate: { occurrenceId } },
          { amount: { amount: '-50' }, candidate: { occurrenceId: secondOccurrenceId } },
        ],
        outcome: 'DISCOUNT_COMPOSITION_READY',
      });
      return yield* Effect.void;
    }),
  );

  it.effect('calculates a percentage independently from the fee-inclusive line basis', () =>
    Effect.gen(function* composesPercentage() {
      const candidate = makeLineCandidate({
        discountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        effect: { kind: 'PERCENTAGE', level: '3' },
        revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      });

      const result = yield* composePricingDiscounts(requestFor([candidate]));

      expect(result).toMatchObject({
        lineContributions: [
          {
            amount: { amount: '-30', currencyCode: 'CZK' },
            applicationCount: 'ONCE_PER_STABLE_LINE',
            basis: { amount: { amount: '1000', currencyCode: 'CZK' } },
            candidate: { audienceBinding: { basePricePath: { kind: 'PRICE_GROUP_PRICE' } } },
          },
        ],
        outcome: 'DISCOUNT_COMPOSITION_READY',
      });
    }),
  );

  it.effect('applies a fixed line effect once despite quantity five', () =>
    Effect.gen(function* composesFixedOnce() {
      const candidate = makeLineCandidate({
        discountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        effect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '100', currencyCode: 'CZK' } },
        revisionId: '10101010-1010-4101-8101-101010101010',
      });

      const result = yield* composePricingDiscounts(requestFor([candidate]));

      expect(result).toMatchObject({
        lineContributions: [{ amount: { amount: '-100' }, applicationCount: 'ONCE_PER_STABLE_LINE' }],
        outcome: 'DISCOUNT_COMPOSITION_READY',
      });
      expect(result.request.decision.lines[0]?.pricingBasis.quantity).toBe('5');
    }),
  );

  it.effect('returns a typed same-layer conflict without choosing by value, effect kind, or ordering', () =>
    Effect.gen(function* rejectsCardinalityCollision() {
      const percentage = makeLineCandidate({
        discountId: '11111111-2222-4333-8444-555555555555',
        effect: { kind: 'PERCENTAGE', level: '99' },
        revisionId: '12121212-1212-4121-8121-121212121212',
      });
      const fixed = makeLineCandidate({
        discountId: '13131313-1313-4131-8131-131313131313',
        effect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '1', currencyCode: 'CZK' } },
        revisionId: '14141414-1414-4141-8141-141414141414',
      });

      const result = yield* composePricingDiscounts(requestFor([fixed, percentage]));

      expect(result).toMatchObject({
        conflict: {
          claimants: [fixed, percentage],
          conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
          path: { kind: 'VARIANT_LINE_LAYER', layer: 'COUNTERPARTY_CONTRACTUAL', occurrenceId },
        },
        outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
      });
      expect(result).not.toHaveProperty('lineContributions');
    }),
  );

  it.effect('keeps repeated same-path evidence as a conflict instead of deduplicating it into a winner', () =>
    Effect.gen(function* preservesRepeatedEvidence() {
      const candidate = makeLineCandidate({
        discountId: '21212121-2121-4212-8212-212121212121',
        effect: { kind: 'PERCENTAGE', level: '5' },
        revisionId: '22222222-aaaa-4222-8222-222222222222',
      });

      const result = yield* composePricingDiscounts(requestFor([candidate, candidate]));

      expect(result).toMatchObject({
        conflict: {
          claimants: [candidate, candidate],
          conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
          path: { kind: 'VARIANT_LINE_LAYER', layer: 'COUNTERPARTY_CONTRACTUAL', occurrenceId },
        },
        outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
      });
    }),
  );

  it.effect('emits the already-proven whole-purchase contribution once without allocating it', () =>
    Effect.gen(function* composesWholePurchaseOnce() {
      const wholePurchase = makeWholePurchaseCandidate();

      const result = yield* composePricingDiscounts(requestFor([wholePurchase]));

      expect(result).toMatchObject({
        lineContributions: [],
        outcome: 'DISCOUNT_COMPOSITION_READY',
        wholePurchaseContribution: {
          amount: { amount: '-100', currencyCode: 'CZK' },
          applicationCount: 'ONCE_PER_PRICING_DECISION',
          candidate: wholePurchase,
        },
      });
      expect(result).not.toHaveProperty('allocations');
      if (result.outcome !== 'DISCOUNT_COMPOSITION_READY') {
        return;
      }
      if (result.wholePurchaseContribution !== undefined) {
        expect(result.wholePurchaseContribution).not.toHaveProperty('allocations');
      }
    }),
  );

  it.effect('rejects replayed whole-purchase proof when the declared exact basis differs', () =>
    Effect.gen(function* rejectsReplayedWholePurchaseProof() {
      const wholePurchase = makeWholePurchaseCandidate();
      const request = requestFor([wholePurchase]);
      const replayed: PricingDiscountCompositionRequest = {
        ...request,
        wholePurchaseBasis: {
          currencyCode: 'CZK',
          eligibleAmount: '819',
          recipients: [
            {
              intermediateValue: { amount: '819', currencyCode: 'CZK' },
              occurrenceId,
              recipientKind: 'MERCHANDISE',
            },
          ],
        },
      };

      const rejected = yield* Effect.flip(composePricingDiscounts(replayed));

      expect(rejected).toMatchObject({ code: 'COMPOSITION_REQUEST_INVALID' });
    }),
  );

  it.effect('fails closed when exact Current tenant support does not enable the Decision currency', () =>
    Effect.gen(function* rejectsUnsupportedCurrency() {
      const candidate = makeLineCandidate({
        discountId: '15151515-1515-4151-8151-151515151515',
        effect: { kind: 'PERCENTAGE', level: '5' },
        revisionId: '16161616-1616-4161-8161-161616161616',
      });
      const invalid: PricingDiscountCompositionRequest = {
        ...requestFor([candidate]),
        currencySupport: { ...currencySupport, supportedCurrencies: ['EUR'] },
      };

      const rejected = yield* Effect.flip(composePricingDiscounts(invalid));

      expect(rejected).toBeInstanceOf(PricingDiscountCompositionRejected);
      expect(rejected).toMatchObject({ code: 'COMPOSITION_REQUEST_INVALID' });
    }),
  );
});
