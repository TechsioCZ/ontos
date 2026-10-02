import { ExactPriceFoundResolutionSchema } from '@app/pricing-contracts/domain/exact-price-resolution';
import type { PricingUnitPriceCalculationAttempt } from '@app/pricing-contracts/domain/unit-price-calculation';
import { DateTime, Effect, Match, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  unitPriceGroupAbsencePredicateRef,
  validateUnitPriceMaterialEvidence,
} from '../../src/services/unit-price-material-evidence.service.ts';
import { unitPriceCalculationAttempt } from './support/unit-price-calculation.fixture.ts';

describe('Pricing Unit Price material evidence gate #778', () => {
  it.effect('admits one exact Current Price, complete Tier set, and owner-derived line Quantity', () =>
    Effect.gen(function* exactMaterialEvidence() {
      const attempt = yield* unitPriceCalculationAttempt({ quantity: '2.54' });
      const ready = yield* validateUnitPriceMaterialEvidence(attempt);

      expect(Schema.is(ExactPriceFoundResolutionSchema)(ready.exactPrice)).toBe(true);
      expect(ready.lineQuantity.quantity).toBe('2.54');
      expect(ready.quantityBasis.resultingPurchaseQuantity.amount).toBe('2.54');
      expect(ready.tierSelection.outcome).toBe('BASE_PRICE_RETAINED');
    }),
  );

  it.effect('rejects a Quantity that is not the exact owner-derived resulting Quantity', () =>
    Effect.gen(function* rejectSubstitutedQuantity() {
      const attempt = yield* unitPriceCalculationAttempt({ quantity: '2.54' });
      if (attempt.lineQuantity === undefined) {
        throw new Error('Fixture must provide one owner-derived line Quantity');
      }
      const failure = yield* validateUnitPriceMaterialEvidence({
        ...attempt,
        lineQuantity: { ...attempt.lineQuantity, quantity: '3' },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'PricingUnitPriceUnverifiableFailure')).toBe(true);
      if (!Predicate.isTagged(failure, 'PricingUnitPriceUnverifiableFailure')) {
        throw new Error('Expected unverifiable substituted Quantity');
      }
      expect(failure.reason).toBe('CURRENTNESS_UNVERIFIABLE');
    }),
  );

  it.effect('rejects invented Group-absence evidence on a direct Group Price path', () =>
    Effect.gen(function* rejectInventedAbsence() {
      const attempt = yield* unitPriceCalculationAttempt({ groupPath: true });
      if (attempt.tierSelection.outcome === 'QUANTITY_TIER_SELECTION_FAILED') {
        throw new Error('Fixture must provide a successful Tier selection');
      }
      const failure = yield* validateUnitPriceMaterialEvidence({
        ...attempt,
        tierSelection: {
          ...attempt.tierSelection,
          evidence: {
            ...attempt.tierSelection.evidence,
            input: {
              ...attempt.tierSelection.evidence.input,
              attempt: {
                ...attempt.tierSelection.evidence.input.attempt,
                exactPrice: {
                  ...attempt.tierSelection.evidence.input.attempt.exactPrice,
                  path: {
                    ...attempt.tierSelection.evidence.input.attempt.exactPrice.path,
                    requiredAbsenceEvidence: [attempt.tierSelection.evidence.input.tierSet.completenessEvidence],
                  },
                },
              },
            },
          },
        },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'PricingUnitPriceUnverifiableFailure')).toBe(true);
      if (!Predicate.isTagged(failure, 'PricingUnitPriceUnverifiableFailure')) {
        throw new Error('Expected unverifiable Group-absence evidence');
      }
      expect(failure.reason).toBe('SET_COMPLETENESS_UNVERIFIABLE');
    }),
  );

  it.effect('rejects a substituted exact Group-price absence predicate', () =>
    Effect.gen(function* rejectSubstitutedAbsencePredicate() {
      const groupAttempt = yield* unitPriceCalculationAttempt({ groupPath: true });
      const fallbackAttempt = Match.value(groupAttempt).pipe(
        Match.when(
          {
            exactPrice: { _tag: 'PRICE_FOUND', path: { _tag: 'GROUP_PRICE' } },
            quantityBasis: { outcome: 'NO_CONVERSION_REQUIRED' },
            tierSelection: { outcome: 'BASE_PRICE_RETAINED' },
          },
          (attempt): PricingUnitPriceCalculationAttempt => {
            const groupPath = attempt.exactPrice.path;
            const groupRequest = groupPath.usedPrice.request;
            const noGroupIdentity = {
              ...groupRequest.exactKey,
              priceGroupSelector: { kind: 'NO_GROUP' as const },
            };
            const noGroupUsedPrice = {
              ...groupPath.usedPrice,
              request: { ...groupRequest, exactKey: noGroupIdentity },
            };
            if (groupPath.usedPrice.evidence.nextApplicabilityBoundary === undefined) {
              throw new Error('Fixture must provide a Price currentness boundary');
            }
            const absenceEvidence = {
              nextApplicabilityBoundary: DateTime.makeUnsafe(groupPath.usedPrice.evidence.nextApplicabilityBoundary),
              observedAt: DateTime.makeUnsafe(groupPath.usedPrice.evidence.observedAt),
              ownerRevision: groupPath.usedPrice.evidence.ownerRevision,
              scope: {
                kind: 'EXACT_PREDICATE' as const,
                predicateRef: unitPriceGroupAbsencePredicateRef(groupRequest),
              },
            };
            const exactPrice = {
              ...attempt.exactPrice,
              path: {
                _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE' as const,
                discountAudience: groupPath.discountAudience,
                groupAbsence: {
                  _tag: 'ABSENT' as const,
                  evidence: groupPath.usedPrice.evidence,
                  request: groupRequest,
                },
                resolutionInput: groupPath.resolutionInput,
                usedPrice: noGroupUsedPrice,
              },
            };
            const tierSelection = {
              ...attempt.tierSelection,
              evidence: {
                ...attempt.tierSelection.evidence,
                input: {
                  ...attempt.tierSelection.evidence.input,
                  attempt: {
                    ...attempt.tierSelection.evidence.input.attempt,
                    exactPrice: {
                      ...attempt.tierSelection.evidence.input.attempt.exactPrice,
                      path: {
                        priceGroupSelector: noGroupIdentity.priceGroupSelector,
                        requiredAbsenceEvidence: [absenceEvidence],
                      },
                      price: {
                        ...attempt.tierSelection.evidence.input.attempt.exactPrice.price,
                        definition: {
                          ...attempt.tierSelection.evidence.input.attempt.exactPrice.price.definition,
                          identityKey: noGroupIdentity,
                        },
                      },
                    },
                  },
                },
              },
            };
            return {
              ...attempt,
              exactPrice,
              quantityBasis: {
                ...attempt.quantityBasis,
                attempt: {
                  ...attempt.quantityBasis.attempt,
                  price: { ...attempt.quantityBasis.attempt.price, identityKey: noGroupIdentity },
                },
              },
              tierSelection,
            };
          },
        ),
        Match.orElse(() => null),
      );
      if (fallbackAttempt === null) {
        throw new Error('Fixture must provide a direct Group Price with baseline Tier selection');
      }

      yield* validateUnitPriceMaterialEvidence(fallbackAttempt);
      if (fallbackAttempt.tierSelection.outcome !== 'BASE_PRICE_RETAINED') {
        throw new Error('Fallback fixture must retain the base Price');
      }
      const [absence] = fallbackAttempt.tierSelection.evidence.input.attempt.exactPrice.path.requiredAbsenceEvidence;
      if (absence === undefined) {
        throw new Error('Fallback fixture must preserve Group-price absence evidence');
      }
      const failure = yield* validateUnitPriceMaterialEvidence({
        ...fallbackAttempt,
        tierSelection: {
          ...fallbackAttempt.tierSelection,
          evidence: {
            ...fallbackAttempt.tierSelection.evidence,
            input: {
              ...fallbackAttempt.tierSelection.evidence.input,
              attempt: {
                ...fallbackAttempt.tierSelection.evidence.input.attempt,
                exactPrice: {
                  ...fallbackAttempt.tierSelection.evidence.input.attempt.exactPrice,
                  path: {
                    ...fallbackAttempt.tierSelection.evidence.input.attempt.exactPrice.path,
                    requiredAbsenceEvidence: [
                      {
                        ...absence,
                        scope: { ...absence.scope, predicateRef: 'substituted-group-price-predicate' },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'PricingUnitPriceUnverifiableFailure')).toBe(true);
      if (!Predicate.isTagged(failure, 'PricingUnitPriceUnverifiableFailure')) {
        throw new Error('Expected unverifiable substituted Group-price predicate');
      }
      expect(failure.reason).toBe('SET_COMPLETENESS_UNVERIFIABLE');
    }),
  );
});
