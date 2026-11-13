// The VAT a Merchandise test company sells at: Tax's Czech baseline (standard 21 %, reduced 12 %) for a VAT payer,
// with rule revisions in force since 2000. Tests price with it exactly as a synced company does.
import { DateTime } from 'effect';

import { TaxRuleRevisionIdSchema } from '../../shared/domain/merchandise-model.ts';
import type { CommandTax } from '../../src/services/persistence.service.ts';
import type { CompanyTaxRates, FetchedTaxRates, SellableVatRates, TaxRateBook } from '../../src/services/tax-rates.ts';

export const TEST_SINCE = DateTime.makeUnsafe('2000-01-01T00:00:00.000Z');

interface TestRates {
  readonly reduced?: string;
  readonly standard?: string;
}
const CZECH_BASELINE: TestRates = { reduced: '12', standard: '21' };

export const testTaxBook = (
  rates: TestRates = CZECH_BASELINE,
  regime: TaxRateBook['regime'] = 'VAT_PAYER',
): TaxRateBook => ({
  fingerprint: `test:${rates.standard ?? '-'}:${rates.reduced ?? '-'}:${regime}`,
  periods: [
    ...(rates.standard === undefined
      ? []
      : [
          {
            code: 'cz.vat.standard' as const,
            effectiveFrom: TEST_SINCE,
            ratePercent: rates.standard,
            taxRuleRevisionId: TaxRuleRevisionIdSchema.make('revision-standard'),
          },
        ]),
    ...(rates.reduced === undefined
      ? []
      : [
          {
            code: 'cz.vat.reduced' as const,
            effectiveFrom: TEST_SINCE,
            ratePercent: rates.reduced,
            taxRuleRevisionId: TaxRuleRevisionIdSchema.make('revision-reduced'),
          },
        ]),
  ],
  regime,
});

export const TEST_TAX_BOOK = testTaxBook();
export const TEST_RATES: SellableVatRates = { 'cz.vat.reduced': 12, 'cz.vat.standard': 21 };
/** The test rates with no product held at its own rate. */
export const TEST_PRICING = { held: {}, migrated: false, rates: TEST_RATES } as const;
/** Tax's answer as a write prepared it before its transaction opened (given after {@link TEST_COMPANY_TAX_RATES}). */
export const TEST_FETCHED_TAX: FetchedTaxRates = {
  book: TEST_TAX_BOOK,
  fetchedAt: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
};
export const TEST_TAX: CommandTax = {
  book: TEST_TAX_BOOK,
  held: {},
  migrated: false,
  rates: TEST_RATES,
  refused: false,
};
export const TEST_COMPANY_TAX_RATES: CompanyTaxRates = {
  book: TEST_TAX_BOOK,
  source: 'TAX',
  syncedAt: TEST_SINCE,
};
