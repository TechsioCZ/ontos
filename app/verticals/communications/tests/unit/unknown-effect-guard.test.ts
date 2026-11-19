import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { canAttemptAfterUnknownEffect, unknownEffectBlock } from '../../src/domain/history/unknown-effect.ts';
import type { FreshEligibility } from '../../src/domain/history/unknown-effect.ts';
import { attempt, factsOf, minute, observation } from './support/history-fixtures.ts';

/**
 * [#1402 H-06 H-08 AC-04] The guard the retry lane calls before any attempt that could duplicate an earlier one: false until a
 * reconciliation proved non-acceptance AND a Current eligibility was evaluated after it, and false forever after an acceptance.
 */
const eligibleAt = (offset: number, eligible = true): Option.Option<FreshEligibility> =>
  Option.some({ eligible, evaluatedAt: minute(offset) });

describe('canAttemptAfterUnknownEffect', () => {
  it('is false while the effect is unknown, however eligible the message is now', () => {
    for (const state of ['PREPARED', 'INDETERMINATE', 'UNAVAILABLE'] as const) {
      const facts = factsOf({ attempts: [attempt(state)] });
      expect(canAttemptAfterUnknownEffect(facts, eligibleAt(99))).toBe(false);
      expect(unknownEffectBlock(facts, eligibleAt(99))).toEqual(Option.some('RECONCILIATION_REQUIRED'));
    }
  });

  it('stays false when the only reconciliation is an acceptance: a second send would duplicate it', () => {
    const facts = factsOf({
      attempts: [attempt('INDETERMINATE')],
      observations: [observation('ACCEPTANCE_PROVEN', { observed: 10 })],
    });
    expect(canAttemptAfterUnknownEffect(facts, eligibleAt(99))).toBe(false);
    expect(unknownEffectBlock(facts, eligibleAt(99))).toEqual(Option.some('ACCEPTANCE_ALREADY_PROVEN'));
  });

  it('stays false after an accepted answer, a delivery or a failure after acceptance: that is an Explicit Resend, not a retry', () => {
    expect(canAttemptAfterUnknownEffect(factsOf({ attempts: [attempt('ACCEPTED')] }), eligibleAt(99))).toBe(false);
    expect(
      canAttemptAfterUnknownEffect(
        factsOf({
          attempts: [attempt('ACCEPTED')],
          observations: [observation('DELIVERY_FAILED', { failureClass: 'BOUNCED_PERMANENT', observed: 10 })],
        }),
        eligibleAt(99),
      ),
    ).toBe(false);
  });

  it('is true only with proven non-acceptance AND a Current eligibility evaluated after that evidence', () => {
    const facts = factsOf({
      attempts: [attempt('INDETERMINATE')],
      observations: [observation('NON_ACCEPTANCE_PROVEN', { observed: 10, recorded: 20 })],
    });
    expect(canAttemptAfterUnknownEffect(facts, eligibleAt(21))).toBe(true);
    // an evaluation made BEFORE (or at the instant of) the reconciliation is a retained answer, not a Current one
    expect(unknownEffectBlock(facts, eligibleAt(19))).toEqual(Option.some('ELIGIBILITY_NOT_FRESH'));
    expect(unknownEffectBlock(facts, eligibleAt(20))).toEqual(Option.some('ELIGIBILITY_NOT_FRESH'));
    expect(unknownEffectBlock(facts, Option.none())).toEqual(Option.some('ELIGIBILITY_NOT_FRESH'));
    // a fresh evaluation that does not allow the message does not allow the send
    expect(unknownEffectBlock(facts, eligibleAt(21, false))).toEqual(Option.some('ELIGIBILITY_NOT_ELIGIBLE'));
  });

  it('never resolves contradictory evidence in favour of sending', () => {
    const facts = factsOf({
      attempts: [attempt('INDETERMINATE')],
      observations: [
        observation('ACCEPTANCE_PROVEN', { observed: 10 }),
        observation('NON_ACCEPTANCE_PROVEN', { observed: 11 }),
      ],
    });
    expect(unknownEffectBlock(facts, eligibleAt(99))).toEqual(Option.some('CONTRADICTORY_EVIDENCE'));
  });

  it('says false for the attempt a reconciliation of ANOTHER attempt did not resolve', () => {
    const facts = factsOf({
      attempts: [
        attempt('INDETERMINATE', { number: 1 }),
        attempt('INDETERMINATE', { id: '22222222-2222-4222-8222-222222222222', number: 2, prepared: 5 }),
      ],
      observations: [observation('NON_ACCEPTANCE_PROVEN', { observed: 10, recorded: 20 })],
    });
    expect(canAttemptAfterUnknownEffect(facts, eligibleAt(99))).toBe(false);
  });
});
