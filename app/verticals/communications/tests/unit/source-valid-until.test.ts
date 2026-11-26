import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SourceCurrentness } from '../../src/domain/privacy/suppression.ts';
import { sourceCurrentnessOf } from '../../src/handoff/process-intent-handoff.ts';

/**
 * #1406: a source that states `occurrence.validUntil` (an issued link or code that expires) is no longer justified past it,
 * whatever its owner answers; a source that omits it means what it always meant. The type below is a fictional fixture.
 */

const TYPE = { currentness: { requireLatestSourceRevision: true }, eligibleSourceStates: ['fixture.current'] } as const;
const FACTS = { latestRevision: 1, state: 'fixture.current' } as const;
const NOW = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
const at = (iso: string) => Option.some(DateTime.makeUnsafe(iso));

describe('The source expiry stated by the request (#1406)', () => {
  it('stops a handoff at or past validUntil with the closed SOURCE_NO_LONGER_VALID reason', () => {
    for (const until of ['2026-11-19T10:00:00.000Z', '2026-11-19T09:59:59.000Z']) {
      const verdict = sourceCurrentnessOf(TYPE, 1, FACTS, at(until), NOW);
      expect(SourceCurrentness.$is('Stale')(verdict)).toBe(true);
      expect(verdict).toMatchObject({ reason: 'SOURCE_NO_LONGER_VALID' });
    }
  });

  it('is Current before validUntil, and when the request states none', () => {
    expect(
      SourceCurrentness.$is('Current')(sourceCurrentnessOf(TYPE, 1, FACTS, at('2026-11-19T10:00:01.000Z'), NOW)),
    ).toBe(true);
    expect(SourceCurrentness.$is('Current')(sourceCurrentnessOf(TYPE, 1, FACTS, Option.none(), NOW))).toBe(true);
  });

  it('never hides the owner facts: an ineligible state or a stale revision still stops while validUntil is in the future', () => {
    expect(
      sourceCurrentnessOf(TYPE, 1, { ...FACTS, state: 'fixture.other' }, at('2026-11-19T11:00:00.000Z'), NOW),
    ).toMatchObject({
      reason: 'SOURCE_STATE_INELIGIBLE',
    });
    expect(sourceCurrentnessOf(TYPE, 1, { ...FACTS, latestRevision: 2 }, Option.none(), NOW)).toMatchObject({
      reason: 'SOURCE_REVISION_NOT_CURRENT',
    });
  });
});
