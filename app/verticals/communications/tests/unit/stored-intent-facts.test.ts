import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { stopReasonCodeOf } from '../../src/domain/history/timeline.ts';
import { StoredIntentFactsSchema, timelineFactsOfStored } from '../../src/history/stored-intent-facts.ts';

/**
 * [#1406 #1409] A stop is shown under ONE closed code, and both readers of the stored stops (the scoped read routine the worker
 * uses and the history service) derive it with `stopReasonCodeOf`: a source lifecycle stop keeps the category `SOURCE_STALE` for the
 * gates but is shown as its specific cause; every other stop is shown as its category.
 */
describe('the closed code a stop is shown under', () => {
  it('shows a source lifecycle stop as its specific cause and every other stop as its category', () => {
    for (const cause of [
      'SOURCE_CONSUMED',
      'SOURCE_EXPIRED',
      'SOURCE_NO_LONGER_VALID',
      'SOURCE_NOT_RESUMABLE',
      'SOURCE_REVISION_NOT_CURRENT',
      'SOURCE_REVOKED',
      'SOURCE_STATE_INELIGIBLE',
      'SOURCE_SUPERSEDED',
    ]) {
      expect(stopReasonCodeOf({ category: 'SOURCE_STALE', cause })).toBe(cause);
    }
    expect(stopReasonCodeOf({ category: 'PRIVACY_NOT_ALLOWED', cause: 'OBJECTION' })).toBe('PRIVACY_NOT_ALLOWED');
    expect(stopReasonCodeOf({ category: 'DOCUMENT_MEDIA_UNAVAILABLE', cause: 'DOCUMENT_MEDIA_UNAVAILABLE' })).toBe(
      'DOCUMENT_MEDIA_UNAVAILABLE',
    );
  });

  it('decodes the stored stops of the read routine into their closed codes', () => {
    const stored = Schema.decodeUnknownSync(StoredIntentFactsSchema)({
      attempts: [],
      conflicts: [],
      documents: [],
      observations: [],
      recoveries: [],
      stops: [
        {
          evaluationSeq: 1,
          proven: true,
          reasons: [
            { category: 'SOURCE_STALE', cause: 'SOURCE_REVOKED' },
            { category: 'PRIVACY_INDETERMINATE', cause: 'EVIDENCE_MISSING' },
          ],
          recordedAt: '2026-11-20T10:00:00.000Z',
        },
      ],
    });
    expect(timelineFactsOfStored(stored).stops.map(({ reasonCodes }) => reasonCodes)).toEqual([
      ['SOURCE_REVOKED', 'PRIVACY_INDETERMINATE'],
    ]);
  });
});
