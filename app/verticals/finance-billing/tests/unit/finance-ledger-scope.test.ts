// @rstest-environment happy-dom
import { acted, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Layer, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandPayloadSchema, ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayload } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { preloadFinanceRecords, useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';

import { mountInRoute } from '../support/module-ui.ts';

/**
 * The Finance ledger cache is document-wide and keyed by its input, so the input must carry the Shell's verified
 * scope: two companies with the same customer filter and the same revision hold different ledgers. These tests drive
 * the real store and hook: one scope never shows or writes with another scope's ledger, a late read of the old scope
 * lands only in that scope, and a page without a verified scope reads nothing and sends nothing.
 */

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

type FinanceView = ReturnType<typeof useFinanceRecords>;
const renderScope = (scope?: string) =>
  Effect.gen(function* mountScope() {
    let current: FinanceView | undefined;
    const Harness = () => {
      current = useFinanceRecords({ scope });
      return null;
    };
    yield* mountInRoute(createElement(Harness), { path: 'finance', url: `/cs/finance${query}` });
    return () => {
      if (current === undefined) {
        throw new Error('the finance ledger hook did not render');
      }
      return current;
    };
  });

const reads: (readonly [RecordsRequest, string | undefined])[] = [];
const commands: ApplyCommandPayload[] = [];
const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ changed: true, revision: 8 });
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(companyLedger);
const OwnerRecordsApi = RecordsApi.prefix('/finance-billing-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  HttpRouter.add('GET', '/shell-super-app-api/auth/session', HttpServerResponse.jsonUnsafe({})),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* readLedger() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          reads.push([payload, request.headers['x-correlation-id']]);
          return yield* answer;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)(payload).pipe(
          Effect.orDie,
          Effect.map((command) => {
            commands.push(command);
            return committed;
          }),
        ),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

/** A write that needs no cross-module reference credentials, so only the ledger revision decides its base. */
const priceItemCommand = {
  _tag: 'UpsertPriceListItem' as const,
  active: true,
  name: 'Úklid společných prostor',
  unitPriceMinor: 150_000,
  vatRate: 21 as const,
};

it.layer(network, { excludeTestServices: true })('finance ledger cache per verified Shell scope', (suite) => {
  beforeEach(() => {
    reads.length = 0;
    commands.length = 0;
    answer = Effect.succeed(companyLedger);
  });

  afterEach(unmountAll);

  suite.effect('keeps each scope on its own ledger, even when the old scope answers late', () =>
    Effect.gen(function* scoped() {
      yield* pinTestDocument;
      const companyScope = financePageScope(companyContext);
      const otherCompanyScope = financePageScope(otherCompanyContext);
      expect(companyScope).toBeDefined();
      expect(otherCompanyScope).not.toBe(companyScope);

      yield* preloadFinanceRecords(query, companyContext);
      const companyView = yield* renderScope(companyScope);
      const inCompany = companyView();
      expect(numbersOf(inCompany)).toEqual(['FV-2026-0001']);

      // The first company's refresh is still in flight when the page switches company.
      const late = yield* Deferred.make<RecordsResponse>();
      answer = Deferred.await(late);
      yield* acted(() => inCompany.reload());
      yield* waitUntil(() => reads.length >= 2);
      expect(reads).toHaveLength(2);

      // Same filter in the other company is its own read, never the cached ledger of the first company.
      answer = Effect.succeed(otherCompanyLedger);
      yield* preloadFinanceRecords(query, otherCompanyContext);
      expect(reads).toHaveLength(3);
      // The scope only keys the cache: every read sends the same filter, with no scope on the wire.
      expect(reads).toEqual([
        [{ partyId }, 'finance-billing.records'],
        [{ partyId }, 'finance-billing.records'],
        [{ partyId }, 'finance-billing.records'],
      ]);
      const otherCompanyView = yield* renderScope(otherCompanyScope);
      expect(numbersOf(otherCompanyView())).toEqual(['FV-2026-0005']);

      yield* Deferred.succeed(late, lateCompanyLedger);
      yield* waitUntil(() => companyView().snapshot?.revision === 9);
      const afterLate = otherCompanyView();
      expect(numbersOf(afterLate)).toEqual(['FV-2026-0005']);
      expect(afterLate.snapshot?.revision).toBe(7);
      // The late answer settled the first company's own entry.
      expect(numbersOf(companyView())).toEqual(['FV-2026-0001', 'FV-2026-0002']);

      // A write from the switched page is based on its own ledger revision, not the late one.
      const outcome = yield* afterLate.execute(priceItemCommand);
      yield* settle;
      expect(outcome).toEqual({ ok: true });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ expectedRevision: 7 });
    }),
  );

  suite.effect('reads nothing and sends nothing without a verified scope', () =>
    Effect.gen(function* unscoped() {
      yield* pinTestDocument;
      // A ledger for the same filter is cached in a verified scope.
      yield* preloadFinanceRecords(query, companyContext);
      const readCount = reads.length;

      yield* preloadFinanceRecords(query, contextlessShellProps.context);
      yield* preloadFinanceRecords(query, { ...companyContext, principalId: '' });
      expect(financePageScope({ ...companyContext, legalEntityId: '' })).toBeUndefined();

      const unscopedView = yield* renderScope();
      const vm = unscopedView();
      expect(vm.snapshot).toBeUndefined();
      expect(vm.invoices).toEqual([]);
      expect(vm.canWrite).toBe(false);
      expect(vm.feedback).toBe('forbidden');

      yield* acted(() => vm.reload());
      expect(reads.length).toBe(readCount);

      expect(yield* vm.execute(priceItemCommand)).toEqual({ feedback: 'unavailable', ok: false });
      expect(commands).toHaveLength(0);
    }),
  );
});
