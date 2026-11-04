import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { InvoiceSchema } from '../../shared/apis/records.ts';
import { financeInvoiceDetailState } from '../../src/routes/[lang]/finance/use-finance-records.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const invoiceId = 'c0000000-0000-4000-8000-000000000201';
const otherInvoiceId = 'd0000000-0000-4000-8000-000000000301';

const invoiceFields = {
  accountingCorrelation: 'accounting-2026-0001',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'e0000000-0000-4000-8000-000000000401',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-10-20T09:00:00Z',
  currency: 'CZK',
  direction: 'OUTGOING',
  dueDate: '2026-11-03',
  issueDate: '2026-10-20',
  paidMinor: 0,
  paymentState: 'UNPAID',
  totalMinor: 121_000,
  updatedAt: '2026-10-20T09:00:00Z',
} as const;

const invoice = Schema.decodeSync(InvoiceSchema)({
  ...invoiceFields,
  documentNumber: 'FV-2026-0001',
  number: 'FV-2026-0001',
  ref: {
    moduleId: 'finance.billing',
    resourceId: invoiceId,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
});

const otherInvoice = Schema.decodeSync(InvoiceSchema)({
  ...invoiceFields,
  documentNumber: 'FV-2026-0002',
  number: 'FV-2026-0002',
  ref: {
    moduleId: 'finance.billing',
    resourceId: otherInvoiceId,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
});

it('resolves an explicit invoice deep link to the exact requested row, never another invoice', () => {
  expect(
    financeInvoiceDetailState({ feedback: 'ready', invoices: [otherInvoice, invoice], resourceId: invoiceId }),
  ).toEqual({ invoice, state: 'ready' });
  expect(
    financeInvoiceDetailState({ feedback: 'ready', invoices: [invoice, otherInvoice], resourceId: otherInvoiceId }),
  ).toEqual({ invoice: otherInvoice, state: 'ready' });
  // Without a `?resourceId=` target the page stays a list: no detail state is produced.
  expect(financeInvoiceDetailState({ feedback: 'ready', invoices: [invoice] })).toBeUndefined();
});

it('reports an unknown target in the loaded ledger as unavailable instead of returning to the list', () => {
  expect(financeInvoiceDetailState({ feedback: 'ready', invoices: [otherInvoice], resourceId: invoiceId })).toEqual({
    state: 'unavailable',
  });
  expect(financeInvoiceDetailState({ feedback: 'ready', invoices: [], resourceId: invoiceId })).toEqual({
    state: 'unavailable',
  });
});

it('shows loading while the ledger is pending and unavailable when the read failed', () => {
  expect(financeInvoiceDetailState({ feedback: 'loading', resourceId: invoiceId })).toEqual({ state: 'loading' });
  expect(financeInvoiceDetailState({ feedback: 'loading', invoices: [otherInvoice], resourceId: invoiceId })).toEqual({
    state: 'loading',
  });
  expect(financeInvoiceDetailState({ feedback: 'unavailable', resourceId: invoiceId })).toEqual({
    state: 'unavailable',
  });
  expect(financeInvoiceDetailState({ feedback: 'conflict', resourceId: invoiceId })).toEqual({
    state: 'unavailable',
  });
  expect(financeInvoiceDetailState({ feedback: 'validation', resourceId: invoiceId })).toEqual({
    state: 'unavailable',
  });
});

it('keeps a denied command visible but never substitutes a stale row for a denied read', () => {
  // A denied write (confirm/void) keeps the invoice the authorized ledger holds on screen; the toast explains it.
  expect(financeInvoiceDetailState({ feedback: 'forbidden', invoices: [invoice], resourceId: invoiceId })).toEqual({
    invoice,
    state: 'ready',
  });
  // A denied ledger read has no ready ledger, so the explicit target is honestly denied.
  expect(financeInvoiceDetailState({ feedback: 'forbidden', resourceId: invoiceId })).toEqual({ state: 'forbidden' });
  // It never falls back to another invoice a previous ledger happened to hold.
  expect(financeInvoiceDetailState({ feedback: 'forbidden', invoices: [otherInvoice], resourceId: invoiceId })).toEqual(
    { state: 'forbidden' },
  );
});

it('maps a failed read to unavailable, not forbidden, and never to another invoice', () => {
  expect(financeInvoiceDetailState({ feedback: 'unavailable', resourceId: invoiceId })).toEqual({
    state: 'unavailable',
  });
  expect(
    financeInvoiceDetailState({ feedback: 'unavailable', invoices: [otherInvoice], resourceId: invoiceId }),
  ).toEqual({ state: 'unavailable' });
});

const explicitTargetFeedbacks = [
  'loading',
  'ready',
  'saving',
  'forbidden',
  'conflict',
  'validation',
  'unavailable',
] as const;

it('keeps every explicit target a resolved state, so the page never silently falls back to the list', () => {
  for (const feedback of explicitTargetFeedbacks) {
    expect(financeInvoiceDetailState({ feedback, invoices: [], resourceId: invoiceId }) === undefined).toBe(false);
  }
});
