// Per-market product offer and price list of the demo catalog (DESIGN 3.2). Merchandise stores only the opaque
// commerce market reference (`marketId`) and a code snapshot; the market itself is owned by commerce.market-catalog.
// Prices are a conversion of the CZK gross price: round_half_up(grossCZK × rate / rounding) × rounding, computed
// with exact decimal arithmetic in the market currency's minor units.
import { Option, Schema } from 'effect';

/** Opaque reference to a `commerce.market-catalog.market` resource of the same tenant. Never joined here. */
export const MarketIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('MerchandiseMarketId'));
export type MarketId = typeof MarketIdSchema.Type;

/** Snapshot of the market code shown in staff screens and orders. */
export const MarketCodeSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** WHOLE_CATALOGUE offers every published product except `offered: false`; SELECTED_PRODUCTS only `offered: true`. */
export const MarketOfferModeSchema = Schema.Literals(['WHOLE_CATALOGUE', 'SELECTED_PRODUCTS']);
export type MarketOfferMode = typeof MarketOfferModeSchema.Type;

export const MarketCurrencySchema = Schema.Literals(['CZK', 'EUR', 'PLN']);
export type MarketCurrency = typeof MarketCurrencySchema.Type;

const EXCHANGE_RATE_PATTERN = /^[0-9]{1,6}(?:\.[0-9]{1,8})?$/u;

/** Drops trailing fractional zeros and leading integer zeros: `"0.0400"` → `"0.04"`, `"001.50"` → `"1.5"`. */
export const normalizeExchangeRate = (value: string): string => {
  const [whole = '0', fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+(?=[0-9])/u, '');
  const decimals = fraction.replace(/0+$/u, '');
  return decimals === '' ? integer : `${integer}.${decimals}`;
};

/** Gross CZK × rate = gross market price. A positive decimal string with at most 8 decimals, stored normalized. */
export const ExchangeRateSchema = Schema.Trim.check(
  Schema.isPattern(EXCHANGE_RATE_PATTERN),
  Schema.makeFilter((value: string) =>
    /[1-9]/u.test(value) ? undefined : 'The exchange rate must be greater than zero',
  ),
);

/** Rounding step in minor units of the market currency (10 = 0.10 €). */
export const RoundingMinorSchema = Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 1 }));

export const MarketExceptionCountsSchema = Schema.Struct({
  notOffered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  offered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const MarketSettingsSchema = Schema.Struct({
  currency: MarketCurrencySchema,
  exceptionCounts: MarketExceptionCountsSchema,
  exchangeRate: ExchangeRateSchema,
  marketCode: Schema.String,
  marketId: MarketIdSchema,
  offerMode: MarketOfferModeSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  roundingMinor: RoundingMinorSchema,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type MarketSettings = typeof MarketSettingsSchema.Type;

/** Product detail: the product's offer and price in one configured market of the company. */
export const ProductMarketSchema = Schema.Struct({
  currency: MarketCurrencySchema,
  grossPriceMinor: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  marketCode: Schema.String,
  marketId: MarketIdSchema,
  offered: Schema.Boolean,
});
export type ProductMarket = typeof ProductMarketSchema.Type;

/** Storefront responses: which market the prices are in. `configured: false` = unknown market, no products. */
export const StorefrontMarketSchema = Schema.Struct({
  configured: Schema.Boolean,
  currency: MarketCurrencySchema,
  marketCode: Schema.optionalKey(Schema.String),
  marketId: MarketIdSchema,
});
export type StorefrontMarket = typeof StorefrontMarketSchema.Type;

/** Market snapshot on a storefront order; its amounts are in `currency`. Orders without it are CZK. */
export const OrderMarketSchema = Schema.Struct({
  currency: MarketCurrencySchema,
  exchangeRate: ExchangeRateSchema,
  marketCode: Schema.String,
  marketId: MarketIdSchema,
  roundingMinor: RoundingMinorSchema,
});
export type OrderMarket = typeof OrderMarketSchema.Type;

/** Currency of amounts priced with an optional market (no market: CZK). */
export const currencyOf = (market: Pick<OrderMarket, 'currency'> | undefined): MarketCurrency =>
  market?.currency ?? 'CZK';

const currencySymbols = { CZK: 'Kč', EUR: '€', PLN: 'zł' } satisfies Readonly<Record<MarketCurrency, string>>;

/** Czech text of an amount (order history, storefront issue messages): `1 290 Kč`, `5,20 €`. */
export const formatMarketMoney = (minor: number, currency: MarketCurrency = 'CZK'): string =>
  `${(minor / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2, minimumFractionDigits: minor % 100 === 0 ? 0 : 2 })} ${currencySymbols[currency]}`;

/** The price list part of a market: everything a price conversion needs. */
export interface MarketPricing {
  readonly currency: MarketCurrency;
  readonly exchangeRate: string;
  readonly roundingMinor: number;
}

/** Default offer of a product without an exception. */
export const offeredByDefault = (mode: MarketOfferMode): boolean => mode === 'WHOLE_CATALOGUE';

/** Whether a product is offered: its stored exception when one exists, else the mode default. */
export const isOfferedInMarket = (mode: MarketOfferMode, exception: Option.Option<boolean>): boolean =>
  Option.getOrElse(exception, () => offeredByDefault(mode));

/** Whether `offered` must be stored as an exception (it differs from the mode default). */
export const isMarketException = (mode: MarketOfferMode, offered: boolean): boolean =>
  offered !== offeredByDefault(mode);

/** `rate = numerator / 10^scale` as exact integers. */
const rateParts = (rate: string) => {
  const [whole = '0', fraction = ''] = rate.split('.');
  return { denominator: 10n ** BigInt(fraction.length), numerator: BigInt(`${whole}${fraction}`) };
};

/** floor(a / b) for b > 0 and any a. */
const floorDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? a / b : -((-a + b - 1n) / b));
const ceilDiv = (a: bigint, b: bigint): bigint => -floorDiv(-a, b);

/** Gross CZK minor → market currency minor, rounded half-up to `roundingMinor`. CZK × 1 / 1 is the identity. */
export const convertGrossMinor = (grossCzkMinor: number, pricing: Omit<MarketPricing, 'currency'>): number => {
  const { denominator, numerator } = rateParts(pricing.exchangeRate);
  const step = BigInt(pricing.roundingMinor);
  const scaled = BigInt(grossCzkMinor) * numerator;
  const unit = denominator * step;
  // round_half_up(scaled / unit) = floor((2 × scaled + unit) / (2 × unit))
  const steps = floorDiv(2n * scaled + unit, 2n * unit);
  return Number(steps * step);
};

/** Storefront price filter bounds in minor units (`minMinor`/`maxMinor` of the storefront catalog query). */
export interface MarketPriceBounds {
  readonly maxMinor?: number;
  readonly minMinor?: number;
}
type WritablePriceBounds = { -readonly [Key in keyof MarketPriceBounds]: MarketPriceBounds[Key] };

/**
 * CZK gross bounds equivalent to market-currency price bounds, so storefront filters stay on the indexed CZK column.
 * `convertGrossMinor` is non-decreasing, so `convert(g) >= min ⟺ g >= minimum` and `convert(g) <= max ⟺ g <= maximum`.
 */
export const czkBoundsForMarket = (
  bounds: MarketPriceBounds,
  pricing: Omit<MarketPricing, 'currency'>,
): MarketPriceBounds => {
  const { denominator, numerator } = rateParts(pricing.exchangeRate);
  const step = BigInt(pricing.roundingMinor);
  // convert(g) = round_half_up(g × n / (d × r)) × r; with x = g × n / (d × r):
  // convert(g) >= min ⟺ round(x) >= k, k = ceil(min / r) ⟺ x >= k - ½ ⟺ g >= (2k - 1) × d × r / (2n)
  // convert(g) <= max ⟺ round(x) <= m, m = floor(max / r) ⟺ x < m + ½ ⟺ g < (2m + 1) × d × r / (2n)
  const lower = (minMinor: number) => {
    const k = ceilDiv(BigInt(minMinor), step);
    const minimum = ceilDiv((2n * k - 1n) * denominator * step, 2n * numerator);
    return Number(minimum < 0n ? 0n : minimum);
  };
  const upper = (maxMinor: number) => {
    const m = floorDiv(BigInt(maxMinor), step);
    return Number(ceilDiv((2n * m + 1n) * denominator * step, 2n * numerator) - 1n);
  };
  const result: WritablePriceBounds = {};
  if (bounds.minMinor !== undefined) {
    result.minMinor = lower(bounds.minMinor);
  }
  if (bounds.maxMinor !== undefined) {
    result.maxMinor = upper(bounds.maxMinor);
  }
  return result;
};
