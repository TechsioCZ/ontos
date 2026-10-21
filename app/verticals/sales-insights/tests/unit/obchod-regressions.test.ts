import { Schema } from 'effect';
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
    orders: [],
    products: [],
    tasks: [],
    opportunities: [
      { id: 'a', partyId: 'p', amountMinor: 10000, expectedCloseDate: '2026-10-20', probability: 10, stage: 'LEAD' },
      {
        id: 'b',
        partyId: 'p',
        amountMinor: 20000,
        expectedCloseDate: '2026-10-20',
        probability: 25,
        stage: 'QUALIFIED',
      },
    ],
  };
  const range = { from: '2026-01-01', to: '2026-12-31', groupBy: 'stage' as const };
  expect(
    computeMetric('pipeline_weighted_value', inputs, range)
      .series.map((point) => point.label)
      .sort(),
  ).toEqual(['Kvalifikovaná', 'Nová']);
  expect(JSON.stringify(computePipelineSummary(inputs, range))).not.toMatch(/Lead|Kvalifikace/u);
});
