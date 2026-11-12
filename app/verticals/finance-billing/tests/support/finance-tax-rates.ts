import { CZ_VAT_REDUCED, CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Effect, Layer } from 'effect';
import type { VatChoices } from '../../shared/apis/vat-choices.ts';
import { FinanceTaxRates } from '../../src/integrations/tax-rates.ts';

/** The Tax rule revision a test company's classification rate comes from. */
export const testTaxRuleRevisionRef = (tenantId: string, code: CzVatClassificationCode) => ({
  moduleId: 'commerce.tax' as const,
  resourceId: `${code}-revision-1`,
  resourceType: 'commerce.tax.tax-rule-revision' as const,
  tenantId,
});

/** The baseline every selling company gets from Tax: 21 % standard and 12 % reduced since 1. 1. 2024. */
export const baselineVatChoices = (
  tenantId: string,
  on: string,
  regime: VatChoices['regime'] = 'VAT_PAYER',
): VatChoices => ({
  on,
  rates: [
    {
      code: CZ_VAT_STANDARD,
      effectiveFrom: DateTime.makeUnsafe('2023-12-31T23:00:00.000Z'),
      ratePercent: 21,
      taxRuleRevisionRef: testTaxRuleRevisionRef(tenantId, CZ_VAT_STANDARD),
    },
    {
      code: CZ_VAT_REDUCED,
      effectiveFrom: DateTime.makeUnsafe('2023-12-31T23:00:00.000Z'),
      ratePercent: 12,
      taxRuleRevisionRef: testTaxRuleRevisionRef(tenantId, CZ_VAT_REDUCED),
    },
  ],
  regime,
});

/** A standard-rate line exactly as the invoice form stores it for the baseline. */
export const standardLineVat = (tenantId: string) => ({
  taxRuleRevisionRef: testTaxRuleRevisionRef(tenantId, CZ_VAT_STANDARD),
  vatClassification: CZ_VAT_STANDARD,
  vatRate: 21,
});

/** Tax answering with the baseline for the scope's own tenant. */
export const FinanceTaxRatesBaseline = Layer.succeed(FinanceTaxRates, {
  choices: (scope, on) => Effect.succeed(baselineVatChoices(scope.tenantId, on)),
  choicesFor: ({ subject }, on) =>
    Effect.succeed(baselineVatChoices(subject._tag === 'Originator' ? subject.tenantId : subject.scope.tenantId, on)),
});
