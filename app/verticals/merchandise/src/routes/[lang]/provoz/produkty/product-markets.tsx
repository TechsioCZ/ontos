// Product detail "Trhy": the product's offer and gross price in every market the company has configured
// (merchandise market settings, DESIGN 3.2). The switches change only the draft; the tab's one Save button sends a
// SetProductMarketOffer for every market whose offer changed, so a live e-shop never changes on a click alone.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Table } from '@techsio/ui-kit/organisms/table';
import { ScrollRegion, SectionCard } from '@app/admin-ui';
import {
  Field,
  FormBuilder,
  FormReact,
  FormRoot,
  InputField,
  SwitchField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import type { ReactNode } from 'react';
import { MarketIdSchema } from '../../../../../shared/domain/market-offers.ts';
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
import { productVersionOf } from './products-api.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

/**
 * The offer of every market of the open product. A switch changes only this form; the tab's Save button sends it, so
 * the form itself is never submitted.
 */
const marketsForm = FormReact.make(
  FormBuilder.empty.addField(
    Field.makeArrayField('offers', Schema.Struct({ marketId: MarketIdSchema, offered: Schema.Boolean })),
  ),
  {
    // `marketId` names the market of a row and is never rendered.
    fields: { offers: { marketId: InputField, offered: SwitchField } },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** The form's offers as the tab's draft: one per market the product is shown in, in the markets' order. */
const offersOf = (
  markets: readonly ProductMarket[],
  offers: readonly { readonly marketId: string; readonly offered: boolean }[],
): readonly MarketOfferDraft[] =>
  markets.map(({ marketId, offered }) => ({
    marketId,
    offered: offers.find((entry) => entry.marketId === marketId)?.offered ?? offered,
  }));

export interface MarketsPanelViewProps {
  /** Market managers only (records `canManageMarkets`); everybody else sees the switches disabled. */
  readonly canManage: boolean;
  /** The form's footer (the Save button). */
  readonly footer?: ReactNode;
  readonly labels: MarketsLabels;
  /** The markets as the server has them; the switches show the offers of the form. */
  readonly markets: readonly ProductMarket[];
  /** The offers are being saved; every switch waits for it. */
  readonly saving: boolean;
}

/** One market's offer switch, labelled by the offer as the form has it. */
const OfferSwitch = ({
  disabled,
  labels,
  market,
}: {
  readonly disabled: boolean;
  readonly labels: MarketsLabels;
  readonly market: ProductMarket;
}) => {
  const offers = Option.match(useAtomValue(marketsForm.values), {
    onNone: () => [],
    onSome: (values) => values.offers,
  });
  const index = offers.findIndex((entry) => entry.marketId === market.marketId);
  if (index === -1) {
    return null;
  }
  return (
    <marketsForm.offers.Item index={index}>
      <marketsForm.offers.offered disabled={disabled} name={`market-offered-${market.marketCode}`}>
        {offers[index]?.offered === true ? labels.offered : labels.notOffered}
        <span className="sr-only">{` · ${market.marketCode}`}</span>
      </marketsForm.offers.offered>
    </marketsForm.offers.Item>
  );
};

/**
 * The offers form of the tab, opening with `markets` as the server has them. The tab renders inside it, so whatever
 * reads the form's values reads this product's.
 */
export const MarketsOffersForm = ({
  children,
  markets,
}: {
  readonly children: ReactNode;
  readonly markets: readonly ProductMarket[];
}) => {
  const { t } = useModernI18n();
  return (
    <FormRoot defaultValues={{ offers: marketOffersOf(markets) }} form={marketsForm} translateMessage={t}>
      {children}
    </FormRoot>
  );
};

/** The tab's table; it renders inside `MarketsOffersForm`. */
export const MarketsPanelView = ({ canManage, footer, labels, markets, saving }: MarketsPanelViewProps) => (
  <SectionCard flush title={labels.title}>
    {markets.length === 0 ? (
      <p className="px-200 py-200 text-fg-secondary text-sm">{labels.empty}</p>
    ) : (
      <ScrollRegion label={labels.title}>
        <Table appearance="line" size="sm">
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
                  <OfferSwitch disabled={!canManage || saving} labels={labels} market={market} />
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
  readonly product: Pick<ProductRecord, 'id' | 'updatedAt'>;
  readonly revision: number;
}

const key = (path: string) => `merchandise.pages.products.markets.${path}`;

const MarketsPanelForm = ({
  active = true,
  canManage,
  markets,
  onCommitted,
  onReload,
  product,
  revision,
}: MarketsPanelProps) => {
  const { t } = useModernI18n();
  const values = useAtomValue(marketsForm.values);
  const setValues = useAtomSet(marketsForm.setValues);
  const drafts = offersOf(markets, Option.match(values, { onNone: () => [], onSome: ({ offers }) => offers }));
  const save = useProductTabSave<readonly MarketOfferDraft[]>({
    commandOf: (value, confirmed) => marketOfferCommands(product.id, value, confirmed),
    isValid: () => true,
    keepAs: `markets:${product.id}`,
    onReload,
    onSaved: () => onCommitted(t(key('saved'))),
    reset: (offers) => setValues({ offers }),
    revision,
    server: marketOffersOf(markets),
    value: drafts,
    version: productVersionOf(product),
  });
  return (
    <MarketsPanelView
      canManage={canManage}
      {...(canManage && markets.length > 0 ? { footer: <ProductTabSaveBar active={active} save={save} /> } : {})}
      labels={marketsLabelsFrom((path) => t(key(path)))}
      markets={markets}
      saving={save.draft.status === 'saving'}
    />
  );
};

export const MarketsPanel = (props: MarketsPanelProps) => (
  <MarketsOffersForm markets={props.markets}>
    <MarketsPanelForm {...props} />
  </MarketsOffersForm>
);
