// The rows of a product's price history with variants. A history entry stores only the net price; every row shows
// the price including VAT at the VAT rate of the price in force now (its stored gross), the in-force row that gross.
import { DateTime } from 'effect';
import { grossUnitPriceMinor } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';

export interface PriceHistoryRow {
  readonly at: DateTime.Utc;
  /** The price including VAT: the stored gross in force now, earlier prices at the same VAT rate. */
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
    if (series.storedGross === undefined || series.current <= 0) {
      return row;
    }
    if (entry.priceMinor === series.current) {
      return { ...row, gross: series.storedGross };
    }
    const vatRate = Math.round(((series.storedGross - series.current) * 100) / series.current);
    return { ...row, gross: grossUnitPriceMinor(entry.priceMinor, vatRate) };
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
