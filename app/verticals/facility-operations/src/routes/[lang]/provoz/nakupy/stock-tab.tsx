import { optionalField } from '../../../../../shared/domain/common.ts';
import { Effect, Option, Schema } from 'effect';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Zásoby (S05): item list with stock level badges + item detail panel with ledger, plan, batches and serials.
import {
  DetailList,
  EmptyState,
  SaveBar,
  SectionCard,
  SidePanel,
  UnsavedChangesDialog,
  foldSearchText,
  formatDate,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  BareTextField,
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  SwitchField,
  TemplateChoiceField,
  TextField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { useEditGuard } from '../../../../ui/edit-guard.tsx';
import { facilitySaveOutcome } from '../../../../ui/facility-save.ts';
import { useFormValues } from '../../../../ui/form-values.tsx';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
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

/** The filters over the stock list; they act as they change, so Enter sends nothing. */
const stockFilterForm = FormReact.make(
  FormBuilder.empty
    .addField('alertsOnly', Schema.Boolean)
    .addField('search', Schema.String)
    .addField('warehouse', Schema.String),
  {
    fields: { alertsOnly: SwitchField, search: BareTextField, warehouse: TemplateChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noStockFilters = { alertsOnly: false, search: '', warehouse: ALL };

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
  transfer: 'neutral',
} as const;

export const LevelBadge = ({ level }: { readonly level: StockLevel }) => {
  const k = usePurchasingT();
  const variant = levelBadgeVariants[level];
  return (
    <Badge severity={variant} size="sm">
      {k(`level.${level}`)}
    </Badge>
  );
};

export const MovementKindBadge = ({ movement }: { readonly movement: StockMovement }) => {
  const k = usePurchasingT();
  const variant = movementBadgeVariants[movement.kind];
  return (
    <Badge severity={variant} size="sm">
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
          <Badge appearance="outline" key={`${ref.kind}:${ref.id}`} severity="neutral" size="sm">
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
  const { alertsOnly, search, warehouse } = Option.getOrElse(
    useAtomValue(stockFilterForm.values),
    () => noStockFilters,
  );
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
      <FormRoot
        className="flex flex-wrap items-end gap-200"
        defaultValues={noStockFilters}
        form={stockFilterForm}
        translateMessage={(message) => t(message)}
      >
        <div className="w-full max-w-xs">
          <stockFilterForm.search aria-label={k('filters.search')} placeholder={k('filters.search')} size="sm" />
        </div>
        <div className="w-full max-w-xs">
          <stockFilterForm.warehouse
            items={[
              { label: k('filters.allWarehouses'), value: ALL },
              ...state.warehouses.map((entry) => ({ label: entry.name, value: entry.id })),
            ]}
            label={k(warehouseLabelKey)}
            labelProps={{ className: 'sr-only' }}
            placeholder={k('placeholders.warehouse')}
            size="sm"
          />
        </div>
        <stockFilterForm.alertsOnly>{k('filters.alertsOnly')}</stockFilterForm.alertsOnly>
      </FormRoot>
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
    <Table appearance="line" size="sm">
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

/**
 * The edit of one stock item, as typed; no supplier is `""`. Uložit sends it through the draft save, so the form only
 * holds the values and Enter sends nothing. One item panel is open at a time, so one form serves every item.
 */
const itemEditForm = FormReact.make(
  FormBuilder.empty
    .addField('leadTimeDays', Schema.String)
    .addField('maximum', Schema.String)
    .addField('minimum', Schema.String)
    .addField('name', Schema.String)
    .addField('note', Schema.String)
    .addField('price', Schema.String)
    .addField('supplierId', Schema.String),
  {
    fields: {
      leadTimeDays: TextField,
      maximum: TextField,
      minimum: TextField,
      name: TextField,
      note: TextField,
      price: TextField,
      supplierId: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type ItemEditDraft = typeof itemEditForm.schema.Encoded;

const itemEditDraftOf = (item: StockItem): ItemEditDraft => ({
  leadTimeDays: String(item.leadTimeDays),
  maximum: String(item.maximum),
  minimum: String(item.minimum),
  name: item.name,
  note: item.note ?? '',
  price: item.lastPriceMinor === undefined ? '' : String(item.lastPriceMinor / 100),
  supplierId: item.supplierId ?? '',
});

const itemEditFields = ['leadTimeDays', 'maximum', 'minimum', 'name', 'note', 'price', 'supplierId'] as const;
const sameItemEditDraft = (left: ItemEditDraft, right: ItemEditDraft): boolean =>
  itemEditFields.every((field) => left[field] === right[field]);

/** Why the draft cannot be saved: a missing name or count, or a maximum below the minimum. */
const itemEditProblem = (values: ItemEditDraft): 'maxBelowMin' | 'required' | undefined => {
  const minimum = Number(values.minimum);
  const maximum = Number(values.maximum);
  const lead = Number(values.leadTimeDays);
  if (values.name.trim() === '' || ![minimum, maximum, lead].every((entry) => Number.isInteger(entry) && entry >= 0)) {
    return 'required';
  }
  return maximum > 0 && maximum < minimum ? 'maxBelowMin' : undefined;
};

const stockItemCommandOf = (
  values: ItemEditDraft,
  item: StockItem,
  state: PurchasingState,
): Option.Option<OpsCommand> => {
  if (itemEditProblem(values) !== undefined) {
    return Option.none();
  }
  const supplier = state.suppliers.find((entry) => entry.id === values.supplierId);
  return Option.some({
    _tag: 'StockItemUpdate',
    itemId: item.id,
    leadTimeDays: Number(values.leadTimeDays),
    maximum: Number(values.maximum),
    minimum: Number(values.minimum),
    name: values.name.trim(),
    note: values.note.trim(),
    ...optionalField('supplierId', supplier?.id),
    ...optionalField('lastPriceMinor', parseAmountMinor(values.price)),
  });
};

/**
 * Edit of one stock item inside its panel, against the read it was opened from: nothing is sent until Uložit, a
 * newer change by someone else refuses the save, and "Načíst nejnovější" loads it. `item` is the live record.
 */
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
  const { language, t } = useModernI18n();
  const shown = useFormValues(itemEditForm, itemEditDraftOf(item));
  const { values } = shown;
  const setValues = useAtomSet(itemEditForm.setValues);
  const toast = useToast();
  // Why the last save failed, in the agenda's words; the save bar shows it while the save is failed.
  const [error, setError] = useState<string | null>(null);
  const answered = (outcome: CommandOutcome) =>
    Effect.sync(() => {
      setError(outcome.ok ? null : t(failureKey(outcome.reason)));
      if (outcome.ok) {
        toast.create({ duration: 5000, title: t('facility-operations.common.saved'), type: 'success' });
      }
    });
  // Saves carry the revision of the read the draft was built on, so someone else's newer change refuses them.
  const base = useDraftBase(item, run);
  const record = useDraftSave<ItemEditDraft, never>({
    equals: sameItemEditDraft,
    isValid: (value) => itemEditProblem(value) === undefined,
    runtime: browserRuntime,
    save: (value) =>
      Option.match(stockItemCommandOf(value, item, state), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => base.confirm(facilitySaveOutcome(base.run(command).pipe(Effect.tap(answered)))),
      }),
    value: values,
  });
  base.sync({
    onAdopt: () => {
      const stored = itemEditDraftOf(item);
      if (!sameItemEditDraft(stored, values)) {
        record.adopt(stored);
        setValues(stored);
      }
    },
    settled: !record.pending && sameItemEditDraft(values, record.confirmed),
  });
  const guard = useEditGuard(record, () => {
    setValues(record.confirmed);
  });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onDone();
      }
    });
  };
  const handleReloadLatest = () => {
    const current = itemEditDraftOf(item);
    base.rebase();
    record.adopt(current);
    setValues(current);
  };
  const problem = record.status === 'invalid' ? itemEditProblem(values) : undefined;
  return (
    <SectionCard title={k('items.editTitle')}>
      {problem !== undefined && (
        <StatusText showIcon status="error">
          {problem === 'required' ? t('facility-operations.common.required') : k('items.maxBelowMin')}
        </StatusText>
      )}
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={itemEditDraftOf(item)}
        form={itemEditForm}
        key={item.id}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <itemEditForm.name id="item-edit-name" label={k('fields.name')} maxLength={200} />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
          <itemEditForm.minimum
            id="item-edit-minimum"
            inputMode="numeric"
            label={k('fields.minimum')}
            maxLength={200}
          />
          <itemEditForm.maximum
            id="item-edit-maximum"
            inputMode="numeric"
            label={k('fields.maximum')}
            maxLength={200}
          />
          <itemEditForm.leadTimeDays
            id="item-edit-leadTimeDays"
            inputMode="numeric"
            label={k('fields.leadTimeDays')}
            maxLength={200}
          />
        </div>
        <itemEditForm.price id="item-edit-price" inputMode="numeric" label={k('fields.lastPriceCzk')} maxLength={200} />
        <itemEditForm.supplierId
          items={state.suppliers.map((entry) => ({ label: entry.name, value: entry.id }))}
          label={k(supplierLabelKey)}
          placeholder={k('placeholders.supplier')}
        />
        <itemEditForm.note id="item-edit-note" label={t('facility-operations.common.note')} maxLength={200} />
      </FormRoot>
      <div className="flex flex-wrap items-center justify-end gap-100">
        <Button appearance="outline" onClick={() => guard.request(onDone)} severity="secondary" size="sm">
          {t('facility-operations.common.cancel')}
        </Button>
        <SaveBar
          error={error}
          labels={labels}
          onReloadLatest={handleReloadLatest}
          onSave={handleSave}
          size="sm"
          status={record.status}
        />
      </div>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
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
          <Badge severity="warning" size="sm">
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
                  <Button appearance="outline" onClick={() => onIssuePlanned(entry)} severity="secondary" size="sm">
                    {k('actions.issuePlanned')}
                  </Button>
                  <Button
                    appearance="ghost"
                    onClick={() => {
                      browserRuntime.runFork(
                        cancelPlannedIssue(run, entry, (reason) => {
                          toast.create({ title: t(failureKey(reason)), type: 'error' });
                        }),
                      );
                    }}
                    severity="secondary"
                    size="sm"
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
                <span>{lookup.warehouse(warehouseId)?.name ?? '—'}</span>
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
                <Badge appearance="outline" key={`${entry.batch}-${entry.warehouseId}`} severity="neutral" size="sm">
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
                  <Badge key={serial} severity="info" size="sm">
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
            <Badge severity="info" size="sm">
              {k(`tracking.${item.tracking}`)}
            </Badge>
          )}
        </div>
        {canWrite && form === undefined && !editing && (
          <div className="flex flex-wrap gap-100">
            <Button
              appearance="outline"
              icon="icon-[mdi--package-down]"
              onClick={() => setForm({ kind: 'receipt' })}
              severity="secondary"
              size="sm"
            >
              {k('actions.receipt')}
            </Button>
            <Button
              appearance="outline"
              icon="icon-[mdi--package-up]"
              onClick={() => setForm({ kind: 'issue' })}
              severity="secondary"
              size="sm"
            >
              {k('actions.issue')}
            </Button>
            <Button
              appearance="outline"
              icon="icon-[mdi--swap-horizontal]"
              onClick={() => setForm({ kind: 'transfer' })}
              severity="secondary"
              size="sm"
            >
              {k('actions.transfer')}
            </Button>
            <Button
              appearance="outline"
              icon="icon-[mdi--scale-balance]"
              onClick={() => setForm({ kind: 'adjustment' })}
              severity="secondary"
              size="sm"
            >
              {k('actions.adjustment')}
            </Button>
            <Button
              appearance="outline"
              icon="icon-[mdi--calendar-clock]"
              onClick={() => setForm({ kind: 'planned' })}
              severity="secondary"
              size="sm"
            >
              {k('actions.planned')}
            </Button>
            <Button
              appearance="ghost"
              icon="icon-[mdi--pencil]"
              onClick={() => setEditing(true)}
              severity="secondary"
              size="sm"
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
