import { beforeAll, expect, it, rstest } from 'effect-rstest';
import { DateTime, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import React, { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Invoice, InvoiceReminder } from '../../shared/apis/records.ts';
import { InvoiceReminderSchema } from '../../shared/apis/records.ts';
import {
  InvoiceReminders,
  invoiceReminderDraftKey,
  invoiceReminderEligible,
} from '../../src/routes/[lang]/finance/invoice-extras.tsx';

// The reminders section must render without the records runtime, the e-mail dispatcher or the shell session.
rstest.mock('../../src/routes/[lang]/finance/reminder-email-receipts.tsx', () => ({
  ReminderEmailStatus: () => null,
  useEmailProvider: () => ({ kind: 'ready', provider: { configured: true, label: null } }),
  useReminderEmailReceipts: () => ({ byReminderId: new Map(), kind: 'ready' }),
}));
rstest.mock('../../src/routes/[lang]/finance/use-invoice-issuer.ts', () => ({
  useInvoiceIssuer: () => 'OntOS Demo s.r.o.',
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) => {
      const labels = new Map([
        ['finance-billing.financeUi.reminders.emailExample', 'fakturace@example.cz'],
        ['finance-billing.financeUi.reminders.message', 'Text upomínky'],
        ['finance-billing.financeUi.reminders.recipient', 'Příjemce'],
        ['finance-billing.financeUi.reminders.title', 'Upomínky'],
        ['finance-billing.financeUi.reminders.empty', 'K faktuře zatím nebyla odeslána žádná upomínka.'],
        ['finance-billing.financeUi.reminders.incoming', 'K přijaté faktuře se upomínky neposílají.'],
        [
          'finance-billing.financeUi.reminders.ineligible',
          'Upomínka se připravuje jen k neuhrazené potvrzené faktuře.',
        ],
      ]);
      return labels.get(key) ?? key;
    },
  }),
}));

type RemindersModel = ComponentProps<typeof InvoiceReminders>['vm'];

const tenantId = 'c0000000-0000-4000-8000-000000000001';
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');

const invoice = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: 'c0000000-0000-4000-8000-000000000012',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: id,
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing' as const,
    resourceId: id,
    resourceType: 'finance.billing.invoice' as const,
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});

const reminder = (invoiceResourceId: string, recipient = 'odberatel@example.cz'): InvoiceReminder =>
  Schema.decodeUnknownSync(InvoiceReminderSchema)({
    createdAt: '2026-10-21T08:40:00.000Z',
    deliveryMode: 'EMAIL',
    id: `reminder-${invoiceResourceId}`,
    invoiceResourceId,
    recipient,
    status: 'QUEUED',
    text: 'Prosíme o úhradu faktury.',
  });

/** Optional rental-object label reads have not supplied an answer. */
const unavailableName = (): undefined => {
  // The label is intentionally absent.
};

/** A required view-model member whose value is intentionally absent; the reminder section never reads it. */
const absent = <Value>(): Value | undefined => undefined;

const indicators = {
  costMinor: 0,
  costVarianceMinor: 0,
  draftCount: 0,
  grossOutstandingMinor: 0,
  openIncomingInvoices: 0,
  openInvoices: 0,
  openOutgoingInvoices: 0,
  overdueInvoices: 0,
  payablesOutstandingMinor: 0,
  plannedCostMinor: 0,
  plannedRevenueMinor: 0,
  receivablesOutstandingMinor: 0,
  revenueMinor: 0,
  revenueVarianceMinor: 0,
};

const model = (reminders: readonly InvoiceReminder[]): RemindersModel => ({
  actorLabel: 'Finanční oddělení',
  busy: false,
  cancelConfirm: constVoid,
  cancelVoid: constVoid,
  canWrite: true,
  closeDetail: constVoid,
  closeDocumentDetail: constVoid,
  confirmInvoice: constVoid,
  confirmPending: constVoid,
  confirmTarget: absent<Invoice>(),
  confirmVoid: constVoid,
  createDraft: () => {
    throw new Error('The reminder section must not create drafts while it is only rendered.');
  },
  detailConflict: false,
  documentId: absent<NonNullable<RemindersModel['documentId']>>(),
  execute: () => {
    throw new Error('The reminder section must not execute commands while it is only rendered.');
  },
  feedback: 'ready',
  fetchDocument: () => {
    throw new Error('The reminder section must not fetch documents while it is only rendered.');
  },
  indicators,
  invoiceDetail: absent<NonNullable<RemindersModel['invoiceDetail']>>(),
  invoices: [],
  objects: {
    available: false,
    contractName: unavailableName,
    contracts: [],
    properties: [],
    propertyName: unavailableName,
    unitName: unavailableName,
    units: [],
  },
  openDetail: constVoid,
  referenceDate: '2026-10-05',
  references: {
    customerById: new Map(),
    customers: [],
    customersLoading: false,
    opportunitiesForbidden: false,
    opportunityTitles: new Map(),
    products: [],
    productsFailed: false,
    productsReadable: absent<boolean>(),
    referencesFailed: false,
  },
  relatedCustomer: false,
  reload: constVoid,
  requestVoid: constVoid,
  selected: absent<Invoice>(),
  snapshot: {
    canWrite: true,
    indicators,
    referenceDate: '2026-10-05',
    revision: 1,
    state: { financialPlanEntries: [], invoices: [], reminders },
  },
  t: String,
  voidTarget: absent<Invoice>(),
});

const renderReminders = (shown: Invoice, reminders: readonly InvoiceReminder[] = []) =>
  renderToStaticMarkup(
    createElement(InvoiceReminders, {
      counterpartyName: 'Dodavatel Materiál s.r.o.',
      invoice: shown,
      vm: model(reminders),
    }),
  );

const outgoingConfirmed = invoice('invoice-outgoing');
const incomingConfirmed = invoice('invoice-incoming', { direction: 'INCOMING' });

// This owner's Node test config compiles TSX with the classic React runtime.
beforeAll(() => {
  rstest.stubGlobal('React', React);
});

it('never offers prepare/send on an incoming supplier invoice while keeping its reminder history', () => {
  const html = renderReminders(incomingConfirmed, [reminder(incomingConfirmed.ref.resourceId)]);
  expect(html).toContain('Upomínky');
  expect(html).not.toContain('Připravit upomínku');
  expect(html).not.toContain('reminder-recipient');
  expect(html).not.toContain('Odeslat e-mailem');
  expect(html).toContain('odberatel@example.cz');
});

it('keeps the prepare action on an outgoing confirmed unpaid invoice', () => {
  const html = renderReminders(outgoingConfirmed);
  expect(html).toContain('Připravit upomínku');
  expect(html).toContain('K faktuře zatím nebyla odeslána žádná upomínka.');
});

it('refuses the action for draft, voided and settled documents', () => {
  for (const overrides of [
    { businessState: 'DRAFT' as const },
    { businessState: 'VOIDED' as const },
    { paidMinor: 100_000, paymentState: 'PAID' as const },
  ]) {
    const html = renderReminders(invoice('invoice-ineligible', overrides));
    expect(html).toContain('Upomínky');
    expect(html).not.toContain('Připravit upomínku');
  }
});

it('explains that incoming invoices get no reminders when they have no history', () => {
  expect(renderReminders(incomingConfirmed)).toContain('K přijaté faktuře se upomínky neposílají.');
});

it('gates eligibility on direction, business state and a remaining amount', () => {
  expect(invoiceReminderEligible(outgoingConfirmed)).toBe(true);
  expect(invoiceReminderEligible(incomingConfirmed)).toBe(false);
  expect(invoiceReminderEligible(invoice('invoice-draft', { businessState: 'DRAFT' }))).toBe(false);
  expect(invoiceReminderEligible(invoice('invoice-paid', { paidMinor: 100_000, paymentState: 'PAID' }))).toBe(false);
});

it('keys the reminder card per tenant, document and direction so retained editing state cannot cross invoices', () => {
  const id = 'invoice-same-id';
  expect(invoiceReminderDraftKey(invoice(id))).not.toBe(
    invoiceReminderDraftKey(invoice(id, { direction: 'INCOMING' })),
  );
  const otherTenant = invoice(id, {
    ref: { ...invoice(id).ref, tenantId: 'c0000000-0000-4000-8000-000000000002' },
  });
  expect(invoiceReminderDraftKey(invoice(id))).not.toBe(invoiceReminderDraftKey(otherTenant));
  expect(invoiceReminderDraftKey(invoice(id))).not.toBe(invoiceReminderDraftKey(invoice('invoice-other-id')));
  // The same document keeps its draft across snapshot updates instead of remounting the section.
  expect(invoiceReminderDraftKey(invoice(id))).toBe(invoiceReminderDraftKey(invoice(id)));
});
