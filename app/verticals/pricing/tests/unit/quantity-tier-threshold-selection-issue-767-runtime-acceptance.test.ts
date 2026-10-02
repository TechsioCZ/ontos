import { QuantityTierSelectionInputSchema } from '@app/pricing-contracts/domain/quantity-tier';
import type { QuantityTierSelectionInput } from '@app/pricing-contracts/domain/quantity-tier';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { selectQuantityTier } from '../../src/services/quantity-tier-selection.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const otherVariantRef = {
  ...variantRef,
  resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const packageOptionRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  resourceType: 'commerce.catalog.package-definition' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const quantityBasis = {
  catalogQuantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 5,
  },
  priceUnitBasis: { quantity: '1', unitRef },
};
const quantityBasisFor = (targetRef: typeof otherVariantRef | typeof packageOptionRef) => ({
  ...quantityBasis,
  catalogQuantityBasis: { ...quantityBasis.catalogQuantityBasis, targetRef },
});
const variantCatalogSelection = { productRef, variantRef };
const packageCatalogSelection = {
  ...variantCatalogSelection,
  packageOption: {
    contentRevision: { resourceRef: packageOptionRef, revision: 5 },
    optionRef: packageOptionRef,
  },
};
const evaluatedAt = '2026-09-27T12:00:00.000Z';
const effectiveFrom = '2026-09-01T00:00:00.000Z';

const tierRevisionIds = {
  duplicate: '99999999-9999-4999-8999-999999999999',
  ten: '77777777-7777-4777-8777-777777777777',
  twenty: '88888888-8888-4888-8888-888888888888',
} as const;

const tier = ({
  amount,
  basis = quantityBasis,
  currencyCode = 'CZK',
  owningPriceRef = priceRef,
  revisionId,
  thresholdQuantity,
}: {
  readonly amount: string;
  readonly basis?: ReturnType<typeof quantityBasisFor> | typeof quantityBasis;
  readonly currencyCode?: 'CZK' | 'EUR';
  readonly owningPriceRef?: typeof priceRef;
  readonly revisionId: string;
  readonly thresholdQuantity: string;
}) => ({
  definition: {
    identityKey: { priceRef: owningPriceRef, quantityBasis: basis, thresholdQuantity },
    revision: {
      effectiveFrom,
      monetaryBoundary: 'PRE_TAX' as const,
      resultingUnitPrice: { amount, currencyCode },
      revision: 1,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom, effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
});

const tier10 = tier({ amount: '90', revisionId: tierRevisionIds.ten, thresholdQuantity: '10' });
const tier20 = tier({ amount: '80', revisionId: tierRevisionIds.twenty, thresholdQuantity: '20' });
const tierVerificationRef = 'commerce.pricing.quantity-tier-set-proof:767-runtime';

const makeInput = ({
  basis = quantityBasis,
  catalogSelection = variantCatalogSelection,
  nextApplicabilityBoundary = '2026-10-01T00:00:00.000Z',
  quantity,
  tiers = [tier20, tier10],
}: {
  readonly basis?: ReturnType<typeof quantityBasisFor> | typeof quantityBasis;
  readonly catalogSelection?: typeof packageCatalogSelection | typeof variantCatalogSelection;
  readonly nextApplicabilityBoundary?: string;
  readonly quantity: string;
  readonly tiers?: readonly ReturnType<typeof tier>[];
}): QuantityTierSelectionInput =>
  Schema.decodeSync(QuantityTierSelectionInputSchema)({
    attempt: {
      evaluatedAt,
      exactPrice: {
        path: { priceGroupSelector: { kind: 'NO_GROUP' }, requiredAbsenceEvidence: [] },
        price: {
          definition: {
            identityKey: {
              catalogSelection,
              commercialScope: {
                channelId: 'B2C',
                marketId: 'cz-launch',
                sellingLegalEntityId: legalEntityId,
              },
              currencyCode: 'CZK',
              priceGroupSelector: { kind: 'NO_GROUP' },
              unitBasis: basis.priceUnitBasis,
            },
            priceRef,
            revision: {
              effectiveFrom,
              monetaryAmount: { amount: '100', currencyCode: 'CZK' },
              monetaryBoundary: 'PRE_TAX',
              revision: 1,
              revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          },
          effectivePeriod: { effectiveFrom, effectiveTo: null },
          lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
        },
        scheduleRevision: 1,
      },
      normalizedQuantity: { quantity, quantityBasis: basis },
      tierSetPriceRef: priceRef,
    },
    tierSet: {
      authority: {
        generation: 1,
        observedAt: '2026-09-27T10:00:00.000Z',
        ownerRevision: 'quantity-tier-set-r1',
        ownerRootRef: `quantity-tier-set:${priceRef.resourceId}`,
        predicateRef: `price:${priceRef.resourceId}`,
        verificationRef: tierVerificationRef,
      },
      completenessEvidence: {
        nextApplicabilityBoundary,
        observedAt: '2026-09-27T10:00:00.000Z',
        ownerRevision: 'quantity-tier-set-r1',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: `price:${priceRef.resourceId}` },
      },
      currentTiers: tiers,
      factProofs: tiers.map(({ definition }, index) => ({
        factRef: `quantity-tier:${index + 1}`,
        factRevisionRef: definition.revision.revisionId,
        verificationRef: tierVerificationRef,
      })),
      priceRef,
    },
  });

const select = (input: QuantityTierSelectionInput) => selectQuantityTier({ input, outcome: 'TIER_SET_CURRENT' });

describe('Pricing Quantity Tier threshold selection #767 runtime acceptance', () => {
  it.effect('uses inclusive highest-reached thresholds for the complete 9/10/15/20/21 matrix', () =>
    Effect.gen(function* thresholdMatrix() {
      const cases = [
        { amount: '100', outcome: 'BASE_PRICE_RETAINED', quantity: '9', threshold: null },
        { amount: '90', outcome: 'QUANTITY_TIER_APPLIED', quantity: '10', threshold: '10' },
        { amount: '90', outcome: 'QUANTITY_TIER_APPLIED', quantity: '15', threshold: '10' },
        { amount: '80', outcome: 'QUANTITY_TIER_APPLIED', quantity: '20', threshold: '20' },
        { amount: '80', outcome: 'QUANTITY_TIER_APPLIED', quantity: '21', threshold: '20' },
      ] as const;

      for (const expected of cases) {
        const result = yield* select(makeInput({ quantity: expected.quantity }));
        expect(result.outcome).toBe(expected.outcome);
        if (result.outcome === 'QUANTITY_TIER_SELECTION_FAILED') {
          throw new Error(`unexpected selection failure: ${result.reason}`);
        }
        expect(result.resultingUnitPrice).toEqual({ amount: expected.amount, currencyCode: 'CZK' });
        expect(result.appliesToQuantity.quantity).toBe(expected.quantity);
        expect('bands' in result).toBe(false);
        expect('graduatedAmounts' in result).toBe(false);
        if (result.evidence.decision.kind === 'HIGHEST_REACHED_THRESHOLD') {
          expect(result.evidence.decision.winningTier.definition.identityKey.thresholdQuantity).toBe(
            expected.threshold,
          );
        } else {
          expect(expected.threshold).toBeNull();
        }
      }
    }),
  );

  it.effect('retains the same exact Price below the first threshold and accepts an explicit zero winning Tier', () =>
    Effect.gen(function* baseAndZero() {
      const below = yield* select(makeInput({ quantity: '9' }));
      expect(below).toMatchObject({
        outcome: 'BASE_PRICE_RETAINED',
        resultingUnitPrice: { amount: '100', currencyCode: 'CZK' },
      });
      if (below.outcome !== 'BASE_PRICE_RETAINED') {
        throw new Error('expected base Price retention');
      }
      expect(below.evidence.input.attempt.exactPrice.price.definition.priceRef).toEqual(priceRef);
      expect(below.evidence.decision).toEqual({ kind: 'NO_THRESHOLD_REACHED' });

      const zero = yield* select(
        makeInput({
          quantity: '20',
          tiers: [tier({ amount: '0', revisionId: tierRevisionIds.twenty, thresholdQuantity: '20' }), tier10],
        }),
      );
      expect(zero).toMatchObject({
        outcome: 'QUANTITY_TIER_APPLIED',
        resultingUnitPrice: { amount: '0', currencyCode: 'CZK' },
      });
    }),
  );

  it.effect('chooses the highest reached threshold, never the cheapest effect or arrival order', () =>
    Effect.gen(function* highestNotCheapest() {
      const cheaperLowerTier = tier({
        amount: '70',
        revisionId: tierRevisionIds.ten,
        thresholdQuantity: '10',
      });
      const result = yield* select(makeInput({ quantity: '21', tiers: [tier20, cheaperLowerTier] }));

      expect(result).toMatchObject({
        outcome: 'QUANTITY_TIER_APPLIED',
        resultingUnitPrice: { amount: '80', currencyCode: 'CZK' },
      });
      if (result.outcome !== 'QUANTITY_TIER_APPLIED') {
        throw new Error('expected an applied Quantity Tier');
      }
      expect(result.evidence.decision).toMatchObject({ kind: 'HIGHEST_REACHED_THRESHOLD' });
      if (result.evidence.decision.kind === 'HIGHEST_REACHED_THRESHOLD') {
        expect(result.evidence.decision.winningTier.definition.identityKey.thresholdQuantity).toBe('20');
      }
    }),
  );

  it.effect('fails incomplete, unavailable, and unverifiable owner sets without base-Price fallback', () =>
    Effect.gen(function* unusableOwnerSets() {
      const { attempt } = makeInput({ quantity: '9' });
      const cases = [
        { outcome: 'TIER_SET_INCOMPLETE', reason: 'INCOMPLETE_TIER_SET' },
        { outcome: 'TIER_SET_UNAVAILABLE', reason: 'UNAVAILABLE_TIER_SET' },
        { outcome: 'TIER_SET_UNVERIFIABLE', reason: 'UNVERIFIABLE_TIER_SET' },
      ] as const;

      for (const ownerState of cases) {
        const result = yield* selectQuantityTier({
          attempt,
          candidateTierRevisionIds: [tierRevisionIds.ten],
          outcome: ownerState.outcome,
        });
        expect(result).toMatchObject({
          candidateTierRevisionIds: [tierRevisionIds.ten],
          outcome: 'QUANTITY_TIER_SELECTION_FAILED',
          reason: ownerState.reason,
        });
        expect('resultingUnitPrice' in result).toBe(false);
      }
    }),
  );

  it.effect('fails stale, ambiguous, and conflicting Current Tier sets without fallback', () =>
    Effect.gen(function* brokenCurrentSets() {
      const duplicateSameEffect = tier({
        amount: '90',
        revisionId: tierRevisionIds.duplicate,
        thresholdQuantity: '10.0',
      });
      const duplicateConflictingEffect = tier({
        amount: '85',
        revisionId: tierRevisionIds.duplicate,
        thresholdQuantity: '10.0',
      });
      const cases = [
        {
          input: makeInput({
            nextApplicabilityBoundary: '2026-09-27T11:00:00.000Z',
            quantity: '9',
          }),
          reason: 'STALE_TIER_SET',
        },
        {
          input: makeInput({ quantity: '15', tiers: [tier10, duplicateSameEffect, tier20] }),
          reason: 'AMBIGUOUS_THRESHOLD',
        },
        {
          input: makeInput({ quantity: '15', tiers: [tier10, duplicateConflictingEffect, tier20] }),
          reason: 'CONFLICTING_CURRENT_TIERS',
        },
      ] as const;

      for (const testCase of cases) {
        const result = yield* select(testCase.input);
        expect(result).toMatchObject({
          outcome: 'QUANTITY_TIER_SELECTION_FAILED',
          reason: testCase.reason,
        });
        expect('resultingUnitPrice' in result).toBe(false);
      }
    }),
  );

  it.effect('fails exact Price, currency, and Quantity-basis mismatches without switching identity', () =>
    Effect.gen(function* exactBindingMismatches() {
      const otherPriceRef = {
        ...priceRef,
        resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      };
      const incompatibleBasis = {
        ...quantityBasis,
        catalogQuantityBasis: {
          ...quantityBasis.catalogQuantityBasis,
          targetDivisibilityRevision: 4,
        },
      };
      const cases = [
        {
          input: makeInput({
            quantity: '15',
            tiers: [
              tier({
                amount: '90',
                owningPriceRef: otherPriceRef,
                revisionId: tierRevisionIds.ten,
                thresholdQuantity: '10',
              }),
            ],
          }),
          reason: 'PRICE_BINDING_MISMATCH',
        },
        {
          input: makeInput({
            quantity: '15',
            tiers: [
              tier({
                amount: '90',
                currencyCode: 'EUR',
                revisionId: tierRevisionIds.ten,
                thresholdQuantity: '10',
              }),
            ],
          }),
          reason: 'CURRENCY_MISMATCH',
        },
        {
          input: makeInput({
            quantity: '15',
            tiers: [
              tier({
                amount: '90',
                basis: incompatibleBasis,
                revisionId: tierRevisionIds.ten,
                thresholdQuantity: '10',
              }),
            ],
          }),
          reason: 'INCOMPATIBLE_QUANTITY_BASIS',
        },
      ] as const;

      for (const testCase of cases) {
        const result = yield* select(testCase.input);
        expect(result).toMatchObject({
          outcome: 'QUANTITY_TIER_SELECTION_FAILED',
          reason: testCase.reason,
        });
        expect('resultingUnitPrice' in result).toBe(false);
      }
    }),
  );

  it.effect('binds Tiers to the exact Catalog target and gives package option precedence over Variant', () =>
    Effect.gen(function* exactCatalogTarget() {
      const otherVariantBasis = quantityBasisFor(otherVariantRef);
      const packageOptionBasis = quantityBasisFor(packageOptionRef);
      expect(() =>
        makeInput({
          basis: otherVariantBasis,
          quantity: '15',
          tiers: [
            tier({
              amount: '90',
              basis: otherVariantBasis,
              revisionId: tierRevisionIds.ten,
              thresholdQuantity: '10',
            }),
          ],
        }),
      ).toThrow(/canonical Catalog target/u);

      const packageOption = yield* select(
        makeInput({
          basis: packageOptionBasis,
          catalogSelection: packageCatalogSelection,
          quantity: '15',
          tiers: [
            tier({
              amount: '90',
              basis: packageOptionBasis,
              revisionId: tierRevisionIds.ten,
              thresholdQuantity: '10',
            }),
          ],
        }),
      );
      expect(packageOption).toMatchObject({
        outcome: 'QUANTITY_TIER_APPLIED',
        resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
      });

      expect(() =>
        makeInput({
          catalogSelection: packageCatalogSelection,
          quantity: '15',
          tiers: [tier10],
        }),
      ).toThrow(/canonical Catalog target/u);
    }),
  );
});
