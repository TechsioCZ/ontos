import { formatMoney } from '@app/admin-ui';
import type { ProductMarket } from '../../../../../shared/domain/market-offers.ts';

/** The texts of the section, one per locale key under `merchandise.pages.products.markets`. */
export interface MarketsLabels {
  readonly currency: string;
  readonly empty: string;
  readonly market: string;
  readonly noPrice: string;
  readonly notOffered: string;
  readonly offer: string;
  readonly offered: string;
  readonly price: string;
  readonly title: string;
}

/** The section texts read through one locale lookup (`path` is relative to the markets keys). */
export const marketsLabelsFrom = (text: (path: string) => string): MarketsLabels => ({
  currency: text('columns.currency'),
  empty: text('empty'),
  market: text('columns.market'),
  noPrice: text('noPrice'),
  notOffered: text('notOffered'),
  offer: text('columns.offered'),
  offered: text('offered'),
  price: text('columns.price'),
  title: text('title'),
});

/** Gross price text of one market row; a product without a price shows that instead of 0. */
export const marketPriceText = (market: ProductMarket, missing: string): string =>
  market.grossPriceMinor === undefined ? missing : formatMoney(market.grossPriceMinor, market.currency);
