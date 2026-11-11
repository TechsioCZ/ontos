// The products list reads: one page of products for the filters on screen and the category filter's choices, each
// from its strict store.
import { useHeldSnapshot } from '@app/admin-ui';
import { pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { MutableRef, Result, Schema } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useSettledPageData } from '../../../../runtime/page-data-hooks.ts';
import type { SettledPageData } from '../../../../runtime/page-data-hooks.ts';
import { categoryChoicesData, productListData, productListMemory, productScope } from './products-api.ts';
import type { CategoryChoices, FailureReason, ProductListInput, ProductListQuery } from './products-api.ts';

const NO_CHOICES: CategoryChoices = { hasTree: false, labels: [] };

/**
 * The category filter's choices; reread after the category panel or a product's category changes.
 *
 * `hasTree` decides which filter the list request carries (a storefront tree category or a category label), so the
 * choices must not read as none while their strict store reloads the same company: the request would lose its
 * category, the table would load another page, and the filter control would leave the screen and come back.
 */
export const useCategoryChoices = (legalEntityId: string) => {
  const snapshot = useSyncExternalStore(
    (listener) => categoryChoicesData.subscribe(listener, legalEntityId),
    () => categoryChoicesData.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => {
    categoryChoicesData.ensure(legalEntityId);
  }, [legalEntityId]);
  // The last ready choices of the same company answer a reload; another company starts without choices, and a
  // failed reload replaces them at once.
  const held = useHeldSnapshot(categoryChoicesData.key(legalEntityId), snapshot);
  return {
    choices: held.state === 'ready' ? held.value : NO_CHOICES,
    reload: () => {
      browserRuntime.runFork(categoryChoicesData.refresh(legalEntityId));
    },
  };
};

export type ProductLoadState =
  | { readonly reason: FailureReason; readonly status: 'error' }
  | { readonly query: ProductListQuery; readonly response: RecordsResponse; readonly status: 'ready' }
  | { readonly status: 'loading' };

/** The last settled read of the list; while a new query loads it stays on screen (`query` tells which it answers). */
const productLoadState = (
  settled: SettledPageData<ProductListInput, RecordsResponse, FailureReason> | undefined,
): ProductLoadState => {
  if (settled === undefined) {
    return { status: 'loading' };
  }
  const { snapshot } = settled;
  return snapshot.state === 'failed'
    ? { reason: snapshot.error, status: 'error' }
    : { query: settled.input.query, response: snapshot.value, status: 'ready' };
};

const QueryIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeQueryIds = Schema.encodeResult(QueryIdsJson);
const decodeQueryIds = Schema.decodeResult(QueryIdsJson);

/**
 * The products page for `query`. `state.query` tells which query the state answers: while another query loads it is
 * still the previous one, and the table shows its loading rows. A reload of the query on screen keeps its rows and
 * capabilities until the reload settles.
 */
export const useProductPage = (legalEntityId: string, query: ProductListQuery, context?: ModulePageContext) => {
  const scope = productScope(context);
  const input: ProductListInput = { legalEntityId, query, scope };
  const snapshot = useSyncExternalStore(
    (listener) => productListData.subscribe(listener, input),
    () => productListData.snapshot(input),
    () => pageDataPending,
  );
  const { category, categoryId, limit, lowStockOnly, offset, search, sort } = query;
  const taggedIdsJson = query.taggedIds === null ? null : Result.getOrThrow(encodeQueryIds(query.taggedIds));
  // The effect owns its request object; only changed filter values ensure another entry.
  useEffect(() => {
    productListData.ensure({
      legalEntityId,
      query: {
        category,
        categoryId,
        limit,
        lowStockOnly,
        offset,
        search,
        sort,
        taggedIds: taggedIdsJson === null ? null : Result.getOrThrow(decodeQueryIds(taggedIdsJson)),
      },
      scope,
    });
  }, [category, categoryId, legalEntityId, limit, lowStockOnly, offset, scope, search, sort, taggedIdsJson]);
  // The strict store reads as pending while it reloads this request (freshness window, live change, settled write).
  // The table keeps the last ready read of the same request until the reload settles; another request never reuses
  // it, and a failed or refused reload replaces it at once.
  // A list reopened while its store reloads starts from its last ready read of this request (`memory`).
  const held = useHeldSnapshot(productListData.key(input), snapshot, { memory: MutableRef.get(productListMemory) });
  const settled = useSettledPageData(held, input);
  return {
    reload: () => {
      browserRuntime.runFork(productListData.refresh(input));
    },
    state: productLoadState(
      settled !== undefined && settled.input.scope === scope && settled.input.legalEntityId === legalEntityId
        ? settled
        : undefined,
    ),
    viewKey: productListData.key(input),
  };
};
