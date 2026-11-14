import type { CustomerListRequest } from '@app/party-registry/api/client';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Deferred, Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { EffectCallback, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import {
  preloadFinanceDirectory,
  useFinanceReferences,
} from '../../src/routes/[lang]/finance/use-finance-references.ts';

/**
 * Customer names, opportunity titles, the product catalog and the signed-in user's label are document-wide caches;
 * each belongs to one verified Shell scope. These tests drive the real stores and hooks (React effects run during the
 * render, the only browser seam replaced): two scopes get their own data, an old scope's late answer never shows as
 * the current scope's, and a page without a verified scope reads nothing and shows nothing cached.
 */

const mocks = rstest.hoisted(() => ({
  /** The customer rows one customer-list read answers. */
  customers: rstest.fn<(request: CustomerListRequest) => Effect.Effect<readonly unknown[], string>>(),
  fetch: rstest.fn(),
  location: { search: {}, searchStr: '' },
  opportunities: rstest.fn(),
  /** The catalog rows one Merchandise records read answers (only the fields the hook reads). */
  products: rstest.fn<() => Effect.Effect<readonly { readonly id: string; readonly name: string }[], string>>(),
  records: rstest.fn(),
}));

// `mocks.customers` answers the customer rows; the customer-list read wraps them as its `items`.
rstest.mock('@app/party-registry/apis/customer-list/client', () => ({
  executeCustomerList: (request: CustomerListRequest) =>
    mocks.customers(request).pipe(Effect.map((items) => ({ items }))),
}));
rstest.mock('@app/sales-pipeline/clients/records', () => ({ executeRecords: mocks.opportunities }));
// `mocks.products` answers the catalog rows; the records read wraps them as its `products` collection.
rstest.mock('@app/merchandise/apis/records/client', () => ({
  executeRecords: () => mocks.products().pipe(Effect.map((products) => ({ products }))),
}));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: () => Effect.fail('no objects') }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: () => Effect.fail('no contracts') }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
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
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
// Node has no DOM: the store is read directly and mount effects run during the render, as a browser mount would.
rstest.mock('react', () => ({
  ...rstest.requireActual('react'),
  useEffect: (effect: EffectCallback) => {
    effect();
  },
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const companyContext = {
  legalEntityId: 'b0000000-0000-4000-8000-000000000011',
  principalId: 'principal-accountant',
  tenantId,
};
const otherCompanyContext = { ...companyContext, legalEntityId: 'b0000000-0000-4000-8000-000000000012' };
const otherPrincipalContext = { ...companyContext, principalId: 'principal-controller' };

const customer = (partyId: string, displayName: string) => ({
  counterpartyId: `counterparty-${partyId}`,
  displayName,
  partyId,
});
const product = (id: string, name: string) => ({ id, name });

/** The page props the Shell passes when the session carries no verified company context. */
const contextlessShellProps: Partial<ModulePageProps> = {};

const references: ReturnType<typeof useFinanceReferences>[] = [];
const renderReferences = (scope?: string) => {
  references.length = 0;
  const Harness = () => {
    references.push(useFinanceReferences({ scope }));
    return null;
  };
  renderToStaticMarkup(createElement(Harness));
  const value = references.at(-1);
  if (value === undefined) {
    throw new Error('the finance references hook did not render');
  }
  return value;
};

const records: ReturnType<typeof useFinanceRecords>[] = [];
const renderRecords = (scope?: string) => {
  records.length = 0;
  const Harness = () => {
    records.push(useFinanceRecords({ scope }));
    return null;
  };
  renderToStaticMarkup(createElement(Harness));
  const value = records.at(-1);
  if (value === undefined) {
    throw new Error('the finance ledger hook did not render');
  }
  return value;
};

/** Lets the store runtime run fiber turns until `mock` saw `calls`; bounded so a broken load cannot hang. */
const waitForCalls = (mock: { readonly mock: { readonly calls: readonly unknown[] } }, calls: number) => {
  const loop = (attempts: number): Effect.Effect<void> =>
    Effect.suspend(() =>
      mock.mock.calls.length >= calls || attempts === 0
        ? Effect.void
        : Effect.yieldNow.pipe(Effect.andThen(loop(attempts - 1))),
    );
  return loop(400);
};
const settle = (turns: number): Effect.Effect<void> =>
  Effect.suspend(() => (turns === 0 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(settle(turns - 1)))));
/** Lets the fetch body's promise continuations and the store's fiber turns run without wall-clock delays. */
const settleAsync = Effect.promise(() => Promise.resolve()).pipe(Effect.andThen(settle(100)));

const names = (value: ReturnType<typeof useFinanceReferences>) => value.customers.map((entry) => entry.displayName);
const productNames = (value: ReturnType<typeof useFinanceReferences>) => value.products.map((entry) => entry.name);

const sessionResponse = (displayName: string, email: string) =>
  Response.json({ identity: { displayName, email } }, { status: 200 });

describe('finance reference caches per verified Shell scope', () => {
  beforeEach(() => {
    rstest.stubGlobal('document', {});
    rstest.stubGlobal('addEventListener', () => {});
    rstest.stubGlobal('removeEventListener', () => {});
    rstest.stubGlobal('dispatchEvent', () => true);
    rstest.stubGlobal('React', rstest.requireActual('react'));
    rstest.stubGlobal('window', { location: { href: 'https://shell.test/cs/finance' } });
    rstest.stubGlobal('fetch', mocks.fetch);
    mocks.opportunities.mockReturnValue(Effect.succeed({ items: [] }));
    mocks.records.mockReturnValue(Effect.never);
  });

  afterEach(() => {
    mocks.customers.mockReset();
    mocks.fetch.mockReset();
    mocks.opportunities.mockReset();
    mocks.products.mockReset();
    mocks.records.mockReset();
  });

  it.live('gives each scope its own directory and catalog, even when the old scope answers late', () =>
    Effect.gen(function* directories() {
      const companyScope = financePageScope(companyContext);
      const otherCompanyScope = financePageScope(otherCompanyContext);
      expect(otherCompanyScope).not.toBe(companyScope);

      // The first company's customer list is still on its way when the page switches company.
      const lateCustomers = yield* Deferred.make<readonly ReturnType<typeof customer>[]>();
      mocks.customers.mockReturnValueOnce(Deferred.await(lateCustomers));
      mocks.products.mockReturnValueOnce(Effect.succeed([product('p-1', 'Nájem kanceláře')]));
      renderReferences(companyScope);
      yield* waitForCalls(mocks.customers, 1);
      yield* waitForCalls(mocks.products, 1);

      mocks.customers.mockReturnValueOnce(Effect.succeed([customer('party-b', 'Beta s.r.o.')]));
      mocks.products.mockReturnValueOnce(Effect.succeed([product('p-2', 'Úklid')]));
      renderReferences(otherCompanyScope);
      yield* waitForCalls(mocks.customers, 2);
      yield* waitForCalls(mocks.products, 2);
      yield* settle(100);

      const other = renderReferences(otherCompanyScope);
      expect(names(other)).toEqual(['Beta s.r.o.']);
      expect(productNames(other)).toEqual(['Úklid']);
      const company = renderReferences(companyScope);
      expect(names(company)).toEqual([]);
      expect(company.customersLoading).toBe(true);
      expect(productNames(company)).toEqual(['Nájem kanceláře']);

      yield* Deferred.succeed(lateCustomers, [customer('party-a', 'Alfa a.s.')]);
      yield* settle(100);
      // The late answer belongs to the first company only; the current company keeps its own names.
      expect(names(renderReferences(otherCompanyScope))).toEqual(['Beta s.r.o.']);
      expect(names(renderReferences(companyScope))).toEqual(['Alfa a.s.']);
      // Each scope read once per list; the reads themselves carry no scope.
      expect(mocks.customers.mock.calls).toEqual([[{ includeArchived: true }], [{ includeArchived: true }]]);
    }),
  );

  it.live('reports missing names only when a name list failed, not when the product catalog did', () =>
    Effect.gen(function* namesNotice() {
      const catalogScope = financePageScope({
        ...companyContext,
        legalEntityId: 'b0000000-0000-4000-8000-000000000021',
      });
      mocks.customers.mockReturnValueOnce(Effect.succeed([customer('party-c', 'Gama a.s.')]));
      mocks.products.mockReturnValueOnce(Effect.fail('catalog unavailable'));
      renderReferences(catalogScope);
      yield* waitForCalls(mocks.products, 1);
      yield* settle(100);
      const catalogFailed = renderReferences(catalogScope);
      expect(names(catalogFailed)).toEqual(['Gama a.s.']);
      // The list shows customer and opportunity names; a failed catalog only leaves the create form without products.
      expect(catalogFailed.referencesFailed).toBe(false);
      expect(catalogFailed.productsFailed).toBe(true);

      const customersScope = financePageScope({
        ...companyContext,
        legalEntityId: 'b0000000-0000-4000-8000-000000000022',
      });
      mocks.customers.mockReturnValueOnce(Effect.fail('customers unavailable'));
      mocks.products.mockReturnValueOnce(Effect.succeed([]));
      renderReferences(customersScope);
      yield* waitForCalls(mocks.customers, 2);
      yield* settle(100);
      expect(renderReferences(customersScope).referencesFailed).toBe(true);
    }),
  );

  it.live('shows each principal its own label, never a late label of the previous principal', () =>
    Effect.gen(function* labels() {
      const accountantScope = financePageScope(companyContext);
      const controllerScope = financePageScope(otherPrincipalContext);
      expect(controllerScope).not.toBe(accountantScope);
      mocks.customers.mockReturnValue(Effect.succeed([]));
      mocks.products.mockReturnValue(Effect.succeed([]));

      // The accountant's session answer is held back until after the switch to the controller.
      const accountantAnswer = Promise.withResolvers<Response>();
      mocks.fetch.mockReturnValueOnce(accountantAnswer.promise);
      renderRecords(accountantScope);
      yield* waitForCalls(mocks.fetch, 1);

      mocks.fetch.mockReturnValueOnce(Promise.resolve(sessionResponse('Kontrolor', 'controller@example.test')));
      renderRecords(controllerScope);
      yield* waitForCalls(mocks.fetch, 2);
      yield* settleAsync;
      expect(renderRecords(controllerScope).actorLabel).toBe('Kontrolor (controller@example.test)');
      expect(renderRecords(accountantScope).actorLabel).toBeUndefined();

      accountantAnswer.resolve(sessionResponse('Účetní', 'accountant@example.test'));
      yield* settleAsync;
      expect(renderRecords(controllerScope).actorLabel).toBe('Kontrolor (controller@example.test)');
      expect(renderRecords(accountantScope).actorLabel).toBe('Účetní (accountant@example.test)');
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    }),
  );

  it.live('reads nothing and exposes no cached reference or label without a verified scope', () =>
    Effect.gen(function* unscoped() {
      // Another scope already holds a directory, a catalog and a label.
      const scope = financePageScope(companyContext);
      mocks.customers.mockReturnValue(Effect.succeed([customer('party-a', 'Alfa a.s.')]));
      mocks.products.mockReturnValue(Effect.succeed([product('p-1', 'Nájem kanceláře')]));
      mocks.fetch.mockImplementation(() => Promise.resolve(sessionResponse('Účetní', 'accountant@example.test')));
      yield* preloadFinanceDirectory(companyContext);
      renderRecords(scope);
      yield* waitForCalls(mocks.fetch, 1);
      yield* settleAsync;
      expect(names(renderReferences(scope))).toEqual(['Alfa a.s.']);
      const reads = [mocks.customers, mocks.products, mocks.fetch].map((mock) => mock.mock.calls.length);

      yield* preloadFinanceDirectory(contextlessShellProps.context);
      yield* preloadFinanceDirectory({ ...companyContext, legalEntityId: '' });
      const value = renderReferences();
      const vm = renderRecords();
      yield* settleAsync;

      expect(value).toMatchObject({ customers: [], customersLoading: false, products: [] });
      expect(value.productsReadable).toBeUndefined();
      expect(value.opportunityTitles.size).toBe(0);
      expect(vm.actorLabel).toBeUndefined();
      expect(vm.references.customers).toEqual([]);
      expect([mocks.customers, mocks.products, mocks.fetch].map((mock) => mock.mock.calls.length)).toEqual(reads);
    }),
  );
});
