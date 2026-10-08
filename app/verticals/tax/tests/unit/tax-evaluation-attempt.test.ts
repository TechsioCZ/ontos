import { Effect, Option, Ref } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TAX_EVALUATION_MAX_ATTEMPTS,
  evaluateWithBoundedRetry,
  taxEvaluationStateChange,
} from '../../src/domain/tax-evaluation-attempt.ts';
import type { TaxEvaluationStateTokens } from '../../src/domain/tax-evaluation-attempt.ts';

const tokens = (ruleSet: string, seller: string): TaxEvaluationStateTokens => ({
  ruleSets: new Map([['cz-standard-goods', { outcome: 'SELECTED', setFingerprint: ruleSet }]]),
  seller: { reason: 'AUTHORITATIVE_POSITIVE', setFingerprint: seller, state: 'CURRENT_POSITIVE' },
});

/** Each observation returns the next scripted state; the evaluation echoes the state it was given. */
const run = (observations: readonly TaxEvaluationStateTokens[]) =>
  Effect.gen(function* scriptedRun() {
    const position = yield* Ref.make(0);
    const observe = Ref.getAndUpdate(position, (index) => index + 1).pipe(
      Effect.map((index) => observations[Math.min(index, observations.length - 1)] ?? tokens('missing', 'missing')),
    );
    return yield* evaluateWithBoundedRetry({ evaluate: (state) => state, observe, tokensOf: (state) => state });
  });

describe('Evaluation-local currentness check with bounded retry (#942 F17-F19)', () => {
  it.effect('publishes when the re-read state equals the state the candidate used', () =>
    Effect.gen(function* stable() {
      const result = yield* run([tokens('r1', 's1'), tokens('r1', 's1')]);

      expect(result.published).toEqual(Option.some({ output: tokens('r1', 's1'), state: tokens('r1', 's1') }));
      expect(result.attempts).toBe(1);
      expect(result.discarded).toEqual([]);
    }),
  );

  it.effect('#942 BDD material set change discards the obsolete candidate and retries on fresh state only', () =>
    Effect.gen(function* changed() {
      const result = yield* run([tokens('r1', 's1'), tokens('r2', 's1'), tokens('r2', 's1'), tokens('r2', 's1')]);

      expect(result.published).toEqual(Option.some({ output: tokens('r2', 's1'), state: tokens('r2', 's1') }));
      expect(result.attempts).toBe(2);
      expect(result.discarded).toEqual([{ attempt: 1, discardedBecause: 'RULE_SET_CHANGED' }]);
    }),
  );

  it.effect('#942 F19 persistent change exhausts the bound without publishing a candidate', () =>
    Effect.gen(function* exhausted() {
      const result = yield* run([
        tokens('r1', 's1'),
        tokens('r1', 's2'),
        tokens('r1', 's3'),
        tokens('r1', 's4'),
        tokens('r1', 's5'),
        tokens('r1', 's6'),
      ]);

      expect(Option.isNone(result.published)).toBe(true);
      expect(result.lastObserved).toEqual(tokens('r1', 's6'));
      expect(result.attempts).toBe(TAX_EVALUATION_MAX_ATTEMPTS);
      expect(result.discarded.map(({ discardedBecause }) => discardedBecause)).toEqual([
        'SELLER_STATE_CHANGED',
        'SELLER_STATE_CHANGED',
        'SELLER_STATE_CHANGED',
      ]);
    }),
  );

  it('a changed rule-set outcome or seller state with an equal fingerprint is still a change', () => {
    const before = tokens('r1', 's1');

    expect(
      taxEvaluationStateChange(before, {
        ...before,
        ruleSets: new Map([['cz-standard-goods', { outcome: 'TAX_RULE_OVERLAP', setFingerprint: 'r1' }]]),
      }),
    ).toEqual(Option.some('RULE_SET_CHANGED'));
    expect(taxEvaluationStateChange(before, { ...before, seller: { ...before.seller, state: 'STALE' } })).toEqual(
      Option.some('SELLER_STATE_CHANGED'),
    );
    expect(taxEvaluationStateChange(before, tokens('r1', 's1'))).toEqual(Option.none());
  });
});
