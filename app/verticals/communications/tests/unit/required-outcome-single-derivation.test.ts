import { describe, expect, it } from 'effect-rstest';

import {
  decideOrThrow,
  FIXTURE_CLOSED_STATE,
  FIXTURE_ORIGINAL_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
  recipient,
} from './support/catalog-fixtures.ts';
import { attempt, recovery, stop } from './support/history-fixtures.ts';
import { feedOfDecision, feedOfFacts, feedSummary } from './support/required-feed.ts';

/**
 * [T3-02, #1394 AC-05 BR-08, #1396 BR-12 AC-09] ONE derivation answers what a required type owes the source about a request:
 * the one production uses to publish it. A source stop is the source owner's own change, so it is `SOURCE_STALE` and never a
 * Communications failure; the SAME fact is reported the same whether the source moved on before the decision or before the last
 * stoppable handoff. Anything the source did not cause stays `FAILED`.
 */
const stopped = (reasonCode: string, proven = true) => ({ stops: [stop({ proven, reasonCodes: [reasonCode] })] });

describe('a stop caused by the source owner is SOURCE_STALE, not a failure (BR-08)', () => {
  it.each([
    'SOURCE_CONSUMED',
    'SOURCE_EXPIRED',
    'SOURCE_NOT_RESUMABLE',
    'SOURCE_REVISION_NOT_CURRENT',
    'SOURCE_REVOKED',
    'SOURCE_STATE_INELIGIBLE',
    'SOURCE_SUPERSEDED',
    'SOURCE_NO_LONGER_VALID',
  ])(
    'a handoff-time stop %s reaches the source as SOURCE_STALE, with its specific reason and no partial result',
    (code) => {
      const feed = feedOfFacts('REQUIRED', [stopped(code)]);

      expect(feedSummary(feed)).toEqual({
        attentions: ['FAILURE'],
        partial: false,
        reasons: [code],
        requiredOutcome: 'SOURCE_STALE',
        sourceImpact: 'SOURCE_OWNER_DECIDES',
      });
    },
  );

  it('the same source change is SOURCE_STALE at the decision and at the last stoppable handoff', () => {
    const registry = fixtureRegistry(fixtureType({ requiredness: 'REQUIRED' }));
    const atDecision = feedOfDecision(
      decideOrThrow(
        registry,
        fixtureRequest(),
        fixtureContext([recipient(FIXTURE_ORIGINAL_ROLE, 'contact-a')], { state: FIXTURE_CLOSED_STATE }),
      ),
    );
    const atHandoff = feedOfFacts('REQUIRED', [stopped('SOURCE_STATE_INELIGIBLE')]);

    expect(atDecision.requiredOutcome).toBe('SOURCE_STALE');
    expect(atHandoff.requiredOutcome).toBe('SOURCE_STALE');
  });

  it('a source stop beside a stop the source did NOT cause is a failure, and partial only when something else is not', () => {
    expect(feedOfFacts('REQUIRED', [stopped('SOURCE_REVOKED'), stopped('PRIVACY_NOT_ALLOWED')])).toMatchObject({
      partial: false,
      requiredOutcome: 'FAILED',
    });
    expect(
      feedOfFacts('REQUIRED', [
        stopped('SOURCE_REVOKED'),
        stopped('PRIVACY_NOT_ALLOWED'),
        { attempts: [attempt('ACCEPTED')] },
      ]),
    ).toMatchObject({ partial: true, requiredOutcome: 'FAILED' });
  });

  it('a source stop beside an accepted message is SOURCE_STALE; beside work still owed it reports that work first', () => {
    expect(
      feedOfFacts('REQUIRED', [stopped('SOURCE_EXPIRED'), { attempts: [attempt('ACCEPTED')] }]).requiredOutcome,
    ).toBe('SOURCE_STALE');
    expect(feedOfFacts('REQUIRED', [stopped('SOURCE_EXPIRED'), {}]).requiredOutcome).toBe('IN_PROGRESS');
    expect(
      feedOfFacts('REQUIRED', [stopped('SOURCE_EXPIRED'), { attempts: [attempt('INDETERMINATE')] }]).requiredOutcome,
    ).toBe('UNKNOWN');
    expect(
      feedOfFacts('REQUIRED', [stopped('SOURCE_EXPIRED'), stopped('PRIVACY_OWNER_UNAVAILABLE', false)]).requiredOutcome,
    ).toBe('NEEDS_REEVALUATION');
  });

  it('what merely looks like a source stop is not one: a protected source, or a refusal after the source changed', () => {
    // a protected SOURCE is a Privacy stop; it is not the source owner moving on
    expect(feedOfFacts('REQUIRED', [stopped('SOURCE_PROTECTED')]).requiredOutcome).toBe('FAILED');
    // a provider refusal is a failure of the message even when its recovery was later stopped because the source moved on
    const refusedThenStale = {
      attempts: [attempt('REJECTED', { reason: 'rate_limited' })],
      recoveries: [recovery({ code: 'SOURCE_REVOKED', outcome: 'STOPPED', proven: true })],
    };
    expect(feedSummary(feedOfFacts('REQUIRED', [refusedThenStale]))).toMatchObject({
      attentions: ['FAILURE'],
      reasons: ['SOURCE_REVOKED'],
      requiredOutcome: 'FAILED',
    });
  });

  it('an optional type owes the source nothing even for a source stop', () => {
    expect(feedOfFacts('OPTIONAL', [stopped('SOURCE_REVOKED')]).requiredOutcome).toBe('NOT_REQUIRED');
  });
});
