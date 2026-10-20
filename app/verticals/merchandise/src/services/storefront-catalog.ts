// Storefront catalog projection: paged/filtered public product cards + category tree, and order status lookup.
// SKELETON (lane akros-sync-backend): task "storefront-catalog" replaces the stub bodies; keep the exported signatures.
import type {
  MerchandiseState,
  StorefrontCatalogQuery,
  StorefrontOrderStatus,
  StorefrontOrderStatusLookup,
} from '../../shared/apis/records.ts';
import type { CatalogCategory, Order, ProductRecord } from '../../shared/domain/merchandise-model.ts';

export const DEFAULT_STOREFRONT_PAGE_SIZE = 24;

export interface StorefrontCatalogPage {
  readonly products: readonly ProductRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly homepageFeaturedProductIds: readonly string[];
  /** Absent when the query sets `includeCategories: false`. */
  readonly categories?: readonly CatalogCategory[];
}

/** Public shape of one product: no raw variants/price history/content history; derived paragraphs + gallery. */
export const toStorefrontProduct = (record: ProductRecord, fields: 'card' | 'full'): ProductRecord => {
  void fields;
  return record;
};

/** `records` are ALL product records of the state; this function applies active/published visibility itself. */
export const storefrontCatalogPage = (input: {
  readonly state: MerchandiseState;
  readonly records: readonly ProductRecord[];
  readonly query: StorefrontCatalogQuery;
}): StorefrontCatalogPage => ({
  homepageFeaturedProductIds: input.state.homepageFeaturedProductIds ?? [],
  page: input.query.page ?? 1,
  pageSize: input.query.pageSize ?? DEFAULT_STOREFRONT_PAGE_SIZE,
  products: [],
  total: 0,
});

/** Customer-safe status of one storefront order; null unless id AND clientRequestId match a visible order. */
export const storefrontOrderStatusOf = (
  orders: readonly Order[],
  lookup: StorefrontOrderStatusLookup,
): StorefrontOrderStatus | null => {
  void orders;
  void lookup;
  return null;
};
