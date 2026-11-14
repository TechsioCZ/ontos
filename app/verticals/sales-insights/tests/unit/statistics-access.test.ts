import { expect, it } from 'effect-rstest';
import { isMetricForbidden, statisticsSourcesFor } from '../../src/statistics/statistics-access.ts';

it('reads only the KPI sources and the metric sources for a plain time grouping', () => {
  expect(statisticsSourcesFor('revenue_invoiced', 'month')).toEqual(['invoices', 'opportunities']);
  expect(statisticsSourcesFor('tasks_done', 'month')).toEqual(['invoices', 'opportunities', 'tasks']);
});

it('adds the name source of a named grouping', () => {
  expect(statisticsSourcesFor('revenue_invoiced', 'customer')).toEqual(['invoices', 'opportunities', 'customers']);
  expect(statisticsSourcesFor('stock_value', 'product')).toEqual([
    'invoices',
    'opportunities',
    'movements',
    'products',
  ]);
});

it('reads every subject entity and the tag names for a tag grouping', () => {
  expect(statisticsSourcesFor('revenue_invoiced', 'tag')).toEqual([
    'invoices',
    'opportunities',
    'customers',
    'employees',
    'orders',
    'products',
    'tags',
  ]);
});

it('marks a metric forbidden only when one of its own sources is refused', () => {
  expect(isMetricForbidden('tasks_open', new Set(['customers']))).toBe(false);
  expect(isMetricForbidden('tasks_open', new Set(['tasks']))).toBe(true);
  expect(isMetricForbidden('stock_value', new Set(['products']))).toBe(true);
});
