// The budget line and opening balance forms of the planning tab. Each is mounted only while open and saves only on
// the shared Uložit.
import { FormBuilder, FormReact, FormRoot, SelectField, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Schema } from 'effect';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import {
  BUDGET_INVALID,
  OPENING_INVALID,
  budgetAmounts,
  buildBudgetLineCommand,
  editBudgetDraft,
  openingCommandOf,
  openingDraftOf,
} from './budget-draft.ts';
import type { BudgetDraft } from './budget-draft.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { monthLabel } from './finance-ui.tsx';
import { BUDGET_CATEGORIES } from './incoming-invoice-draft.ts';
import { ObjectSelectionField, ObjectSelectionSchema } from './object-fields.tsx';

/** What the budget line form edits; the line's id and its stored links stay as the draft opened with them. */
const budgetForm = FormReact.make(
  FormBuilder.empty
    .addField('actual', Schema.String)
    .addField('category', Schema.String)
    .addField('explanation', Schema.String)
    .addField('kind', Schema.String)
    .addField('object', ObjectSelectionSchema)
    .addField('planned', Schema.String),
  {
    fields: {
      actual: TextField,
      category: SelectField,
      explanation: TextField,
      kind: SelectField,
      object: ObjectSelectionField,
      planned: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

const budgetEditableOf = (draft: BudgetDraft): typeof budgetForm.schema.Encoded => ({
  actual: draft.actual,
  category: draft.category,
  explanation: draft.explanation,
  kind: draft.kind,
  object: draft.object,
  planned: draft.planned,
});

/** The opening balance as typed: the amount and the date as their input text. */
const openingForm = FormReact.make(
  FormBuilder.empty.addField('amount', Schema.String).addField('date', Schema.String),
  {
    fields: { amount: TextField, date: TextField },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

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
  const values = useFormDraft(budgetForm, budgetEditableOf(initial));
  const draft: BudgetDraft = {
    ...initial,
    ...values.draft,
    kind: values.draft.kind === 'REVENUE' ? 'REVENUE' : 'COST',
  };
  const { id } = initial;
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => budgetAmounts(value) !== undefined,
    onClose,
    reset: (value) => values.reset(budgetEditableOf(value)),
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
      <FormRoot
        className="flex flex-col gap-150"
        defaultValues={budgetEditableOf(initial)}
        form={budgetForm}
        translateMessage={t}
      >
        {values.ready}
        <InvalidNotice shown={form.record.status === 'invalid'} text={BUDGET_INVALID} />
        <div className="grid grid-cols-2 gap-150">
          <budgetForm.kind
            items={[
              { displayValue: 'Výdaj', label: 'Výdaj', value: 'COST' },
              { displayValue: 'Příjem', label: 'Příjem', value: 'REVENUE' },
            ]}
            label={t('finance-billing.financeUi.common.type')}
            labelProps={{ className: 'font-label text-label-md' }}
            size="sm"
          />
          <budgetForm.category
            items={BUDGET_CATEGORIES.map((category) => ({ displayValue: category, label: category, value: category }))}
            label={t('finance-billing.financeUi.common.category')}
            labelProps={{ className: 'font-label text-label-md' }}
            size="sm"
          />
        </div>
        <budgetForm.object idPrefix="budget-object" objects={vm.objects} />
        <budgetForm.planned
          id="budget-planned"
          inputMode="decimal"
          label={t('finance-billing.financeUi.planning.plannedAmount')}
          size="sm"
        />
        <budgetForm.actual
          helpText="Prázdné = skutečnost se spočítá z potvrzených faktur kategorie."
          id="budget-actual"
          inputMode="decimal"
          label={t('finance-billing.financeUi.planning.manualActual')}
          size="sm"
        />
        <budgetForm.explanation
          id="budget-explanation"
          label={t('finance-billing.financeUi.planning.explanation')}
          size="sm"
        />
      </FormRoot>
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
  const { draft, ready, reset } = useFormDraft(openingForm, initial);
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => openingCommandOf(value, vm.actorLabel) !== undefined,
    onClose,
    reset,
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
      <FormRoot className="flex flex-col gap-150" defaultValues={initial} form={openingForm} translateMessage={t}>
        {ready}
        <InvalidNotice shown={form.record.status === 'invalid'} text={OPENING_INVALID} />
        <openingForm.amount
          id="opening-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.planning.openingAmount')}
          size="sm"
        />
        <openingForm.date
          id="opening-date"
          label={t('finance-billing.financeUi.planning.asOf')}
          size="sm"
          type="date"
        />
      </FormRoot>
    </FinanceFormDialog>
  );
};
