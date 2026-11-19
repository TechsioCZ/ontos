// @rstest-environment happy-dom
import { CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../../finance-billing/api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '@app/finance-billing/contracts/apply-command';
import type { ApplyCommandPayloadSchema } from '@app/finance-billing/contracts/apply-command';
import { InvoiceSchema, RecordsApi, RecordsResponseSchema } from '@app/finance-billing/contracts/records';
import type { RecordsRequest } from '@app/finance-billing/contracts/records';
import {
  ApplyCommandActionApi,
  ApplyCommandActionCommitIndeterminateProblemSchema,
} from '../../../finance-billing/shared/apis/apply-command-action.ts';
import { VatChoicesApi, VatChoicesResponseSchema } from '../../../finance-billing/shared/apis/vat-choices.ts';
import type { VatChoicesRequest } from '../../../finance-billing/shared/apis/vat-choices.ts';
import { FinanceConflictProblemSchema } from '../../../finance-billing/shared/finance-action-problems.ts';
import { SalesOrderSchema } from '../../shared/domain/purchasing.ts';
import { issueSalesInvoice } from '../../src/routes/[lang]/provoz/nakupy/sales-tab.tsx';
import { recordingRunner } from './form-save-fixture.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const timestamp = '2026-11-14T09:00:00Z';
const issueDate = '2026-11-14';
const order = Schema.decodeUnknownSync(SalesOrderSchema)({
  createdAt: timestamp,
  createdBy: actor,
  currency: 'CZK',
  customer: { counterpartyId: '73000000-0000-4000-8000-000000000001', name: 'Customer', tenantId },
  deliveries: [],
  history: [],
  id: 'order-1',
  invoices: [],
  lines: [
    { deliveredQuantity: 0, description: 'Service', id: 'line-1', quantity: 1, unitPriceMinor: 10_000, vatRate: 21 },
  ],
  number: 'PRO-2026-001',
  status: 'approved',
  updatedAt: timestamp,
  updatedBy: actor,
});
const invoice = Schema.decodeUnknownSync(InvoiceSchema)({
  accountingCorrelation: 'sales-invoice-test',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'DRAFT',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: order.customer.counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: timestamp,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'PRO-2026-001-F1',
  dueDate: issueDate,
  issueDate,
  number: 'FV-2026-0001',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: 'invoice-1', resourceType: 'finance.billing.invoice', tenantId },
  sourceOrder: { id: 'order-1', number: 'PRO-2026-001' },
  totalMinor: 12_100,
  updatedAt: timestamp,
});
const snapshot = (invoices: readonly (typeof InvoiceSchema.Type)[]) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    canWrite: true,
    indicators: {
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
    },
    referenceDate: '2026-10-05',
    revision: 1,
    state: { financialPlanEntries: [], invoices: invoices.map((current) => Schema.encodeSync(InvoiceSchema)(current)) },
  });
const vatChoices = Schema.decodeUnknownSync(VatChoicesResponseSchema)({
  on: issueDate,
  rates: [
    {
      code: CZ_VAT_STANDARD,
      effectiveFrom: timestamp,
      ratePercent: 21,
      taxRuleRevisionRef: {
        moduleId: 'commerce.tax',
        resourceId: 'revision-1',
        resourceType: 'commerce.tax.tax-rule-revision',
        tenantId,
      },
    },
  ],
  regime: 'VAT_PAYER',
});
const createdInvoice = (current = invoice) =>
  Schema.decodeUnknownSync(ApplyCommandResultSchema)({
    changed: true,
    invoice: Schema.encodeSync(InvoiceSchema)(current),
    revision: 2,
  });
const creates: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const reads: RecordsRequest[] = [];
const vatReads: VatChoicesRequest[] = [];
const failures: true[] = [];
let financeRecords = snapshot([]);
let createAnswer: Effect.Effect<
  typeof ApplyCommandResultSchema.Type,
  typeof FinanceConflictProblemSchema.Type | typeof ApplyCommandActionCommitIndeterminateProblemSchema.Type
> = Effect.succeed(createdInvoice());

const OwnerActionApi = ApplyCommandActionApi.prefix('/finance-billing-api');
const OwnerRecordsApi = RecordsApi.prefix('/finance-billing-api');
const OwnerVatApi = VatChoicesApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          creates.push(payload);
        }).pipe(Effect.andThen(Effect.suspend(() => createAnswer))),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return financeRecords;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerVatApi,
    HttpApiBuilder.group(OwnerVatApi, 'vatChoices', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          vatReads.push(payload);
          return vatChoices;
        }),
      ),
    ),
  ),
);

beforeEach(() => {
  creates.length = 0;
  reads.length = 0;
  vatReads.length = 0;
  failures.length = 0;
  financeRecords = snapshot([]);
  createAnswer = Effect.succeed(createdInvoice());
});

const attempt = (runner: ReturnType<typeof recordingRunner>, current = order) =>
  // Every attempt starts with nothing kept in the browser: a new panel, tab, device or person.
  issueSalesInvoice({
    busy: { current: false },
    dueDate: issueDate,
    issueDate,
    onFailed: () => {
      failures.push(true);
    },
    order: current,
    run: runner.run,
  });

it.live('Finance drafts the invoice under the identity of the order, never under a guessed number', () =>
  Effect.gen(function* draftUnderOrderIdentity() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    const outcome = yield* attempt(runner);
    yield* networkIdle;
    expect(outcome).toMatchObject({ number: invoice.number, ok: true });
    const [payload] = creates;
    expect(payload).toMatchObject({ command: { sourceOrder: { id: order.id, number: order.number } } });
    expect(payload).not.toHaveProperty('command.documentNumber');
    expect(runner.sent).toEqual([
      {
        _tag: 'SalesOrderLinkInvoice',
        invoiceId: invoice.ref.resourceId,
        number: invoice.number,
        orderId: order.id,
        totalMinor: invoice.totalMinor,
      },
    ]);
  }).pipe(Effect.provide(network)),
);

it.live('after a failed link a fresh attempt links the invoice Finance holds for the order and creates none', () =>
  Effect.gen(function* retryOnlyLink() {
    yield* pinTestDocument;
    const runner = recordingRunner(['unavailable']);
    const failedLink = yield* attempt(runner);
    yield* networkIdle;
    expect(failedLink).toMatchObject({ number: invoice.number, ok: false, reason: 'link' });
    financeRecords = snapshot([invoice]);
    const linked = yield* attempt(runner);
    yield* networkIdle;
    expect(linked).toMatchObject({ number: invoice.number, ok: true });
    expect(creates).toHaveLength(1);
    expect(vatReads).toHaveLength(1);
    expect(runner.sent).toHaveLength(2);
    expect(runner.sent[1]).toEqual(runner.sent[0]);
    expect(Predicate.isTagged(runner.sent[1], 'SalesOrderLinkInvoice')).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('when Finance stored the invoice but its answer was lost, the retry links that invoice', () =>
  Effect.gen(function* lostAnswer() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    // Finance commits, but cannot return a determinate successful answer to this attempt.
    createAnswer = Effect.sync(() => {
      financeRecords = snapshot([invoice]);
    }).pipe(
      Effect.andThen(
        Effect.fail(
          ApplyCommandActionCommitIndeterminateProblemSchema.make({
            detail: 'The invoice was stored but the answer was lost.',
            invocationId: 'invoice-create-lost-answer',
            resolution: 'RESOLVE_COMMIT',
            retryCommand: false,
            status: 503,
            title: 'Action commit uncertain',
            type: 'https://ontos.dev/problems/action-commit-indeterminate',
          }),
        ),
      ),
    );
    const lost = yield* attempt(runner);
    yield* networkIdle;
    expect(lost.ok).toBe(false);
    expect(runner.sent).toEqual([]);
    // Finance is read again, so the panel shows the invoice that now waits for its link.
    expect(failures).toHaveLength(1);
    financeRecords = snapshot([invoice]);
    const linked = yield* attempt(runner);
    yield* networkIdle;
    expect(linked).toMatchObject({ number: invoice.number, ok: true });
    expect(creates).toHaveLength(1);
    expect(runner.sent).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('an invoice of another order, an advance or a voided one is not the order invoice and is never linked', () =>
  Effect.gen(function* foreignInvoices() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    financeRecords = snapshot([
      { ...invoice, businessState: 'VOIDED', ref: { ...invoice.ref, resourceId: 'voided' } },
      {
        ...invoice,
        ref: { ...invoice.ref, resourceId: 'other-order' },
        sourceOrder: { id: 'order-2', number: 'PRO-2026-002' },
      },
      { ...invoice, documentKind: 'ADVANCE', ref: { ...invoice.ref, resourceId: 'advance' } },
    ]);
    // Finance answering with an invoice that is not this order's is refused, not linked.
    createAnswer = Effect.succeed(createdInvoice({ ...invoice, sourceOrder: { id: 'order-2', number: 'X' } }));
    const outcome = yield* attempt(runner);
    yield* networkIdle;
    expect(outcome.ok).toBe(false);
    expect(creates).toHaveLength(1);
    expect(runner.sent).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('the order invoice issued to another customer in Finance is refused, never created again or linked', () =>
  Effect.gen(function* otherCustomerInFinance() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    financeRecords = snapshot([
      {
        ...invoice,
        counterpartyRef: { ...invoice.counterpartyRef, resourceId: '73000000-0000-4000-8000-000000000002' },
      },
    ]);
    const outcome = yield* attempt(runner);
    yield* networkIdle;
    expect(outcome).toMatchObject({ ok: false, reason: 'customer' });
    expect(creates).toHaveLength(0);
    expect(runner.sent).toEqual([]);
    expect(failures).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live("Finance's refusal for another customer reads as that, not as a generic failure", () =>
  Effect.gen(function* otherCustomerRefusal() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    createAnswer = Effect.fail(
      FinanceConflictProblemSchema.make({
        code: 'finance_conflict',
        detail: 'source_order_invoice_other_counterparty',
        status: 409,
        title: 'Action conflict',
        type: 'https://ontos.dev/problems/action-conflict',
      }),
    );
    const outcome = yield* attempt(runner);
    yield* networkIdle;
    expect(outcome).toMatchObject({ ok: false, reason: 'customer' });
    expect(runner.sent).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('amounts edited in Finance are still the order invoice; the link takes number and amount from Finance', () =>
  Effect.gen(function* editedInFinance() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    financeRecords = snapshot([{ ...invoice, number: 'FV-2026-0002', totalMinor: 36_300 }]);
    const outcome = yield* attempt(runner);
    yield* networkIdle;
    expect(outcome).toMatchObject({ number: 'FV-2026-0002', ok: true });
    expect(creates).toHaveLength(0);
    expect(runner.sent).toEqual([
      {
        _tag: 'SalesOrderLinkInvoice',
        invoiceId: invoice.ref.resourceId,
        number: 'FV-2026-0002',
        orderId: order.id,
        totalMinor: 36_300,
      },
    ]);
  }).pipe(Effect.provide(network)),
);

it.live('already linked orders refuse Finance creation before any read or write', () =>
  Effect.gen(function* refuseDuplicate() {
    yield* pinTestDocument;
    const runner = recordingRunner();
    const linkedOrder = Schema.decodeUnknownSync(SalesOrderSchema)({
      ...Schema.encodeSync(SalesOrderSchema)(order),
      invoices: [{ invoiceId: invoice.ref.resourceId, linkedAt: timestamp, linkedBy: actor, number: invoice.number }],
    });
    const outcome = yield* attempt(runner, linkedOrder);
    yield* networkIdle;
    expect(outcome.ok).toBe(false);
    expect(creates).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(runner.sent).toEqual([]);
  }).pipe(Effect.provide(network)),
);
