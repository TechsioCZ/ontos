// The rows of a product's price history with variants. A history entry stores only the net price, so the price
// including VAT is known only for the price in force now (its stored gross); older rows show none rather than one
// invented from today's rate.
import { DateTime } from 'effect';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';

export interface PriceHistoryRow {
  readonly at: DateTime.Utc;
  /** The stored gross of the price in force now; absent for every earlier price. */
  readonly gross?: number;
  readonly key: string;
  readonly name: string;
  readonly net: number;
  readonly previous: number | undefined;
}

interface PricedSeries {
  readonly current: number;
  readonly history: ProductRecord['priceHistory'];
  readonly key: string;
  readonly name: string;
  readonly storedGross: number | undefined;
}

const rowsOf = (series: PricedSeries): readonly PriceHistoryRow[] =>
  series.history.map((entry, index) => {
    const row: PriceHistoryRow = {
      at: entry.effectiveFrom,
      key: `${series.key}-${index}`,
      name: series.name,
      net: entry.priceMinor,
      previous: entry.previousPriceMinor ?? series.history[index - 1]?.priceMinor,
    };
    const inForce = index === series.history.length - 1 && entry.priceMinor === series.current;
    return inForce && series.storedGross !== undefined ? { ...row, gross: series.storedGross } : row;
  });

/** Every variant's and the product's own price changes, newest first. */
export const priceHistoryRows = (product: ProductRecord): readonly PriceHistoryRow[] =>
  [
    ...(product.variantRecords ?? []).flatMap((variant) =>
      rowsOf({
        current: variant.priceMinor,
        history: variant.priceHistory,
        key: variant.id,
        name: `${variant.name} · ${variant.sku}`,
        storedGross: variant.grossPriceMinor,
      }),
    ),
    ...rowsOf({
      current: product.currentPriceMinor,
      history: product.priceHistory,
      key: 'product',
      name: `Základní cena produktu · ${product.sku}`,
      storedGross: product.grossPriceMinor,
    }),
  ].toSorted((left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at));
