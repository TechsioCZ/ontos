import { expect, it } from 'effect-rstest';
import { statisticsCsv } from '../../src/statistics/statistics-csv.ts';

it('exports displayed Czech stage labels and values without leaking internal stage codes', () => {
  const csv = statisticsCsv(
    [{ key: 'LEAD', label: 'Nová', value: 10000 }, { key: 'QUALIFIED', label: 'Kvalifikovaná', value: 20000 }],
    'CZK',
    ['Skupina', 'Hodnota'],
  );
  expect(csv.startsWith('﻿"Skupina";"Hodnota"\r\n')).toBe(true);
  expect(csv).toContain('"Nová";"100');
  expect(csv).toContain('"Kvalifikovaná";"200');
  expect(csv).not.toMatch(/LEAD|QUALIFIED|Lead|Kvalifikace/u);
});

it('quotes multiline delimiters and neutralizes spreadsheet formulas in group labels', () => {
  const csv = statisticsCsv(
    [{ key: 'x', label: '=HYPERLINK("url");\nřádek', value: 3 }],
    'count',
    ['Skupina', 'Hodnota'],
  );
  expect(csv).toContain('"\'=HYPERLINK(""url"");\nřádek";"3"');
});
