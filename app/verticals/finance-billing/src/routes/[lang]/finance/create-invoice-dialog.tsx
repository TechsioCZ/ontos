import { comboboxTranslations, formatDate, matchesSearch, SidePanel, UnsavedChangesDialog } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { DateTime } from 'effect';
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
  toInvoiceLine,
} from '../../../../shared/domain/invoice-draft.ts';
import type { DraftLine, DraftLineKind, PaymentTermDays } from '../../../../shared/domain/invoice-draft.ts';
import { DOCUMENT_KINDS, DraftTotalsSummary, IssueDateField, issueDateProblem } from './create-invoice-fields.tsx';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import { useCreatedInvoiceToast } from './create-invoice-toast.tsx';
import { InvoiceLineEditor } from './invoice-line-editor.tsx';
import { formLabelProps } from './invoice-view.ts';
import { emptyObjectSelection, objectAnchors, ObjectFields } from './object-fields.tsx';
import type { ObjectSelection } from './object-fields.tsx';
import type { CalendarDate, DraftInvoiceOutcome, useFinanceRecords } from './use-finance-records.ts';

type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

const ns = 'finance-billing.faktury';

/** Focus target after a line is removed. */
const ADD_LINE_BUTTON_ID = 'invoice-add-line';
const CUSTOMER_COMBOBOX_ID = 'invoice-customer';

interface Draft {
  readonly customerId: string;
  readonly documentKind: InvoiceDocumentKind;
  /** Today's date (real clock) when the form opens. */
  readonly issueDate: CalendarDate;
  readonly lines: readonly DraftLine[];
  readonly object: ObjectSelection;
  readonly paymentDays: PaymentTermDays;
}

const emptyDraft = (lineKind: DraftLineKind): Draft => ({
  customerId: '',
  documentKind: 'STANDARD',
  issueDate: DateTime.formatIsoDateUtc(DateTime.nowUnsafe()),
  lines: [newDraftLine('line-1', lineKind)],
  object: emptyObjectSelection,
  paymentDays: 14,
});

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
  const { t } = useModernI18n();
  const { createDraft, references } = vm;
  const priceList = (vm.snapshot?.state.priceList ?? []).filter((item) => item.active);
  const defaultLineKind = references.productsReadable === false ? 'free' : 'product';
  const created = useCreatedInvoiceToast(vm);
  const lineSequence = useRef(1);
  const initial = emptyDraft(defaultLineKind);
  const [draft, setDraft] = useState<Draft>(initial);
  const [customerQuery, setCustomerQuery] = useState('');
  const customers = references.customers.filter((customer) => customer.status === 'ACTIVE');
  const customerOf = (value: Draft) => customers.find((item) => item.partyId === value.customerId);
  const inputOf = (value: Draft) => {
    const customer = customerOf(value);
    const dueDate = value.issueDate === '' ? undefined : addCalendarDays(value.issueDate, value.paymentDays);
    const valid =
      customer !== undefined &&
      dueDate !== undefined &&
      isPlausibleIssueDate(value.issueDate) &&
      value.lines.every((line) => lineIssue(line) === undefined) &&
      draftTotals(value.lines) !== undefined;
    return valid
      ? {
          anchors: objectAnchors(vm.objects, { ...value.object, contractId: '' }),
          customer,
          documentKind: value.documentKind,
          dueDate,
          issueDate: value.issueDate,
          lines: value.lines.map(toInvoiceLine),
        }
      : undefined;
  };
  const form = useFinanceFormSave<Draft, DraftInvoiceOutcome>({
    initial,
    isValid: (value) => inputOf(value) !== undefined,
    onClose: () => onOpenChange(false),
    onSent: (outcome) => {
      if (outcome.ok) {
        created(outcome.invoice);
      }
    },
    reset: setDraft,
    send: (value) => {
      const input = inputOf(value);
      return input === undefined ? undefined : createDraft(input);
    },
    value: draft,
    vm,
  });
  const showIssues = form.record.status === 'invalid';
  const { issueDate } = draft;
  const dueDate = issueDate === '' ? undefined : addCalendarDays(issueDate, draft.paymentDays);
  const totals = draftTotals(draft.lines);
  // A 0 Kč line can be a gift, so it is not an error; the form says so before Uložit creates the draft.
  const zeroPriceWarning = inputOf(draft) !== undefined && draft.lines.some((line) => line.unitPriceMinor === 0);
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
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setLines = (next: (lines: readonly DraftLine[]) => readonly DraftLine[]) =>
    setDraft((current) => ({ ...current, lines: next(current.lines) }));
  const addLine = () => {
    lineSequence.current += 1;
    const key = `line-${lineSequence.current}`;
    setLines((lines) => [...lines, newDraftLine(key, defaultLineKind)]);
  };
  const updateLine = (lineKey: string, next: DraftLine) =>
    setLines((lines) => lines.map((item) => (item.key === lineKey ? next : item)));
  const removeLine = (lineKey: string) => {
    setLines((lines) => lines.filter((line) => line.key !== lineKey));
    // The removed line's buttons unmount with it, so focus moves to the add-line button that stays in the panel.
    document.querySelector<HTMLElement>(`[id="${ADD_LINE_BUTTON_ID}"]`)?.focus();
  };
  return (
    <>
      <SidePanel
        actions={<FinanceSaveActions form={form} />}
        guard={form.guard}
        onOpenChange={onOpenChange}
        open
        resizeLabel={t('finance-billing.sidePanel.resize')}
        // xl leaves the line's Typ select room for "Volná položka" at the form's text size.
        size="xl"
        title={t(`${ns}.newInvoice`)}
      >
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          <div className="flex flex-col gap-50">
            <Combobox
              filterBehavior="external"
              id={CUSTOMER_COMBOBOX_ID}
              items={customerItems}
              label={t(`${ns}.form.customer`)}
              noResultsMessage={t(`${ns}.form.customerNoMatch`)}
              onChange={(values) => update({ customerId: values[0] ?? '' })}
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
          <SelectTemplate
            items={DOCUMENT_KINDS.map(([value, label]) => ({ displayValue: label, label, value }))}
            label={t('finance-billing.financeUi.common.documentKind')}
            labelProps={formLabelProps}
            name="documentKind"
            onValueChange={({ value }) => {
              const next = DOCUMENT_KINDS.find(([kind]) => kind === value[0])?.[0];
              if (next !== undefined) {
                update({ documentKind: next });
              }
            }}
            value={[draft.documentKind]}
          />
          {(draft.documentKind === 'FINAL' || draft.documentKind === 'PARTIAL') && (
            <p className="text-fg-secondary text-xs">
              Po uložení návrhu v detailu dokladu vyberete dřívější zálohové nebo dílčí faktury a ručně potvrdíte
              částky, které se zohlední. Daňové vyúčtování OntOS automaticky neprovádí.
            </p>
          )}
          <ObjectFields
            idPrefix="invoice-object"
            objects={vm.objects}
            onChange={(next) => update({ object: next })}
            value={draft.object}
          />
          <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <IssueDateField
              error={issueDateError}
              label={t(`${ns}.form.issueDate`)}
              onChange={(next) => update({ issueDate: next })}
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
                  update({ paymentDays: next });
                }
              }}
              placeholder={t('finance-billing.selectPlaceholder')}
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
                // A mistyped number is flagged as soon as it is typed; a missing product or description once the
                // draft is held back.
                issue={showIssues ? lineIssue(line) : lineValueIssue(line)}
                key={line.key}
                line={line}
                onChange={(next) => updateLine(line.key, next)}
                onRemove={() => removeLine(line.key)}
                position={index + 1}
                priceList={priceList}
                products={references.products.filter((product) => product.active)}
                productsReadable={references.productsReadable !== false}
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
            <p className="text-fg-secondary text-xs">
              {t(`${ns}.form.${references.productsReadable === false ? 'rentalLineHint' : 'priceNote'}`)}
            </p>
          </div>
          <DraftTotalsSummary totals={totals} zeroPriceWarning={zeroPriceWarning} />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/** Mounted only while open, so every open starts from an empty draft. */
export const CreateInvoiceDialog = ({ onOpenChange, open, vm }: CreateInvoiceDialogProps) =>
  open ? <CreateInvoiceForm onOpenChange={onOpenChange} vm={vm} /> : null;
