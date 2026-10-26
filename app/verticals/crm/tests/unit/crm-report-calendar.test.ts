import { describe, expect, it } from 'effect-rstest';
import { periodOf, periodWithDate, readQuery } from '../../src/crm/report-query.ts';
import { periodOptions } from '../../src/routes/[lang]/crm/prehled-prodeju/report-format.ts';
import { buildSalesReport, ordersCsv } from '../../shared/domain/reports.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { filtersOf } from '../../src/routes/[lang]/crm/prehled-prodeju/report-filters.tsx';

const periods = periodOptions('2026-10-26T10:00:00Z', []);

it('keeps the unfiltered query defaults during server rendering', () => {
  expect(readQuery()).toEqual({
    client: 'vse',
    grouping: 'salesperson',
    period: 'vse',
    salesperson: 'vse',
    status: 'vse',
  });
});

it('applies the calendar range together with the other report filters', () => {
  expect(
    filtersOf(
      {
        client: 'client-a',
        grouping: 'salesperson',
        period: '2026-10-05:2026-10-07',
        salesperson: 'rep-a',
        status: 'r:nova',
      },
      periods,
    ),
  ).toEqual({
    clientId: 'client-a',
    period: { from: '2026-10-05', to: '2026-10-07' },
    salespersonId: 'rep-a',
    status: { kind: 'raw', raw: 'nova' },
  });
});

describe('sales report calendar period', () => {
  it('restores a custom inclusive date range from the URL', () => {
    expect(periodOf('2026-10-05:2026-10-07', periods)).toEqual({ from: '2026-10-05', to: '2026-10-07' });
  });
  it('keeps presets and all-time filtering', () => {
    expect(periodOf('tento-mesic', periods)).toEqual({ from: '2026-10-01', to: '2026-10-26' });
    expect(periodOf('vse', periods)).toEqual({});
  });
  it('allows a single day and either open bound', () => {
    expect(periodOf('2026-10-05:2026-10-05', periods)).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(periodOf('2026-10-05:', periods)).toEqual({ from: '2026-10-05' });
    expect(periodOf(':2026-10-07', periods)).toEqual({ to: '2026-10-07' });
  });
  it('rejects malformed, impossible and reversed URL dates', () => {
    for (const value of [
      ':',
      '2026-02-30:2026-03-01',
      '2026-10-07:2026-10-05',
      '2026-10-05:2026-10-07:extra',
      'no-date:2026-10-07',
      '2026-10-05:no-date',
      '2026-1-1:2026-10-07',
    ]) {
      expect(periodOf(value, periods)).toBeUndefined();
    }
    expect(periodOf('2028-02-29:2028-03-01', periods)).toEqual({ from: '2028-02-29', to: '2028-03-01' });
  });
  it('edits a preset without losing the other boundary', () => {
    expect(periodWithDate({ from: '2026-10-01', to: '2026-10-26' }, 'from', '2026-10-05')).toBe(
      '2026-10-05:2026-10-26',
    );
  });
  it('keeps an edited range ordered', () => {
    expect(periodWithDate({ from: '2026-10-01', to: '2026-10-07' }, 'from', '2026-10-10')).toBe(
      '2026-10-10:2026-10-10',
    );
    expect(periodWithDate({ from: '2026-10-05', to: '2026-10-07' }, 'to', '2026-10-01')).toBe('2026-10-01:2026-10-01');
  });
  it('clears bounds without leaving a hidden custom filter', () => {
    expect(periodWithDate({ from: '2026-10-05', to: '2026-10-07' }, 'from', '')).toBe(':2026-10-07');
    expect(periodWithDate({ to: '2026-10-07' }, 'to', '')).toBe('vse');
  });
});

it('includes both calendar boundaries in the report and CSV, but neither neighbouring day', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const state: CrmState = {
    ...initialCrmState,
    clients: {
      ...initialCrmState.clients,
      items: [
        {
          createdAt: at,
          createdBy: 'admin',
          id: 'client-a',
          kind: 'organization',
          name: 'Client A',
          status: 'active',
          updatedAt: at,
        },
      ],
    },
    imports: {
      ...initialCrmState.imports,
      orders: [
        '2026-10-04T23:59:59.000Z',
        '2026-10-05T00:00:00.000Z',
        '2026-10-07T23:59:59.000Z',
        '2026-10-08T00:00:00.000Z',
      ].map((date, index) => ({
        amount: '10.00',
        clientId: 'client-a',
        currency: 'CZK',
        externalId: `external-${index}`,
        id: `order-${index}`,
        number: `ORDER-${index}`,
        orderedAt: date,
        pairing: 'paired',
        rawStatus: 'nova',
        receivedAt: at,
        source: 'test',
        statusHistory: [],
      })),
    },
  };
  const report = buildSalesReport(state, { period: periodOf('2026-10-05:2026-10-07', periods) ?? {} });
  expect(report.count).toBe(2);
  expect(report.totals).toEqual([{ amount: '20.00', count: 2, currency: 'CZK' }]);
  expect(report.rows).toHaveLength(2);
  expect(report.rows.map((row) => row.order.id)).toEqual(expect.arrayContaining(['order-1', 'order-2']));
  const csv = ordersCsv(report);
  expect(csv).toContain('ORDER-1');
  expect(csv).toContain('ORDER-2');
  expect(csv).not.toContain('ORDER-0');
  expect(csv).not.toContain('ORDER-3');
});
