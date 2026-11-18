// @rstest-environment happy-dom
import { settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  ProductRecordSchema,
  RecordsApi as MerchandiseRecordsApi,
  RecordsResponseSchema as MerchandiseRecordsResponseSchema,
  RecordsUnavailableProblemSchema as MerchandiseUnavailableProblemSchema,
} from '@app/merchandise/apis/records';
import type { RecordsRequest as MerchandiseRecordsRequest } from '@app/merchandise/apis/records';
import {
  RecordsApi as OpportunityRecordsApi,
  RecordsResponseSchema as OpportunityRecordsResponseSchema,
} from '@app/sales-pipeline/contracts/records';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import {
  CustomerListApi,
  CustomerListItemSchema,
  CustomerListUnavailableProblemSchema,
} from '../../../party-registry/shared/apis/customer-list.ts';
import type { CustomerListRequest, CustomerListResponse } from '../../../party-registry/shared/apis/customer-list.ts';
import { RecordsApi } from '../../shared/apis/records.ts';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import {
  preloadFinanceDirectory,
  useFinanceReferences,
} from '../../src/routes/[lang]/finance/use-finance-references.ts';
import { mountInRoute } from '../support/module-ui.ts';

// Drive the document caches through mounted hooks, the real router/i18n and generated HTTP clients.
// Each owner decodes requests and encodes replies through its public contract.
const tenantId = 'a0000000-0000-4000-8000-000000000001';
const companyContext = {
  legalEntityId: 'b0000000-0000-4000-8000-000000000011',
  principalId: 'principal-accountant',
  tenantId,
};
const otherCompanyContext = { ...companyContext, legalEntityId: 'b0000000-0000-4000-8000-000000000012' };
const otherPrincipalContext = { ...companyContext, principalId: 'principal-controller' };
const actorPrincipalRef = { principalId: 'c0000000-0000-4000-8000-000000000001', tenantId };
const partyA = 'd0000000-0000-4000-8000-000000000001';
const partyB = 'd0000000-0000-4000-8000-000000000002';
const partyC = 'd0000000-0000-4000-8000-000000000003';

const customer = (partyId: string, displayName: string) =>
  Schema.decodeUnknownSync(CustomerListItemSchema)({
    city: null,
    companyId: null,
    counterpartyId: partyId,
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    displayName,
    email: null,
    partyId,
    partyRef: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
    partyRevision: 1,
    phone: null,
    status: 'ACTIVE',
    vatId: null,
  });
const product = (id: string, name: string) =>
  Schema.decodeUnknownSync(ProductRecordSchema)({
    active: true,
    category: 'Služby',
    createdAt: '2026-11-01T00:00:00.000Z',
    currentPriceMinor: 10_000,
    id,
    lowStock: false,
    lowStockThreshold: 0,
    name,
    priceHistory: [],
    sku: id,
    stockOnHand: 0,
    stockValueMinor: 0,
    unit: 'ks',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
const emptyCatalog = Schema.decodeUnknownSync(MerchandiseRecordsResponseSchema)({
  actorPrincipalRef,
  canWrite: false,
  indicators: {
    lowStockCount: 0,
    openOrderValueMinor: 0,
    orderCount: 0,
    productCount: 0,
    stockValueMinor: 0,
  },
  movements: [],
  orders: [],
  products: [],
  revision: 1,
});
const catalog = (products: readonly ReturnType<typeof product>[]) => ({
  ...emptyCatalog,
  indicators: { ...emptyCatalog.indicators, productCount: products.length },
  products,
});
const opportunities = Schema.decodeUnknownSync(OpportunityRecordsResponseSchema)({
  actorPrincipalRef,
  canWrite: false,
  indicators: {
    byStage: [],
    lostCount: 0,
    openCount: 0,
    openValueMinor: 0,
    weightedValueMinor: 0,
    winRate: null,
    wonCount: 0,
    wonValueMinor: 0,
  },
  items: [],
  revision: 1,
});
const customerReads: CustomerListRequest[] = [];
const productReads: MerchandiseRecordsRequest[] = [];
const sessionReads: string[] = [];
let customersAnswer: Effect.Effect<CustomerListResponse, typeof CustomerListUnavailableProblemSchema.Type> =
  Effect.succeed({ items: [] });
let productsAnswer: Effect.Effect<
  typeof MerchandiseRecordsResponseSchema.Type,
  typeof MerchandiseUnavailableProblemSchema.Type
> = Effect.succeed(catalog([]));
let sessionAnswer: Effect.Effect<HttpServerResponse.HttpServerResponse> = Effect.never;
const sessionResponse = (displayName: string, email: string) =>
  HttpServerResponse.jsonUnsafe({ identity: { displayName, email } });

const Customers = CustomerListApi.prefix('/party-registry-api');
const Products = MerchandiseRecordsApi.prefix('/merchandise-api');
const Opportunities = OpportunityRecordsApi.prefix('/sales-pipeline-api');
const Finance = RecordsApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    merchandise: '/merchandise-api',
    'party-registry': '/party-registry-api',
    'sales-pipeline': '/sales-pipeline-api',
  }).application,
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          customerReads.push(payload);
          return customersAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Products,
    HttpApiBuilder.group(Products, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          productReads.push(payload);
          return productsAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Opportunities,
    HttpApiBuilder.group(Opportunities, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(opportunities)),
    ),
  ),
  serveApi(
    Finance,
    HttpApiBuilder.group(Finance, 'records', (group) => group.handle('execute', () => Effect.never)),
  ),
  // Property and agreement audiences are deliberately absent: the Shell refuses these optional reads.
  HttpRouter.add(
    'GET',
    '/shell-super-app-api/auth/session',
    Effect.suspend(() => {
      sessionReads.push('/shell-super-app-api/auth/session');
      return sessionAnswer;
    }),
  ),
);

/** The page props the Shell passes when the session carries no verified company context. */
const contextlessShellProps: Partial<ModulePageProps> = {};

const mountHook = <Value>(useValue: () => Value) =>
  Effect.gen(function* mountFinanceHook() {
    let current = Option.none<Value>();
    const Harness = () => {
      current = Option.some(useValue());
      return null;
    };
    yield* mountInRoute(createElement(Harness), { path: 'finance', url: '/cs/finance' });
    return () => Option.getOrThrow(current);
  });
const renderReferences = (scope?: string) => mountHook(() => useFinanceReferences({ scope }));
const renderRecords = (scope?: string) => mountHook(() => useFinanceRecords({ scope }));
const names = (value: ReturnType<typeof useFinanceReferences>) => value.customers.map((entry) => entry.displayName);
const productNames = (value: ReturnType<typeof useFinanceReferences>) => value.products.map((entry) => entry.name);
const readCounts = () => [customerReads.length, productReads.length, sessionReads.length];

it.layer(network, { excludeTestServices: true })('finance reference caches per verified Shell scope', (suite) => {
  beforeEach(() => {
    customerReads.length = 0;
    productReads.length = 0;
    sessionReads.length = 0;
    customersAnswer = Effect.succeed({ items: [] });
    productsAnswer = Effect.succeed(catalog([]));
    sessionAnswer = Effect.never;
  });
  afterEach(unmountAll);

  suite.effect('gives each scope its own directory and catalog, even when the old scope answers late', () =>
    Effect.gen(function* directories() {
      yield* pinTestDocument;
      const companyScope = financePageScope(companyContext);
      const otherCompanyScope = financePageScope(otherCompanyContext);
      expect(otherCompanyScope).not.toBe(companyScope);

      const lateCustomers = yield* Deferred.make<readonly ReturnType<typeof customer>[]>();
      customersAnswer = Deferred.await(lateCustomers).pipe(Effect.map((items) => ({ items })));
      productsAnswer = Effect.succeed(catalog([product('p-1', 'Nájem kanceláře')]));
      const company = yield* renderReferences(companyScope);
      yield* waitUntil(() => customerReads.length === 1 && productReads.length === 1);

      customersAnswer = Effect.succeed({ items: [customer(partyB, 'Beta s.r.o.')] });
      productsAnswer = Effect.succeed(catalog([product('p-2', 'Úklid')]));
      const other = yield* renderReferences(otherCompanyScope);
      yield* waitUntil(
        () => !other().customersLoading && other().products.length === 1 && company().products.length === 1,
      );

      expect(names(other())).toEqual(['Beta s.r.o.']);
      expect(productNames(other())).toEqual(['Úklid']);
      expect(names(company())).toEqual([]);
      expect(company().customersLoading).toBe(true);
      expect(productNames(company())).toEqual(['Nájem kanceláře']);

      yield* Deferred.succeed(lateCustomers, [customer(partyA, 'Alfa a.s.')]);
      yield* waitUntil(() => !company().customersLoading);
      expect(names(other())).toEqual(['Beta s.r.o.']);
      expect(names(company())).toEqual(['Alfa a.s.']);
      // Each scope read once per list; the reads themselves carry no scope.
      expect(customerReads).toEqual([{ includeArchived: true }, { includeArchived: true }]);
    }),
  );

  suite.effect('reports missing names only when a name list failed, not when the product catalog did', () =>
    Effect.gen(function* namesNotice() {
      yield* pinTestDocument;
      const catalogScope = financePageScope({
        ...companyContext,
        legalEntityId: 'b0000000-0000-4000-8000-000000000021',
      });
      customersAnswer = Effect.succeed({ items: [customer(partyC, 'Gama a.s.')] });
      productsAnswer = Effect.fail(
        yield* Schema.decodeUnknownEffect(MerchandiseUnavailableProblemSchema)({
          _tag: 'RecordsUnavailableProblem',
          detail: 'catalog unavailable',
          retryable: true,
          status: 503,
          title: 'Catalog unavailable',
          type: 'https://ontos.dev/problems/records-unavailable',
        }),
      );
      const catalogFailed = yield* renderReferences(catalogScope);
      yield* waitUntil(() => !catalogFailed().customersLoading && catalogFailed().productsFailed);
      expect(names(catalogFailed())).toEqual(['Gama a.s.']);
      expect(catalogFailed().referencesFailed).toBe(false);
      expect(catalogFailed().productsFailed).toBe(true);

      const customersScope = financePageScope({
        ...companyContext,
        legalEntityId: 'b0000000-0000-4000-8000-000000000022',
      });
      customersAnswer = Effect.fail(
        yield* Schema.decodeUnknownEffect(CustomerListUnavailableProblemSchema)({
          _tag: 'CustomerListUnavailableProblem',
          detail: 'customers unavailable',
          retryable: true,
          status: 503,
          title: 'Customers unavailable',
          type: 'https://ontos.dev/problems/customer-list-unavailable',
        }),
      );
      productsAnswer = Effect.succeed(catalog([]));
      const customersFailed = yield* renderReferences(customersScope);
      yield* waitUntil(() => !customersFailed().customersLoading);
      expect(customersFailed().referencesFailed).toBe(true);
    }),
  );

  suite.effect('shows each principal its own label, never a late label of the previous principal', () =>
    Effect.gen(function* labels() {
      yield* pinTestDocument;
      const accountantScope = financePageScope(companyContext);
      const controllerScope = financePageScope(otherPrincipalContext);
      expect(controllerScope).not.toBe(accountantScope);

      const accountantAnswer = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
      sessionAnswer = Deferred.await(accountantAnswer);
      const accountant = yield* renderRecords(accountantScope);
      yield* waitUntil(() => sessionReads.length === 1);

      sessionAnswer = Effect.succeed(sessionResponse('Kontrolor', 'controller@example.test'));
      const controller = yield* renderRecords(controllerScope);
      yield* waitUntil(() => controller().actorLabel !== undefined);
      expect(controller().actorLabel).toBe('Kontrolor (controller@example.test)');
      expect(accountant().actorLabel).toBeUndefined();

      yield* Deferred.succeed(accountantAnswer, sessionResponse('Účetní', 'accountant@example.test'));
      yield* waitUntil(() => accountant().actorLabel !== undefined);
      expect(controller().actorLabel).toBe('Kontrolor (controller@example.test)');
      expect(accountant().actorLabel).toBe('Účetní (accountant@example.test)');
      expect(sessionReads).toHaveLength(2);
    }),
  );

  suite.effect('reads nothing and exposes no cached reference or label without a verified scope', () =>
    Effect.gen(function* unscoped() {
      yield* pinTestDocument;
      const scope = financePageScope(companyContext);
      customersAnswer = Effect.succeed({ items: [customer(partyA, 'Alfa a.s.')] });
      productsAnswer = Effect.succeed(catalog([product('p-1', 'Nájem kanceláře')]));
      sessionAnswer = Effect.succeed(sessionResponse('Účetní', 'accountant@example.test'));
      yield* preloadFinanceDirectory(companyContext);
      const scopedRecords = yield* renderRecords(scope);
      const scopedReferences = yield* renderReferences(scope);
      yield* waitUntil(() => scopedRecords().actorLabel !== undefined && scopedReferences().products.length === 1);
      expect(names(scopedReferences())).toEqual(['Alfa a.s.']);
      const reads = readCounts();

      yield* preloadFinanceDirectory(contextlessShellProps.context);
      yield* preloadFinanceDirectory({ ...companyContext, legalEntityId: '' });
      const references = yield* renderReferences();
      const records = yield* renderRecords();
      yield* settle;
      const value = references();
      const vm = records();

      expect(value).toMatchObject({ customers: [], customersLoading: false, products: [] });
      expect(value.productsReadable).toBeUndefined();
      expect(value.opportunityTitles.size).toBe(0);
      expect(vm.actorLabel).toBeUndefined();
      expect(vm.references.customers).toEqual([]);
      expect(readCounts()).toEqual(reads);
    }),
  );
});
