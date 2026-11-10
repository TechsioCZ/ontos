import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { FinanceInvoiceTable } from '../../src/routes/[lang]/finance/invoices-table.tsx';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { preloadFinanceRecords, useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';

/**
 * A ledger that loaded empty successfully, then failed its refresh, used to tell the user the empty list is the
 * answer: `PageData` kept the last-good ready snapshot on a failed revalidation and the hook derived `feedback`
 * from that snapshot state alone, so the table's empty state read "no invoices yet" and no error appeared. These
 * tests render the real hook result into the real invoices table. A failed refresh must surface its failure and
 * must not present the last-good rows (or write access) as the current answer; a denied read must clear them too.
 */

interface FinanceTestSearch {
  readonly partyId?: string;
  readonly resourceId?: string;
}

const mocks = rstest.hoisted(() => {
  const search: FinanceTestSearch = {};
  return { location: { search, searchStr: '' }, records: rstest.fn() };
});

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useRouterState: (options?: {
    readonly select?: (state: { readonly location: typeof mocks.location }) => string | FinanceTestSearch | null;
  }) => (options?.select === undefined ? '' : options.select({ location: mocks.location })),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, _options?: Readonly<Record<string, string | number>>) => key,
  }),
}));
// The store is deliberately browser-gated; in the node test the render reads the current entry directly.
rstest.mock('react', () => ({
  ...rstest.requireActual('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

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

const unavailable = { _tag: 'RecordsUnavailableProblem', status: 503 };
const forbidden = { _tag: 'RecordsForbiddenProblem', status: 403 };
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
  showsFailure: html.includes(failureKey),
  showsSuccessfulEmpty: html.includes(successfulEmptyKey),
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

const renderLedger = () => {
  rendered.length = 0;
  const html = renderToStaticMarkup(createElement(LedgerHarness));
  const vm = rendered.at(-1);
  if (vm === undefined) {
    throw new Error('the finance ledger hook did not render');
  }
  return { html, vm };
};

/** The ledger the Shell preloads before the first paint of the page. */
const preload = (
  partyId: string,
  search: Pick<FinanceTestSearch, 'resourceId'> = {},
  ledger: RecordsResponse = emptyLedger,
) =>
  Effect.gen(function* preloadLedger() {
    mocks.location.search = { partyId, ...search };
    mocks.records.mockReturnValue(Effect.succeed(ledger));
    yield* preloadFinanceRecords(`?partyId=${partyId}`, shellContext);
  });

/** Lets the store's runtime run a fiber turn. */
const yieldToLedger = (turns: number): Effect.Effect<void> =>
  Effect.suspend(() => (turns === 0 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(yieldToLedger(turns - 1)))));

/** Polls the mocked read count without a clock read; the turn bound keeps a broken startup from hanging the test. */
const waitForLedgerReads = (reads: number, attempts: number): Effect.Effect<void> =>
  Effect.suspend(() =>
    mocks.records.mock.calls.length >= reads || attempts === 0
      ? Effect.void
      : Effect.yieldNow.pipe(Effect.andThen(waitForLedgerReads(reads, attempts - 1))),
  );

/** Waits for the ledger read the real hook started from `reload()` to settle in the real store. */
const settleLedgerReads = (label: string, reads: number) =>
  Effect.gen(function* settled() {
    yield* waitForLedgerReads(reads, 400);
    if (mocks.records.mock.calls.length < reads) {
      throw new Error(`${label}: the refresh never read the ledger`);
    }
    // The store settles its entry in the same fiber turn as the read; let that turn finish before rendering.
    yield* yieldToLedger(100);
    return renderLedger();
  });

const settleRefresh = (label: string) => settleLedgerReads(label, 2);

describe('finance ledger after a successful empty load', () => {
  beforeEach(() => {
    // The store draws its browser boundary from these globals; the test supplies only that shape, no DOM. The store only
    // asks whether `document` exists; reading it as undefined keeps ui-kit overlays inline, as in server rendering.
    Object.defineProperty(globalThis, 'document', { configurable: true, get: () => globalThis.undefined });
    rstest.stubGlobal('addEventListener', () => {});
    rstest.stubGlobal('removeEventListener', () => {});
    rstest.stubGlobal('dispatchEvent', () => true);
    // The test transpiler emits the classic JSX factory for imported `.tsx` modules; give it the real React.
    rstest.stubGlobal('React', rstest.requireActual('react'));
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    mocks.records.mockReset();
  });

  it.live('shows the successful empty state when the ledger really is empty', () =>
    Effect.gen(function* initialSuccess() {
      yield* preload('ledger-refresh-initial');
      const { html, vm } = renderLedger();
      expect(vm.feedback).toBe('ready');
      expect(vm.snapshot?.revision).toBe(emptyLedger.revision);
      expect(vm.invoices).toEqual([]);
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'ready',
        showsFailure: false,
        showsSuccessfulEmpty: true,
      });
    }),
  );

  it.live('shows loading, not an empty ledger, before the first read settles', () =>
    Effect.sync(() => {
      mocks.location.search = { partyId: 'ledger-refresh-pending' };
      const { html, vm } = renderLedger();

      expect(vm.feedback).toBe('loading');
      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'loading',
        showsFailure: false,
        showsSuccessfulEmpty: false,
      });
    }),
  );

  it.live('never reports successful emptiness when the refresh is unavailable', () =>
    Effect.gen(function* transientFailure() {
      yield* preload('ledger-refresh-unavailable');
      const healthy = renderLedger();
      expect(messageOf(healthy.vm.feedback, healthy.html).showsSuccessfulEmpty).toBe(true);

      mocks.records.mockReturnValue(Effect.fail(unavailable));
      healthy.vm.reload();
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
      mocks.records.mockReturnValue(Effect.succeed(emptyLedger));
      vm.reload();
      const recovered = yield* settleLedgerReads('recovered ledger read', 3);
      expect(recovered.vm.feedback).toBe('ready');
      expect(recovered.vm.snapshot?.revision).toBe(emptyLedger.revision);
      expect(messageOf(recovered.vm.feedback, recovered.html)).toEqual({
        feedback: 'ready',
        showsFailure: false,
        showsSuccessfulEmpty: true,
      });
    }),
  );

  it.live('distinguishes a denied refresh from an unavailable one', () =>
    Effect.gen(function* deniedFailure() {
      yield* preload('ledger-refresh-forbidden');
      const healthy = renderLedger();
      mocks.records.mockReturnValue(Effect.fail(forbidden));
      healthy.vm.reload();
      const { html, vm } = yield* settleRefresh('forbidden refresh');

      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
      expect(messageOf(vm.feedback, html)).toEqual({
        feedback: 'forbidden',
        showsFailure: true,
        showsSuccessfulEmpty: false,
      });
    }),
  );

  it.live('keeps an explicit invoice target unavailable, never a stale row, when the refresh is unavailable', () =>
    Effect.gen(function* detailUnavailable() {
      yield* preload('ledger-refresh-detail-unavailable', { resourceId: invoiceId }, ledgerWithInvoices);
      const healthy = renderLedger();
      expect(healthy.vm.invoiceDetail).toEqual({ invoice, state: 'ready' });

      mocks.records.mockReturnValue(Effect.fail(unavailable));
      healthy.vm.reload();
      const { vm } = yield* settleRefresh('unavailable detail refresh');

      expect(vm.feedback).toBe('unavailable');
      expect(vm.invoiceDetail).toEqual({ state: 'unavailable' });
      expect(vm.selected).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
    }),
  );

  it.live('reports a denied refresh of an explicit invoice target as forbidden, not unavailable', () =>
    Effect.gen(function* detailForbidden() {
      yield* preload('ledger-refresh-detail-forbidden', { resourceId: invoiceId }, ledgerWithInvoices);
      const healthy = renderLedger();
      expect(healthy.vm.invoiceDetail).toEqual({ invoice, state: 'ready' });

      mocks.records.mockReturnValue(Effect.fail(forbidden));
      healthy.vm.reload();
      const { vm } = yield* settleRefresh('forbidden detail refresh');

      expect(vm.feedback).toBe('forbidden');
      expect(vm.invoiceDetail).toEqual({ state: 'forbidden' });
      expect(vm.selected).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
    }),
  );
});
