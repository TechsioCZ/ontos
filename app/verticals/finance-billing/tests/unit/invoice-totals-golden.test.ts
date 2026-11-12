/*
 * Every stored invoice keeps exactly its amounts after VAT moved to Tax. The expected values were computed by the
 * trunk's totals (before classifications existed) from the sales-demo invoice lines the reset script seeds
 * (`scripts/demo/sales-plan.mts`, snapshotted in `tests/fixtures/sales-demo-invoice-lines.json`) and from mixed-rate
 * lines with discounts and rounding. The same lines after the stored-rate classification (21 % standard, 12 %
 * reduced, other rates untouched) must total identically.
 */
import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { InvoiceLinesSchema } from '../../shared/apis/records.ts';
import type { InvoiceLine } from '../../shared/apis/records.ts';
import { computeInvoiceTotals } from '../../shared/domain/invoice-totals.ts';
import type { InvoiceTotals } from '../../shared/domain/invoice-totals.ts';
import { classificationOfStoredRate } from '../../shared/domain/line-vat.ts';
import salesDemoLines from '../fixtures/sales-demo-invoice-lines.json';

type Golden = readonly [
  subtotalMinor: number,
  vatMinor: number,
  totalMinor: number,
  recap: readonly (readonly [rate: number, baseMinor: number, vatMinor: number])[],
];

const planGolden = {
  i01: [14_700_000, 3_087_000, 17_787_000, [[21, 14_700_000, 3_087_000]]],
  i02: [7_225_000, 1_517_250, 8_742_250, [[21, 7_225_000, 1_517_250]]],
  i03: [5_996_000, 1_259_160, 7_255_160, [[21, 5_996_000, 1_259_160]]],
  i04: [2_360_000, 495_600, 2_855_600, [[21, 2_360_000, 495_600]]],
  i05: [10_691_000, 2_245_110, 12_936_110, [[21, 10_691_000, 2_245_110]]],
  i06: [
    2_667_000,
    495_390,
    3_162_390,
    [
      [21, 2_079_000, 436_590],
      [10, 588_000, 58_800],
    ],
  ],
  i07: [4_774_000, 1_002_540, 5_776_540, [[21, 4_774_000, 1_002_540]]],
  i08: [12_202_000, 2_562_420, 14_764_420, [[21, 12_202_000, 2_562_420]]],
  i09: [21_704_000, 4_557_840, 26_261_840, [[21, 21_704_000, 4_557_840]]],
  i10: [50_746_000, 10_656_660, 61_402_660, [[21, 50_746_000, 10_656_660]]],
  i11: [
    24_478_000,
    5_108_040,
    29_586_040,
    [
      [21, 24_184_000, 5_078_640],
      [10, 294_000, 29_400],
    ],
  ],
  i12: [1_738_000, 364_980, 2_102_980, [[21, 1_738_000, 364_980]]],
  i13: [1_287_000, 270_270, 1_557_270, [[21, 1_287_000, 270_270]]],
  i14: [378_000, 79_380, 457_380, [[21, 378_000, 79_380]]],
  i15: [22_788_000, 4_785_480, 27_573_480, [[21, 22_788_000, 4_785_480]]],
  i16: [
    6_529_000,
    1_311_800,
    7_840_800,
    [
      [21, 5_990_000, 1_257_900],
      [10, 539_000, 53_900],
    ],
  ],
  i17: [18_148_000, 3_811_080, 21_959_080, [[21, 18_148_000, 3_811_080]]],
  i18: [9_129_000, 1_917_090, 11_046_090, [[21, 9_129_000, 1_917_090]]],
  i19: [1_898_000, 398_580, 2_296_580, [[21, 1_898_000, 398_580]]],
  i20: [1_898_000, 398_580, 2_296_580, [[21, 1_898_000, 398_580]]],
  i21: [2_847_000, 597_870, 3_444_870, [[21, 2_847_000, 597_870]]],
  i22: [3_796_000, 797_160, 4_593_160, [[21, 3_796_000, 797_160]]],
  i23: [3_796_000, 797_160, 4_593_160, [[21, 3_796_000, 797_160]]],
  i24: [4_745_000, 996_450, 5_741_450, [[21, 4_745_000, 996_450]]],
  i25: [4_745_000, 996_450, 5_741_450, [[21, 4_745_000, 996_450]]],
  i26: [5_694_000, 1_195_740, 6_889_740, [[21, 5_694_000, 1_195_740]]],
  i27: [5_694_000, 1_195_740, 6_889_740, [[21, 5_694_000, 1_195_740]]],
  i28: [949_000, 199_290, 1_148_290, [[21, 949_000, 199_290]]],
  i29: [949_000, 199_290, 1_148_290, [[21, 949_000, 199_290]]],
  i30: [1_898_000, 398_580, 2_296_580, [[21, 1_898_000, 398_580]]],
} satisfies Readonly<Record<string, Golden>>;

const mixedGolden = {
  m01: [
    226_337,
    23_914,
    250_251,
    [
      [21, 99_999, 21_000],
      [12, 13_993, 1679],
      [10, 12_345, 1235],
      [0, 100_000, 0],
    ],
  ],
  m02: [
    48_243,
    9321,
    57_564,
    [
      [21, 39_243, 8241],
      [12, 9000, 1080],
    ],
  ],
  m03: [
    105,
    1,
    106,
    [
      [21, 5, 1],
      [12, 1, 0],
      [0, 99, 0],
    ],
  ],
} satisfies Readonly<Record<string, Golden>>;

const mixedLines = {
  m01: [
    { description: 'A', quantity: 3, unitPriceMinor: 33_333, vatRate: 21 },
    { description: 'B', quantity: 7, unitPriceMinor: 1999, vatRate: 12 },
    { description: 'C', quantity: 1, unitPriceMinor: 12_345, vatRate: 10 },
    { description: 'D', quantity: 2, unitPriceMinor: 50_000, vatRate: 0 },
  ],
  m02: [
    {
      description: 'A',
      discount: { kind: 'PERCENT', reason: 'x', value: 15 },
      quantity: 9,
      unitPriceMinor: 4999,
      vatRate: 21,
    },
    {
      description: 'B',
      discount: { kind: 'AMOUNT', reason: 'y', value: 1001 },
      quantity: 1,
      unitPriceMinor: 10_001,
      vatRate: 12,
    },
    { description: 'C', quantity: 13, unitPriceMinor: 77, vatRate: 21 },
  ],
  m03: [
    { description: 'A', quantity: 1, unitPriceMinor: 1, vatRate: 12 },
    { description: 'B', quantity: 1, unitPriceMinor: 5, vatRate: 21 },
    { description: 'C', quantity: 1, unitPriceMinor: 99, vatRate: 0 },
  ],
} satisfies Readonly<Record<string, readonly InvoiceLine[]>>;

/** The sales-demo invoice lines exactly as `scripts/reset-demo.mts` stores them. */
const planLines = Schema.decodeUnknownSync(Schema.Record(Schema.String, InvoiceLinesSchema))(salesDemoLines);

/** What the migration does to a stored line. */
const classified = (line: InvoiceLine): InvoiceLine => {
  const code = classificationOfStoredRate(line.vatRate);
  return code === undefined ? line : { ...line, vatClassification: code };
};

const asGolden = (totals: InvoiceTotals | undefined): Golden | undefined =>
  totals === undefined
    ? undefined
    : [
        totals.subtotalMinor,
        totals.vatMinor,
        totals.totalMinor,
        totals.vatRecap.map((entry) => [entry.rate, entry.baseMinor, entry.vatMinor] as const),
      ];

describe('invoice totals golden', () => {
  it('covers every sales-demo invoice', () => {
    expect(Object.keys(planGolden)).toEqual(Object.keys(planLines));
  });

  for (const [key, golden] of Object.entries(planGolden)) {
    it(`keeps sales-demo invoice ${key} identical before and after classification`, () => {
      const lines = planLines[key] ?? [];
      expect(asGolden(computeInvoiceTotals(lines))).toEqual(golden);
      expect(asGolden(computeInvoiceTotals(lines.map(classified)))).toEqual(golden);
    });
  }

  for (const [key, golden] of Object.entries(mixedGolden)) {
    it(`keeps mixed-rate invoice ${key} identical before and after classification`, () => {
      const lines: readonly InvoiceLine[] = Object.entries(mixedLines).find(([name]) => name === key)?.[1] ?? [];
      expect(asGolden(computeInvoiceTotals(lines))).toEqual(golden);
      expect(asGolden(computeInvoiceTotals(lines.map(classified)))).toEqual(golden);
    });
  }
});
