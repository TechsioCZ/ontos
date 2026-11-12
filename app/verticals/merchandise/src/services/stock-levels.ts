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
import type { SellableVatRates } from './tax-rates.ts';

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
    total += movement.delta;
    if (movement.variantId !== undefined) {
      variants.set(movement.variantId, (variants.get(movement.variantId) ?? 0) + movement.delta);
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
      onHand += movement.delta;
    }
  }
  return onHand;
};

/** Stock of one variant: the signed sum of its ledger movements. */
export const variantStockOf = (movements: readonly StockMovement[], productId: Product['id'], variantId: string) => {
  let onHand = 0;
  for (const movement of movements) {
    if (movement.productId === productId && movement.variantId === variantId) {
      onHand += movement.delta;
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
  if (input.stock <= 0) {
    return 'OUT_OF_STOCK';
  }
  return input.stock <= input.threshold ? 'LOW_STOCK' : 'IN_STOCK';
};

const availabilityRank = {
  IN_STOCK: 3,
  LOW_STOCK: 2,
  OUT_OF_STOCK: 0,
  UNKNOWN: 1,
} satisfies Readonly<Record<Availability, number>>;

export const realVariantsOf = (product: Product) => (product.variants ?? []).filter(isRealVariant);

/**
 * Gross unit price at the company's priced rate: the first tier, else net plus VAT. A classification that is not
 * sellable has no gross price at all, never a price at 0 %.
 */
const grossPriceOf = (net: number, tiers: Product['priceTiers'], rate: number | undefined) =>
  rate === undefined ? undefined : (tiers?.[0]?.priceMinor ?? grossUnitPriceMinor(net, rate));

const toVariantRecord = (
  product: Product,
  variant: ProductVariant & { readonly id: VariantRecord['id']; readonly priceMinor: number },
  stock: StockLevels,
  rate: number | undefined,
): VariantRecord => {
  const stockOnHand = stock.variants.get(variant.id) ?? 0;
  const active = product.active && variant.active !== false;
  const grossPriceMinor = grossPriceOf(variant.priceMinor, variant.priceTiers, rate);
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
 * Replenishment is a product-level policy: alert only below a positive product minimum.
 * Variant availability stays truthful even when the product is catalogue-only (minimum zero).
 * Products with real variants derive value, availability and the lowest active price from those variants.
 */
export const toProductRecord = (product: Product, stock: StockLevels, rates: SellableVatRates): ProductRecord => {
  const stockOnHand = stock.total;
  const rate = rates[product.taxClassificationCode];
  const variants = realVariantsOf(product).map((variant) => toVariantRecord(product, variant, stock, rate));
  if (variants.length === 0) {
    const grossPriceMinor = grossPriceOf(product.currentPriceMinor, product.priceTiers, rate);
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
  const variantStock = sumOf(variants, (variant) => variant.stockOnHand);
  const grossPrices = (sellable.length > 0 ? sellable : variants).flatMap((variant) =>
    variant.grossPriceMinor === undefined ? [] : [variant.grossPriceMinor],
  );
  const record: ProductRecord = {
    ...product,
    availability: product.active ? best : 'OUT_OF_STOCK',
    lowStock: product.lowStockThreshold > 0 && stockOnHand < product.lowStockThreshold,
    stockOnHand,
    stockValueMinor: Math.round(
      sumOf(variants, (variant) => variant.stockOnHand * variant.priceMinor) +
        (stockOnHand - variantStock) * product.currentPriceMinor,
    ),
    variantRecords: variants,
  };
  return grossPrices.length === 0 ? record : { ...record, grossPriceMinor: Math.min(...grossPrices) };
};

/** All product records of one state; movements are partitioned once so large catalogs stay linear. */
export const computeProductRecords = (state: MerchandiseState, rates: SellableVatRates): readonly ProductRecord[] => {
  const byProduct = new Map<string, StockMovement[]>();
  for (const movement of state.movements) {
    const bucket = byProduct.get(movement.productId) ?? [];
    bucket.push(movement);
    byProduct.set(movement.productId, bucket);
  }
  return state.products.map((product) =>
    toProductRecord(product, stockLevelsOf(byProduct.get(product.id) ?? [], product.id), rates),
  );
};
