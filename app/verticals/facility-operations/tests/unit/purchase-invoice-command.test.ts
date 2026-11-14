import { ApplyCommandPayloadSchema } from '@app/finance-billing/contracts/apply-command';
import { InvoiceLinesSchema } from '@app/finance-billing/contracts/records';
import { CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PurchaseOrderIdSchema } from '../../shared/domain/purchasing.ts';
import { purchaseInvoiceCommandOf } from '../../src/routes/[lang]/provoz/nakupy/purchase-invoice-command.ts';
import type { PurchaseInvoiceInput } from '../../src/routes/[lang]/provoz/nakupy/purchase-invoice-command.ts';

const input: PurchaseInvoiceInput = {
  documentNumber: 'SUP-2026-118',
  dueDate: '2026-11-16',
  issueDate: '2026-11-02',
  lines: Schema.decodeUnknownSync(InvoiceLinesSchema)([
    {
      description: 'Maintenance',
      quantity: 1,
      taxRuleRevisionRef: {
        moduleId: 'commerce.tax',
        resourceId: 'revision-1',
        resourceType: 'commerce.tax.tax-rule-revision',
        tenantId: '70000000-0000-4000-8000-000000000020',
      },
      unitPriceMinor: 10_000,
      vatClassification: CZ_VAT_STANDARD,
      vatRate: 21,
    },
  ]),
  order: {
    currency: 'CZK',
    id: Schema.decodeUnknownSync(PurchaseOrderIdSchema)('purchase-order-1'),
    number: 'OBJ-2026-001',
  },
  supplier: { ico: '01234567', name: 'Supplier s.r.o.' },
  totalMinor: 12_100,
};

it('refuses an EUR order instead of relabelling unchanged amounts as CZK', () => {
  expect(Option.isNone(purchaseInvoiceCommandOf({ ...input, order: { ...input.order, currency: 'EUR' } }))).toBe(true);
});

it('preserves the known supplier ICO and exact CZK prices in the public Finance payload', () => {
  const command = Option.getOrThrow(purchaseInvoiceCommandOf(input));
  const payload = Schema.encodeSync(ApplyCommandPayloadSchema)({ command, expectedRevision: 7 });
  expect(payload).toMatchObject({
    command: {
      _tag: 'RecordIncomingInvoice',
      documentNumber: input.documentNumber,
      lines: input.lines,
      sourceOrder: { id: input.order.id, number: input.order.number },
      supplierCompanyId: '01234567',
      supplierName: 'Supplier s.r.o.',
      totalMinor: 12_100,
    },
    expectedRevision: 7,
  });
});

it('refuses an absent supplier document number rather than inventing one from the order', () => {
  expect(Option.isNone(purchaseInvoiceCommandOf({ ...input, documentNumber: '' }))).toBe(true);
  expect(Option.isNone(purchaseInvoiceCommandOf({ ...input, documentNumber: '   ' }))).toBe(true);
});

it('refuses unclassified rate-only purchase lines before submitting to Finance', () => {
  expect(
    Option.isNone(
      purchaseInvoiceCommandOf({
        ...input,
        lines: [{ description: 'Maintenance', quantity: 1, unitPriceMinor: 10_000, vatRate: 21 }],
      }),
    ),
  ).toBe(true);
});

it('does not invent a supplier ICO when the purchasing supplier has none', () => {
  const command = Option.getOrThrow(purchaseInvoiceCommandOf({ ...input, supplier: { name: input.supplier.name } }));
  const payload = Schema.encodeSync(ApplyCommandPayloadSchema)({ command, expectedRevision: 7 });
  expect(payload.command).not.toHaveProperty('supplierCompanyId');
});
