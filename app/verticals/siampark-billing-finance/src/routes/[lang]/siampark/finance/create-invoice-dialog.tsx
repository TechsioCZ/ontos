import { DetailList, formatDate, formatMoney } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect } from 'effect';
import { useRef, useState } from 'react';
import {
  addCalendarDays,
  draftTotals,
  lineIssue,
  newDraftLine,
  PAYMENT_TERM_DAYS,
  toInvoiceLine,
} from '../../../../../shared/domain/invoice-draft.ts';
import type { DraftLine, PaymentTermDays } from '../../../../../shared/domain/invoice-draft.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { InvoiceLineEditor } from './invoice-line-editor.tsx';
import type { CalendarDate, DraftInvoiceOutcome, useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

const ns = 'siampark-billing-finance.faktury';

interface Draft {
  readonly customerId: string;
  /** Today's date (real clock) when the form opens. */
  readonly issueDate: CalendarDate;
  readonly lines: readonly DraftLine[];
  readonly paymentDays: PaymentTermDays;
}

const emptyDraft = (): Draft => ({
  customerId: '',
  issueDate: DateTime.formatIsoDateUtc(DateTime.nowUnsafe()),
  lines: [newDraftLine('line-1', 'product')],
  paymentDays: 14,
});

interface CreateInvoiceDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly vm: FinanceViewModel;
}

export const CreateInvoiceDialog = ({ onOpenChange, open, vm }: CreateInvoiceDialogProps) => {
  const { confirmInvoice, createDraft, references, t } = vm;
  const toaster = useToast();
  const lineSequence = useRef(1);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<{ readonly message: string; readonly reason?: string } | null>(null);

  const { issueDate } = draft;
  const dueDate = issueDate === '' ? undefined : addCalendarDays(issueDate, draft.paymentDays);
  const customers = references.customers.filter((customer) => customer.status === 'ACTIVE');
  const customer = customers.find((item) => item.partyId === draft.customerId);
  const products = references.products.filter((product) => product.active);
  const totals = draftTotals(draft.lines);
  const customerError = submitted && customer === undefined ? t(`${ns}.form.errorCustomer`) : undefined;

  const customerLabel = (item: (typeof customers)[number]) => {
    const name = item.displayName ?? item.partyId;
    if (item.companyId === null) {
      return name;
    }
    const companyIdLabel = t(`${ns}.companyId`);
    return `${name} · ${companyIdLabel} ${item.companyId}`;
  };

  const updateLine = (lineKey: string, next: DraftLine) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === lineKey ? next : line)),
    }));

  const addLine = () => {
    lineSequence.current += 1;
    const key = `line-${lineSequence.current}`;
    setDraft((current) => ({ ...current, lines: [...current.lines, newDraftLine(key, 'free')] }));
  };

  const removeLine = (lineKey: string) =>
    setDraft((current) => ({ ...current, lines: current.lines.filter((line) => line.key !== lineKey) }));

  const close = () => {
    setDraft(emptyDraft());
    setSubmitted(false);
    setServerError(null);
    onOpenChange(false);
  };

  const handleOutcome = (outcome: DraftInvoiceOutcome) => {
    setBusy(false);
    if (!outcome.ok) {
      const message = t(`siampark-billing-finance.demo.feedback.${outcome.feedback}`);
      const reason = outcome.reason === null ? undefined : t(`${ns}.form.failureReason`, { reason: outcome.reason });
      setServerError(reason === undefined ? { message } : { message, reason });
      toaster.create({
        description: reason === undefined ? message : `${message} ${reason}`,
        title: t(`${ns}.form.createFailed`),
        type: 'error',
      });
      return;
    }
    const { invoice } = outcome;
    // The toast id is fixed up front so the action can dismiss exactly this toast before confirming.
    const toastId = `invoice-created-${invoice.ref.resourceId}`;
    toaster.create({
      description: (
        <div className="flex items-center justify-between gap-150">
          <span>{invoice.number ?? invoice.documentNumber}</span>
          <Button
            onClick={() => {
              toaster.dismiss(toastId);
              confirmInvoice(invoice);
            }}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${ns}.confirm`)}
          </Button>
        </div>
      ),
      id: toastId,
      title: t(`${ns}.form.created`),
      type: 'success',
    });
    close();
  };

  const submit = () => {
    setSubmitted(true);
    if (customer === undefined || dueDate === undefined || draft.lines.some((line) => lineIssue(line) !== undefined)) {
      return;
    }
    setBusy(true);
    setServerError(null);
    void financeBrowserRuntime.runPromise(
      createDraft({ customer, dueDate, issueDate, lines: draft.lines.map(toInvoiceLine) }).pipe(
        Effect.tap((outcome) => Effect.sync(() => handleOutcome(outcome))),
      ),
    );
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={close} theme="outlined" variant="secondary">
            {t(`${ns}.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${ns}.form.submitting`)} onClick={submit} variant="primary">
            {t(`${ns}.form.submit`)}
          </Button>
        </>
      }
      // The form holds unsaved input, and the date field opens a picker outside the drawer. A stray pointer or
      // focus move outside must not discard the draft; Escape, the close button and Zrušit still close.
      closeOnInteractOutside={false}
      customTrigger
      onOpenChange={({ open: next }) => {
        if (!next) {
          close();
        }
      }}
      open={open}
      placement="right"
      size="lg"
      title={t(`${ns}.newInvoice`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== null && (
          <div className="flex flex-col gap-50">
            <StatusText showIcon status="error">
              {serverError.message}
            </StatusText>
            {serverError.reason !== undefined && (
              <p className="break-words text-fg-secondary text-xs">{serverError.reason}</p>
            )}
          </div>
        )}
        <Combobox
          {...(customerError === undefined ? {} : { helpText: customerError })}
          items={customers.map((item) => ({ id: item.partyId, label: customerLabel(item), value: item.partyId }))}
          label={t(`${ns}.form.customer`)}
          noResultsMessage={t(`${ns}.form.customerNoMatch`)}
          onChange={(values) => setDraft((current) => ({ ...current, customerId: values[0] ?? '' }))}
          placeholder={t(`${ns}.form.customerPlaceholder`)}
          validateStatus={customerError === undefined ? 'default' : 'error'}
          value={draft.customerId === '' ? [] : [draft.customerId]}
        />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormInput
            id="invoice-issue-date"
            label={t(`${ns}.form.issueDate`)}
            name="issueDate"
            onChange={(event) => setDraft((current) => ({ ...current, issueDate: event.target.value }))}
            required
            type="date"
            value={issueDate}
          />
          <SelectTemplate
            items={PAYMENT_TERM_DAYS.map((days) => ({ label: t(`${ns}.form.term${days}`), value: String(days) }))}
            label={t(`${ns}.form.paymentTerm`)}
            name="paymentDays"
            onValueChange={({ value }) => {
              const next = PAYMENT_TERM_DAYS.find((days) => String(days) === value[0]);
              if (next !== undefined) {
                setDraft((current) => ({ ...current, paymentDays: next }));
              }
            }}
            value={[String(draft.paymentDays)]}
          />
        </div>
        {dueDate !== undefined && (
          <p className="text-fg-secondary text-xs">{t(`${ns}.form.dueHint`, { date: formatDate(dueDate) })}</p>
        )}

        <div className="flex flex-col gap-150">
          <span className="font-medium text-sm">{t(`${ns}.form.lines`)}</span>
          {draft.lines.map((line) => (
            <InvoiceLineEditor
              canRemove={draft.lines.length > 1}
              issue={submitted ? lineIssue(line) : undefined}
              key={line.key}
              line={line}
              onChange={(next) => updateLine(line.key, next)}
              onRemove={() => removeLine(line.key)}
              products={products}
            />
          ))}
          <div>
            <Button icon="icon-[mdi--plus]" onClick={addLine} size="sm" theme="outlined" variant="secondary">
              {t(`${ns}.form.addLine`)}
            </Button>
          </div>
          <p className="text-fg-secondary text-xs">{t(`${ns}.form.priceNote`)}</p>
        </div>

        <DetailList
          items={[
            {
              label: t(`${ns}.subtotal`),
              value: <span className="tabular-nums">{formatMoney(totals.subtotalMinor)}</span>,
            },
            {
              label: t(`${ns}.vatTotal`),
              value: <span className="tabular-nums">{formatMoney(totals.vatMinor)}</span>,
            },
            {
              label: t(`${ns}.total`),
              value: <span className="font-semibold tabular-nums">{formatMoney(totals.totalMinor)}</span>,
            },
          ]}
        />
      </form>
    </Dialog>
  );
};
