// @rstest-environment happy-dom
import { EmailReceiptsApi } from '@app/email-delivery/receipt-api';
import { settle, text, unmountAll } from '@app/admin-ui/testing/module-ui';
import { browserNetwork, pinTestDocument, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { afterEach, expect, it } from 'effect-rstest';
import { DateTime, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { createElement } from 'react';
import type { ComponentProps } from 'react';

import type { Invoice, InvoiceReminder } from '../../shared/apis/records.ts';
import { InvoiceReminderSchema } from '../../shared/apis/records.ts';
import { InvoiceReminders, invoiceReminderDraftKey } from '../../src/routes/[lang]/finance/invoice-extras.tsx';
import { InvoiceIssuerSessionSchema } from '../../src/routes/[lang]/finance/use-invoice-issuer.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const czech = moduleText('cs');
const ReceiptsApi = EmailReceiptsApi.prefix('/shell-super-app-api');
const receipts = HttpApiBuilder.group(ReceiptsApi, 'emailReceipts', (group) =>
  group
    .handle('provider', () => Effect.succeed({ configured: true, label: Option.none() }))
    .handle('list', () => Effect.succeed({ deliveries: [] })),
);
const IssuerApi = HttpApi.make('FinanceReminderIssuerTestApi')
  .add(
    HttpApiGroup.make('authentication').add(
      HttpApiEndpoint.get('currentSession', '/auth/session', { success: InvoiceIssuerSessionSchema }),
    ),
  )
  .prefix('/shell-super-app-api');
const issuer = HttpApiBuilder.group(IssuerApi, 'authentication', (group) =>
  group.handle('currentSession', () =>
    Effect.succeed(
      Schema.decodeUnknownSync(InvoiceIssuerSessionSchema)({
        identity: { legalEntityId: 'company-a', legalName: 'OntOS Demo s.r.o.' },
        state: 'authenticated',
      }),
    ),
  ),
);
const network = browserNetwork(serveApi(ReceiptsApi, receipts), serveApi(IssuerApi, issuer));

afterEach(unmountAll);

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
  scope: 'finance-reminder-test-scope',
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
  Effect.gen(function* render() {
    yield* pinTestDocument;
    yield* mountInRoute(
      createElement(InvoiceReminders, {
        counterpartyName: 'Dodavatel Materiál s.r.o.',
        invoice: shown,
        vm: model(reminders),
      }),
      { path: 'finance', url: '/cs/finance' },
    );
    yield* settle;
    return text();
  });

const outgoingConfirmed = invoice('invoice-outgoing');
const incomingConfirmed = invoice('invoice-incoming', { direction: 'INCOMING' });

it.live('never offers prepare/send on an incoming supplier invoice while keeping its reminder history', () =>
  Effect.gen(function* incomingHistory() {
    const content = yield* renderReminders(incomingConfirmed, [reminder(incomingConfirmed.ref.resourceId)]);
    expect(content).toContain(czech('finance-billing.financeUi.reminders.title'));
    expect(content).not.toContain('Připravit upomínku');
    expect(document.querySelectorAll('#reminder-recipient')).toHaveLength(0);
    expect(content).not.toContain('Odeslat e-mailem');
    expect(content).toContain('odberatel@example.cz');
  }).pipe(Effect.provide(network)),
);

it.live('keeps the prepare action on an outgoing confirmed unpaid invoice', () =>
  Effect.gen(function* outgoingUnpaid() {
    const content = yield* renderReminders(outgoingConfirmed);
    expect(content).toContain('Připravit upomínku');
    expect(content).toContain(czech('finance-billing.financeUi.reminders.empty'));
  }).pipe(Effect.provide(network)),
);

it.live('refuses the action for draft, voided and settled documents', () =>
  Effect.gen(function* ineligibleDocuments() {
    for (const overrides of [
      { businessState: 'DRAFT' as const },
      { businessState: 'VOIDED' as const },
      { paidMinor: 100_000, paymentState: 'PAID' as const },
    ]) {
      const content = yield* renderReminders(invoice('invoice-ineligible', overrides));
      expect(content).toContain(czech('finance-billing.financeUi.reminders.title'));
      expect(content).not.toContain('Připravit upomínku');
      unmountAll();
    }
  }).pipe(Effect.provide(network)),
);

it.live('explains that incoming invoices get no reminders when they have no history', () =>
  Effect.gen(function* incomingEmpty() {
    const content = yield* renderReminders(incomingConfirmed);
    expect(content).toContain(czech('finance-billing.financeUi.reminders.incoming'));
  }).pipe(Effect.provide(network)),
);

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
