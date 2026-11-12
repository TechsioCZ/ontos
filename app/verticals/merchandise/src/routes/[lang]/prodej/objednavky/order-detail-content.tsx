import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { DetailList, formatDateTime, formatMoney, SectionCard, StatusBadge, surfaceTileClassName } from '@app/admin-ui';
import { DateTime, Effect } from 'effect';
import { useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { Order, ProductRecord } from '../../../../../shared/apis/records.ts';
import { orderCurrency } from '../../../../../shared/domain/merchandise-model.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { lineGrossMinor } from '../../../../../shared/domain/order-totals.ts';
import type { CustomerDirectory } from './customers-directory.ts';
import { OrderEditForm } from './order-edit-form.tsx';
import { useTaxLabels } from '../../provoz/produkty/product-tax-classification.ts';
import { OrderEmailDeliveries } from './order-email-deliveries.tsx';
import { OrderCustomerButton } from './order-customer-button.tsx';
import {
  historyActorLabel,
  historyKindKeys,
  isOrderEditable,
  isStorefrontOrder,
  orderCustomerName,
  workflowIndex,
  workflowSteps,
} from './order-eshop.ts';
import { actionLabelKey, transitionsFrom } from './orders-model.ts';
import { removeDemoOrder } from './orders-records.ts';
import type { OrderDetailState } from './orders-records.ts';

type Translate = ReturnType<typeof useModernI18n>['t'];

/** A detail whose order and product records are loaded. */
export type ReadyOrderDetail = Extract<OrderDetailState, { readonly status: 'ready' }>;
/** A detail that is not ready yet: reading, gone, or failed. */
export type PendingOrderDetail = Extract<OrderDetailState, { readonly status: 'error' | 'loading' | 'not-found' }>;

/** Text of a detail that is not ready yet: reading, gone, or failed. */
const pendingDetailKeys = {
  error: 'merchandise.pages.orders.detail.failed',
  loading: 'merchandise.pages.orders.detail.loading',
  'not-found': 'merchandise.pages.orders.detail.notFound',
} as const satisfies Record<PendingOrderDetail['status'], string>;

const workflowColor = (active: boolean, done: boolean) => {
  if (active) {
    return 'border-transparent bg-bg-primary-base text-fg-reverse';
  }
  return done ? 'border-transparent bg-bg-success text-fg-reverse' : 'border-border-primary text-fg-secondary';
};

const orderSourceValue = (
  storefront: boolean,
  brand: string | undefined,
  opportunityId: string | undefined,
  opportunityHref: string,
  t: Translate,
) => {
  if (storefront) {
    return brand === undefined
      ? t('merchandise.pages.orders.detail.storefrontSource')
      : t('merchandise.pages.orders.detail.storefrontSourceBrand', { brand });
  }
  return opportunityId === undefined ? (
    t('merchandise.pages.orders.source.manual')
  ) : (
    <Link href={opportunityHref}>{t('merchandise.pages.orders.source.opportunity')}</Link>
  );
};

/** Horizontal workflow: Nová → Zpracovává se → Připravená k předání → Předáno dopravci → Dokončená. */
const WorkflowSteps = ({ status }: { readonly status: OrderStatus }) => {
  const { t } = useModernI18n();
  const current = workflowIndex(status);
  if (status === 'CANCELLED') {
    return (
      <StatusText showIcon status="error">
        {t('merchandise.pages.orders.detail.cancelledNotice')}
      </StatusText>
    );
  }
  return (
    <>
      <style>{`
        @media (max-width: 639px) {
          .merchandise-order-workflow { grid-template-columns: 1fr; }
          .merchandise-order-workflow > li { flex-direction: row; gap: 8px; text-align: left; }
          .merchandise-order-workflow > li > span:first-child { flex-shrink: 0; }
          .merchandise-order-workflow > li > span:last-child { width: auto !important; overflow-wrap: normal !important; }
        }
      `}</style>
      <ol
        aria-label={t('merchandise.ui.orderWorkflow')}
        className="merchandise-order-workflow grid grid-cols-5 gap-100"
      >
        {workflowSteps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li className="flex min-w-0 flex-col items-center gap-50 text-center" key={step.status}>
              <span
                aria-current={active ? 'step' : undefined}
                className={[
                  'flex items-center justify-center rounded-full border font-semibold text-xs',
                  workflowColor(active, done),
                ].join(' ')}
                style={{ height: 28, width: 28 }}
              >
                {done ? '✓' : index + 1}
              </span>
              <span
                className={`text-xs leading-tight ${active ? 'font-semibold' : 'text-fg-secondary'}`}
                style={{ overflowWrap: 'anywhere', width: '100%' }}
              >
                {t(step.labelKey)}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
};

const OrderHistory = ({
  currentPrincipalId,
  order,
}: {
  readonly currentPrincipalId: string | undefined;
  readonly order: Order;
}) => {
  const { t } = useModernI18n();
  const entries = (order.history ?? []).toReversed();
  if (entries.length === 0) {
    return <p className="text-fg-secondary text-sm">{t('merchandise.pages.orders.detail.historyEmpty')}</p>;
  }
  return (
    <ol className="flex flex-col gap-150">
      {entries.map((entry, index) => (
        <li
          className="flex flex-col gap-50 border-border-primary border-l-2 pl-200"
          key={`${DateTime.formatIso(entry.at)}-${index}`}
        >
          <div className="flex flex-wrap items-baseline gap-x-150 gap-y-50">
            <span className="font-semibold text-sm">{t(historyKindKeys[entry.kind])}</span>
            <span className="text-fg-secondary text-xs">
              {formatDateTime(DateTime.formatIso(entry.at))} · {historyActorLabel(entry, currentPrincipalId, t)}
            </span>
          </div>
          {entry.before !== undefined && entry.kind !== 'CREATED' ? (
            <div className="grid grid-cols-1 gap-50 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-150">
              <span className="text-fg-secondary">{t('merchandise.pages.orders.detail.valueBefore')}</span>
              <span className="line-through decoration-1 opacity-70">{entry.before}</span>
              <span className="text-fg-secondary">{t('merchandise.pages.orders.detail.valueAfter')}</span>
              <span>{entry.after ?? '—'}</span>
            </div>
          ) : (
            entry.after !== undefined && <span className="text-sm">{entry.after}</span>
          )}
          {entry.reason !== undefined && (
            <span className="text-fg-secondary text-xs">
              {t('merchandise.pages.orders.detail.reason', { reason: entry.reason })}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
};

/** Demo-only soft removal, with an explicit reason and separate destructive confirmation. */
const DemoOrderCleanup = ({
  onRemoved,
  order,
  revision,
}: {
  readonly onRemoved: () => void;
  readonly order: Order;
  readonly revision: number;
}) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(() => t('merchandise.pages.orders.detail.cleanup.reasonDefault'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Effect.Error<ReturnType<typeof removeDemoOrder>> | null>(null);
  const remove = () => {
    if (busy || reason.trim().length < 5) {
      return;
    }
    setBusy(true);
    setError(null);
    void browserRuntime.runPromise(
      removeDemoOrder(order.id, reason.trim(), revision).pipe(
        Effect.match({
          onFailure: (cause) => {
            setBusy(false);
            setError(cause);
          },
          onSuccess: () => {
            setBusy(false);
            setOpen(false);
            onRemoved();
          },
        }),
      ),
    );
  };
  return (
    <>
      <div>
        <Button onClick={() => setOpen(true)} size="sm" theme="outlined" variant="danger">
          {t('merchandise.pages.orders.detail.cleanup.open')}
        </Button>
      </div>
      <Dialog
        actions={
          <div style={{ display: 'grid', gap: 8, width: '100%' }}>
            <Button disabled={busy} onClick={() => setOpen(false)} size="sm" theme="outlined" variant="secondary">
              {t('merchandise.pages.orders.detail.cleanup.keep')}
            </Button>
            <Button
              disabled={reason.trim().length < 5}
              isLoading={busy}
              loadingText={t('merchandise.pages.orders.detail.cleanup.busy')}
              onClick={remove}
              size="sm"
              variant="danger"
            >
              {t('merchandise.pages.orders.detail.cleanup.confirm')}
            </Button>
          </div>
        }
        closeLabel={t('merchandise.pages.orders.detail.close')}
        customTrigger
        description={t('merchandise.pages.orders.detail.cleanup.description')}
        onOpenChange={({ open: next }) => {
          if (!busy) {
            setOpen(next);
          }
        }}
        open={open}
        title={t('merchandise.pages.orders.detail.cleanup.title', { number: order.number })}
      >
        <FormInput
          id="demo-cleanup-reason"
          label={t('merchandise.ui.removalReason')}
          maxLength={500}
          name="reason"
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
        {error && <StatusText status="error">{t('merchandise.pages.orders.detail.cleanup.failed')}</StatusText>}
      </Dialog>
    </>
  );
};

/** Which order actions the panel and the page offer for this order in its current state. */
const orderDetailAffordances = (
  order: Order,
  customers: CustomerDirectory,
  canWrite: boolean,
  canEditOrders: boolean,
  canCleanupDemo: boolean,
  editing: boolean,
) => {
  const storefront = isStorefrontOrder(order);
  const transitions = canWrite && !editing ? transitionsFrom(order.status) : [];
  const forward = transitions.filter((status) => status !== 'CANCELLED').slice(0, 1);
  const cancel =
    transitions.includes('CANCELLED') ||
    (canWrite &&
      !editing &&
      order.demo === true &&
      storefront &&
      (order.status === 'SHIPPED' || order.status === 'DELIVERED'));
  return {
    cancel,
    forward,
    showCleanup: canCleanupDemo && order.demo === true && storefront,
    showCustomerConversion:
      canEditOrders &&
      storefront &&
      order.contact !== undefined &&
      customers.status === 'ready' &&
      !customers.entries.some((customer) => customer.partyId === order.partyId),
    showEdit: canEditOrders && isOrderEditable(order),
    storefront,
  };
};

/** Only an imported source catalog names its pickup point after the e-shop brand (as `shippingMethodFor` stores it). */
const pickupBrandOf = (products: readonly ProductRecord[], brand: string | undefined) =>
  products.some((product) => product.sourceGroupId !== undefined) ? brand : undefined;

const deliveryAddressValue = (address: NonNullable<Order['deliveryAddress']>): string =>
  `${address.street}, ${address.postalCode} ${address.city}${
    address.country === undefined ? '' : `, ${address.country}`
  }`;

/** Read-only header from the authorized list row, shown until the enriched detail lands. */
const renderOrderSummary = ({
  customers,
  order,
  t,
}: {
  readonly customers: CustomerDirectory;
  readonly order: Order;
  readonly t: Translate;
}) => (
  <DetailList
    items={[
      {
        label: t('merchandise.pages.orders.detail.customer'),
        value: orderCustomerName(order, customers) ?? t('merchandise.pages.orders.customers.unknown'),
      },
      ...(order.contact?.email === undefined ? [] : [{ label: t('merchandise.ui.email'), value: order.contact.email }]),
      ...(order.contact?.phone === undefined ? [] : [{ label: t('merchandise.ui.phone'), value: order.contact.phone }]),
      ...(order.deliveryAddress === undefined
        ? []
        : [{ label: t('merchandise.ui.deliveryAddress'), value: deliveryAddressValue(order.deliveryAddress) }]),
      ...(order.shipping === undefined
        ? []
        : [
            {
              label: t('merchandise.ui.shipping'),
              value: `${order.shipping.label} · ${formatMoney(order.shipping.priceMinor, orderCurrency(order))}`,
            },
          ]),
      {
        label: t('merchandise.pages.orders.detail.createdAt'),
        value: formatDateTime(DateTime.formatIso(order.createdAt)),
      },
      {
        label: t('merchandise.pages.orders.detail.grossTotal'),
        value: <span className="tabular-nums">{formatMoney(order.totalMinor, orderCurrency(order))}</span>,
      },
    ]}
  />
);

const renderOrderFields = ({
  brand,
  customers,
  opportunityHref,
  order,
  pickupBrand,
  storefront,
  t,
}: {
  readonly brand: string | undefined;
  readonly customers: CustomerDirectory;
  readonly opportunityHref: string;
  readonly order: Order;
  readonly pickupBrand: string | undefined;
  readonly storefront: boolean;
  readonly t: Translate;
}) => (
  <DetailList
    items={[
      {
        label: t('merchandise.pages.orders.detail.customer'),
        value: orderCustomerName(order, customers) ?? t('merchandise.pages.orders.customers.unknown'),
      },
      ...(order.contact === undefined
        ? []
        : [
            {
              label: t('merchandise.pages.orders.detail.contact'),
              value: [order.contact.email, order.contact.phone].filter((part) => part !== undefined).join(' · '),
            },
          ]),
      ...(order.deliveryAddress === undefined
        ? []
        : [
            {
              label: t('merchandise.ui.deliveryAddress'),
              value: deliveryAddressValue(order.deliveryAddress),
            },
          ]),
      ...(order.shipping === undefined
        ? []
        : [
            {
              label: t('merchandise.ui.shipping'),
              // Seeded pickup orders of an imported catalog name the seed's pickup point; show the company's own.
              value: `${pickupBrand === undefined ? order.shipping.label : order.shipping.label.replace('Kavárna Doma, Brno', pickupBrand)} · ${formatMoney(order.shipping.priceMinor, orderCurrency(order))}`,
            },
          ]),
      ...(order.market === undefined
        ? []
        : [
            {
              label: t('merchandise.pages.orders.detail.market'),
              value: (
                <span className="flex flex-wrap items-center gap-100">
                  <Badge size="sm" variant="outline">
                    {order.market.marketCode}
                  </Badge>
                  <span>{order.market.currency}</span>
                </span>
              ),
            },
          ]),
      ...(storefront
        ? [
            {
              label: t('merchandise.pages.orders.detail.payment'),
              value: t('merchandise.pages.orders.detail.paymentNone'),
            },
          ]
        : []),
      ...(order.note === undefined || order.note === ''
        ? []
        : [{ label: t('merchandise.pages.orders.detail.note'), value: order.note }]),
      {
        label: t('merchandise.pages.orders.detail.source'),
        value: orderSourceValue(storefront, brand, order.opportunityId, opportunityHref, t),
      },
      {
        label: t('merchandise.pages.orders.detail.createdAt'),
        value: formatDateTime(DateTime.formatIso(order.createdAt)),
      },
      {
        label: t('merchandise.pages.orders.detail.updatedAt'),
        value: formatDateTime(DateTime.formatIso(order.updatedAt)),
      },
    ]}
  />
);

/** Body of a detail that is not ready: the list row's summary while the enriched detail lands, or the state text. */
export const OrderPendingBody = ({
  customers,
  detail,
}: {
  readonly customers: CustomerDirectory;
  readonly detail: PendingOrderDetail;
}) => {
  const { t } = useModernI18n();
  const summary = detail.status === 'loading' ? detail.summary : undefined;
  if (summary === undefined) {
    return (
      <div className="py-200">
        <StatusText showIcon={detail.status !== 'loading'} status={detail.status === 'loading' ? 'default' : 'error'}>
          {t(pendingDetailKeys[detail.status])}
        </StatusText>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-200 py-200">
      <div className="flex flex-wrap items-center gap-100">
        <StatusBadge kind="order" value={summary.order.status} />
        {isStorefrontOrder(summary.order) && (
          <Badge size="sm" variant="info">
            {t('merchandise.ui.storefrontBadge')}
          </Badge>
        )}
        {summary.order.demo === true && (
          <Badge size="sm" variant="warning">
            {t('merchandise.ui.demoBadge')}
          </Badge>
        )}
      </div>
      {renderOrderSummary({ customers, order: summary.order, t })}
      <StatusText showIcon status="default">
        {t(pendingDetailKeys.loading)}
      </StatusText>
    </div>
  );
};

interface OrderDetailActionsProps {
  readonly busy: boolean;
  readonly canCleanupDemo: boolean;
  readonly canEditOrders: boolean;
  readonly canWrite: boolean;
  readonly customers: CustomerDirectory;
  readonly editing: boolean;
  readonly onClose: () => void;
  readonly onStatus: (order: Order, status: OrderStatus) => void;
  readonly order: Order;
}

/**
 * The footer actions of an order: close, cancel and the next status. The edit form brings its own (back to the
 * detail and the Save button), so an order being edited has none here.
 */
export const OrderDetailActions = ({
  busy,
  canCleanupDemo,
  canEditOrders,
  canWrite,
  customers,
  editing,
  onClose,
  onStatus,
  order,
}: OrderDetailActionsProps) => {
  const { t } = useModernI18n();
  const { cancel, forward } = orderDetailAffordances(
    order,
    customers,
    canWrite,
    canEditOrders,
    canCleanupDemo,
    editing,
  );
  const label = (status: OrderStatus) => {
    const labelKey = actionLabelKey(status);
    return labelKey === null ? status : t(labelKey);
  };
  if (editing) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-100">
      <Button onClick={onClose} size="sm" theme="outlined" variant="secondary">
        {t('merchandise.pages.orders.detail.close')}
      </Button>
      {cancel && (
        <Button
          className="shrink-0 whitespace-nowrap"
          disabled={busy}
          onClick={() => onStatus(order, 'CANCELLED')}
          size="sm"
          theme="outlined"
          variant="danger"
        >
          {label('CANCELLED')}
        </Button>
      )}
      {forward.map((status, index) => (
        <Button
          className="whitespace-nowrap"
          isLoading={busy && index === 0}
          key={status}
          loadingText={t('merchandise.pages.orders.create.submitting')}
          onClick={() => onStatus(order, status)}
          size="sm"
          {...(index === 0
            ? { variant: 'primary' as const }
            : { theme: 'outlined' as const, variant: 'secondary' as const })}
        >
          {label(status)}
        </Button>
      ))}
    </div>
  );
};

export interface OrderDetailContentProps {
  /** The company's e-shop brand (`storefrontBrandOf`); names e-shop orders and personal pickup. */
  readonly brand?: string | undefined;
  readonly busy: boolean;
  readonly canCleanupDemo: boolean;
  readonly canEditOrders: boolean;
  readonly canWrite: boolean;
  readonly currentPrincipalId: string | undefined;
  readonly customers: CustomerDirectory;
  /** The open order with its line products and whether it took goods from stock (quantity edits then move stock). */
  readonly detail: ReadyOrderDetail;
  /**
   * The host's footer for the edit form's actions (the side panel's footer); `null` until it is on screen. Left out,
   * the edit form shows them in its own footer.
   */
  readonly editActionsSlot?: HTMLElement | null | undefined;
  readonly editing: boolean;
  readonly onClose: () => void;
  readonly onEdited: (message: string) => void;
  readonly onEditingChange: (editing: boolean) => void;
  readonly revision: number;
}

/** One order: workflow, customer, delivery, lines, totals and audited history; editable until the hand-over. */
export const OrderDetailContent = ({
  brand,
  busy,
  canCleanupDemo,
  canEditOrders,
  canWrite,
  currentPrincipalId,
  customers,
  detail,
  editActionsSlot,
  editing,
  onClose,
  onEdited,
  onEditingChange,
  revision,
}: OrderDetailContentProps) => {
  const { language, t } = useModernI18n();
  const taxLabels = useTaxLabels();
  const { movesStock: orderMovesStock, order, products, vat } = detail;
  const pickupBrand = pickupBrandOf(products, brand);
  const { showCleanup, showCustomerConversion, showEdit, storefront } = orderDetailAffordances(
    order,
    customers,
    canWrite,
    canEditOrders,
    canCleanupDemo,
    editing,
  );
  const opportunitySearch =
    order.opportunityId === undefined ? '' : `?opportunityId=${encodeURIComponent(order.opportunityId)}`;
  const opportunityHref = `/${language}/prodej/prilezitosti${opportunitySearch}`;
  const gross = order.pricesIncludeVat === true;
  const linesGross = order.lines.reduce((total, line) => total + lineGrossMinor(line, order.pricesIncludeVat), 0);

  if (editing) {
    return (
      <div className="py-200">
        <OrderEditForm
          actionsSlot={editActionsSlot}
          movesStock={orderMovesStock}
          onCancel={() => onEditingChange(false)}
          onSaved={(message) => {
            onEditingChange(false);
            onEdited(message);
          }}
          order={order}
          pickupBrand={pickupBrand}
          products={products}
          revision={revision}
          vat={vat}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-250 py-200">
      <div className="flex flex-wrap items-center gap-100">
        <StatusBadge kind="order" value={order.status} />
        {storefront && (
          <Badge size="sm" variant="info">
            {t('merchandise.ui.storefrontBadge')}
          </Badge>
        )}
        {order.demo === true && (
          <Badge size="sm" variant="warning">
            {t('merchandise.ui.demoBadge')}
          </Badge>
        )}
        {showEdit && (
          <span className="ml-auto">
            <Button
              disabled={busy}
              icon="icon-[mdi--pencil-outline]"
              onClick={() => onEditingChange(true)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t('merchandise.pages.orders.detail.editOrder')}
            </Button>
          </span>
        )}
      </div>
      {order.demo === true && (
        <p className={`${surfaceTileClassName} p-150 text-fg-secondary text-sm`}>
          <span className="font-semibold text-fg-primary">{t('merchandise.pages.orders.detail.demoPrefix')} </span>
          {t('merchandise.pages.orders.detail.demoNotice')} {t('merchandise.pages.orders.detail.demoStatusNotice')}
        </p>
      )}
      {showCleanup && (
        <DemoOrderCleanup
          onRemoved={() => {
            onClose();
            onEdited(t('merchandise.pages.orders.detail.cleanup.removed'));
          }}
          order={order}
          revision={revision}
        />
      )}
      {showCustomerConversion && (
        <OrderCustomerButton
          key={order.id}
          onConverted={() => {
            customers.reload();
            onEdited(t('merchandise.pages.orders.detail.conversion.converted'));
          }}
          order={order}
          revision={revision}
        />
      )}
      <WorkflowSteps status={order.status} />
      {renderOrderFields({ brand, customers, opportunityHref, order, pickupBrand, storefront, t })}
      <SectionCard flush title={t('merchandise.pages.orders.detail.lines')}>
        <Table size="sm" variant="line">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>{t('merchandise.pages.orders.detail.lineName')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">{t('merchandise.pages.orders.detail.lineQuantity')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">
                <span className="whitespace-nowrap">
                  {gross
                    ? t('merchandise.pages.orders.detail.unitPriceGross')
                    : t('merchandise.pages.orders.detail.unitPriceNet')}
                </span>
              </Table.ColumnHeader>
              <Table.ColumnHeader align="end">{t('merchandise.pages.orders.detail.lineVat')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">{t('merchandise.pages.orders.detail.lineTotal')}</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {order.lines.map((line) => (
              <Table.Row key={`${line.productId}|${line.variantId ?? ''}`}>
                <Table.Cell>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{line.productName}</span>
                    <span className="text-fg-secondary text-xs">
                      {line.variantName === undefined ? line.sku : `${line.variantName} · ${line.sku}`}
                    </span>
                  </div>
                </Table.Cell>
                <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                  {line.quantity}
                </Table.Cell>
                <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                  {formatMoney(line.unitPriceMinor, orderCurrency(order))}
                </Table.Cell>
                <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                  {taxLabels.line(line.taxClassificationCode, line.vatRate)}
                </Table.Cell>
                <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                  {formatMoney(lineGrossMinor(line, order.pricesIncludeVat), orderCurrency(order))}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </SectionCard>
      <DetailList
        items={[
          ...(order.shipping === undefined
            ? []
            : [
                {
                  label: t('merchandise.pages.orders.detail.goodsGross'),
                  value: <span className="tabular-nums">{formatMoney(linesGross, orderCurrency(order))}</span>,
                },
                {
                  label: t('merchandise.pages.orders.detail.shippingGross'),
                  value: (
                    <span className="tabular-nums">{formatMoney(order.shipping.priceMinor, orderCurrency(order))}</span>
                  ),
                },
              ]),
          {
            label: t('merchandise.pages.orders.detail.netTotal'),
            value: (
              <span className="tabular-nums">
                {formatMoney(order.totalMinor - order.totalVatMinor, orderCurrency(order))}
              </span>
            ),
          },
          {
            label: t('merchandise.pages.orders.detail.vatTotal'),
            value: <span className="tabular-nums">{formatMoney(order.totalVatMinor, orderCurrency(order))}</span>,
          },
          {
            label: t('merchandise.pages.orders.detail.grossTotal'),
            value: (
              <span className="font-semibold tabular-nums">{formatMoney(order.totalMinor, orderCurrency(order))}</span>
            ),
          },
        ]}
      />
      {storefront && <OrderEmailDeliveries orderId={order.id} />}
      <SectionCard title={t('merchandise.ui.changeHistory')}>
        <OrderHistory currentPrincipalId={currentPrincipalId} order={order} />
      </SectionCard>
    </div>
  );
};
