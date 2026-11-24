import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { discountCandidates } from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import {
  interpretPricingDiscountApplicability,
  resolveCurrentPricingDiscountRevisions,
} from '../../src/services/discount-applicability.service.ts';
import { composePricingDiscounts } from '../../src/services/discount-composition.service.ts';
import { makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

// #1225: original occurrences of one Variant each receive the Price Group Discount that covers their basis. Genuinely
// competing Discounts for one occurrence and layer stay a conflict.
const scenarioFor = (occurrenceId: string) => makeIssue779Scenario({ discounts: ['0', '10', '0'], occurrenceId });

interface DiscountRevisionFixture {
  readonly amount: string;
  readonly discountId: string;
  readonly revisionId: string;
}

const priceGroupApplicability = (
  scenario: Effect.Success<ReturnType<typeof scenarioFor>>,
  revisionFixture: DiscountRevisionFixture,
) =>
  Effect.gen(function* applicabilityFor() {
    const candidate = scenario.compositionRequest.discountComposition.lineContributions
      .map(({ candidate: lineCandidate }) => lineCandidate)
      .find(({ layer }) => layer === 'PRICE_GROUP_CONTRACTUAL');
    if (candidate === undefined) {
      throw new Error('Fixture must provide a Price Group Discount candidate');
    }
    const { definition } = candidate;
    const scheduled = {
      definition: {
        discountId: revisionFixture.discountId,
        identityKey: definition.identityKey,
        revision: {
          ...definition.revision,
          configuredEffect: {
            kind: 'FIXED_MONETARY_AMOUNT' as const,
            level: { amount: revisionFixture.amount, currencyCode: 'CZK' },
          },
          revisionId: revisionFixture.revisionId,
        },
      },
      effectivePeriod: { effectiveFrom: definition.revision.effectiveFrom, effectiveTo: null },
      lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
    };
    const currentResolution = yield* resolveCurrentPricingDiscountRevisions(
      scheduled.definition.identityKey,
      [scheduled],
      scenario.compositionRequest.decision.operationTime,
    );
    return yield* interpretPricingDiscountApplicability({
      audienceBinding: candidate.audienceBinding,
      currencySupport: scenario.unitPrice.input.exactPrice.currencySupport,
      currentResolution,
    });
  });

const ten: DiscountRevisionFixture = {
  amount: '10',
  discountId: '31313131-3131-4313-8313-313131313132',
  revisionId: '41414141-4141-4414-8414-414141414142',
};
const twenty: DiscountRevisionFixture = {
  amount: '20',
  discountId: '31313131-3131-4313-8313-313131313133',
  revisionId: '41414141-4141-4414-8414-414141414143',
};

describe('Current Pricing Decision Discount candidates #1225', () => {
  it.effect('covers every original occurrence of one Variant with one Price Group Discount', () =>
    Effect.gen(function* coversEveryOccurrence() {
      const first = yield* scenarioFor('line-1225-a');
      const second = yield* scenarioFor('line-1225-b');
      const applicability = yield* priceGroupApplicability(first, ten);
      const { decision } = first.compositionRequest;

      const candidates = discountCandidates(applicability, { decision, subject: decision.purchasingContext.subject }, [
        first.unitPrice,
        second.unitPrice,
      ]);

      expect(
        candidates.map((candidate) => [
          candidate.kind,
          'occurrenceId' in candidate ? candidate.occurrenceId : undefined,
          candidate.layer,
          candidate.outcome,
        ]),
      ).toEqual([
        ['VARIANT_LINE', 'line-1225-a', 'PRICE_GROUP_CONTRACTUAL', 'DISCOUNT_APPLICABLE'],
        ['VARIANT_LINE', 'line-1225-b', 'PRICE_GROUP_CONTRACTUAL', 'DISCOUNT_APPLICABLE'],
      ]);
    }),
  );

  it.effect('keeps two different Discounts for one occurrence and layer a conflict', () =>
    Effect.gen(function* competingStayConflict() {
      const only = yield* scenarioFor('line-1225-a');
      const winning = yield* priceGroupApplicability(only, ten);
      const competing = yield* priceGroupApplicability(only, twenty);
      const { decision } = only.compositionRequest;
      const request = { decision, subject: decision.purchasingContext.subject };

      const candidates = [winning, competing].flatMap((applicability) =>
        discountCandidates(applicability, request, [only.unitPrice]),
      );

      expect(candidates).toHaveLength(2);
      const composed = yield* composePricingDiscounts({
        ...only.compositionRequest.discountComposition.request,
        candidates,
      });
      expect(composed).toMatchObject({
        conflict: { conflictKind: 'DISCOUNT_LAYER_CARDINALITY', path: { occurrenceId: 'line-1225-a' } },
        outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
      });
    }),
  );
});
