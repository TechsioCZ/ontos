import { normalizeQuantity } from '../../shared/domain/order-quantity.ts';
// Stock levels and the derived product/variant record (availability, gross price, stock value). Pure; the
// store keeps the levels as columns, in-memory callers derive them from the movement ledger.
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { grossUnitPriceMinor, isRealVariant } from '../../shared/domain/merchandise-model.ts';
import type {
  Availability,
  Product,
  ProductRecord,
  ProductVariant,
  StockMovement,
  VariantRecord,
} from '../../shared/domain/merchandise-model.ts';
import { heldRateOf } from './tax-rates.ts';
import type { HeldProductRates, SellableVatRates } from './tax-rates.ts';

/** Stock on hand of one product: the ledger total and each variant's own sum. */
export interface StockLevels {
  readonly total: number;
  readonly variants: ReadonlyMap<string, number>;
}

/** Levels of one product from its ledger movements (other products' movements are ignored). */
export const stockLevelsOf = (movements: readonly StockMovement[], productId: string): StockLevels => {
  let total = 0;
  const variants = new Map<string, number>();
  for (const movement of movements) {
    if (movement.productId !== productId) {
      continue;
    }
    total = normalizeQuantity(total + movement.delta);
    if (movement.variantId !== undefined) {
      variants.set(movement.variantId, normalizeQuantity((variants.get(movement.variantId) ?? 0) + movement.delta));
    }
  }
  return { total, variants };
};

export const sumOf = <T>(items: readonly T[], amount: (item: T) => number) => {
  let total = 0;
  for (const item of items) {
    total += amount(item);
  }
  return total;
};

/** Stock on hand is the signed sum of the ledger. Negative values are a bug the command logic must prevent. */
export const stockOnHandOf = (movements: readonly StockMovement[], productId: Product['id']) => {
  let onHand = 0;
  for (const movement of movements) {
    if (movement.productId === productId) {
      onHand = normalizeQuantity(onHand + movement.delta);
    }
  }
  return onHand;
};

/** Stock of one variant: the signed sum of its ledger movements. */
export const variantStockOf = (movements: readonly StockMovement[], productId: Product['id'], variantId: string) => {
  let onHand = 0;
  for (const movement of movements) {
    if (movement.productId === productId && movement.variantId === variantId) {
      onHand = normalizeQuantity(onHand + movement.delta);
    }
  }
  return onHand;
};

/** Availability for a sellable unit. Untracked stock is UNKNOWN (never silently „skladem“). */
export const availabilityOf = (input: {
  readonly active: boolean;
  readonly stock: number;
  readonly stockTracked: boolean;
  readonly threshold: number;
}): Availability => {
  if (!input.active) {
    return 'OUT_OF_STOCK';
  }
  if (!input.stockTracked) {
    return 'UNKNOWN';
  }
  const stock = normalizeQuantity(input.stock);
  if (stock <= 0) {
    return 'OUT_OF_STOCK';
  }
  return stock <= input.threshold ? 'LOW_STOCK' : 'IN_STOCK';
};

const availabilityRank = {
  IN_STOCK: 3,
  LOW_STOCK: 2,
  OUT_OF_STOCK: 0,
  UNKNOWN: 1,
} satisfies Readonly<Record<Availability, number>>;

export const realVariantsOf = (product: Product) => (product.variants ?? []).filter(isRealVariant);

/**
 * Gross unit price as stored: the first tier, else the stored gross entered with the price. Only a price stored without
 * one (data from before stored gross prices) is derived, net plus VAT at the rate Tax gives the classification now; a
 * classification that is not sellable then has no gross price, never one at 0 %.
 */
interface GrossPriced {
  readonly grossPriceMinor?: number | undefined;
  readonly priceTiers?: Product['priceTiers'];
}

/** The gross unit price as stored (first tier, else the stored gross); `undefined` when none is stored. */
export const storedGrossOf = (priced: GrossPriced) => priced.priceTiers?.[0]?.priceMinor ?? priced.grossPriceMinor;

export const grossPriceOf = (priced: GrossPriced, net: number, rate: number | undefined) =>
  storedGrossOf(priced) ?? (rate === undefined ? undefined : grossUnitPriceMinor(net, rate));

const toVariantRecord = (
  product: Product,
  variant: ProductVariant & { readonly id: VariantRecord['id']; readonly priceMinor: number },
  stock: StockLevels,
  rate: number | undefined,
): VariantRecord => {
  const stockOnHand = normalizeQuantity(stock.variants.get(variant.id) ?? 0);
  const active = product.active && variant.active !== false;
  const grossPriceMinor = grossPriceOf(variant, variant.priceMinor, rate);
  const record: VariantRecord = {
    ...variant,
    active: variant.active !== false,
    attributes: variant.attributes,
    availability: availabilityOf({
      active,
      stock: stockOnHand,
      stockTracked: product.stockTracked !== false,
      threshold: product.lowStockThreshold,
    }),
    id: variant.id,
    name: variant.name,
    priceHistory: variant.priceHistory ?? [],
    priceMinor: variant.priceMinor,
    sku: variant.sku ?? `${product.sku}-${variant.id}`,
    stockOnHand,
    unit: variant.unit ?? variant.sourceUnit ?? product.unit,
  };
  return grossPriceMinor === undefined ? record : { ...record, grossPriceMinor };
};

/**
 * The one rate a product's prices use: its held rate while it has one (a reduced product migrated at 10 % keeps
 * selling at 10 % until Tax first prices its company), otherwise the rate its classification sells at. The displayed gross, the
 * label and an order line all take this rate.
 */
export const productRateOf = (
  product: Pick<Product, 'id' | 'taxClassificationCode'>,
  rates: SellableVatRates,
  held: HeldProductRates,
): number | undefined => heldRateOf(held, product) ?? rates[product.taxClassificationCode];

/**
 * Replenishment is a product-level policy: alert only below a positive product minimum.
 * Variant availability stays truthful even when the product is catalogue-only (minimum zero).
 * Products with real variants derive value, availability and the lowest active price from those variants.
 * A price stored without its gross gets one at the product's rate ({@link productRateOf}).
 */
export const toProductRecord = (
  product: Product,
  stock: StockLevels,
  rates: SellableVatRates,
  held: HeldProductRates,
): ProductRecord => {
  const stockOnHand = normalizeQuantity(stock.total);
  const rate = productRateOf(product, rates, held);
  const variants = realVariantsOf(product).map((variant) => toVariantRecord(product, variant, stock, rate));
  if (variants.length === 0) {
    const grossPriceMinor = grossPriceOf(product, product.currentPriceMinor, rate);
    const record: ProductRecord = {
      ...product,
      availability: availabilityOf({
        active: product.active,
        stock: stockOnHand,
        stockTracked: product.stockTracked !== false,
        threshold: product.lowStockThreshold,
      }),
      lowStock: product.lowStockThreshold > 0 && stockOnHand < product.lowStockThreshold,
      stockOnHand,
      stockValueMinor: Math.round(stockOnHand * product.currentPriceMinor),
    };
    return grossPriceMinor === undefined ? record : { ...record, grossPriceMinor };
  }
  const sellable = variants.filter((variant) => variant.active);
  let best: Availability = 'OUT_OF_STOCK';
  for (const variant of sellable) {
    if (availabilityRank[variant.availability] > availabilityRank[best]) {
      best = variant.availability;
    }
  }
  const variantStock = normalizeQuantity(sumOf(variants, (variant) => variant.stockOnHand));
  const grossPrices = (sellable.length > 0 ? sellable : variants).flatMap((variant) =>
    variant.grossPriceMinor === undefined ? [] : [variant.grossPriceMinor],
  );
  // A product with variants sells only at its variants' prices: its price including VAT is their lowest, or none when
  // no variant has one yet; never a gross stored on the product itself.
  const { grossPriceMinor: _own, ...unpriced } = product;
  void _own;
  const record: ProductRecord = {
    ...unpriced,
    availability: product.active ? best : 'OUT_OF_STOCK',
    lowStock: product.lowStockThreshold > 0 && stockOnHand < product.lowStockThreshold,
    stockOnHand,
    stockValueMinor: Math.round(
      sumOf(variants, (variant) => variant.stockOnHand * variant.priceMinor) +
        normalizeQuantity(stockOnHand - variantStock) * product.currentPriceMinor,
    ),
    variantRecords: variants,
  };
  return grossPrices.length === 0 ? record : { ...record, grossPriceMinor: Math.min(...grossPrices) };
};

/** All product records of one state; movements are partitioned once so large catalogs stay linear. */
export const computeProductRecords = (
  state: MerchandiseState,
  rates: SellableVatRates,
  held: HeldProductRates,
): readonly ProductRecord[] => {
  const byProduct = new Map<string, StockMovement[]>();
  for (const movement of state.movements) {
    const bucket = byProduct.get(movement.productId) ?? [];
    bucket.push(movement);
    byProduct.set(movement.productId, bucket);
  }
  return state.products.map((product) =>
    toProductRecord(product, stockLevelsOf(byProduct.get(product.id) ?? [], product.id), rates, held),
  );
};
