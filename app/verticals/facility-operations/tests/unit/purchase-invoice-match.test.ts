import { Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { matchingIncomingInvoice } from '../../src/routes/[lang]/provoz/nakupy/purchase-invoice-match.ts';

const invoice = { number: 'FA-2026-3318', resourceId: 'invoice-1', supplier: 'Elektro Šimánek s.r.o.' };

it('resolves the same supplier and document number regardless of case or outer whitespace', () => {
  expect(matchingIncomingInvoice([invoice], ' fa-2026-3318 ', 'ELEKTRO ŠIMÁNEK S.R.O.')).toEqual(invoice);
});
it('never links a different supplier with the same document number', () => {
  expect(matchingIncomingInvoice([invoice], invoice.number, 'AquaChem Bohemia a.s.')).toBeUndefined();
});
it('does not guess when a document number is ambiguous', () => {
  expect(
    matchingIncomingInvoice([invoice, { ...invoice, resourceId: 'invoice-2' }], invoice.number, invoice.supplier),
  ).toBeUndefined();
});
it('preserves older Finance records without a supplier snapshot but still requires a unique number', () => {
  const legacy = Struct.omit(invoice, ['supplier']);
  expect(matchingIncomingInvoice([legacy], invoice.number, invoice.supplier)).toEqual(legacy);
  expect(matchingIncomingInvoice([legacy, invoice], invoice.number, invoice.supplier)).toBeUndefined();
});
it('leaves missing documents as references rather than creating a broken link', () => {
  expect(matchingIncomingInvoice([invoice], 'FV-AQ-2026-04411', 'AquaChem Bohemia a.s.')).toBeUndefined();
});
