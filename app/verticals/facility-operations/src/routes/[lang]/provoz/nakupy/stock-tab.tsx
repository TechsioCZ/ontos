import { optionalField } from '../../../../../shared/domain/common.ts';
import { Effect } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Zásoby (S05): item list with stock level badges + item detail panel with ledger, plan, batches and serials.
import {
  DetailList,
  EmptyState,
  SectionCard,
  SidePanel,
  foldSearchText,
  formatDate,
  surfaceTileClassName,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type {
  PurchasingState,
  StockItem,
  StockMovement,
  StockPlannedIssue,
} from '../../../../../shared/domain/purchasing.ts';
import {
  batchesInStock,
  itemMovements,
  materialPlanOf,
  onHandByWarehouse,
  serialsInStock,
} from '../../../../../shared/domain/purchasing-stock.ts';
import type { MaterialPlan, StockLevel } from '../../../../../shared/domain/purchasing-stock.ts';
import { MovementForm } from './movement-form.tsx';
import type { MovementKind } from './movement-form.tsx';
import {
  failureKey,
  parseAmountMinor,
  formatStamp,
  formatAmount,
  formatQuantity,
  lookupOf,
  principalLabel,
  todayIso,
  usePurchasingT,
} from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

const warehouseLabelKey = 'fields.warehouse';
const supplierLabelKey = 'fields.supplier';

const ALL = '__all__';

/** Inline link-styled button (wraps like text, unlike the ui-kit Button). */
export const TextLink = ({ children, onClick }: { readonly children: ReactNode; readonly onClick: () => void }) => (
  <button
    className="cursor-pointer text-left font-medium text-fg-primary underline underline-offset-2"
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

const levelBadgeVariants = { above_maximum: 'warning', below_minimum: 'danger', ok: 'success' } as const;
const movementBadgeVariants = {
  adjustment: 'warning',
  issue: 'info',
  receipt: 'success',
  transfer: 'outline',
} as const;

export const LevelBadge = ({ level }: { readonly level: StockLevel }) => {
  const k = usePurchasingT();
  const variant = levelBadgeVariants[level];
  return (
    <Badge size="sm" variant={variant}>
      {k(`level.${level}`)}
    </Badge>
  );
};

export const MovementKindBadge = ({ movement }: { readonly movement: StockMovement }) => {
  const k = usePurchasingT();
  const variant = movementBadgeVariants[movement.kind];
  return (
    <Badge size="sm" variant={variant}>
      {k(`movementKind.${movement.kind}`)}
    </Badge>
  );
};

export const RefList = ({ movement }: { readonly movement: Pick<StockMovement, 'refs'> }) => {
  const k = usePurchasingT();
  if (movement.refs.length === 0) {
    return <span className="text-fg-secondary">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-50">
      {movement.refs.map((ref) => {
        const kindLabel = k(`refKind.${ref.kind}`);
        return (
          <Badge key={`${ref.kind}:${ref.id}`} size="sm" variant="outline">
            {`${kindLabel}: ${ref.label}`}
          </Badge>
        );
      })}
    </span>
  );
};

interface StockTabProps {
  readonly onOpen: (itemId: string) => void;
  readonly state: PurchasingState;
}

const StockLookupContext = createContext<ReturnType<typeof lookupOf> | undefined>(undefined);

const StockNameCell = ({ row }: CellContext<MaterialPlan>) => {
  const k = usePurchasingT();
  const category = k(`category.${row.original.item.category}`);
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-medium">{row.original.item.name}</span>
      <span className="text-fg-secondary text-xs">{`${row.original.item.sku} · ${category}`}</span>
    </div>
  );
};

const StockWarehouseCell = ({ row }: CellContext<MaterialPlan>) => {
  const lookup = useContext(StockLookupContext);
  return lookup?.warehouse(row.original.item.warehouseId)?.code ?? '—';
};

const StockOnHandCell = ({ row }: CellContext<MaterialPlan>) => (
  <span className="font-semibold tabular-nums">{formatQuantity(row.original.onHand, row.original.item.unit)}</span>
);

const StockLimitsCell = ({ row }: CellContext<MaterialPlan>) => (
  <span className="text-fg-secondary tabular-nums">{`${row.original.item.minimum} / ${row.original.item.maximum}`}</span>
);

const StockLevelCell = ({ row }: CellContext<MaterialPlan>) => <LevelBadge level={row.original.level} />;

const StockExpectedCell = ({ row }: CellContext<MaterialPlan>) =>
  row.original.expectedReceipts > 0 ? (
    <span className="tabular-nums">{`+${formatQuantity(row.original.expectedReceipts, row.original.item.unit)}${
      row.original.nextExpectedDate === undefined ? '' : ` · ${formatDate(row.original.nextExpectedDate)}`
    }`}</span>
  ) : (
    <span className="text-fg-secondary">—</span>
  );

const StockProjectedCell = ({ row }: CellContext<MaterialPlan>) => (
  <span
    className={
      row.original.projected < row.original.item.minimum ? 'font-semibold text-fg-danger tabular-nums' : 'tabular-nums'
    }
  >
    {formatQuantity(row.original.projected, row.original.item.unit)}
  </span>
);

const StockSupplierCell = ({ row }: CellContext<MaterialPlan>) => {
  const lookup = useContext(StockLookupContext);
  const { t } = useModernI18n();
  return (
    lookup?.supplier(row.original.item.supplierId)?.name ?? (
      <span className="text-fg-secondary">{t('facility-operations.common.notProvided')}</span>
    )
  );
};

export const StockTab = ({ onOpen, state }: StockTabProps) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const [search, setSearch] = useState('');
  const [warehouse, setWarehouse] = useState(ALL);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const today = todayIso();
  const plans = state.items.map((item) => materialPlanOf(state, item, today));
  const query = foldSearchText(search.trim());
  const rows = plans.filter(
    (plan) =>
      (query === '' || foldSearchText(`${plan.item.sku} ${plan.item.name}`).includes(query)) &&
      (warehouse === ALL || plan.item.warehouseId === warehouse) &&
      (!alertsOnly || plan.level !== 'ok'),
  );
  const columns: ColumnDef<MaterialPlan>[] = [
    {
      cell: StockNameCell,
      header: k('fields.name'),
      id: 'name',
    },
    {
      cell: StockWarehouseCell,
      header: k(warehouseLabelKey),
      id: 'warehouse',
    },
    {
      cell: StockOnHandCell,
      header: k('fields.onHand'),
      id: 'onHand',
    },
    {
      cell: StockLimitsCell,
      header: k('fields.minMax'),
      id: 'minmax',
    },
    { cell: StockLevelCell, header: k('fields.level'), id: 'level' },
    {
      cell: StockExpectedCell,
      header: k('fields.expected'),
      id: 'expected',
    },
    {
      cell: StockProjectedCell,
      header: k('fields.projected'),
      id: 'projected',
    },
    {
      cell: StockSupplierCell,
      header: k(supplierLabelKey),
      id: 'supplier',
    },
  ];
  return (
    <div className="flex flex-col gap-200">
      <div className="flex flex-wrap items-end gap-200">
        <div className="w-full max-w-xs">
          <Input
            aria-label={k('filters.search')}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={k('filters.search')}
            size="sm"
            value={search}
          />
        </div>
        <div className="w-full max-w-xs">
          <Select
            items={[
              { displayValue: k('filters.allWarehouses'), label: k('filters.allWarehouses'), value: ALL },
              ...state.warehouses.map((entry) => ({ displayValue: entry.name, label: entry.name, value: entry.id })),
            ]}
            label={k(warehouseLabelKey)}
            labelProps={{ className: 'sr-only' }}
            name="warehouse-filter"
            onValueChange={({ value }) => setWarehouse(value[0] ?? ALL)}
            placeholder={k('placeholders.warehouse')}
            size="sm"
            value={[warehouse]}
          />
        </div>
        <Switch checked={alertsOnly} onCheckedChange={setAlertsOnly}>
          {k('filters.alertsOnly')}
        </Switch>
      </div>
      <StockLookupContext value={lookup}>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.item.id}
          getRowLabel={(row) => row.original.item.name}
          interactive
          loading={false}
          onRowClick={(row) => onOpen(row.original.item.id)}
          size="sm"
          translations={{
            emptyDescription: k('empty.items'),
            emptyTitle: t('facility-operations.common.states.emptyTitle'),
          }}
        />
      </StockLookupContext>
    </div>
  );
};

interface ItemPanelProps {
  readonly canWrite: boolean;
  readonly itemId: string | undefined;
  readonly me: PrincipalRef | undefined;
  readonly onClose: () => void;
  readonly onOpenOrder: (orderId: string) => void;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}

const PlanFigure = ({
  emphasis = false,
  label,
  value,
}: {
  readonly emphasis?: boolean;
  readonly label: string;
  readonly value: string;
}) => (
  <div className="flex flex-col gap-50 rounded-md bg-surface-secondary p-150">
    <span className="text-fg-secondary text-xs">{label}</span>
    <span className={emphasis ? 'font-semibold text-fg-danger tabular-nums' : 'font-semibold tabular-nums'}>
      {value}
    </span>
  </div>
);

const movementTrackingText = (movement: StockMovement, k: ReturnType<typeof usePurchasingT>) => {
  const parts: string[] = [];
  if (movement.batch !== undefined) {
    parts.push(`${k('fields.batch')} ${movement.batch}`);
  }
  if (movement.serialNumbers !== undefined && movement.serialNumbers.length > 0) {
    parts.push(`SN ${movement.serialNumbers.join(', ')}`);
  }
  return parts.join(' · ');
};

export const MovementTable = ({
  lookup,
  me,
  movements,
  onOpenOrder,
  showItem,
  unit,
}: {
  readonly lookup: ReturnType<typeof lookupOf>;
  readonly me: PrincipalRef | undefined;
  readonly movements: readonly StockMovement[];
  readonly onOpenOrder: (orderId: string) => void;
  readonly showItem: boolean;
  readonly unit?: string;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const you = t('facility-operations.common.you');
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{k('fields.date')}</Table.ColumnHeader>
          {showItem && <Table.ColumnHeader>{k('fields.item')}</Table.ColumnHeader>}
          <Table.ColumnHeader>{k('fields.kind')}</Table.ColumnHeader>
          <Table.ColumnHeader align="end">{k('fields.quantity')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k(warehouseLabelKey)}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.reason')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.refs')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.author')}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {movements.map((movement) => {
          const item = lookup.item(movement.itemId);
          const itemUnit = unit ?? item?.unit ?? '';
          const order = lookup.order(movement.purchaseOrderId);
          const warehouse =
            movement.kind === 'transfer'
              ? `${lookup.warehouse(movement.fromWarehouseId)?.code ?? ''} → ${lookup.warehouse(movement.warehouseId)?.code ?? ''}`
              : (lookup.warehouse(movement.warehouseId)?.code ?? '');
          const tracking = movementTrackingText(movement, k);
          return (
            <Table.Row key={movement.id}>
              <Table.Cell>{formatDate(movement.date)}</Table.Cell>
              {showItem && (
                <Table.Cell>
                  <span className="flex flex-col">
                    <span>{item?.name ?? '—'}</span>
                    <span className="text-fg-secondary text-xs">{item?.sku ?? ''}</span>
                  </span>
                </Table.Cell>
              )}
              <Table.Cell>
                <MovementKindBadge movement={movement} />
              </Table.Cell>
              <Table.Cell align="end">
                <span className="font-medium tabular-nums">
                  {`${movement.kind !== 'transfer' && movement.quantity > 0 ? '+' : ''}${formatQuantity(movement.quantity, itemUnit)}`}
                </span>
              </Table.Cell>
              <Table.Cell>{warehouse}</Table.Cell>
              <Table.Cell>
                <span className="flex flex-col">
                  <span>{movement.reason}</span>
                  {tracking !== '' && <span className="text-fg-secondary text-xs">{tracking}</span>}
                </span>
              </Table.Cell>
              <Table.Cell>
                <span className="flex flex-wrap items-center gap-50">
                  {order !== undefined && <TextLink onClick={() => onOpenOrder(order.id)}>{order.number}</TextLink>}
                  <RefList movement={{ refs: movement.refs.filter((ref) => ref.kind !== 'purchase_order') }} />
                </span>
              </Table.Cell>
              <Table.Cell>
                <span className="text-xs">{principalLabel(movement.createdBy, me, you)}</span>
              </Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  );
};

interface SubmitStockItemInput {
  readonly item: StockItem;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly onDone: () => void;
  readonly run: RunCommand;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly state: PurchasingState;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly values: Readonly<Record<string, string>>;
}
const submitStockItem = Effect.fn('FacilityOperations.Purchasing.submitStockItem')(function* updateStockItem(
  input: SubmitStockItemInput,
) {
  const { item, k, onDone, run, setBusy, setError, state, t, toast, values } = input;
  setError(undefined);
  const minimum = Number(values['minimum']);
  const maximum = Number(values['maximum']);
  const lead = Number(values['leadTimeDays']);
  const name = (values['name'] ?? '').trim();
  if (name === '' || ![minimum, maximum, lead].every((entry) => Number.isInteger(entry) && entry >= 0)) {
    setError(t('facility-operations.common.required'));
    return;
  }
  if (maximum > 0 && maximum < minimum) {
    setError(k('items.maxBelowMin'));
    return;
  }
  const supplier = state.suppliers.find((entry) => entry.id === values['supplierId']);
  setBusy(true);
  const outcome = yield* run({
    _tag: 'StockItemUpdate',
    itemId: item.id,
    leadTimeDays: lead,
    maximum,
    minimum,
    name,
    note: (values['note'] ?? '').trim(),
    ...optionalField('supplierId', supplier?.id),
    ...optionalField('lastPriceMinor', parseAmountMinor(values['price'] ?? '')),
  });
  setBusy(false);
  if (outcome.ok) {
    toast.create({ duration: 5000, title: t('facility-operations.common.saved'), type: 'success' });
    onDone();
  } else {
    setError(t(failureKey(outcome.reason)));
  }
});

const ItemEditForm = ({
  item,
  onDone,
  run,
  state,
}: {
  readonly item: StockItem;
  readonly onDone: () => void;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({
    leadTimeDays: String(item.leadTimeDays),
    maximum: String(item.maximum),
    minimum: String(item.minimum),
    name: item.name,
    note: item.note ?? '',
    price: item.lastPriceMinor === undefined ? '' : String(item.lastPriceMinor / 100),
    supplierId: item.supplierId ?? 'none',
  });
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const set = (name: string, next: string) => setValues((current) => ({ ...current, [name]: next }));
  const submit = () => submitStockItem({ item, k, onDone, run, setBusy, setError, state, t, toast, values });
  const input = (name: string, label: string, numeric = false) => (
    <FormInput
      id={`item-edit-${name}`}
      inputMode={numeric ? 'numeric' : undefined}
      label={label}
      maxLength={200}
      onChange={(event) => set(name, event.target.value)}
      value={values[name] ?? ''}
    />
  );
  return (
    <SectionCard title={k('items.editTitle')}>
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      {input('name', k('fields.name'))}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
        {input('minimum', k('fields.minimum'), true)}
        {input('maximum', k('fields.maximum'), true)}
        {input('leadTimeDays', k('fields.leadTimeDays'), true)}
      </div>
      {input('price', k('fields.lastPriceCzk'), true)}
      <Select
        items={state.suppliers.map((entry) => ({ displayValue: entry.name, label: entry.name, value: entry.id }))}
        label={k(supplierLabelKey)}
        name="item-edit-supplier"
        onValueChange={({ value }) => set('supplierId', value[0] ?? 'none')}
        placeholder={k('placeholders.supplier')}
        size="md"
        value={values['supplierId'] === 'none' ? [] : [values['supplierId'] ?? '']}
      />
      {input('note', t('facility-operations.common.note'))}
      <div className="flex justify-end gap-100">
        <Button onClick={onDone} size="sm" theme="outlined" variant="secondary">
          {t('facility-operations.common.cancel')}
        </Button>
        <Button
          isLoading={busy}
          loadingText={t('facility-operations.common.saving')}
          onClick={() => {
            browserRuntime.runFork(submit());
          }}
          size="sm"
          variant="primary"
        >
          {t('facility-operations.common.save')}
        </Button>
      </div>
    </SectionCard>
  );
};

const cancelPlannedIssue = Effect.fn('FacilityOperations.Purchasing.cancelPlannedIssue')(function* cancelPlannedIssue(
  run: RunCommand,
  entry: StockPlannedIssue,
  onFailure: (reason: Parameters<typeof failureKey>[0]) => void,
) {
  const outcome = yield* run({ _tag: 'StockPlannedIssueCancel', plannedIssueId: entry.id });
  if (!outcome.ok) {
    onFailure(outcome.reason);
  }
});
interface ItemPlanSectionProps {
  readonly canWrite: boolean;
  readonly item: StockItem;
  readonly onIssuePlanned: (entry: StockPlannedIssue) => void;
  readonly plan: MaterialPlan;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}
const ItemPlanSection = ({ canWrite, item, onIssuePlanned, plan, run, state }: ItemPlanSectionProps) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const planned = state.plannedIssues.filter((entry) => entry.itemId === item.id && entry.status === 'planned');
  return (
    <SectionCard title={k('panel.plan')}>
      <div className="grid grid-cols-2 gap-150">
        <PlanFigure label={k('fields.onHand')} value={formatQuantity(plan.onHand, item.unit)} />
        <PlanFigure label={k('plan.expected')} value={`+ ${formatQuantity(plan.expectedReceipts, item.unit)}`} />
        <PlanFigure label={k('plan.plannedIssues')} value={`− ${formatQuantity(plan.plannedIssues, item.unit)}`} />
        <PlanFigure
          emphasis={plan.projected < item.minimum}
          label={k('fields.projected')}
          value={`= ${formatQuantity(plan.projected, item.unit)}`}
        />
      </div>
      {plan.availableFrom !== undefined && (
        <p className="text-sm">
          {k('plan.availableFrom', {
            count: item.leadTimeDays,
            date: formatDate(plan.availableFrom),
            lead: item.leadTimeDays,
          })}
        </p>
      )}
      {plan.suggestedQuantity > 0 && (
        <p className="flex flex-wrap items-center gap-100 text-sm">
          <Badge size="sm" variant="warning">
            {k('replenish.ruleBadge')}
          </Badge>
          {k('plan.suggest', { quantity: formatQuantity(plan.suggestedQuantity, item.unit) })}
        </p>
      )}
      {planned.length > 0 && (
        <div className="flex flex-col gap-100">
          <span className="text-fg-secondary text-xs">{k('plan.plannedIssues')}</span>
          {planned.map((entry) => (
            <div
              className={`${surfaceTileClassName} flex flex-wrap items-center justify-between gap-150 p-150 text-sm`}
              key={entry.id}
            >
              <div className="flex min-w-0 flex-col gap-50">
                <span className="font-medium">{`${formatDate(entry.date)} · ${formatQuantity(entry.quantity, item.unit)}`}</span>
                <span className="text-fg-secondary">{entry.reason}</span>
                <RefList movement={entry} />
              </div>
              {canWrite && (
                <div className="flex gap-50">
                  <Button onClick={() => onIssuePlanned(entry)} size="sm" theme="outlined" variant="secondary">
                    {k('actions.issuePlanned')}
                  </Button>
                  <Button
                    onClick={() => {
                      browserRuntime.runFork(
                        cancelPlannedIssue(run, entry, (reason) => {
                          toast.create({ title: t(failureKey(reason)), type: 'error' });
                        }),
                      );
                    }}
                    size="sm"
                    theme="borderless"
                    variant="secondary"
                  >
                    {k('actions.cancelPlanned')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
};

interface StockItemDetailsProps {
  readonly item: StockItem;
  readonly me: PrincipalRef | undefined;
  readonly state: PurchasingState;
}
const StockItemDetails = ({ item, me, state }: StockItemDetailsProps) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const perWarehouse = [...onHandByWarehouse(state, item.id).entries()].filter(([, quantity]) => quantity !== 0);
  const serials = [...serialsInStock(state, item.id).entries()];
  const batches = batchesInStock(state, item.id);
  const you = t('facility-operations.common.you');
  return (
    <>
      <SectionCard title={k('panel.detail')}>
        <DetailList
          items={[
            { label: k(warehouseLabelKey), value: lookup.warehouse(item.warehouseId)?.name ?? '—' },
            { label: k('fields.unit'), value: item.unit },
            { label: k('fields.minMax'), value: `${item.minimum} / ${item.maximum} ${item.unit}` },
            { label: k('fields.leadTime'), value: k('leadTimeDays', { count: item.leadTimeDays }) },
            {
              label: k(supplierLabelKey),
              value: lookup.supplier(item.supplierId)?.name ?? t('facility-operations.common.notProvided'),
            },
            {
              label: k('fields.lastPrice'),
              value:
                item.lastPriceMinor === undefined
                  ? t('facility-operations.common.noData')
                  : formatAmount(item.lastPriceMinor),
            },
            { label: k('fields.tracking'), value: k(`tracking.${item.tracking}`) },
            ...(item.note === undefined || item.note === ''
              ? []
              : [{ label: t('facility-operations.common.note'), value: item.note }]),
            {
              label: t('facility-operations.common.updatedAt'),
              value: `${formatStamp(item.updatedAt)} · ${principalLabel(item.updatedBy, me, you)}`,
            },
          ]}
        />
      </SectionCard>
      <SectionCard title={k('panel.byWarehouse')}>
        {perWarehouse.length === 0 ? (
          <p className="text-fg-secondary text-sm">{k('empty.noStock')}</p>
        ) : (
          <ul className="flex flex-col gap-50 text-sm">
            {perWarehouse.map(([warehouseId, quantity]) => (
              <li className="flex justify-between gap-200" key={warehouseId}>
                <span>{lookup.warehouse(warehouseId)?.name ?? warehouseId}</span>
                <span className="font-medium tabular-nums">{formatQuantity(quantity, item.unit)}</span>
              </li>
            ))}
          </ul>
        )}
        {batches.length > 0 && (
          <div className="flex flex-col gap-50">
            <span className="text-fg-secondary text-xs">{k('panel.batches')}</span>
            <div className="flex flex-wrap gap-50">
              {batches.map((entry) => (
                <Badge key={`${entry.batch}-${entry.warehouseId}`} size="sm" variant="outline">
                  {`${entry.batch} · ${formatQuantity(entry.quantity, item.unit)} · ${lookup.warehouse(entry.warehouseId)?.code ?? ''}`}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {item.tracking === 'serial' && (
          <div className="flex flex-col gap-50">
            <span className="text-fg-secondary text-xs">{k('panel.serials')}</span>
            <div className="flex flex-wrap gap-50">
              {serials.length === 0 ? (
                <span className="text-fg-secondary text-sm">{k('movement.noSerials')}</span>
              ) : (
                serials.map(([serial, warehouseId]) => (
                  <Badge key={serial} size="sm" variant="info">
                    {`${serial} · ${lookup.warehouse(warehouseId)?.code ?? ''}`}
                  </Badge>
                ))
              )}
            </div>
          </div>
        )}
      </SectionCard>
    </>
  );
};

export const ItemPanel = ({ canWrite, itemId, me, onClose, onOpenOrder, run, state }: ItemPanelProps) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const [form, setForm] = useState<{ readonly kind: MovementKind; readonly planned?: StockPlannedIssue } | undefined>();
  const [editing, setEditing] = useState(false);
  const item: StockItem | undefined = state.items.find((entry) => entry.id === itemId);
  const close = () => {
    setForm(undefined);
    setEditing(false);
    onClose();
  };
  if (item === undefined) {
    return (
      <SidePanel
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
        open={false}
        resizeLabel={t('facility-operations.common.close')}
        title=""
      />
    );
  }
  const category = k(`category.${item.category}`);
  const plan = materialPlanOf(state, item, todayIso());
  const movements = itemMovements(state, item.id).toReversed();
  return (
    <SidePanel
      closeOnInteractOutside={form === undefined && !editing}
      description={`${item.sku} · ${category}`}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
      resizeLabel={t('facility-operations.common.close')}
      size="xl"
      title={item.name}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <span className="font-semibold text-2xl tabular-nums">{formatQuantity(plan.onHand, item.unit)}</span>
          <LevelBadge level={plan.level} />
          {item.tracking !== 'none' && (
            <Badge size="sm" variant="info">
              {k(`tracking.${item.tracking}`)}
            </Badge>
          )}
        </div>
        {canWrite && form === undefined && !editing && (
          <div className="flex flex-wrap gap-100">
            <Button
              icon="icon-[mdi--package-down]"
              onClick={() => setForm({ kind: 'receipt' })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.receipt')}
            </Button>
            <Button
              icon="icon-[mdi--package-up]"
              onClick={() => setForm({ kind: 'issue' })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.issue')}
            </Button>
            <Button
              icon="icon-[mdi--swap-horizontal]"
              onClick={() => setForm({ kind: 'transfer' })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.transfer')}
            </Button>
            <Button
              icon="icon-[mdi--scale-balance]"
              onClick={() => setForm({ kind: 'adjustment' })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.adjustment')}
            </Button>
            <Button
              icon="icon-[mdi--calendar-clock]"
              onClick={() => setForm({ kind: 'planned' })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.planned')}
            </Button>
            <Button
              icon="icon-[mdi--pencil]"
              onClick={() => setEditing(true)}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              {k('actions.edit')}
            </Button>
          </div>
        )}
        {editing && <ItemEditForm item={item} onDone={() => setEditing(false)} run={run} state={state} />}
        {form !== undefined && (
          <MovementForm
            item={item}
            kind={form.kind}
            onDone={() => setForm(undefined)}
            run={run}
            state={state}
            {...(form.planned === undefined ? {} : { planned: form.planned })}
          />
        )}
        <ItemPlanSection
          canWrite={canWrite}
          item={item}
          onIssuePlanned={(entry) => setForm({ kind: 'issue', planned: entry })}
          plan={plan}
          run={run}
          state={state}
        />
        <StockItemDetails item={item} me={me} state={state} />
        <SectionCard title={k('panel.movements', { count: movements.length })}>
          {movements.length === 0 ? (
            <EmptyState title={k('empty.movements')} />
          ) : (
            <MovementTable
              lookup={lookupOf(state)}
              me={me}
              movements={movements}
              onOpenOrder={onOpenOrder}
              showItem={false}
              unit={item.unit}
            />
          )}
        </SectionCard>
      </div>
    </SidePanel>
  );
};
