import { describe, expect, it } from 'effect-rstest';

import { awaitsFirstOutcome } from '../../src/domain/history/awaits-outcome.ts';
import { attempt, factsOf, observation } from './support/history-fixtures.ts';

/**
 * [#1403 review R-05] An original that can still be delivered by the ordinary step is not resent. It is final only with a known
 * effect of an attempt that may have left, a proven stop, or a closed intent.
 */
describe('awaitsFirstOutcome', () => {
  it('waits while there is no attempt, only attempts that made no request, or only an unknown effect', () => {
    expect(awaitsFirstOutcome(factsOf({}))).toBe(true);
    expect(awaitsFirstOutcome(factsOf({ attempts: [attempt('NOT_ATTEMPTED')] }))).toBe(true);
    expect(awaitsFirstOutcome(factsOf({ attempts: [attempt('UNAVAILABLE', { reason: 'configuration' })] }))).toBe(true);
    expect(awaitsFirstOutcome(factsOf({ attempts: [attempt('INDETERMINATE')] }))).toBe(true);
  });

  it('is final with an accepted or provably refused attempt, or a reconciled non-acceptance', () => {
    expect(awaitsFirstOutcome(factsOf({ attempts: [attempt('ACCEPTED')] }))).toBe(false);
    expect(awaitsFirstOutcome(factsOf({ attempts: [attempt('REJECTED', { reason: 'provider_rejected' })] }))).toBe(
      false,
    );
    expect(
      awaitsFirstOutcome(
        factsOf({
          attempts: [attempt('INDETERMINATE')],
          observations: [observation('NON_ACCEPTANCE_PROVEN', { observed: 10, recorded: 20 })],
        }),
      ),
    ).toBe(false);
  });

  it('is final once the intent is no longer pending', () => {
    const closed = factsOf({});
    expect(awaitsFirstOutcome({ ...closed, intent: { ...closed.intent, status: 'SUPPRESSED' } })).toBe(false);
  });
});
