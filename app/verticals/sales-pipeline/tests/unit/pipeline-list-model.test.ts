import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import { skipTally, sortNewestFirst } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-model.ts';

const idOf = (suffix: number) => `0196a8a0-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
const partyId = '0196a8a0-0000-7000-8000-0000000000aa';

const opportunity = (suffix: number, createdAt: string) =>
  Schema.decodeUnknownSync(OpportunitySchema)({
    amountMinor: 0,
    createdAt,
    currency: 'CZK',
    expectedCloseDate: '2026-11-30',
    id: idOf(suffix),
    lines: [],
    partyId,
    probability: 10,
    stage: 'LEAD',
    stageHistory: [],
    title: `Příležitost ${suffix}`,
    updatedAt: '2026-10-13T08:00:00.000Z',
  });

const decodeResult = Schema.decodeUnknownSync(ApplyCommandResultSchema);

it('lists the newest opportunity first', () => {
  const rows = sortNewestFirst([
    opportunity(1, '2026-09-01T08:00:00.000Z'),
    opportunity(2, '2026-10-12T08:00:00.000Z'),
    opportunity(3, '2026-10-01T08:00:00.000Z'),
  ]);
  expect(rows.map((row) => row.id)).toEqual([idOf(2), idOf(3), idOf(1)]);
});

it('counts bulk skips by reason', () => {
  const tally = skipTally(
    4,
    decodeResult({
      opportunities: [],
      results: [
        { id: idOf(1), outcome: 'changed' },
        { id: idOf(2), outcome: 'skipped', reason: 'closed' },
        { id: idOf(3), outcome: 'skipped', reason: 'closed' },
        { id: idOf(4), outcome: 'skipped', reason: 'not_found' },
      ],
      revision: 7,
    }),
  );
  expect(tally).toEqual({ closed: 2, invalidTransition: 0, notFound: 1, other: 0, total: 3 });
});

it('counts an unchanged single-record command as skipped without a reason', () => {
  const tally = skipTally(1, decodeResult({ opportunities: [], revision: 7 }));
  expect(tally).toEqual({ closed: 0, invalidTransition: 0, notFound: 0, other: 1, total: 1 });
  expect(skipTally(0, decodeResult({ opportunities: [], revision: 7 })).total).toBe(0);
});
