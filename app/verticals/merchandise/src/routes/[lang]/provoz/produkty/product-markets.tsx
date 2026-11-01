// Product detail "Trhy": the product's offer and gross price in every market the company has configured
// (merchandise market settings, DESIGN 3.2). One switch per market runs SetProductMarketOffer.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Table } from '@techsio/ui-kit/organisms/table';
import { formatMoney, ScrollRegion, SectionCard } from '@app/admin-ui';
import { useState } from 'react';
import type { MarketId, ProductMarket } from '../../../../../shared/domain/market-offers.ts';
import type { ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import { runCommand } from './products-api.ts';
import { useCommandFailure } from './product-forms.tsx';

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

export interface MarketsPanelViewProps {
  /** Catalog managers only (records `canManageCatalog`); everybody else sees the switches disabled. */
  readonly canManage: boolean;
  readonly error: string | null;
  readonly labels: MarketsLabels;
  readonly markets: readonly ProductMarket[];
  readonly onToggle: (market: ProductMarket, offered: boolean) => void;
  /** The market whose offer is being saved; every switch waits for it. */
  readonly pendingMarketId: MarketId | null;
}

export const MarketsPanelView = ({
  canManage,
  error,
  labels,
  markets,
  onToggle,
  pendingMarketId,
}: MarketsPanelViewProps) => (
  <SectionCard flush title={labels.title}>
    {markets.length === 0 ? (
      <p className="px-200 py-200 text-fg-secondary text-sm">{labels.empty}</p>
    ) : (
      <ScrollRegion label={labels.title}>
        <Table size="sm" variant="line">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>{labels.market}</Table.ColumnHeader>
              <Table.ColumnHeader>{labels.currency}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">{labels.price}</Table.ColumnHeader>
              <Table.ColumnHeader>{labels.offer}</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {markets.map((market) => (
              <Table.Row key={market.marketId}>
                <Table.Cell className="whitespace-nowrap font-medium">{market.marketCode}</Table.Cell>
                <Table.Cell>{market.currency}</Table.Cell>
                <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                  {marketPriceText(market, labels.noPrice)}
                </Table.Cell>
                <Table.Cell>
                  <Switch
                    checked={market.offered}
                    disabled={!canManage || pendingMarketId !== null}
                    name={`market-offered-${market.marketCode}`}
                    onCheckedChange={(checked: boolean) => onToggle(market, checked)}
                  >
                    {market.offered ? labels.offered : labels.notOffered}
                    <span className="sr-only">{` · ${market.marketCode}`}</span>
                  </Switch>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </ScrollRegion>
    )}
    {error !== null && (
      <StatusText showIcon status="error">
        {error}
      </StatusText>
    )}
  </SectionCard>
);

export interface MarketsPanelProps {
  readonly canManage: boolean;
  readonly markets: readonly ProductMarket[];
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: Pick<ProductRecord, 'id'>;
  readonly revision: number;
}

const key = (path: string) => `merchandise.pages.products.markets.${path}`;

export const MarketsPanel = ({ canManage, markets, onCommitted, onReload, product, revision }: MarketsPanelProps) => {
  const { t } = useModernI18n();
  const failure = useCommandFailure();
  const [pendingMarketId, setPendingMarketId] = useState<MarketId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (market: ProductMarket, offered: boolean) => {
    setPendingMarketId(market.marketId);
    setError(null);
    runCommand(
      { _tag: 'SetProductMarketOffer', marketId: market.marketId, offered, productId: product.id },
      revision,
      (outcome) => {
        setPendingMarketId(null);
        if (outcome.ok) {
          // The committed callback reads the product again, so the switch shows the stored offer.
          onCommitted(t(key(offered ? 'offeredSaved' : 'withdrawnSaved'), { code: market.marketCode }));
          return;
        }
        setError(failure(outcome.reason, onReload));
      },
    );
  };
  return (
    <MarketsPanelView
      canManage={canManage}
      error={error}
      labels={marketsLabelsFrom((path) => t(key(path)))}
      markets={markets}
      onToggle={toggle}
      pendingMarketId={pendingMarketId}
    />
  );
};
