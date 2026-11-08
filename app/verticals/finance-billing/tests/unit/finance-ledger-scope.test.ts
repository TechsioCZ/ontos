import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { preloadFinanceRecords, useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';

/**
 * The Finance ledger cache is document-wide and keyed by its input, so the input must carry the Shell's verified
 * scope: two companies with the same customer filter and the same revision hold different ledgers. These tests drive
 * the real store and hook: one scope never shows or writes with another scope's ledger, a late read of the old scope
 * lands only in that scope, and a page without a verified scope reads nothing and sends nothing.
 */

const mocks = rstest.hoisted(() => ({
  apply: rstest.fn(),
  location: { search: {}, searchStr: '' },
  records: rstest.fn(),
}));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  // The shared admin toaster configures the kit's singleton at import time; it only needs somewhere to write.
  toaster: { attrs: {} },
  useToast: () => ({ create: () => {}, dismiss: () => {} }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  // Finance reads the router only through a selector, so the mock answers with exactly what that selector returns.
  useRouterState: <Selected>(options: {
    readonly select: (state: { readonly location: typeof mocks.location }) => Selected;
  }): Selected => options.select({ location: mocks.location }),
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

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const companyContext = {
  legalEntityId: 'b0000000-0000-4000-8000-000000000011',
  principalId: 'principal-accountant',
  tenantId,
};
const otherCompanyContext = { ...companyContext, legalEntityId: 'b0000000-0000-4000-8000-000000000012' };
/** The page props the Shell passes when the session carries no verified company context. */
const contextlessShellProps: Partial<ModulePageProps> = {};
const partyId = 'ledger-scope-party';
const query = `?partyId=${partyId}`;

const invoiceInput = (resourceId: string, number: string) => ({
  accountingCorrelation: `accounting-${number}`,
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
  documentNumber: number,
  dueDate: '2026-11-03',
  issueDate: '2026-10-20',
  number,
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId, resourceType: 'finance.billing.invoice', tenantId },
  totalMinor: 121_000,
  updatedAt: '2026-10-20T09:00:00Z',
});

const ledgerOf = (revision: number, invoices: readonly ReturnType<typeof invoiceInput>[]): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    businessDate: '2026-10-05',
    canWrite: true,
    indicators: {
      costMinor: 0,
      costVarianceMinor: 0,
      draftCount: 0,
      grossOutstandingMinor: 0,
      openIncomingInvoices: 0,
      openInvoices: invoices.length,
      openOutgoingInvoices: invoices.length,
      overdueInvoices: 0,
      payablesOutstandingMinor: 0,
      plannedCostMinor: 0,
      plannedRevenueMinor: 0,
      receivablesOutstandingMinor: 0,
      revenueMinor: 0,
      revenueVarianceMinor: 0,
    },
    referenceDate: '2026-10-05',
    revision,
    state: { financialPlanEntries: [], invoices },
  });

// Same filter, same revision, different companies' ledgers.
const companyLedger = ledgerOf(7, [invoiceInput('c0000000-0000-4000-8000-000000000201', 'FV-2026-0001')]);
const otherCompanyLedger = ledgerOf(7, [invoiceInput('d0000000-0000-4000-8000-000000000301', 'FV-2026-0005')]);
// What the first company's slow refresh finally answers, after the page already switched company.
const lateCompanyLedger = ledgerOf(9, [
  invoiceInput('c0000000-0000-4000-8000-000000000201', 'FV-2026-0001'),
  invoiceInput('c0000000-0000-4000-8000-000000000202', 'FV-2026-0002'),
]);

const numbersOf = (vm: ReturnType<typeof useFinanceRecords>) => vm.invoices.map((invoice) => invoice.number);

const rendered: ReturnType<typeof useFinanceRecords>[] = [];
const renderScope = (scope?: string) => {
  rendered.length = 0;
  const Harness = () => {
    rendered.push(useFinanceRecords({ scope }));
    return null;
  };
  renderToStaticMarkup(createElement(Harness));
  const vm = rendered.at(-1);
  if (vm === undefined) {
    throw new Error('the finance ledger hook did not render');
  }
  return vm;
};

/** Lets the store's runtime run fiber turns; bounded so a broken load cannot hang the test. */
const waitForReads = (reads: number, attempts: number): Effect.Effect<void> =>
  Effect.suspend(() =>
    mocks.records.mock.calls.length >= reads || attempts === 0
      ? Effect.void
      : Effect.yieldNow.pipe(Effect.andThen(waitForReads(reads, attempts - 1))),
  );
const yieldTurns = (turns: number): Effect.Effect<void> =>
  Effect.suspend(() => (turns === 0 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(yieldTurns(turns - 1)))));

/** A write that needs no cross-module reference credentials, so only the ledger revision decides its base. */
const priceItemCommand = {
  _tag: 'UpsertPriceListItem' as const,
  active: true,
  name: 'Úklid společných prostor',
  unitPriceMinor: 150_000,
  vatRate: 21 as const,
};

describe('finance ledger cache per verified Shell scope', () => {
  beforeEach(() => {
    rstest.stubGlobal('document', {});
    rstest.stubGlobal('addEventListener', () => {});
    rstest.stubGlobal('removeEventListener', () => {});
    rstest.stubGlobal('dispatchEvent', () => true);
    rstest.stubGlobal('React', rstest.requireActual('react'));
    mocks.location.search = { partyId };
  });

  afterEach(() => {
    mocks.apply.mockReset();
    mocks.records.mockReset();
  });

  it.live('keeps each scope on its own ledger, even when the old scope answers late', () =>
    Effect.gen(function* scoped() {
      const companyScope = financePageScope(companyContext);
      const otherCompanyScope = financePageScope(otherCompanyContext);
      expect(companyScope).toBeDefined();
      expect(otherCompanyScope).not.toBe(companyScope);

      mocks.records.mockReturnValue(Effect.succeed(companyLedger));
      yield* preloadFinanceRecords(query, companyContext);
      const inCompany = renderScope(companyScope);
      expect(numbersOf(inCompany)).toEqual(['FV-2026-0001']);

      // The first company's refresh is still in flight when the page switches company.
      const late = yield* Deferred.make<RecordsResponse>();
      mocks.records.mockReturnValueOnce(Deferred.await(late));
      inCompany.reload();
      yield* waitForReads(2, 400);
      expect(mocks.records).toHaveBeenCalledTimes(2);

      // Same filter in the other company is its own read, never the cached ledger of the first company.
      mocks.records.mockReturnValue(Effect.succeed(otherCompanyLedger));
      yield* preloadFinanceRecords(query, otherCompanyContext);
      expect(mocks.records).toHaveBeenCalledTimes(3);
      // The scope only keys the cache: every read sends the same filter, with no scope on the wire.
      expect(mocks.records.mock.calls).toEqual([
        [{ partyId }, 'finance-billing.records'],
        [{ partyId }, 'finance-billing.records'],
        [{ partyId }, 'finance-billing.records'],
      ]);
      expect(numbersOf(renderScope(otherCompanyScope))).toEqual(['FV-2026-0005']);

      yield* Deferred.succeed(late, lateCompanyLedger);
      yield* yieldTurns(100);
      const afterLate = renderScope(otherCompanyScope);
      expect(numbersOf(afterLate)).toEqual(['FV-2026-0005']);
      expect(afterLate.snapshot?.revision).toBe(7);
      // The late answer settled the first company's own entry.
      expect(numbersOf(renderScope(companyScope))).toEqual(['FV-2026-0001', 'FV-2026-0002']);

      // A write from the switched page is based on its own ledger revision, not the late one.
      mocks.apply.mockReturnValue(Effect.succeed({ changed: true, revision: 8 }));
      expect(yield* afterLate.execute(priceItemCommand)).toEqual({ ok: true });
      expect(mocks.apply).toHaveBeenCalledTimes(1);
      expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 7 });
    }),
  );

  it.live('reads nothing and sends nothing without a verified scope', () =>
    Effect.gen(function* unscoped() {
      // A ledger for the same filter is cached in a verified scope.
      mocks.records.mockReturnValue(Effect.succeed(companyLedger));
      yield* preloadFinanceRecords(query, companyContext);
      const reads = mocks.records.mock.calls.length;

      yield* preloadFinanceRecords(query, contextlessShellProps.context);
      yield* preloadFinanceRecords(query, { ...companyContext, principalId: '' });
      expect(financePageScope({ ...companyContext, legalEntityId: '' })).toBeUndefined();

      const vm = renderScope();
      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
      expect(vm.feedback).toBe('forbidden');

      vm.reload();
      yield* yieldTurns(100);
      expect(mocks.records.mock.calls.length).toBe(reads);

      expect(yield* vm.execute(priceItemCommand)).toEqual({ feedback: 'unavailable', ok: false });
      expect(mocks.apply).not.toHaveBeenCalled();
    }),
  );
});
