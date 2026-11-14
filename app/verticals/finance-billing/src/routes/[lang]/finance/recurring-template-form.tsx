// A new recurring invoice template; mounted only while open and saved only on the shared Uložit.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { formatMoney, SidePanel, UnsavedChangesDialog } from '@app/admin-ui';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { VatChoices } from '../../../../shared/apis/vat-choices.ts';
import { lineVatProblem } from '../../../../shared/domain/invoice-draft.ts';
import { defaultLineVatChoice, forSellerRegime, lineVatOf } from '../../../../shared/domain/line-vat.ts';
import type { LineVatChoice } from '../../../../shared/domain/line-vat.ts';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import { parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { useVatChoices } from './use-vat-choices.ts';
import { VatChoiceSelect } from './vat-choice-select.tsx';

interface TemplateDraft {
  readonly amount: string;
  readonly customerId: string;
  readonly description: string;
  readonly dueDays: string;
  readonly issueDay: string;
  readonly name: string;
  /** The rent line's VAT; each generated invoice takes Tax's rate at its own issue date. */
  readonly vat: LineVatChoice;
}

/** What the form opens with; the suggested line text and terms are not typed input. */
const emptyTemplate = (regime?: VatChoices['regime']): TemplateDraft => ({
  amount: '',
  customerId: '',
  description: 'Nájemné za prostor',
  dueDays: '14',
  issueDay: '1',
  name: '',
  vat: defaultLineVatChoice('OUTGOING', regime),
});

type Customers = FinanceViewModel['references']['customers'];

/** Why the draft cannot be saved yet, or undefined when it can. */
const templateProblem = (
  draft: TemplateDraft,
  customers: Customers,
  choices: VatChoices | undefined,
): string | undefined => {
  const amountMinor = parseAmountMinor(draft.amount);
  const issueDay = Number(draft.issueDay);
  const dueDays = Number(draft.dueDays);
  const known = customers.some((entry) => entry.partyId === draft.customerId);
  if (!known || draft.name.trim() === '' || draft.description.trim() === '') {
    return 'Vyberte nájemce a vyplňte název a popis položky.';
  }
  if (amountMinor === undefined || amountMinor === 0) {
    return 'Zadejte měsíční částku bez DPH.';
  }
  if (lineVatProblem(draft, choices, 'OUTGOING')) {
    return 'Vyberte DPH, kterou modul Daně pro firmu vede.';
  }
  const daysValid = Number.isInteger(issueDay) && issueDay >= 1 && issueDay <= 28;
  return daysValid && Number.isInteger(dueDays) && dueDays >= 1 && dueDays <= 90
    ? undefined
    : 'Den vystavení musí být 1–28 a splatnost 1–90 dní.';
};

/** CreateRecurringTemplate for a draft `templateProblem` accepts. */
const templateCommandOf = (
  draft: TemplateDraft,
  customers: Customers,
  choices: VatChoices | undefined,
): FinanceCommandDraft<'CreateRecurringTemplate'> | undefined => {
  const customer = customers.find((entry) => entry.partyId === draft.customerId);
  const amountMinor = parseAmountMinor(draft.amount);
  const vat = lineVatOf(draft.vat, choices);
  if (
    customer === undefined ||
    amountMinor === undefined ||
    vat === undefined ||
    templateProblem(draft, customers, choices) !== undefined
  ) {
    return undefined;
  }
  const command: FinanceCommandDraft<'CreateRecurringTemplate'> = {
    _tag: 'CreateRecurringTemplate',
    counterpartyRef: customer.counterpartyRef,
    dueDays: Number(draft.dueDays),
    issueDay: Number(draft.issueDay),
    lines: [{ ...vat, description: draft.description.trim(), quantity: 1, unitPriceMinor: amountMinor }],
    name: draft.name.trim(),
    partyId: customer.partyId,
  };
  if (customer.displayName !== null) {
    command.counterpartyName = customer.displayName;
  }
  return command;
};

export const RecurringTemplateEditor = ({
  onClose,
  vm,
}: {
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const { customers } = vm.references;
  const today = vm.referenceDate === '' ? DateTime.formatIsoDateUtc(DateTime.nowUnsafe()) : vm.referenceDate;
  const vatState = useVatChoices(vm.scope, today);
  const choices = vatState.state === 'ready' ? vatState.choices : undefined;
  const [typed, setTyped] = useState(() => emptyTemplate());
  const set = (patch: Partial<TemplateDraft>) => setTyped((current) => ({ ...current, ...patch }));
  // A company that is not a VAT payer bills rent without VAT; the line reads as the non-payer treatment.
  const draft = forSellerRegime(typed, choices?.regime);
  const form = useFinanceFormSave({
    initial: emptyTemplate(choices?.regime),
    isValid: (value) => templateProblem(value, customers, choices) === undefined,
    onClose,
    reset: setTyped,
    send: (value) => {
      const command = templateCommandOf(value, customers, choices);
      return command === undefined ? undefined : vm.execute(command, 'Šablona opakované faktury uložena');
    },
    value: draft,
    vm,
  });
  const problem = form.record.status === 'invalid' ? templateProblem(draft, customers, choices) : undefined;
  const amountMinor = parseAmountMinor(draft.amount);
  const vatRate = lineVatOf(draft.vat, choices)?.vatRate;
  return (
    <>
      <SidePanel
        actions={<FinanceSaveActions form={form} />}
        description="Pravidelná měsíční faktura, např. nájemné za jednotku."
        guard={form.guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={vm.t('finance-billing.sidePanel.resize')}
        size="lg"
        title={t('finance-billing.financeUi.recurring.newTemplate')}
      >
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          {problem !== undefined && (
            <StatusText showIcon size="sm" status="warning">
              {problem}
            </StatusText>
          )}
          {customers.length === 0 && (
            <StatusText showIcon size="sm" status="warning">
              V adresáři zatím není žádný zákazník (nájemce). Založte jej nejprve v sekci Zákazníci.
            </StatusText>
          )}
          <SelectTemplate
            items={customers.map((customer) => ({
              displayValue: customer.displayName ?? t('finance-billing.faktury.unknownCustomer'),
              label: customer.displayName ?? t('finance-billing.faktury.unknownCustomer'),
              value: customer.partyId,
            }))}
            label={t('finance-billing.financeUi.recurring.tenant')}
            labelProps={{ className: 'font-label text-label-md' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next !== undefined) {
                set({ customerId: next });
              }
            }}
            placeholder={t('finance-billing.financeUi.recurring.tenantPlaceholder')}
            size="sm"
            value={draft.customerId === '' ? [] : [draft.customerId]}
          />
          <FormInput
            id="template-name"
            label={t('finance-billing.financeUi.recurring.templateName')}
            onChange={(event) => set({ name: event.target.value })}
            placeholder={t('finance-billing.financeUi.recurring.templateExample')}
            size="sm"
            value={draft.name}
          />
          <FormInput
            id="template-line"
            label={t('finance-billing.financeUi.recurring.lineText')}
            onChange={(event) => set({ description: event.target.value })}
            size="sm"
            value={draft.description}
          />
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            <FormInput
              helpText={
                amountMinor === undefined || vatRate === undefined
                  ? 'Částka bez DPH'
                  : `s DPH ${formatMoney(Math.round(amountMinor * (1 + vatRate / 100)))}`
              }
              id="template-amount"
              inputMode="decimal"
              label={t('finance-billing.financeUi.recurring.monthlyAmount')}
              onChange={(event) => set({ amount: event.target.value })}
              size="sm"
              value={draft.amount}
            />
            <VatChoiceSelect
              choice={draft.vat}
              direction="OUTGOING"
              invalid={choices !== undefined && lineVatProblem(draft, choices, 'OUTGOING')}
              name="template-vat"
              onChange={(vat) => set({ vat })}
              vat={vatState}
            />
          </div>
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            <FormInput
              id="template-issue-day"
              inputMode="numeric"
              label={t('finance-billing.financeUi.recurring.issueDay')}
              onChange={(event) => set({ issueDay: event.target.value })}
              size="sm"
              value={draft.issueDay}
            />
            <FormInput
              id="template-due-days"
              inputMode="numeric"
              label={t('finance-billing.financeUi.recurring.dueDays')}
              onChange={(event) => set({ dueDays: event.target.value })}
              size="sm"
              value={draft.dueDays}
            />
          </div>
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </>
  );
};
