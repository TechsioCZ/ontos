import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import { PricingLinePublicationResultWireSchema } from '@app/pricing-contracts/domain/rounding-boundary';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';

const PricingLinePublicationResultJsonSchema = Schema.fromJsonString(PricingLinePublicationResultWireSchema);
const encodeResult = Schema.encodeEffect(PricingLinePublicationResultJsonSchema);
const decodeResult = Schema.decodeEffect(PricingLinePublicationResultJsonSchema, {
  onExcessProperty: 'error',
});

describe('Pricing final-line provider transport boundary', () => {
  it.effect('round-trips canonical amounts and signed adjustments without conversion or double rounding', () =>
    Effect.gen(function* roundTripsExactStrings() {
      for (const expected of [
        { adjustment: '0.005', preRound: '33.335', published: '33.34' },
        { adjustment: '-0.004', preRound: '33.334', published: '33.33' },
      ] as const) {
        const { preRound } = yield* makeIssue779PreRoundScenario({
          discounts: ['0', '0', '0'],
          priceAmount: expected.preRound,
        });
        const result = yield* publishPricingLineValues({
          candidateRef: preRound.rawComposition.candidateRef,
          decision: preRound.decision,
          preRound,
          publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
        });

        const readyResult = yield* result.outcome === 'LINE_VALUES_PUBLISHED'
          ? Effect.succeed(result)
          : Effect.die(result.failure.message);

        const providerWire = yield* encodeResult(readyResult);
        const roundTripped = yield* decodeResult(providerWire);
        const readyRoundTripped = yield* roundTripped.outcome === 'LINE_VALUES_PUBLISHED'
          ? Effect.succeed(roundTripped)
          : Effect.die(roundTripped.failure.message);

        expect(readyRoundTripped).toEqual(readyResult);
        expect(readyRoundTripped.publishedLines[0]?.publishedLineValue).toEqual({
          amount: expected.published,
          currencyCode: 'CZK',
        });
        expect(readyRoundTripped.publishedLines[0]?.roundingAdjustment).toEqual({
          amount: expected.adjustment,
          currencyCode: 'CZK',
        });
        expect(providerWire).toContain(`"amount":"${expected.published}"`);
        expect(providerWire).toContain(`"amount":"${expected.adjustment}"`);
      }
    }),
  );

  it.effect('rejects a provider representation that coerces a canonical amount to a JSON number', () =>
    Effect.gen(function* rejectsNumericCoercion() {
      const { preRound } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        priceAmount: '33.335',
      });
      const result = yield* publishPricingLineValues({
        candidateRef: preRound.rawComposition.candidateRef,
        decision: preRound.decision,
        preRound,
        publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
      });
      const readyResult = yield* result.outcome === 'LINE_VALUES_PUBLISHED'
        ? Effect.succeed(result)
        : Effect.die(result.failure.message);

      const providerWire = yield* encodeResult(readyResult);
      expect(yield* decodeResult(providerWire)).toEqual(readyResult);
      const numericallyCoercedWire = providerWire.replace('"amount":"33.34"', '"amount":33.34');

      expect(numericallyCoercedWire).not.toBe(providerWire);
      const decodeFailure = yield* Effect.flip(decodeResult(numericallyCoercedWire));
      expect(decodeFailure).toBeDefined();
    }),
  );
});
