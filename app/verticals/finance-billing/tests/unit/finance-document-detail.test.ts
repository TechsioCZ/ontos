import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { FinanceDocumentSchema, InvoiceSchema } from '../../shared/apis/records.ts';
import {
  customerInvoiceFilterKey,
  decodeCustomerInvoiceSearch,
  recordsRequestFromQuery,
} from '../../src/routes/[lang]/finance/use-finance-records.ts';
import {
  financeDocumentDetailPath,
  financeDocumentDetailState,
  financeDocumentInvoiceLink,
  financeDocumentRecordTarget,
  financeRecordDetailConflict,
  financeDocumentReadLifetime,
} from '../../src/routes/[lang]/finance/finance-document-detail.ts';

it('discards superseded document reads and every pending read when the detail is removed', () => {
  const lifetime = financeDocumentReadLifetime();
  const first = lifetime.begin();
  expect(first()).toBe(true);
  const second = lifetime.begin();
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  lifetime.invalidate();
  expect(first()).toBe(false);
  expect(second()).toBe(false);
  const afterRemount = lifetime.begin();
  expect(afterRemount()).toBe(true);
  expect(second()).toBe(false);
});

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const documentId = 'b0000000-0000-4000-8000-000000000101';
const invoiceId = 'c0000000-0000-4000-8000-000000000201';
const otherInvoiceId = 'd0000000-0000-4000-8000-000000000301';

const document = Schema.decodeSync(FinanceDocumentSchema)({
  actorLabel: 'Jana Nováková',
  fileName: 'faktura-2026-0001.pdf',
  id: documentId,
  invoiceResourceId: invoiceId,
  mimeType: 'application/pdf',
  sha256: 'a'.repeat(64),
  sizeBytes: 2048,
  uploadedAt: '2026-10-20T10:00:00Z',
});

const invoice = Schema.decodeSync(InvoiceSchema)({
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
  documentNumber: 'FV-2026-0001',
  dueDate: '2026-11-03',
  issueDate: '2026-10-20',
  number: 'FV-2026-0001',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: invoiceId,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 121_000,
  updatedAt: '2026-10-20T09:00:00Z',
});

const orphan = Schema.decodeSync(FinanceDocumentSchema)({
  fileName: 'predavaci-protokol.pdf',
  id: 'b0000000-0000-4000-8000-000000000102',
  mimeType: 'application/pdf',
  sha256: 'b'.repeat(64),
  sizeBytes: 512,
  uploadedAt: '2026-10-21T10:00:00Z',
});

const missingInvoiceLink = Schema.decodeSync(FinanceDocumentSchema)({
  fileName: 'stornovana-faktura.pdf',
  id: 'b0000000-0000-4000-8000-000000000103',
  invoiceResourceId: otherInvoiceId,
  mimeType: 'application/pdf',
  sha256: 'c'.repeat(64),
  sizeBytes: 700,
  uploadedAt: '2026-10-22T10:00:00Z',
});

it('opens the document UUID as documentId, never as the invoice resourceId', () => {
  const search = Option.getOrUndefined(decodeCustomerInvoiceSearch({ documentId }));
  expect(search?.documentId).toBe(documentId);
  expect(search?.resourceId).toBeUndefined();
  expect(financeDocumentRecordTarget(documentId)).toEqual({ search: { documentId }, to: '/finance' });
  expect(Object.keys(financeDocumentRecordTarget(documentId).search)).toEqual(['documentId']);
  expect(financeDocumentDetailPath(documentId)).toBe(`/finance?documentId=${documentId}`);
  // The ledger request still loads the full owner snapshot, and the document ID does not become an invoice filter.
  expect(Option.getOrUndefined(recordsRequestFromQuery(`?documentId=${documentId}`))).toEqual({});
});

it('resolves the exact authorized document metadata and distinguishes a missing ID', () => {
  expect(financeDocumentDetailState({ documentId, documents: [orphan, document], feedback: 'ready' })).toMatchObject({
    document: { fileName: document.fileName, id: documentId },
    state: 'ready',
  });
  expect(financeDocumentDetailState({ documentId, documents: [orphan], feedback: 'ready' })).toEqual({
    state: 'missing',
  });
  expect(financeDocumentDetailState({ documentId, documents: [], feedback: 'ready' })).toEqual({
    state: 'missing',
  });
});

it('hides the document after a denied read even if an earlier snapshot still holds it', () => {
  expect(financeDocumentDetailState({ documentId, documents: [document], feedback: 'forbidden' })).toEqual({
    state: 'forbidden',
  });
});

it('separates loading, unavailable and invalid document states', () => {
  expect(financeDocumentDetailState({ documentId, feedback: 'loading' })).toEqual({
    state: 'loading',
  });
  expect(financeDocumentDetailState({ documentId, documents: [], feedback: 'unavailable' })).toEqual({
    state: 'unavailable',
  });
  expect(financeDocumentDetailState({ documentId, documents: [document], feedback: 'conflict' })).toEqual({
    state: 'unavailable',
  });
  expect(financeDocumentDetailState({ documentId: 'not-a-uuid', documents: [document], feedback: 'ready' })).toEqual({
    state: 'invalid',
  });
  expect(financeDocumentDetailState({ documents: [document], feedback: 'ready' })).toEqual({
    state: 'invalid',
  });
});

it('links only the invoice named by the document, and reports a missing or absent link honestly', () => {
  expect(financeDocumentInvoiceLink([invoice], document)).toEqual({ invoice, kind: 'linked' });
  expect(financeDocumentInvoiceLink([], document)).toEqual({
    invoiceResourceId: invoiceId,
    kind: 'missing',
  });
  expect(financeDocumentInvoiceLink([], orphan)).toEqual({ kind: 'none' });
  expect(financeDocumentInvoiceLink([invoice], missingInvoiceLink)).toEqual({
    invoiceResourceId: otherInvoiceId,
    kind: 'missing',
  });
});

it('keeps the existing invoice detail selection unchanged', () => {
  const search = Option.getOrUndefined(decodeCustomerInvoiceSearch({ resourceId: invoiceId }));
  expect(search?.resourceId).toBe(invoiceId);
  expect(search?.documentId).toBeUndefined();
  expect(financeRecordDetailConflict({ resourceId: invoiceId })).toBe(false);
  expect(financeRecordDetailConflict({ documentId })).toBe(false);
  expect(financeRecordDetailConflict({ documentId, resourceId: invoiceId })).toBe(true);
  expect(Option.getOrUndefined(recordsRequestFromQuery(`?resourceId=${invoiceId}`))).toEqual({});
  expect(customerInvoiceFilterKey({ resourceId: invoiceId })).toBe(customerInvoiceFilterKey({}));
  expect(customerInvoiceFilterKey({ documentId })).toBe(customerInvoiceFilterKey({}));
});
