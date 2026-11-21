// Page data of the staff product list (definePageData: prepared before the Shell reveals the page, kept per
// document). The list is Catalog's product page read; a product's ERP figures are Inventory's on-hand read and
// Pricing's catalogue page price read, both in the signed-in company.
import { CatalogVariantOnHandPageRequestSchema } from '@app/inventory/api/catalog-variant-on-hand-page';
import { executeCatalogVariantOnHandPage } from '@app/inventory/api/catalog-variant-on-hand-page-client';
import { executeCatalogPagePrices } from '@app/pricing/apis/catalog-page-prices-client';
import { CatalogPagePricesRequestSchema } from '@app/pricing/apis/catalog-page-prices';
import { definePageData } from '@app/shared-contracts/page-data';
import { Effect, Option, Schema } from 'effect';

import { ProductPageRequestSchema } from '../../shared/apis/product-page.ts';
import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import { executeProductPage } from '../api/product-page-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { requestId } from './browser-crypto.ts';
import { encodeErpOffer } from './erp-offer.ts';
import type { ErpOffer } from './erp-offer.ts';
import { ALL_PRODUCT_LIFECYCLES, onHandRequestOf, PRODUCT_PAGE_SIZE, pricesRequestOf } from './products-model.ts';
import type { ReadOutcome, VariantFigures } from './products-model.ts';

/** This vertical's deployment app id and the apps whose data the page shows. */
const ownApp = 'catalog';

export interface ProductListInput {
  /** The signed-in company: each company's session keeps its own entries. */
  readonly legalEntityId: string;
  readonly locale: string;
  readonly offset: number;
  readonly search: string;
}

/** The encoded product page request; an empty search names none. */
const productPageRequestOf = (input: ProductListInput) => {
  const request = {
    lifecycles: ALL_PRODUCT_LIFECYCLES,
    limit: PRODUCT_PAGE_SIZE,
    locale: input.locale,
    offset: input.offset,
  };
  const search = input.search.trim();
  return search === '' ? request : { ...request, search };
};

export const productListData = definePageData({
  changesFrom: [ownApp],
  key: (input: ProductListInput) =>
    [input.legalEntityId, input.locale, String(input.offset), input.search].map(encodeURIComponent).join('|'),
  load: (input: ProductListInput) =>
    Schema.decodeUnknownEffect(ProductPageRequestSchema)(productPageRequestOf(input)).pipe(
      Effect.flatMap((request) => requestId.pipe(Effect.flatMap((id) => executeProductPage(request, id)))),
    ),
  runtime: browserRuntime,
});

export interface VariantFiguresInput {
  readonly item: ProductPageItem;
  readonly legalEntityId: string;
  readonly offer: Option.Option<ErpOffer>;
}

const outcomeOf = <A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<ReadOutcome<A>, never, R> =>
  read.pipe(
    Effect.map((value): ReadOutcome<A> => ({ kind: 'answered', value })),
    Effect.orElseSucceed((): ReadOutcome<A> => ({ kind: 'failed' })),
  );

const notConfigured = { kind: 'not_configured' } as const;

const readFigures = (offer: ErpOffer, item: ProductPageItem) =>
  Effect.all(
    {
      onHand: outcomeOf(
        Schema.decodeUnknownEffect(CatalogVariantOnHandPageRequestSchema)(onHandRequestOf(offer, item)).pipe(
          Effect.flatMap((request) =>
            requestId.pipe(Effect.flatMap((id) => executeCatalogVariantOnHandPage(request, id))),
          ),
          Effect.map(({ items }) => items),
        ),
      ),
      prices: outcomeOf(
        Schema.decodeUnknownEffect(CatalogPagePricesRequestSchema)(pricesRequestOf(offer, item)).pipe(
          Effect.flatMap((request) => requestId.pipe(Effect.flatMap((id) => executeCatalogPagePrices(request, id)))),
        ),
      ),
    },
    { concurrency: 2 },
  );

/** One product's Variant figures under the ERP offer; without an offer nothing is asked. */
export const variantFiguresData = definePageData({
  changesFrom: [ownApp, 'inventory', 'pricing'],
  key: (input: VariantFiguresInput) =>
    [
      input.legalEntityId,
      input.item.productRef.resourceId,
      String(input.item.revision),
      Option.match(input.offer, { onNone: () => '', onSome: encodeErpOffer }),
    ]
      .map(encodeURIComponent)
      .join('|'),
  load: (input: VariantFiguresInput): Effect.Effect<VariantFigures> =>
    Option.match(input.offer, {
      onNone: () => Effect.succeed<VariantFigures>({ onHand: notConfigured, prices: notConfigured }),
      onSome: (offer) => readFigures(offer, input.item),
    }),
  maxEntries: 50,
  runtime: browserRuntime,
});
