import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DetailList, formatDateTime, formatMoney, SectionCard, SidePanel, StatusBadge } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { Order, ProductRecord } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { lineGrossMinor } from '../../../../../shared/domain/order-totals.ts';
import type { CustomerDirectory } from './customers-directory.ts';
import { OrderEditForm } from './order-edit-form.tsx';
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
  readonly canWrite: boolean;
  readonly currentPrincipalId: string | undefined;
  readonly customers: CustomerDirectory;
  readonly onClose: () => void;
  readonly onEdited: (message: string) => void;
  readonly onStatus: (order: Order, status: OrderStatus) => void;
  readonly order: Order | undefined;
  readonly products: readonly ProductRecord[];
  readonly revision: number;
}

const DEMO_NOTICE = 'E-shop je prezentační demo. Žádné zboží nebude doručeno a nic se neplatí.';

/** Horizontal workflow: Nová → Potvrzená → Balí se → Předáno dopravci (simulace) → Dokončená. */
const WorkflowSteps = ({ status }: { readonly status: OrderStatus }) => {
  const current = workflowIndex(status);
  if (status === 'CANCELLED') {
    return (
      <StatusText showIcon status="error">
        Objednávka je stornovaná. Další změny stavu nejsou možné.
      </StatusText>
    );
  }
  return (
    <ol aria-label="Průběh objednávky" className="grid grid-cols-5 gap-100">
      {workflowSteps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li className="flex min-w-0 flex-col items-center gap-50 text-center" key={step.status}>
            <span
              aria-current={active ? 'step' : undefined}
              className={[
                'flex size-7 items-center justify-center rounded-full border font-semibold text-xs',
                active
                  ? 'border-transparent bg-bg-primary-base text-fg-reverse'
                  : done
                    ? 'border-transparent bg-bg-success text-fg-reverse'
                    : 'border-border-primary text-fg-secondary',
              ].join(' ')}
            >
              {done ? <span aria-hidden className="icon-[mdi--check] size-4" /> : index + 1}
            </span>
            <span className={`text-xs leading-tight ${active ? 'font-semibold' : 'text-fg-secondary'}`}>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

const OrderHistory = ({
  currentPrincipalId,
  order,
}: {
  readonly currentPrincipalId: string | undefined;
  readonly order: Order;
}) => {
  const entries = [...(order.history ?? [])].reverse();
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

/** One order: workflow, customer, delivery, lines, totals and audited history; editable until the hand-over. */
export const OrderDetailDialog = ({
  busy,
  canWrite,
  currentPrincipalId,
  customers,
  onClose,
  onEdited,
  onStatus,
  order,
  products,
  revision,
}: OrderDetailDialogProps) => {
  const { language, t } = useModernI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (order === undefined) {
    return null;
  }
  const editing = editingId === order.id;
  const storefront = isStorefrontOrder(order);
  const transitions = canWrite && !editing ? transitionsFrom(order.status) : [];
  const forward = transitions.filter((status) => status !== 'CANCELLED');
  const cancel = transitions.includes('CANCELLED');
  const label = (status: OrderStatus) => {
    const labelKey = actionLabelKey(status);
    return labelKey === null ? status : t(labelKey);
  };
  const opportunityHref = `/${language}/prodej/prilezitosti`;
  const gross = order.pricesIncludeVat === true;
  const linesGross = order.lines.reduce((total, line) => total + lineGrossMinor(line, order.pricesIncludeVat), 0);

  const actions = editing ? (
    <Button onClick={() => setEditingId(null)} theme="outlined" variant="secondary">
      Zpět na detail
    </Button>
  ) : (
    <>
      <Button onClick={onClose} theme="outlined" variant="secondary">
        {t('merchandise.pages.orders.detail.close')}
      </Button>
      {cancel && (
        <Button disabled={busy} onClick={() => onStatus(order, 'CANCELLED')} theme="outlined" variant="danger">
          {label('CANCELLED')}
        </Button>
      )}
      {canWrite && isOrderEditable(order) && (
        <Button
          disabled={busy}
          icon="icon-[mdi--pencil-outline]"
          onClick={() => setEditingId(order.id)}
          theme="outlined"
          variant="secondary"
        >
          Upravit objednávku
        </Button>
      )}
      {forward.map((status, index) => (
        <Button
          isLoading={busy && index === 0}
          key={status}
          loadingText={t('merchandise.pages.orders.create.submitting')}
          onClick={() => onStatus(order, status)}
          {...(index === 0
            ? { variant: 'primary' as const }
            : { theme: 'outlined' as const, variant: 'secondary' as const })}
        >
          {label(status)}
        </Button>
      ))}
    </>
  );

  return (
    <SidePanel
      actions={actions}
      onOpenChange={(next) => {
        if (!next) {
          setEditingId(null);
          onClose();
        }
      }}
      open
      resizeLabel={t('merchandise.sidePanel.resize')}
      size="lg"
      title={
        editing
          ? `Úprava objednávky ${order.number}`
          : t('merchandise.pages.orders.detail.title', { number: order.number })
      }
    >
      {editing ? (
        <div className="py-200">
          <OrderEditForm
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
            {order.status === 'SHIPPED' && (
              <Badge size="sm" variant="outline">
                Simulace předání dopravci
              </Badge>
            )}
          </div>
          {order.demo === true && (
            <StatusText showIcon status="warning">
              {DEMO_NOTICE} Změny stavu neodesílají zásilku ani výzvu k platbě.
            </StatusText>
          )}
          <WorkflowSteps status={order.status} />
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
                      value: [order.contact.email, order.contact.phone]
                        .filter((part) => part !== undefined)
                        .join(' · '),
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
                : [{ label: 'Doprava', value: `${order.shipping.label} · ${formatMoney(order.shipping.priceMinor)}` }]),
              ...(storefront ? [{ label: 'Platba', value: 'Nic neplatíte (DEMO)' }] : []),
              ...(order.note === undefined || order.note === '' ? [] : [{ label: 'Poznámka', value: order.note }]),
              {
                label: t('merchandise.pages.orders.detail.source'),
                value: storefront ? (
                  'E-shop Kavárna Doma (DEMO)'
                ) : order.opportunityId === undefined ? (
                  t('merchandise.pages.orders.source.manual')
                ) : (
                  <Link href={opportunityHref}>{t('merchandise.pages.orders.source.opportunity')}</Link>
                ),
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
          <SectionCard flush title={t('merchandise.pages.orders.detail.lines')}>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{t('merchandise.pages.orders.detail.lineName')}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">
                    {t('merchandise.pages.orders.detail.lineQuantity')}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{gross ? 'Cena/j s DPH' : 'Cena/j bez DPH'}</Table.ColumnHeader>
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
                    <Table.Cell align="end" className="tabular-nums">
                      {line.quantity}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {formatMoney(line.unitPriceMinor)}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {`${line.vatRate} %`}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
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
          <SectionCard title="Historie změn">
            <OrderHistory currentPrincipalId={currentPrincipalId} order={order} />
          </SectionCard>
        </div>
      )}
    </SidePanel>
  );
};
