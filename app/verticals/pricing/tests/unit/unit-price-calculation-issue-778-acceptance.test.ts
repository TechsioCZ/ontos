import { ExactPriceFoundResolutionSchema } from '@app/pricing-contracts/domain/exact-price-resolution';
import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import { QuantityTierSelectionSuccessSchema } from '@app/pricing-contracts/domain/quantity-tier';
import {
  PricingUnitPriceCalculationAttemptSchema,
  PricingUnitPriceConflictFailure,
  PricingUnitPriceUnavailableFailure,
  PricingUnitPriceUnverifiableFailure,
} from '@app/pricing-contracts/domain/unit-price-calculation';
import { Effect, Exit, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingUnitPrice } from '../../src/services/unit-price-calculation.service.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixturePriceRef,
  unitPriceFixtureVariantRef,
} from './support/unit-price-calculation.fixture.ts';

const tierIds = {
  five: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
  ten: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee10',
  three: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
} as const;

const decodeAttempt = Schema.decodeUnknownSync(PricingUnitPriceCalculationAttemptSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Unit Price calculation #778 owner acceptance', () => {
  it.effect('multiplies exact pre-Tax Unit Price by owner-derived metres and kilograms without rounding', () =>
    Effect.gen(function* exactExamples() {
      const metresAttempt = yield* unitPriceCalculationAttempt({
        priceAmount: '120',
        quantity: '2.54',
        tiers: [{ amount: '110', revisionId: tierIds.three, thresholdQuantity: '3' }],
      });
      const kilogramsAttempt = yield* unitPriceCalculationAttempt({
        occurrenceId: 'line-778-kg',
        priceAmount: '85',
        quantity: '3.2',
      });
      const metres = yield* calculatePricingUnitPrice(metresAttempt);
      const kilograms = yield* calculatePricingUnitPrice(kilogramsAttempt);

      expect(metres.unitPrice).toEqual({ amount: '120', currencyCode: 'CZK' });
      expect(metres.baseLineValue.currencyCode).toBe('CZK');
      expect(priceDecimalValuesEqual(metres.baseLineValue.amount, '304.80')).toBe(true);
      expect(metres.baseLineValue.amount).toBe('304.8');
      expect(metres.monetaryBoundary).toBe('PRE_TAX');
      expect(kilograms.unitPrice.amount).toBe('85');
      expect(kilograms.baseLineValue.amount).toBe('272');
    }),
  );

  it.effect(
    'uses the highest reached Tier of the one exact Price, retains baseline when none is reached, and preserves zero',
    () =>
      Effect.gen(function* selectTier() {
        const tiers = [
          { amount: '110', revisionId: tierIds.five, thresholdQuantity: '5' },
          { amount: '100', revisionId: tierIds.ten, thresholdQuantity: '10' },
        ] as const;
        const appliedAttempt = yield* unitPriceCalculationAttempt({ priceAmount: '120', quantity: '12', tiers });
        const baselineAttempt = yield* unitPriceCalculationAttempt({
          occurrenceId: 'line-778-baseline',
          priceAmount: '120',
          quantity: '2',
          tiers,
        });
        const zeroAttempt = yield* unitPriceCalculationAttempt({
          occurrenceId: 'line-778-zero',
          priceAmount: '0',
          quantity: '7',
        });
        const applied = yield* calculatePricingUnitPrice(appliedAttempt);
        const baseline = yield* calculatePricingUnitPrice(baselineAttempt);
        const zero = yield* calculatePricingUnitPrice(zeroAttempt);

        expect(applied.input.tierSelection.outcome).toBe('QUANTITY_TIER_APPLIED');
        expect(applied.unitPrice.amount).toBe('100');
        expect(applied.baseLineValue.amount).toBe('1200');
        expect(applied.input.tierSelection.evidence.decision).toMatchObject({
          kind: 'HIGHEST_REACHED_THRESHOLD',
          winningTier: { definition: { identityKey: { priceRef: unitPriceFixturePriceRef, thresholdQuantity: '10' } } },
        });
        expect(baseline.input.tierSelection.outcome).toBe('BASE_PRICE_RETAINED');
        expect(baseline.unitPrice.amount).toBe('120');
        expect(baseline.baseLineValue.amount).toBe('240');
        expect(zero.unitPrice.amount).toBe('0');
        expect(zero.baseLineValue.amount).toBe('0');
      }),
  );

  it.effect(
    'keeps incomplete, conflicting, unavailable, unverifiable, and stale Tier sets distinct from true absence',
    () =>
      Effect.gen(function* failClosedTierEvidence() {
        const incompleteAttempt = yield* unitPriceCalculationAttempt({ tierState: 'INCOMPLETE' });
        const unavailableAttempt = yield* unitPriceCalculationAttempt({ tierState: 'UNAVAILABLE' });
        const unverifiableAttempt = yield* unitPriceCalculationAttempt({ tierState: 'UNVERIFIABLE' });
        const staleAttempt = yield* unitPriceCalculationAttempt({ staleTierSet: true });
        const conflictingAttempt = yield* unitPriceCalculationAttempt({
          quantity: '12',
          tiers: [
            { amount: '100', revisionId: tierIds.five, thresholdQuantity: '10' },
            { amount: '90', revisionId: tierIds.ten, thresholdQuantity: '10.0' },
          ],
        });
        const incomplete = yield* calculatePricingUnitPrice(incompleteAttempt).pipe(Effect.flip);
        const unavailable = yield* calculatePricingUnitPrice(unavailableAttempt).pipe(Effect.flip);
        const unverifiable = yield* calculatePricingUnitPrice(unverifiableAttempt).pipe(Effect.flip);
        const stale = yield* calculatePricingUnitPrice(staleAttempt).pipe(Effect.flip);
        const conflicting = yield* calculatePricingUnitPrice(conflictingAttempt).pipe(Effect.flip);

        expect(Schema.is(PricingUnitPriceUnverifiableFailure)(incomplete)).toBe(true);
        expect(Schema.is(PricingUnitPriceUnavailableFailure)(unavailable)).toBe(true);
        expect(Schema.is(PricingUnitPriceUnverifiableFailure)(unverifiable)).toBe(true);
        expect(Schema.is(PricingUnitPriceUnverifiableFailure)(stale)).toBe(true);
        expect(Schema.is(PricingUnitPriceConflictFailure)(conflicting)).toBe(true);
        if (
          !Schema.is(PricingUnitPriceUnverifiableFailure)(incomplete) ||
          !Schema.is(PricingUnitPriceUnavailableFailure)(unavailable) ||
          !Schema.is(PricingUnitPriceUnverifiableFailure)(unverifiable) ||
          !Schema.is(PricingUnitPriceUnverifiableFailure)(stale) ||
          !Schema.is(PricingUnitPriceConflictFailure)(conflicting)
        ) {
          throw new Error('Tier evidence fixtures must retain their typed failure classes');
        }
        expect(incomplete.reason).toBe('SET_COMPLETENESS_UNVERIFIABLE');
        expect(unavailable).toMatchObject({ reason: 'QUANTITY_TIER_UNAVAILABLE', retryable: true });
        expect(unverifiable.reason).toBe('QUANTITY_TIER_UNVERIFIABLE');
        expect(stale.reason).toBe('QUANTITY_TIER_UNVERIFIABLE');
        expect(conflicting.reason).toBe('QUANTITY_TIER_CONFLICT');
      }),
  );

  it.effect(
    'preserves exact Group/no-group paths, resulting Quantity evidence, and stable selection/line identity',
    () =>
      Effect.gen(function* preserveEvidence() {
        const noGroupAttempt = yield* unitPriceCalculationAttempt({ occurrenceId: 'line-778-no-group' });
        const groupAttempt = yield* unitPriceCalculationAttempt({ groupPath: true, occurrenceId: 'line-778-group' });
        const noGroup = yield* calculatePricingUnitPrice(noGroupAttempt);
        const group = yield* calculatePricingUnitPrice(groupAttempt);

        const noGroupPath = Match.value(noGroup.input.exactPrice.path).pipe(
          Match.tag('NO_GROUP_GUEST', (path) => path),
          Match.orElse(() => null),
        );
        const groupPath = Match.value(group.input.exactPrice.path).pipe(
          Match.tag('GROUP_PRICE', (path) => path),
          Match.orElse(() => null),
        );
        expect(noGroupPath).toBeDefined();
        expect(groupPath).toBeDefined();
        if (groupPath === null || !('priceGroupRef' in groupPath.usedPrice.request.exactKey.priceGroupSelector)) {
          throw new Error('Grouped fixture must preserve the exact Price Group selector');
        }
        expect(groupPath.usedPrice.priceRef).toEqual(unitPriceFixturePriceRef);
        expect(group.input.tierSelection.evidence.input.attempt.exactPrice.path.priceGroupSelector).toEqual({
          kind: 'PRICE_GROUP',
          priceGroupRef: groupPath.usedPrice.request.exactKey.priceGroupSelector.priceGroupRef,
        });
        expect(group.input.line.occurrenceId).toBe(groupAttempt.line.occurrenceId);
        expect(group.input.line.catalog.selection).toEqual(groupAttempt.line.catalog.selection);
        expect(group.input.line.catalog.selection.variantRef).toEqual(unitPriceFixtureVariantRef);
        expect(group.resultingQuantity).toEqual(group.input.quantityBasis.resultingPurchaseQuantity);
        expect(group.input.lineQuantity.quantityBasis).toEqual(
          group.input.tierSelection.appliesToQuantity.quantityBasis,
        );
      }),
  );

  it.effect('rejects historical-only support and isolates native future EUR facts without FX or Launch fallback', () =>
    Effect.gen(function* isolateCurrency() {
      const historicalAttempt = yield* unitPriceCalculationAttempt({ historicalCurrencySupport: true });
      const czkAttempt = yield* unitPriceCalculationAttempt();
      const eurAttempt = yield* unitPriceCalculationAttempt({
        currencyCode: 'EUR',
        occurrenceId: 'line-778-eur',
      });
      const historical = yield* calculatePricingUnitPrice(historicalAttempt).pipe(Effect.flip);
      const eur = yield* calculatePricingUnitPrice(eurAttempt);

      expect(Schema.is(PricingUnitPriceUnverifiableFailure)(historical)).toBe(true);
      if (!Schema.is(PricingUnitPriceUnverifiableFailure)(historical)) {
        throw new Error('Historical-only support must remain a typed unverifiable failure');
      }
      expect(historical.reason).toBe('CURRENTNESS_UNVERIFIABLE');
      expect(Schema.is(ExactPriceFoundResolutionSchema)(czkAttempt.exactPrice)).toBe(true);
      if (!Schema.is(ExactPriceFoundResolutionSchema)(czkAttempt.exactPrice)) {
        throw new Error('Launch fixture must resolve one exact CZK Price');
      }
      expect(czkAttempt.exactPrice.currencySupport.supportedCurrencies).toEqual(['CZK']);
      expect(eur.unitPrice.currencyCode).toBe('EUR');
      expect(eur.baseLineValue).toEqual({ amount: '304.8', currencyCode: 'EUR' });
      expect(eur.input.exactPrice.currencySupport.supportedCurrencies).toEqual(['EUR']);
      expect(eur).not.toHaveProperty('conversionRate');
      expect(eur).not.toHaveProperty('convertedFromCurrency');
    }),
  );

  it.effect('retains exact sub-cent intermediates and fails source precision instead of truncating or rounding', () =>
    Effect.gen(function* retainPrecision() {
      const exactAttempt = yield* unitPriceCalculationAttempt({ priceAmount: '0.333333333', quantity: '3' });
      const exact = yield* calculatePricingUnitPrice(exactAttempt);
      const excessiveAmount = yield* unitPriceCalculationAttempt({ priceAmount: '1.1234567890' }).pipe(Effect.exit);
      const excessiveQuantity = yield* unitPriceCalculationAttempt({ quantity: '2.5400000000' }).pipe(Effect.exit);

      expect(exact.baseLineValue.amount).toBe('0.999999999');
      expect(exact.baseLineValue.amount).not.toBe('1');
      expect(Exit.isFailure(excessiveAmount)).toBe(true);
      expect(Exit.isFailure(excessiveQuantity)).toBe(true);
    }),
  );

  it.effect(
    'admits no Storefront, Product-only, Market-less, cross-Price Tier, package-component, or formula fallback',
    () =>
      Effect.gen(function* rejectFallbacks() {
        const attempt = yield* unitPriceCalculationAttempt({
          quantity: '12',
          tiers: [{ amount: '100', revisionId: tierIds.ten, thresholdQuantity: '10' }],
        });
        if (
          !Schema.is(ExactPriceFoundResolutionSchema)(attempt.exactPrice) ||
          !Schema.is(QuantityTierSelectionSuccessSchema)(attempt.tierSelection)
        ) {
          throw new Error('Acceptance fixture must contain one exact Price and an applied Tier');
        }
        if (!('usedPrice' in attempt.exactPrice.path)) {
          throw new Error('Acceptance fixture must contain a successful exact Price path');
        }
        const { usedPrice } = attempt.exactPrice.path;
        const { exactKey } = usedPrice.request;
        const productOnly = {
          ...attempt,
          exactPrice: {
            ...attempt.exactPrice,
            path: {
              ...attempt.exactPrice.path,
              usedPrice: {
                ...usedPrice,
                request: {
                  ...usedPrice.request,
                  exactKey: {
                    ...exactKey,
                    catalogSelection: { productRef: exactKey.catalogSelection.productRef },
                  },
                },
              },
            },
          },
        };
        const marketLess = {
          ...attempt,
          exactPrice: {
            ...attempt.exactPrice,
            path: {
              ...attempt.exactPrice.path,
              usedPrice: {
                ...usedPrice,
                request: {
                  ...usedPrice.request,
                  exactKey: {
                    ...exactKey,
                    commercialScope: {
                      channelId: exactKey.commercialScope.channelId,
                      sellingLegalEntityId: exactKey.commercialScope.sellingLegalEntityId,
                    },
                  },
                },
              },
            },
          },
        };
        const crossPriceTier = {
          ...attempt,
          tierSelection: {
            ...attempt.tierSelection,
            evidence: {
              ...attempt.tierSelection.evidence,
              input: {
                ...attempt.tierSelection.evidence.input,
                tierSet: {
                  ...attempt.tierSelection.evidence.input.tierSet,
                  priceRef: { ...unitPriceFixturePriceRef, resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
                },
              },
            },
          },
        };

        expect(() => decodeAttempt({ ...attempt, storefrontId: 'storefront-778' })).toThrow();
        expect(() => decodeAttempt({ ...attempt, componentPrices: [] })).toThrow();
        expect(() => decodeAttempt({ ...attempt, configurationFormula: 'measuredValue * unitPrice' })).toThrow();
        expect(() => decodeAttempt(productOnly)).toThrow();
        expect(() => decodeAttempt(marketLess)).toThrow();
        expect(() => decodeAttempt(crossPriceTier)).toThrow();
      }),
  );
});
