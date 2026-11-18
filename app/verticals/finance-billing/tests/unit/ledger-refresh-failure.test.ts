// @rstest-environment happy-dom
import { acted, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { HttpServerResponse } from 'effect/http';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import {
  InvoiceSchema,
  RecordsApi,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  RecordsUnavailableProblemSchema,
} from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { FinanceInvoiceTable } from '../../src/routes/[lang]/finance/invoices-table.tsx';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { preloadFinanceRecords, useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

/**
 * A ledger that loaded empty successfully, then failed its refresh, used to tell the user the empty list is the
 * answer: `PageData` kept the last-good ready snapshot on a failed revalidation and the hook derived `feedback`
 * from that snapshot state alone, so the table's empty state read "no invoices yet" and no error appeared. These
 * tests render the real hook result into the real invoices table. A failed refresh must surface its failure and
 * must not present the last-good rows (or write access) as the current answer; a denied read must clear them too.
 */

const emptyLedger = Schema.decodeSync(RecordsResponseSchema)({
  businessDate: '2026-10-05',
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
  revision: 3,
  state: { financialPlanEntries: [], invoices: [] },
}) satisfies RecordsResponse;

const unavailable = RecordsUnavailableProblemSchema.make({
  detail: 'Ledger unavailable',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:ontos:test:records-unavailable',
});
const forbidden = RecordsForbiddenProblemSchema.make({
  detail: 'Ledger access denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:ontos:test:records-forbidden',
});
const czech = moduleText('cs');
const successfulEmptyKey = 'finance-billing.faktury.emptyFirstTitle';
const failureKey = 'finance-billing.faktury.loadError';

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

const invoiceInput = {
  ...invoiceFields,
  documentNumber: 'FV-2026-0001',
  number: 'FV-2026-0001',
  ref: {
    moduleId: 'finance.billing',
    resourceId: invoiceId,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
} as const;

const otherInvoiceInput = {
  ...invoiceFields,
  documentNumber: 'FV-2026-0002',
  number: 'FV-2026-0002',
  ref: {
    moduleId: 'finance.billing',
    resourceId: otherInvoiceId,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
} as const;

const invoice = Schema.decodeSync(InvoiceSchema)(invoiceInput);

const ledgerWithInvoices = Schema.decodeUnknownSync(RecordsResponseSchema)({
  ...emptyLedger,
  state: { ...emptyLedger.state, invoices: [otherInvoiceInput, invoiceInput] },
}) satisfies RecordsResponse;

/** One shape for the user-visible outcome, so a failure shows the whole answer the screen gives. */
const messageOf = (feedback: string, html: string) => ({
  feedback,
  showsFailure: html.includes(czech(failureKey)),
  showsSuccessfulEmpty: html.includes(czech(successfulEmptyKey)),
});

/** The real table, fed by the real ledger hook; the render captures the hook result for assertions. */
/** The verified Shell context the page receives; the ledger cache is keyed by its scope. */
const shellContext = {
  legalEntityId: 'b0000000-0000-4000-8000-000000000011',
  principalId: 'principal-accountant',
  tenantId,
};

const rendered: ReturnType<typeof useFinanceRecords>[] = [];
const LedgerHarness = () => {
  const vm = useFinanceRecords({ scope: financePageScope(shellContext) });
  rendered.push(vm);
  return createElement(FinanceInvoiceTable, { vm });
};

const currentLedger = () => {
  const vm = rendered.at(-1);
  expect(vm).toBeDefined();
  if (vm === undefined) {
    throw new Error('the finance ledger hook did not render');
  }
  return { html: text(), vm };
};

let query = '';
let answer: Effect.Effect<
  RecordsResponse,
  typeof RecordsUnavailableProblemSchema.Type | typeof RecordsForbiddenProblemSchema.Type
> = Effect.succeed(emptyLedger);
const reads: RecordsRequest[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return answer;
        }),
      ),
    ),
  ),
  HttpRouter.add(
    'GET',
    '/shell-super-app-api/auth/session',
    Effect.succeed(HttpServerResponse.jsonUnsafe({ identity: { displayName: 'Accountant' } })),
  ),
);

const renderLedger = () =>
  Effect.gen(function* mountLedger() {
    unmountAll();
    rendered.length = 0;
    yield* mountInRoute(createElement(LedgerHarness), { path: 'finance', url: `/cs/finance${query}` });
    return currentLedger();
  });

/** Preload and mount use the same real router query and owner records endpoint. */
const preload = (
  partyId: string,
  search: Pick<RecordsRequest, 'resourceId'> = {},
  ledger: RecordsResponse = emptyLedger,
) =>
  Effect.gen(function* preloadLedger() {
    query = `?${new URLSearchParams({ partyId, ...search })}`;
    answer = Effect.succeed(ledger);
    yield* preloadFinanceRecords(query, shellContext);
  });

/** Wait for recorded owner reads and the mounted view's settled feedback, never for spy calls. */
const settleLedgerReads = (label: string, count: number) =>
  Effect.gen(function* settled() {
    yield* waitUntil(() => reads.length >= count && currentLedger().vm.feedback !== 'loading');
    expect(reads.length, label).toBeGreaterThanOrEqual(count);
    return currentLedger();
  });
const settleRefresh = (label: string) => settleLedgerReads(label, 2);

describe('finance ledger after a successful empty load', () => {
  beforeEach(() => {
    reads.length = 0;
    rendered.length = 0;
    answer = Effect.succeed(emptyLedger);
    query = '';
  });
  afterEach(unmountAll);

  it.live('shows the successful empty state when the ledger really is empty', () =>
    Effect.gen(function* initialSuccess() {
      yield* pinTestDocument;
      yield* preload('ledger-refresh-initial');
      const { html, vm } = yield* renderLedger();
      expect(vm.feedback).toBe('ready');
      expect(vm.snapshot?.revision).toBe(emptyLedger.revision);
      expect(vm.invoices).toEqual([]);
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'ready',
        showsFailure: false,
        showsSuccessfulEmpty: true,
      });
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );

  it.live('promises the create button only to a user who can write', () =>
    Effect.gen(function* emptyByPermission() {
      yield* pinTestDocument;
      const createHint = czech('finance-billing.faktury.emptyFirstDescription');
      const readOnlyHint = czech('finance-billing.faktury.emptyFirstReadOnlyDescription');
      yield* preload('ledger-empty-writer');
      const writer = yield* renderLedger();
      expect(writer.vm.canWrite).toBe(true);
      expect({ create: writer.html.includes(createHint), readOnly: writer.html.includes(readOnlyHint) }).toEqual({
        create: true,
        readOnly: false,
      });

      yield* preload('ledger-empty-reader', {}, { ...emptyLedger, canWrite: false });
      const reader = yield* renderLedger();
      expect(reader.vm.canWrite).toBe(false);
      expect({ create: reader.html.includes(createHint), readOnly: reader.html.includes(readOnlyHint) }).toEqual({
        create: false,
        readOnly: true,
      });
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );

  it.live('shows loading, not an empty ledger, before the first read settles', () =>
    Effect.gen(function* pendingLoad() {
      yield* pinTestDocument;
      query = '?partyId=ledger-refresh-pending';
      answer = Effect.never;
      const { html, vm } = yield* renderLedger();

      expect(vm.feedback).toBe('loading');
      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'loading',
        showsFailure: false,
        showsSuccessfulEmpty: false,
      });
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );

  it.live('never reports successful emptiness when the refresh is unavailable', () =>
    Effect.gen(function* transientFailure() {
      yield* pinTestDocument;
      yield* preload('ledger-refresh-unavailable');
      const healthy = yield* renderLedger();
      expect(messageOf(healthy.vm.feedback, healthy.html).showsSuccessfulEmpty).toBe(true);

      answer = Effect.fail(unavailable);
      yield* acted(() => healthy.vm.reload());
      const { html, vm } = yield* settleRefresh('unavailable refresh');

      // The failed read is not a ledger: a last-good row and its write access are not presented as current.
      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
      // What the user is told: a failure, not "there are no invoices yet".
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'unavailable',
        showsFailure: true,
        showsSuccessfulEmpty: false,
      });

      // A later successful read restores the ledger instead of pinning the failure.
      answer = Effect.succeed(emptyLedger);
      yield* acted(() => vm.reload());
      const recovered = yield* settleLedgerReads('recovered ledger read', 3);
      expect(recovered.vm.feedback).toBe('ready');
      expect(recovered.vm.snapshot?.revision).toBe(emptyLedger.revision);
      expect(messageOf(recovered.vm.feedback, recovered.html)).toEqual({
        feedback: 'ready',
        showsFailure: false,
        showsSuccessfulEmpty: true,
      });
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );

  it.live('distinguishes a denied refresh from an unavailable one', () =>
    Effect.gen(function* deniedFailure() {
      yield* pinTestDocument;
      yield* preload('ledger-refresh-forbidden');
      const healthy = yield* renderLedger();
      answer = Effect.fail(forbidden);
      yield* acted(() => healthy.vm.reload());
      const { html, vm } = yield* settleRefresh('forbidden refresh');

      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'forbidden',
        showsFailure: true,
        showsSuccessfulEmpty: false,
      });
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );

  it.live('keeps an explicit invoice target unavailable, never a stale row, when the refresh is unavailable', () =>
    Effect.gen(function* detailUnavailable() {
      yield* pinTestDocument;
      yield* preload('ledger-refresh-detail-unavailable', { resourceId: invoiceId }, ledgerWithInvoices);
      const healthy = yield* renderLedger();
      expect(healthy.vm.invoiceDetail).toEqual({ invoice, state: 'ready' });

      answer = Effect.fail(unavailable);
      yield* acted(() => healthy.vm.reload());
      const { vm } = yield* settleRefresh('unavailable detail refresh');

      expect(vm.feedback).toBe('unavailable');
      expect(vm.invoiceDetail).toEqual({ state: 'unavailable' });
      expect(vm.selected).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );

  it.live('reports a denied refresh of an explicit invoice target as forbidden, not unavailable', () =>
    Effect.gen(function* detailForbidden() {
      yield* pinTestDocument;
      yield* preload('ledger-refresh-detail-forbidden', { resourceId: invoiceId }, ledgerWithInvoices);
      const healthy = yield* renderLedger();
      expect(healthy.vm.invoiceDetail).toEqual({ invoice, state: 'ready' });

      answer = Effect.fail(forbidden);
      yield* acted(() => healthy.vm.reload());
      const { vm } = yield* settleRefresh('forbidden detail refresh');

      expect(vm.feedback).toBe('forbidden');
      expect(vm.invoiceDetail).toEqual({ state: 'forbidden' });
      expect(vm.selected).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );
});
