// @effect-diagnostics asyncFunction:off
// S06 prodej: nabídky zákazníkům → prodejní objednávky → dodání → vystavená faktura (návrh ve Financích).
// The customer is a party-registry counterparty; the invoice is created by Finance from a snapshot of the order lines
// and counterparty (CreateInvoiceDraft), so a later quote edit never changes an issued invoice.
import { listCustomers } from '@app/party-registry/api/client';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { DetailList, EmptyState, SectionCard, SidePanel, formatDate, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Effect, Random } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { salesRemainder } from '../../../../../../shared/commands/sales.ts';
import type {
  PurchasingState,
  SalesCustomer,
  SalesOrder,
  SalesQuote,
  SalesVatRate,
} from '../../../../../../shared/domain/purchasing.ts';
import { salesTotals } from '../../../../../../shared/domain/purchasing.ts';
import { ChangeHistory } from '../../../../../ui/change-history.tsx';
import { applyFinanceCommand, readFinance } from '../../../../../api/finance-reads.ts';
import { useIncomingInvoiceLinks } from './finance-links.tsx';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import { addDays } from '../../../../../ui/ops-agenda/deadlines.ts';
import { dateTimeIso, failureKey, formatAmount, formatStamp, parseAmountMinor, parsePositiveInt, todayIso, usePurchasingT } from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

const vatRates: readonly SalesVatRate[] = [21, 12, 10, 0];
type Variant = 'outline' | 'info' | 'warning' | 'success' | 'danger';
const quoteVariant: Readonly<Record<SalesQuote['status'], Variant>> = {
  accepted: 'success',
  draft: 'outline',
  rejected: 'danger',
  sent: 'info',
};
const orderVariant: Readonly<Record<SalesOrder['status'], Variant>> = {
  approved: 'info',
  cancelled: 'outline',
  completed: 'success',
  draft: 'outline',
  ordered: 'info',
  partially_delivered: 'warning',
};

// ── Customers (party registry) ───────────────────────────────────────────────────────────────────────────────────

type CustomersState =
  | { readonly status: 'loading' | 'failed' }
  | { readonly status: 'ready'; readonly customers: readonly SalesCustomer[] };

const useCustomers = (): CustomersState => {
  const [state, setState] = useState<CustomersState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      listCustomers({ includeArchived: false }).pipe(
        Effect.timeout('12 seconds'),
        Effect.match({
          onFailure: (): CustomersState => ({ status: 'failed' }),
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
        Effect.map((next) => {
          if (alive) setState(next);
        }),
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
                  <Table.ColumnHeader>{k('sales.columns.quote')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.invoices')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {orders.map((order) => {
                  const ordered = order.lines.reduce((sum, line) => sum + line.quantity, 0);
                  const delivered = order.lines.reduce((sum, line) => sum + line.deliveredQuantity, 0);
                  return (
                    <Table.Row className="cursor-pointer hover:bg-surface-hover" key={order.id} onClick={() => onOpenOrder(order.id)}>
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
                        {order.invoices.length === 0 ? k('sales.noInvoice') : order.invoices.map((invoice) => invoice.number).join(', ')}
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
                  <Table.ColumnHeader>{k('sales.columns.quote')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.status')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.date')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.validUntil')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('sales.columns.total')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('sales.columns.order')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {quotes.map((quote) => (
                  <Table.Row className="cursor-pointer hover:bg-surface-hover" key={quote.id} onClick={() => onOpenQuote(quote.id)}>
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
                    <Table.Cell className="tabular-nums">{quote.validUntil === undefined ? '—' : formatDate(quote.validUntil)}</Table.Cell>
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
  readonly quantity: string;
  readonly price: string;
  readonly vat: SalesVatRate;
}
const emptyLine: LineDraft = { description: '', price: '', quantity: '1', vat: 21 };

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
  const [lines, setLines] = useState<readonly LineDraft[]>(
    quote?.lines.map((line) => ({
      description: line.description,
      price: String(line.unitPriceMinor / 100).replace('.', ','),
      quantity: String(line.quantity),
      vat: line.vatRate,
    })) ?? [emptyLine],
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

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
    ? salesTotals(parsed.map((line) => ({ quantity: line.quantity ?? 0, unitPriceMinor: line.unitPriceMinor ?? 0, vatRate: line.vatRate })))
    : undefined;

  const submit = async (status: 'draft' | 'sent') => {
    const customer = customers.status === 'ready' ? customers.customers.find((entry) => entry.counterpartyId === customerId) : undefined;
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
      ...(validUntil === '' ? {} : { validUntil }),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    };
    const outcome = await run(
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
  };

  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            {t('siampark-ops.common.cancel')}
          </Button>
          {quote === undefined && (
            <Button disabled={busy} onClick={() => void submit('draft')} theme="outlined" variant="secondary">
              {k('sales.form.saveDraft')}
            </Button>
          )}
          <Button isLoading={busy} onClick={() => void submit('sent')} variant="primary">
            {quote === undefined ? k('sales.form.saveSent') : k('sales.form.saveChanges')}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('siampark-ops.common.close')}
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
            items={customers.customers.map((entry) => ({ displayValue: entry.name, label: entry.name, value: entry.counterpartyId }))}
            label={k('sales.fields.customer')}
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
          <FormInput id="sales-quote-date" label={k('sales.fields.date')} onChange={(event) => setDate(event.target.value)} required type="date" value={date} />
          <FormInput
            id="sales-quote-valid"
            label={k('sales.fields.validUntil')}
            onChange={(event) => setValidUntil(event.target.value)}
            type="date"
            value={validUntil}
          />
        </div>
        <fieldset className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
          <legend className="px-50 font-semibold text-sm">{k('sales.fields.lines')}</legend>
          {lines.map((line, index) => (
            <div className="flex flex-col gap-100 border-border-secondary border-b pb-150" key={index}>
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
                items={vatRates.map((rate) => ({ displayValue: `${rate} %`, label: `${rate} %`, value: String(rate) }))}
                label={k('sales.fields.vat')}
                name={`sales-line-${index}-vat`}
                onValueChange={({ value }) => setLine(index, { vat: (Number(value[0] ?? 21) as SalesVatRate) })}
                size="md"
                value={[String(line.vat)]}
              />
              </div>
              <div className="flex justify-end">
                <Button
                  disabled={lines.length === 1}
                  onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
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
            <Button onClick={() => setLines((current) => [...current, emptyLine])} size="sm" theme="outlined" variant="secondary">
              {k('sales.form.addLine')}
            </Button>
            {totals !== undefined && (
              <span className="text-sm">
                {k('sales.totals', { base: formatAmount(totals.baseMinor), total: formatAmount(totals.totalMinor) })}
              </span>
            )}
          </div>
        </fieldset>
        <FormTextarea id="sales-quote-note" label={k('sales.fields.note')} onChange={(event) => setNote(event.target.value)} rows={2} value={note} />
      </div>
    </SidePanel>
  );
};

// ── Detail panels ────────────────────────────────────────────────────────────────────────────────────────────────

const LinesTable = ({ lines, delivered }: { readonly lines: SalesQuote['lines'] | SalesOrder['lines']; readonly delivered?: boolean }) => {
  const k = usePurchasingT();
  return (
    <div className="overflow-x-auto">
      <Table size="sm" variant="line">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>{k('sales.fields.description')}</Table.ColumnHeader>
            <Table.ColumnHeader className="text-right">{k('sales.fields.quantity')}</Table.ColumnHeader>
            {delivered === true && <Table.ColumnHeader className="text-right">{k('sales.columns.deliveredShort')}</Table.ColumnHeader>}
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
                <Table.Cell className="text-right tabular-nums">{'deliveredQuantity' in line ? line.deliveredQuantity : 0}</Table.Cell>
              )}
              <Table.Cell className="whitespace-nowrap text-right tabular-nums">{formatAmount(line.unitPriceMinor)}</Table.Cell>
              <Table.Cell className="whitespace-nowrap text-right tabular-nums">{`${line.vatRate} %`}</Table.Cell>
              <Table.Cell className="whitespace-nowrap text-right tabular-nums">{formatAmount(line.quantity * line.unitPriceMinor)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

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
  const act = async (command: Parameters<RunCommand>[0], success: string, after?: (id: string | undefined) => void) => {
    setBusy(true);
    const outcome = await run(command);
    setBusy(false);
    toast.create(
      outcome.ok ? { title: k(success), type: 'success' } : { title: t(failureKey(outcome.reason)), type: 'error' },
    );
    if (outcome.ok) after?.(outcome.result.entityIds[0]);
  };
  return (
    <SidePanel
      description={quote.customer.name}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('siampark-ops.common.close')}
      size="xl"
      title={k('sales.quoteTitle', { number: quote.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <Badge size="sm" variant={quoteVariant[quote.status]}>
            {k(`sales.quoteStatus.${quote.status}`)}
          </Badge>
          <span className="font-semibold text-lg tabular-nums">{formatAmount(totals.baseMinor)}</span>
          <span className="text-fg-secondary text-sm">{k('sales.withVat', { total: formatAmount(totals.totalMinor) })}</span>
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
                onClick={() => void act({ _tag: 'SalesQuoteReject', quoteId: quote.id }, 'sales.messages.rejected')}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {k('sales.actions.reject')}
              </Button>
              <Button
                isLoading={busy}
                onClick={() =>
                  void act({ _tag: 'SalesOrderCreateFromQuote', quoteId: quote.id }, 'sales.messages.orderCreated', (id) => {
                    if (id !== undefined) onOpenOrder(id);
                  })
                }
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
              { label: k('sales.fields.customer'), value: quote.customer.name },
              { label: k('sales.fields.date'), value: formatDate(quote.date) },
              { label: k('sales.fields.validUntil'), value: quote.validUntil === undefined ? '—' : formatDate(quote.validUntil) },
              ...(quote.note === undefined ? [] : [{ label: k('sales.fields.note'), value: quote.note }]),
              { label: k('sales.detail.lastChange'), value: formatStamp(quote.updatedAt) },
            ]}
          />
        </SectionCard>
        <SectionCard title={k('sales.fields.lines')}>
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
const useIssueInvoice = (run: RunCommand) => {
  const busy = useRef(false);
  return async (order: SalesOrder, issueDate: string, dueDate: string): Promise<{ ok: boolean; number?: string }> => {
    if (busy.current) return { ok: false };
    busy.current = true;
    const created = await browserRuntime.runPromise(
      Effect.gen(function* issueInvoice() {
        const parts = yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt]);
        const idempotencyKey = `sales-invoice:${order.id}:${parts.join(':')}`;
        const snapshot = yield* readFinance('siampark-ops.sales-invoice.read');
        const referenceCredentials = yield* makeReferenceGatewayCredentials(['party-registry']);
        return yield* applyFinanceCommand(
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
              note: `Vystaveno z prodejní objednávky ${order.number}${order.quoteNumber === undefined ? '' : ` (nabídka ${order.quoteNumber})`}.`,
              ...(order.customer.partyId === undefined ? {} : { partyId: order.customer.partyId }),
              totalMinor: Math.max(1, salesTotals(order.lines).totalMinor),
            },
            expectedRevision: snapshot.revision,
          },
          'siampark-ops.sales-invoice.create',
          { idempotencyKey, referenceCredentials },
        );
      }).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (result) => result.invoice,
        }),
      ),
    );
    if (created === undefined) {
      busy.current = false;
      return { ok: false };
    }
    const number = created.number ?? created.documentNumber;
    const linked = await run({
      _tag: 'SalesOrderLinkInvoice',
      invoiceId: created.ref.resourceId,
      number,
      orderId: order.id,
      totalMinor: created.totalMinor,
    });
    busy.current = false;
    return { number, ok: linked.ok };
  };
};

type OrderAction = 'deliver' | 'close' | 'invoice' | undefined;

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
  const [action, setAction] = useState<OrderAction>(undefined);
  const [deliveryDate, setDeliveryDate] = useState(todayIso());
  const [quantities, setQuantities] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(addDays(todayIso(), 14));
  const [error, setError] = useState<string>();
  const order = (state.salesOrders ?? []).find((entry) => entry.id === orderId);
  if (order === undefined) {
    return null;
  }
  const lang = language.startsWith('en') ? 'en' : 'cs';
  const totals = salesTotals(order.lines);
  const remainder = salesRemainder(order);
  const done = async (command: Parameters<RunCommand>[0], success: string) => {
    setBusy(true);
    setError(undefined);
    const outcome = await run(command);
    setBusy(false);
    if (!outcome.ok) {
      setError(t(failureKey(outcome.reason)));
      return;
    }
    toast.create({ title: k(success), type: 'success' });
    setAction(undefined);
  };
  const deliver = () => {
    const lines = remainder
      .map(({ line }) => ({ lineId: line.id, quantity: parsePositiveInt(quantities[line.id] ?? '') }))
      .filter((entry): entry is { lineId: typeof entry.lineId; quantity: number } => entry.quantity !== undefined);
    if (lines.length === 0) {
      setError(k('sales.form.deliveryRequired'));
      return;
    }
    void done({ _tag: 'SalesOrderDeliver', date: deliveryDate, lines, orderId: order.id }, 'sales.messages.delivered');
  };
  const invoice = async () => {
    if (dueDate < issueDate) {
      setError(k('sales.form.dueDate'));
      return;
    }
    setBusy(true);
    setError(undefined);
    const outcome = await issueInvoice(order, issueDate, dueDate);
    setBusy(false);
    if (!outcome.ok) {
      setError(k('sales.form.invoiceFailed'));
      return;
    }
    toast.create({ title: k('sales.messages.invoiced', { number: outcome.number ?? '' }), type: 'success' });
    setAction(undefined);
  };
  const financeWritable = finance.status === 'ready' && finance.canWrite;
  const canInvoice = canWrite && financeWritable && order.status !== 'draft' && order.status !== 'cancelled';
  return (
    <SidePanel
      closeOnInteractOutside={action === undefined}
      description={order.customer.name}
      onOpenChange={(open) => !open && onClose()}
      open
      resizeLabel={t('siampark-ops.common.close')}
      size="xl"
      title={k('sales.orderTitle', { number: order.number })}
    >
      <div className="flex flex-col gap-250 py-200">
        <div className="flex flex-wrap items-center gap-150">
          <Badge size="sm" variant={orderVariant[order.status]}>
            {k(`orderStatus.${order.status}`)}
          </Badge>
          <span className="font-semibold text-lg tabular-nums">{formatAmount(totals.baseMinor)}</span>
          <span className="text-fg-secondary text-sm">{k('sales.withVat', { total: formatAmount(totals.totalMinor) })}</span>
          {remainder.length > 0 && order.status !== 'cancelled' && order.status !== 'draft' && (
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
              <Button disabled={busy} onClick={() => void done({ _tag: 'SalesOrderTransition', orderId: order.id, to: 'approved' }, 'sales.messages.approved')} size="sm" variant="primary">
                {k('sales.actions.approve')}
              </Button>
            )}
            {order.status === 'approved' && (
              <Button disabled={busy} onClick={() => void done({ _tag: 'SalesOrderTransition', orderId: order.id, to: 'ordered' }, 'sales.messages.confirmed')} size="sm" variant="primary">
                {k('sales.actions.confirm')}
              </Button>
            )}
            {(order.status === 'ordered' || order.status === 'partially_delivered') && remainder.length > 0 && (
              <Button disabled={busy} onClick={() => setAction('deliver')} size="sm" theme="outlined" variant="secondary">
                {k('sales.actions.deliver')}
              </Button>
            )}
            {canInvoice && (
              <Button disabled={busy} onClick={() => setAction('invoice')} size="sm" theme="outlined" variant="secondary">
                {k('sales.actions.invoice')}
              </Button>
            )}
            {order.status === 'partially_delivered' && (
              <Button disabled={busy} onClick={() => setAction('close')} size="sm" theme="borderless" variant="secondary">
                {k('sales.actions.close')}
              </Button>
            )}
            {(order.status === 'draft' || order.status === 'approved' || order.status === 'ordered') && order.deliveries.length === 0 && (
              <Button disabled={busy} onClick={() => void done({ _tag: 'SalesOrderTransition', orderId: order.id, to: 'cancelled' }, 'sales.messages.cancelled')} size="sm" theme="borderless" variant="secondary">
                {k('sales.actions.cancel')}
              </Button>
            )}
          </div>
        )}
        {canWrite &&
          finance.status === 'ready' &&
          !finance.canWrite &&
          order.status !== 'draft' &&
          order.status !== 'cancelled' && (
            <p className="text-fg-secondary text-xs" data-testid="sales-invoice-readonly">
              Fakturu k této objednávce vystaví účetní nebo vedení ve Financích. Vaše role má ve Financích jen čtení.
            </p>
          )}
        {action === 'deliver' && (
          <SectionCard title={k('sales.actions.deliver')}>
            <FormInput id="sales-delivery-date" label={k('sales.fields.deliveryDate')} onChange={(event) => setDeliveryDate(event.target.value)} type="date" value={deliveryDate} />
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
                {t('siampark-ops.common.cancel')}
              </Button>
              <Button isLoading={busy} onClick={deliver} size="sm" variant="primary">
                {k('sales.actions.saveDelivery')}
              </Button>
            </div>
          </SectionCard>
        )}
        {action === 'close' && (
          <SectionCard title={k('sales.actions.close')}>
            <FormTextarea id="sales-close-reason" label={k('sales.fields.closeReason')} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
            <div className="flex justify-end gap-100">
              <Button onClick={() => setAction(undefined)} size="sm" theme="outlined" variant="secondary">
                {t('siampark-ops.common.cancel')}
              </Button>
              <Button
                disabled={reason.trim() === ''}
                isLoading={busy}
                onClick={() => void done({ _tag: 'SalesOrderTransition', note: reason.trim(), orderId: order.id, to: 'completed' }, 'sales.messages.closed')}
                size="sm"
                variant="primary"
              >
                {k('sales.actions.close')}
              </Button>
            </div>
          </SectionCard>
        )}
        {action === 'invoice' && canInvoice && (
          <SectionCard title={k('sales.actions.invoice')}>
            <p className="text-fg-secondary text-sm">{k('sales.form.invoiceIntro', { customer: order.customer.name })}</p>
            <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
              <FormInput id="sales-invoice-issue" label={k('sales.fields.issueDate')} onChange={(event) => setIssueDate(event.target.value)} type="date" value={issueDate} />
              <FormInput id="sales-invoice-due" label={k('sales.fields.dueDate')} onChange={(event) => setDueDate(event.target.value)} type="date" value={dueDate} />
            </div>
            <p className="font-semibold text-sm">{k('sales.withVat', { total: formatAmount(totals.totalMinor) })}</p>
            <div className="flex justify-end gap-100">
              <Button onClick={() => setAction(undefined)} size="sm" theme="outlined" variant="secondary">
                {t('siampark-ops.common.cancel')}
              </Button>
              <Button isLoading={busy} onClick={() => void invoice()} size="sm" variant="primary">
                {k('sales.actions.createInvoice')}
              </Button>
            </div>
          </SectionCard>
        )}
        <SectionCard title={k('sales.detail.info')}>
          <DetailList
            items={[
              { label: k('sales.fields.customer'), value: order.customer.name },
              {
                label: k('sales.columns.quote'),
                value:
                  order.quoteId === undefined ? (
                    '—'
                  ) : (
                    <button className="underline underline-offset-2" onClick={() => order.quoteId !== undefined && onOpenQuote(order.quoteId)} type="button">
                      {order.quoteNumber ?? order.quoteId}
                    </button>
                  ),
              },
              ...(order.note === undefined ? [] : [{ label: k('sales.fields.note'), value: order.note }]),
              { label: k('sales.detail.lastChange'), value: formatStamp(order.updatedAt) },
            ]}
          />
        </SectionCard>
        <SectionCard title={k('sales.fields.lines')}>
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
                  {entry.totalMinor !== undefined && <span className="tabular-nums">{formatAmount(entry.totalMinor)}</span>}
                  <span className="text-fg-secondary text-xs">{formatStamp(entry.linkedAt)}</span>
                  <a className="font-medium underline underline-offset-2" href={`/${lang}/siampark/finance?resourceId=${encodeURIComponent(entry.invoiceId)}`}>
                    {k('sales.openInvoice')}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title={k('sales.detail.history')}>
          <ol className="flex flex-col gap-100 border-border-primary border-l pl-200 text-sm">
            {order.history.toReversed().map((entry, index) => (
              <li className="flex flex-col" key={`${dateTimeIso(entry.at)}-${index}`}>
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
        </SectionCard>
        <SectionCard>
          <ChangeHistory entityId={order.id} refreshKey={dateTimeIso(order.updatedAt)} />
        </SectionCard>
      </div>
    </SidePanel>
  );
};
