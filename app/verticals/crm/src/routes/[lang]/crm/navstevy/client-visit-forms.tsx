// Inline "record visit" and "plan contact" forms of the client card's Návštěvy tab. Typing changes only the draft;
// the shared Save button ("Uložit", last in the footer) sends one RecordVisit / PlanContact command, and leaving with
// unsaved input asks Uložit / Zahodit změny / Zůstat.
import { surfaceTileClassName } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import type { CrmFormSave } from '../../../../crm/form-save.tsx';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { planCommandOf } from '../k-osloveni/plan-panels.tsx';
import type { PlanDraft } from '../k-osloveni/plan-panels.tsx';
import { VisitFields, emptyVisitDraft, recordVisitCommandOf } from './visit-panels.tsx';
import type { VisitDraft } from './visit-panels.tsx';
import { czechError, formatDay, localDay, relativeDay, shiftDay, visitKindMeta } from './visits-model.ts';

interface InlineFormProps {
  readonly clientId: string;
  /** Leaves the form; after a save and after Zrušit (through the unsaved-changes guard). */
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}

const InlineForm = <V,>({
  children,
  form,
  onClose,
  testId,
  title,
}: {
  readonly children: ReactNode;
  readonly form: CrmFormSave<V>;
  readonly onClose: () => void;
  readonly testId: string;
  readonly title: string;
}) => (
  <div className={`${surfaceTileClassName} flex flex-col gap-200 p-250`} data-testid={testId}>
    {/* Enter never sends the record: only Uložit does. */}
    <form className="flex flex-col gap-200" onSubmit={(event) => event.preventDefault()}>
      <span className="font-semibold text-sm">{title}</span>
      {children}
    </form>
    <div className="flex flex-wrap items-center justify-end gap-100">
      <CrmFormSaveActions form={form} onCancel={onClose} />
    </div>
  </div>
);

/** Records a visit, call, video call or e-mail of the client. */
export const ClientVisitForm = ({ clientId, onClose, records, submit }: InlineFormProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [draft, setDraft] = useState<VisitDraft>(() => emptyVisitDraft(records, clientId));
  const patch = (next: Partial<VisitDraft>) => setDraft((current) => ({ ...current, ...next }));
  const form = useCrmFormSave<VisitDraft>({
    command: (value) => recordVisitCommandOf(value, clientId, records.viewer.writeAll),
    failureText: (message) => czechError(message, t('crm.ciClientsVisits.visits.recordFailed')),
    onSaved: (value) => {
      toaster.create({ title: `${visitKindMeta[value.kind].label} zapsán(a)`, type: 'success' });
      onClose();
    },
    submit,
    value: draft,
  });
  return (
    <InlineForm
      form={form}
      onClose={onClose}
      testId="crm-card-visit-form"
      title={t('crm.ciClientsVisits.visits.recordVisit')}
    >
      <VisitFields
        draft={draft}
        idPrefix="crm-card-visit"
        onChange={patch}
        records={records}
        showClient={false}
        showSalesperson={records.viewer.writeAll}
        submitted={form.record.status === 'invalid'}
      />
      {draft.nextStepDate !== '' && (
        <FormCheckbox
          checked={draft.addToPlan}
          id="crm-card-visit-plan"
          label={t('crm.ciClientsVisits.visits.addNextStepToPlan')}
          onCheckedChange={(checked) => patch({ addToPlan: checked })}
          size="sm"
        />
      )}
    </InlineForm>
  );
};

/** Plans a contact with the client; it opens complete (in a week), so Uložit can plan it at once. */
export const ClientPlanForm = ({ clientId, onClose, records, submit }: InlineFormProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const today = localDay(records.now);
  const opened: PlanDraft = { client: clientId, dueDate: shiftDay(today, 7), note: '', salespersonId: '' };
  const [draft, setDraft] = useState<PlanDraft>(opened);
  const patch = (next: Partial<PlanDraft>) => setDraft((current) => ({ ...current, ...next }));
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
    <InlineForm
      form={form}
      onClose={onClose}
      testId="crm-card-plan-form"
      title={t('crm.ciClientsVisits.visits.planContact')}
    >
      <FormInput
        helpText={`${formatDay(draft.dueDate)} · ${relativeDay(draft.dueDate, today)}`}
        id="crm-card-plan-date"
        label={t('crm.ciClientsVisits.visits.contactOnDate')}
        min={today}
        name="dueDate"
        onChange={(event) => patch({ dueDate: event.target.value })}
        required
        size="sm"
        type="date"
        value={draft.dueDate}
      />
      <FormTextarea
        id="crm-card-plan-note"
        label={t('crm.ciClientsVisits.fields.note')}
        name="note"
        onChange={(event) => patch({ note: event.target.value })}
        rows={2}
        size="sm"
        value={draft.note}
      />
      {records.viewer.writeAll && (
        <SelectTemplate
          items={[
            { label: t('crm.ciClientsVisits.visits.clientSalesperson'), value: '' },
            ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
          ]}
          label={t('crm.ciClientsVisits.visits.responsibleSalesperson')}
          name="planSalesperson"
          onValueChange={(details) => patch({ salespersonId: details.value[0] ?? '' })}
          size="sm"
          value={[draft.salespersonId]}
        />
      )}
      <span className="text-fg-secondary text-xs">{t('crm.ciClientsVisits.visits.manualPlanHint')}</span>
    </InlineForm>
  );
};
