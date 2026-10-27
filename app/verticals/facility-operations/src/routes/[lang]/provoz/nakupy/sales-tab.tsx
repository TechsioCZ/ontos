import { SalesInvoicePreparationDenied } from './sales-invoice-preparation-denied.ts';
import { SalesInvoiceSnapshotMissing } from './sales-invoice-snapshot-missing.ts';
import type { IsoDate } from '../../../../../shared/domain/common.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
// S06 prodej: nabídky zákazníkům → prodejní objednávky → dodání → vystavená faktura (návrh ve Financích).
// The customer is a party-registry counterparty; the invoice is created by Finance from a snapshot of the order lines
// and counterparty (CreateInvoiceDraft), so a later quote edit never changes an issued invoice.
import { listCustomers } from '@app/party-registry/api/client';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { DetailList, EmptyState, SectionCard, SidePanel, formatDate, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { BadgeProps } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Effect, Random, Result, Schema } from 'effect';
import { useEffect, useId, useRef, useState } from 'react';
import { salesRemainder } from '../../../../../shared/commands/sales.ts';
import type {
  PurchasingState,
  SalesCustomer,
  SalesOrder,
  SalesQuote,
  SalesVatRate,
} from '../../../../../shared/domain/purchasing.ts';
import { salesTotals } from '../../../../../shared/domain/purchasing.ts';
import { ChangeHistory } from '../../../../ui/change-history.tsx';
import { applyFinanceCommand, readFinance } from '../../../../api/finance-reads.ts';
import { useIncomingInvoiceLinks } from './finance-links.tsx';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { addDays } from '../../../../ui/ops-agenda/deadlines.ts';
import {
  dateTimeIso,
  historyRows,
  failureKey,
  formatAmount,
  formatStamp,
  parseAmountMinor,
  parsePositiveInt,
  todayIso,
  usePurchasingT,
} from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

const quoteLabelKey = 'sales.columns.quote';
const cancelLabelKey = 'facility-operations.common.cancel';
const closeLabelKey = 'facility-operations.common.close';
const customerLabelKey = 'sales.fields.customer';
const linesLabelKey = 'sales.fields.lines';
const noteLabelKey = 'sales.fields.note';
const withVatKey = 'sales.withVat';
const closeActionKey = 'sales.actions.close';

const vatRates: readonly SalesVatRate[] = [21, 12, 10, 0];
type Variant = NonNullable<BadgeProps['variant']>;
const quoteVariant = {
  accepted: 'success',
  draft: 'outline',
  rejected: 'danger',
  sent: 'info',
} as const satisfies Readonly<Record<SalesQuote['status'], Variant>>;
const orderVariant = {
  approved: 'info',
  cancelled: 'outline',
  completed: 'success',
  draft: 'outline',
  ordered: 'info',
  partially_delivered: 'warning',
} as const satisfies Readonly<Record<SalesOrder['status'], Variant>>;

// ── Customers (party registry) ───────────────────────────────────────────────────────────────────────────────────

const loadCustomers = Effect.fn('FacilityOperations.Purchasing.loadCustomers')(() =>
  listCustomers({ includeArchived: false }).pipe(Effect.timeout('12 seconds')),
);

type CustomersState =
  | { readonly status: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof loadCustomers>>; readonly status: 'failed' }
  | { readonly customers: readonly SalesCustomer[]; readonly status: 'ready' };

const useCustomers = (): CustomersState => {
  const [state, setState] = useState<CustomersState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      loadCustomers().pipe(
        Effect.match({
          onFailure: (cause): CustomersState => ({ cause, status: 'failed' }),
          onSuccess: (items): CustomersState => ({
            customers: items
              .flatMap((item): SalesCustomer[] =>
                item.displayName === null
                  ? []
                  : [
                      {
                        counterpartyId: item.counterpartyRef.resourceId,
                        name: item.displayName,
                        partyId: item.partyId,
                        tenantId: item.counterpartyRef.tenantId,
                      },
                    ],
              )
              .toSorted((left, right) => left.name.localeCompare(right.name, 'cs')),
            status: 'ready',
          }),
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setState(next);
            }
          }),
        ),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};

// ── Lists ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SalesTab = ({
  canWrite,
  onNewQuote,
  onOpenOrder,
  onOpenQuote,
  state,
}: {
  readonly canWrite: boolean;
  readonly onNewQuote: () => void;
  readonly onOpenOrder: (id: string) => void;
  readonly onOpenQuote: (id: string) => void;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const quotes = (state.salesQuotes ?? []).toSorted((left, right) => right.number.localeCompare(left.number));
  const orders = (state.salesOrders ?? []).toSorted((left, right) => right.number.localeCompare(left.number));
  const openOrders = orders.filter(
    (order) => order.status !== 'completed' && order.status !== 'cancelled' && salesRemainder(order).length > 0,
  );
  return (
    <div className="flex flex-col gap-250">
      <div className="flex flex-wrap items-start justify-between gap-150">
        <p className="max-w-[52rem] text-fg-secondary text-sm">{k('sales.intro')}</p>
        {canWrite && (
          <Button icon="icon-[mdi--file-document-edit-outline]" onClick={onNewQuote} size="sm" variant="primary">
            {k('sales.newQuote')}
          </Button>
        )}
      </div>
      <SectionCard title={k('sales.ordersTitle', { count: orders.length, open: openOrders.length })}>
        {orders.length === 0 ? (
          <EmptyState description={k('sales.noOrdersHint')} title={k('sales.noOrders')} />
        ) : (
          <div className="overflow-x-auto">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{k('sales.columns.order')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.status')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('sales.columns.delivered')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('sales.columns.total')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k(quoteLabelKey)}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.invoices')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {orders.map((order) => {
                  const ordered = order.lines.reduce((sum, line) => sum + line.quantity, 0);
                  const delivered = order.lines.reduce((sum, line) => sum + line.deliveredQuantity, 0);
                  return (
                    <Table.Row
                      className="cursor-pointer hover:bg-surface-hover"
                      key={order.id}
                      onClick={() => onOpenOrder(order.id)}
                    >
                      <Table.Cell>
                        <span className="flex min-w-[12rem] flex-col">
                          <span className="font-medium tabular-nums">{order.number}</span>
                          <span className="text-fg-secondary text-xs">{order.customer.name}</span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge size="sm" variant={orderVariant[order.status]}>
                          {k(`orderStatus.${order.status}`)}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">{`${delivered} / ${ordered}`}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {formatAmount(salesTotals(order.lines).baseMinor)}
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">{order.quoteNumber ?? '—'}</Table.Cell>
                      <Table.Cell className="tabular-nums">
                        {order.invoices.length === 0
                          ? k('sales.noInvoice')
                          : order.invoices.map((invoice) => invoice.number).join(', ')}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>
      <SectionCard title={k('sales.quotesTitle', { count: quotes.length })}>
        {quotes.length === 0 ? (
          <EmptyState description={k('sales.noQuotesHint')} title={k('sales.noQuotes')} />
        ) : (
          <div className="overflow-x-auto">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{k(quoteLabelKey)}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.status')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.date')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.validUntil')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('sales.columns.total')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.order')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {quotes.map((quote) => (
                  <Table.Row
                    className="cursor-pointer hover:bg-surface-hover"
                    key={quote.id}
                    onClick={() => onOpenQuote(quote.id)}
                  >
                    <Table.Cell>
                      <span className="flex min-w-[12rem] flex-col">
                        <span className="font-medium tabular-nums">{quote.number}</span>
                        <span className="text-fg-secondary text-xs">{quote.customer.name}</span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="sm" variant={quoteVariant[quote.status]}>
                        {k(`sales.quoteStatus.${quote.status}`)}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">{formatDate(quote.date)}</Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {quote.validUntil === undefined ? '—' : formatDate(quote.validUntil)}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                      {formatAmount(salesTotals(quote.lines).baseMinor)}
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {(state.salesOrders ?? []).find((order) => order.id === quote.salesOrderId)?.number ?? '—'}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
};

// ── Quote form ───────────────────────────────────────────────────────────────────────────────────────────────────

interface LineDraft {
  readonly description: string;
  readonly key: string;
  readonly price: string;
  readonly quantity: string;
  readonly vat: SalesVatRate;
}
const withoutSalesLine = (lines: readonly LineDraft[], key: string) => lines.filter((line) => line.key !== key);
const emptyLine: Omit<LineDraft, 'key'> = { description: '', price: '', quantity: '1', vat: 21 };

interface ParsedSalesLine {
  readonly description: string;
  readonly quantity: number | undefined;
  readonly unitPriceMinor: number | undefined;
  readonly vatRate: SalesVatRate;
}

interface SubmitSalesQuoteDraftInput {
  readonly customerId: string;
  readonly customers: CustomersState;
  readonly date: string;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly note: string;
  readonly onSaved: (id: string) => void;
  readonly parsed: readonly ParsedSalesLine[];
  readonly quote: SalesQuote | undefined;
  readonly run: RunCommand;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly valid: boolean;
  readonly validUntil: IsoDate;
}
const submitSalesQuoteDraft = Effect.fn('FacilityOperations.Purchasing.submitSalesQuoteDraft')(
  function* submitSalesQuote(input: SubmitSalesQuoteDraftInput, status: 'draft' | 'sent') {
    const {
      customerId,
      customers,
      date,
      k,
      note,
      onSaved,
      parsed,
      quote,
      run,
      setBusy,
      setError,
      t,
      valid,
      validUntil,
    } = input;
    const customer =
      customers.status === 'ready'
        ? customers.customers.find((entry) => entry.counterpartyId === customerId)
        : undefined;
    if (customer === undefined || !valid || date === '') {
      setError(k('sales.form.required'));
      return;
    }
    if (validUntil !== '' && validUntil < date) {
      setError(k('sales.form.validity'));
      return;
    }
    setBusy(true);
    setError(undefined);
    const fields = {
      customer,
      date,
      lines: parsed.map((line) => ({
        description: line.description,
        quantity: line.quantity ?? 1,
        unitPriceMinor: line.unitPriceMinor ?? 0,
        vatRate: line.vatRate,
      })),
      ...optionalField('validUntil', validUntil === '' ? undefined : validUntil),
      ...optionalField('note', note.trim() === '' ? undefined : note.trim()),
    };
    const outcome = yield* run(
      quote === undefined
        ? { _tag: 'SalesQuoteCreate', ...fields, status }
        : { _tag: 'SalesQuoteUpdate', ...fields, quoteId: quote.id },
    );
    setBusy(false);
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return;
    }
    onSaved(outcome.result.entityIds[0] ?? quote?.id ?? '');
  },
);

export const SalesQuoteFormPanel = ({
  onClose,
  onSaved,
  quote,
  run,
}: {
  readonly onClose: () => void;
  readonly onSaved: (quoteId: string) => void;
  readonly quote?: SalesQuote;
  readonly run: RunCommand;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState(quote?.customer.counterpartyId ?? '');
  const [date, setDate] = useState(quote?.date ?? todayIso());
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? addDays(todayIso(), 30));
  const [note, setNote] = useState(quote?.note ?? '');
  const linePrefix = useId();
  const lineSequence = useRef(0);
  const [lines, setLines] = useState<readonly LineDraft[]>(
    () =>
      quote?.lines.map((line, index) => ({
        description: line.description,
        key: `${linePrefix}-initial-${index}`,
        price: String(line.unitPriceMinor / 100).replace('.', ','),
        quantity: String(line.quantity),
        vat: line.vatRate,
      })) ?? [{ ...emptyLine, key: `${linePrefix}-initial` }],
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const addLine = () => {
    lineSequence.current += 1;
    const key = `${linePrefix}-${lineSequence.current}`;
    setLines((current) => [...current, { ...emptyLine, key }]);
  };
  const setLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((line, at) => (at === index ? { ...line, ...patch } : line)));

  const parsed = lines.map((line) => ({
    description: line.description.trim(),
    quantity: parsePositiveInt(line.quantity),
    unitPriceMinor: parseAmountMinor(line.price),
    vatRate: line.vat,
  }));
  const valid = parsed.every(
    (line) => line.description !== '' && line.quantity !== undefined && line.unitPriceMinor !== undefined,
  );
  const totals = valid
    ? salesTotals(
        parsed.map((line) => ({
          quantity: line.quantity ?? 0,
          unitPriceMinor: line.unitPriceMinor ?? 0,
          vatRate: line.vatRate,
        })),
      )
    : undefined;

  const submit = (status: 'draft' | 'sent') =>
    submitSalesQuoteDraft(
      { customerId, customers, date, k, note, onSaved, parsed, quote, run, setBusy, setError, t, valid, validUntil },
      status,
    );

  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            {t(cancelLabelKey)}
          </Button>
          {quote === undefined && (
            <Button
              disabled={busy}
              onClick={() => {
                browserRuntime.runFork(submit('draft'));
              }}
              theme="outlined"
              variant="secondary"
            >
              {k('sales.form.saveDraft')}
            </Button>
          )}
          <Button
            isLoading={busy}
            onClick={() => {
              browserRuntime.runFork(submit('sent'));
            }}
            variant="primary"
          >
            {quote === undefined ? k('sales.form.saveSent') : k('sales.form.saveChanges')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(closeLabelKey)}
      size="xl"
      title={quote === undefined ? k('sales.newQuote') : k('sales.editQuote', { number: quote.number })}
    >
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        {quote !== undefined && quote.salesOrderId !== undefined && (
          <StatusText showIcon status="default">
            {k('sales.form.copyNote')}
          </StatusText>
        )}
        {customers.status === 'ready' ? (
          <Select
            items={customers.customers.map((entry) => ({
              displayValue: entry.name,
              label: entry.name,
              value: entry.counterpartyId,
            }))}
            label={k(customerLabelKey)}
            name="sales-customer"
            onValueChange={({ value }) => setCustomerId(value[0] ?? '')}
            placeholder={k('sales.form.pickCustomer')}
            size="md"
            value={customerId === '' ? [] : [customerId]}
          />
        ) : (
          <p className="text-fg-secondary text-sm">
            {k(customers.status === 'loading' ? 'sales.form.customersLoading' : 'sales.form.customersUnavailable')}
          </p>
        )}
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormInput
            id="sales-quote-date"
            label={k('sales.fields.date')}
            onChange={(event) => setDate(event.target.value)}
            required
            type="date"
            value={date}
          />
          <FormInput
            id="sales-quote-valid"
            label={k('sales.fields.validUntil')}
            onChange={(event) => setValidUntil(event.target.value)}
            type="date"
            value={validUntil}
          />
        </div>
        <fieldset className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
          <legend className="px-50 font-semibold text-sm">{k(linesLabelKey)}</legend>
          {lines.map((line, index) => (
            <div className="flex flex-col gap-100 border-border-secondary border-b pb-150" key={line.key}>
              <FormInput
                id={`sales-line-${index}-description`}
                label={k('sales.fields.description')}
                onChange={(event) => setLine(index, { description: event.target.value })}
                placeholder={k('sales.form.descriptionPlaceholder')}
                value={line.description}
              />
              <div className="grid items-end gap-100" style={{ gridTemplateColumns: '7rem minmax(6rem, 1fr) 6.5rem' }}>
                <FormInput
                  id={`sales-line-${index}-quantity`}
                  inputMode="numeric"
                  label={k('sales.fields.quantity')}
                  onChange={(event) => setLine(index, { quantity: event.target.value })}
                  value={line.quantity}
                />
                <FormInput
                  id={`sales-line-${index}-price`}
                  inputMode="decimal"
                  label={k('sales.fields.unitPrice')}
                  onChange={(event) => setLine(index, { price: event.target.value })}
                  placeholder="4 500"
                  value={line.price}
                />
                <Select
                  items={vatRates.map((rate) => ({
                    displayValue: `${rate} %`,
                    label: `${rate} %`,
                    value: String(rate),
                  }))}
                  label={k('sales.fields.vat')}
                  name={`sales-line-${index}-vat`}
                  onValueChange={({ value }) => {
                    const selectedRate = vatRates.find((candidate) => candidate === Number(value[0] ?? 21));
                    if (selectedRate !== undefined) {
                      setLine(index, { vat: selectedRate });
                    }
                  }}
                  size="md"
                  value={[String(line.vat)]}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  disabled={lines.length === 1}
                  onClick={() => setLines((current) => withoutSalesLine(current, line.key))}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  {k('sales.form.removeLine')}
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-100">
            <Button onClick={addLine} size="sm" theme="outlined" variant="secondary">
              {k('sales.form.addLine')}
            </Button>
            {totals !== undefined && (
              <span className="text-sm">
                {k('sales.totals', { base: formatAmount(totals.baseMinor), total: formatAmount(totals.totalMinor) })}
              </span>
            )}
          </div>
        </fieldset>
        <FormTextarea
          id="sales-quote-note"
          label={k(noteLabelKey)}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          value={note}
        />
      </div>
    </SidePanel>
  );
};

// ── Detail panels ────────────────────────────────────────────────────────────────────────────────────────────────

const LinesTable = ({
  delivered,
  lines,
}: {
  readonly delivered?: boolean;
  readonly lines: SalesQuote['lines'] | SalesOrder['lines'];
}) => {
  const k = usePurchasingT();
  return (
    <div className="overflow-x-auto">
      <Table size="sm" variant="line">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>{k('sales.fields.description')}</Table.ColumnHeader>
            <Table.ColumnHeader className="text-right">{k('sales.fields.quantity')}</Table.ColumnHeader>
            {delivered === true && (
              <Table.ColumnHeader className="text-right">{k('sales.columns.deliveredShort')}</Table.ColumnHeader>
            )}
            <Table.ColumnHeader className="text-right">{k('sales.fields.unitPrice')}</Table.ColumnHeader>
            <Table.ColumnHeader className="text-right">{k('sales.fields.vat')}</Table.ColumnHeader>
            <Table.ColumnHeader className="text-right">{k('sales.columns.lineTotal')}</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {lines.map((line) => (
            <Table.Row key={line.id}>
              <Table.Cell className="min-w-[12rem] font-medium">{line.description}</Table.Cell>
              <Table.Cell className="text-right tabular-nums">{line.quantity}</Table.Cell>
              {delivered === true && (
                <Table.Cell className="text-right tabular-nums">
                  {'deliveredQuantity' in line ? line.deliveredQuantity : 0}
                </Table.Cell>
              )}
              <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                {formatAmount(line.unitPriceMinor)}
              </Table.Cell>
              <Table.Cell className="whitespace-nowrap text-right tabular-nums">{`${line.vatRate} %`}</Table.Cell>
              <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                {formatAmount(line.quantity * line.unitPriceMinor)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

interface SubmitSalesQuoteCommandInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly run: RunCommand;
  readonly setBusy: (value: boolean) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}
const submitSalesQuoteCommand = Effect.fn('FacilityOperations.Purchasing.submitSalesQuoteCommand')(
  function* applySalesQuoteCommand(
    input: SubmitSalesQuoteCommandInput,
    command: Parameters<RunCommand>[0],
    success: string,
    after?: (id: string | undefined) => void,
  ) {
    const { k, run, setBusy, t, toast } = input;
    setBusy(true);
    const outcome = yield* run(command);
    setBusy(false);
    toast.create(
      outcome.ok ? { title: k(success), type: 'success' } : { title: t(failureKey(outcome.reason)), type: 'error' },
    );
    if (outcome.ok) {
      after?.(outcome.result.entityIds[0]);
    }
  },
);

export const SalesQuotePanel = ({
  canWrite,
  onClose,
  onEdit,
  onOpenOrder,
  quoteId,
  run,
  state,
}: {
  readonly canWrite: boolean;
  readonly onClose: () => void;
  readonly onEdit: (quote: SalesQuote) => void;
  readonly onOpenOrder: (id: string) => void;
  readonly quoteId: string;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const quote = (state.salesQuotes ?? []).find((entry) => entry.id === quoteId);
  if (quote === undefined) {
    return null;
  }
  const totals = salesTotals(quote.lines);
  const order = (state.salesOrders ?? []).find((entry) => entry.id === quote.salesOrderId);
  const act = (command: Parameters<RunCommand>[0], success: string, after?: (id: string | undefined) => void) =>
    submitSalesQuoteCommand({ k, run, setBusy, t, toast }, command, success, after);
  return (
    <SidePanel
      description={quote.customer.name}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(closeLabelKey)}
      size="xl"
      title={k('sales.quoteTitle', { number: quote.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <Badge size="sm" variant={quoteVariant[quote.status]}>
            {k(`sales.quoteStatus.${quote.status}`)}
          </Badge>
          <span className="font-semibold text-lg tabular-nums">{formatAmount(totals.baseMinor)}</span>
          <span className="text-fg-secondary text-sm">{k(withVatKey, { total: formatAmount(totals.totalMinor) })}</span>
          <span className="flex-1" />
          {canWrite && quote.status !== 'rejected' && (
            <Button disabled={busy} onClick={() => onEdit(quote)} size="sm" theme="outlined" variant="secondary">
              {k('sales.actions.editQuote')}
            </Button>
          )}
          {canWrite && (quote.status === 'draft' || quote.status === 'sent') && (
            <>
              <Button
                disabled={busy}
                onClick={() => {
                  browserRuntime.runFork(
                    act({ _tag: 'SalesQuoteReject', quoteId: quote.id }, 'sales.messages.rejected'),
                  );
                }}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {k('sales.actions.reject')}
              </Button>
              <Button
                isLoading={busy}
                onClick={() => {
                  browserRuntime.runFork(
                    act(
                      { _tag: 'SalesOrderCreateFromQuote', quoteId: quote.id },
                      'sales.messages.orderCreated',
                      (id) => {
                        if (id !== undefined) {
                          onOpenOrder(id);
                        }
                      },
                    ),
                  );
                }}
                size="sm"
                variant="primary"
              >
                {k('sales.actions.createOrder')}
              </Button>
            </>
          )}
          {order !== undefined && (
            <Button onClick={() => onOpenOrder(order.id)} size="sm" theme="outlined" variant="secondary">
              {k('sales.actions.openOrder', { number: order.number })}
            </Button>
          )}
        </div>
        <SectionCard title={k('sales.detail.info')}>
          <DetailList
            items={[
              { label: k(customerLabelKey), value: quote.customer.name },
              { label: k('sales.fields.date'), value: formatDate(quote.date) },
              {
                label: k('sales.fields.validUntil'),
                value: quote.validUntil === undefined ? '—' : formatDate(quote.validUntil),
              },
              ...(quote.note === undefined ? [] : [{ label: k(noteLabelKey), value: quote.note }]),
              { label: k('sales.detail.lastChange'), value: formatStamp(quote.updatedAt) },
            ]}
          />
        </SectionCard>
        <SectionCard title={k(linesLabelKey)}>
          <LinesTable lines={quote.lines} />
        </SectionCard>
        <SectionCard>
          <ChangeHistory entityId={quote.id} refreshKey={dateTimeIso(quote.updatedAt)} />
        </SectionCard>
      </div>
    </SidePanel>
  );
};

/** Creates the issued invoice draft in Finance from a snapshot of the order, then links it back to the order. */
const prepareSalesInvoice = Effect.fn('FacilityOperations.Purchasing.prepareSalesInvoice')(
  function* prepareSalesInvoice(order: SalesOrder, issueDate: string, dueDate: string) {
    const parts = yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 });
    const idempotencyKey = `sales-invoice:${order.id}:${parts.join(':')}`;
    const snapshot = yield* readFinance('facility-operations.sales-invoice.read');
    if (!snapshot.canWrite) {
      return yield* new SalesInvoicePreparationDenied({ orderId: order.id });
    }
    const referenceCredentials = yield* makeReferenceGatewayCredentials(['party-registry']);
    const quoteSuffix = order.quoteNumber === undefined ? '' : ` (nabídka ${order.quoteNumber})`;
    const result = yield* applyFinanceCommand(
      {
        command: {
          _tag: 'CreateInvoiceDraft',
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: order.customer.counterpartyId,
            resourceType: 'party.registry.counterparty',
            tenantId: order.customer.tenantId,
          },
          currency: 'CZK',
          direction: 'OUTGOING',
          documentNumber: `${order.number}-F${order.invoices.length + 1}`,
          dueDate,
          issueDate,
          lines: order.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            vatRate: line.vatRate,
          })),
          note: `Vystaveno z prodejní objednávky ${order.number}${quoteSuffix}.`,
          ...optionalField('partyId', order.customer.partyId),
          totalMinor: Math.max(1, salesTotals(order.lines).totalMinor),
        },
        expectedRevision: snapshot.revision,
      },
      'facility-operations.sales-invoice.create',
      { idempotencyKey, referenceCredentials },
    );
    if (result.invoice === undefined) {
      return yield* new SalesInvoiceSnapshotMissing({ orderId: order.id });
    }
    return result.invoice;
  },
);

interface InvoiceIssueOutcome {
  readonly failure?:
    | Effect.Error<ReturnType<typeof prepareSalesInvoice>>
    | Extract<Effect.Success<ReturnType<RunCommand>>, { readonly ok: false }>;
  readonly number?: string;
  readonly ok: boolean;
}
const invoiceNotCreated = (failure?: InvoiceIssueOutcome['failure']): InvoiceIssueOutcome => ({
  ok: false,
  ...optionalField('failure', failure),
});

interface IssueSalesInvoiceInput {
  readonly busy: { current: boolean };
  readonly run: RunCommand;
}
const issueSalesInvoice = Effect.fn('FacilityOperations.Purchasing.issueSalesInvoice')(
  function* issueAndLinkSalesInvoice(
    input: IssueSalesInvoiceInput,
    order: SalesOrder,
    issueDate: string,
    dueDate: string,
  ) {
    const { busy, run } = input;
    if (busy.current) {
      return invoiceNotCreated();
    }
    busy.current = true;
    const created = yield* prepareSalesInvoice(order, issueDate, dueDate).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, ok: false as const }),
        onSuccess: (invoice) => ({ invoice, ok: true as const }),
      }),
    );
    if (!created.ok) {
      busy.current = false;
      return invoiceNotCreated(created.failure);
    }
    const { invoice } = created;
    const number = invoice.number ?? invoice.documentNumber;
    const linked = yield* run({
      _tag: 'SalesOrderLinkInvoice',
      invoiceId: invoice.ref.resourceId,
      number,
      orderId: order.id,
      totalMinor: invoice.totalMinor,
    });
    busy.current = false;
    return linked.ok ? { number, ok: true as const } : { failure: linked, number, ok: false as const };
  },
);

const useIssueInvoice = (run: RunCommand) => {
  const busy = useRef(false);
  return (order: SalesOrder, issueDate: string, dueDate: string) =>
    issueSalesInvoice({ busy, run }, order, issueDate, dueDate);
};

const OrderActionSchema = Schema.Literals(['deliver', 'close', 'invoice']);
type OrderAction = typeof OrderActionSchema.Type | undefined;

interface SubmitSalesOrderCommandInput {
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly run: RunCommand;
  readonly setAction: (value: OrderAction) => void;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}
const submitSalesOrderCommand = Effect.fn('FacilityOperations.Purchasing.submitSalesOrderCommand')(
  function* applySalesOrderCommand(
    input: SubmitSalesOrderCommandInput,
    command: Parameters<RunCommand>[0],
    success: string,
  ) {
    const { k, run, setAction, setBusy, setError, t, toast } = input;
    setBusy(true);
    setError(undefined);
    const outcome = yield* run(command);
    setBusy(false);
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return;
    }
    toast.create({ title: k(success), type: 'success' });
    setAction(undefined);
  },
);

interface SubmitSalesInvoiceInput {
  readonly dueDate: IsoDate;
  readonly issueDate: IsoDate;
  readonly issueInvoice: ReturnType<typeof useIssueInvoice>;
  readonly k: ReturnType<typeof usePurchasingT>;
  readonly order: SalesOrder;
  readonly setAction: (value: OrderAction) => void;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly toast: ReturnType<typeof useToast>;
}
const submitSalesInvoice = Effect.fn('FacilityOperations.Purchasing.submitSalesInvoice')(function* invoiceSalesOrder(
  input: SubmitSalesInvoiceInput,
) {
  const { dueDate, issueDate, issueInvoice, k, order, setAction, setBusy, setError, toast } = input;
  if (dueDate < issueDate) {
    setError(k('sales.form.dueDate'));
    return;
  }
  setBusy(true);
  setError(undefined);
  const outcome = yield* issueInvoice(order, issueDate, dueDate);
  setBusy(false);
  if (!outcome.ok) {
    setError(k('sales.form.invoiceFailed'));
    return;
  }
  toast.create({ title: k('sales.messages.invoiced', { number: outcome.number ?? '' }), type: 'success' });
  setAction(undefined);
});

interface SalesOrderDetailsProps {
  readonly lang: string;
  readonly onOpenQuote: (id: string) => void;
  readonly order: SalesOrder;
}
const SalesOrderDetails = ({ lang, onOpenQuote, order }: SalesOrderDetailsProps) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const history = historyRows(order.history);
  return (
    <>
      <SectionCard title={k('sales.detail.info')}>
        <DetailList
          items={[
            { label: k(customerLabelKey), value: order.customer.name },
            {
              label: k(quoteLabelKey),
              value:
                order.quoteId === undefined ? (
                  '—'
                ) : (
                  <button
                    className="underline underline-offset-2"
                    onClick={() => {
                      if (order.quoteId !== undefined) {
                        onOpenQuote(order.quoteId);
                      }
                    }}
                    type="button"
                  >
                    {order.quoteNumber ?? order.quoteId}
                  </button>
                ),
            },
            ...(order.note === undefined ? [] : [{ label: k(noteLabelKey), value: order.note }]),
            { label: k('sales.detail.lastChange'), value: formatStamp(order.updatedAt) },
          ]}
        />
      </SectionCard>
      <SectionCard title={k(linesLabelKey)}>
        <LinesTable delivered lines={order.lines} />
      </SectionCard>
      <SectionCard title={k('sales.columns.invoices')}>
        {order.invoices.length === 0 ? (
          <p className="text-fg-secondary text-sm">{k('sales.noInvoice')}</p>
        ) : (
          <ul className="flex flex-col gap-100 text-sm">
            {order.invoices.map((entry) => (
              <li className="flex flex-wrap items-center gap-150" key={entry.invoiceId}>
                <span className="font-medium tabular-nums">{entry.number}</span>
                {entry.totalMinor !== undefined && (
                  <span className="tabular-nums">{formatAmount(entry.totalMinor)}</span>
                )}
                <span className="text-fg-secondary text-xs">{formatStamp(entry.linkedAt)}</span>
                <a
                  className="font-medium underline underline-offset-2"
                  href={`/${lang}/finance?resourceId=${encodeURIComponent(entry.invoiceId)}`}
                >
                  {k('sales.openInvoice')}
                </a>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={k('sales.detail.history')}>
        {Result.isFailure(history) ? (
          <StatusText showIcon status="error">
            {t('facility-operations.common.errors.unavailable')}
          </StatusText>
        ) : (
          <ol className="flex flex-col gap-100 border-border-primary border-l pl-200 text-sm">
            {history.success.map(({ entry, key }) => (
              <li className="flex flex-col" key={key}>
                <span className="flex flex-wrap items-center gap-100">
                  <Badge size="sm" variant={orderVariant[entry.status]}>
                    {k(`orderStatus.${entry.status}`)}
                  </Badge>
                  <span className="font-medium">{k(`sales.event.${entry.event}`)}</span>
                  <span className="text-fg-secondary text-xs">{formatStamp(entry.at)}</span>
                </span>
                {entry.note !== undefined && <span className="text-fg-secondary text-xs">{entry.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </SectionCard>
      <SectionCard>
        <ChangeHistory entityId={order.id} refreshKey={dateTimeIso(order.updatedAt)} />
      </SectionCard>
    </>
  );
};

const salesOrderCapabilities = (
  order: SalesOrder,
  finance: ReturnType<typeof useIncomingInvoiceLinks>,
  canWrite: boolean,
  remainingCount: number,
) => {
  const persisted = order.status !== 'draft' && order.status !== 'cancelled';
  const financeWritable = finance.status === 'ready' && finance.canWrite;
  const financeReadOnly = finance.status === 'ready' && !finance.canWrite;
  return {
    cancellable:
      (order.status === 'draft' || order.status === 'approved' || order.status === 'ordered') &&
      order.deliveries.length === 0,
    deliverable: (order.status === 'ordered' || order.status === 'partially_delivered') && remainingCount > 0,
    hasRemaining: remainingCount > 0 && persisted,
    invoiceReadOnly: canWrite && financeReadOnly && persisted,
    invoiceWritable: canWrite && financeWritable && persisted,
  };
};

export const SalesOrderPanel = ({
  canWrite,
  onClose,
  onOpenQuote,
  orderId,
  run,
  state,
}: {
  readonly canWrite: boolean;
  readonly onClose: () => void;
  readonly onOpenQuote: (id: string) => void;
  readonly orderId: string;
  readonly run: RunCommand;
  readonly state: PurchasingState;
}) => {
  const k = usePurchasingT();
  const { language, t } = useModernI18n();
  const toast = useToast();
  const issueInvoice = useIssueInvoice(run);
  // Finance decides who may create invoice drafts; read-only Finance roles get no invoice action at all.
  const finance = useIncomingInvoiceLinks();
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<OrderAction>();
  const [deliveryDate, setDeliveryDate] = useState(todayIso);
  const [quantities, setQuantities] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso);
  const [dueDate, setDueDate] = useState(() => addDays(todayIso(), 14));
  const [error, setError] = useState<string>();
  const order = (state.salesOrders ?? []).find((entry) => entry.id === orderId);
  if (order === undefined) {
    return null;
  }
  const lang = language.startsWith('en') ? 'en' : 'cs';
  const totals = salesTotals(order.lines);
  const remainder = salesRemainder(order);
  const done = (command: Parameters<RunCommand>[0], success: string) =>
    submitSalesOrderCommand({ k, run, setAction, setBusy, setError, t, toast }, command, success);
  const deliver = () => {
    const lines = remainder
      .map(({ line }) => ({ lineId: line.id, quantity: parsePositiveInt(quantities[line.id] ?? '') }))
      .filter((entry): entry is { lineId: typeof entry.lineId; quantity: number } => entry.quantity !== undefined);
    if (lines.length === 0) {
      setError(k('sales.form.deliveryRequired'));
      return;
    }
    browserRuntime.runFork(
      done({ _tag: 'SalesOrderDeliver', date: deliveryDate, lines, orderId: order.id }, 'sales.messages.delivered'),
    );
  };
  const invoice = () =>
    submitSalesInvoice({ dueDate, issueDate, issueInvoice, k, order, setAction, setBusy, setError, toast });
  const capabilities = salesOrderCapabilities(order, finance, canWrite, remainder.length);
  return (
    <SidePanel
      closeOnInteractOutside={action === undefined}
      description={order.customer.name}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(closeLabelKey)}
      size="xl"
      title={k('sales.orderTitle', { number: order.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <Badge size="sm" variant={orderVariant[order.status]}>
            {k(`orderStatus.${order.status}`)}
          </Badge>
          <span className="font-semibold text-lg tabular-nums">{formatAmount(totals.baseMinor)}</span>
          <span className="text-fg-secondary text-sm">{k(withVatKey, { total: formatAmount(totals.totalMinor) })}</span>
          {capabilities.hasRemaining && (
            <Badge size="sm" variant="warning">
              {k('sales.remaining', { count: remainder.reduce((sum, entry) => sum + entry.remaining, 0) })}
            </Badge>
          )}
        </div>
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error}
          </StatusText>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-100">
            {order.status === 'draft' && (
              <Button
                disabled={busy}
                onClick={() => {
                  browserRuntime.runFork(
                    done(
                      { _tag: 'SalesOrderTransition', orderId: order.id, to: 'approved' },
                      'sales.messages.approved',
                    ),
                  );
                }}
                size="sm"
                variant="primary"
              >
                {k('sales.actions.approve')}
              </Button>
            )}
            {order.status === 'approved' && (
              <Button
                disabled={busy}
                onClick={() => {
                  browserRuntime.runFork(
                    done(
                      { _tag: 'SalesOrderTransition', orderId: order.id, to: 'ordered' },
                      'sales.messages.confirmed',
                    ),
                  );
                }}
                size="sm"
                variant="primary"
              >
                {k('sales.actions.confirm')}
              </Button>
            )}
            {capabilities.deliverable && (
              <Button
                disabled={busy}
                onClick={() => setAction('deliver')}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {k('sales.actions.deliver')}
              </Button>
            )}
            {capabilities.invoiceWritable && (
              <Button
                disabled={busy}
                onClick={() => setAction('invoice')}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {k('sales.actions.invoice')}
              </Button>
            )}
            {order.status === 'partially_delivered' && (
              <Button
                disabled={busy}
                onClick={() => setAction('close')}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {k(closeActionKey)}
              </Button>
            )}
            {capabilities.cancellable && (
              <Button
                disabled={busy}
                onClick={() => {
                  browserRuntime.runFork(
                    done(
                      { _tag: 'SalesOrderTransition', orderId: order.id, to: 'cancelled' },
                      'sales.messages.cancelled',
                    ),
                  );
                }}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {k('sales.actions.cancel')}
              </Button>
            )}
          </div>
        )}
        {capabilities.invoiceReadOnly && (
          <p className="text-fg-secondary text-xs" data-testid="sales-invoice-readonly">
            Fakturu k této objednávce vystaví účetní nebo vedení ve Financích. Vaše role má ve Financích jen čtení.
          </p>
        )}
        {action === 'deliver' && (
          <SectionCard title={k('sales.actions.deliver')}>
            <FormInput
              id="sales-delivery-date"
              label={k('sales.fields.deliveryDate')}
              onChange={(event) => setDeliveryDate(event.target.value)}
              type="date"
              value={deliveryDate}
            />
            {remainder.map(({ line, remaining }) => (
              <FormInput
                helpText={k('sales.form.remainingHelp', { count: remaining })}
                id={`sales-deliver-${line.id}`}
                inputMode="numeric"
                key={line.id}
                label={line.description}
                onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                value={quantities[line.id] ?? ''}
              />
            ))}
            <div className="flex justify-end gap-100">
              <Button onClick={() => setAction(undefined)} size="sm" theme="outlined" variant="secondary">
                {t(cancelLabelKey)}
              </Button>
              <Button isLoading={busy} onClick={deliver} size="sm" variant="primary">
                {k('sales.actions.saveDelivery')}
              </Button>
            </div>
          </SectionCard>
        )}
        {action === 'close' && (
          <SectionCard title={k(closeActionKey)}>
            <FormTextarea
              id="sales-close-reason"
              label={k('sales.fields.closeReason')}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              value={reason}
            />
            <div className="flex justify-end gap-100">
              <Button onClick={() => setAction(undefined)} size="sm" theme="outlined" variant="secondary">
                {t(cancelLabelKey)}
              </Button>
              <Button
                disabled={reason.trim() === ''}
                isLoading={busy}
                onClick={() => {
                  browserRuntime.runFork(
                    done(
                      { _tag: 'SalesOrderTransition', note: reason.trim(), orderId: order.id, to: 'completed' },
                      'sales.messages.closed',
                    ),
                  );
                }}
                size="sm"
                variant="primary"
              >
                {k(closeActionKey)}
              </Button>
            </div>
          </SectionCard>
        )}
        {action === 'invoice' && capabilities.invoiceWritable && (
          <SectionCard title={k('sales.actions.invoice')}>
            <p className="text-fg-secondary text-sm">
              {k('sales.form.invoiceIntro', { customer: order.customer.name })}
            </p>
            <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
              <FormInput
                id="sales-invoice-issue"
                label={k('sales.fields.issueDate')}
                onChange={(event) => setIssueDate(event.target.value)}
                type="date"
                value={issueDate}
              />
              <FormInput
                id="sales-invoice-due"
                label={k('sales.fields.dueDate')}
                onChange={(event) => setDueDate(event.target.value)}
                type="date"
                value={dueDate}
              />
            </div>
            <p className="font-semibold text-sm">{k(withVatKey, { total: formatAmount(totals.totalMinor) })}</p>
            <div className="flex justify-end gap-100">
              <Button onClick={() => setAction(undefined)} size="sm" theme="outlined" variant="secondary">
                {t(cancelLabelKey)}
              </Button>
              <Button
                isLoading={busy}
                onClick={() => {
                  browserRuntime.runFork(invoice());
                }}
                size="sm"
                variant="primary"
              >
                {k('sales.actions.createInvoice')}
              </Button>
            </div>
          </SectionCard>
        )}
        <SalesOrderDetails lang={lang} onOpenQuote={onOpenQuote} order={order} />
      </div>
    </SidePanel>
  );
};
