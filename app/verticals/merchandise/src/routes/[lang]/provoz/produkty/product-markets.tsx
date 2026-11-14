// Product detail "Trhy": the product's offer and gross price in every market the company has configured
// (merchandise market settings, DESIGN 3.2). The switches change only the draft; the tab's one Save button sends a
// SetProductMarketOffer for every market whose offer changed, so a live e-shop never changes on a click alone.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Table } from '@techsio/ui-kit/organisms/table';
import { ScrollRegion, SectionCard } from '@app/admin-ui';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { ProductMarket } from '../../../../../shared/domain/market-offers.ts';
import type { ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import {
  marketOfferCommands,
  marketOffersOf,
  marketPriceText,
  marketsLabelsFrom,
} from './product-market-view-model.ts';
import type { MarketOfferDraft, MarketsLabels } from './product-market-view-model.ts';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';

export interface MarketsPanelViewProps {
  /** Market managers only (records `canManageMarkets`); everybody else sees the switches disabled. */
  readonly canManage: boolean;
  /** The form's footer (the Save button). */
  readonly footer?: ReactNode;
  readonly labels: MarketsLabels;
  /** The markets with the offer as the draft has it. */
  readonly markets: readonly ProductMarket[];
  readonly onToggle: (market: ProductMarket, offered: boolean) => void;
  /** The offers are being saved; every switch waits for it. */
  readonly saving: boolean;
}

export const MarketsPanelView = ({ canManage, footer, labels, markets, onToggle, saving }: MarketsPanelViewProps) => (
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
                    disabled={!canManage || saving}
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
    {footer !== undefined && <div className="px-200 py-200">{footer}</div>}
  </SectionCard>
);

export interface MarketsPanelProps {
  readonly active?: boolean;
  readonly canManage: boolean;
  readonly markets: readonly ProductMarket[];
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: Pick<ProductRecord, 'id'>;
  readonly revision: number;
}

const key = (path: string) => `merchandise.pages.products.markets.${path}`;

export const MarketsPanel = ({
  active = true,
  canManage,
  markets,
  onCommitted,
  onReload,
  product,
  revision,
}: MarketsPanelProps) => {
  const { t } = useModernI18n();
  const [drafts, setDrafts] = useState(() => marketOffersOf(markets));
  const save = useProductTabSave<readonly MarketOfferDraft[]>({
    commandOf: (value, confirmed) => marketOfferCommands(product.id, value, confirmed),
    isValid: () => true,
    onReload,
    onSaved: () => onCommitted(t(key('saved'))),
    reset: setDrafts,
    revision,
    server: marketOffersOf(markets),
    value: drafts,
  });
  const shown = markets.map((market) => ({
    ...market,
    offered: drafts.find((entry) => entry.marketId === market.marketId)?.offered ?? market.offered,
  }));
  const toggle = (market: ProductMarket, offered: boolean) => {
    setDrafts((current) =>
      current.map((entry) => (entry.marketId === market.marketId ? { ...entry, offered } : entry)),
    );
  };
  return (
    <MarketsPanelView
      canManage={canManage}
      {...(canManage && markets.length > 0 ? { footer: <ProductTabSaveBar active={active} save={save} /> } : {})}
      labels={marketsLabelsFrom((path) => t(key(path)))}
      markets={shown}
      onToggle={toggle}
      saving={save.draft.status === 'saving'}
    />
  );
};
