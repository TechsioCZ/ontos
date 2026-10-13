import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';
import { computeKpis, computeMetric, computePipelineSummary, metricCatalog } from '../../shared/metrics.ts';
import type { MetricInputs, OpportunityInput } from '../../shared/metrics.ts';

const at = (iso: string) => DateTime.makeUnsafe(iso);

const range = { from: '2026-09-01', to: '2026-10-31' };

const fixture: MetricInputs = {
  customers: [
    { id: 'c1', name: 'Alfa' },
    { id: 'c2', name: 'Beta' },
  ],
  employees: [
    { fullName: 'Obchodník A', id: 'emp-a' },
    { fullName: 'Obchodník B', id: 'emp-b' },
  ],
  invoices: [
    // In range, CONFIRMED, OUTGOING: counted.
    {
      businessState: 'CONFIRMED',
      direction: 'OUTGOING',
      issueDate: '2026-09-15',
      opportunityId: 'opp-won-a',
      paidMinor: 0,
      partyId: 'c1',
      paymentState: 'UNPAID',
      totalMinor: 100_000,
    },
    {
      businessState: 'CONFIRMED',
      direction: 'OUTGOING',
      issueDate: '2026-09-20',
      paidMinor: 50_000,
      partyId: 'c2',
      paymentState: 'PAID',
      totalMinor: 50_000,
    },
    {
      businessState: 'CONFIRMED',
      direction: 'OUTGOING',
      issueDate: '2026-10-02',
      opportunityId: 'opp-won-b',
      paidMinor: 50_000,
      partyId: 'c1',
      paymentState: 'PARTIALLY_PAID',
      totalMinor: 200_000,
    },
    // Excluded: draft, voided, incoming (supplier) invoice, and out of range.
    {
      businessState: 'DRAFT',
      direction: 'OUTGOING',
      issueDate: '2026-10-03',
      paidMinor: 0,
      partyId: 'c1',
      paymentState: 'UNPAID',
      totalMinor: 999,
    },
    {
      businessState: 'VOIDED',
      direction: 'OUTGOING',
      issueDate: '2026-10-04',
      paidMinor: 0,
      partyId: 'c1',
      paymentState: 'UNPAID',
      totalMinor: 888,
    },
    {
      businessState: 'CONFIRMED',
      direction: 'INCOMING',
      issueDate: '2026-10-05',
      paidMinor: 0,
      partyId: 'c1',
      paymentState: 'UNPAID',
      totalMinor: 7777,
    },
    {
      businessState: 'CONFIRMED',
      direction: 'OUTGOING',
      issueDate: '2026-11-01',
      paidMinor: 0,
      partyId: 'c1',
      paymentState: 'UNPAID',
      totalMinor: 5,
    },
  ],
  movements: [
    { delta: 20, productId: 'p1' },
    { delta: -5, productId: 'p1' },
    { delta: 10, productId: 'p2' },
  ],
  opportunities: [
    {
      amountMinor: 300_000,
      closedAt: at('2026-09-10T09:00:00.000Z'),
      createdAt: at('2026-08-15T09:00:00.000Z'),
      expectedCloseDate: '2026-09-10',
      id: 'opp-won-a',
      ownerEmployeeId: 'emp-a',
      partyId: 'c1',
      probability: 100,
      stage: 'WON',
    },
    {
      amountMinor: 200_000,
      closedAt: at('2026-10-02T10:00:00.000Z'),
      createdAt: at('2026-09-01T00:00:00.000Z'),
      expectedCloseDate: '2026-10-02',
      id: 'opp-won-b',
      ownerEmployeeId: 'emp-b',
      partyId: 'c1',
      probability: 100,
      stage: 'WON',
    },
    {
      amountMinor: 100_000,
      closedAt: at('2026-10-03T10:00:00.000Z'),
      createdAt: at('2026-09-05T10:00:00.000Z'),
      expectedCloseDate: '2026-10-03',
      id: 'opp-lost-a',
      ownerEmployeeId: 'emp-a',
      partyId: 'c2',
      probability: 0,
      stage: 'LOST',
    },
    {
      amountMinor: 55_000,
      closedAt: at('2026-08-01T10:00:00.000Z'),
      createdAt: at('2026-07-01T10:00:00.000Z'),
      expectedCloseDate: '2026-08-01',
      id: 'opp-lost-old',
      ownerEmployeeId: 'emp-a',
      partyId: 'c2',
      probability: 0,
      stage: 'LOST',
    },
    {
      amountMinor: 400_000,
      createdAt: at('2026-09-20T08:00:00.000Z'),
      expectedCloseDate: '2026-10-20',
      id: 'opp-open',
      ownerEmployeeId: 'emp-b',
      partyId: 'c2',
      probability: 75,
      stage: 'NEGOTIATION',
    },
    {
      amountMinor: 80_000,
      createdAt: at('2026-11-01T00:00:00.000Z'),
      expectedCloseDate: '2026-11-30',
      id: 'opp-open-late',
      partyId: 'c1',
      probability: 10,
      stage: 'LEAD',
    },
  ],
  orders: [
    {
      createdAt: at('2026-10-01T08:00:00.000Z'),
      id: 'o1',
      lines: [
        { productId: 'p1', quantity: 3 },
        { productId: 'p2', quantity: 2 },
      ],
      opportunityId: 'opp-won-b',
      partyId: 'c1',
      status: 'CONFIRMED',
    },
    {
      createdAt: at('2026-10-02T08:00:00.000Z'),
      id: 'o2',
      lines: [{ productId: 'p1', quantity: 100 }],
      partyId: 'c1',
      status: 'CANCELLED',
    },
    {
      createdAt: at('2026-09-30T23:30:00.000Z'),
      id: 'o3',
      lines: [{ productId: 'p1', quantity: 5 }],
      partyId: 'c2',
      status: 'DELIVERED',
    },
  ],
  products: [
    { currentPriceMinor: 1000, id: 'p1', name: 'Šroub M6' },
    { currentPriceMinor: 500, id: 'p2', name: 'Matice' },
  ],
  tagAssignments: [{ subject: { id: 'c1', kind: 'customer' }, tagId: 'vip' }],
  tags: [{ id: 'vip', name: 'VIP' }],
  tasks: [
    { assigneeEmployeeId: 'emp-a', dueDate: '2026-10-10', state: 'NEW', updatedAt: at('2026-10-01T00:00:00.000Z') },
    {
      assigneeEmployeeId: 'emp-b',
      dueDate: '2026-10-20',
      state: 'IN_PROGRESS',
      updatedAt: at('2026-10-01T00:00:00.000Z'),
    },
    { assigneeEmployeeId: 'emp-a', state: 'DONE', updatedAt: at('2026-10-05T12:00:00.000Z') },
    { assigneeEmployeeId: 'emp-b', state: 'WAITING', updatedAt: at('2026-10-01T00:00:00.000Z') },
    {
      assigneeEmployeeId: 'emp-b',
      dueDate: '2026-10-01',
      state: 'CANCELLED',
      updatedAt: at('2026-10-01T00:00:00.000Z'),
    },
  ],
};

it('groups invoiced revenue by month, ascending, with Czech month labels', () => {
  const result = computeMetric('revenue_invoiced', fixture, { ...range, groupBy: 'month' });
  expect(result.supported).toBe(true);
  expect(result.series).toEqual([
    { key: '2026-09', label: 'zář 2026', value: 150_000 },
    { key: '2026-10', label: 'říj 2026', value: 200_000 },
  ]);
  expect(result.total).toBe(350_000);
});

it('counts only confirmed outgoing invoices inside the range', () => {
  expect(computeMetric('invoice_count', fixture, { ...range, groupBy: 'month' }).total).toBe(3);
  expect(computeMetric('unpaid_amount', fixture, { ...range, groupBy: 'month' }).total).toBe(100_000 + 150_000);
});

it('groups revenue by ISO week with Monday labels', () => {
  const result = computeMetric('revenue_invoiced', fixture, { ...range, groupBy: 'week' });
  expect(result.series).toEqual([
    { key: '2026-09-14', label: 'Týden 14. 9. 2026', value: 150_000 },
    { key: '2026-09-28', label: 'Týden 28. 9. 2026', value: 200_000 },
  ]);
});

it('labels day and week buckets with the year so a multi-year range stays readable', () => {
  const daily = computeMetric('revenue_invoiced', fixture, { ...range, groupBy: 'day' });
  expect(daily.series.length).toBeGreaterThan(0);
  for (const point of daily.series) {
    expect(point.label).toMatch(/^\d{1,2}\. \d{1,2}\. 2026$/u);
  }
});

it('reports no win rate, not 0 %, for a period without closed opportunities', () => {
  const empty = { from: '2030-01-01', to: '2030-01-31' };
  expect(computeMetric('win_rate', fixture, { ...empty, groupBy: 'month' }).total).toBeNull();
  expect(computeKpis(fixture, empty).find((kpi) => kpi.id === 'win_rate')?.value).toBeNull();
  expect(computeMetric('revenue_invoiced', fixture, { ...empty, groupBy: 'month' }).total).toBe(0);
});

it('computes win rate as won over closed in range, overall and per employee', () => {
  const total = computeMetric('win_rate', fixture, { ...range, groupBy: 'month' });
  expect(total.total).toBe(66.7);
  expect(total.series).toEqual([
    { key: '2026-09', label: 'zář 2026', value: 100 },
    { key: '2026-10', label: 'říj 2026', value: 50 },
  ]);
  const byEmployee = computeMetric('win_rate', fixture, { ...range, groupBy: 'employee' });
  expect(byEmployee.series).toEqual([
    { key: 'emp-b', label: 'Obchodník B', value: 100 },
    { key: 'emp-a', label: 'Obchodník A', value: 50 },
  ]);
});

it('sums won and lost opportunity values by closedAt', () => {
  expect(computeMetric('opportunities_won', fixture, { ...range, groupBy: 'month' }).total).toBe(500_000);
  expect(computeMetric('opportunities_lost', fixture, { ...range, groupBy: 'month' }).total).toBe(100_000);
});

it('excludes cancelled orders from units sold and groups by product', () => {
  const total = computeMetric('units_sold', fixture, { ...range, groupBy: 'month' });
  expect(total.total).toBe(10);
  const byProduct = computeMetric('units_sold', fixture, { ...range, groupBy: 'product' });
  expect(byProduct.series).toEqual([
    { key: 'p1', label: 'Šroub M6', value: 8 },
    { key: 'p2', label: 'Matice', value: 2 },
  ]);
});

it('groups revenue by owning employee through the opportunity, with a none bucket', () => {
  const result = computeMetric('revenue_invoiced', fixture, { ...range, groupBy: 'employee' });
  expect(result.series).toEqual([
    { key: 'emp-b', label: 'Obchodník B', value: 200_000 },
    { key: 'emp-a', label: 'Obchodník A', value: 100_000 },
    { key: 'none', label: 'Nepřiřazeno', value: 50_000 },
  ]);
});

it('counts a record under each of its tags and labels untagged records', () => {
  const result = computeMetric('revenue_invoiced', fixture, { ...range, groupBy: 'tag' });
  expect(result.series).toEqual([
    { key: 'vip', label: 'VIP', value: 300_000 },
    { key: 'none', label: 'Bez štítku', value: 50_000 },
  ]);
  expect(result.total).toBe(350_000);
});

it('reports unsupported groupings instead of guessing a series', () => {
  const result = computeMetric('stock_value', fixture, { ...range, groupBy: 'month' });
  expect(result).toEqual({ series: [], supported: false, total: 0 });
});

it('values stock from movements times the current price', () => {
  const result = computeMetric('stock_value', fixture, { ...range, groupBy: 'product' });
  expect(result.total).toBe(20_000);
  expect(result.series[0]).toEqual({ key: 'p1', label: 'Šroub M6', value: 15_000 });
});

it('keeps the top twelve categories and folds the rest into Ostatní', () => {
  const invoices = Array.from({ length: 13 }, (_, index) => ({
    businessState: 'CONFIRMED' as const,
    issueDate: '2026-09-01',
    paidMinor: 0,
    partyId: `customer-${String(index + 1).padStart(2, '0')}`,
    paymentState: 'UNPAID' as const,
    totalMinor: (index + 1) * 1000,
  }));
  const result = computeMetric('revenue_invoiced', { ...fixture, invoices }, { ...range, groupBy: 'customer' });
  expect(result.series).toHaveLength(13);
  expect(result.series[0]?.key).toBe('customer-13');
  expect(result.series[12]).toEqual({ key: 'other', label: 'Ostatní', value: 1000 });
});

it('computes the four headline KPIs over the period', () => {
  const kpis = computeKpis(fixture, { ...range, today: '2026-10-13' });
  const byId = new Map(kpis.map((kpi) => [kpi.id, kpi.value]));
  expect(kpis.map((kpi) => [kpi.id, kpi.label, kpi.unit])).toEqual([
    ['revenue_invoiced', 'Tržby (potvrzené)', 'CZK'],
    ['pipeline_open_value', 'Otevřená pipeline (k dnešku)', 'CZK'],
    ['opportunities_won', 'Vyhráno', 'CZK'],
    ['win_rate', 'Úspěšnost', 'percent'],
  ]);
  expect(byId.get('revenue_invoiced')).toBe(350_000);
  // Snapshot: includes opp-open-late, which closes after the range.
  expect(byId.get('pipeline_open_value')).toBe(480_000);
  expect(byId.get('opportunities_won')).toBe(500_000);
  expect(byId.get('win_rate')).toBe(66.7);
});

it('keeps every KPI equal to the total of the same metric under each of its groupings', () => {
  const today = '2026-10-13';
  for (const kpi of computeKpis(fixture, { ...range, today })) {
    const entry = metricCatalog.find((candidate) => candidate.id === kpi.id);
    for (const groupBy of entry?.allowedGroupings ?? []) {
      expect(computeMetric(kpi.id, fixture, { ...range, groupBy, today }).total).toBe(kpi.value);
    }
  }
});

it('resolves overdue tasks against the reference day in the metric series', () => {
  expect(computeMetric('tasks_overdue', fixture, { ...range, groupBy: 'employee', today: '2026-10-13' }).total).toBe(1);
  expect(computeMetric('tasks_overdue', fixture, { ...range, groupBy: 'employee', today: '2026-10-05' }).total).toBe(0);
});

it('counts open and done tasks by assignee', () => {
  expect(computeMetric('tasks_open', fixture, { ...range, groupBy: 'employee' }).total).toBe(3);
  expect(computeMetric('tasks_done', fixture, { ...range, groupBy: 'employee' }).series).toEqual([
    { key: 'emp-a', label: 'Obchodník A', value: 1 },
  ]);
});

it('exposes the full catalog with Czech labels and allowed groupings', () => {
  expect(metricCatalog).toHaveLength(14);
  const revenue = metricCatalog.find((entry) => entry.id === 'revenue_invoiced');
  expect(revenue?.label).toBe('Tržby z faktur');
  expect(revenue?.unit).toBe('CZK');
  expect(revenue?.allowedGroupings).toContain('month');
  expect(metricCatalog.find((entry) => entry.id === 'stock_value')?.allowedGroupings).toEqual(['product', 'tag']);
});

// Regression: seed-like data. Open opportunities expect to close after the selected range (the last
// 12 months), so a range filter on expectedCloseDate made the open pipeline KPI read 0 Kč.
it('values the open pipeline as a snapshot of every open opportunity, regardless of range', () => {
  const stages = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'] as const;
  const probabilities = { LEAD: 10, NEGOTIATION: 75, PROPOSAL: 50, QUALIFIED: 25 } as const;
  const open = Array.from({ length: 34 }, (_, index) => {
    const stage = stages[index % stages.length] ?? 'LEAD';
    return {
      amountMinor: 100_000 * (index + 1),
      expectedCloseDate: `2026-${String(11 + (index % 2)).padStart(2, '0')}-15`,
      id: `opp-open-${index}`,
      partyId: 'c1',
      probability: probabilities[stage],
      stage,
    };
  });
  const closed = Array.from({ length: 26 }, (_, index) => ({
    amountMinor: 50_000,
    closedAt: at('2026-05-10T10:00:00.000Z'),
    expectedCloseDate: '2026-05-10',
    id: `opp-closed-${index}`,
    partyId: 'c2',
    probability: index < 18 ? 100 : 0,
    stage: index < 18 ? ('WON' as const) : ('LOST' as const),
  }));
  const seeded: MetricInputs = { ...fixture, opportunities: [...open, ...closed] };
  const lastTwelveMonths = { from: '2025-11-01', to: '2026-10-13', today: '2026-10-13' };
  const expectedOpen = open.reduce((sum, o) => sum + o.amountMinor, 0);
  const expectedWeighted = open.reduce((sum, o) => sum + Math.round((o.amountMinor * o.probability) / 100), 0);

  const byId = new Map(computeKpis(seeded, lastTwelveMonths).map((kpi) => [kpi.id, kpi.value]));
  expect(byId.get('pipeline_open_value')).toBe(expectedOpen);
  expect(byId.get('win_rate')).toBe(69.2);
  expect(computeMetric('pipeline_open_value', seeded, { ...lastTwelveMonths, groupBy: 'stage' }).total).toBe(
    expectedOpen,
  );
  expect(computeMetric('pipeline_weighted_value', seeded, { ...lastTwelveMonths, groupBy: 'employee' }).total).toBe(
    expectedWeighted,
  );
  // Time buckets follow expectedCloseDate, so the forecast months show up even past the range end.
  expect(
    computeMetric('pipeline_open_value', seeded, { ...lastTwelveMonths, groupBy: 'month' }).series.map((p) => p.key),
  ).toEqual(['2026-11', '2026-12']);
});

// Regression: the win-rate KPI read 69,2 % for one metric/grouping and 70,4 % for another over the same period.
it('reports the same win rate for the same period whatever metric or grouping is selected', () => {
  const stages = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'] as const;
  const open = Array.from({ length: 34 }, (_, index) => ({
    amountMinor: 100_000 * (index + 1),
    expectedCloseDate: '2026-11-15',
    id: `opp-open-${index}`,
    partyId: 'c1',
    probability: 50,
    stage: stages[index % stages.length] ?? 'LEAD',
  }));
  const closed = Array.from({ length: 26 }, (_, index) => ({
    amountMinor: 50_000,
    closedAt: at('2026-05-10T10:00:00.000Z'),
    expectedCloseDate: '2026-05-10',
    id: `opp-closed-${index}`,
    partyId: 'c2',
    probability: index < 18 ? 100 : 0,
    stage: index < 18 ? ('WON' as const) : ('LOST' as const),
  }));
  const seeded: MetricInputs = { ...fixture, opportunities: [...open, ...closed] };
  const period = { from: '2025-11-01', to: '2026-10-13', today: '2026-10-13' };
  const kpiWinRate = computeKpis(seeded, period).find((kpi) => kpi.id === 'win_rate')?.value;
  expect(kpiWinRate).toBe(69.2);
  for (const groupBy of ['month', 'employee', 'customer', 'tag'] as const) {
    expect(computeMetric('win_rate', seeded, { ...period, groupBy }).total).toBe(69.2);
  }
});

const opportunity = (patch: Partial<OpportunityInput> & Pick<OpportunityInput, 'id' | 'stage'>): OpportunityInput => ({
  amountMinor: 100_000,
  expectedCloseDate: '2026-10-01',
  partyId: 'c1',
  probability: 50,
  ...patch,
});

it('summarises the open pipeline today next to the opened, won and lost opportunities of the period', () => {
  const summary = computePipelineSummary(fixture, { ...range, today: '2026-10-13' });
  // Snapshot: both open opportunities, including opp-open-late created after the range.
  expect(summary.open.count).toBe(2);
  expect(summary.open.valueMinor).toBe(480_000);
  expect(summary.open.byStage).toEqual([
    { count: 1, label: 'Lead', stage: 'LEAD', valueMinor: 80_000 },
    { count: 0, label: 'Kvalifikace', stage: 'QUALIFIED', valueMinor: 0 },
    { count: 0, label: 'Nabídka', stage: 'PROPOSAL', valueMinor: 0 },
    { count: 1, label: 'Vyjednávání', stage: 'NEGOTIATION', valueMinor: 400_000 },
  ]);
  // Created in range: opp-won-b on the first day, opp-lost-a, opp-open; whatever their stage is now.
  expect(summary.opened).toEqual({ count: 3, valueMinor: 700_000 });
  expect(summary.won).toEqual({ count: 2, valueMinor: 500_000 });
  // opp-lost-old closed before the range.
  expect(summary.lost).toEqual({ count: 1, valueMinor: 100_000 });
  expect(summary.closed).toEqual({ count: 3, valueMinor: 600_000 });
  expect(summary.winRate).toBe(66.7);
});

it('reports the same win rate and won value as the KPI row for the same period', () => {
  const period = { ...range, today: '2026-10-13' };
  const byId = new Map(computeKpis(fixture, period).map((kpi) => [kpi.id, kpi.value]));
  const summary = computePipelineSummary(fixture, period);
  expect(summary.winRate).toBe(byId.get('win_rate'));
  expect(summary.won.valueMinor).toBe(byId.get('opportunities_won'));
  expect(summary.open.valueMinor).toBe(byId.get('pipeline_open_value'));
});

it('keeps the open pipeline but shows an empty flow and no win rate for a period with nothing in it', () => {
  const summary = computePipelineSummary(fixture, { from: '2030-01-01', to: '2030-01-31', today: '2030-01-31' });
  expect(summary.open.valueMinor).toBe(480_000);
  expect(summary.opened).toEqual({ count: 0, valueMinor: 0 });
  expect(summary.closed).toEqual({ count: 0, valueMinor: 0 });
  expect(summary.winRate).toBeNull();
});

it('includes both range days whole, as UTC calendar days, for opened and closed opportunities', () => {
  const opportunities = [
    opportunity({ closedAt: at('2026-08-31T23:59:59.999Z'), id: 'before', stage: 'WON' }),
    opportunity({ closedAt: at('2026-09-01T00:00:00.000Z'), id: 'first-day', stage: 'WON' }),
    opportunity({ closedAt: at('2026-10-31T23:59:59.999Z'), id: 'last-day', stage: 'LOST' }),
    opportunity({ closedAt: at('2026-11-01T00:00:00.000Z'), id: 'after', stage: 'LOST' }),
    opportunity({ createdAt: at('2026-09-01T00:00:00.000Z'), id: 'opened-first', stage: 'LEAD' }),
    opportunity({ createdAt: at('2026-10-31T23:59:59.999Z'), id: 'opened-last', stage: 'LEAD' }),
    opportunity({ createdAt: at('2026-11-01T00:00:00.000Z'), id: 'opened-after', stage: 'LEAD' }),
  ];
  const summary = computePipelineSummary({ ...fixture, opportunities }, range);
  expect(summary.won.count).toBe(1);
  expect(summary.lost.count).toBe(1);
  expect(summary.opened.count).toBe(2);
});

it('gives a real rate when only won or only lost opportunities closed', () => {
  const closedOn = at('2026-09-15T12:00:00.000Z');
  const onlyWon = [opportunity({ closedAt: closedOn, id: 'w', stage: 'WON' })];
  const onlyLost = [opportunity({ closedAt: closedOn, id: 'l', stage: 'LOST' })];
  expect(computePipelineSummary({ ...fixture, opportunities: onlyWon }, range).winRate).toBe(100);
  expect(computePipelineSummary({ ...fixture, opportunities: onlyLost }, range).winRate).toBe(0);
});

it('sums values in haléře without rounding and skips opportunities without a creation time', () => {
  const opportunities = [
    opportunity({ amountMinor: 12_345, createdAt: at('2026-09-02T08:00:00.000Z'), id: 'a', stage: 'PROPOSAL' }),
    opportunity({ amountMinor: 1, createdAt: at('2026-09-03T08:00:00.000Z'), id: 'b', stage: 'PROPOSAL' }),
    opportunity({ amountMinor: 99, id: 'undated', stage: 'PROPOSAL' }),
  ];
  const summary = computePipelineSummary({ ...fixture, opportunities }, range);
  expect(summary.opened).toEqual({ count: 2, valueMinor: 12_346 });
  expect(summary.open.byStage.find((stage) => stage.stage === 'PROPOSAL')).toEqual({
    count: 3,
    label: 'Nabídka',
    stage: 'PROPOSAL',
    valueMinor: 12_445,
  });
});
