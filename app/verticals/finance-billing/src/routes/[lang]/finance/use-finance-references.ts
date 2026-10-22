import type { ProductRecord } from '@app/merchandise/contracts/records';
import { listProducts } from '@app/merchandise/clients/records';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { Effect, Predicate, Schema } from 'effect';
import { useEffect, useState } from 'react';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { customerIndex } from './invoice-view.ts';
import { financeReferenceAccess } from './sales-pipeline-readable.ts';

const ReferenceSourceSchema = Schema.Literals(['customers', 'opportunities', 'products']);
type ReferenceSource = typeof ReferenceSourceSchema.Type;

interface ReferenceFailure {
  readonly cause: unknown;
  readonly source: ReferenceSource;
}

/**
 * Names that the invoice list, detail and create form show instead of opaque ids. Each list loads on its own,
 * so one failing read leaves the others usable and sets `referencesFailed`. A role without access to the sales
 * pipeline is not a failure: `opportunitiesForbidden` lets the list mark those cells instead. A legal entity
 * without merchandise access uses descriptive invoice lines and never requests the inaccessible catalog.
 */
export const useFinanceReferences = () => {
  const [customers, setCustomers] = useState<readonly CustomerListItem[]>([]);
  const [opportunityTitles, setOpportunityTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [products, setProducts] = useState<readonly ProductRecord[]>([]);
  const [failures, setFailures] = useState<readonly ReferenceFailure[]>([]);
  const [opportunitiesForbidden, setOpportunitiesForbidden] = useState(false);
  const [productsReadable, setProductsReadable] = useState<boolean>();
  /** True until the customer list answers, so rows do not read "Neznámý zákazník" while names are on the way. */
  const [customersLoading, setCustomersLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const recordFailure = (source: ReferenceSource, cause: unknown) => {
      if (active) {
        setFailures((current) => [...current, { cause, source }]);
      }
    };
    void financeBrowserRuntime.runPromise(
      listCustomers({ includeArchived: true }).pipe(
        Effect.match({
          onFailure: (cause) => recordFailure('customers', cause),
          onSuccess: (items) => {
            if (active) {
              setCustomers(items);
            }
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (active) {
              setCustomersLoading(false);
            }
          }),
        ),
      ),
    );
    const markOpportunitiesForbidden = () => {
      if (active) {
        setOpportunitiesForbidden(true);
      }
    };
    const loadOpportunityTitles = listOpportunities({}, 'finance-billing.opportunities').pipe(
      Effect.match({
        onFailure: (cause) => {
          if (Predicate.isTagged(cause, 'RecordsForbiddenProblem')) {
            markOpportunitiesForbidden();
          } else {
            recordFailure('opportunities', cause);
          }
        },
        onSuccess: (response) => {
          if (active) {
            setOpportunityTitles(new Map<string, string>(response.items.map((item) => [item.id, item.title] as const)));
          }
        },
      }),
    );
    const loadProducts = listProducts('finance-billing.products', { limit: 250, ordersLimit: 0, summary: true }).pipe(
      Effect.match({
        onFailure: (cause) => recordFailure('products', cause),
        onSuccess: (items) => {
          if (active) {
            setProducts(items);
          }
        },
      }),
    );
    void financeBrowserRuntime.runPromise(
      financeReferenceAccess.pipe(
        Effect.flatMap((access) => {
          if (active) {
            setProductsReadable(access.productsReadable);
          }
          return Effect.all(
            [
              access.opportunitiesReadable ? loadOpportunityTitles : Effect.sync(markOpportunitiesForbidden),
              access.productsReadable ? loadProducts : Effect.void,
            ],
            { concurrency: 2 },
          );
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, []);

  return {
    customerById: customerIndex(customers),
    customers,
    customersLoading,
    opportunitiesForbidden,
    opportunityTitles,
    products,
    productsReadable,
    referencesFailed: failures.length > 0,
  };
};
