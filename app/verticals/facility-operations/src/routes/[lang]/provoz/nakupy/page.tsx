import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
// Facility operations — Sklad a nákupy (S05 sklad a zásoby, S06 nabídky dodavatelů a nákupní objednávky).
// OWNED BY THE `purchasing` LANE (ops-purchasing). Data: one governed records read of agenda `purchasing`,
// every change through the apply-command Action (shared/commands/purchasing.ts).
import { PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Option, Schema, SchemaGetter } from 'effect';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useState } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { RunCommand } from './purchasing-model.ts';
import type { PurchasingState, SalesQuote } from '../../../../../shared/domain/purchasing.ts';
import {
  OPEN_ORDER_STATUSES,
  materialPlanOf,
  orderOpenValueMinor,
} from '../../../../../shared/domain/purchasing-stock.ts';
import { AgendaFrame, AgendaGate } from '../../../../ui/agenda-frame.tsx';
import { preloadAgendaRecords, useAgendaRecords } from '../../../../ui/use-agenda.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { ItemCreatePanel, PurchaseDocumentPanel, SupplierPanel } from './order-forms.tsx';
import type { DraftLine } from './order-forms.tsx';
import { OrderPanel, OrdersTab } from './orders-tab.tsx';
import { MovementsTab, QuotePanel, QuotesTab, ReplenishTab, SuppliersTab } from './other-tabs.tsx';
import { formatAmount, todayIso, usePurchasingT } from './purchasing-model.ts';
import { SalesOrderPanel, SalesQuoteFormPanel, SalesQuotePanel, SalesTab } from './sales-tab.tsx';
import { ItemPanel, StockTab } from './stock-tab.tsx';

const tabs = ['stock', 'replenish', 'orders', 'quotes', 'sales', 'movements', 'suppliers'] as const;
type Tab = (typeof tabs)[number];
const panelKinds = {
  createItem: 'create-item',
  createOrder: 'create-order',
  createQuote: 'create-quote',
  createSupplier: 'create-supplier',
  item: 'item',
  order: 'order',
  quote: 'quote',
  salesOrder: 'sales-order',
  salesQuote: 'sales-quote',
  salesQuoteForm: 'sales-quote-form',
} as const;
const tabContentClassName = 'py-200';
type Panel =
  | { readonly id: string; readonly kind: typeof panelKinds.item }
  | { readonly id: string; readonly kind: typeof panelKinds.order }
  | { readonly id: string; readonly kind: typeof panelKinds.quote }
  | {
      readonly kind: typeof panelKinds.createOrder;
      readonly lines?: readonly DraftLine[];
      readonly supplierId?: string;
    }
  | { readonly kind: typeof panelKinds.createQuote }
  | { readonly kind: typeof panelKinds.createItem }
  | { readonly kind: typeof panelKinds.createSupplier }
  | { readonly id: string; readonly kind: typeof panelKinds.salesQuote }
  | { readonly id: string; readonly kind: typeof panelKinds.salesOrder }
  | { readonly kind: typeof panelKinds.salesQuoteForm; readonly quote?: SalesQuote };

const Stats = ({ state }: { readonly state: PurchasingState }) => {
  const k = usePurchasingT();
  const today = todayIso();
  const plans = state.items.map((item) => materialPlanOf(state, item, today));
  const below = plans.filter((plan) => plan.level === 'below_minimum').length;
  const above = plans.filter((plan) => plan.level === 'above_maximum').length;
  const open = state.orders.filter((order) => OPEN_ORDER_STATUSES.has(order.status));
  const openValue = open.reduce((sum, order) => sum + orderOpenValueMinor(order), 0);
  const quotes = state.quotes.filter((quote) => quote.status === 'received').length;
  return (
    <StatRow>
      <StatCard
        hint={k('stats.warehouses', { count: state.warehouses.length })}
        label={k('stats.items')}
        value={formatNumber(state.items.length)}
      />
      <StatCard hint={k('stats.aboveMax', { count: above })} label={k('stats.belowMin')} value={formatNumber(below)} />
      <StatCard
        hint={k('stats.openValue', { value: formatAmount(openValue) })}
        label={k('stats.openOrders')}
        value={formatNumber(open.length)}
      />
      <StatCard
        hint={k('stats.drafts', { count: state.orders.filter((order) => order.status === 'draft').length })}
        label={k('stats.quotes')}
        value={formatNumber(quotes)}
      />
    </StatRow>
  );
};

interface PurchasingNavigationProps {
  readonly canWrite: boolean;
  readonly me: PrincipalRef | undefined;
  readonly openItem: (id: string) => void;
  readonly openOrder: (id: string) => void;
  readonly openQuote: (id: string) => void;
  readonly setPanel: (panel: Panel | undefined) => void;
  readonly state: PurchasingState;
}
interface PurchasingTabsProps extends PurchasingNavigationProps {
  readonly financeRefresh: number;
  readonly setTab: (tab: Tab) => void;
  readonly suggestions: number;
  readonly tab: Tab;
}
const PurchasingTabs = ({
  canWrite,
  financeRefresh,
  me,
  openItem,
  openOrder,
  openQuote,
  setPanel,
  setTab,
  state,
  suggestions,
  tab,
}: PurchasingTabsProps) => {
  const k = usePurchasingT();
  return (
    <Tabs
      onValueChange={(value) => {
        const nextTab = tabs.find((candidate) => candidate === value);
        if (nextTab !== undefined) {
          setTab(nextTab);
        }
      }}
      size="sm"
      value={tab}
      variant="line"
    >
      <div className="max-w-full overflow-x-auto">
        <Tabs.List className="min-w-max">
          <Tabs.Trigger value="stock">{k('tabs.stock')}</Tabs.Trigger>
          <Tabs.Trigger value="replenish">
            <span className="flex items-center gap-100">
              {k('tabs.replenish')}
              {suggestions > 0 && (
                <Badge size="sm" variant="warning">
                  {String(suggestions)}
                </Badge>
              )}
            </span>
          </Tabs.Trigger>
          <Tabs.Trigger value="orders">{k('tabs.orders')}</Tabs.Trigger>
          <Tabs.Trigger value="quotes">{k('tabs.quotes')}</Tabs.Trigger>
          <Tabs.Trigger value="sales">{k('tabs.sales')}</Tabs.Trigger>
          <Tabs.Trigger value="movements">{k('tabs.movements')}</Tabs.Trigger>
          <Tabs.Trigger value="suppliers">{k('tabs.suppliers')}</Tabs.Trigger>
          <Tabs.Indicator />
        </Tabs.List>
      </div>
      <Tabs.Content className={tabContentClassName} value="stock">
        <StockTab onOpen={openItem} state={state} />
      </Tabs.Content>
      <Tabs.Content className={tabContentClassName} value="replenish">
        <ReplenishTab
          canWrite={canWrite}
          onDraftOrder={(supplierId, lines) =>
            setPanel({ kind: panelKinds.createOrder, lines, ...optionalField('supplierId', supplierId) })
          }
          onOpenItem={openItem}
          state={state}
        />
      </Tabs.Content>
      <Tabs.Content className={tabContentClassName} value="orders">
        <OrdersTab financeRefresh={financeRefresh} onOpen={openOrder} state={state} />
      </Tabs.Content>
      <Tabs.Content className={tabContentClassName} value="quotes">
        <QuotesTab onOpen={openQuote} state={state} />
      </Tabs.Content>
      <Tabs.Content className={tabContentClassName} value="sales">
        <SalesTab
          canWrite={canWrite}
          onNewQuote={() => setPanel({ kind: panelKinds.salesQuoteForm })}
          onOpenOrder={(id) => setPanel({ id, kind: panelKinds.salesOrder })}
          onOpenQuote={(id) => setPanel({ id, kind: panelKinds.salesQuote })}
          state={state}
        />
      </Tabs.Content>
      <Tabs.Content className={tabContentClassName} value="movements">
        <MovementsTab me={me} onOpenOrder={openOrder} state={state} />
      </Tabs.Content>
      <Tabs.Content className={tabContentClassName} value="suppliers">
        <SuppliersTab state={state} />
      </Tabs.Content>
    </Tabs>
  );
};

interface PurchasingPanelsProps extends PurchasingNavigationProps {
  readonly close: () => void;
  readonly onInvoiceCreated: () => void;
  readonly panel: Panel | undefined;
  readonly run: RunCommand;
}
const PurchasingPanels = ({
  canWrite,
  close,
  me,
  onInvoiceCreated,
  openItem,
  openOrder,
  openQuote,
  panel,
  run,
  setPanel,
  state,
}: PurchasingPanelsProps) => {
  if (panel === undefined) {
    return null;
  }
  return (
    <>
      {panel.kind === panelKinds.item && (
        <ItemPanel
          canWrite={canWrite}
          itemId={panel.id}
          me={me}
          onClose={close}
          onOpenOrder={openOrder}
          run={run}
          state={state}
        />
      )}
      {panel.kind === panelKinds.order && (
        <OrderPanel
          canWrite={canWrite}
          key={panel.id}
          me={me}
          onClose={close}
          onInvoiceCreated={onInvoiceCreated}
          onOpenItem={openItem}
          onOpenQuote={openQuote}
          orderId={panel.id}
          run={run}
          state={state}
        />
      )}
      {panel.kind === panelKinds.quote && (
        <QuotePanel
          canWrite={canWrite}
          key={panel.id}
          onClose={close}
          onOpenOrder={openOrder}
          quoteId={panel.id}
          run={run}
          state={state}
        />
      )}
      {(panel.kind === panelKinds.createOrder || panel.kind === panelKinds.createQuote) && (
        <PurchaseDocumentPanel
          kind={panel.kind === panelKinds.createOrder ? 'order' : 'quote'}
          onClose={close}
          onCreated={(id) => (panel.kind === panelKinds.createOrder ? openOrder(id) : openQuote(id))}
          run={run}
          state={state}
          {...optionalField('initialLines', panel.kind === panelKinds.createOrder ? panel.lines : undefined)}
          {...optionalField('initialSupplierId', panel.kind === panelKinds.createOrder ? panel.supplierId : undefined)}
        />
      )}
      {panel.kind === panelKinds.createItem && (
        <ItemCreatePanel onClose={close} onCreated={openItem} run={run} state={state} />
      )}
      {panel.kind === panelKinds.createSupplier && <SupplierPanel onClose={close} run={run} />}
      {panel.kind === panelKinds.salesQuoteForm && (
        <SalesQuoteFormPanel
          onClose={close}
          onSaved={(id) => setPanel({ id, kind: panelKinds.salesQuote })}
          run={run}
          {...optionalField('quote', panel.quote)}
        />
      )}
      {panel.kind === panelKinds.salesQuote && (
        <SalesQuotePanel
          canWrite={canWrite}
          key={panel.id}
          onClose={close}
          onEdit={(quote) => setPanel({ kind: panelKinds.salesQuoteForm, quote })}
          onOpenOrder={(id) => setPanel({ id, kind: panelKinds.salesOrder })}
          quoteId={panel.id}
          run={run}
          state={state}
        />
      )}
      {panel.kind === panelKinds.salesOrder && (
        <SalesOrderPanel
          canWrite={canWrite}
          key={panel.id}
          onClose={close}
          onOpenQuote={(id) => setPanel({ id, kind: panelKinds.salesQuote })}
          orderId={panel.id}
          run={run}
          state={state}
        />
      )}
    </>
  );
};

const PurchasingSearch = Schema.Struct({
  orderId: Schema.optionalKey(Schema.String.pipe(Schema.brand('FacilityPurchaseOrderRouteId'))),
  salesOrderId: Schema.optionalKey(Schema.String.pipe(Schema.brand('FacilitySalesOrderRouteId'))),
  tab: Schema.optionalKey(Schema.String),
});
const RawPurchasingSearch = Schema.toCodecJson(Schema.URLSearchParams);
const PurchasingSearchCodec = RawPurchasingSearch.pipe(
  Schema.decodeTo<typeof PurchasingSearch, typeof RawPurchasingSearch>(PurchasingSearch, {
    decode: SchemaGetter.transform((params) => {
      const orderId = params.get('orderId');
      const salesOrderId = params.get('salesOrderId');
      const tab = params.get('tab');
      return {
        ...optionalField('orderId', orderId ?? undefined),
        ...optionalField('salesOrderId', salesOrderId ?? undefined),
        ...optionalField('tab', tab ?? undefined),
      };
    }),
    encode: SchemaGetter.encodeURLSearchParams(),
  }),
);

const initialPanel = (params: typeof PurchasingSearch.Type | undefined): Option.Option<Panel> => {
  const id = params?.orderId;
  if (id !== undefined) {
    return Option.some({ id, kind: panelKinds.order });
  }
  const salesId = params?.salesOrderId;
  if (salesId !== undefined) {
    return Option.some({ id: salesId, kind: panelKinds.salesOrder });
  }
  return Option.none();
};

const PurchasingView = () => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const ops = useAgendaRecords(['purchasing']);
  const envelope = ops.data?.agendas.purchasing;
  const state = envelope?.state;
  const canWrite = envelope?.canWrite === true;
  const me = ops.data?.actorPrincipalRef;
  const searchStr = useRouterState({ select: (router) => router.location.searchStr });
  const params = Option.getOrUndefined(Schema.decodeOption(PurchasingSearchCodec)(searchStr));
  const [tab, setTab] = useState<Tab>(() => {
    if (params?.orderId !== undefined) {
      return 'orders';
    }
    if (params?.salesOrderId !== undefined || params?.tab === 'prodej') {
      return 'sales';
    }
    return 'stock';
  });
  const [panel, setPanel] = useState<Panel | undefined>(() => Option.getOrUndefined(initialPanel(params)));
  const [financeRefresh, setFinanceRefresh] = useState(0);
  const close = () => setPanel(undefined);
  const openItem = (id: string) => setPanel({ id, kind: panelKinds.item });
  const openOrder = (id: string) => setPanel({ id, kind: panelKinds.order });
  const openQuote = (id: string) => setPanel({ id, kind: panelKinds.quote });
  const suggestions =
    state === undefined
      ? 0
      : state.items.filter((item) => materialPlanOf(state, item, todayIso()).suggestedQuantity > 0).length;

  const headerActions =
    canWrite && state !== undefined ? (
      <div className="flex flex-wrap items-center gap-100">
        {tab === 'suppliers' && (
          <Button
            icon="icon-[mdi--plus]"
            onClick={() => setPanel({ kind: panelKinds.createSupplier })}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {k('actions.newSupplier')}
          </Button>
        )}
        {tab === 'stock' && (
          <Button
            icon="icon-[mdi--plus]"
            onClick={() => setPanel({ kind: panelKinds.createItem })}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {k('actions.newItem')}
          </Button>
        )}
        <Button
          icon="icon-[mdi--file-document-edit-outline]"
          onClick={() => setPanel({ kind: panelKinds.createQuote })}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {k('actions.newQuote')}
        </Button>
        <Button
          icon="icon-[mdi--cart-plus]"
          onClick={() => setPanel({ kind: panelKinds.createOrder })}
          size="sm"
          variant="primary"
        >
          {k('actions.newOrder')}
        </Button>
      </div>
    ) : undefined;

  return (
    <>
      <PageHeader actions={headerActions} description={k('description')} title={k('title')} />
      <AgendaGate
        onRetry={() => {
          browserRuntime.runFork(ops.reload());
        }}
        readable={envelope !== undefined}
        status={ops.status}
      >
        {state !== undefined && (
          <>
            <Stats state={state} />
            <PurchasingTabs
              canWrite={canWrite}
              financeRefresh={financeRefresh}
              me={me}
              openItem={openItem}
              openOrder={openOrder}
              openQuote={openQuote}
              setPanel={setPanel}
              setTab={setTab}
              state={state}
              suggestions={suggestions}
              tab={tab}
            />
            <PurchasingPanels
              canWrite={canWrite}
              close={close}
              me={me}
              onInvoiceCreated={() => setFinanceRefresh((value) => value + 1)}
              openItem={openItem}
              openOrder={openOrder}
              openQuote={openQuote}
              panel={panel}
              run={ops.run}
              setPanel={setPanel}
              state={state}
            />
          </>
        )}
      </AgendaGate>
      <p className="text-fg-secondary text-xs">{t('facility-operations.purchasing.footer')}</p>
    </>
  );
};

export const PurchasingPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.purchasing.title" />
    <PurchasingView />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the first render already has the purchasing agenda. */
export const preloadPage = preloadAgendaRecords(['purchasing']);
export default PurchasingPage;
