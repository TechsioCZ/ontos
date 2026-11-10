import type { ProductRecord } from '@app/merchandise/contracts/records';
import { listProducts } from '@app/merchandise/clients/records';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { financePageScope } from './finance-page-scope.ts';
import { customerIndex } from './invoice-view.ts';
import type { CustomerIndex } from './invoice-view.ts';
import { financeReferenceAccess } from './sales-pipeline-readable.ts';

const ReferenceSourceSchema = Schema.Literals(['customers', 'opportunities', 'products']);
type ReferenceSource = typeof ReferenceSourceSchema.Type;

/**
 * The reference lists belong to one verified Shell scope (`financePageScope`, the cache key): another company or
 * principal never sees them, and a late answer for an old scope settles only that scope's entry. The scope only keys
 * the cache; the reads send the same requests as before, and the session's own credentials carry identity.
 */

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
  changesFrom: ['finance-billing', 'party-registry', 'sales-pipeline'],
  key: (scope: string) => scope,
  load: (_scope: string) => loadDirectory(),
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
  changesFrom: ['finance-billing', 'merchandise'],
  key: (scope: string) => scope,
  load: (_scope: string) => loadProducts(),
  runtime: financeBrowserRuntime,
});

const pendingSnapshot = () => pageDataPending;
const noCustomers: readonly CustomerListItem[] = [];
const noCustomerIndex: CustomerIndex = new Map();
const noTitles: ReadonlyMap<string, string> = new Map();
const noProducts: readonly ProductRecord[] = [];

/** The Shell's prefetch of the first-paint directory; without a verified scope there is nothing to read for. */
export const preloadFinanceDirectory = (context: ModulePageContext | undefined): Effect.Effect<void> => {
  const scope = financePageScope(context);
  return scope === undefined ? Effect.void : financeDirectory.preload(scope);
};

/**
 * Names that the invoice list, detail and create form show instead of opaque ids, for one verified scope
 * (`financePageScope`). Without a scope nothing is read and no list of any scope is exposed.
 */
export const useFinanceReferences = ({ scope }: { readonly scope: string | undefined }) => {
  const directorySnap = useSyncExternalStore(
    financeDirectory.subscribe,
    () => (scope === undefined ? pageDataPending : financeDirectory.snapshot(scope)),
    pendingSnapshot,
  );
  const productsSnap = useSyncExternalStore(
    financeProducts.subscribe,
    () => (scope === undefined ? pageDataPending : financeProducts.snapshot(scope)),
    pendingSnapshot,
  );
  useEffect(() => {
    if (scope !== undefined) {
      financeDirectory.ensure(scope);
      financeProducts.ensure(scope);
    }
  }, [scope]);
  const directory = directorySnap.state === 'ready' ? directorySnap.value : undefined;
  const products = productsSnap.state === 'ready' ? productsSnap.value : undefined;

  return {
    customerById: directory?.customerById ?? noCustomerIndex,
    customers: directory?.customers ?? noCustomers,
    /** True until the customer list answers, so rows do not read "Neznámý zákazník" while names are on the way. */
    customersLoading: scope !== undefined && directory === undefined,
    opportunitiesForbidden: directory?.opportunitiesForbidden ?? false,
    opportunityTitles: directory?.opportunityTitles ?? noTitles,
    products: products?.items ?? noProducts,
    productsReadable: directory?.productsReadable,
    /** The product catalog of the create form could not be read; the list itself shows no product names. */
    productsFailed: products?.failed === true,
    /**
     * Names the list shows (customers, opportunity titles) could not be read. A failed product catalog is not one of
     * them: it only leaves the create form without products, and says so there.
     */
    referencesFailed: (directory?.failures.length ?? 0) > 0,
  };
};
