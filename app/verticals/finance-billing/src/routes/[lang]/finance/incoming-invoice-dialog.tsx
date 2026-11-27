import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime, Effect, Schema } from 'effect';
import { DetailList, formatMoney, requiredLabelFor, SidePanel, UnsavedChangesDialog } from '@app/admin-ui';
import { FormBuilder, FormReact, FormRoot, SelectField, TextField, useAtomSet } from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useRef } from 'react';
import { draftTotals, lineIssue, lineValueIssue, newDraftLine } from '../../../../shared/domain/invoice-draft.ts';
import { defaultLineVatChoice } from '../../../../shared/domain/line-vat.ts';
import { financeBrowserAtomRuntime, financeBrowserRuntime } from '../../../runtime/browser.ts';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import {
  BUDGET_CATEGORIES,
  emptyIncomingDraft,
  IncomingFileSchema,
  incomingCommandOf,
  incomingProblem,
} from './incoming-invoice-draft.ts';
import { IncomingFileField } from './incoming-invoice-file.tsx';
import { DraftLineSchema, InvoiceLinesField } from './invoice-line-editor.tsx';
import { useVatChoices } from './use-vat-choices.ts';
import { ObjectSelectionField, ObjectSelectionSchema } from './object-fields.tsx';
import type { CommandOutcome } from './use-finance-records.ts';

interface IncomingInvoiceDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly vm: FinanceViewModel;
}

const optionalMoney = (minor: number | undefined) => (minor === undefined ? '—' : formatMoney(minor));

/** A received invoice as typed, with its lines, object and the picked document. Uložit records it through the save bar. */
const incomingForm = FormReact.make(
  FormBuilder.empty
    .addField('category', Schema.String)
    .addField('documentNumber', Schema.String)
    .addField('dueDate', Schema.String)
    .addField('file', Schema.OptionFromNullOr(IncomingFileSchema))
    .addField('issueDate', Schema.String)
    .addField('lines', Schema.Array(DraftLineSchema))
    .addField('note', Schema.String)
    .addField('object', ObjectSelectionSchema)
    .addField('supplierCompanyId', Schema.String)
    .addField('supplierName', Schema.String),
  {
    fields: {
      category: SelectField,
      documentNumber: TextField,
      dueDate: TextField,
      file: IncomingFileField,
      issueDate: TextField,
      lines: InvoiceLinesField,
      note: TextField,
      object: ObjectSelectionField,
      supplierCompanyId: TextField,
      supplierName: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

type IncomingValues = typeof incomingForm.schema.Encoded;

const incomingLines = incomingForm.getFieldAtoms(incomingForm.fields.lines);

/**
 * S07.R6: a received invoice is entered by hand and its PDF/scan is stored with it. Typing and picking a file change
 * only the draft; the shared Uložit records the invoice once and opens its detail.
 */
const IncomingInvoiceForm = ({ onOpenChange, vm }: Omit<IncomingInvoiceDialogProps, 'open'>) => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const initial: IncomingValues = emptyIncomingDraft(
    vm.referenceDate === ''
      ? financeBrowserRuntime.runSync(
          DateTime.now.pipe(Effect.map((value) => DateTime.formatLocal(value, { locale: 'en-CA' }))),
        )
      : vm.referenceDate,
  );
  const values = useFormDraft(incomingForm, initial);
  const { draft } = values;
  const setLineValues = useAtomSet(incomingLines.setValue);
  const lineSequence = useRef(1);
  const vat = useVatChoices(vm.scope, draft.issueDate);
  const choices = vat.state === 'ready' ? vat.choices : undefined;
  const totals = draftTotals(draft.lines, choices, 'INCOMING');
  const priceList = (vm.snapshot?.state.priceList ?? []).filter((item) => item.active);
  const addLine = () => {
    lineSequence.current += 1;
    const key = `incoming-line-${lineSequence.current}`;
    setLineValues([...draft.lines, newDraftLine(key, 'free', defaultLineVatChoice('INCOMING', choices?.regime))]);
  };
  const form = useFinanceFormSave<IncomingValues, CommandOutcome>({
    initial,
    isValid: (value) => incomingCommandOf(value, vm, choices) !== undefined,
    onClose: () => onOpenChange(false),
    onSent: (outcome) => {
      if (outcome.ok && outcome.invoice !== undefined) {
        vm.openDetail(outcome.invoice.ref.resourceId);
      }
    },
    reset: values.reset,
    send: (value) => {
      const command = incomingCommandOf(value, vm, choices);
      return command === undefined ? undefined : vm.execute(command, 'Přijatá faktura zaevidována');
    },
    value: draft,
    vm,
  });
  const showIssues = form.record.status === 'invalid';
  const problem = showIssues ? incomingProblem(draft, choices) : undefined;
  return (
    <>
      <SidePanel
        actions={<FinanceSaveActions form={form} />}
        description="Ruční evidence došlé faktury. Přiložený doklad se uloží a lze jej kdykoli stáhnout nebo zobrazit."
        guard={form.guard}
        onOpenChange={onOpenChange}
        open
        resizeLabel={vm.t('finance-billing.sidePanel.resize')}
        size="lg"
        title={t('finance-billing.financeUi.incoming.title')}
      >
        <FormRoot
          className="flex flex-col gap-200 py-200"
          defaultValues={initial}
          form={incomingForm}
          translateMessage={t}
        >
          {values.ready}
          {problem !== undefined && (
            <StatusText showIcon size="sm" status="warning">
              {problem}
            </StatusText>
          )}
          <div className="grid grid-cols-1 gap-200 md:grid-cols-[2fr_1fr]">
            <incomingForm.supplierName
              id="incoming-supplier"
              label={t('finance-billing.financeUi.incoming.supplier')}
              placeholder={t('finance-billing.financeUi.incoming.supplierExample')}
              required
              requiredLabel={requiredLabel}
              size="sm"
            />
            <incomingForm.supplierCompanyId
              id="incoming-ico"
              label={t('finance-billing.faktury.companyId')}
              placeholder={t('finance-billing.financeUi.common.optional')}
              size="sm"
            />
          </div>
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            <incomingForm.documentNumber
              id="incoming-number"
              label={t('finance-billing.financeUi.incoming.number')}
              placeholder={t('finance-billing.financeUi.incoming.numberExample')}
              required
              requiredLabel={requiredLabel}
              size="sm"
            />
          </div>
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            <incomingForm.issueDate
              id="incoming-issued"
              label={t('finance-billing.faktury.form.issueDate')}
              required
              requiredLabel={requiredLabel}
              size="sm"
              type="date"
            />
            <incomingForm.dueDate
              id="incoming-due"
              label={t('finance-billing.faktury.columns.due')}
              required
              requiredLabel={requiredLabel}
              size="sm"
              type="date"
            />
          </div>
          <div className="flex flex-col gap-150">
            <span className="font-medium text-sm">Položky dokladu (ceny bez DPH)</span>
            <incomingForm.lines
              direction="INCOMING"
              issueOf={(line) => (showIssues ? lineIssue(line, choices, 'INCOMING') : lineValueIssue(line))}
              priceList={priceList}
              products={[]}
              productsReadable={false}
              vat={vat}
            />
            <div>
              <Button appearance="outline" icon="icon-[mdi--plus]" onClick={addLine} severity="secondary" size="sm">
                Přidat položku
              </Button>
            </div>
            <DetailList
              items={[
                {
                  label: 'Základ',
                  value: <span className="tabular-nums">{optionalMoney(totals?.subtotalMinor)}</span>,
                },
                { label: 'DPH', value: <span className="tabular-nums">{optionalMoney(totals?.vatMinor)}</span> },
                {
                  label: 'Celkem s DPH',
                  value: <span className="font-semibold tabular-nums">{optionalMoney(totals?.totalMinor)}</span>,
                },
              ]}
            />
          </div>
          <incomingForm.object idPrefix="incoming-object" objects={vm.objects} />
          <incomingForm.category
            items={BUDGET_CATEGORIES.map((category) => ({ displayValue: category, label: category, value: category }))}
            label={t('finance-billing.financeUi.incoming.budgetCategory')}
            labelProps={{ className: 'font-label text-label-md' }}
            size="sm"
          />
          <incomingForm.note
            id="incoming-note"
            label={t('finance-billing.financeUi.common.note')}
            placeholder={t('finance-billing.financeUi.common.optional')}
            size="sm"
          />
          <incomingForm.file />
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/** Mounted only while open, so every open starts from an empty form. */
export const IncomingInvoiceDialog = ({ onOpenChange, open, vm }: IncomingInvoiceDialogProps) =>
  open ? <IncomingInvoiceForm onOpenChange={onOpenChange} vm={vm} /> : null;
