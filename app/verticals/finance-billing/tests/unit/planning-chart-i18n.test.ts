import { expect, it } from 'effect-rstest';

import csCatalog from '../../locales/cs/finance-billing.json';
import enCatalog from '../../locales/en/finance-billing.json';

const cs = csCatalog['finance-billing'].financeUi.planning.chart;
const en = enCatalog['finance-billing'].financeUi.planning.chart;

it('translates every chart and series key in both languages', () => {
  const chartKeys = [
    'flowTitle',
    'flowAria',
    'incomePaid',
    'incomeExpected',
    'expensePaid',
    'expenseExpected',
    'balanceTitle',
    'balanceAria',
    'estimateBadge',
    'openingHint',
  ] as const;
  expect(new Set(Object.keys(cs))).toEqual(new Set(chartKeys));
  expect(new Set(Object.keys(en))).toEqual(new Set(chartKeys));
  for (const key of chartKeys) {
    expect(cs[key].trim(), `cs ${key}`).not.toBe('');
    expect(en[key].trim(), `en ${key}`).not.toBe('');
    expect(cs[key], `cs ${key} is not English`).not.toBe(en[key]);
  }
});
