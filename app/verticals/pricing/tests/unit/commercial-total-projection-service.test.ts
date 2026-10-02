import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCommercialTotalProjectionUnverifiable,
  projectPricingCommercialTotal,
} from '../../src/services/commercial-total-projection.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { candidateRef, makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';

const readyCommercialTotal = Effect.fn('test.readyCommercialTotal')(function* readyCommercialTotalProgram() {
  const { preRound } = yield* makeIssue779PreRoundScenario({
    feeAmount: '10',
    promotionAmount: '-10',
  });
  const [line] = preRound.lines;
  if (line === undefined) {
    return yield* Effect.die('The #779 fixture must preserve one pre-round line');
  }

  const result = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: [
      {
        occurrenceId: line.occurrenceId,
        publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
        publishedLineValue: line.nonNegativePreRoundValue,
        roundingAdjustment: money('0'),
      },
    ],
  });
  if (result.outcome === 'COMMERCIAL_TOTAL_FAILED') {
    return yield* Effect.die(result.failure.message);
  }
  return result;
});

describe('Pricing commercial-total safe projection', () => {
  it.effect('publishes one pre-Tax total without exposing internal evidence or adding Fees twice', () =>
    Effect.gen(function* publishesOnlySafePricingFields() {
      const canonical = yield* readyCommercialTotal();
      const projection = yield* projectPricingCommercialTotal(canonical);

      expect(projection).toEqual({
        candidateRef: canonical.candidateRef,
        currencyCode: 'CZK',
        lines: canonical.publishedLines.map(({ occurrenceId, publishedLineValue }) => ({
          occurrenceId,
          publishedLineValue,
        })),
        monetaryBoundary: 'PRE_TAX',
        pricingNetCommercialTotal: canonical.pricingNetCommercialTotal,
      });
      expect(canonical.breakdown).toMatchObject({
        baseLineTotal: money('100'),
        commercialFeeTotal: money('10'),
        pricingOwnedDiscountTotal: money('-30'),
        promotionAllocationTotal: money('-10'),
      });
      expect(projection.pricingNetCommercialTotal).toEqual(money('70'));
      expect(projection.lines[0]).not.toHaveProperty('publicationProfile');
      expect(projection.lines[0]).not.toHaveProperty('roundingAdjustment');
      expect(projection).not.toHaveProperty('breakdown');
      expect(projection).not.toHaveProperty('decision');
      expect(projection).not.toHaveProperty('sourceEvidence');
      expect(projection).not.toHaveProperty('shippingAllocations');
      expect(projection).not.toHaveProperty('commercialFeeTotal');
      expect(projection).not.toHaveProperty('pricingOwnedDiscountTotal');
      expect(projection).not.toHaveProperty('promotionAllocationTotal');
      expect(projection).not.toHaveProperty('zeroFloorAdjustmentTotal');
      expect(projection).not.toHaveProperty('pricingLineRoundingAdjustmentTotal');
    }),
  );

  it.effect('maps a canonical failure to one typed non-publishable outcome', () =>
    Effect.gen(function* refusesFailedCanonicalTotal() {
      const failure = yield* Effect.flip(
        projectPricingCommercialTotal({
          candidateRef,
          failure: {
            code: 'CURRENCY_MISMATCH',
            message: 'Currencies cannot be mixed or relabeled',
            retryable: false,
          },
          outcome: 'COMMERCIAL_TOTAL_FAILED',
        }),
      );

      expect(failure).toBeInstanceOf(PricingCommercialTotalProjectionUnverifiable);
      expect(failure).toMatchObject({
        code: 'CURRENCY_MISMATCH',
        reason: 'Currencies cannot be mixed or relabeled',
        retryable: false,
      });
    }),
  );

  it.effect('rejects altered algebra and forbidden downstream totals instead of publishing them', () =>
    Effect.gen(function* rejectsUnsafeCommercialTotals() {
      const canonical = yield* readyCommercialTotal();
      const invalidCandidates = [
        {
          ...canonical,
          pricingNetCommercialTotal: money('80'),
        },
        {
          ...canonical,
          breakdown: {
            ...canonical.breakdown,
            commercialFeeTotal: money('10', 'EUR'),
          },
        },
        {
          ...canonical,
          shippingTotal: money('12'),
        },
        {
          ...canonical,
          deliveryTotal: money('12'),
        },
        {
          ...canonical,
          taxTotal: money('15'),
        },
        {
          ...canonical,
          grossTotal: money('85'),
        },
        {
          ...canonical,
          finalPayable: money('97'),
        },
        {
          ...canonical,
          storefrontId: 'storefront:forbidden',
        },
        {
          ...canonical,
          fxRate: '1',
        },
      ];

      for (const candidate of invalidCandidates) {
        const failure = yield* Effect.flip(projectPricingCommercialTotal(candidate));
        expect(failure).toBeInstanceOf(PricingCommercialTotalProjectionUnverifiable);
        expect(failure).toMatchObject({ code: 'PROJECTION_UNVERIFIABLE', retryable: true });
      }
    }),
  );
});
