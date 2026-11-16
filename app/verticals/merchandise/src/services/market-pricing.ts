// Market projection of storefront product records and orders: prices converted into the market currency
// (shared/domain/market-offers.ts) and the per-market offer a storefront order is checked against.
import { Option } from 'effect';
import type { MarketId, MarketPricing, OrderMarket, StorefrontMarket } from '../../shared/domain/market-offers.ts';
import { convertGrossMinor } from '../../shared/domain/market-offers.ts';
import type { ProductRecord, SearchVariantOffer, VariantRecord } from '../../shared/domain/merchandise-model.ts';

type PriceTiers = NonNullable<ProductRecord['priceTiers']>;

const tiersIn = (tiers: PriceTiers, pricing: MarketPricing): PriceTiers =>
  tiers.map((tier) => ({
    ...tier,
    priceExcludingVatMinor: convertGrossMinor(tier.priceExcludingVatMinor, pricing),
    priceMinor: convertGrossMinor(tier.priceMinor, pricing),
  }));

const variantIn = <Variant extends VariantRecord>(variant: Variant, pricing: MarketPricing): Variant => {
  const net: Variant = { ...variant, priceMinor: convertGrossMinor(variant.priceMinor, pricing) };
  const converted: Variant =
    variant.grossPriceMinor === undefined
      ? net
      : { ...net, grossPriceMinor: convertGrossMinor(variant.grossPriceMinor, pricing) };
  return variant.priceTiers === undefined
    ? converted
    : { ...converted, priceTiers: tiersIn(variant.priceTiers, pricing) };
};

/** Match the storefront's minimum-key deduplication and displayed-gross tier lookup AFTER conversion. */
const displayNetOf = (variant: SellableVariantRecord) => {
  if (variant.grossPriceMinor <= 0 || variant.priceMinor <= 0) {
    return Option.none<number>();
  }
  const tiers = [
    {
      minimumQuantity: variant.minimumQuantity ?? 1,
      priceExcludingVatMinor: variant.priceMinor,
      priceMinor: variant.grossPriceMinor,
    },
    ...(variant.priceTiers ?? []).filter((tier) => tier.priceMinor > 0),
  ];
  return Option.fromUndefinedOr(
    [...new Map(tiers.map((tier) => [tier.minimumQuantity, tier] as const)).values()]
      .toSorted((left, right) => left.minimumQuantity - right.minimumQuantity)
      .find((tier) => tier.priceMinor === variant.grossPriceMinor)?.priceExcludingVatMinor,
  );
};

/** A variant whose classification is sellable: it has a gross price. Only such variants reach the storefront. */
export type SellableVariantRecord = VariantRecord & { readonly grossPriceMinor: number };

/** Canonical CZK singleton -> one market-priced offer. Call once, before attaching it to the public product. */
export const searchVariantOffer = (
  source: SellableVariantRecord,
  pricing: Option.Option<MarketPricing>,
): SearchVariantOffer => {
  const variant = Option.match(pricing, { onNone: () => source, onSome: (market) => variantIn(source, market) });
  let offer: SearchVariantOffer = {
    availability: variant.availability,
    currency: Option.match(pricing, { onNone: () => 'CZK', onSome: (market) => market.currency }),
    grossPriceMinor: variant.grossPriceMinor,
    id: variant.id,
    name: variant.name,
    priceMinor: variant.priceMinor,
    sku: variant.sku,
    stockOnHand: variant.stockOnHand,
    unit: variant.unit ?? variant.sourceUnit ?? 'ks',
  };
  const displayPriceExcludingVatMinor = displayNetOf(variant);
  if (Option.isSome(displayPriceExcludingVatMinor)) {
    offer = { ...offer, displayPriceExcludingVatMinor: displayPriceExcludingVatMinor.value };
  }
  if (variant.imageSrc !== undefined) {
    offer = { ...offer, imageSrc: variant.imageSrc };
  }
  if (variant.minimumQuantity !== undefined) {
    offer = { ...offer, minimumQuantity: variant.minimumQuantity };
  }
  if (variant.packageQuantity !== undefined) {
    offer = { ...offer, packageQuantity: variant.packageQuantity };
  }
  if (variant.sourceUnit !== undefined) {
    offer = { ...offer, sourceUnit: variant.sourceUnit };
  }
  return offer;
};

/**
 * Every price field of a storefront product in the market currency: gross prices (authoritative for the storefront and
 * the order check), net prices and tiers (display only), the variant summary's lowest price. Price history is never
 * part of a storefront record, and stock value is not a price.
 */
export const productInMarketCurrency = (record: ProductRecord, pricing: MarketPricing): ProductRecord => {
  let converted: ProductRecord = { ...record, currentPriceMinor: convertGrossMinor(record.currentPriceMinor, pricing) };
  if (record.grossPriceMinor !== undefined) {
    converted = { ...converted, grossPriceMinor: convertGrossMinor(record.grossPriceMinor, pricing) };
  }
  if (record.priceTiers !== undefined) {
    converted = { ...converted, priceTiers: tiersIn(record.priceTiers, pricing) };
  }
  if (record.variantRecords !== undefined) {
    converted = { ...converted, variantRecords: record.variantRecords.map((variant) => variantIn(variant, pricing)) };
  }
  if (record.variantSummary !== undefined) {
    converted = {
      ...converted,
      variantSummary: {
        ...record.variantSummary,
        minGrossPriceMinor: record.variantSummary.minGrossPriceMinor.pipe(
          Option.map((minor) => convertGrossMinor(minor, pricing)),
        ),
      },
    };
  }
  return converted;
};

/** Gross price a product shows in staff market rows: its own, else the lowest active variant price. */
export const productGrossCzk = (record: ProductRecord): Option.Option<number> => {
  if (record.grossPriceMinor !== undefined) {
    return Option.some(record.grossPriceMinor);
  }
  let lowest = Option.none<number>();
  for (const variant of record.variantRecords ?? []) {
    const price = variant.grossPriceMinor;
    if (variant.active && price !== undefined) {
      lowest = Option.some(Option.match(lowest, { onNone: () => price, onSome: (other) => Math.min(other, price) }));
    }
  }
  return lowest;
};

/** The storefront `market` field of a configured market. */
export const storefrontMarketOf = (market: OrderMarket): StorefrontMarket => ({
  configured: true,
  currency: market.currency,
  marketCode: market.marketCode,
  marketId: market.marketId,
});

/** The storefront `market` field of a market without settings: CZK, no code, nothing offered. */
export const unconfiguredStorefrontMarket = (marketId: MarketId): StorefrontMarket => ({
  configured: false,
  currency: 'CZK',
  marketId,
});

/** The storefront `market` field of a resolved `storefrontCatalog.marketId`. */
export const storefrontMarketFor = (marketId: MarketId, market: Option.Option<OrderMarket>): StorefrontMarket =>
  Option.match(market, { onNone: () => unconfiguredStorefrontMarket(marketId), onSome: storefrontMarketOf });

/** A storefront order's market as the pure command sees it. */
export type StorefrontOrderMarket =
  | { readonly kind: 'czk' }
  | { readonly kind: 'unavailable'; readonly marketId: MarketId }
  | { readonly kind: 'priced'; readonly market: OrderMarket; readonly offeredProductIds: ReadonlySet<string> };

/**
 * The market of a storefront order: no `marketId` is a CZK order; otherwise only the context persistence resolved for
 * that same market counts, and a market without settings offers nothing.
 */
export const storefrontOrderMarketOf = (
  marketId: MarketId | undefined,
  context: OrderMarketContext | undefined,
): StorefrontOrderMarket => {
  if (marketId === undefined) {
    return { kind: 'czk' };
  }
  const unavailable: StorefrontOrderMarket = { kind: 'unavailable', marketId };
  if (context === undefined || context.marketId !== marketId) {
    return unavailable;
  }
  return Option.match(context.market, {
    onNone: () => unavailable,
    onSome: (market): StorefrontOrderMarket => ({
      kind: 'priced',
      market,
      offeredProductIds: context.offeredProductIds,
    }),
  });
};

/** The price list of a priced storefront order market; CZK orders have none. */
export const pricedMarketOf = (orderMarket: StorefrontOrderMarket): OrderMarket | undefined =>
  orderMarket.kind === 'priced' ? orderMarket.market : undefined;

/** Whether the order's market offers the product (CZK orders offer every sellable product). */
export const offeredInOrderMarket = (orderMarket: StorefrontOrderMarket, productId: string): boolean =>
  orderMarket.kind !== 'priced' || orderMarket.offeredProductIds.has(productId);

/** `{ market }` of a storefront result for a priced order, nothing otherwise. */
export const storefrontMarketField = (market: OrderMarket | undefined) =>
  market === undefined ? {} : { market: storefrontMarketOf(market) };

/**
 * What a storefront order needs from its market, resolved before the pure command runs: the market's price list
 * (none = the market has no settings, nothing is offered) and which of the ordered products it offers.
 */
export interface OrderMarketContext {
  readonly market: Option.Option<OrderMarket>;
  readonly marketId: MarketId;
  readonly offeredProductIds: ReadonlySet<string>;
}
