import type { IsoDate } from '../../../../../shared/domain/common.ts';
import { Effect, Option, Schema } from 'effect';
import { FormSaveFooter, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useFormValues } from '../../../../ui/form-values.tsx';
// Doplnění (rule-based), Pohyby (ledger + issues by month + serial lookup), Nabídky, Dodavatelé. ops-purchasing lane.
import {
  DetailList,
  ScrollRegion,
  SectionCard,
  SidePanel,
  UnsavedChangesDialog,
  foldSearchText,
  formatDate,
  formatNumber,
} from '@app/admin-ui';
import {
  BareTextField,
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  TemplateChoiceField,
  TextField,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
import { createContext, useContext, useState } from 'react';
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

const notProvidedKey = 'facility-operations.common.notProvided';

// ── Doplnění zásob ────────────────────────────────────────────────────────────────────────────────────────────────
export const ReplenishTab = ({
  canWrite,
  onDraftOrder,
  onOpenItem,
  state,
}: {
  readonly canWrite: boolean;
  readonly onDraftOrder: (supplierId: string | undefined, lines: readonly DraftLine[]) => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const today = todayIso();
  const suggestions = state.items.flatMap((item) => {
    const plan = materialPlanOf(state, item, today);
    return plan.suggestedQuantity > 0 ? [plan] : [];
  });
  const groups = new Map<string, MaterialPlan[]>();
  for (const plan of suggestions) {
    const key = plan.item.supplierId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), plan]);
  }
  const drafts = state.orders.filter((order) => order.status === 'draft');
  return (
    <div className="flex flex-col gap-200">
      <div className="flex flex-wrap items-center gap-100 rounded-md bg-surface-secondary p-200 text-sm">
        <Badge severity="warning" size="sm">
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
                        plans.map((plan) => draftLine(plan.item.id, plan.item, plan.suggestedQuantity)),
                      )
                    }
                    severity="primary"
                    size="sm"
                  >
                    {k('replenish.createOrder')}
                  </Button>
                ) : undefined
              }
              key={supplierId}
              title={supplier?.name ?? t(notProvidedKey)}
            >
              {draft !== undefined && (
                <StatusText showIcon status="warning">
                  {k('replenish.draftExists', { number: draft.number })}
                </StatusText>
              )}
              <ScrollRegion label={t('facility-operations.ui.recommendedReplenishment')}>
                <Table appearance="line" size="sm" style={{ minWidth: '40rem' }}>
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
              </ScrollRegion>
            </SectionCard>
          );
        })
      )}
    </div>
  );
};

// ── Pohyby ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The filters over the movement ledger; they act as they change, so Enter sends nothing. */
const movementFilterForm = FormReact.make(
  FormBuilder.empty.addField('kind', Schema.String).addField('search', Schema.String),
  {
    fields: { kind: TemplateChoiceField, search: BareTextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noMovementFilters = { kind: 'all', search: '' };

export const MovementsTab = ({
  me,
  onOpenOrder,
  state,
}: {
  readonly me: PrincipalRef | undefined;
  readonly onOpenOrder: (orderId: string) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const { kind, search } = Option.getOrElse(useAtomValue(movementFilterForm.values), () => noMovementFilters);
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
    .toSorted((left, right) => {
      if (left.date === right.date) {
        return 0;
      }
      return left.date < right.date ? 1 : -1;
    });
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
      <FormRoot
        className="flex flex-wrap items-end gap-200"
        defaultValues={noMovementFilters}
        form={movementFilterForm}
        translateMessage={(message) => t(message)}
      >
        <div className="w-full max-w-sm">
          <movementFilterForm.search aria-label={k('movements.search')} placeholder={k('movements.search')} size="sm" />
        </div>
        <div className="w-full max-w-xs">
          <movementFilterForm.kind
            items={['all', 'receipt', 'issue', 'transfer', 'adjustment'].map((value) => ({
              label: value === 'all' ? k('movements.allKinds') : k(`movementKind.${value}`),
              value,
            }))}
            label={k('fields.kind')}
            labelProps={{ className: 'sr-only' }}
            placeholder={k('placeholders.option')}
            size="sm"
          />
        </div>
        <span className="text-fg-secondary text-sm">{k('movements.count', { count: rows.length })}</span>
      </FormRoot>
      <div className="overflow-x-auto">
        <MovementTable lookup={lookup} me={me} movements={rows} onOpenOrder={onOpenOrder} showItem />
      </div>
    </div>
  );
};

// ── Nabídky dodavatelů ────────────────────────────────────────────────────────────────────────────────────────────
const quoteVariant = { accepted: 'success', received: 'info', rejected: 'neutral' } as const;

export const QuoteStatusBadge = ({ status }: { readonly status: SupplierQuote['status'] }) => {
  const k = usePurchasingT();
  return (
    <Badge severity={quoteVariant[status]} size="sm">
      {k(`quoteStatus.${status}`)}
    </Badge>
  );
};

const QuoteLookupContext = createContext<ReturnType<typeof lookupOf> | undefined>(undefined);
const SupplierStateContext = createContext<PurchasingState | undefined>(undefined);

const QuoteNumberCell = ({ row }: CellContext<SupplierQuote>) => {
  const lookup = useContext(QuoteLookupContext);
  return (
    <div className="flex flex-col">
      <span className="font-medium">{row.original.number}</span>
      <span className="text-fg-secondary text-xs">{lookup?.supplier(row.original.supplierId)?.name ?? '—'}</span>
    </div>
  );
};

const QuoteStatusCell = ({ row }: CellContext<SupplierQuote>) => <QuoteStatusBadge status={row.original.status} />;

const QuoteDateCell = ({ row }: CellContext<SupplierQuote>) => formatDate(row.original.date);

const QuoteValidityCell = ({ row }: CellContext<SupplierQuote>) => {
  const { t } = useModernI18n();
  return row.original.validUntil === undefined ? t(notProvidedKey) : formatDate(row.original.validUntil);
};

const QuoteLinesCell = ({ row }: CellContext<SupplierQuote>) => {
  const k = usePurchasingT();
  return k('quotes.lineCount', { count: row.original.lines.length });
};

const QuoteTotalCell = ({ row }: CellContext<SupplierQuote>) => (
  <span className="tabular-nums">{formatAmount(orderTotalMinor(row.original), row.original.currency)}</span>
);

const QuoteOrderCell = ({ row }: CellContext<SupplierQuote>) => {
  const lookup = useContext(QuoteLookupContext);
  return lookup?.order(row.original.purchaseOrderId)?.number ?? <span className="text-fg-secondary">—</span>;
};

const SupplierNameCell = ({ row }: CellContext<Supplier>) => (
  <div className="flex flex-col">
    <span className="font-medium">{row.original.name}</span>
    <span className="text-fg-secondary text-xs">{row.original.ico === undefined ? '' : `IČO ${row.original.ico}`}</span>
  </div>
);

const SupplierContactCell = ({ row }: CellContext<Supplier>) => {
  const { t } = useModernI18n();
  return row.original.contact ?? t(notProvidedKey);
};

const SupplierEmailCell = ({ row }: CellContext<Supplier>) => (
  <span className="flex flex-col text-xs">
    <span>{row.original.email ?? ''}</span>
    <span>{row.original.phone ?? ''}</span>
  </span>
);

const SupplierLeadCell = ({ row }: CellContext<Supplier>) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  return row.original.leadTimeDays === undefined
    ? t(notProvidedKey)
    : k('leadTimeDays', { count: row.original.leadTimeDays });
};

const SupplierItemsCell = ({ row }: CellContext<Supplier>) => {
  const state = useContext(SupplierStateContext);
  return state?.items.filter((item) => item.supplierId === row.original.id).length ?? 0;
};

const SupplierOrdersCell = ({ row }: CellContext<Supplier>) => {
  const state = useContext(SupplierStateContext);
  return (
    state?.orders.filter((order) => order.supplierId === row.original.id && order.status !== 'cancelled').length ?? 0
  );
};

export const QuotesTab = ({
  onOpen,
  state,
}: {
  readonly onOpen: (quoteId: string) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const columns: ColumnDef<SupplierQuote>[] = [
    {
      cell: QuoteNumberCell,
      header: k('fields.quote'),
      id: 'number',
    },
    { cell: QuoteStatusCell, header: k('fields.status'), id: 'status' },
    { cell: QuoteDateCell, header: k('fields.quoteDate'), id: 'date' },
    {
      cell: QuoteValidityCell,
      header: k('fields.validUntil'),
      id: 'validUntil',
    },
    {
      cell: QuoteLinesCell,
      header: k('fields.lines'),
      id: 'lines',
    },
    {
      cell: QuoteTotalCell,
      header: k('fields.total'),
      id: 'total',
    },
    {
      cell: QuoteOrderCell,
      header: k('fields.order'),
      id: 'order',
    },
  ];
  return (
    <QuoteLookupContext value={lookup}>
      <DataTable
        columns={columns}
        data={state.quotes.toReversed()}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.original.number}
        interactive
        loading={false}
        onRowClick={(row) => onOpen(row.original.id)}
        size="sm"
        translations={{
          emptyDescription: k('empty.quotes'),
          emptyTitle: t('facility-operations.common.states.emptyTitle'),
        }}
      />
    </QuoteLookupContext>
  );
};

/**
 * The order a received quote becomes. Uložit sends it through the form save, so Enter sends nothing. One quote panel is
 * open at a time.
 */
const quoteToOrderForm = FormReact.make(
  FormBuilder.empty.addField('expectedDate', Schema.String).addField('warehouseId', Schema.String),
  {
    fields: { expectedDate: TextField, warehouseId: ChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

interface SubmitOrderFromQuoteInput {
  readonly expectedDate: IsoDate;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly onOpenOrder: (id: string) => void;
  readonly quote: SupplierQuote;
  readonly run: RunCommand;
  readonly setError: (value: string | undefined) => void;
  readonly state: PurchasingState;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
  readonly warehouseId: string;
}
const submitOrderFromQuote = Effect.fn('FacilityOperations.Purchasing.submitOrderFromQuote')(
  function* createOrderFromQuote(input: SubmitOrderFromQuoteInput) {
    const { expectedDate, k, onOpenOrder, quote, run, setError, state, t, toast, warehouseId } = input;
    setError(undefined);
    const warehouse = state.warehouses.find((entry) => entry.id === warehouseId);
    if (warehouse === undefined) {
      setError(t('facility-operations.common.required'));
      return 'failed' as const;
    }
    const command = {
      _tag: 'PurchaseOrderCreateFromQuote' as const,
      quoteId: quote.id,
      warehouseId: warehouse.id,
    };
    const outcome = yield* run(expectedDate === '' ? command : { ...command, expectedDate });
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return refusedOutcome(outcome);
    }
    return submitDone(() => {
      toast.create({ duration: 5000, title: k('quotes.ordered'), type: 'success' });
      const [orderId] = outcome.result.entityIds;
      if (orderId !== undefined) {
        onOpenOrder(orderId);
      }
    });
  },
);

interface SubmitQuoteRejectionInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly quote: SupplierQuote;
  readonly run: RunCommand;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly setRejecting: (value: boolean) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}
const submitQuoteRejection = Effect.fn('FacilityOperations.Purchasing.submitQuoteRejection')(function* rejectQuote(
  input: SubmitQuoteRejectionInput,
) {
  const { k, quote, run, setBusy, setError, setRejecting, t, toast } = input;
  setBusy(true);
  const outcome = yield* run({ _tag: 'PurchaseQuoteReject', quoteId: quote.id });
  setBusy(false);
  setRejecting(false);
  if (outcome.ok) {
    toast.create({ duration: 5000, title: k('quotes.rejected'), type: 'success' });
  } else {
    setError(t(failureKey(outcome.reason)));
  }
});

/** Turns a received quote into an order: Uložit creates it; rejecting the quote stays a confirmed command. */
export const QuoteToOrderForm = ({
  error,
  onOpenOrder,
  quote,
  run,
  setError,
  state,
}: {
  readonly error?: string | undefined;
  readonly onOpenOrder: (orderId: string) => void;
  readonly quote: SupplierQuote;
  readonly run: RunCommand;
  readonly setError: (value: string | undefined) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const opened = { expectedDate: '', warehouseId: state.warehouses[0]?.id ?? '' };
  const shown = useFormValues(quoteToOrderForm, opened);
  const { expectedDate, warehouseId } = shown.values;
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  // The order is created on Uložit only; the warehouse it opens with can be used as it is.
  const form = useFormSave({
    savableAtOnce: true,
    submit: () =>
      submitOrderFromQuote({ expectedDate, k, onOpenOrder, quote, run, setError, state, t, toast, warehouseId }),
    value: shown.values,
  });
  const reject = () => submitQuoteRejection({ k, quote, run, setBusy, setError, setRejecting, t, toast });
  return (
    <SectionCard title={k('quotes.toOrderTitle')}>
      <p className="text-fg-secondary text-sm">{k('quotes.toOrderHint')}</p>
      <FormRoot
        className="grid grid-cols-1 gap-200 sm:grid-cols-2"
        defaultValues={opened}
        form={quoteToOrderForm}
        key={quote.id}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <quoteToOrderForm.warehouseId
          items={state.warehouses.map((entry) => ({ label: entry.name, value: entry.id }))}
          label={k('fields.deliverTo')}
          placeholder={k('placeholders.warehouse')}
        />
        <quoteToOrderForm.expectedDate id="quote-expected" label={k('fields.expectedDate')} type="date" />
      </FormRoot>
      {rejecting ? (
        <div className="flex flex-wrap justify-end gap-100">
          <span className="self-center text-sm">{k('quotes.rejectConfirm')}</span>
          <Button appearance="outline" onClick={() => setRejecting(false)} severity="secondary" size="sm">
            {t('facility-operations.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            onClick={() => {
              browserRuntime.runFork(reject());
            }}
            severity="danger"
            size="sm"
          >
            {k('quotes.reject')}
          </Button>
          {/* The leave question stays reachable while the rejection is being confirmed. */}
          <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
        </div>
      ) : (
        <FormSaveFooter error={error} form={form}>
          <Button appearance="ghost" onClick={() => setRejecting(true)} severity="danger" size="sm">
            {k('quotes.reject')}
          </Button>
        </FormSaveFooter>
      )}
    </SectionCard>
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
  readonly canWrite: boolean;
  readonly onClose: () => void;
  readonly onOpenOrder: (orderId: string) => void;
  readonly quoteId: string;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const quote = state.quotes.find((entry) => entry.id === quoteId);
  const [error, setError] = useState<string | undefined>();
  if (quote === undefined) {
    return null;
  }
  const order = lookup.order(quote.purchaseOrderId);
  return (
    <SidePanel
      description={lookup.supplier(quote.supplierId)?.name ?? ''}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
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
          <QuoteToOrderForm
            error={error}
            onOpenOrder={onOpenOrder}
            quote={quote}
            run={run}
            setError={setError}
            state={state}
          />
        )}
        <SectionCard title={k('orders.lines')}>
          <Table appearance="line" size="sm">
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
                value: quote.validUntil === undefined ? t(notProvidedKey) : formatDate(quote.validUntil),
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
      cell: SupplierNameCell,
      header: k('fields.supplierName'),
      id: 'name',
    },
    {
      cell: SupplierContactCell,
      header: k('fields.contact'),
      id: 'contact',
    },
    {
      cell: SupplierEmailCell,
      header: k('fields.email'),
      id: 'email',
    },
    {
      cell: SupplierLeadCell,
      header: k('fields.leadTime'),
      id: 'lead',
    },
    {
      cell: SupplierItemsCell,
      header: k('suppliers.items'),
      id: 'items',
    },
    {
      cell: SupplierOrdersCell,
      header: k('suppliers.orders'),
      id: 'orders',
    },
  ];
  return (
    <SupplierStateContext value={state}>
      <DataTable
        columns={columns}
        data={[...state.suppliers]}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.original.name}
        loading={false}
        size="sm"
        translations={{
          emptyDescription: k('empty.suppliers'),
          emptyTitle: t('facility-operations.common.states.emptyTitle'),
        }}
      />
    </SupplierStateContext>
  );
};
