import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import {
  DetailList,
  formatDateTime,
  formatMoney,
  SectionCard,
  SidePanel,
  StatusBadge,
  surfaceTileClassName,
} from '@app/admin-ui';
import { DateTime, Effect } from 'effect';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { removeDemoOrder } from './orders-records.ts';
import type { OrderDetailState } from './orders-records.ts';
import { useState } from 'react';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { lineGrossMinor } from '../../../../../shared/domain/order-totals.ts';
import type { CustomerDirectory } from './customers-directory.ts';
import { OrderEditForm } from './order-edit-form.tsx';
import { OrderEmailDeliveries } from './order-email-deliveries.tsx';
import { OrderCustomerButton } from './order-customer-button.tsx';
import {
  historyActorLabel,
  historyKindLabels,
  isOrderEditable,
  isStorefrontOrder,
  orderCustomerName,
  workflowIndex,
  workflowSteps,
} from './order-eshop.ts';
import { actionLabelKey, transitionsFrom } from './orders-model.ts';

interface OrderDetailDialogProps {
  readonly busy: boolean;
  readonly canCleanupDemo?: boolean;
  readonly canEditOrders?: boolean;
  readonly canWrite: boolean;
  readonly currentPrincipalId: string | undefined;
  readonly customers: CustomerDirectory;
  /** The open order with its line products and whether it took goods from stock (quantity edits then move stock). */
  readonly detail: OrderDetailState;
  readonly onClose: () => void;
  readonly onEdited: (message: string) => void;
  readonly onStatus: (order: Order, status: OrderStatus) => void;
  readonly revision: number;
}

/** Text of a detail that is not ready yet: reading, gone, or failed. */
const pendingDetailKeys = {
  error: 'merchandise.pages.orders.detail.failed',
  loading: 'merchandise.pages.orders.detail.loading',
  'not-found': 'merchandise.pages.orders.detail.notFound',
} as const satisfies Record<Exclude<OrderDetailState['status'], 'idle' | 'ready'>, string>;

const DEMO_NOTICE = 'E-shop je prezentační demo. Žádné zboží nebude doručeno a nic se neplatí.';

const workflowColor = (active: boolean, done: boolean) => {
  if (active) {
    return 'border-transparent bg-bg-primary-base text-fg-reverse';
  }
  return done ? 'border-transparent bg-bg-success text-fg-reverse' : 'border-border-primary text-fg-secondary';
};

const orderSourceValue = (
  storefront: boolean,
  akros: boolean,
  opportunityId: string | undefined,
  opportunityHref: string,
  t: ReturnType<typeof useModernI18n>['t'],
) => {
  if (storefront) {
    return akros ? 'E-shop AKROS (DEMO)' : 'E-shop Kavárna Doma (DEMO)';
  }
  return opportunityId === undefined ? (
    t('merchandise.pages.orders.source.manual')
  ) : (
    <Link href={opportunityHref}>{t('merchandise.pages.orders.source.opportunity')}</Link>
  );
};

/** Horizontal workflow: Nová → Zpracovává se → Připravená k předání → Předáno dopravci → Dokončená. */
const WorkflowSteps = ({ status }: { readonly status: OrderStatus }) => {
  const current = workflowIndex(status);
  if (status === 'CANCELLED') {
    return (
      <StatusText showIcon status="error">
        Objednávka je zrušená. Další změny stavu nejsou možné.
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
      <ol aria-label="Průběh objednávky" className="merchandise-order-workflow grid grid-cols-5 gap-100">
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
                {step.label}
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
  const entries = (order.history ?? []).toReversed();
  if (entries.length === 0) {
    return <p className="text-fg-secondary text-sm">Historie změn není u této starší objednávky k dispozici.</p>;
  }
  return (
    <ol className="flex flex-col gap-150">
      {entries.map((entry, index) => (
        <li
          className="flex flex-col gap-50 border-border-primary border-l-2 pl-200"
          key={`${DateTime.formatIso(entry.at)}-${index}`}
        >
          <div className="flex flex-wrap items-baseline gap-x-150 gap-y-50">
            <span className="font-semibold text-sm">{historyKindLabels[entry.kind]}</span>
            <span className="text-fg-secondary text-xs">
              {formatDateTime(DateTime.formatIso(entry.at))} · {historyActorLabel(entry, currentPrincipalId)}
            </span>
          </div>
          {entry.before !== undefined && entry.kind !== 'CREATED' ? (
            <div className="grid grid-cols-1 gap-50 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-150">
              <span className="text-fg-secondary">Před:</span>
              <span className="line-through decoration-1 opacity-70">{entry.before}</span>
              <span className="text-fg-secondary">Po:</span>
              <span>{entry.after ?? '—'}</span>
            </div>
          ) : (
            entry.after !== undefined && <span className="text-sm">{entry.after}</span>
          )}
          {entry.reason !== undefined && <span className="text-fg-secondary text-xs">Důvod: {entry.reason}</span>}
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
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('Úklid prezentační DEMO objednávky');
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
          Odstranit DEMO objednávku
        </Button>
      </div>
      <Dialog
        actions={
          <div style={{ display: 'grid', gap: 8, width: '100%' }}>
            <Button disabled={busy} onClick={() => setOpen(false)} size="sm" theme="outlined" variant="secondary">
              Zachovat objednávku
            </Button>
            <Button
              disabled={reason.trim().length < 5}
              isLoading={busy}
              loadingText="Odstraňuji…"
              onClick={remove}
              size="sm"
              variant="danger"
            >
              Potvrdit odstranění DEMO
            </Button>
          </div>
        }
        closeLabel="Zavřít"
        customTrigger
        description="Pouze pro správce. Objednávka zmizí z prezentačního seznamu v libovolném stavu. Historie i identita původního podání zůstanou v auditu. Skutečné objednávky nelze odstranit."
        onOpenChange={({ open: next }) => {
          if (!busy) {
            setOpen(next);
          }
        }}
        open={open}
        title={`Odstranit DEMO objednávku ${order.number}?`}
      >
        <FormInput
          id="demo-cleanup-reason"
          label="Důvod odstranění (audit)"
          maxLength={500}
          name="reason"
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
        {error && (
          <StatusText status="error">Objednávku se nepodařilo odstranit. Obnovte data a zkuste to znovu.</StatusText>
        )}
      </Dialog>
    </>
  );
};

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

const renderOrderFields = ({
  akros,
  customers,
  opportunityHref,
  order,
  storefront,
  t,
}: {
  readonly akros: boolean;
  readonly customers: CustomerDirectory;
  readonly opportunityHref: string;
  readonly order: Order;
  readonly storefront: boolean;
  readonly t: ReturnType<typeof useModernI18n>['t'];
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
              label: 'Kontakt',
              value: [order.contact.email, order.contact.phone].filter((part) => part !== undefined).join(' · '),
            },
          ]),
      ...(order.deliveryAddress === undefined
        ? []
        : [
            {
              label: 'Doručovací adresa',
              value: `${order.deliveryAddress.street}, ${order.deliveryAddress.postalCode} ${order.deliveryAddress.city}${
                order.deliveryAddress.country === undefined ? '' : `, ${order.deliveryAddress.country}`
              }`,
            },
          ]),
      ...(order.shipping === undefined
        ? []
        : [
            {
              label: 'Doprava',
              value: `${akros ? order.shipping.label.replace('Kavárna Doma, Brno', 'AKROS') : order.shipping.label} · ${formatMoney(order.shipping.priceMinor)}`,
            },
          ]),
      ...(storefront ? [{ label: 'Platba', value: 'Nic neplatíte (DEMO)' }] : []),
      ...(order.note === undefined || order.note === '' ? [] : [{ label: 'Poznámka', value: order.note }]),
      {
        label: t('merchandise.pages.orders.detail.source'),
        value: orderSourceValue(storefront, akros, order.opportunityId, opportunityHref, t),
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

/** One order: workflow, customer, delivery, lines, totals and audited history; editable until the hand-over. */
export const OrderDetailDialog = ({
  busy,
  canCleanupDemo = false,
  canWrite,
  canEditOrders = canWrite,
  currentPrincipalId,
  customers,
  detail,
  onClose,
  onEdited,
  onStatus,
  revision,
}: OrderDetailDialogProps) => {
  const { language, t } = useModernI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (detail.status === 'idle') {
    return null;
  }
  if (detail.status !== 'ready') {
    return (
      <SidePanel
        actions={
          <Button onClick={onClose} size="sm" theme="outlined" variant="secondary">
            {t('merchandise.pages.orders.detail.close')}
          </Button>
        }
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={t('merchandise.sidePanel.resize')}
        size="xl"
        title={t('merchandise.pages.orders.detail.loadingTitle')}
      >
        <div className="py-200">
          <StatusText showIcon={detail.status !== 'loading'} status={detail.status === 'loading' ? 'default' : 'error'}>
            {t(pendingDetailKeys[detail.status])}
          </StatusText>
        </div>
      </SidePanel>
    );
  }
  const { movesStock: orderMovesStock, order, products } = detail;
  const editing = editingId === order.id;
  const akros = products.some((product) => product.sourceGroupId !== undefined);
  const { cancel, forward, showCleanup, showCustomerConversion, showEdit, storefront } = orderDetailAffordances(
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
  const opportunitySearch =
    order.opportunityId === undefined ? '' : `?opportunityId=${encodeURIComponent(order.opportunityId)}`;
  const opportunityHref = `/${language}/prodej/prilezitosti${opportunitySearch}`;
  const gross = order.pricesIncludeVat === true;
  const linesGross = order.lines.reduce((total, line) => total + lineGrossMinor(line, order.pricesIncludeVat), 0);

  const actions = editing ? (
    <Button onClick={() => setEditingId(null)} theme="outlined" variant="secondary">
      Zpět na detail
    </Button>
  ) : (
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

  return (
    <SidePanel
      actions={actions}
      closeOnInteractOutside={!editing}
      onOpenChange={(next) => {
        if (!next) {
          setEditingId(null);
          onClose();
        }
      }}
      open
      resizeLabel={t('merchandise.sidePanel.resize')}
      size="xl"
      title={
        editing
          ? `Úprava objednávky ${order.number}`
          : t('merchandise.pages.orders.detail.title', { number: order.number })
      }
    >
      {editing ? (
        <div className="py-200">
          <OrderEditForm
            movesStock={orderMovesStock}
            onCancel={() => setEditingId(null)}
            onSaved={(message) => {
              setEditingId(null);
              onEdited(message);
            }}
            order={order}
            products={products}
            revision={revision}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-250 py-200">
          <div className="flex flex-wrap items-center gap-100">
            <StatusBadge kind="order" value={order.status} />
            {storefront && (
              <Badge size="sm" variant="info">
                E-shop
              </Badge>
            )}
            {order.demo === true && (
              <Badge size="sm" variant="warning">
                DEMO
              </Badge>
            )}
            {showEdit && (
              <span className="ml-auto">
                <Button
                  disabled={busy}
                  icon="icon-[mdi--pencil-outline]"
                  onClick={() => setEditingId(order.id)}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  Upravit objednávku
                </Button>
              </span>
            )}
          </div>
          {order.demo === true && (
            <p className={`${surfaceTileClassName} p-150 text-fg-secondary text-sm`}>
              <span className="font-semibold text-fg-primary">DEMO: </span>
              {DEMO_NOTICE} Změny stavu neodesílají zásilku ani výzvu k platbě.
            </p>
          )}
          {showCleanup && (
            <DemoOrderCleanup
              onRemoved={() => {
                onClose();
                onEdited('DEMO objednávka odstraněna; audit zůstal zachován');
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
                onEdited('Kontakt byl převeden na zákazníka');
              }}
              order={order}
              revision={revision}
            />
          )}
          <WorkflowSteps status={order.status} />
          {renderOrderFields({ akros, customers, opportunityHref, order, storefront, t })}
          <SectionCard flush title={t('merchandise.pages.orders.detail.lines')}>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{t('merchandise.pages.orders.detail.lineName')}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">
                    {t('merchandise.pages.orders.detail.lineQuantity')}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader align="end">
                    <span className="whitespace-nowrap">{gross ? 'Cena/j s DPH' : 'Cena/j bez DPH'}</span>
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
                      {formatMoney(line.unitPriceMinor)}
                    </Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      {`${line.vatRate} %`}
                    </Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      {formatMoney(lineGrossMinor(line, order.pricesIncludeVat))}
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
                    { label: 'Zboží s DPH', value: <span className="tabular-nums">{formatMoney(linesGross)}</span> },
                    {
                      label: 'Doprava s DPH',
                      value: <span className="tabular-nums">{formatMoney(order.shipping.priceMinor)}</span>,
                    },
                  ]),
              {
                label: t('merchandise.pages.orders.detail.netTotal'),
                value: <span className="tabular-nums">{formatMoney(order.totalMinor - order.totalVatMinor)}</span>,
              },
              {
                label: t('merchandise.pages.orders.detail.vatTotal'),
                value: <span className="tabular-nums">{formatMoney(order.totalVatMinor)}</span>,
              },
              {
                label: t('merchandise.pages.orders.detail.grossTotal'),
                value: <span className="font-semibold tabular-nums">{formatMoney(order.totalMinor)}</span>,
              },
            ]}
          />
          {storefront && <OrderEmailDeliveries orderId={order.id} />}
          <SectionCard title="Historie změn">
            <OrderHistory currentPrincipalId={currentPrincipalId} order={order} />
          </SectionCard>
        </div>
      )}
    </SidePanel>
  );
};
