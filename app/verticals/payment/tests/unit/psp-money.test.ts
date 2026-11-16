import { describe, expect, it } from 'effect-rstest';
import { Match, Option, Schema } from 'effect';

import {
  assertLaunchMinor,
  compareObservedAmount,
  parseExactMinorUnits,
  ProviderAmountDiscrepancySchema,
  ProviderReportedAmountSchema,
} from '../../src/integrations/psp/psp-money.ts';
import type { ObservedAmountComparison } from '../../src/integrations/psp/psp-money.ts';

const discrepancyOf = (comparison: ObservedAmountComparison) =>
  Match.value(comparison).pipe(
    Match.tag('MATCH', () => Option.none()),
    Match.tag('MISMATCH', ({ discrepancy }) => Option.some(discrepancy)),
    Match.exhaustive,
  );

describe('#1156 PSP exact money', () => {
  it('#1156 1 599,50 CZK is 159950 minor units', () => {
    expect(parseExactMinorUnits('159950')).toEqual(Option.some(159_950));
    expect(assertLaunchMinor({ amountMinor: 159_950, currency: 'CZK' })).toEqual(
      Option.some({ amountMinor: 159_950, currency: 'CZK' }),
    );
    expect(parseExactMinorUnits('0')).toEqual(Option.some(0));
    expect(parseExactMinorUnits('9007199254740991')).toEqual(Option.some(9_007_199_254_740_991));
  });

  it('#1156 Provider amount text that is not an exact unsigned integer is rejected', () => {
    for (const text of ['1e3', '-1', '1.5', '+1', '', ' 1', '1 ', '01', '1,5', '0x10', 'NaN', '9007199254740992']) {
      expect(Option.isNone(parseExactMinorUnits(text))).toBe(true);
    }
  });

  it('#1156 Only CZK integer minor units are Launch money', () => {
    expect(Option.isNone(assertLaunchMinor({ amountMinor: 159_950, currency: 'EUR' }))).toBe(true);
    expect(Option.isNone(assertLaunchMinor({ amountMinor: 159_950, currency: 'czk' }))).toBe(true);
    expect(Option.isNone(assertLaunchMinor({ amountMinor: 1599.5, currency: 'CZK' }))).toBe(true);
    expect(Option.isNone(assertLaunchMinor({ amountMinor: -1, currency: 'CZK' }))).toBe(true);
    expect(Option.isNone(assertLaunchMinor({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'CZK' }))).toBe(true);
  });

  it('#1156 Observed amount mismatch is a discrepancy, never a confirmation', () => {
    const expected = { amountMinor: 159_950, currency: 'CZK' } as const;

    expect(
      Option.isNone(discrepancyOf(compareObservedAmount(expected, { amountMinor: 159_950, currency: 'CZK' }))),
    ).toBe(true);
    const observed = { amountMinor: 159_900, currency: 'CZK' } as const;
    expect(discrepancyOf(compareObservedAmount(expected, observed))).toEqual(Option.some({ expected, observed }));
  });

  it('#1156 A provider amount in another currency is kept as authentic mismatch evidence', () => {
    const expected = { amountMinor: 159_950, currency: 'CZK' } as const;
    const observed = { amountMinor: 159_950, currency: 'EUR' } as const;

    expect(discrepancyOf(compareObservedAmount(expected, observed))).toEqual(Option.some({ expected, observed }));
    expect(Schema.decodeUnknownOption(ProviderAmountDiscrepancySchema)({ expected, observed })).toEqual(
      Option.some({ expected, observed }),
    );
    expect(
      Option.isNone(Schema.decodeUnknownOption(ProviderReportedAmountSchema)({ amountMinor: 1, currency: 'eur' })),
    ).toBe(true);
  });
});
