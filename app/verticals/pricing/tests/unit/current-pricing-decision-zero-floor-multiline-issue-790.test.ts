import type { PricingRawCompositionReady } from '@app/pricing-contracts/domain/line-composition';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { evaluatePricingLineValues } from '../../src/services/line-value-calculation.service.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { authorizationSetFor, firstRawLine, makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const twoNegativeLines = Effect.fn('test.twoNegativeZeroFloorLines')(function* twoNegativeZeroFloorLines() {
  const firstFixture = yield* makeIssue779Scenario({
    discounts: ['40', '40', '40'],
    occurrenceId: 'line-790-floor-a',
  });
  const secondFixture = yield* makeIssue779Scenario({
    discounts: ['40', '40', '40'],
    occurrenceId: 'line-790-floor-b',
  });
  const firstRaw = yield* composePricingRawLines(firstFixture.compositionRequest);
  const secondRaw = yield* composePricingRawLines(secondFixture.compositionRequest);
  if (firstRaw.outcome !== 'RAW_COMPOSITION_READY' || secondRaw.outcome !== 'RAW_COMPOSITION_READY') {
    return yield* Effect.die('Issue #790 multi-line fixture requires two ready raw-negative lines');
  }
  const firstLine = firstRawLine(firstRaw.lines);
  const originalSecondLine = firstRawLine(secondRaw.lines);
  const secondPricingBasis = { ...originalSecondLine.line.pricingBasis, quantity: '2' };
  const secondDecisionLine = { ...originalSecondLine.line, pricingBasis: secondPricingBasis };
  const secondLine = {
    ...originalSecondLine,
    line: secondDecisionLine,
    unitPriceCalculation: {
      ...originalSecondLine.unitPriceCalculation,
      input: {
        ...originalSecondLine.unitPriceCalculation.input,
        line: secondDecisionLine,
      },
    },
  };
  const composition: PricingRawCompositionReady = {
    ...firstRaw,
    decision: {
      ...firstRaw.decision,
      lines: [firstLine.line, secondDecisionLine],
    },
    lines: [firstLine, secondLine],
  };
  return {
    composition,
    firstAuthorizationSet: authorizationSetFor(firstLine),
    firstLine,
    secondAuthorizationSet: authorizationSetFor(secondLine),
    secondLine,
  };
});

describe('Current Pricing Decision multi-line ZERO_FLOOR authority #790', () => {
  it.effect('applies distinct occurrence-bound Current authorizations to different negative lines', () =>
    Effect.gen(function* distinctLineAuthorizations() {
      const scenario = yield* twoNegativeLines();

      const result = yield* evaluatePricingLineValues({
        authorizationSets: [
          {
            authorizationSet: scenario.firstAuthorizationSet,
            occurrenceId: scenario.firstLine.occurrenceId,
          },
          {
            authorizationSet: scenario.secondAuthorizationSet,
            occurrenceId: scenario.secondLine.occurrenceId,
          },
        ],
        composition: scenario.composition,
      });

      expect(result).toMatchObject({
        lines: [
          {
            floorEvaluation: {
              authorization: { businessScope: { pricingBasis: scenario.firstLine.line.pricingBasis } },
              kind: 'AUTHORIZED_ZERO_FLOOR',
            },
            occurrenceId: scenario.firstLine.occurrenceId,
          },
          {
            floorEvaluation: {
              authorization: { businessScope: { pricingBasis: scenario.secondLine.line.pricingBasis } },
              kind: 'AUTHORIZED_ZERO_FLOOR',
            },
            occurrenceId: scenario.secondLine.occurrenceId,
          },
        ],
        outcome: 'PRE_ROUND_LINE_VALUES_READY',
      });
    }),
  );

  it.effect('fails typed when one negative line has no applicable authorization or occurrence-bound read', () =>
    Effect.gen(function* missingLineAuthorization() {
      const scenario = yield* twoNegativeLines();
      const missingAuthorization = yield* evaluatePricingLineValues({
        authorizationSets: [
          {
            authorizationSet: scenario.firstAuthorizationSet,
            occurrenceId: scenario.firstLine.occurrenceId,
          },
          {
            authorizationSet: { ...scenario.secondAuthorizationSet, authorizations: [] },
            occurrenceId: scenario.secondLine.occurrenceId,
          },
        ],
        composition: scenario.composition,
      });
      expect(missingAuthorization).toMatchObject({
        kind: 'ZERO_FLOOR_FAILED',
        occurrenceId: scenario.secondLine.occurrenceId,
        reasonCode: 'AUTHORIZATION_ABSENT',
        retryable: false,
      });

      const missingRead = yield* evaluatePricingLineValues({
        authorizationSets: [
          {
            authorizationSet: scenario.firstAuthorizationSet,
            occurrenceId: scenario.firstLine.occurrenceId,
          },
          {
            authorizationSet: scenario.secondAuthorizationSet,
            occurrenceId: 'line-790-floor-unbound',
          },
        ],
        composition: scenario.composition,
      });
      expect(missingRead).toMatchObject({
        kind: 'ZERO_FLOOR_FAILED',
        occurrenceId: scenario.secondLine.occurrenceId,
        reasonCode: 'AUTHORIZATION_UNVERIFIABLE',
        retryable: false,
      });
    }),
  );
});
