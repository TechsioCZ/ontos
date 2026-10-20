import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  InvoiceIssuerSessionSchema,
  invoiceIssuerName,
} from '../../src/routes/[lang]/siampark/finance/use-invoice-issuer.ts';

it('uses the authenticated selected company for original invoices, new drafts and print, never a Siampark constant', () => {
  for (const [id, legalName] of [
    ['0020', 'Obchodní firma'],
    ['0021', 'Siampark'],
    ['0022', 'Velkoobchod Hanák s.r.o.'],
  ]) {
    const session = Schema.decodeUnknownSync(InvoiceIssuerSessionSchema)({
      state: 'authenticated',
      identity: { legalEntityId: id, legalName },
    });
    expect(invoiceIssuerName(session)).toBe(legalName);
  }
});
it('does not invent an issuer for an anonymous, blocked or unselected session', () => {
  for (const state of ['anonymous', 'access_blocked', 'selection_required'] as const) {
    expect(invoiceIssuerName({ state })).toBeUndefined();
  }
});
