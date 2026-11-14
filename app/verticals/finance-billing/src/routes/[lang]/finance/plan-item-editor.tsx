// A new financial plan item, or an edit of one; mounted only while open and saved only on the shared Uložit.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useState } from 'react';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { ObjectFields } from './object-fields.tsx';
import { editPlanItemDraft, planItemCommandOf, planItemProblem } from './plan-item-draft.ts';
import type { PlanDraft } from './plan-item-draft.ts';

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
  const [draft, setDraft] = useState(initial);
  const update = (patch: Partial<PlanDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const { id } = initial;
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => planItemCommandOf(value, vm) !== undefined,
    onClose,
    reset: setDraft,
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
      <div className="flex flex-col gap-150">
        {problem !== undefined && (
          <StatusText showIcon size="sm" status="warning">
            {problem}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <SelectTemplate
            items={[
              { displayValue: 'Příjem', label: 'Příjem', value: 'REVENUE' },
              { displayValue: 'Výdaj', label: 'Výdaj', value: 'COST' },
            ]}
            label={t('finance-billing.financeUi.common.type')}
            labelProps={{ className: 'font-label text-label-md' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next === 'COST' || next === 'REVENUE') {
                update({ kind: next });
              }
            }}
            size="sm"
            value={[draft.kind]}
          />
          <FormInput
            id="plan-title"
            label={t('finance-billing.financeUi.common.name')}
            onChange={(event) => update({ title: event.target.value })}
            placeholder={t('finance-billing.financeUi.plan.titleExample')}
            size="sm"
            value={draft.title}
          />
        </div>
        <div className="grid grid-cols-1 gap-150 sm:grid-cols-3">
          <FormInput
            id="plan-amount"
            inputMode="decimal"
            label={t('finance-billing.financeUi.common.amount')}
            onChange={(event) => update({ amount: event.target.value })}
            size="sm"
            value={draft.amount}
          />
          <FormInput
            id="plan-date"
            label={t('finance-billing.financeUi.plan.expectedDate')}
            onChange={(event) => update({ expectedDate: event.target.value })}
            size="sm"
            type="date"
            value={draft.expectedDate}
          />
          <FormInput
            helpText="Nepovinné, 1–100"
            id="plan-probability"
            inputMode="numeric"
            label={t('finance-billing.financeUi.plan.probability')}
            onChange={(event) => update({ probability: event.target.value })}
            size="sm"
            value={draft.probability}
          />
        </div>
        <ObjectFields
          idPrefix="plan-object"
          objects={vm.objects}
          onChange={(next) => update({ object: next })}
          showContract
          showCostCenter={false}
          value={draft.object}
        />
        <FormInput
          id="plan-project"
          label={t('finance-billing.financeUi.plan.project')}
          onChange={(event) => update({ projectName: event.target.value })}
          placeholder={t('finance-billing.financeUi.plan.projectExample')}
          size="sm"
          value={draft.projectName}
        />
        <FormInput
          id="plan-note"
          label={t('finance-billing.financeUi.common.note')}
          onChange={(event) => update({ note: event.target.value })}
          size="sm"
          value={draft.note}
        />
      </div>
    </FinanceFormDialog>
  );
};
