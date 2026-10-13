import {
  DetailList,
  formatDate,
  formatMoney,
  matchesSearch,
  SidePanel,
  comboboxTranslations,
  datePickerTranslations,
} from '@app/admin-ui';
import { CalendarDate as IntlCalendarDate } from '@internationalized/date';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect } from 'effect';
import { useRef, useState } from 'react';
import {
  addCalendarDays,
  draftTotals,
  isPlausibleIssueDate,
  lineIssue,
  lineValueIssue,
  newDraftLine,
  PAYMENT_TERM_DAYS,
  toInvoiceLine,
} from '../../../../../shared/domain/invoice-draft.ts';
import type { DraftLine, DraftLineIssue, PaymentTermDays } from '../../../../../shared/domain/invoice-draft.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { InvoiceLineEditor } from './invoice-line-editor.tsx';
import { formLabelProps } from './invoice-view.ts';
import type { CalendarDate, DraftInvoiceOutcome, useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

const ns = 'siampark-billing-finance.faktury';

/** Wraps the issue-date picker so a failed submit can find it and focus its first segment. */
const ISSUE_DATE_FIELD_ID = 'invoice-issue-date';
/** Focus target when the lines are valid one by one but their sum passes the money range. */
const ADD_LINE_BUTTON_ID = 'invoice-add-line';

/** The draft keeps the issue date as an ISO `YYYY-MM-DD` string; anything else shows an empty picker. */
const toIssueCalendarDate = (isoDate: string): IntlCalendarDate | null =>
  /^\d{4}-\d{2}-\d{2}$/u.test(isoDate)
    ? new IntlCalendarDate(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10)))
    : null;

interface Draft {
  readonly customerId: string;
  /** Today's date (real clock) when the form opens. */
  readonly issueDate: CalendarDate;
  readonly lines: readonly DraftLine[];
  readonly paymentDays: PaymentTermDays;
  /** Set when Escape or the close button hid this draft after it was edited; the reopened panel says so. */
  readonly resumed: boolean;
}

const CUSTOMER_COMBOBOX_ID = 'invoice-customer';

const emptyDraft = (): Draft => ({
  customerId: '',
  issueDate: DateTime.formatIsoDateUtc(DateTime.nowUnsafe()),
  lines: [newDraftLine('line-1', 'product')],
  paymentDays: 14,
  resumed: false,
});

/** True once the form holds input a fresh draft would not have, so closing it keeps something worth resuming. */
const isLineEdited = (line: DraftLine): boolean =>
  line.kind !== 'product' || line.productId !== null || line.description !== '' || line.quantity !== 1;

const isDraftEdited = (draft: Draft): boolean => {
  const fresh = emptyDraft();
  return (
    draft.customerId !== fresh.customerId ||
    draft.issueDate !== fresh.issueDate ||
    draft.paymentDays !== fresh.paymentDays ||
    draft.lines.length !== fresh.lines.length ||
    draft.lines.some(isLineEdited)
  );
};

/** An empty date is flagged after submit; a complete date with an implausible year is flagged as soon as it is typed. */
const issueDateProblem = (issueDate: string, submitted: boolean): 'missing' | 'year' | undefined => {
  if (issueDate === '') {
    return submitted ? 'missing' : undefined;
  }
  return isPlausibleIssueDate(issueDate) ? undefined : 'year';
};

/** A sum past the money range shows a dash and an error instead of 0 Kč. */
const optionalMoney = (minor: number | undefined) => (minor === undefined ? '—' : formatMoney(minor));

/** DOM id of the input that shows a line's problem, so a failed submit can move focus there. */
const lineIssueFieldId = (line: DraftLine, issue: DraftLineIssue): string => {
  if (issue === 'product') {
    return `invoice-line-product-${line.key}-input`;
  }
  if (issue === 'description') {
    return `invoice-line-description-${line.key}`;
  }
  // A product line has no price field, so its out-of-range amount is fixed through the quantity.
  const atQuantity = issue === 'quantity' || (issue === 'amount' && line.kind === 'product');
  return atQuantity ? `invoice-line-quantity-${line.key}` : `invoice-line-price-${line.key}`;
};

interface CreateInvoiceDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly vm: FinanceViewModel;
}

interface IssueDateFieldProps {
  readonly error: string | undefined;
  readonly label: string;
  /** ISO `YYYY-MM-DD`, or '' while the date is incomplete. */
  readonly onChange: (isoDate: string) => void;
  readonly value: string;
}

/** Czech date picker for the issue date, plus its inline error. The wrapper id lets a failed submit focus it. */
const IssueDateField = ({ error, label, onChange, value }: IssueDateFieldProps) => (
  <div className="flex flex-col gap-50" id={ISSUE_DATE_FIELD_ID}>
    <DatePicker.Root
      invalid={error !== undefined}
      locale="cs-CZ"
      name="issueDate"
      onValueChange={(details) => onChange(details.value === null ? '' : details.valueAsString)}
      required
      size="md"
      translations={datePickerTranslations}
      value={toIssueCalendarDate(value)}
    >
      <DatePicker.Label>{label}</DatePicker.Label>
      <DatePicker.Control>
        <DatePicker.Segments />
        <DatePicker.IndicatorGroup>
          <DatePicker.Trigger />
        </DatePicker.IndicatorGroup>
      </DatePicker.Control>
      <DatePicker.Positioner>
        <DatePicker.Content className="z-(--z-popup) bg-(--color-popup-bg)">
          <DatePicker.Calendar />
        </DatePicker.Content>
      </DatePicker.Positioner>
    </DatePicker.Root>
    {error !== undefined && (
      <StatusText showIcon size="sm" status="error">
        {error}
      </StatusText>
    )}
  </div>
);

/** Shown when the panel reopens with a draft that Escape or the close button kept; Začít znovu starts over. */
const ResumedDraftNotice = ({ onRestart }: { readonly onRestart: () => void }) => {
  const { t } = useModernI18n();
  return (
    <div className="flex items-center justify-between gap-150 rounded-md border border-border-primary p-150">
      <StatusText icon="icon-[mdi--history]" showIcon size="sm">
        {t(`${ns}.form.draftKept`)}
      </StatusText>
      <Button onClick={onRestart} size="sm" theme="outlined" variant="secondary">
        {t(`${ns}.form.draftRestart`)}
      </Button>
    </div>
  );
};

interface DraftTotalsSummaryProps {
  /** Undefined when the sum passes the money range. */
  readonly totals: ReturnType<typeof draftTotals>;
  readonly zeroPriceWarning: boolean;
}

/** Subtotal, VAT and total of the valid lines, with the out-of-range and 0 Kč messages under them. */
const DraftTotalsSummary = ({ totals, zeroPriceWarning }: DraftTotalsSummaryProps) => {
  const { t } = useModernI18n();
  return (
    <>
      <DetailList
        items={[
          {
            label: t(`${ns}.subtotal`),
            value: <span className="tabular-nums">{optionalMoney(totals?.subtotalMinor)}</span>,
          },
          {
            label: t(`${ns}.vatTotal`),
            value: <span className="tabular-nums">{optionalMoney(totals?.vatMinor)}</span>,
          },
          {
            label: t(`${ns}.total`),
            value: <span className="font-semibold tabular-nums">{optionalMoney(totals?.totalMinor)}</span>,
          },
        ]}
      />
      {totals === undefined && (
        <StatusText showIcon size="sm" status="error">
          {t(`${ns}.form.errorTotal`)}
        </StatusText>
      )}
      {zeroPriceWarning && (
        <StatusText showIcon size="sm" status="warning">
          {t(`${ns}.form.zeroPriceConfirm`)}
        </StatusText>
      )}
    </>
  );
};

export const CreateInvoiceDialog = ({ onOpenChange, open, vm }: CreateInvoiceDialogProps) => {
  const { confirmInvoice, createDraft, references, t } = vm;
  const toaster = useToast();
  const lineSequence = useRef(1);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  /** Set by the first submit that finds a 0 Kč line; the next submit creates the draft anyway. */
  const [zeroPriceAcknowledged, setZeroPriceAcknowledged] = useState(false);

  const { issueDate } = draft;
  const dueDate = issueDate === '' ? undefined : addCalendarDays(issueDate, draft.paymentDays);
  const customers = references.customers.filter((customer) => customer.status === 'ACTIVE');
  const customer = customers.find((item) => item.partyId === draft.customerId);
  const products = references.products.filter((product) => product.active);
  const totals = draftTotals(draft.lines);
  const hasZeroPriceLine = draft.lines.some((line) => line.unitPriceMinor === 0);
  const zeroPriceWarning = zeroPriceAcknowledged && hasZeroPriceLine;
  const customerError = submitted && customer === undefined ? t(`${ns}.form.errorCustomer`) : undefined;
  const issueProblem = issueDateProblem(issueDate, submitted);
  const issueDateError =
    issueProblem === undefined
      ? undefined
      : t(`${ns}.form.${issueProblem === 'missing' ? 'errorIssueDate' : 'errorIssueDateYear'}`);

  const customerLabel = (item: (typeof customers)[number]) => {
    const name = item.displayName ?? item.partyId;
    if (item.companyId === null) {
      return name;
    }
    const companyIdLabel = t(`${ns}.companyId`);
    return `${name} · ${companyIdLabel} ${item.companyId}`;
  };

  const customerItems = customers.flatMap((item) => {
    const label = customerLabel(item);
    return matchesSearch(label, customerQuery) ? [{ id: item.partyId, label, value: item.partyId }] : [];
  });

  // Any change to the lines asks again before a 0 Kč line is saved.
  const setLines = (next: (lines: readonly DraftLine[]) => readonly DraftLine[]) => {
    setZeroPriceAcknowledged(false);
    setDraft((current) => ({ ...current, lines: next(current.lines) }));
  };

  const updateLine = (lineKey: string, next: DraftLine) =>
    setLines((lines) => lines.map((line) => (line.key === lineKey ? next : line)));

  const addLine = () => {
    lineSequence.current += 1;
    const key = `line-${lineSequence.current}`;
    // A new line starts as a product line like the first one, so it has its own Produkt picker right away.
    setLines((lines) => [...lines, newDraftLine(key, 'product')]);
  };

  const removeLine = (lineKey: string) => {
    setLines((lines) => lines.filter((line) => line.key !== lineKey));
    // The removed line's buttons unmount with it, so focus moves to the add-line button that stays in the dialog.
    document.querySelector<HTMLElement>(`[id="${ADD_LINE_BUTTON_ID}"]`)?.focus();
  };

  /** Starts a fresh draft. Used by Začít znovu, Zrušit and after a successful create. */
  const resetDraft = () => {
    setDraft(emptyDraft());
    setSubmitted(false);
    setServerError(null);
    setZeroPriceAcknowledged(false);
  };

  /** Zrušit discards the draft; Escape and the close button keep it (see `handleOpenChange`). */
  const discardAndClose = () => {
    resetDraft();
    onOpenChange(false);
  };

  /** Escape and the close button hide the panel but keep an edited draft for the next open. */
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setDraft((current) => ({ ...current, resumed: isDraftEdited(current) }));
    }
    onOpenChange(next);
  };

  const handleOutcome = (outcome: DraftInvoiceOutcome) => {
    setBusy(false);
    if (!outcome.ok) {
      const message = t(`siampark-billing-finance.demo.feedback.${outcome.feedback}`);
      setServerError(message);
      toaster.create({ description: message, title: t(`${ns}.form.createFailed`), type: 'error' });
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
    discardAndClose();
  };

  /** The first field that blocks the submit, in form order, as a DOM id. */
  const firstInvalidFieldId = (): string | undefined => {
    if (customer === undefined) {
      return `${CUSTOMER_COMBOBOX_ID}-input`;
    }
    if (!isPlausibleIssueDate(issueDate)) {
      return ISSUE_DATE_FIELD_ID;
    }
    const line = draft.lines.find((item) => lineIssue(item) !== undefined);
    const issue = line === undefined ? undefined : lineIssue(line);
    if (line !== undefined && issue !== undefined) {
      return lineIssueFieldId(line, issue);
    }
    // Every line is valid on its own but together they pass the money range; the add-line button sits by the lines.
    return totals === undefined ? ADD_LINE_BUTTON_ID : undefined;
  };

  const submit = () => {
    setSubmitted(true);
    const invalidFieldId = firstInvalidFieldId();
    if (invalidFieldId !== undefined) {
      const field = document.querySelector<HTMLElement>(`[id="${invalidFieldId}"]`);
      // A date picker's root is not focusable, so focus its first date segment instead.
      (field?.querySelector<HTMLElement>('[role="spinbutton"]') ?? field)?.focus();
      return;
    }
    if (customer === undefined || dueDate === undefined) {
      return;
    }
    // A 0 Kč line can be a gift, so it is not an error, but it is never saved without a second, deliberate click.
    if (hasZeroPriceLine && !zeroPriceAcknowledged) {
      setZeroPriceAcknowledged(true);
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
    <SidePanel
      actions={
        <>
          <Button onClick={discardAndClose} theme="outlined" variant="secondary">
            {t(`${ns}.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${ns}.form.submitting`)} onClick={submit} variant="primary">
            {t(`${ns}.form.${zeroPriceWarning ? 'submitAnyway' : 'submit'}`)}
          </Button>
        </>
      }
      // The form holds unsaved input, and the date field opens a picker outside the drawer. A stray pointer or
      // focus move outside must not discard the draft. Escape and the close button only hide the panel, so the
      // draft is still there when it reopens, with a notice and Začít znovu; Zrušit discards it.
      closeOnInteractOutside={false}
      onOpenChange={handleOpenChange}
      open={open}
      // xl leaves the line's Typ select room for "Volná položka" at the form's text size.
      size="xl"
      title={t(`${ns}.newInvoice`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {draft.resumed && <ResumedDraftNotice onRestart={resetDraft} />}
        {serverError !== null && (
          <StatusText showIcon size="sm" status="error">
            {serverError}
          </StatusText>
        )}
        <div className="flex flex-col gap-50">
          <Combobox
            filterBehavior="external"
            id={CUSTOMER_COMBOBOX_ID}
            items={customerItems}
            label={t(`${ns}.form.customer`)}
            noResultsMessage={t(`${ns}.form.customerNoMatch`)}
            onChange={(values) => setDraft((current) => ({ ...current, customerId: values[0] ?? '' }))}
            onInputValueChange={setCustomerQuery}
            onOpenChange={() => setCustomerQuery('')}
            openOnClick
            placeholder={t(`${ns}.form.customerPlaceholder`)}
            required
            translations={comboboxTranslations}
            validateStatus={customerError === undefined ? 'default' : 'error'}
            value={draft.customerId === '' ? [] : [draft.customerId]}
          />
          {customerError !== undefined && (
            <StatusText showIcon size="sm" status="error">
              {customerError}
            </StatusText>
          )}
        </div>
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <IssueDateField
            error={issueDateError}
            label={t(`${ns}.form.issueDate`)}
            onChange={(next) => setDraft((current) => ({ ...current, issueDate: next }))}
            value={issueDate}
          />
          <SelectTemplate
            items={PAYMENT_TERM_DAYS.map((days) => {
              const label = t(`${ns}.form.term${days}`);
              return { displayValue: label, label, value: String(days) };
            })}
            label={t(`${ns}.form.paymentTerm`)}
            labelProps={formLabelProps}
            name="paymentDays"
            onValueChange={({ value }) => {
              const next = PAYMENT_TERM_DAYS.find((days) => String(days) === value[0]);
              if (next !== undefined) {
                setDraft((current) => ({ ...current, paymentDays: next }));
              }
            }}
            placeholder={t('siampark-billing-finance.selectPlaceholder')}
            value={[String(draft.paymentDays)]}
          />
        </div>
        {/* A due date counted from an incomplete or implausible issue date is meaningless, so the line says why. */}
        <p className="text-fg-secondary text-xs">
          {dueDate !== undefined && issueProblem === undefined
            ? t(`${ns}.form.dueHint`, { date: formatDate(dueDate) })
            : t(`${ns}.form.dueHintPending`)}
        </p>

        <div className="flex flex-col gap-150">
          <span className="font-medium text-sm">{t(`${ns}.form.lines`)}</span>
          {draft.lines.map((line, index) => (
            <InvoiceLineEditor
              canRemove={draft.lines.length > 1}
              // A mistyped number is flagged as soon as it is typed; a missing product or description only on submit.
              issue={submitted ? lineIssue(line) : lineValueIssue(line)}
              key={line.key}
              line={line}
              onChange={(next) => updateLine(line.key, next)}
              onRemove={() => removeLine(line.key)}
              position={index + 1}
              products={products}
            />
          ))}
          <div>
            <Button
              icon="icon-[mdi--plus]"
              id={ADD_LINE_BUTTON_ID}
              onClick={addLine}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t(`${ns}.form.addLine`)}
            </Button>
          </div>
          <p className="text-fg-secondary text-xs">{t(`${ns}.form.priceNote`)}</p>
        </div>

        <DraftTotalsSummary totals={totals} zeroPriceWarning={zeroPriceWarning} />
      </form>
    </SidePanel>
  );
};
