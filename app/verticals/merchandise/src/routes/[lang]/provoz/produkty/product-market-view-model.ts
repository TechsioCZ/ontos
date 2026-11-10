import { formatMoney } from '@app/admin-ui';
import type { MarketId, ProductMarket } from '../../../../../shared/domain/market-offers.ts';
import type { ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductCommand } from './products-api.ts';

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

/** The offer of one market, as the draft of the tab keeps it. */
export interface MarketOfferDraft {
  readonly marketId: MarketId;
  readonly offered: boolean;
}

export const marketOffersOf = (markets: readonly ProductMarket[]): readonly MarketOfferDraft[] =>
  markets.map(({ marketId, offered }) => ({ marketId, offered }));

/**
 * One SetProductMarketOffer for every market whose offer the draft changed since the confirmed version. Each names
 * the offer the draft was read from (`expectedOffered`), so the server refuses it when someone changed that offer
 * in the meantime instead of overwriting their change.
 */
export const marketOfferCommands = (
  productId: ProductRecord['id'],
  draft: readonly MarketOfferDraft[],
  confirmed: readonly MarketOfferDraft[],
): readonly ProductCommand[] =>
  draft.flatMap(({ marketId, offered }) => {
    const read = confirmed.find((entry) => entry.marketId === marketId);
    if (read?.offered === offered) {
      return [];
    }
    const command = { _tag: 'SetProductMarketOffer', marketId, offered, productId } as const;
    return [(read === undefined ? command : { ...command, expectedOffered: read.offered }) satisfies ProductCommand];
  });
