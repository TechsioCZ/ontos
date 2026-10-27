import { expect, it } from 'effect-rstest';
import { DateTime, Schema } from 'effect';
import { FinanceRecordsViewSchema } from '../../src/api/finance-reads.ts';

const invoice = {
  accountingCorrelation: 'acc-1',
  accountingSyncState: 'SYNCED',
  businessState: 'CONFIRMED',
  counterpartyName: 'Elektro Šimánek s.r.o.',
  counterpartyRef: { moduleId: 'party.registry', resourceId: 'cp-1', resourceType: 'x', tenantId: 't' },
  createdAt: '2026-10-01T08:00:00.000Z',
  currency: 'CZK',
  direction: 'INCOMING',
  documentNumber: 'FA-2026-3318',
  dueDate: '2026-10-15',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: 'inv-1', resourceType: 'invoice', tenantId: 't' },
  sourceOrder: { id: 'po-1', number: 'OBJ-2026-0003' },
  totalMinor: 12_100,
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const response = {
  businessDate: '2026-10-21',
  canWrite: false,
  indicators: { draftCount: 1 },
  referenceDate: '2026-10-05',
  revision: 42,
  state: {
    documents: [
      {
        actorLabel: 'Finance (finance@siampark.demo)',
        fileName: 'faktura-2026-412.pdf',
        id: 'doc-1',
        invoiceResourceId: 'inv-1',
        mimeType: 'application/pdf',
        sha256: 'abc',
        sizeBytes: 2048,
        uploadedAt: '2026-10-02T09:00:00.000Z',
      },
    ],
    financialPlanEntries: [],
    invoices: [invoice],
  },
};

const decode = Schema.decodeUnknownSync(FinanceRecordsViewSchema);

it('reads the Finance fields provoz uses', () => {
  const view = decode(response);
  expect(view.canWrite).toBe(false);
  expect(view.revision).toBe(42);
  expect(view.state.invoices[0]?.sourceOrder?.number).toBe('OBJ-2026-0003');
  expect(view.state.documents?.[0]?.invoiceResourceId).toBe('inv-1');
});

it('decodes upload instants natively without changing the Finance wire dates', () => {
  const view = decode(response);
  expect(view.state.documents?.map((file) => DateTime.isUtc(file.uploadedAt))).toEqual([true]);
  const encoded = Schema.encodeSync(FinanceRecordsViewSchema)(view);
  expect(encoded.state.documents?.[0]?.uploadedAt).toBe('2026-10-02T09:00:00.000Z');
  expect(encoded.state.invoices[0]?.dueDate).toBe('2026-10-15');
  expect(encoded.state.invoices[0]?.issueDate).toBe('2026-10-01');
  expect(encoded.businessDate).toBe('2026-10-21');
});

it('keeps working when Finance adds fields, states and document kinds', () => {
  const additive = {
    ...response,
    futureIndicator: { anything: true },
    state: {
      ...response.state,
      futureCollection: [{ id: 'x' }],
      invoices: [
        {
          ...invoice,
          businessState: 'ARCHIVED_IN_FUTURE',
          documentKind: 'SOMETHING_NEW',
          exportState: 'HANDED_OVER',
          newNestedField: { deep: [1, 2, 3] },
          paymentState: 'OVERPAID',
          reviewState: 'APPROVED',
        },
      ],
    },
  };
  const view = decode(additive);
  expect(view.state.invoices).toHaveLength(1);
  expect(view.state.invoices[0]?.businessState).toBe('ARCHIVED_IN_FUTURE');
  expect(view.state.invoices[0]?.documentNumber).toBe('FA-2026-3318');
});
