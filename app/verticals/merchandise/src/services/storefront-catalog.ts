// Storefront projections: the public product shape, search-text folding and the customer-safe order status.
import type { StorefrontOrderStatus } from '../../shared/apis/records.ts';
import type { Order, OrderStatus, ProductRecord } from '../../shared/domain/merchandise-model.ts';

export const DEFAULT_STOREFRONT_PAGE_SIZE = 24;

const customerStatusLabels: Readonly<Record<OrderStatus, string>> = {
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Zpracovává se',
  DELIVERED: 'Dokončená',
  NEW: 'Nová',
  PACKING: 'Připravená k předání',
  SHIPPED: 'Předáno dopravci',
};
/** Search folding: no diacritics, Czech lower case ('šroub' and 'sroub' match). */
export const normalizeSearchText = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('cs')
    .trim();
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

/** Customer-safe status of one storefront order (no contact, address, lines or totals). */
export const storefrontStatusOf = (order: Order): StorefrontOrderStatus => ({
  id: order.id,
  number: order.number,
  status: order.status,
  statusLabel: customerStatusLabels[order.status],
  updatedAt: order.updatedAt,
});
