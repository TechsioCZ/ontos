// Every text the sales-report charts show (titles, tooltips, empty states, data table) exists in Czech and English,
// with the same placeholders, and the Czech copy is not left in English.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'effect-rstest';

import csReports from '../../locales/cs/crm-reports.json';
import enReports from '../../locales/en/crm-reports.json';

const source = readFileSync(
  new URL('../../src/routes/[lang]/crm/prehled-prodeju/report-charts.tsx', import.meta.url),
  'utf-8',
);
const usedKeys = [
  ...new Set([...source.matchAll(/t\(`\$\{k\}\.(?<key>\w+)`/gu)].map((match) => match.groups?.key ?? '')),
];
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{(?<name>\w+)\}\}/gu)].map((match) => match.groups?.name ?? '');
const cs: Record<string, string> = csReports.reports.chart;
const en: Record<string, string> = enReports.reports.chart;

describe('sales report chart texts', () => {
  it('finds the chart keys in the component', () => {
    expect(usedKeys).toEqual(expect.arrayContaining(['orderCount', 'valueTitle', 'emptyDescription', 'countsAria']));
  });

  it('translates every used key in both languages with matching placeholders', () => {
    for (const key of usedKeys) {
      expect(cs[key], `cs ${key}`).toBeTruthy();
      expect(en[key], `en ${key}`).toBeTruthy();
      expect(new Set(placeholders(cs[key] ?? '')), key).toEqual(new Set(placeholders(en[key] ?? '')));
      expect(cs[key], `cs ${key} is not English`).not.toBe(en[key]);
    }
    expect(new Set(Object.keys(cs))).toEqual(new Set(Object.keys(en)));
  });

  it('keeps the component free of hard-coded chart copy and raw field names', () => {
    expect(source).not.toMatch(/ariaLabel="|description="|valueLabel="/u);
    expect(source).not.toContain("const shortMonths = ['led'");
  });
});
