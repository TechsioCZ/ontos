// Bounded product reads for pickers: the server search returns one page of list rows; the full record with its
// variants is read one product at a time, only for the product the user picks.
import { Effect, Random } from 'effect';
import type { Duration } from 'effect';
import { useEffect, useState } from 'react';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { CATEGORY_RESULT_LIMIT } from '../../../../../shared/domain/category-search.ts';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';

export const SEARCH_DEBOUNCE: Duration.Input = '250 millis';

/** `value` once it has stayed unchanged for `delay`, so typing reads the server once per pause. */
export const useDebounced = <A>(value: A, delay: Duration.Input = SEARCH_DEBOUNCE): A => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const fiber = browserRuntime.runFork(
      Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(() => setSettled(value)))),
    );
    return () => {
      fiber.interruptUnsafe();
    };
  }, [value, delay]);
  return settled;
};

/** Rows one picker search shows. Typing more narrows the result. */
const PRODUCT_SEARCH_LIMIT = 20;

const correlation = (purpose: string) =>
  Random.nextInt.pipe(Effect.map((nonce) => `merchandise:product-search:${purpose}:${nonce}`));

/** One page of summary rows matching `search` (name, SKU), optionally only active products. */
export const searchProducts = (search: string, activeOnly: boolean) =>
  correlation('list').pipe(
    Effect.flatMap((id) =>
      executeRecords(
        {
          view: {
            limit: PRODUCT_SEARCH_LIMIT,
            ordersLimit: 0,
            summary: true,
            ...(search === '' ? {} : { search }),
            ...(activeOnly ? { active: true } : {}),
          },
        },
        id,
      ),
    ),
    Effect.map((response) => response.products),
  );

/** Tree categories whose path matches `text` (blank = top-level ones), best first, with the match count. */
export const searchCategoryTrails = (text: string) =>
  correlation('categories').pipe(
    Effect.flatMap((id) =>
      executeRecords(
        { view: { categorySearch: { limit: CATEGORY_RESULT_LIMIT, text }, limit: 0, ordersLimit: 0 } },
        id,
      ),
    ),
    Effect.map((response) => ({ matches: response.categoryMatches ?? [], total: response.categoryMatchTotal ?? 0 })),
  );

/**
 * Full record (variants, prices) of one product. Reads without `summary` return at most two products, so the full
 * record is read one product at a time; `productIds` (not `productId`) leaves its movements out.
 */
export const readProductRecord = (productId: ProductId) =>
  correlation('record').pipe(
    Effect.flatMap((id) => executeRecords({ view: { limit: 1, ordersLimit: 0, productIds: [productId] } }, id)),
    Effect.map((response) => response.products.find((product) => product.id === productId)),
  );

export type ProductRecordState =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly product: ProductRecord; readonly status: 'ready' };

/** Reads the full record of one picked product and reports the outcome; the caller drops it for a stale pick. */
export const loadProductRecord = (productId: ProductId, onLoaded: (state: ProductRecordState) => void): void => {
  void browserRuntime.runPromise(
    readProductRecord(productId).pipe(
      Effect.match({
        onFailure: (): ProductRecordState => ({ status: 'error' }),
        onSuccess: (product): ProductRecordState =>
          product === undefined ? { status: 'error' } : { product, status: 'ready' },
      }),
      Effect.map(onLoaded),
    ),
  );
};
