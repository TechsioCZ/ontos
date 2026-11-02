import { PricingUnitPriceCalculationReadyInputSchema } from '@app/pricing-contracts/domain/unit-price-calculation';
import type { PricingUnitPriceCalculationReadyInput } from '@app/pricing-contracts/domain/unit-price-calculation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingUnitPrice } from '../../src/services/unit-price-calculation.service.ts';
import { unitPriceCalculationAttempt } from './support/unit-price-calculation.fixture.ts';

const isReadyInput = Schema.is(PricingUnitPriceCalculationReadyInputSchema);

type UnitBasis = PricingUnitPriceCalculationReadyInput['quantityBasis']['attempt']['price']['identityKey']['unitBasis'];

// The caller's requested exact key keeps its own lexical form while the owner stores a normalized decimal form,
// so the stored selected-Price and Quantity-basis Price identities are re-bound and the requested key is untouched.
const withStoredPriceUnitBasis = (
  input: PricingUnitPriceCalculationReadyInput,
  unitBasis: UnitBasis,
): PricingUnitPriceCalculationReadyInput => {
  const { attempt: tierAttempt } = input.tierSelection.evidence.input;
  const selectedPrice = tierAttempt.exactPrice.price;
  const quantityPrice = input.quantityBasis.attempt.price;
  return {
    ...input,
    quantityBasis: {
      ...input.quantityBasis,
      attempt: {
        ...input.quantityBasis.attempt,
        price: { ...quantityPrice, identityKey: { ...quantityPrice.identityKey, unitBasis } },
      },
    },
    tierSelection: {
      ...input.tierSelection,
      evidence: {
        ...input.tierSelection.evidence,
        input: {
          ...input.tierSelection.evidence.input,
          attempt: {
            ...tierAttempt,
            exactPrice: {
              ...tierAttempt.exactPrice,
              price: {
                ...selectedPrice,
                definition: {
                  ...selectedPrice.definition,
                  identityKey: { ...selectedPrice.definition.identityKey, unitBasis },
                },
              },
            },
          },
        },
      },
    },
  };
};

const readyInput = unitPriceCalculationAttempt().pipe(
  Effect.flatMap(calculatePricingUnitPrice),
  Effect.map(({ input }) => input),
);

describe('Unit Price calculation Price identity quantity compares by decimal value', () => {
  it.effect('treats 1, 1.0 and 1.000 as the same Price unit quantity', () =>
    Effect.gen(function* equalValues() {
      const input = yield* readyInput;
      const requested = input.exactPrice.path;
      expect('usedPrice' in requested ? requested.usedPrice.request.exactKey.unitBasis.quantity : null).toBe('1');
      expect(isReadyInput(input)).toBe(true);
      for (const quantity of ['1', '1.0', '1.000', '1.000000000']) {
        const stored = { ...input.quantityBasis.attempt.price.identityKey.unitBasis, quantity };
        expect(isReadyInput(withStoredPriceUnitBasis(input, stored))).toBe(true);
      }
    }),
  );

  it.effect('rejects a Price unit quantity with a different value however it is written', () =>
    Effect.gen(function* differentValues() {
      const input = yield* readyInput;
      for (const quantity of ['2', '1.5', '1.000000001', '10']) {
        const stored = { ...input.quantityBasis.attempt.price.identityKey.unitBasis, quantity };
        expect(isReadyInput(withStoredPriceUnitBasis(input, stored))).toBe(false);
      }
    }),
  );

  it.effect('still requires every other identity field to match exactly when the quantity value is equal', () =>
    Effect.gen(function* otherIdentityFields() {
      const input = yield* readyInput;
      const base = input.quantityBasis.attempt.price.identityKey.unitBasis;
      const otherUnit = { ...base.unitRef, resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
      expect(isReadyInput(withStoredPriceUnitBasis(input, { quantity: '1.000', unitRef: otherUnit }))).toBe(false);
    }),
  );
});
