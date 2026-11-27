// Inline "record visit" and "plan contact" forms of the client card's Návštěvy tab. Typing changes only the draft;
// the shared Save button ("Uložit", last in the footer) sends one RecordVisit / PlanContact command, and leaving with
// unsaved input asks Uložit / Zahodit změny / Zůstat.
import { requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import { CheckboxField, FormReact, FormRoot, useAtomValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Schema } from 'effect';
import type { ReactNode } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import type { CrmFormSave } from '../../../../crm/form-save.tsx';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { planCommandOf, planControls, planFields } from '../k-osloveni/plan-panels.tsx';
import type { PlanDraft } from '../k-osloveni/plan-panels.tsx';
import {
  VisitFields,
  emptyVisitDraft,
  recordVisitCommandOf,
  useMessageTranslator,
  useMessagesWhileInvalid,
  visitControls,
  visitFields,
  visitKindLabel,
} from './visit-panels.tsx';
import type { RecordVisitDraft } from './visit-panels.tsx';
import { czechError, formatDay, localDay, relativeDay, shiftDay } from './visits-model.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

interface InlineFormProps {
  readonly clientId: string;
  /** Leaves the form; after a save and after Zrušit (through the unsaved-changes guard). */
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}

/** The card's inline form: its fields (in the form's `FormRoot`), then Zrušit and Uložit. */
const InlineForm = <V,>({
  children,
  form,
  onClose,
  testId,
}: {
  readonly children: ReactNode;
  readonly form: CrmFormSave<V>;
  readonly onClose: () => void;
  readonly testId: string;
}) => (
  <div className={`${surfaceTileClassName} flex flex-col gap-200 p-250`} data-testid={testId}>
    {children}
    <div className="flex flex-wrap items-center justify-end gap-100">
      <CrmFormSaveActions form={form} onCancel={onClose} />
    </div>
  </div>
);

/** Recording a visit on the card; its own form, so the card and the side panel never share a draft. */
const clientVisitForm = FormReact.make(visitFields.addField('addToPlan', Schema.Boolean), {
  fields: { ...visitControls, addToPlan: CheckboxField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

/** Records a visit, call, video call or e-mail of the client. Enter never sends the record: only Uložit does. */
export const ClientVisitForm = ({ clientId, onClose, records, submit }: InlineFormProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const translate = useMessageTranslator();
  const opened: RecordVisitDraft = { ...emptyVisitDraft(records, clientId), addToPlan: true };
  const draft = Option.getOrElse(useAtomValue(clientVisitForm.values), () => opened);
  const form = useCrmFormSave<RecordVisitDraft>({
    command: (value) => recordVisitCommandOf(value, clientId, records.viewer.writeAll),
    failureText: (message) => czechError(message, t('crm.ciClientsVisits.visits.recordFailed')),
    onSaved: (value) => {
      toaster.create({ title: `${visitKindLabel(value.kind)} zapsán(a)`, type: 'success' });
      onClose();
    },
    submit,
    value: draft,
  });
  useMessagesWhileInvalid(clientVisitForm, form.record.status === 'invalid');
  return (
    <InlineForm form={form} onClose={onClose} testId="crm-card-visit-form">
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={clientVisitForm}
        translateMessage={translate}
      >
        <span className="font-semibold text-sm">{t('crm.ciClientsVisits.visits.recordVisit')}</span>
        <VisitFields
          form={clientVisitForm}
          idPrefix="crm-card-visit"
          records={records}
          showClient={false}
          showSalesperson={records.viewer.writeAll}
        />
        {draft.nextStepDate !== '' && (
          <clientVisitForm.addToPlan
            id="crm-card-visit-plan"
            label={t('crm.ciClientsVisits.visits.addNextStepToPlan')}
          />
        )}
      </FormRoot>
    </InlineForm>
  );
};

/** Planning a contact on the card; its own form, so the card and the side panel never share a draft. */
const clientPlanForm = FormReact.make(planFields, {
  fields: planControls,
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

/**
 * Plans a contact with the client; it opens complete (in a week), so Uložit can plan it at once. Enter never sends
 * the plan: only Uložit does.
 */
export const ClientPlanForm = ({ clientId, onClose, records, submit }: InlineFormProps) => {
  const { language, t } = useModernI18n();
  const toaster = useToast();
  const translate = useMessageTranslator();
  const today = localDay(records.now);
  const opened: PlanDraft = { client: clientId, dueDate: shiftDay(today, 7), note: '', salespersonId: '' };
  const draft = Option.getOrElse(useAtomValue(clientPlanForm.values), () => opened);
  const form = useCrmFormSave<PlanDraft>({
    command: (value) => planCommandOf(value, undefined, records.viewer.writeAll),
    failureText: (message) => czechError(message, t('crm.ciClientsVisits.visits.planFailed')),
    fromEmpty: { empty: { ...opened, dueDate: '' }, opened },
    onSaved: (value) => {
      toaster.create({
        description: formatDay(value.dueDate),
        title: t('crm.ciClientsVisits.visits.contactPlanned'),
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
  return (
    <InlineForm form={form} onClose={onClose} testId="crm-card-plan-form">
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={clientPlanForm}
        translateMessage={translate}
      >
        <span className="font-semibold text-sm">{t('crm.ciClientsVisits.visits.planContact')}</span>
        <clientPlanForm.dueDate
          helpText={`${formatDay(draft.dueDate)} · ${relativeDay(draft.dueDate, today)}`}
          id="crm-card-plan-date"
          label={t('crm.ciClientsVisits.visits.contactOnDate')}
          min={today}
          name="dueDate"
          required
          requiredLabel={requiredLabelFor(language)}
          size="sm"
          type="date"
        />
        <clientPlanForm.note
          id="crm-card-plan-note"
          label={t('crm.ciClientsVisits.fields.note')}
          name="note"
          rows={2}
          size="sm"
        />
        {records.viewer.writeAll && (
          <clientPlanForm.salespersonId
            items={[
              { label: t('crm.ciClientsVisits.visits.clientSalesperson'), value: '' },
              ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
            ]}
            label={t('crm.ciClientsVisits.visits.responsibleSalesperson')}
            placeholder={t('crm.ciClientsVisits.visits.clientSalesperson')}
          />
        )}
        <span className="text-fg-secondary text-xs">{t('crm.ciClientsVisits.visits.manualPlanHint')}</span>
      </FormRoot>
    </InlineForm>
  );
};
