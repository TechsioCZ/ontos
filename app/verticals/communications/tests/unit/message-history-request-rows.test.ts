import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { HistorySlotKeySchema } from '../../shared/communication-history.ts';
import {
  NotARequestLevelRow,
  projectMessageHistoryItem,
  projectRequestHistoryItem,
} from '../../src/history/message-history-projection.ts';
import { intentRecord, requestRecord } from './support/access-fixtures.ts';
import { factsOf } from './support/history-fixtures.ts';

/**
 * [#1402 H-01 H-03 AC-01; #1401 I-07 AC-06] A request the catalog decided no message for, or that left a slot unresolved, is a
 * readable row of its own, and NO_MESSAGE, SUPPRESSED and NOT_SENT are three distinct states.
 */
const SLOT = HistorySlotKeySchema.make('approver');
const withMask = { includeEndpointMask: true };
const project = (intent = intentRecord()) => projectMessageHistoryItem(requestRecord([intent]), intent, withMask);

describe('A request with no message or an unresolved slot is a readable row of its own', () => {
  it.effect('[H-01 H-03] a catalog no-message decision is NO_MESSAGE with its closed reason and no message', () =>
    Effect.gen(function* noMessage() {
      const request = requestRecord([], undefined, { noMessageReason: 'NO_RULE_MATCHED' });
      const row = yield* projectRequestHistoryItem(request);
      expect(row).toMatchObject({
        headline: { reasonCodes: ['NO_RULE_MATCHED'], status: 'NO_MESSAGE' },
        source: { moduleId: 'fixture.source', occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 1 } },
        unresolvedSlots: [],
      });
      expect(row).not.toHaveProperty('intentId');
    }),
  );

  it.effect(
    '[I-07] a slot no legal recipient was found for is NOT_SENT with its closed reason, beside the messages',
    () =>
      Effect.gen(function* unresolved() {
        const request = requestRecord([intentRecord()], undefined, {
          unresolvedSlots: [{ reason: 'RECIPIENT_AMBIGUOUS', slotKey: SLOT }],
        });
        const row = yield* projectRequestHistoryItem(request);
        expect(row).toMatchObject({
          headline: { reasonCodes: [], status: 'NOT_SENT' },
          unresolvedSlots: [{ reason: 'RECIPIENT_AMBIGUOUS', slotKey: 'approver' }],
        });
      }),
  );

  it.effect('a request with neither is not a request-level row, and a free-text reason is never shown', () =>
    Effect.gen(function* neither() {
      const failure = yield* projectRequestHistoryItem(requestRecord([intentRecord()])).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(NotARequestLevelRow);
      const dirty = yield* projectRequestHistoryItem(
        requestRecord([], undefined, { noMessageReason: 'see someone@example.test' }),
      );
      expect(dirty.headline.reasonCodes).toEqual([]);
    }),
  );

  it.effect('[H-03 I-07] NO_MESSAGE, SUPPRESSED and NOT_SENT stay three distinct published states', () =>
    Effect.gen(function* distinct() {
      const suppressed = yield* project(
        intentRecord({ facts: factsOf({ intentStatus: 'SUPPRESSED', reason: 'PRIVACY_NOT_ALLOWED' }) }),
      );
      const notSent = yield* project(
        intentRecord({ facts: factsOf({ intentStatus: 'NOT_SENT', reason: 'TEMPLATE_UNAVAILABLE' }) }),
      );
      const noMessage = yield* projectRequestHistoryItem(requestRecord([], undefined, { noMessageReason: 'X' }));
      expect([suppressed.headline.status, notSent.headline.status, noMessage.headline.status]).toEqual([
        'SUPPRESSED',
        'NOT_SENT',
        'NO_MESSAGE',
      ]);
      expect(notSent.headline.reasonCodes).toEqual(['TEMPLATE_UNAVAILABLE']);
    }),
  );
});
