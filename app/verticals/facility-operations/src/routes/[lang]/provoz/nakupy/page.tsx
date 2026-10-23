// Facility operations — Sklad a nákupy (S05 sklad a zásoby, S06 nabídky dodavatelů a nákupní objednávky).
// OWNED BY THE `purchasing` LANE (ops-purchasing). Data: one governed records read of agenda `purchasing`,
// every change through the apply-command Action (shared/commands/purchasing.ts).
import { PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useState } from 'react';
import type { PurchasingState } from '../../../../../shared/domain/purchasing.ts';
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
import type { SalesQuote } from '../../../../../shared/domain/purchasing.ts';

type Tab = 'stock' | 'replenish' | 'orders' | 'quotes' | 'sales' | 'movements' | 'suppliers';
type Panel =
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'order'; readonly id: string }
  | { readonly kind: 'quote'; readonly id: string }
  | { readonly kind: 'create-order'; readonly supplierId?: string; readonly lines?: readonly DraftLine[] }
  | { readonly kind: 'create-quote' }
  | { readonly kind: 'create-item' }
  | { readonly kind: 'create-supplier' }
  | { readonly kind: 'sales-quote'; readonly id: string }
  | { readonly kind: 'sales-order'; readonly id: string }
  | { readonly kind: 'sales-quote-form'; readonly quote?: SalesQuote };

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

const PurchasingView = () => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const ops = useAgendaRecords(['purchasing']);
  const envelope = ops.data?.agendas.purchasing;
  const state = envelope?.state;
  const canWrite = envelope?.canWrite === true;
  const me = ops.data?.actorPrincipalRef;
  const params = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search);
  const [tab, setTab] = useState<Tab>(() =>
    params?.has('orderId') === true
      ? 'orders'
      : params?.has('salesOrderId') === true || params?.get('tab') === 'prodej'
        ? 'sales'
        : 'stock',
  );
  const [panel, setPanel] = useState<Panel | undefined>(() => {
    const id = params?.get('orderId') ?? null;
    const salesId = params?.get('salesOrderId') ?? null;
    return id !== null ? { kind: 'order', id } : salesId !== null ? { id: salesId, kind: 'sales-order' } : undefined;
  });
  const [financeRefresh, setFinanceRefresh] = useState(0);
  const close = () => setPanel(undefined);
  const openItem = (id: string) => setPanel({ id, kind: 'item' });
  const openOrder = (id: string) => setPanel({ id, kind: 'order' });
  const openQuote = (id: string) => setPanel({ id, kind: 'quote' });
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
            onClick={() => setPanel({ kind: 'create-supplier' })}
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
            onClick={() => setPanel({ kind: 'create-item' })}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {k('actions.newItem')}
          </Button>
        )}
        <Button
          icon="icon-[mdi--file-document-edit-outline]"
          onClick={() => setPanel({ kind: 'create-quote' })}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {k('actions.newQuote')}
        </Button>
        <Button
          icon="icon-[mdi--cart-plus]"
          onClick={() => setPanel({ kind: 'create-order' })}
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
      <AgendaGate onRetry={() => void ops.reload()} readable={envelope !== undefined} status={ops.status}>
        {state !== undefined && (
          <>
            <Stats state={state} />
            <Tabs onValueChange={(value) => setTab(value as Tab)} size="sm" value={tab} variant="line">
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
              <Tabs.Content className="py-200" value="stock">
                <StockTab onOpen={openItem} state={state} />
              </Tabs.Content>
              <Tabs.Content className="py-200" value="replenish">
                <ReplenishTab
                  canWrite={canWrite}
                  onDraftOrder={(supplierId, lines) =>
                    setPanel({ kind: 'create-order', lines, ...(supplierId === undefined ? {} : { supplierId }) })
                  }
                  onOpenItem={openItem}
                  state={state}
                />
              </Tabs.Content>
              <Tabs.Content className="py-200" value="orders">
                <OrdersTab financeRefresh={financeRefresh} onOpen={openOrder} state={state} />
              </Tabs.Content>
              <Tabs.Content className="py-200" value="quotes">
                <QuotesTab onOpen={openQuote} state={state} />
              </Tabs.Content>
              <Tabs.Content className="py-200" value="sales">
                <SalesTab
                  canWrite={canWrite}
                  onNewQuote={() => setPanel({ kind: 'sales-quote-form' })}
                  onOpenOrder={(id) => setPanel({ id, kind: 'sales-order' })}
                  onOpenQuote={(id) => setPanel({ id, kind: 'sales-quote' })}
                  state={state}
                />
              </Tabs.Content>
              <Tabs.Content className="py-200" value="movements">
                <MovementsTab me={me} onOpenOrder={openOrder} state={state} />
              </Tabs.Content>
              <Tabs.Content className="py-200" value="suppliers">
                <SuppliersTab state={state} />
              </Tabs.Content>
            </Tabs>
            {panel?.kind === 'item' && (
              <ItemPanel
                canWrite={canWrite}
                itemId={panel.id}
                me={me}
                onClose={close}
                onOpenOrder={openOrder}
                run={ops.run}
                state={state}
              />
            )}
            {panel?.kind === 'order' && (
              <OrderPanel
                canWrite={canWrite}
                key={panel.id}
                me={me}
                onClose={close}
                onOpenItem={openItem}
                onOpenQuote={openQuote}
                onInvoiceCreated={() => setFinanceRefresh((value) => value + 1)}
                orderId={panel.id}
                run={ops.run}
                state={state}
              />
            )}
            {panel?.kind === 'quote' && (
              <QuotePanel
                canWrite={canWrite}
                key={panel.id}
                onClose={close}
                onOpenOrder={openOrder}
                quoteId={panel.id}
                run={ops.run}
                state={state}
              />
            )}
            {(panel?.kind === 'create-order' || panel?.kind === 'create-quote') && (
              <PurchaseDocumentPanel
                kind={panel.kind === 'create-order' ? 'order' : 'quote'}
                onClose={close}
                onCreated={(id) => (panel.kind === 'create-order' ? openOrder(id) : openQuote(id))}
                run={ops.run}
                state={state}
                {...(panel.kind === 'create-order' && panel.lines !== undefined ? { initialLines: panel.lines } : {})}
                {...(panel.kind === 'create-order' && panel.supplierId !== undefined
                  ? { initialSupplierId: panel.supplierId }
                  : {})}
              />
            )}
            {panel?.kind === 'create-item' && (
              <ItemCreatePanel onClose={close} onCreated={openItem} run={ops.run} state={state} />
            )}
            {panel?.kind === 'create-supplier' && <SupplierPanel onClose={close} run={ops.run} />}
            {panel?.kind === 'sales-quote-form' && (
              <SalesQuoteFormPanel
                onClose={close}
                onSaved={(id) => setPanel({ id, kind: 'sales-quote' })}
                run={ops.run}
                {...(panel.quote === undefined ? {} : { quote: panel.quote })}
              />
            )}
            {panel?.kind === 'sales-quote' && (
              <SalesQuotePanel
                canWrite={canWrite}
                key={panel.id}
                onClose={close}
                onEdit={(quote) => setPanel({ kind: 'sales-quote-form', quote })}
                onOpenOrder={(id) => setPanel({ id, kind: 'sales-order' })}
                quoteId={panel.id}
                run={ops.run}
                state={state}
              />
            )}
            {panel?.kind === 'sales-order' && (
              <SalesOrderPanel
                canWrite={canWrite}
                key={panel.id}
                onClose={close}
                onOpenQuote={(id) => setPanel({ id, kind: 'sales-quote' })}
                orderId={panel.id}
                run={ops.run}
                state={state}
              />
            )}
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
