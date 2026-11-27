import {
  comboboxTranslations,
  formatDate,
  matchesSearch,
  requiredLabelFor,
  SidePanel,
  UnsavedChangesDialog,
} from '@app/admin-ui';
import {
  ComboboxField,
  DateField,
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  useAtomSet,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Schema } from 'effect';
import { useRef, useState } from 'react';
import type { InvoiceDocumentKind } from '../../../../shared/apis/records.ts';
import {
  addCalendarDays,
  draftTotals,
  isPlausibleIssueDate,
  lineIssue,
  lineValueIssue,
  newDraftLine,
  PAYMENT_TERM_DAYS,
  storedLinesOf,
} from '../../../../shared/domain/invoice-draft.ts';
import type { DraftLineKind, PaymentTermDays } from '../../../../shared/domain/invoice-draft.ts';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import { DOCUMENT_KINDS, DraftTotalsSummary, issueDateProblem, useIssueDateProps } from './create-invoice-fields.tsx';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import { useCreateInvoiceFeedback, zeroPriceChecked } from './create-invoice-toast.tsx';
import { DraftLineSchema, InvoiceLinesField } from './invoice-line-editor.tsx';
import { choicesOf, useVatChoices } from './use-vat-choices.ts';
import { defaultLineVatChoice, forSellerRegime } from '../../../../shared/domain/line-vat.ts';
import type { VatChoices } from '../../../../shared/apis/vat-choices.ts';
import { formLabelProps } from './invoice-view.ts';
import { emptyObjectSelection, objectAnchors, ObjectSelectionField, ObjectSelectionSchema } from './object-fields.tsx';
import type { DraftInvoiceOutcome, useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

const ns = 'finance-billing.faktury';

/** Focus target after a line is removed. */
const ADD_LINE_BUTTON_ID = 'invoice-add-line';
const CUSTOMER_COMBOBOX_ID = 'invoice-customer';

/**
 * A new invoice draft as typed: the customer, the document kind, the issue date (today on the real clock when the
 * form opens), the payment term in days, the object and the lines. Uložit sends it through the save bar, so the form
 * only holds it.
 */
const createInvoiceForm = FormReact.make(
  FormBuilder.empty
    .addField('customerId', Schema.String)
    .addField('documentKind', Schema.String)
    .addField('issueDate', Schema.String)
    .addField('lines', Schema.Array(DraftLineSchema))
    .addField('object', ObjectSelectionSchema)
    .addField('paymentDays', Schema.String),
  {
    fields: {
      customerId: ComboboxField,
      documentKind: SelectTemplateField,
      issueDate: DateField,
      lines: InvoiceLinesField,
      object: ObjectSelectionField,
      paymentDays: SelectTemplateField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

type Draft = typeof createInvoiceForm.schema.Encoded;

const invoiceLines = createInvoiceForm.getFieldAtoms(createInvoiceForm.fields.lines);

/** The removed line's buttons unmount with it, so focus moves to the add-line button that stays in the panel. */
const focusAddLine = () => {
  document.querySelector<HTMLElement>(`[id="${ADD_LINE_BUTTON_ID}"]`)?.focus();
};

const emptyDraft = (lineKind: DraftLineKind, regime?: VatChoices['regime']): Draft => ({
  customerId: '',
  documentKind: 'STANDARD',
  issueDate: DateTime.formatIsoDateUtc(DateTime.nowUnsafe()),
  lines: [newDraftLine('line-1', lineKind, defaultLineVatChoice('OUTGOING', regime))],
  object: emptyObjectSelection,
  paymentDays: '14',
});

const documentKindOf = (draft: Draft): InvoiceDocumentKind =>
  DOCUMENT_KINDS.find(([kind]) => kind === draft.documentKind)?.[0] ?? 'STANDARD';
const paymentDaysOf = (draft: Draft): PaymentTermDays =>
  PAYMENT_TERM_DAYS.find((days) => String(days) === draft.paymentDays) ?? 14;

interface CreateInvoiceDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly vm: FinanceViewModel;
}

/**
 * A new outgoing invoice draft. Typing changes only the form's draft; the shared Uložit creates it once. Leaving with
 * unsaved input asks first; an untouched form closes at once.
 */
const CreateInvoiceForm = ({ onOpenChange, vm }: Omit<CreateInvoiceDialogProps, 'open'>) => {
  const { language, t } = useModernI18n();
  const { createDraft, references } = vm;
  const priceList = (vm.snapshot?.state.priceList ?? []).filter((item) => item.active);
  const defaultLineKind = references.productsReadable === false ? 'free' : 'product';
  const feedback = useCreateInvoiceFeedback(vm, () => onOpenChange(false));
  const lineSequence = useRef(1);
  // What the form opens with; FormRoot reads it on mount only.
  const opened = emptyDraft(defaultLineKind);
  const values = useFormDraft(createInvoiceForm, opened);
  const typed = values.draft;
  const setLineValues = useAtomSet(invoiceLines.setValue);
  /**
   * The lines the first Uložit that found a 0 Kč line saw; the next Uložit over the same lines creates the draft
   * anyway. Any change to the lines asks again before a 0 Kč line is saved.
   */
  const [acknowledgedLines, setAcknowledgedLines] = useState<Draft['lines']>();
  const zeroPriceAcknowledged = acknowledgedLines === typed.lines;
  const acknowledgeZeroPrice = () => setAcknowledgedLines(typed.lines);
  const vat = useVatChoices(vm.scope, typed.issueDate);
  const choices = choicesOf(vat);
  const regime = choices?.regime;
  // Once Tax says the company is not a VAT payer, every line on a classification reads as the non-payer treatment.
  const draft: Draft = { ...typed, lines: typed.lines.map((line) => forSellerRegime(line, regime)) };
  const initial = emptyDraft(defaultLineKind, regime);
  // The text typed into the customer search narrows the offered customers; it is not part of the draft.
  const [customerQuery, setCustomerQuery] = useState('');
  const customers = references.customers.filter((customer) => customer.status === 'ACTIVE');
  const customerOf = (value: Draft) => customers.find((item) => item.partyId === value.customerId);
  const inputOf = (value: Draft) => {
    const customer = customerOf(value);
    const dueDate = value.issueDate === '' ? undefined : addCalendarDays(value.issueDate, paymentDaysOf(value));
    const valid =
      customer !== undefined &&
      dueDate !== undefined &&
      isPlausibleIssueDate(value.issueDate) &&
      value.lines.every((line) => lineIssue(line, choices, 'OUTGOING') === undefined) &&
      draftTotals(value.lines, choices, 'OUTGOING') !== undefined;
    const lines = storedLinesOf(value.lines, choices);
    return valid && lines !== undefined
      ? {
          anchors: objectAnchors(vm.objects, { ...value.object, contractId: '' }),
          customer,
          documentKind: documentKindOf(value),
          dueDate,
          issueDate: value.issueDate,
          lines,
        }
      : undefined;
  };
  const form = useFinanceFormSave<Draft, DraftInvoiceOutcome>({
    initial,
    isValid: (value) => inputOf(value) !== undefined,
    onClose: () => onOpenChange(false),
    onFailed: feedback.failed,
    onSent: (outcome) => {
      if (outcome.ok) {
        feedback.created(outcome.invoice);
      }
    },
    reset: values.reset,
    send: (value) => {
      const input = inputOf(value);
      return input === undefined ? undefined : createDraft(input);
    },
    value: draft,
    vm,
  });
  const showIssues = form.record.status === 'invalid';
  const { issueDate } = draft;
  const dueDate = issueDate === '' ? undefined : addCalendarDays(issueDate, paymentDaysOf(draft));
  const totals = draftTotals(draft.lines, choices, 'OUTGOING');
  // A 0 Kč line can be a gift, so it is not an error, but it is never saved without a second, deliberate Uložit.
  const hasZeroPriceLine = inputOf(draft) !== undefined && draft.lines.some((line) => line.unitPriceMinor === 0);
  const { checked, zeroPriceWarning } = zeroPriceChecked(form, hasZeroPriceLine, [
    zeroPriceAcknowledged,
    acknowledgeZeroPrice,
  ]);
  const customerError = showIssues && customerOf(draft) === undefined ? t(`${ns}.form.errorCustomer`) : undefined;
  const issueProblem = issueDateProblem(issueDate, showIssues);
  const issueDateError =
    issueProblem === undefined
      ? undefined
      : t(`${ns}.form.${issueProblem === 'missing' ? 'errorIssueDate' : 'errorIssueDateYear'}`);
  const customerItems = customers.flatMap((item) => {
    const name = item.displayName ?? t('finance-billing.faktury.unknownCustomer');
    const companyIdLabel = t(`${ns}.companyId`);
    const label = item.companyId === null ? name : `${name} · ${companyIdLabel} ${item.companyId}`;
    return matchesSearch(label, customerQuery) ? [{ id: item.partyId, label, value: item.partyId }] : [];
  });
  const addLine = () => {
    lineSequence.current += 1;
    const key = `line-${lineSequence.current}`;
    setLineValues([...typed.lines, newDraftLine(key, defaultLineKind, defaultLineVatChoice('OUTGOING', regime))]);
  };
  const issueDateProps = useIssueDateProps({ error: issueDateError, label: t(`${ns}.form.issueDate`) });
  return (
    <>
      <SidePanel
        actions={<FinanceSaveActions form={checked} />}
        guard={checked.guard}
        onOpenChange={onOpenChange}
        open
        resizeLabel={t('finance-billing.sidePanel.resize')}
        // xl leaves the line's Typ select room for "Volná položka" at the form's text size.
        size="xl"
        title={t(`${ns}.newInvoice`)}
      >
        <FormRoot
          className="flex flex-col gap-200 py-200"
          defaultValues={opened}
          form={createInvoiceForm}
          translateMessage={t}
        >
          {values.ready}
          <div className="flex flex-col gap-50">
            <createInvoiceForm.customerId
              filterBehavior="external"
              id={CUSTOMER_COMBOBOX_ID}
              items={customerItems}
              label={t(`${ns}.form.customer`)}
              noResultsMessage={t(`${ns}.form.customerNoMatch`)}
              onInputValueChange={setCustomerQuery}
              onOpenChange={() => setCustomerQuery('')}
              openOnClick
              placeholder={t(`${ns}.form.customerPlaceholder`)}
              required
              requiredLabel={requiredLabelFor(language)}
              translations={comboboxTranslations}
              {...(customerError === undefined ? {} : { helpText: customerError, invalid: true })}
            />
          </div>
          <createInvoiceForm.documentKind
            items={DOCUMENT_KINDS.map(([value, label]) => ({ displayValue: label, label, value }))}
            label={t('finance-billing.financeUi.common.documentKind')}
            labelProps={formLabelProps}
            name="documentKind"
          />
          {(documentKindOf(draft) === 'FINAL' || documentKindOf(draft) === 'PARTIAL') && (
            <p className="text-fg-secondary text-xs">
              Po uložení návrhu v detailu dokladu vyberete dřívější zálohové nebo dílčí faktury a ručně potvrdíte
              částky, které se zohlední. Daňové vyúčtování OntOS automaticky neprovádí.
            </p>
          )}
          <createInvoiceForm.object idPrefix="invoice-object" objects={vm.objects} />
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <createInvoiceForm.issueDate {...issueDateProps} />
            <createInvoiceForm.paymentDays
              items={PAYMENT_TERM_DAYS.map((days) => {
                const label = t(`${ns}.form.term${days}`);
                return { displayValue: label, label, value: String(days) };
              })}
              label={t(`${ns}.form.paymentTerm`)}
              labelProps={formLabelProps}
              name="paymentDays"
              placeholder={t('finance-billing.selectPlaceholder')}
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
            <createInvoiceForm.lines
              direction="OUTGOING"
              // A mistyped number is flagged as soon as it is typed; a missing product or description once the
              // draft is held back.
              issueOf={(line) => (showIssues ? lineIssue(line, choices, 'OUTGOING') : lineValueIssue(line))}
              onRemoved={focusAddLine}
              priceList={priceList}
              products={references.products.filter((product) => product.active)}
              productsReadable={references.productsReadable !== false}
              shownLine={(line) => forSellerRegime(line, regime)}
              vat={vat}
            />
            <div>
              <Button
                appearance="outline"
                icon="icon-[mdi--plus]"
                id={ADD_LINE_BUTTON_ID}
                onClick={addLine}
                severity="secondary"
                size="sm"
              >
                {t(`${ns}.form.addLine`)}
              </Button>
            </div>
            <p className="text-fg-secondary text-xs">
              {t(`${ns}.form.${references.productsReadable === false ? 'rentalLineHint' : 'priceNote'}`)}
            </p>
            {references.productsFailed && (
              <StatusText showIcon size="sm" status="error">
                {t(`${ns}.referencesError`)}
              </StatusText>
            )}
          </div>
          <DraftTotalsSummary totals={totals} zeroPriceWarning={zeroPriceWarning} />
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={checked.labels} prompt={checked.guard.prompt} />
    </>
  );
};

/** Mounted only while open, so every open starts from an empty draft. */
export const CreateInvoiceDialog = ({ onOpenChange, open, vm }: CreateInvoiceDialogProps) =>
  open ? <CreateInvoiceForm onOpenChange={onOpenChange} vm={vm} /> : null;
