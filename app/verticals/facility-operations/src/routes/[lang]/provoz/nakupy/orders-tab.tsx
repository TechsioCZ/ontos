import { optionalField } from '../../../../../shared/domain/common.ts';
import { Effect, Result, Schema } from 'effect';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// S06: purchase orders list + detail panel (lines with delivered/remaining, deliveries, invoices, history).
import { DetailList, SectionCard, SidePanel, formatDate, requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import { Field, FormBuilder, FormReact, FormRoot, TextAreaField, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Meter } from '@techsio/ui-kit/atoms/meter';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
import { createContext, useContext, useState } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { CommentThread } from '../../../../ui/comment-thread.tsx';
import { ChangeHistory } from '../../../../ui/change-history.tsx';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { PurchaseLineIdSchema } from '../../../../../shared/domain/purchasing.ts';
import type { PurchaseOrder, PurchasingState } from '../../../../../shared/domain/purchasing.ts';
import {
  OPEN_ORDER_STATUSES,
  lineRemaining,
  orderOpenValueMinor,
  orderRemainingQuantity,
  orderTotalMinor,
} from '../../../../../shared/domain/purchasing-stock.ts';
import {
  dateTimeIso,
  historyRows,
  formatStamp,
  failureKey,
  formatAmount,
  formatQuantity,
  lookupOf,
  parseAmountMinor,
  parseSerials,
  principalLabel,
  todayIso,
  usePurchasingT,
} from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';
import { TextLink } from './stock-tab.tsx';
import { FinanceInvoiceLink, useIncomingInvoiceLinks } from './finance-links.tsx';
import { InvoiceDraftForm } from './invoice-draft-form.tsx';
import { FormSaveFooter, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import { useFormValues } from '../../../../ui/form-values.tsx';
import { ListSwitch, useListSwitch } from '../../../../ui/list-switch.tsx';

const noteLabelKey = 'facility-operations.common.note';
const cancelLabelKey = 'facility-operations.common.cancel';

const ignoredReceiptQuantities = new Set(['', '0']);

type PurchaseReceiveLine = Extract<
  Parameters<RunCommand>[0],
  { readonly _tag: 'PurchaseOrderReceive' }
>['lines'][number];

const statusVariant = {
  approved: 'info',
  cancelled: 'neutral',
  completed: 'success',
  draft: 'neutral',
  ordered: 'info',
  partially_delivered: 'warning',
} as const satisfies Readonly<Record<PurchaseOrder['status'], 'neutral' | 'info' | 'warning' | 'success' | 'danger'>>;

export const OrderStatusBadge = ({ status }: { readonly status: PurchaseOrder['status'] }) => {
  const k = usePurchasingT();
  return (
    <Badge severity={statusVariant[status]} size="sm">
      {k(`orderStatus.${status}`)}
    </Badge>
  );
};

const DeliveryProgress = ({ order }: { readonly order: PurchaseOrder }) => {
  const ordered = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const received = order.lines.reduce((sum, line) => sum + Math.min(line.quantity, line.receivedQuantity), 0);
  const ratio = ordered === 0 ? 0 : received / ordered;
  return (
    <div className="flex min-w-32 flex-col gap-50">
      <Meter aria-hidden max={ordered} severity={ratio >= 1 ? 'success' : 'primary'} value={received} />
      <span className="text-fg-secondary text-xs tabular-nums">{`${received} / ${ordered}`}</span>
    </div>
  );
};

const OrderLookupContext = createContext<ReturnType<typeof lookupOf> | undefined>(undefined);
const OrderQuotesContext = createContext<PurchasingState['quotes']>([]);
const OrderFinanceContext = createContext<ReturnType<typeof useIncomingInvoiceLinks>>({ status: 'loading' });

const OrderNumberCell = ({ row }: CellContext<PurchaseOrder>) => {
  const lookup = useContext(OrderLookupContext);
  return (
    <div className="flex flex-col">
      <span className="font-medium">{row.original.number}</span>
      <span className="text-fg-secondary text-xs">{lookup?.supplier(row.original.supplierId)?.name ?? '—'}</span>
    </div>
  );
};

const OrderStatusCell = ({ row }: CellContext<PurchaseOrder>) => <OrderStatusBadge status={row.original.status} />;

const OrderDeliveryCell = ({ row }: CellContext<PurchaseOrder>) => <DeliveryProgress order={row.original} />;

const OrderTotalCell = ({ row }: CellContext<PurchaseOrder>) => (
  <span className="tabular-nums">{formatAmount(orderTotalMinor(row.original), row.original.currency)}</span>
);

const OrderExpectedCell = ({ row }: CellContext<PurchaseOrder>) =>
  row.original.expectedDate === undefined ? '—' : formatDate(row.original.expectedDate);

const OrderQuoteCell = ({ row }: CellContext<PurchaseOrder>) => {
  const quotes = useContext(OrderQuotesContext);
  const k = usePurchasingT();
  return row.original.quoteId === undefined ? (
    <span className="text-fg-secondary">{k('orders.direct')}</span>
  ) : (
    (quotes.find((quote) => quote.id === row.original.quoteId)?.number ?? '—')
  );
};

const OrderInvoicesCell = ({ row }: CellContext<PurchaseOrder>) => {
  const financeLinks = useContext(OrderFinanceContext);
  const k = usePurchasingT();
  const numbers = [
    ...new Set([
      ...row.original.invoices.map((invoice) => invoice.number),
      ...(financeLinks.status === 'ready'
        ? financeLinks.invoices.flatMap((invoice) =>
            invoice.sourceOrder?.id === row.original.id ? [invoice.number] : [],
          )
        : []),
    ]),
  ];
  return numbers.length === 0 ? (
    <span className="text-fg-secondary">
      {k(financeLinks.status === 'ready' ? 'orders.noInvoice' : `orders.finance.${financeLinks.status}`)}
    </span>
  ) : (
    numbers.join(', ')
  );
};

export const OrdersTab = ({
  financeRefresh = 0,
  onOpen,
  state,
}: {
  readonly financeRefresh?: number;
  readonly onOpen: (orderId: string) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const openOnly = useListSwitch('ordersOpenOnly');
  const financeLinks = useIncomingInvoiceLinks(financeRefresh);
  const rows = state.orders
    .filter((order) => !openOnly || OPEN_ORDER_STATUSES.has(order.status) || order.status === 'draft')
    .toReversed();
  const columns: ColumnDef<PurchaseOrder>[] = [
    {
      cell: OrderNumberCell,
      header: k('fields.order'),
      id: 'number',
    },
    { cell: OrderStatusCell, header: k('fields.status'), id: 'status' },
    { cell: OrderDeliveryCell, header: k('fields.delivered'), id: 'delivered' },
    {
      cell: OrderTotalCell,
      header: k('fields.total'),
      id: 'total',
    },
    {
      cell: OrderExpectedCell,
      header: k('fields.expectedDate'),
      id: 'expectedDate',
    },
    {
      cell: OrderQuoteCell,
      header: k('fields.quote'),
      id: 'quote',
    },
    {
      cell: OrderInvoicesCell,
      header: k('fields.invoices'),
      id: 'invoices',
    },
  ];
  return (
    <div className="flex flex-col gap-200">
      <ListSwitch name="ordersOpenOnly">{k('filters.openOrders')}</ListSwitch>
      <OrderLookupContext value={lookup}>
        <OrderQuotesContext value={state.quotes}>
          <OrderFinanceContext value={financeLinks}>
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.original.number}
              interactive
              loading={false}
              onRowClick={(row) => onOpen(row.original.id)}
              size="sm"
              translations={{
                emptyDescription: k('empty.orders'),
                emptyTitle: t('facility-operations.common.states.emptyTitle'),
              }}
            />
          </OrderFinanceContext>
        </OrderQuotesContext>
      </OrderLookupContext>
    </div>
  );
};

const prepareInvoiceAction = 'prepare-invoice';
const OrderActionSchema = Schema.Literals(['receive', 'invoice', prepareInvoiceAction, 'close', 'cancel']);
type OrderAction = typeof OrderActionSchema.Type;

// The order's forms only hold their values: Uložit or the form's own button sends them, so Enter sends nothing. The
// panel shows one of them at a time, so each form is mounted once.

/** The note of a close or a cancel. */
const noteForm = FormReact.make(FormBuilder.empty.addField('note', Schema.String), {
  fields: { note: TextAreaField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const emptyNote = { note: '' };

/** One received order line: what came now, and its batch or serial numbers. */
const ReceiptLineSchema = Schema.Struct({
  batch: Schema.String,
  lineId: PurchaseLineIdSchema,
  quantity: Schema.String,
  serials: Schema.String,
});

/** The receipt of a delivery; one entry per order line that still has a remainder. */
const receiveForm = FormReact.make(
  FormBuilder.empty
    .addField('date', Schema.String)
    .addField('deliveryNote', Schema.String)
    .addField(Field.makeArrayField('lines', ReceiptLineSchema)),
  {
    fields: {
      date: TextField,
      deliveryNote: TextField,
      lines: { batch: TextField, lineId: TextField, quantity: TextField, serials: TextAreaField },
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** The supplier invoice linked to the order. */
const invoiceLinkForm = FormReact.make(
  FormBuilder.empty
    .addField('amount', Schema.String)
    .addField('date', Schema.String)
    .addField('note', Schema.String)
    .addField('number', Schema.String),
  {
    fields: { amount: TextField, date: TextField, note: TextField, number: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const emptyInvoiceLink = { amount: '', date: '', note: '', number: '' };

const NoteForm = ({
  busy,
  onCancel,
  onSubmit,
  required,
  submitLabel,
  title,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (note: string) => void;
  readonly required: boolean;
  readonly submitLabel: string;
  readonly title: string;
}) => {
  const { language, t } = useModernI18n();
  const shown = useFormValues(noteForm, emptyNote);
  const { note } = shown.values;
  const [missing, setMissing] = useState(false);
  return (
    <SectionCard title={title}>
      {missing && (
        <StatusText showIcon status="error">
          {t('facility-operations.common.required')}
        </StatusText>
      )}
      <FormRoot defaultValues={emptyNote} form={noteForm} translateMessage={(message) => t(message)}>
        {shown.ready}
        <noteForm.note
          id="order-note"
          label={t(noteLabelKey)}
          required={required}
          requiredLabel={requiredLabelFor(language)}
          rows={2}
        />
      </FormRoot>
      <div className="flex justify-end gap-100">
        <Button appearance="outline" onClick={onCancel} severity="secondary" size="sm">
          {t(cancelLabelKey)}
        </Button>
        <Button
          isLoading={busy}
          onClick={() => {
            if (required && note.trim() === '') {
              setMissing(true);
              return;
            }
            onSubmit(note.trim());
          }}
          severity="primary"
          size="sm"
        >
          {submitLabel}
        </Button>
      </div>
    </SectionCard>
  );
};

interface SubmitOrderReceiptInput {
  readonly batches: Readonly<Record<string, string>>;
  readonly date: string;
  readonly deliveryNote: string;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly lookup: ReturnType<typeof lookupOf>;
  readonly onDone: () => void;
  readonly open: readonly PurchaseOrder['lines'][number][];
  readonly order: PurchaseOrder;
  readonly quantities: Readonly<Record<string, string>>;
  readonly run: RunCommand;
  readonly serials: Readonly<Record<string, string>>;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}
const submitOrderReceipt = Effect.fn('FacilityOperations.Purchasing.submitOrderReceipt')(function* receiveOrder(
  input: SubmitOrderReceiptInput,
) {
  const { batches, date, deliveryNote, k, lookup, onDone, open, order, quantities, run, serials, setError, t, toast } =
    input;
  setError(undefined);
  const lines: PurchaseReceiveLine[] = [];
  for (const line of open) {
    const text = (quantities[line.id] ?? '').trim();
    if (ignoredReceiptQuantities.has(text)) {
      continue;
    }
    const quantity = Number(text);
    if (!Number.isInteger(quantity) || quantity < 0) {
      setError(t('facility-operations.common.errors.invalid'));
      return 'failed' as const;
    }
    if (quantity > lineRemaining(line)) {
      setError(k('orders.overRemaining', { item: line.description, remaining: lineRemaining(line) }));
      return 'failed' as const;
    }
    const item = lookup.item(line.itemId);
    const tracking = item === undefined ? 'none' : item.tracking;
    const batch = (batches[line.id] ?? '').trim();
    const serialList = parseSerials(serials[line.id] ?? '');
    if (tracking === 'batch' && batch === '') {
      setError(k('orders.batchFor', { item: line.description }));
      return 'failed' as const;
    }
    if (tracking === 'serial' && serialList.length !== quantity) {
      setError(k('orders.serialsFor', { count: quantity, item: line.description }));
      return 'failed' as const;
    }
    lines.push({
      lineId: line.id,
      quantity,
      ...optionalField('batch', batch === '' ? undefined : batch),
      ...optionalField('serialNumbers', tracking === 'serial' ? serialList : undefined),
    });
  }
  if (lines.length === 0) {
    setError(k('orders.nothingReceived'));
    return 'failed' as const;
  }
  const outcome = yield* run({
    _tag: 'PurchaseOrderReceive',
    date,
    lines,
    orderId: order.id,
    ...optionalField('deliveryNote', deliveryNote.trim() === '' ? undefined : deliveryNote.trim()),
  });
  if (!outcome.ok) {
    setError(t(failureKey(outcome.reason)));
    return refusedOutcome(outcome);
  }
  return submitDone(() => {
    toast.create({ duration: 5000, title: k('orders.received'), type: 'success' });
    onDone();
  });
});

/** Receipt of a delivery against the order (exported for its mounted test). */
export const ReceiveForm = ({
  onDone,
  order,
  run,
  state,
}: {
  readonly onDone: () => void;
  readonly order: PurchaseOrder;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { language, t } = useModernI18n();
  const toast = useToast();
  const lookup = lookupOf(state);
  const open = order.lines.filter((line) => lineRemaining(line) > 0);
  const opened = {
    date: todayIso(),
    deliveryNote: '',
    lines: open.map((line) => ({ batch: '', lineId: line.id, quantity: String(lineRemaining(line)), serials: '' })),
  };
  const shown = useFormValues(receiveForm, opened);
  const { date, deliveryNote } = shown.values;
  const entries = (pick: (line: (typeof shown.values.lines)[number]) => string) =>
    Object.fromEntries(shown.values.lines.map((line) => [line.lineId, pick(line)]));
  const quantities = entries((line) => line.quantity);
  const batches = entries((line) => line.batch);
  const serials = entries((line) => line.serials);
  const [error, setError] = useState<string | undefined>();
  // The receipt is recorded on Uložit only; the remaining quantities it opens with can be received as they are.
  const form = useFormSave({
    savableAtOnce: true,
    submit: () =>
      submitOrderReceipt({
        batches,
        date,
        deliveryNote,
        k,
        lookup,
        onDone,
        open,
        order,
        quantities,
        run,
        serials,
        setError,
        t,
        toast,
      }),
    value: { batches, date, deliveryNote, quantities, serials },
  });
  return (
    <SectionCard title={k('orders.receiveTitle')}>
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={receiveForm}
        key={order.id}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <receiveForm.date
            id="receive-date"
            label={k('fields.date')}
            required
            requiredLabel={requiredLabelFor(language)}
            type="date"
          />
          <receiveForm.deliveryNote id="receive-note" label={k('fields.deliveryNote')} maxLength={64} />
        </div>
        <div className="flex flex-col gap-150">
          {shown.values.lines.map((entry, index) => {
            // A line received in full since the form opened is not offered any more.
            const line = open.find((candidate) => candidate.id === entry.lineId);
            if (line === undefined) {
              return null;
            }
            const item = lookup.item(line.itemId);
            return (
              <receiveForm.lines.Item index={index} key={line.id}>
                <div className={`${surfaceTileClassName} grid grid-cols-1 gap-100 p-150 sm:grid-cols-[2fr_1fr]`}>
                  <div className="flex flex-col justify-center">
                    <span className="font-medium text-sm">{line.description}</span>
                    <span className="text-fg-secondary text-xs">
                      {k('orders.remainingOf', {
                        ordered: line.quantity,
                        remaining: lineRemaining(line),
                        unit: item?.unit ?? '',
                      })}
                    </span>
                  </div>
                  <receiveForm.lines.quantity
                    id={`receive-qty-${line.id}`}
                    inputMode="numeric"
                    label={k('fields.receivedNow')}
                    size="sm"
                  />
                  {item?.tracking === 'batch' && (
                    <receiveForm.lines.batch id={`receive-batch-${line.id}`} label={k('fields.batch')} size="sm" />
                  )}
                  {item?.tracking === 'serial' && (
                    <receiveForm.lines.serials
                      helpText={k('movement.serialHelp')}
                      id={`receive-serials-${line.id}`}
                      label={k('fields.serialNumbers')}
                      rows={2}
                    />
                  )}
                </div>
              </receiveForm.lines.Item>
            );
          })}
        </div>
      </FormRoot>
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};

interface SubmitOrderInvoiceLinkInput {
  readonly amount: string;
  readonly date: string;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly note: string;
  readonly number: string;
  readonly onDone: () => void;
  readonly order: PurchaseOrder;
  readonly run: RunCommand;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}

const submitOrderInvoiceLink = Effect.fn('FacilityOperations.Purchasing.submitOrderInvoiceLink')(
  function* linkOrderInvoice(input: SubmitOrderInvoiceLinkInput) {
    const { amount, date, k, note, number, onDone, order, run, setError, t, toast } = input;
    setError(undefined);
    const amountMinor = amount.trim() === '' ? undefined : parseAmountMinor(amount);
    if (number.trim() === '' || (amount.trim() !== '' && amountMinor === undefined)) {
      setError(t('facility-operations.common.required'));
      return 'failed' as const;
    }
    const outcome = yield* run({
      _tag: 'PurchaseOrderLinkInvoice',
      number: number.trim(),
      orderId: order.id,
      ...optionalField('invoiceDate', date === '' ? undefined : date),
      ...optionalField('amountMinor', amountMinor),
      ...optionalField('note', note.trim() === '' ? undefined : note.trim()),
    });
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return refusedOutcome(outcome);
    }
    return submitDone(() => {
      toast.create({ duration: 5000, title: k('orders.invoiceLinked'), type: 'success' });
      onDone();
    });
  },
);

/** Links a supplier invoice to the order (exported for its mounted test). */
export const InvoiceForm = ({
  onDone,
  order,
  run,
}: {
  readonly onDone: () => void;
  readonly order: PurchaseOrder;
  readonly run: RunCommand;
}) => {
  const k = usePurchasingT();
  const { language, t } = useModernI18n();
  const toast = useToast();
  const shown = useFormValues(invoiceLinkForm, emptyInvoiceLink);
  const { amount, date, note, number } = shown.values;
  const [error, setError] = useState<string | undefined>();
  // The invoice is linked on Uložit only.
  const form = useFormSave({
    submit: () => submitOrderInvoiceLink({ amount, date, k, note, number, onDone, order, run, setError, t, toast }),
    value: { amount, date, note, number },
  });
  return (
    <SectionCard title={k('orders.linkInvoice')}>
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={emptyInvoiceLink}
        form={invoiceLinkForm}
        key={order.id}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
          <invoiceLinkForm.number
            id="invoice-number"
            label={k('fields.invoiceNumber')}
            maxLength={64}
            required
            requiredLabel={requiredLabelFor(language)}
          />
          <invoiceLinkForm.date id="invoice-date" label={k('fields.invoiceDate')} type="date" />
          <invoiceLinkForm.amount id="invoice-amount" inputMode="decimal" label={k('fields.invoiceAmount')} />
        </div>
        <invoiceLinkForm.note id="invoice-note" label={t(noteLabelKey)} maxLength={300} />
      </FormRoot>
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};

type OrderTransitionTarget = Extract<OpsCommand, { readonly _tag: 'PurchaseOrderTransition' }>['to'];

interface SubmitOrderTransitionInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly order: PurchaseOrder;
  readonly run: RunCommand;
  readonly setAction: (value: OrderAction | undefined) => void;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}
const submitOrderTransition = Effect.fn('FacilityOperations.Purchasing.submitOrderTransition')(
  function* transitionOrder(input: SubmitOrderTransitionInput, to: OrderTransitionTarget, note?: string) {
    const { k, order, run, setAction, setBusy, setError, t, toast } = input;
    setError(undefined);
    setBusy(true);
    const outcome = yield* run({
      _tag: 'PurchaseOrderTransition',
      orderId: order.id,
      to,
      ...optionalField('note', note === '' ? undefined : note),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ duration: 5000, title: k(`orders.transitioned.${to}`), type: 'success' });
      setAction(undefined);
    } else {
      setError(t(failureKey(outcome.reason)));
    }
  },
);

interface OrderRecordSectionsProps {
  readonly financeLinks: ReturnType<typeof useIncomingInvoiceLinks>;
  readonly me: PrincipalRef | undefined;
  readonly onOpenItem: (id: string) => void;
  readonly onOpenQuote: (id: string) => void;
  readonly order: PurchaseOrder;
  readonly sourceInvoices: readonly Extract<
    ReturnType<typeof useIncomingInvoiceLinks>,
    { readonly status: 'ready' }
  >['invoices'][number][];
  readonly state: PurchasingState;
}
const purchaseDeliveryHeading = (
  delivery: PurchaseOrder['deliveries'][number],
  k: ReturnType<typeof usePurchasingT>,
) => {
  const note = delivery.deliveryNote === undefined ? '' : ` · ${k('fields.deliveryNote')} ${delivery.deliveryNote}`;
  return `${formatDate(delivery.date)}${note}`;
};

const OrderRecordSections = ({
  financeLinks,
  me,
  onOpenItem,
  onOpenQuote,
  order,
  sourceInvoices,
  state,
}: OrderRecordSectionsProps) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const lookup = lookupOf(state);
  const supplier = lookup.supplier(order.supplierId);
  const quote = state.quotes.find((entry) => entry.id === order.quoteId);
  const you = t('facility-operations.common.you');
  const history = historyRows(order.history);
  return (
    <>
      <SectionCard title={k('orders.lines')}>
        <div className="overflow-x-auto">
          <Table appearance="line" className="min-w-[40rem]" size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{k('fields.item')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.ordered')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.received')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.remaining')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.unitPrice')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{k('fields.lineTotal')}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {order.lines.map((line) => {
                const item = lookup.item(line.itemId);
                const unit = item?.unit ?? '';
                return (
                  <Table.Row key={line.id}>
                    <Table.Cell className="min-w-48">
                      {item === undefined ? (
                        <span className="flex flex-col">
                          <span>{line.description}</span>
                          <span className="text-fg-secondary text-xs">{k('lines.service')}</span>
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          <TextLink onClick={() => onOpenItem(item.id)}>{line.description}</TextLink>
                          <span className="text-fg-secondary text-xs">{item.sku}</span>
                        </span>
                      )}
                    </Table.Cell>
                    <Table.Cell align="end">{formatQuantity(line.quantity, unit)}</Table.Cell>
                    <Table.Cell align="end">{formatQuantity(line.receivedQuantity, unit)}</Table.Cell>
                    <Table.Cell align="end">
                      <span
                        className={
                          lineRemaining(line) > 0 ? 'font-semibold tabular-nums' : 'text-fg-secondary tabular-nums'
                        }
                      >
                        {formatQuantity(lineRemaining(line), unit)}
                      </span>
                    </Table.Cell>
                    <Table.Cell align="end">{formatAmount(line.unitPriceMinor, order.currency)}</Table.Cell>
                    <Table.Cell align="end">
                      {formatAmount(line.unitPriceMinor * line.quantity, order.currency)}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      </SectionCard>
      <SectionCard title={k('panel.detail')}>
        <DetailList
          items={[
            { label: k('fields.supplier'), value: lookup.supplier(order.supplierId)?.name ?? '—' },
            { label: k('fields.deliverTo'), value: lookup.warehouse(order.warehouseId)?.name ?? '—' },
            {
              label: k('fields.expectedDate'),
              value:
                order.expectedDate === undefined
                  ? t('facility-operations.common.notProvided')
                  : formatDate(order.expectedDate),
            },
            {
              label: k('fields.quote'),
              value:
                quote === undefined ? (
                  k('orders.direct')
                ) : (
                  <TextLink onClick={() => onOpenQuote(quote.id)}>
                    {k('orders.fromQuote', { number: quote.number })}
                  </TextLink>
                ),
            },
            ...(order.note === undefined || order.note === '' ? [] : [{ label: t(noteLabelKey), value: order.note }]),
            {
              label: t('facility-operations.common.createdBy'),
              value: `${formatStamp(order.createdAt)} · ${principalLabel(order.createdBy, me, you)}`,
            },
          ]}
        />
      </SectionCard>
      <SectionCard title={k('orders.deliveries', { count: order.deliveries.length })}>
        {order.deliveries.length === 0 ? (
          <p className="text-fg-secondary text-sm">{k('orders.noDeliveries')}</p>
        ) : (
          <ul className="flex flex-col gap-150">
            {order.deliveries.map((delivery) => (
              <li className={`${surfaceTileClassName} flex flex-col gap-50 p-150 text-sm`} key={delivery.id}>
                <span className="font-medium">{purchaseDeliveryHeading(delivery, k)}</span>
                {delivery.lines.map((entry) => {
                  const line = order.lines.find((candidate) => candidate.id === entry.lineId);
                  const unit = lookup.item(line?.itemId)?.unit ?? '';
                  const batchLabel = entry.batch === undefined ? '' : ` · ${k('fields.batch')} ${entry.batch}`;
                  const serialLabel =
                    entry.serialNumbers === undefined ? '' : ` · SN ${entry.serialNumbers.join(', ')}`;
                  return (
                    <span className="text-fg-secondary" key={entry.lineId}>
                      {`${line?.description ?? ''}: ${formatQuantity(entry.quantity, unit)}${batchLabel}${serialLabel}`}
                    </span>
                  );
                })}
                <span className="text-fg-secondary text-xs">{`${k('orders.receivedBy')} ${principalLabel(delivery.receivedBy, me, you)} · ${formatStamp(delivery.receivedAt)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={k('orders.invoices')}>
        {sourceInvoices.map((invoice) => (
          <div className="flex flex-wrap items-center gap-100 rounded-md p-150 text-sm" key={invoice.resourceId}>
            <Badge severity="warning" size="sm">
              Doklad z objednávky
            </Badge>
            <span>{invoice.number}</span>
            <FinanceInvoiceLink links={financeLinks} number={invoice.number} supplier={supplier?.name ?? ''} />
          </div>
        ))}
        <p className="text-fg-secondary text-xs">{k('orders.invoiceNote')}</p>
        {order.invoices.length === 0 && sourceInvoices.length === 0 ? (
          <p className="text-fg-secondary text-sm">{k('orders.noInvoice')}</p>
        ) : (
          <ul className="flex flex-col gap-100 text-sm">
            {order.invoices.map((invoice) => (
              <li className="flex flex-wrap items-center justify-between gap-100" key={invoice.number}>
                <span className="flex flex-wrap items-center gap-100">
                  <span className="icon-[mdi--file-document-outline]" />
                  <span className="font-medium">{invoice.number}</span>
                  <FinanceInvoiceLink
                    links={financeLinks}
                    number={invoice.number}
                    supplier={lookup.supplier(order.supplierId)?.name ?? ''}
                  />
                  {invoice.invoiceDate !== undefined && (
                    <span className="text-fg-secondary">{formatDate(invoice.invoiceDate)}</span>
                  )}
                  {invoice.note !== undefined && <span className="text-fg-secondary">{`· ${invoice.note}`}</span>}
                </span>
                <span className="tabular-nums">
                  {invoice.amountMinor === undefined
                    ? t('facility-operations.common.notProvided')
                    : formatAmount(invoice.amountMinor, order.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={k('orders.discussion')}>
        <CommentThread
          hideWhenForbidden
          subject={{ id: order.id, kind: 'purchase', label: k('orders.panelTitle', { number: order.number }) }}
          title={null}
        />
      </SectionCard>
      <SectionCard>
        <ChangeHistory entityId={order.id} refreshKey={dateTimeIso(order.updatedAt)} />
      </SectionCard>
      <SectionCard title={k('orders.history')}>
        {Result.isFailure(history) ? (
          <StatusText showIcon status="error">
            {t('facility-operations.common.errors.unavailable')}
          </StatusText>
        ) : (
          <ol className="flex flex-col gap-100 border-border-primary border-l pl-200 text-sm">
            {history.success.map(({ entry, key }) => {
              const note = entry.note === undefined ? '' : ` · ${entry.note}`;
              return (
                <li className="flex flex-col" key={key}>
                  <span className="flex flex-wrap items-center gap-100">
                    <span className="font-medium">{k(`historyEvent.${entry.event}`)}</span>
                    <OrderStatusBadge status={entry.status} />
                  </span>
                  <span className="text-fg-secondary text-xs">{`${formatStamp(entry.at)} · ${principalLabel(entry.by, me, you)}${note}`}</span>
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
    </>
  );
};

const orderCapabilities = (
  order: PurchaseOrder,
  supplier: PurchasingState['suppliers'][number] | undefined,
  finance: ReturnType<typeof useIncomingInvoiceLinks>,
  invoiceCount: number,
) => {
  const persisted = order.status !== 'draft' && order.status !== 'cancelled';
  const invoiceDraft =
    persisted && order.currency === 'CZK' && supplier !== undefined && invoiceCount === 0 && finance.status === 'ready';
  return {
    cancellable:
      (order.status === 'draft' || order.status === 'approved' || order.status === 'ordered') &&
      order.deliveries.length === 0,
    invoiceDraftReadOnly: invoiceDraft && finance.status === 'ready' && !finance.canWrite,
    invoiceDraftWritable: invoiceDraft && finance.status === 'ready' && finance.canWrite,
    linkable: persisted,
    receivable: order.status === 'ordered' || order.status === 'partially_delivered',
  };
};

interface OrderActionFormsProps {
  readonly action: OrderAction | undefined;
  readonly busy: boolean;
  readonly financeLinks: ReturnType<typeof useIncomingInvoiceLinks>;
  readonly onCancel: () => void;
  readonly onInvoiceCreated: () => void;
  readonly order: PurchaseOrder;
  readonly run: RunCommand;
  readonly state: PurchasingState;
  readonly supplier: PurchasingState['suppliers'][number] | undefined;
  readonly transition: (to: OrderTransitionTarget, note?: string) => ReturnType<typeof submitOrderTransition>;
}
const OrderActionForms = ({
  action,
  busy,
  financeLinks,
  onCancel,
  onInvoiceCreated,
  order,
  run,
  state,
  supplier,
  transition,
}: OrderActionFormsProps) => {
  const k = usePurchasingT();
  return (
    <>
      {action === 'receive' && <ReceiveForm onDone={onCancel} order={order} run={run} state={state} />}
      {action === prepareInvoiceAction &&
        supplier !== undefined &&
        financeLinks.status === 'ready' &&
        financeLinks.canWrite && (
          <InvoiceDraftForm onCancel={onCancel} onCreated={onInvoiceCreated} order={order} supplier={supplier} />
        )}
      {action === 'invoice' && <InvoiceForm onDone={onCancel} order={order} run={run} />}
      {(action === 'close' || action === 'cancel') && (
        <NoteForm
          busy={busy}
          onCancel={onCancel}
          onSubmit={(note) => {
            browserRuntime.runFork(transition(action === 'close' ? 'completed' : 'cancelled', note));
          }}
          required={action === 'close'}
          submitLabel={k(action === 'close' ? 'orders.closeSubmit' : 'orders.cancelSubmit')}
          title={k(action === 'close' ? 'orders.closeTitle' : 'orders.cancelTitle')}
        />
      )}
    </>
  );
};

export const OrderPanel = ({
  canWrite,
  me,
  onClose,
  onInvoiceCreated,
  onOpenItem,
  onOpenQuote,
  orderId,
  run,
  state,
}: {
  readonly canWrite: boolean;
  readonly me: PrincipalRef | undefined;
  readonly onClose: () => void;
  readonly onInvoiceCreated: () => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly onOpenQuote: (quoteId: string) => void;
  readonly orderId: string;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [financeRefresh, setFinanceRefresh] = useState(0);
  const financeLinks = useIncomingInvoiceLinks(financeRefresh);
  const [action, setAction] = useState<OrderAction | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const lookup = lookupOf(state);
  const order = state.orders.find((entry) => entry.id === orderId);
  if (order === undefined) {
    return null;
  }
  const sourceInvoices =
    financeLinks.status === 'ready'
      ? financeLinks.invoices.filter((invoice) => invoice.sourceOrder?.id === order.id)
      : [];
  const supplier = lookup.supplier(order.supplierId);
  const transition = (to: OrderTransitionTarget, note?: string) =>
    submitOrderTransition({ k, order, run, setAction, setBusy, setError, t, toast }, to, note);
  const capabilities = orderCapabilities(order, supplier, financeLinks, sourceInvoices.length);
  return (
    <SidePanel
      description={`${lookup.supplier(order.supplierId)?.name ?? ''} · ${lookup.warehouse(order.warehouseId)?.name ?? ''}`}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t('facility-operations.common.close')}
      size="xl"
      title={k('orders.panelTitle', { number: order.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <OrderStatusBadge status={order.status} />
          <span className="font-semibold text-lg tabular-nums">
            {formatAmount(orderTotalMinor(order), order.currency)}
          </span>
          {orderRemainingQuantity(order) > 0 && OPEN_ORDER_STATUSES.has(order.status) && (
            <Badge severity="warning" size="sm">
              {k('orders.openValue', { value: formatAmount(orderOpenValueMinor(order), order.currency) })}
            </Badge>
          )}
        </div>
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        {canWrite && action === undefined && (
          <div className="flex flex-wrap gap-100">
            {order.status === 'draft' && (
              <Button
                icon="icon-[mdi--check]"
                isLoading={busy}
                onClick={() => {
                  browserRuntime.runFork(transition('approved'));
                }}
                severity="primary"
                size="sm"
              >
                {k('orders.approve')}
              </Button>
            )}
            {order.status === 'approved' && (
              <Button
                icon="icon-[mdi--send]"
                isLoading={busy}
                onClick={() => {
                  browserRuntime.runFork(transition('ordered'));
                }}
                severity="primary"
                size="sm"
              >
                {k('orders.markOrdered')}
              </Button>
            )}
            {capabilities.receivable && (
              <Button
                icon="icon-[mdi--truck-delivery]"
                onClick={() => setAction('receive')}
                severity="primary"
                size="sm"
              >
                {k('orders.receive')}
              </Button>
            )}
            {capabilities.invoiceDraftWritable && (
              <Button
                appearance="outline"
                icon="icon-[mdi--file-document-plus-outline]"
                onClick={() => setAction(prepareInvoiceAction)}
                severity="secondary"
                size="sm"
              >
                Připravit návrh faktury
              </Button>
            )}
            {capabilities.linkable && (
              <Button
                appearance="outline"
                icon="icon-[mdi--file-link]"
                onClick={() => setAction('invoice')}
                severity="secondary"
                size="sm"
              >
                {k('orders.linkInvoice')}
              </Button>
            )}
            {order.status === 'partially_delivered' && (
              <Button appearance="outline" onClick={() => setAction('close')} severity="secondary" size="sm">
                {k('orders.close')}
              </Button>
            )}
            {capabilities.cancellable && (
              <Button appearance="ghost" onClick={() => setAction('cancel')} severity="danger" size="sm">
                {k('orders.cancel')}
              </Button>
            )}
          </div>
        )}
        {capabilities.invoiceDraftReadOnly && (
          <p className="text-fg-secondary text-xs" data-testid="invoice-draft-readonly">
            Návrh přijaté faktury z této objednávky připraví účetní nebo vedení ve Financích. Vaše role má ve Financích
            jen čtení.
          </p>
        )}
        <OrderActionForms
          action={action}
          busy={busy}
          financeLinks={financeLinks}
          onCancel={() => setAction(undefined)}
          onInvoiceCreated={() => {
            setAction(undefined);
            setFinanceRefresh((value) => value + 1);
            onInvoiceCreated();
            toast.create({ duration: 5000, title: 'Návrh faktury byl uložen ve Financích', type: 'success' });
          }}
          order={order}
          run={run}
          state={state}
          supplier={supplier}
          transition={transition}
        />
        <OrderRecordSections
          financeLinks={financeLinks}
          me={me}
          onOpenItem={onOpenItem}
          onOpenQuote={onOpenQuote}
          order={order}
          sourceInvoices={sourceInvoices}
          state={state}
        />
      </div>
    </SidePanel>
  );
};
