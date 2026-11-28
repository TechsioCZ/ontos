import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Option, Schema } from 'effect';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import { assignableSalespeople } from '../../../../crm/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// AREA: visits (C06) — owned by the crm-visits lane. Plan a contact / reschedule it / complete it (+ visit).
import { DetailList, SidePanel, comboboxTranslations, requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import {
  CheckboxField,
  ChoiceField,
  ComboboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { Field } from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { lastVisitOf } from '../../../../../shared/domain/visits.ts';
import type { PlanItem } from '../../../../../shared/domain/visits.ts';

import {
  ClientPickSchema,
  VisitFields,
  emptyVisitDraft,
  useMessageTranslator,
  useMessagesWhileInvalid,
  visitControls,
  visitFields,
  visitKindLabel,
  visitKindOf,
} from '../navstevy/visit-panels.tsx';
import type { Submit, VisitDraft } from '../navstevy/visit-panels.tsx';

import {
  clientLabel,
  czechError,
  formatDay,
  formatVisitTime,
  isoFromLocal,
  localDay,
  relativeDay,
  salespersonLabel,
  shiftDay,
  writableClients,
} from '../navstevy/visits-model.ts';

const RESIZE_LABEL = 'Změnit šířku panelu (šipky vlevo a vpravo)';

const quickDays = [
  { days: 1, label: 'Zítra' },
  { days: 7, label: 'Za týden' },
  { days: 14, label: 'Za 14 dní' },
  { days: 30, label: 'Za měsíc' },
];

/** The schema of each field of a plan form. */
interface PlanFieldSchemas {
  readonly client: typeof ClientPickSchema;
  readonly dueDate: Schema.String;
  readonly note: Schema.String;
  readonly salespersonId: Schema.String;
}

/** The fields of a plan form. */
type PlanFormFields = {
  readonly [Key in keyof PlanFieldSchemas]: Field.FieldDef<Key, PlanFieldSchemas[Key]>;
};

/** A planned contact as typed: the client (`""` until picked), the day, a note and the responsible salesperson. */
export type PlanDraft = Field.EncodedFromFields<PlanFormFields>;

/** The fields of a plan form: the client, the day, a note and the responsible salesperson. */
export const planFields: FormBuilder.FormBuilder<PlanFormFields, never> = FormBuilder.empty
  .addField('client', ClientPickSchema)
  .addField('dueDate', Schema.String)
  .addField('note', Schema.String)
  .addField('salespersonId', Schema.String);

/** The kit controls of the plan fields. */
interface PlanControls {
  readonly client: typeof ComboboxField;
  readonly dueDate: typeof TextField;
  readonly note: typeof TextAreaField;
  readonly salespersonId: typeof ChoiceField;
}

/** The kit controls of the plan fields (`""` salesperson is the client's assigned one). */
export const planControls: PlanControls = {
  client: ComboboxField,
  dueDate: TextField,
  note: TextAreaField,
  salespersonId: ChoiceField,
};

/**
 * Planning a contact in the side panel (`""` salesperson is the client's assigned one). Enter never sends the plan:
 * only Uložit does.
 */
const planContactForm = FormReact.make(planFields, {
  fields: planControls,
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const planDueDate = planContactForm.getFieldAtoms(planContactForm.fields.dueDate);

/** PlanContact for a new contact, UpdatePlanItem with the changed fields for `item`; none while incomplete. */
export const planCommandOf = (
  value: PlanDraft,
  item: PlanItem | undefined,
  writeAll: boolean,
): Option.Option<CrmCommandInput> => {
  if (value.client === '' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.dueDate)) {
    return Option.none();
  }
  const note = value.note.trim();
  if (item !== undefined) {
    const command: CrmCommandInput = { _tag: 'UpdatePlanItem', planItemId: item.id };
    if (value.dueDate !== item.dueDate) {
      Object.assign(command, { dueDate: value.dueDate });
    }
    if (note !== (item.note ?? '')) {
      Object.assign(command, { note });
    }
    return Option.some(command);
  }
  const command: CrmCommandInput = { _tag: 'PlanContact', clientId: value.client, dueDate: value.dueDate };
  if (note !== '') {
    Object.assign(command, { note });
  }
  if (writeAll && value.salespersonId !== '') {
    Object.assign(command, { salespersonId: value.salespersonId });
  }
  return Option.some(command);
};

/** New planned contact, or rescheduling an open one (`item`). */
export const PlanContactPanel = ({
  clientId,
  item,
  onClose,
  records,
  submit,
}: {
  readonly clientId?: string;
  readonly item?: PlanItem;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const { language, t } = useModernI18n();
  const toaster = useToast();
  const translate = useMessageTranslator();
  const today = localDay(records.now);
  const editing = item !== undefined;
  const fixedClient = editing || clientId !== undefined;
  const opened: PlanDraft = {
    client: item?.clientId ?? clientId ?? '',
    dueDate: item?.dueDate ?? shiftDay(today, 7),
    note: item?.note ?? '',
    salespersonId: '',
  };
  const draft = Option.getOrElse(useAtomValue(planContactForm.values), () => opened);
  const setDueDate = useAtomSet(planDueDate.setValue);
  const form = useCrmFormSave<PlanDraft>({
    command: (value) => planCommandOf(value, item, records.viewer.writeAll),
    failureText: (message) => czechError(message, 'Uložení se nezdařilo.'),
    // A new contact for a known client opens complete: Uložit plans it at once.
    fromEmpty: editing || clientId === undefined ? undefined : { empty: { ...opened, dueDate: '' }, opened },
    onSaved: (value) => {
      toaster.create({
        description: `${clientLabel(records, value.client)} · ${formatDay(value.dueDate)}`,
        title: editing ? 'Kontakt přeplánován' : 'Kontakt naplánován',
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
  useMessagesWhileInvalid(planContactForm, form.record.status === 'invalid');

  return (
    <SidePanel
      actions={<CrmFormSaveActions form={form} onCancel={onClose} />}
      description="Ruční plán obchodníka. Systém sám nic neplánuje ani nedoporučuje."
      guard={form.guard}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="lg"
      title={editing ? 'Přeplánovat kontakt' : 'Naplánovat kontakt'}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={opened}
        form={planContactForm}
        translateMessage={translate}
      >
        {fixedClient ? (
          <DetailList items={[{ label: 'Klient', value: clientLabel(records, draft.client) }]} />
        ) : (
          <planContactForm.client
            clearable={false}
            helpText="Jen klienti, ke kterým smíte zapisovat."
            items={writableClients(records).map((entry) => ({ label: entry.name, value: entry.id }))}
            label={t('crm.ciWorkflow.client')}
            noResultsMessage="Žádný klient neodpovídá"
            placeholder={t('crm.ciWorkflow.searchClient')}
            required
            requiredLabel={requiredLabelFor(language)}
            size="sm"
            translations={comboboxTranslations}
          />
        )}
        <planContactForm.dueDate
          helpText={`${formatDay(draft.dueDate)} · ${relativeDay(draft.dueDate, today)}`}
          id="crm-plan-due"
          label={t('crm.ciWorkflow.contactOn')}
          min={today}
          name="dueDate"
          required
          requiredLabel={requiredLabelFor(language)}
          size="sm"
          type="date"
        />
        <div className="flex flex-wrap gap-100">
          {quickDays.map((entry) => (
            <Button
              appearance="outline"
              key={entry.days}
              onClick={() => setDueDate(shiftDay(today, entry.days))}
              severity="secondary"
              size="sm"
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <planContactForm.note
          id="crm-plan-note"
          label={t('crm.ciWorkflow.note')}
          maxLength={4000}
          name="note"
          placeholder={t('crm.ciWorkflow.planNotePlaceholder')}
          rows={3}
          size="sm"
        />
        {!editing && records.viewer.writeAll && (
          <planContactForm.salespersonId
            items={[
              { label: 'Přidělený obchodník klienta', value: '' },
              ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
            ]}
            label={t('crm.ciWorkflow.responsibleSalesperson')}
            placeholder="Přidělený obchodník klienta"
          />
        )}
      </FormRoot>
    </SidePanel>
  );
};

/** Completing a planned contact as typed: the outcome, and the visit that fulfilled it when one is recorded. */
type CompletionDraft = VisitDraft & { readonly doneNote: string; readonly withVisit: boolean };

/** CompletePlanItem with the outcome and the visit; none while a recorded visit lacks its result or time. */
const completionCommandOf = (draft: CompletionDraft, item: PlanItem): Option.Option<CrmCommandInput> => {
  const occurredAt = isoFromLocal(draft.date, draft.time);
  const kind = visitKindOf(draft.kind);
  if (draft.withVisit && (draft.result.trim() === '' || occurredAt === undefined || Option.isNone(kind))) {
    return Option.none();
  }
  const command: Extract<CrmCommandInput, { readonly _tag: 'CompletePlanItem' }> = {
    _tag: 'CompletePlanItem',
    planItemId: item.id,
  };
  if (draft.doneNote.trim() !== '') {
    Object.assign(command, { doneNote: draft.doneNote.trim() });
  }
  if (draft.withVisit && occurredAt !== undefined && Option.isSome(kind)) {
    const visit: NonNullable<typeof command.visit> = { kind: kind.value, occurredAt, result: draft.result.trim() };
    if (draft.note.trim() !== '') {
      Object.assign(visit, { note: draft.note.trim() });
    }
    Object.assign(command, { visit });
  }
  return Option.some(command);
};

/** Completing a planned contact. Enter never completes it: only Uložit does. */
const completePlanForm = FormReact.make(
  visitFields.addField('doneNote', Schema.String).addField('withVisit', Schema.Boolean),
  {
    fields: { ...visitControls, doneNote: TextField, withVisit: CheckboxField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** Mark a planned contact done; optionally record the visit / call that fulfilled it (C06). */
export const CompletePlanPanel = ({
  item,
  onClose,
  records,
  submit,
}: {
  readonly item: PlanItem;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const translate = useMessageTranslator();
  const opened: CompletionDraft = {
    ...emptyVisitDraft(records, item.clientId, 'call'),
    doneNote: '',
    withVisit: true,
  };
  const draft = Option.getOrElse(useAtomValue(completePlanForm.values), () => opened);
  const form = useCrmFormSave<CompletionDraft>({
    command: (value) => completionCommandOf(value, item),
    failureText: (message) => czechError(message, 'Uložení se nezdařilo.'),
    onSaved: (value) => {
      toaster.create({
        description: value.withVisit ? `${visitKindLabel(value.kind)} je v historii návštěv.` : undefined,
        title: 'Kontakt vyřízen',
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
  useMessagesWhileInvalid(completePlanForm, form.record.status === 'invalid');
  const last = lastVisitOf(records.state.visits.items, item.clientId);
  return (
    <SidePanel
      actions={<CrmFormSaveActions form={form} onCancel={onClose} />}
      description={`${clientLabel(records, item.clientId)} · plánováno na ${formatDay(item.dueDate)}`}
      guard={form.guard}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="lg"
      title={t('crm.ciWorkflow.completeContact')}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={opened}
        form={completePlanForm}
        translateMessage={translate}
      >
        <DetailList
          items={[
            { label: 'Poznámka k plánu', value: item.note ?? <span className="text-fg-secondary">bez poznámky</span> },
            { label: 'Obchodník', value: salespersonLabel(records, item.salespersonId) },
            {
              label: 'Poslední kontakt',
              value:
                last === undefined ? (
                  <span className="text-fg-secondary">bez záznamu</span>
                ) : (
                  `${formatVisitTime(last.occurredAt)} · ${last.result}`
                ),
            },
          ]}
        />
        <completePlanForm.doneNote
          autoComplete="off"
          id="crm-plan-done-note"
          label={t('crm.ciWorkflow.contactOutcome')}
          name="doneNote"
          size="sm"
        />
        <completePlanForm.withVisit id="crm-plan-with-visit" label={t('crm.ciWorkflow.recordVisit')} />
        {draft.withVisit && (
          <div className={`${surfaceTileClassName} flex flex-col gap-200 p-200`}>
            <VisitFields
              form={completePlanForm}
              idPrefix="crm-plan-visit"
              records={records}
              showClient={false}
              showNextStep={false}
              showSalesperson={false}
            />
          </div>
        )}
      </FormRoot>
    </SidePanel>
  );
};
