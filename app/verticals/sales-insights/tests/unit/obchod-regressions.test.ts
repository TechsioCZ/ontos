import { Array as EffectArray, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { RecordsResponseSchema } from '@app/work-tasks/contracts/records';
import { computeMetric, computePipelineSummary } from '../../shared/metrics.ts';
import type { MetricInputs } from '../../shared/metrics.ts';

it('accepts the work producer current reference day instead of the original seed-day literal', () => {
  const date = Schema.toEncoded(RecordsResponseSchema.fields.referenceDate);
  expect(Schema.is(date)('2026-10-20')).toBe(true);
  expect(Schema.is(date)('2026-11-01')).toBe(true);
  expect(Schema.is(date)('not-a-day')).toBe(false);
});
it('uses the same Czech opportunity labels in summary and chart/table/CSV series', () => {
  const inputs: MetricInputs = {
    employees: [],
    invoices: [],
    movements: [],
    opportunities: [
      { amountMinor: 10_000, expectedCloseDate: '2026-10-20', id: 'a', partyId: 'p', probability: 10, stage: 'LEAD' },
      {
        amountMinor: 20_000,
        expectedCloseDate: '2026-10-20',
        id: 'b',
        partyId: 'p',
        probability: 25,
        stage: 'QUALIFIED',
      },
    ],
    orders: [],
    products: [],
    tasks: [],
  };
  const range = { from: '2026-01-01', groupBy: 'stage' as const, to: '2026-12-31' };
  expect(
    EffectArray.sort(
      computeMetric('pipeline_weighted_value', inputs, range).series.map((point) => point.label),
      Order.String,
    ),
  ).toEqual(['Kvalifikovaná', 'Nová']);
  expect(JSON.stringify(computePipelineSummary(inputs, range))).not.toMatch(/Lead|Kvalifikace/u);
});
