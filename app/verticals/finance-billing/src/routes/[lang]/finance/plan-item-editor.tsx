// A new financial plan item, or an edit of one; mounted only while open and saved only on the shared Uložit.
import { FormBuilder, FormReact, FormRoot, SelectTemplateField, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Schema } from 'effect';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { ObjectSelectionField, ObjectSelectionSchema } from './object-fields.tsx';
import { editPlanItemDraft, planItemCommandOf, planItemProblem } from './plan-item-draft.ts';
import type { PlanDraft } from './plan-item-draft.ts';

/** What the plan item form edits; the item's id and its stored links stay as the draft opened with them. */
const planItemForm = FormReact.make(
  FormBuilder.empty
    .addField('amount', Schema.String)
    .addField('expectedDate', Schema.String)
    .addField('kind', Schema.String)
    .addField('note', Schema.String)
    .addField('object', ObjectSelectionSchema)
    .addField('probability', Schema.String)
    .addField('projectName', Schema.String)
    .addField('title', Schema.String),
  {
    fields: {
      amount: TextField,
      expectedDate: TextField,
      kind: SelectTemplateField,
      note: TextField,
      object: ObjectSelectionField,
      probability: TextField,
      projectName: TextField,
      title: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

const editableOf = (draft: PlanDraft): typeof planItemForm.schema.Encoded => ({
  amount: draft.amount,
  expectedDate: draft.expectedDate,
  kind: draft.kind,
  note: draft.note,
  object: draft.object,
  probability: draft.probability,
  projectName: draft.projectName,
  title: draft.title,
});

/** An edit is saved only over the version of the item it opened with. */
export const PlanItemEditor = ({
  initial,
  onClose,
  vm,
}: {
  readonly initial: PlanDraft;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const values = useFormDraft(planItemForm, editableOf(initial));
  const draft: PlanDraft = {
    ...initial,
    ...values.draft,
    kind: values.draft.kind === 'COST' ? 'COST' : 'REVENUE',
  };
  const { id } = initial;
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => planItemCommandOf(value, vm) !== undefined,
    onClose,
    reset: (value) => values.reset(editableOf(value)),
    send: (value) => {
      const command = planItemCommandOf(value, vm);
      return command === undefined
        ? undefined
        : vm.execute(
            command,
            id === undefined ? 'Položka finančního plánu přidána' : 'Položka finančního plánu uložena',
          );
    },
    server:
      id === undefined
        ? undefined
        : () => {
            const current = vm.snapshot?.state.planItems?.find((item) => item.id === id);
            return current === undefined ? undefined : editPlanItemDraft(current);
          },
    value: draft,
    vm,
  });
  const problem = form.record.status === 'invalid' ? planItemProblem(draft) : undefined;
  return (
    <FinanceFormDialog
      description="Očekávaný příjem nebo výdaj. Měna CZK."
      form={form}
      title={id === undefined ? 'Nová položka finančního plánu' : 'Upravit položku plánu'}
    >
      <FormRoot
        className="flex flex-col gap-150"
        defaultValues={editableOf(initial)}
        form={planItemForm}
        translateMessage={t}
      >
        {values.ready}
        {problem !== undefined && (
          <StatusText showIcon size="sm" status="warning">
            {problem}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <planItemForm.kind
            items={[
              { displayValue: 'Příjem', label: 'Příjem', value: 'REVENUE' },
              { displayValue: 'Výdaj', label: 'Výdaj', value: 'COST' },
            ]}
            label={t('finance-billing.financeUi.common.type')}
            labelProps={{ className: 'font-label text-label-md' }}
            size="sm"
          />
          <planItemForm.title
            id="plan-title"
            label={t('finance-billing.financeUi.common.name')}
            placeholder={t('finance-billing.financeUi.plan.titleExample')}
            size="sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-3">
          <planItemForm.amount
            id="plan-amount"
            inputMode="decimal"
            label={t('finance-billing.financeUi.common.amount')}
            size="sm"
          />
          <planItemForm.expectedDate
            id="plan-date"
            label={t('finance-billing.financeUi.plan.expectedDate')}
            size="sm"
            type="date"
          />
          <planItemForm.probability
            helpText="Nepovinné, 1–100"
            id="plan-probability"
            inputMode="numeric"
            label={t('finance-billing.financeUi.plan.probability')}
            size="sm"
          />
        </div>
        <planItemForm.object idPrefix="plan-object" objects={vm.objects} showContract showCostCenter={false} />
        <planItemForm.projectName
          id="plan-project"
          label={t('finance-billing.financeUi.plan.project')}
          placeholder={t('finance-billing.financeUi.plan.projectExample')}
          size="sm"
        />
        <planItemForm.note id="plan-note" label={t('finance-billing.financeUi.common.note')} size="sm" />
      </FormRoot>
    </FinanceFormDialog>
  );
};
