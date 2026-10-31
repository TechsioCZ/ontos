import type { ProductRecord } from '@app/merchandise/contracts/records';
import { listProducts } from '@app/merchandise/clients/records';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { customerIndex } from './invoice-view.ts';
import type { CustomerIndex } from './invoice-view.ts';
import { financeReferenceAccess } from './sales-pipeline-readable.ts';

const ReferenceSourceSchema = Schema.Literals(['customers', 'opportunities', 'products']);
type ReferenceSource = typeof ReferenceSourceSchema.Type;

/** The reference lists belong to the document: a switch of company or account reloads it. */
type DocumentScope = 'document';
const documentScope: DocumentScope = 'document';

/**
 * What the invoice list needs on its first paint: which optional references the legal entity may read (it decides
 * whether "Nová faktura" is offered), customer names and source-opportunity titles. Each read settles on its own,
 * so one failing read leaves the others usable and is listed in `failures`. A role without access to the sales
 * pipeline is not a failure: `opportunitiesForbidden` lets the list mark those cells instead.
 */
interface FinanceDirectory {
  readonly customerById: CustomerIndex;
  readonly customers: readonly CustomerListItem[];
  readonly failures: readonly ReferenceSource[];
  readonly opportunitiesForbidden: boolean;
  readonly opportunityTitles: ReadonlyMap<string, string>;
  readonly productsReadable: boolean;
}

const loadDirectory = Effect.fn('Finance.referenceDirectory')(function* loadDirectory() {
  const access = yield* financeReferenceAccess;
  const [customers, opportunities] = yield* Effect.all(
    [
      listCustomers({ includeArchived: true }).pipe(Effect.result),
      access.opportunitiesReadable
        ? listOpportunities({}, 'finance-billing.opportunities').pipe(Effect.result, Effect.asSome)
        : Effect.succeedNone,
    ],
    { concurrency: 2 },
  );
  const opportunitiesForbidden = Option.match(opportunities, {
    onNone: () => true,
    onSome: (result) => Result.isFailure(result) && Predicate.isTagged(result.failure, 'RecordsForbiddenProblem'),
  });
  const opportunityItems = opportunities.pipe(
    Option.flatMap(Result.getSuccess),
    Option.match({ onNone: () => [], onSome: (response) => response.items }),
  );
  const opportunitiesFailed = Option.exists(opportunities, Result.isFailure) && !opportunitiesForbidden;
  const customerItems = Result.isSuccess(customers) ? customers.success : [];
  const failures: ReferenceSource[] = [
    ...(Result.isFailure(customers) ? (['customers'] as const) : []),
    ...(opportunitiesFailed ? (['opportunities'] as const) : []),
  ];
  return {
    customerById: customerIndex(customerItems),
    customers: customerItems,
    failures,
    opportunitiesForbidden,
    opportunityTitles: new Map<string, string>(opportunityItems.map((item) => [item.id, item.title] as const)),
    productsReadable: access.productsReadable,
  } satisfies FinanceDirectory;
});

/** Never fails: every read's failure is part of the value. */
const financeDirectory = definePageData({
  key: (scope: DocumentScope) => `directory:${scope}`,
  load: loadDirectory,
  runtime: financeBrowserRuntime,
});

interface FinanceProducts {
  readonly failed: boolean;
  readonly items: readonly ProductRecord[];
}

/**
 * The catalog only feeds the create-invoice form, so it is not part of the page's first paint. A legal entity
 * without merchandise access uses descriptive invoice lines and never requests the inaccessible catalog.
 */
const loadProducts = Effect.fn('Finance.referenceProducts')(function* loadProducts() {
  const access = yield* financeReferenceAccess;
  if (!access.productsReadable) {
    return { failed: false, items: [] } satisfies FinanceProducts;
  }
  const products = yield* listProducts('finance-billing.products', { limit: 250, ordersLimit: 0, summary: true }).pipe(
    Effect.result,
  );
  return (
    Result.isSuccess(products) ? { failed: false, items: products.success } : { failed: true, items: [] }
  ) satisfies FinanceProducts;
});

const financeProducts = definePageData({
  key: (scope: DocumentScope) => `products:${scope}`,
  load: loadProducts,
  runtime: financeBrowserRuntime,
});

const directorySnapshot = () => financeDirectory.snapshot(documentScope);
const productsSnapshot = () => financeProducts.snapshot(documentScope);
const pendingSnapshot = () => pageDataPending;
const noCustomers: readonly CustomerListItem[] = [];
const noCustomerIndex: CustomerIndex = new Map();
const noTitles: ReadonlyMap<string, string> = new Map();
const noProducts: readonly ProductRecord[] = [];

export const preloadFinanceDirectory: Effect.Effect<void> = financeDirectory.preload(documentScope);

/** Names that the invoice list, detail and create form show instead of opaque ids. */
export const useFinanceReferences = () => {
  const directorySnap = useSyncExternalStore(financeDirectory.subscribe, directorySnapshot, pendingSnapshot);
  const productsSnap = useSyncExternalStore(financeProducts.subscribe, productsSnapshot, pendingSnapshot);
  useEffect(() => {
    financeDirectory.ensure(documentScope);
    financeProducts.ensure(documentScope);
  }, []);
  const directory = directorySnap.state === 'ready' ? directorySnap.value : undefined;
  const products = productsSnap.state === 'ready' ? productsSnap.value : undefined;

  return {
    customerById: directory?.customerById ?? noCustomerIndex,
    customers: directory?.customers ?? noCustomers,
    /** True until the customer list answers, so rows do not read "Neznámý zákazník" while names are on the way. */
    customersLoading: directory === undefined,
    opportunitiesForbidden: directory?.opportunitiesForbidden ?? false,
    opportunityTitles: directory?.opportunityTitles ?? noTitles,
    products: products?.items ?? noProducts,
    productsReadable: directory?.productsReadable,
    referencesFailed: (directory?.failures.length ?? 0) > 0 || products?.failed === true,
  };
};
