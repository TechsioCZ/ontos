// Every text the cash-flow charts show (series names, titles, tooltips, empty state) exists in Czech and English,
// and the Czech copy is not left in English.
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import csCatalog from '../../locales/cs/finance-billing.json';
import enCatalog from '../../locales/en/finance-billing.json';

const cs: Record<string, string> = csCatalog['finance-billing'].financeUi.planning.chart;
const en: Record<string, string> = enCatalog['finance-billing'].financeUi.planning.chart;

const panelSource = Effect.gen(function* readPanelSource() {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(
    new URL('../../src/routes/[lang]/finance/planning-panel.tsx', import.meta.url).pathname,
  );
});

const usedKeys = (source: string) => [
  ...new Set([
    ...[...source.matchAll(/t\(`\$\{chartKey\}\.(?<key>\w+)`/gu)].map((match) => match[1] ?? ''),
    // Series keys are data values translated through `${chartKey}.${row.series}`.
    ...[...source.matchAll(/series: '(?<key>\w+)'/gu)].map((match) => match[1] ?? ''),
  ]),
];

it.layer(NodeServices.layer)('cash-flow chart texts', (test) => {
  test.effect('translates every chart and series key in both languages', () =>
    Effect.gen(function* everyKeyTranslated() {
      const keys = usedKeys(yield* panelSource);
      expect(keys).toEqual(
        expect.arrayContaining(['incomePaid', 'incomeExpected', 'expensePaid', 'expenseExpected', 'balanceTitle']),
      );
      for (const key of keys) {
        expect(cs[key], `cs ${key}`).toBeTruthy();
        expect(en[key], `en ${key}`).toBeTruthy();
        expect(cs[key], `cs ${key} is not English`).not.toBe(en[key]);
      }
      expect(new Set(Object.keys(cs))).toEqual(new Set(Object.keys(en)));
    }),
  );

  test.effect('keeps the charts free of hard-coded copy', () =>
    Effect.gen(function* noHardCodedCopy() {
      expect(yield* panelSource).not.toMatch(/ariaLabel="|valueLabel="|series: 'Příjmy|series: 'Výdaje/u);
    }),
  );
});
