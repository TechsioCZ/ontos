// @effect-diagnostics asyncFunction:off
// Doplnění (rule-based), Pohyby (ledger + issues by month + serial lookup), Nabídky, Dodavatelé. ops-purchasing lane.
import { DetailList, SectionCard, SidePanel, foldSearchText, formatDate, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { PurchasingState, Supplier, SupplierQuote } from '../../../../../shared/domain/purchasing.ts';
import {
  addDays,
  issuesByMonth,
  materialPlanOf,
  orderTotalMinor,
} from '../../../../../shared/domain/purchasing-stock.ts';
import type { MaterialPlan } from '../../../../../shared/domain/purchasing-stock.ts';
import { draftLine } from './order-forms.tsx';
import type { DraftLine } from './order-forms.tsx';
import { failureKey, formatAmount, formatQuantity, lookupOf, todayIso, usePurchasingT } from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';
import { LevelBadge, MovementTable, TextLink } from './stock-tab.tsx';

// ── Doplnění zásob ────────────────────────────────────────────────────────────────────────────────────────────────
export const ReplenishTab = ({
  canWrite,
  onDraftOrder,
  onOpenItem,
  state,
}: {
  readonly state: PurchasingState;
  readonly canWrite: boolean;
  readonly onOpenItem: (itemId: string) => void;
  readonly onDraftOrder: (supplierId: string | undefined, lines: readonly DraftLine[]) => void;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const today = todayIso();
  const suggestions = state.items
    .map((item) => materialPlanOf(state, item, today))
    .filter((plan) => plan.suggestedQuantity > 0);
  const groups = new Map<string, MaterialPlan[]>();
  for (const plan of suggestions) {
    const key = plan.item.supplierId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), plan]);
  }
  const drafts = state.orders.filter((order) => order.status === 'draft');
  return (
    <div className="flex flex-col gap-200">
      <div className="flex flex-wrap items-center gap-100 rounded-md bg-surface-secondary p-200 text-sm">
        <Badge size="sm" variant="warning">
          {k('replenish.ruleBadge')}
        </Badge>
        <span>{k('replenish.rule')}</span>
      </div>
      {suggestions.length === 0 ? (
        <p className="text-fg-secondary text-sm">{k('replenish.none')}</p>
      ) : (
        [...groups.entries()].map(([supplierId, plans]) => {
          const supplier = lookup.supplier(supplierId);
          const draft = drafts.find((order) => order.supplierId === supplierId);
          return (
            <SectionCard
              actions={
                canWrite ? (
                  <Button
                    icon="icon-[mdi--cart-plus]"
                    onClick={() =>
                      onDraftOrder(
                        supplier?.id,
                        plans.map((plan) => draftLine(plan.item, plan.suggestedQuantity)),
                      )
                    }
                    size="sm"
                    variant="primary"
                  >
                    {k('replenish.createOrder')}
                  </Button>
                ) : undefined
              }
              key={supplierId}
              title={supplier?.name ?? t('facility-operations.common.notProvided')}
            >
              {draft !== undefined && (
                <StatusText showIcon status="warning">
                  {k('replenish.draftExists', { number: draft.number })}
                </StatusText>
              )}
              <div className="overflow-x-auto" role="region" aria-label="Doporučené doplnění zásob" tabIndex={0}>
                <Table size="sm" style={{ minWidth: '40rem' }} variant="line">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>{k('fields.item')}</Table.ColumnHeader>
                      <Table.ColumnHeader align="end">{k('fields.onHand')}</Table.ColumnHeader>
                      <Table.ColumnHeader align="end">{k('fields.projected')}</Table.ColumnHeader>
                      <Table.ColumnHeader align="end">{k('fields.minMax')}</Table.ColumnHeader>
                      <Table.ColumnHeader align="end">{k('replenish.suggested')}</Table.ColumnHeader>
                      <Table.ColumnHeader>{k('replenish.availability')}</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {plans.map((plan) => (
                      <Table.Row key={plan.item.id}>
                        <Table.Cell>
                          <TextLink onClick={() => onOpenItem(plan.item.id)}>
                            {`${plan.item.sku} · ${plan.item.name}`}
                          </TextLink>
                        </Table.Cell>
                        <Table.Cell align="end">
                          <span className="flex items-center justify-end gap-100">
                            <LevelBadge level={plan.level} />
                            {formatQuantity(plan.onHand, plan.item.unit)}
                          </span>
                        </Table.Cell>
                        <Table.Cell align="end">{formatQuantity(plan.projected, plan.item.unit)}</Table.Cell>
                        <Table.Cell align="end">{`${plan.item.minimum} / ${plan.item.maximum}`}</Table.Cell>
                        <Table.Cell align="end">
                          <span className="font-semibold tabular-nums">
                            {formatQuantity(plan.suggestedQuantity, plan.item.unit)}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          {k('replenish.leadTime', {
                            count: plan.item.leadTimeDays,
                            date: formatDate(plan.availableFrom ?? addDays(today, plan.item.leadTimeDays)),
                            days: plan.item.leadTimeDays,
                          })}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </SectionCard>
          );
        })
      )}
    </div>
  );
};

// ── Pohyby ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const MovementsTab = ({
  me,
  onOpenOrder,
  state,
}: {
  readonly state: PurchasingState;
  readonly me: PrincipalRef | undefined;
  readonly onOpenOrder: (orderId: string) => void;
}) => {
  const k = usePurchasingT();
  const lookup = lookupOf(state);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const query = foldSearchText(search.trim());
  const rows = state.movements
    .filter((movement) => {
      if (kind !== 'all' && movement.kind !== kind) {
        return false;
      }
      if (query === '') {
        return true;
      }
      const item = lookup.item(movement.itemId);
      return foldSearchText(
        [
          item?.sku,
          item?.name,
          movement.reason,
          movement.batch,
          ...(movement.serialNumbers ?? []),
          ...movement.refs.map((ref) => ref.label),
        ].join(' '),
      ).includes(query);
    })
    .toSorted((left, right) => (left.date === right.date ? 0 : left.date < right.date ? 1 : -1));
  const months = [...issuesByMonth(state.movements).entries()]
    .toSorted(([left], [right]) => (left < right ? 1 : -1))
    .slice(0, 4);
  return (
    <div className="flex flex-col gap-250">
      <SectionCard title={k('movements.byMonth')}>
        <div className="grid grid-cols-2 gap-150 sm:grid-cols-4">
          {months.map(([month, quantity]) => {
            const [year, monthNumber] = month.split('-');
            const issues = state.movements.filter(
              (movement) => movement.kind === 'issue' && movement.date.startsWith(month),
            ).length;
            return (
              <div className="flex flex-col gap-50 rounded-md bg-surface-secondary p-150" key={month}>
                <span className="text-fg-secondary text-xs">{`${monthNumber}/${year}`}</span>
                <span className="font-semibold tabular-nums">
                  {k('movements.issuedUnits', { count: quantity, units: formatNumber(quantity) })}
                </span>
                <span className="text-fg-secondary text-xs">{k('movements.issueCount', { count: issues })}</span>
              </div>
            );
          })}
        </div>
      </SectionCard>
      <div className="flex flex-wrap items-end gap-200">
        <div className="w-full max-w-sm">
          <Input
            aria-label={k('movements.search')}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={k('movements.search')}
            size="sm"
            value={search}
          />
        </div>
        <div className="w-full max-w-xs">
          <Select
            placeholder={k('placeholders.option')}
            items={['all', 'receipt', 'issue', 'transfer', 'adjustment'].map((value) => ({
              displayValue: value === 'all' ? k('movements.allKinds') : k(`movementKind.${value}`),
              label: value === 'all' ? k('movements.allKinds') : k(`movementKind.${value}`),
              value,
            }))}
            label={k('fields.kind')}
            labelProps={{ className: 'sr-only' }}
            name="movement-kind"
            onValueChange={({ value }) => setKind(value[0] ?? 'all')}
            size="sm"
            value={[kind]}
          />
        </div>
        <span className="text-fg-secondary text-sm">{k('movements.count', { count: rows.length })}</span>
      </div>
      <div className="overflow-x-auto">
        <MovementTable lookup={lookup} me={me} movements={rows} onOpenOrder={onOpenOrder} showItem />
      </div>
    </div>
  );
};

// ── Nabídky dodavatelů ────────────────────────────────────────────────────────────────────────────────────────────
const quoteVariant = { accepted: 'success', received: 'info', rejected: 'outline' } as const;

export const QuoteStatusBadge = ({ status }: { readonly status: SupplierQuote['status'] }) => {
  const k = usePurchasingT();
  return (
    <Badge size="sm" variant={quoteVariant[status]}>
      {k(`quoteStatus.${status}`)}
    </Badge>
  );
};

export const QuotesTab = ({
  onOpen,
  state,
}: {
  readonly state: PurchasingState;
  readonly onOpen: (quoteId: string) => void;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const columns: ColumnDef<SupplierQuote>[] = [
    {
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.number}</span>
          <span className="text-fg-secondary text-xs">{lookup.supplier(row.original.supplierId)?.name ?? '—'}</span>
        </div>
      ),
      header: k('fields.quote'),
      id: 'number',
    },
    { cell: ({ row }) => <QuoteStatusBadge status={row.original.status} />, header: k('fields.status'), id: 'status' },
    { cell: ({ row }) => formatDate(row.original.date), header: k('fields.quoteDate'), id: 'date' },
    {
      cell: ({ row }) =>
        row.original.validUntil === undefined
          ? t('facility-operations.common.notProvided')
          : formatDate(row.original.validUntil),
      header: k('fields.validUntil'),
      id: 'validUntil',
    },
    {
      cell: ({ row }) => k('quotes.lineCount', { count: row.original.lines.length }),
      header: k('fields.lines'),
      id: 'lines',
    },
    {
      cell: ({ row }) => (
        <span className="tabular-nums">{formatAmount(orderTotalMinor(row.original), row.original.currency)}</span>
      ),
      header: k('fields.total'),
      id: 'total',
    },
    {
      cell: ({ row }) =>
        lookup.order(row.original.purchaseOrderId)?.number ?? <span className="text-fg-secondary">—</span>,
      header: k('fields.order'),
      id: 'order',
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={state.quotes.toReversed()}
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.original.number}
      interactive
      loading={false}
      onRowClick={(row) => onOpen(row.original.id)}
      size="sm"
      translations={{ emptyDescription: k('empty.quotes'), emptyTitle: t('facility-operations.common.states.emptyTitle') }}
    />
  );
};

export const QuotePanel = ({
  canWrite,
  onClose,
  onOpenOrder,
  quoteId,
  run,
  state,
}: {
  readonly state: PurchasingState;
  readonly quoteId: string;
  readonly canWrite: boolean;
  readonly run: RunCommand;
  readonly onClose: () => void;
  readonly onOpenOrder: (orderId: string) => void;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const lookup = lookupOf(state);
  const quote = state.quotes.find((entry) => entry.id === quoteId);
  const [warehouseId, setWarehouseId] = useState(state.warehouses[0]?.id ?? '');
  const [expectedDate, setExpectedDate] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (quote === undefined) {
    return null;
  }
  const toOrder = async () => {
    setError(undefined);
    setBusy(true);
    const outcome = await run({
      _tag: 'PurchaseOrderCreateFromQuote',
      quoteId: quote.id,
      warehouseId: warehouseId as PurchasingState['warehouses'][number]['id'],
      ...(expectedDate === '' ? {} : { expectedDate }),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k('quotes.ordered'), type: 'success' });
      const orderId = outcome.result.entityIds[0];
      if (orderId !== undefined) {
        onOpenOrder(orderId);
      }
    } else {
      setError(t(failureKey(outcome.reason)));
    }
  };
  const reject = async () => {
    setBusy(true);
    const outcome = await run({ _tag: 'PurchaseQuoteReject', quoteId: quote.id });
    setBusy(false);
    setRejecting(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k('quotes.rejected'), type: 'success' });
    } else {
      setError(t(failureKey(outcome.reason)));
    }
  };
  const order = lookup.order(quote.purchaseOrderId);
  return (
    <SidePanel
      description={lookup.supplier(quote.supplierId)?.name ?? ''}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('facility-operations.common.close')}
      size="xl"
      title={k('quotes.panelTitle', { number: quote.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <QuoteStatusBadge status={quote.status} />
          <span className="font-semibold text-lg tabular-nums">
            {formatAmount(orderTotalMinor(quote), quote.currency)}
          </span>
        </div>
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        {canWrite && quote.status === 'received' && (
          <SectionCard title={k('quotes.toOrderTitle')}>
            <p className="text-fg-secondary text-sm">{k('quotes.toOrderHint')}</p>
            <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
              <Select
                placeholder={k('placeholders.warehouse')}
                items={state.warehouses.map((entry) => ({
                  displayValue: entry.name,
                  label: entry.name,
                  value: entry.id,
                }))}
                label={k('fields.deliverTo')}
                name="quote-warehouse"
                onValueChange={({ value }) => setWarehouseId(value[0] ?? warehouseId)}
                size="md"
                value={[warehouseId]}
              />
              <FormInput
                id="quote-expected"
                label={k('fields.expectedDate')}
                onChange={(event) => setExpectedDate(event.target.value)}
                type="date"
                value={expectedDate}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-100">
              {rejecting ? (
                <>
                  <span className="self-center text-sm">{k('quotes.rejectConfirm')}</span>
                  <Button onClick={() => setRejecting(false)} size="sm" theme="outlined" variant="secondary">
                    {t('facility-operations.common.cancel')}
                  </Button>
                  <Button isLoading={busy} onClick={() => void reject()} size="sm" variant="danger">
                    {k('quotes.reject')}
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => setRejecting(true)} size="sm" theme="borderless" variant="danger">
                    {k('quotes.reject')}
                  </Button>
                  <Button
                    icon="icon-[mdi--cart-arrow-right]"
                    isLoading={busy}
                    onClick={() => void toOrder()}
                    size="sm"
                    variant="primary"
                  >
                    {k('quotes.toOrder')}
                  </Button>
                </>
              )}
            </div>
          </SectionCard>
        )}
        <SectionCard title={k('orders.lines')}>
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{k('fields.item')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.quantity')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.unitPrice')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.lineTotal')}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {quote.lines.map((line) => {
                const item = lookup.item(line.itemId);
                return (
                  <Table.Row key={line.id}>
                    <Table.Cell>
                      <span className="flex flex-col">
                        <span>{line.description}</span>
                        <span className="text-fg-secondary text-xs">{item?.sku ?? k('lines.service')}</span>
                      </span>
                    </Table.Cell>
                    <Table.Cell align="end">{formatQuantity(line.quantity, item?.unit ?? '')}</Table.Cell>
                    <Table.Cell align="end">{formatAmount(line.unitPriceMinor, quote.currency)}</Table.Cell>
                    <Table.Cell align="end">
                      {formatAmount(line.unitPriceMinor * line.quantity, quote.currency)}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </SectionCard>
        <SectionCard title={k('panel.detail')}>
          <DetailList
            items={[
              { label: k('fields.supplier'), value: lookup.supplier(quote.supplierId)?.name ?? '—' },
              { label: k('fields.quoteDate'), value: formatDate(quote.date) },
              {
                label: k('fields.validUntil'),
                value:
                  quote.validUntil === undefined ? t('facility-operations.common.notProvided') : formatDate(quote.validUntil),
              },
              { label: k('fields.currency'), value: quote.currency },
              {
                label: k('fields.order'),
                value:
                  order === undefined ? '—' : <TextLink onClick={() => onOpenOrder(order.id)}>{order.number}</TextLink>,
              },
              ...(quote.note === undefined || quote.note === ''
                ? []
                : [{ label: t('facility-operations.common.note'), value: quote.note }]),
            ]}
          />
        </SectionCard>
      </div>
    </SidePanel>
  );
};

// ── Dodavatelé ────────────────────────────────────────────────────────────────────────────────────────────────────
export const SuppliersTab = ({ state }: { readonly state: PurchasingState }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const columns: ColumnDef<Supplier>[] = [
    {
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.name}</span>
          <span className="text-fg-secondary text-xs">
            {row.original.ico === undefined ? '' : `IČO ${row.original.ico}`}
          </span>
        </div>
      ),
      header: k('fields.supplierName'),
      id: 'name',
    },
    {
      cell: ({ row }) => row.original.contact ?? t('facility-operations.common.notProvided'),
      header: k('fields.contact'),
      id: 'contact',
    },
    {
      cell: ({ row }) => (
        <span className="flex flex-col text-xs">
          <span>{row.original.email ?? ''}</span>
          <span>{row.original.phone ?? ''}</span>
        </span>
      ),
      header: k('fields.email'),
      id: 'email',
    },
    {
      cell: ({ row }) =>
        row.original.leadTimeDays === undefined
          ? t('facility-operations.common.notProvided')
          : k('leadTimeDays', { count: row.original.leadTimeDays }),
      header: k('fields.leadTime'),
      id: 'lead',
    },
    {
      cell: ({ row }) => state.items.filter((item) => item.supplierId === row.original.id).length,
      header: k('suppliers.items'),
      id: 'items',
    },
    {
      cell: ({ row }) =>
        state.orders.filter((order) => order.supplierId === row.original.id && order.status !== 'cancelled').length,
      header: k('suppliers.orders'),
      id: 'orders',
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={[...state.suppliers]}
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.original.name}
      loading={false}
      size="sm"
      translations={{ emptyDescription: k('empty.suppliers'), emptyTitle: t('facility-operations.common.states.emptyTitle') }}
    />
  );
};
