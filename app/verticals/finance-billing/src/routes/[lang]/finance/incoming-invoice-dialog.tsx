import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime, Effect } from 'effect';
import { DetailList, formatMoney, SidePanel, UnsavedChangesDialog } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@app/admin-ui/form-controls';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useRef, useState } from 'react';
import { draftTotals, lineIssue, lineValueIssue, newDraftLine } from '../../../../shared/domain/invoice-draft.ts';
import type { DraftLine } from '../../../../shared/domain/invoice-draft.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { BUDGET_CATEGORIES, emptyIncomingDraft, incomingCommandOf, incomingProblem } from './incoming-invoice-draft.ts';
import type { IncomingDraft } from './incoming-invoice-draft.ts';
import { IncomingFileField } from './incoming-invoice-file.tsx';
import { InvoiceLineEditor } from './invoice-line-editor.tsx';
import { ObjectFields } from './object-fields.tsx';
import type { CommandOutcome } from './use-finance-records.ts';

interface IncomingInvoiceDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly vm: FinanceViewModel;
}

const optionalMoney = (minor: number | undefined) => (minor === undefined ? '—' : formatMoney(minor));

/**
 * S07.R6: a received invoice is entered by hand and its PDF/scan is stored with it. Typing and picking a file change
 * only the draft; the shared Uložit records the invoice once and opens its detail.
 */
const IncomingInvoiceForm = ({ onOpenChange, vm }: Omit<IncomingInvoiceDialogProps, 'open'>) => {
  const { t } = useModernI18n();
  const initial = emptyIncomingDraft(
    vm.referenceDate === ''
      ? financeBrowserRuntime.runSync(
          DateTime.now.pipe(Effect.map((value) => DateTime.formatLocal(value, { locale: 'en-CA' }))),
        )
      : vm.referenceDate,
  );
  const [draft, setDraft] = useState<IncomingDraft>(initial);
  const set = (patch: Partial<IncomingDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const lineSequence = useRef(1);
  const totals = draftTotals(draft.lines);
  const priceList = (vm.snapshot?.state.priceList ?? []).filter((item) => item.active);
  const setLines = (next: (lines: readonly DraftLine[]) => readonly DraftLine[]) =>
    setDraft((current) => ({ ...current, lines: next(current.lines) }));
  const updateLine = (key: string, next: DraftLine) =>
    setLines((lines) => lines.map((entry) => (entry.key === key ? next : entry)));
  const removeLine = (key: string) => setLines((lines) => lines.filter((entry) => entry.key !== key));
  const addLine = () => {
    lineSequence.current += 1;
    const key = `incoming-line-${lineSequence.current}`;
    setLines((lines) => [...lines, newDraftLine(key, 'free')]);
  };
  const form = useFinanceFormSave<IncomingDraft, CommandOutcome>({
    initial,
    isValid: (value) => incomingCommandOf(value, vm) !== undefined,
    onClose: () => onOpenChange(false),
    onSent: (outcome) => {
      if (outcome.ok && outcome.invoice !== undefined) {
        vm.openDetail(outcome.invoice.ref.resourceId);
      }
    },
    reset: setDraft,
    send: (value) => {
      const command = incomingCommandOf(value, vm);
      return command === undefined ? undefined : vm.execute(command, 'Přijatá faktura zaevidována');
    },
    value: draft,
    vm,
  });
  const showIssues = form.record.status === 'invalid';
  const problem = showIssues ? incomingProblem(draft) : undefined;
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
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          {problem !== undefined && (
            <StatusText showIcon size="sm" status="warning">
              {problem}
            </StatusText>
          )}
          <div className="grid grid-cols-1 gap-200 md:grid-cols-[2fr_1fr]">
            <FormInput
              id="incoming-supplier"
              label={t('finance-billing.financeUi.incoming.supplier')}
              onChange={(event) => set({ supplierName: event.target.value })}
              placeholder={t('finance-billing.financeUi.incoming.supplierExample')}
              required
              size="sm"
              value={draft.supplierName}
            />
            <FormInput
              id="incoming-ico"
              label={t('finance-billing.faktury.companyId')}
              onChange={(event) => set({ supplierCompanyId: event.target.value })}
              placeholder={t('finance-billing.financeUi.common.optional')}
              size="sm"
              value={draft.supplierCompanyId}
            />
          </div>
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            <FormInput
              id="incoming-number"
              label={t('finance-billing.financeUi.incoming.number')}
              onChange={(event) => set({ documentNumber: event.target.value })}
              placeholder={t('finance-billing.financeUi.incoming.numberExample')}
              required
              size="sm"
              value={draft.documentNumber}
            />
          </div>
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            <FormInput
              id="incoming-issued"
              label={t('finance-billing.faktury.form.issueDate')}
              onChange={(event) => set({ issueDate: event.target.value })}
              required
              size="sm"
              type="date"
              value={draft.issueDate}
            />
            <FormInput
              id="incoming-due"
              label={t('finance-billing.faktury.columns.due')}
              onChange={(event) => set({ dueDate: event.target.value })}
              required
              size="sm"
              type="date"
              value={draft.dueDate}
            />
          </div>
          <div className="flex flex-col gap-150">
            <span className="font-medium text-sm">Položky dokladu (ceny bez DPH)</span>
            {draft.lines.map((line, index) => (
              <InvoiceLineEditor
                canRemove={draft.lines.length > 1}
                issue={showIssues ? lineIssue(line) : lineValueIssue(line)}
                key={line.key}
                line={line}
                onChange={(next) => updateLine(line.key, next)}
                onRemove={() => removeLine(line.key)}
                position={index + 1}
                priceList={priceList}
                products={[]}
                productsReadable={false}
              />
            ))}
            <div>
              <Button icon="icon-[mdi--plus]" onClick={addLine} size="sm" theme="outlined" variant="secondary">
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
          <ObjectFields
            idPrefix="incoming-object"
            objects={vm.objects}
            onChange={(next) => set({ object: next })}
            value={draft.object}
          />
          <SelectTemplate
            items={BUDGET_CATEGORIES.map((category) => ({ displayValue: category, label: category, value: category }))}
            label={t('finance-billing.financeUi.incoming.budgetCategory')}
            labelProps={{ className: 'font-label text-label-md' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next !== undefined) {
                set({ category: next });
              }
            }}
            size="sm"
            value={[draft.category]}
          />
          <FormInput
            id="incoming-note"
            label={t('finance-billing.financeUi.common.note')}
            onChange={(event) => set({ note: event.target.value })}
            placeholder={t('finance-billing.financeUi.common.optional')}
            size="sm"
            value={draft.note}
          />
          <IncomingFileField file={draft.file} onChange={(file) => set({ file })} />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};

/** Mounted only while open, so every open starts from an empty form. */
export const IncomingInvoiceDialog = ({ onOpenChange, open, vm }: IncomingInvoiceDialogProps) =>
  open ? <IncomingInvoiceForm onOpenChange={onOpenChange} vm={vm} /> : null;
