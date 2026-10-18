import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  MAX_LINE_QUANTITY,
  manualOpportunityLine,
  isSafeOpportunityAmount,
  filterItemsByQuery,
  isValidQuantity,
  skipTally,
  sortNewestFirst,
  stageRank,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-model.ts';

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

it('filters customer labels by the typed text and keeps the picked label listed', () => {
  const items = [{ label: 'Kroměřížská tiskárna s.r.o.' }, { label: 'Pražská pekárna' }];
  expect(filterItemsByQuery(items, 'Kro')).toEqual([items[0]]);
  expect(filterItemsByQuery(items, 'prazska')).toEqual([items[1]]);
  expect(filterItemsByQuery(items, '  ')).toEqual(items);
  expect(filterItemsByQuery(items, items[0].label, items[0].label)).toEqual(items);
});

it('ranks stages in pipeline order, not by code name', () => {
  // Code order would put LOST before NEGOTIATION and WON; the pipeline puts them after PROPOSAL.
  const pipelineOrder = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;
  expect(pipelineOrder.map((stage) => stageRank(stage))).toEqual([0, 1, 2, 3, 4, 5]);
});

it('accepts only whole line quantities of at least 1', () => {
  expect([1, 5, 120].map((value) => isValidQuantity(value))).toEqual([true, true, true]);
  expect([0, -5, 1.5, Number.NaN].map((value) => isValidQuantity(value))).toEqual([false, false, false, false]);
});

it('caps one line quantity at the form maximum', () => {
  expect([MAX_LINE_QUANTITY, MAX_LINE_QUANTITY + 1, 999_999_999].map((value) => isValidQuantity(value))).toEqual([
    true,
    false,
    false,
  ]);
});

it('keeps a priced rental period without a catalog product identity', () => {
  expect(Option.getOrUndefined(manualOpportunityLine(' Budova Parková, listopad 2026 ', 2, 12_500.25, 0))).toEqual({
    productName: 'Budova Parková, listopad 2026',
    quantity: 2,
    unitPriceMinor: 1_250_025,
    vatRate: 0,
  });
});
it('rejects incomplete, negative, fractional-period and unsafe rental amounts', () => {
  expect(Option.isNone(manualOpportunityLine(' ', 1, 200, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', 1, -1, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', 1, -0.001, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', 1, Number.NaN, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', 1, Number.POSITIVE_INFINITY, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', Number.NaN, 200, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', 1.5, 200, 21))).toBe(true);
  expect(Option.isNone(manualOpportunityLine('Rent', 2, Number.MAX_SAFE_INTEGER / 100, 21))).toBe(true);
});

it('rejects an unsafe quantity edit and an unsafe sum of individually valid rent lines', () => {
  const line = Option.getOrThrow(manualOpportunityLine('Rent', 1, 40_000_000_000_000, 0));
  expect(isSafeOpportunityAmount([line, line])).toBe(true);
  expect(isSafeOpportunityAmount([line, line, line])).toBe(false);
  expect(isSafeOpportunityAmount([{ ...line, quantity: 3 }])).toBe(false);
  expect(isSafeOpportunityAmount([{ ...line, quantity: 2 }])).toBe(true);
});
