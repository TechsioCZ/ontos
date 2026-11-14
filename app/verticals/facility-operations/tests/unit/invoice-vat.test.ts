import { InvoiceLineSchema } from '@app/finance-billing/contracts/records';
import { CZ_VAT_STANDARD, CZ_VAT_REDUCED } from '@app/shared-contracts/cz-vat-classifications';
import { DateTime, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { incomingVatOptions, salesLineVat } from '../../src/routes/[lang]/provoz/nakupy/invoice-vat.ts';
import type { FinanceVatChoices } from '../../src/ui/finance-reads.ts';
import { purchaseInvoiceCommandOf } from '../../src/routes/[lang]/provoz/nakupy/purchase-invoice-command.ts';
import { PurchaseOrderIdSchema } from '../../shared/domain/purchasing.ts';

const issueDate = '2026-11-14';
const reference = {
  moduleId: 'commerce.tax',
  resourceId: '11111111-1111-4111-8111-111111111111',
  resourceType: 'commerce.tax.tax-rule-revision',
  tenantId: '70000000-0000-4000-8000-000000000020',
};
const taxRuleRevisionRef = Schema.decodeUnknownSync(InvoiceLineSchema)({
  description: 'Service',
  quantity: 1,
  taxRuleRevisionRef: reference,
  unitPriceMinor: 10_000,
  vatClassification: CZ_VAT_STANDARD,
  vatRate: 21,
}).taxRuleRevisionRef;
if (taxRuleRevisionRef === undefined) {
  throw new Error('The VAT fixture must carry its published revision');
}
const choices: FinanceVatChoices = {
  on: issueDate,
  rates: [
    {
      code: CZ_VAT_STANDARD,
      effectiveFrom: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
      ratePercent: 21,
      taxRuleRevisionRef,
    },
    {
      code: CZ_VAT_REDUCED,
      effectiveFrom: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
      ratePercent: 12,
      taxRuleRevisionRef,
    },
  ],
  regime: 'VAT_PAYER',
};

it('sales lines copy Finance issue-date classifications and the exact published revision', () => {
  expect(Option.getOrThrow(salesLineVat({ choices, issueDate, vatRate: 21 }))).toEqual({
    taxRuleRevisionRef,
    vatClassification: CZ_VAT_STANDARD,
    vatRate: 21,
  });
  expect(Option.getOrThrow(salesLineVat({ choices, issueDate, vatRate: 12 }))).toMatchObject({
    vatClassification: CZ_VAT_REDUCED,
    vatRate: 12,
  });
});

it('refuses historical, ambiguous, stale-date and regime-incompatible VAT instead of guessing', () => {
  for (const vatRate of [0, 10]) {
    expect(Option.isNone(salesLineVat({ choices, issueDate, vatRate }))).toBe(true);
  }
  expect(Option.isNone(salesLineVat({ choices, issueDate: '2026-11-15', vatRate: 21 }))).toBe(true);
  for (const regime of ['NON_PAYER', 'NOT_DECLARED'] as const) {
    expect(Option.isNone(salesLineVat({ choices: { ...choices, regime }, issueDate, vatRate: 21 }))).toBe(true);
  }
  const ambiguous = { ...choices, rates: choices.rates.map((rate) => ({ ...rate, ratePercent: 21 })) };
  expect(Option.isNone(salesLineVat({ choices: ambiguous, issueDate, vatRate: 21 }))).toBe(true);
});

it('purchase options preserve published VAT metadata through the public Finance command codec', () => {
  const options = incomingVatOptions({ ...choices, regime: 'NON_PAYER' });
  expect(options).toHaveLength(5);
  for (const option of options) {
    const line = { description: 'Service', quantity: 1, unitPriceMinor: 10_000, ...option.vat };
    const command = Option.getOrThrow(
      purchaseInvoiceCommandOf({
        documentNumber: 'SUP-2026-118',
        dueDate: issueDate,
        issueDate,
        lines: [line],
        order: { currency: 'CZK', id: Schema.decodeUnknownSync(PurchaseOrderIdSchema)('order-1'), number: 'PO-1' },
        supplier: { name: 'Supplier' },
        totalMinor: 12_100,
      }),
    );
    expect(command.lines?.[0]).toEqual(line);
  }
  expect(options.find((option) => option.key === 'EXEMPT')?.vat).toEqual({ vatRate: 0, vatTreatment: 'EXEMPT' });
  expect(options.some((option) => option.vat.vatRate === 10)).toBe(false);
});
