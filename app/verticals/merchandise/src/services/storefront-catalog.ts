// Storefront catalog projection: paged/filtered public product cards + category tree, and order status lookup.
import type {
  MerchandiseState,
  StorefrontCatalogQuery,
  StorefrontOrderStatus,
  StorefrontOrderStatusLookup,
} from '../../shared/apis/records.ts';
import type { CatalogCategory, Order, OrderStatus, ProductRecord } from '../../shared/domain/merchandise-model.ts';

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

const customerStatusLabels: Readonly<Record<OrderStatus, string>> = {
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Zpracovává se',
  DELIVERED: 'Dokončená',
  NEW: 'Nová',
  PACKING: 'Připravená k předání',
  SHIPPED: 'Předáno dopravci (simulace)',
};
const isInStock = (availability: ProductRecord['availability']) =>
  availability === 'IN_STOCK' || availability === 'LOW_STOCK';
const labelMatches = (record: ProductRecord, label: NonNullable<StorefrontCatalogQuery['label']>) =>
  label === 'action'
    ? record.isAction === true
    : label === 'recommended'
      ? record.isRecommended === true
      : label === 'sale'
        ? record.isSale === true
        : record.isNew === true;
/** Same folding as Kai's mock search: no diacritics, Czech lower case ('šroub' and 'sroub' match). */
export const normalizeSearchText = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('cs')
    .trim();
const parameterText = (parameters: ProductRecord['parameters']) =>
  (parameters ?? []).map(({ label, value, unit }) => `${label} ${value} ${unit}`);
// Records come from the owner's state cache, so the folded text is built once per record object.
const searchTexts = new WeakMap<ProductRecord, string>();
const searchTextOf = (record: ProductRecord) => {
  const cached = searchTexts.get(record);
  if (cached !== undefined) return cached;
  const text = normalizeSearchText(
    [
      record.name,
      record.sku,
      record.shortDescription ?? '',
      ...parameterText(record.parameters),
      ...(record.variantRecords ?? []).flatMap((variant) => [
        variant.name,
        variant.sku,
        variant.attributes,
        ...parameterText(variant.parameters),
      ]),
    ].join(' '),
  );
  searchTexts.set(record, text);
  return text;
};
const priceOf = (record: ProductRecord) => record.grossPriceMinor ?? Number.MAX_SAFE_INTEGER;

/** Public shape of one product: no raw variants/price history/content history; derived paragraphs + gallery. */
export const toStorefrontProduct = (record: ProductRecord, fields: 'card' | 'full'): ProductRecord => {
  const { variants: _rawVariants, contentHistory: _history, ...rest } = record;
  void _rawVariants;
  void _history;
  const gallery =
    record.images !== undefined && record.images.length > 0
      ? [...record.images]
      : record.imageSrc === undefined || record.imageSrc === ''
        ? []
        : [record.imageSrc];
  const descriptionParagraphs = (record.description ?? '')
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const full: ProductRecord = {
    ...rest,
    descriptionParagraphs,
    gallery,
    priceHistory: [],
    ...(record.variantRecords === undefined
      ? {}
      : { variantRecords: record.variantRecords.map((variant) => ({ ...variant, priceHistory: [] })) }),
  };
  if (fields === 'full') return full;
  const { variantRecords: _v, description: _d, descriptionParagraphs: _p, parameters: _pa, ...card } = full;
  void _v;
  void _d;
  void _p;
  void _pa;
  return card;
};

/** `records` are ALL product records of the state; this function applies active/published visibility itself. */
export const storefrontCatalogPage = (input: {
  readonly state: MerchandiseState;
  readonly records: readonly ProductRecord[];
  readonly query: StorefrontCatalogQuery;
}): StorefrontCatalogPage => {
  const { state, records, query } = input;
  const visible = records.filter(
    (record) => record.active && record.published !== false && record.demoArchive === undefined,
  );
  const categories = state.categories ?? [];
  const featuredIds = state.homepageFeaturedProductIds ?? [];

  let list: readonly ProductRecord[] = visible;
  if (query.featured === true) {
    const byId = new Map<string, ProductRecord>(visible.map((record) => [record.id, record] as const));
    const seen = new Set<string>();
    const featured = featuredIds.flatMap((id) => {
      const record = byId.get(id);
      if (record === undefined || seen.has(id)) return [];
      seen.add(id);
      return [record];
    });
    list = [...featured, ...visible.filter((record) => record.isRecommended === true && !seen.has(record.id))];
  }
  if (query.productIds !== undefined) {
    const byId = new Map<string, ProductRecord>(list.map((record) => [record.id, record] as const));
    list = query.productIds.flatMap((id) => {
      const record = byId.get(id);
      return record === undefined ? [] : [record];
    });
  }
  if (query.slug !== undefined) {
    const slug = query.slug;
    list = list.filter((record) => record.slug === slug);
  }
  if (query.categorySlug !== undefined) {
    const category = categories.find((candidate) => candidate.slug === query.categorySlug);
    list =
      category === undefined
        ? []
        : list.filter(
            (record) => record.categoryId === category.id || (record.categoryPathIds ?? []).includes(category.id),
          );
  }
  if (query.label !== undefined) {
    const label = query.label;
    list = list.filter((record) => labelMatches(record, label));
  }
  // Every word must occur somewhere in the product text; word order does not matter.
  const words = normalizeSearchText(query.q ?? '')
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length > 0)
    list = list.filter((record) => {
      const text = searchTextOf(record);
      return words.every((word) => text.includes(word));
    });
  if (query.minMinor !== undefined) {
    const minMinor = query.minMinor;
    list = list.filter((record) => (record.grossPriceMinor ?? 0) >= minMinor);
  }
  if (query.maxMinor !== undefined) {
    const maxMinor = query.maxMinor;
    list = list.filter((record) => (record.grossPriceMinor ?? 0) <= maxMinor);
  }
  if (query.availability === 'in-stock') list = list.filter((record) => isInStock(record.availability));
  if (query.availability === 'out-of-stock') list = list.filter((record) => !isInStock(record.availability));
  if (query.sort === 'name' || (query.sort === undefined && words.length > 0)) {
    const needle = normalizeSearchText(query.q ?? '');
    const rank = (record: ProductRecord) => {
      const name = normalizeSearchText(record.name);
      const sku = normalizeSearchText(record.sku);
      if (name === needle || sku === needle) return 0;
      if (name.includes(needle) || sku.includes(needle)) return 1;
      if (words.every((word) => `${name} ${sku}`.includes(word))) return 2;
      return 3;
    };
    list = list.toSorted((a, b) => (words.length === 0 ? 0 : rank(a) - rank(b)) || a.name.localeCompare(b.name, 'cs'));
  }
  if (query.sort === 'price-asc') list = list.toSorted((a, b) => priceOf(a) - priceOf(b));
  if (query.sort === 'price-desc') list = list.toSorted((a, b) => priceOf(b) - priceOf(a));

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_STOREFRONT_PAGE_SIZE;
  const products = list
    .slice((page - 1) * pageSize, page * pageSize)
    .map((record) => toStorefrontProduct(record, query.fields ?? 'full'));
  return {
    products,
    total: list.length,
    page,
    pageSize,
    homepageFeaturedProductIds: featuredIds,
    ...(query.includeCategories === false
      ? {}
      : {
          // Slim tree: heading and long description only for the requested category (the storefront shows them
          // nowhere else), which keeps every read about 250 kB lighter with the full AKROS tree.
          categories: categories
            .filter((category) => {
              const seen = new Set<string>();
              let current: CatalogCategory | undefined = category;
              while (current !== undefined && !seen.has(current.id)) {
                if (current.published === false) return false;
                seen.add(current.id);
                current = categories.find((parent) => parent.id === current?.parentId);
              }
              return true;
            })
            .map(({ history: _history, ...category }) => {
              void _history;
              return category.slug === query.categorySlug
                ? category
                : { ...category, heading: '', longDescription: '' };
            }),
        }),
  };
};

/** Customer-safe status of one storefront order; null unless id AND clientRequestId match a visible order. */
export const storefrontOrderStatusOf = (
  orders: readonly Order[],
  lookup: StorefrontOrderStatusLookup,
): StorefrontOrderStatus | null => {
  const order = orders.find(
    (candidate) =>
      candidate.id === lookup.orderId &&
      candidate.clientRequestId === lookup.clientRequestId &&
      candidate.channel === 'STOREFRONT' &&
      candidate.demoCleanup === undefined,
  );
  return order === undefined
    ? null
    : {
        id: order.id,
        number: order.number,
        status: order.status,
        statusLabel: customerStatusLabels[order.status],
        updatedAt: order.updatedAt,
      };
};
