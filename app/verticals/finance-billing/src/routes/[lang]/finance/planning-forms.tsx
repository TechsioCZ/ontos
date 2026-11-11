// The budget line and opening balance forms of the planning tab. Each is mounted only while open and saves only on
// the shared Uložit.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useState } from 'react';
import {
  BUDGET_INVALID,
  OPENING_INVALID,
  budgetAmounts,
  buildBudgetLineCommand,
  editBudgetDraft,
  openingCommandOf,
  openingDraftOf,
} from './budget-draft.ts';
import type { BudgetDraft, OpeningDraft } from './budget-draft.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { monthLabel } from './finance-ui.tsx';
import { BUDGET_CATEGORIES } from './incoming-invoice-draft.ts';
import { ObjectFields } from './object-fields.tsx';

const InvalidNotice = ({ shown, text }: { readonly shown: boolean; readonly text: string }) =>
  shown ? (
    <StatusText showIcon size="sm" status="warning">
      {text}
    </StatusText>
  ) : null;

/** A new budget line, or an edit of `initial.id`; an edit is saved only over the version it opened with. */
export const BudgetEditor = ({
  budgetMonth,
  initial,
  onClose,
  vm,
}: {
  readonly budgetMonth: string;
  readonly initial: BudgetDraft;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState(initial);
  const { id } = initial;
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => budgetAmounts(value) !== undefined,
    onClose,
    reset: setDraft,
    send: (value) => {
      const amounts = budgetAmounts(value);
      return amounts === undefined
        ? undefined
        : vm.execute(buildBudgetLineCommand({ ...amounts, budgetMonth, draft: value, vm }), 'Rozpočet uložen');
    },
    server:
      id === undefined
        ? undefined
        : () => {
            const current = vm.snapshot?.state.budgets?.find((budget) => budget.id === id);
            return current === undefined ? undefined : editBudgetDraft(current);
          },
    value: draft,
    vm,
  });
  return (
    <FinanceFormDialog
      description={`Rozpočet pro ${monthLabel(budgetMonth)}`}
      form={form}
      title={id === undefined ? 'Nová rozpočtová položka' : 'Upravit rozpočet'}
    >
      <div className="flex flex-col gap-150">
        <InvalidNotice shown={form.record.status === 'invalid'} text={BUDGET_INVALID} />
        <div className="grid grid-cols-2 gap-150">
          <SelectTemplate
            items={[
              { displayValue: 'Výdaj', label: 'Výdaj', value: 'COST' },
              { displayValue: 'Příjem', label: 'Příjem', value: 'REVENUE' },
            ]}
            label={t('finance-billing.financeUi.common.type')}
            labelProps={{ className: 'font-label text-label-md' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next === 'COST' || next === 'REVENUE') {
                setDraft((current) => ({ ...current, kind: next }));
              }
            }}
            size="sm"
            value={[draft.kind]}
          />
          <SelectTemplate
            items={BUDGET_CATEGORIES.map((category) => ({ displayValue: category, label: category, value: category }))}
            label={t('finance-billing.financeUi.common.category')}
            labelProps={{ className: 'font-label text-label-md' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next !== undefined) {
                setDraft((current) => ({ ...current, category: next }));
              }
            }}
            size="sm"
            value={[draft.category]}
          />
        </div>
        <ObjectFields
          idPrefix="budget-object"
          objects={vm.objects}
          onChange={(next) => setDraft((current) => ({ ...current, object: next }))}
          value={draft.object}
        />
        <FormInput
          id="budget-planned"
          inputMode="decimal"
          label={t('finance-billing.financeUi.planning.plannedAmount')}
          onChange={(event) => setDraft((current) => ({ ...current, planned: event.target.value }))}
          size="sm"
          value={draft.planned}
        />
        <FormInput
          helpText="Prázdné = skutečnost se spočítá z potvrzených faktur kategorie."
          id="budget-actual"
          inputMode="decimal"
          label={t('finance-billing.financeUi.planning.manualActual')}
          onChange={(event) => setDraft((current) => ({ ...current, actual: event.target.value }))}
          size="sm"
          value={draft.actual}
        />
        <FormInput
          id="budget-explanation"
          label={t('finance-billing.financeUi.planning.explanation')}
          onChange={(event) => setDraft((current) => ({ ...current, explanation: event.target.value }))}
          size="sm"
          value={draft.explanation}
        />
      </div>
    </FinanceFormDialog>
  );
};

/** The manually confirmed opening balance; saved only over the version the dialog opened with. */
export const OpeningBalanceEditor = ({
  month,
  onClose,
  vm,
}: {
  /** The month an unset opening balance starts in. */
  readonly month: string;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const server = () => openingDraftOf(vm.snapshot?.state.cashFlowOpening, month);
  const initial = server();
  const [draft, setDraft] = useState<OpeningDraft>(initial);
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => openingCommandOf(value, vm.actorLabel) !== undefined,
    onClose,
    reset: setDraft,
    send: (value) => {
      const command = openingCommandOf(value, vm.actorLabel);
      return command === undefined ? undefined : vm.execute(command, 'Počáteční stav potvrzen');
    },
    server,
    value: draft,
    vm,
  });
  return (
    <FinanceFormDialog
      description="Zadejte stav prostředků ke dni, od kterého se počítá odhad. Uloží se s vaším jménem jako ručně potvrzený."
      form={form}
      size="sm"
      title={t('finance-billing.financeUi.planning.openingTitle')}
    >
      <div className="flex flex-col gap-150">
        <InvalidNotice shown={form.record.status === 'invalid'} text={OPENING_INVALID} />
        <FormInput
          id="opening-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.planning.openingAmount')}
          onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))}
          size="sm"
          value={draft.amount}
        />
        <FormInput
          id="opening-date"
          label={t('finance-billing.financeUi.planning.asOf')}
          onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))}
          size="sm"
          type="date"
          value={draft.date}
        />
      </div>
    </FinanceFormDialog>
  );
};
