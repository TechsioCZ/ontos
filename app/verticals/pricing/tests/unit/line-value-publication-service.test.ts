import type { PricingLinePublicationRequest } from '@app/pricing-contracts/domain/rounding-boundary';
import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingFinalPreRoundReady } from '@app/pricing-contracts/domain/line-composition';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';

const requestFor = (
  preRound: PricingFinalPreRoundReady,
  publicationProfileVersion: string = PRICING_CZK_PUBLICATION_PROFILE_VERSION,
): PricingLinePublicationRequest => ({
  candidateRef: preRound.rawComposition.candidateRef,
  decision: preRound.decision,
  preRound,
  publicationProfileVersion,
});

describe('Pricing final-line publication runtime', () => {
  it.effect('rounds one post-guard original line HALF_UP and records its signed adjustment', () =>
    Effect.gen(function* roundsOneStableLine() {
      const { preRound } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        priceAmount: '33.335',
      });

      const result = yield* publishPricingLineValues(requestFor(preRound));

      expect(result).toMatchObject({
        outcome: 'LINE_VALUES_PUBLISHED',
        publishedLines: [
          {
            publishedLineValue: money('33.34'),
            roundingAdjustment: money('0.005'),
          },
        ],
      });
    }),
  );

  it.effect('retains a negative rounding adjustment without rounding an intermediate or total', () =>
    Effect.gen(function* retainsNegativeAdjustment() {
      const { preRound } = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        priceAmount: '33.334',
      });

      const result = yield* publishPricingLineValues(requestFor(preRound));

      expect(result).toMatchObject({
        outcome: 'LINE_VALUES_PUBLISHED',
        publishedLines: [
          {
            publishedLineValue: money('33.33'),
            roundingAdjustment: money('-0.004'),
          },
        ],
      });
      expect(result).not.toHaveProperty('pricingNetCommercialTotal');
    }),
  );

  it.effect('publishes zero only after a raw-negative line has passed the governed ZERO_FLOOR guard', () =>
    Effect.gen(function* publishesGuardedZero() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['40', '40', '40'] });

      const result = yield* publishPricingLineValues(requestFor(preRound));

      expect(result).toMatchObject({
        outcome: 'LINE_VALUES_PUBLISHED',
        publishedLines: [{ publishedLineValue: money('0'), roundingAdjustment: money('0') }],
        sourceEvidence: {
          preRound: {
            lines: [
              {
                floorEvaluation: {
                  floorAdjustment: money('20'),
                  kind: 'AUTHORIZED_ZERO_FLOOR',
                  rawPostCompositionValue: money('-20'),
                },
              },
            ],
          },
        },
      });
    }),
  );

  it.effect('rejects a raw-negative line before rounding when ZERO_FLOOR has not authorized it', () =>
    Effect.gen(function* rejectsUnguardedNegative() {
      const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'] });
      const [line] = preRound.lines;
      if (line === undefined) {
        throw new Error('Issue #781 fixture requires one original Pricing line');
      }
      const unguardedLine = {
        ...line,
        composition: {
          ...line.composition,
          rawPostCompositionValue: money('-0.004'),
        },
      };
      const unguarded: PricingFinalPreRoundReady = { ...preRound, lines: [unguardedLine] };

      expect(yield* publishPricingLineValues(requestFor(unguarded))).toMatchObject({
        failure: { code: 'RAW_NEGATIVE_UNGUARDED' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
    }),
  );

  it.effect('fails typed for mixed currency or unknown profiles and does not activate EUR or FX', () =>
    Effect.gen(function* rejectsUnsupportedPublication() {
      const { preRound: czk } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'] });
      const { preRound: eur } = yield* makeIssue779PreRoundScenario({
        currencyCode: 'EUR',
        discounts: ['0', '0', '0'],
      });
      const [czkLine] = czk.lines;
      const [czkRawLine] = czk.rawComposition.lines;
      if (czkLine === undefined || czkRawLine === undefined) {
        throw new Error('Issue #781 mixed-currency fixture requires one complete original line');
      }
      const eurPrePromotion = money(czkLine.composition.prePromotionValue.amount, 'EUR');
      const mixedCurrency: PricingFinalPreRoundReady = {
        ...czk,
        lines: [
          {
            ...czkLine,
            composition: { ...czkLine.composition, prePromotionValue: eurPrePromotion },
          },
        ],
        rawComposition: {
          ...czk.rawComposition,
          lines: [{ ...czkRawLine, prePromotionValue: eurPrePromotion }],
        },
      };

      expect(yield* publishPricingLineValues(requestFor(czk, 'pricing-publication-unknown'))).toMatchObject({
        failure: { code: 'UNSUPPORTED_PROFILE' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
      expect(yield* publishPricingLineValues(requestFor(mixedCurrency))).toMatchObject({
        failure: { code: 'CURRENCY_MISMATCH' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
      expect(yield* publishPricingLineValues(requestFor(eur))).toMatchObject({
        failure: { code: 'UNSUPPORTED_CURRENCY' },
        outcome: 'LINE_PUBLICATION_FAILED',
      });
    }),
  );
});
