import type { CatalogPagePrice, CatalogPagePricesResponse } from '@app/pricing/apis/catalog-page-prices';
import { Match, Option } from 'effect';

import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import type { ErpOffer } from './erp-offer.ts';

/** One page of the staff product list. */
export const PRODUCT_PAGE_SIZE = 25;

/** Every lifecycle state: staff see drafts and retired products beside the active ones. */
export const ALL_PRODUCT_LIFECYCLES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;

/** The largest page of Variants the Inventory and Pricing reads answer in one call. */
const VARIANT_PAGE_LIMIT = 100;

interface OwnerRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

/** The Catalog facts of a recorded option value the list shows; Catalog's AttributeValue is one. */
type OptionValue =
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly amount: number; readonly kind: 'MEASUREMENT'; readonly unit: string }
  | { readonly kind: 'CONTROLLED'; readonly valueRef: { readonly resourceId: string } }
  | { readonly kind: 'SPECIAL'; readonly state: string };

/** The product page item facts the list uses; a Catalog `ProductPageItem` is one. */
export interface PageProduct {
  readonly productRef: OwnerRef;
  readonly variants: readonly {
    readonly lifecycle: ProductPageItem['variants'][number]['lifecycle'];
    readonly localized: ProductPageItem['localized'];
    readonly options: readonly { readonly values: readonly OptionValue[] }[];
    readonly sku?: string;
    readonly variantRef: OwnerRef;
  }[];
}

interface VariantKey {
  readonly variantRef: { readonly resourceId: string };
}

/** One Variant's answer of Inventory's on-hand read, as far as the list shows it. */
export type OnHandAnswer =
  | (VariantKey & { readonly outcome: 'ON_HAND'; readonly total: { readonly amount: string } })
  | (VariantKey & { readonly outcome: 'NO_STOCK_ITEM' | 'CONFLICTING_BINDINGS' | 'NO_POSITION' | 'ON_HAND_UNKNOWN' });

/** Pricing's answer for one catalogue page of Variants. */
export type PricesAnswer = CatalogPagePricesResponse;
type PriceAnswer = CatalogPagePrice;

/** What the staff list shows for one Variant's ERP stock: the owner's outcome, never a guessed zero. */
export type StockCell =
  | { readonly kind: 'ON_HAND'; readonly quantity: string }
  | { readonly kind: 'NO_STOCK_ITEM' }
  | { readonly kind: 'CONFLICTING_BINDINGS' }
  | { readonly kind: 'NO_POSITION' }
  | { readonly kind: 'ON_HAND_UNKNOWN' }
  | { readonly kind: 'NOT_CONFIGURED' }
  | { readonly kind: 'READ_FAILED' };

/** What the staff list shows for one Variant's ERP price: the exact Price or why there is none. */
export type PriceCell =
  | { readonly amount: string; readonly currencyCode: string; readonly kind: 'PRICE' }
  | { readonly kind: 'NO_PRICE' }
  | { readonly kind: 'PRICING_CONFLICT' }
  | { readonly kind: 'PRICING_INDETERMINATE' }
  | { readonly kind: 'CURRENCY_NOT_SUPPORTED' }
  | { readonly kind: 'NOT_CONFIGURED' }
  | { readonly kind: 'READ_FAILED' };

export interface VariantRow {
  readonly lifecycle: PageProduct['variants'][number]['lifecycle'];
  readonly name: string | undefined;
  readonly options: string;
  readonly price: PriceCell;
  readonly sku: string | undefined;
  readonly stock: StockCell;
  readonly variantId: string;
}

/** The figures of one product's Variants: each read answers, failed, or was not asked (no ERP offer). */
export type ReadOutcome<A> =
  | { readonly kind: 'answered'; readonly value: A }
  | { readonly kind: 'failed' }
  | { readonly kind: 'not_configured' };

export interface VariantFigures {
  readonly onHand: ReadOutcome<readonly OnHandAnswer[]>;
  readonly prices: ReadOutcome<PricesAnswer>;
}

export const productName = (localized: ProductPageItem['localized']): string | undefined =>
  localized.kind === 'PRESENT' ? localized.name : undefined;

const valueText = (value: OptionValue): string =>
  Match.value(value).pipe(
    Match.discriminatorsExhaustive('kind')({
      CONTROLLED: ({ valueRef }) => valueRef.resourceId,
      MEASUREMENT: ({ amount, unit }) => `${String(amount)} ${unit}`,
      SPECIAL: ({ state }) => state,
      TEXT: ({ text }) => text,
    }),
  );

/** The recorded combination of an ACTIVE Variant, one axis value after another. */
export const optionsText = (options: PageProduct['variants'][number]['options']): string =>
  options.map(({ values }) => values.map(valueText).join(', ')).join(' / ');

const stockOf = (answer: OnHandAnswer): StockCell =>
  Match.value(answer).pipe(
    Match.discriminatorsExhaustive('outcome')({
      CONFLICTING_BINDINGS: (): StockCell => ({ kind: 'CONFLICTING_BINDINGS' }),
      NO_POSITION: (): StockCell => ({ kind: 'NO_POSITION' }),
      NO_STOCK_ITEM: (): StockCell => ({ kind: 'NO_STOCK_ITEM' }),
      ON_HAND: ({ total }): StockCell => ({ kind: 'ON_HAND', quantity: total.amount }),
      ON_HAND_UNKNOWN: (): StockCell => ({ kind: 'ON_HAND_UNKNOWN' }),
    }),
  );

const readFailed = { kind: 'READ_FAILED' } as const;

export const stockCellOf = (outcome: ReadOutcome<readonly OnHandAnswer[]>, variantId: string): StockCell => {
  if (outcome.kind === 'not_configured') {
    return { kind: 'NOT_CONFIGURED' };
  }
  if (outcome.kind === 'failed') {
    return readFailed;
  }
  return Option.match(
    Option.fromNullishOr(outcome.value.find(({ variantRef }) => variantRef.resourceId === variantId)),
    { onNone: (): StockCell => readFailed, onSome: stockOf },
  );
};

const priceOf = (answer: PriceAnswer): PriceCell =>
  Match.valueTags(answer, {
    NO_APPLICABLE_PRICE: (): PriceCell => ({ kind: 'NO_PRICE' }),
    PRICE_FOUND: ({ priceRevision }): PriceCell => ({ ...priceRevision.monetaryAmount, kind: 'PRICE' }),
    PRICING_CONFIGURATION_ERROR: (): PriceCell => ({ kind: 'PRICING_CONFLICT' }),
    PRICING_CONFLICT: (): PriceCell => ({ kind: 'PRICING_CONFLICT' }),
    PRICING_INDETERMINATE: (): PriceCell => ({ kind: 'PRICING_INDETERMINATE' }),
  });

export const priceCellOf = (outcome: ReadOutcome<PricesAnswer>, variantId: string): PriceCell => {
  if (outcome.kind === 'not_configured') {
    return { kind: 'NOT_CONFIGURED' };
  }
  if (outcome.kind === 'failed') {
    return readFailed;
  }
  return Match.valueTags(outcome.value, {
    CATALOG_PAGE_PRICED: ({ prices }): PriceCell =>
      Option.match(
        Option.fromNullishOr(
          prices.find(({ catalogSelection }) => catalogSelection.variantRef.resourceId === variantId),
        ),
        { onNone: (): PriceCell => readFailed, onSome: priceOf },
      ),
    CURRENCY_SUPPORT_NOT_CURRENT: (): PriceCell => ({ kind: 'CURRENCY_NOT_SUPPORTED' }),
  });
};

/** Every Variant of one product with its ERP price and stock, in Catalog order. */
export const variantRows = (item: PageProduct, figures: VariantFigures): readonly VariantRow[] =>
  item.variants.map((variant) => {
    const variantId = variant.variantRef.resourceId;
    return {
      lifecycle: variant.lifecycle,
      name: productName(variant.localized),
      options: optionsText(variant.options),
      price: priceCellOf(figures.prices, variantId),
      sku: variant.sku,
      stock: stockCellOf(figures.onHand, variantId),
      variantId,
    };
  });

/** The Variants one product's figures are read for: at most one page of each owner read. */
const pagedVariants = (item: PageProduct) => item.variants.slice(0, VARIANT_PAGE_LIMIT);

/** The encoded Inventory on-hand request for one product's Variants. */
export const onHandRequestOf = (offer: ErpOffer, item: PageProduct) => ({
  customerConfigurationId: offer.customerConfigurationId,
  variantRefs: pagedVariants(item).map(({ variantRef }) => variantRef),
});

/** The encoded Pricing request for one product's Variants: the exact no-group Price key of the ERP offer. */
export const pricesRequestOf = (offer: ErpOffer, item: PageProduct) => ({
  channelId: offer.channelId,
  currencyCode: offer.currencyCode,
  items: pagedVariants(item).map(({ variantRef }) => ({
    catalogSelection: { productRef: item.productRef, variantRef },
    unitBasis: {
      quantity: offer.unitQuantity,
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: offer.unitId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId: item.productRef.tenantId,
      },
    },
  })),
  marketId: offer.marketId,
});

/** A decimal Price amount as money in the page language (a BCP 47 tag): `1234.5`, `CZK` → `1 234,50 Kč`. */
export const formatPrice = (amount: string, currencyCode: string, language: string): string =>
  new Intl.NumberFormat(language, { currency: currencyCode, style: 'currency' }).format(Number(amount));

/** A stock figure in the page language: `1234.5` → `1 234,5`. */
export const formatQuantity = (quantity: string, language: string): string =>
  new Intl.NumberFormat(language, { maximumFractionDigits: 3 }).format(Number(quantity));
