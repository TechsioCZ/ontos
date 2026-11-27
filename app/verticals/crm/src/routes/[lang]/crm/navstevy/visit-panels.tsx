import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import type { Atom } from 'effect/reactivity';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// AREA: visits — owned by the crm-visits lane. Side panels: record a visit, correct it (with history), detail.
import { DetailList, SidePanel, comboboxTranslations, requiredLabelFor, surfaceTileClassName } from '@app/admin-ui';
import {
  CheckboxField,
  ChoiceField,
  ComboboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  RadioField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { Field } from '@app/core-runtime/ui/form';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useEffect } from 'react';
import type { FC } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { visitKinds } from '../../../../../shared/domain/visits.ts';
import type { Visit, VisitKind } from '../../../../../shared/domain/visits.ts';

import { VisitKindBadge } from './visit-timeline.tsx';
import {
  clientLabel,
  czechError,
  formatDay,
  formatVisitTime,
  isoFromLocal,
  localInputs,
  principalLabel,
  salespersonLabel,
  visitKindMeta,
  writableClients,
} from './visits-model.ts';

const RESIZE_LABEL = 'Změnit šířku panelu (šipky vlevo a vpravo)';

export type Submit = CrmCommandSubmit;

/** A client picked in a visit or plan form; `""` is none. */
export const ClientPickSchema = Schema.String.check(
  Schema.makeFilter((clientId: string) => clientId !== '', { message: 'Vyberte klienta.' }),
);

/**
 * A visit as typed in every visit form: the Prague day and time apart (an empty time is midnight), the kind and the
 * salesperson as picked (`""` is the client's assigned salesperson). The checks carry the messages the fields show.
 */
/** The day of a visit; an empty time is midnight. */
const VisitDateSchema = Schema.String.check(
  Schema.makeFilter((date: string) => isoFromLocal(date, '') !== undefined, { message: 'Vyplňte datum a čas.' }),
);
const VisitResultSchema = Schema.String.check(
  Schema.makeFilter((result: string) => result.trim() !== '', { message: 'Vyplňte krátký výsledek jednání.' }),
);

/** The schema of each field every visit form has. */
interface VisitFieldSchemas {
  readonly clientId: typeof ClientPickSchema;
  readonly date: typeof VisitDateSchema;
  readonly kind: Schema.String;
  readonly nextStep: Schema.String;
  readonly nextStepDate: Schema.String;
  readonly note: Schema.String;
  readonly result: typeof VisitResultSchema;
  readonly salespersonId: Schema.String;
  readonly time: Schema.String;
}

/** The fields every visit form has. */
type VisitFormFields = {
  readonly [Key in keyof VisitFieldSchemas]: Field.FieldDef<Key, VisitFieldSchemas[Key]>;
};

/**
 * A visit as typed in every visit form: the Prague day and time apart, the kind as picked and the salesperson as
 * picked (`""` is the client's assigned one).
 */
export type VisitDraft = Field.EncodedFromFields<VisitFormFields>;

/**
 * The fields every visit form has, checked with the messages they show; a form adds its own (add to plan, reason,
 * outcome) to these.
 */
export const visitFields: FormBuilder.FormBuilder<VisitFormFields, never> = FormBuilder.empty
  .addField('clientId', ClientPickSchema)
  .addField('date', VisitDateSchema)
  .addField('kind', Schema.String)
  .addField('nextStep', Schema.String)
  .addField('nextStepDate', Schema.String)
  .addField('note', Schema.String)
  .addField('result', VisitResultSchema)
  .addField('salespersonId', Schema.String)
  .addField('time', Schema.String);

/** The kit controls of the visit fields. */
interface VisitControls {
  readonly clientId: typeof ComboboxField;
  readonly date: typeof TextField;
  readonly kind: typeof RadioField;
  readonly nextStep: typeof TextField;
  readonly nextStepDate: typeof TextField;
  readonly note: typeof TextAreaField;
  readonly result: typeof TextField;
  readonly salespersonId: typeof ChoiceField;
  readonly time: typeof TextField;
}

/** The kit controls of the visit fields; each visit form adds the controls of its own fields. */
export const visitControls: VisitControls = {
  clientId: ComboboxField,
  date: TextField,
  kind: RadioField,
  nextStep: TextField,
  nextStepDate: TextField,
  note: TextAreaField,
  result: TextField,
  salespersonId: ChoiceField,
  time: TextField,
};

interface Choice {
  readonly label: string;
  readonly value: string;
}

/**
 * The visit fields of a visit form, as `VisitFields` renders them. A form built from `visitFields` with the
 * `visitControls` has them, whatever else it holds.
 */
export interface VisitFieldsForm {
  readonly clientId: FC<{
    clearable: boolean;
    helpText: string;
    items: Choice[];
    label: string;
    noResultsMessage: string;
    placeholder: string;
    required: boolean;
    requiredLabel: string;
    size: 'sm';
    translations: typeof comboboxTranslations;
  }>;
  readonly date: FC<{
    id: string;
    label: string;
    max: string;
    name: string;
    required: boolean;
    requiredLabel: string;
    size: 'sm';
    type: 'date';
  }>;
  readonly kind: FC<{ items: readonly Choice[]; label: string }>;
  readonly nextStep: FC<{ autoComplete: 'off'; id: string; label: string; name: string; size: 'sm' }>;
  readonly nextStepDate: FC<{ id: string; label: string; name: string; size: 'sm'; type: 'date' }>;
  readonly note: FC<{ id: string; label: string; maxLength: number; name: string; rows: number; size: 'sm' }>;
  readonly result: FC<{
    autoComplete: 'off';
    helpText: string;
    id: string;
    label: string;
    maxLength: number;
    name: string;
    required: boolean;
    requiredLabel: string;
    size: 'sm';
  }>;
  readonly salespersonId: FC<{ items: Choice[]; label: string; placeholder: string }>;
  readonly time: FC<{
    id: string;
    label: string;
    name: string;
    required: boolean;
    requiredLabel: string;
    size: 'sm';
    type: 'time';
  }>;
}

/** The kind a draft names, when it is one. */
export const visitKindOf = (kind: string): Option.Option<VisitKind> =>
  Option.fromUndefinedOr(visitKinds.find((candidate) => candidate === kind));

/** The label of the kind a draft names. */
export const visitKindLabel = (kind: string): string =>
  Option.match(visitKindOf(kind), { onNone: () => kind, onSome: (known) => visitKindMeta[known].label });

export const emptyVisitDraft = (records: RecordsResponse, clientId = '', kind: VisitKind = 'visit'): VisitDraft => {
  const now = localInputs(records.now);
  return {
    clientId,
    date: now.date,
    kind,
    nextStep: '',
    nextStepDate: '',
    note: '',
    result: '',
    salespersonId: '',
    time: now.time,
  };
};

/** The parts of a built form whose field messages follow the save bar. */
interface MessagesForm {
  readonly isDirty: Atom.Atom<boolean>;
  readonly reset: Atom.Writable<void, void>;
  readonly validate: Atom.AtomResultFn<void, void>;
  readonly validationCount: Atom.Atom<number>;
}

/**
 * Field messages show once the draft is changed and invalid, the same moment the save bar says so, and hide again
 * once the form is back at the values it opened with.
 */
export const useMessagesWhileInvalid = (form: MessagesForm, invalid: boolean) => {
  const validate = useAtomSet(form.validate);
  const reset = useAtomSet(form.reset);
  const checked = useAtomValue(form.validationCount) > 0;
  const changed = useAtomValue(form.isDirty);
  useEffect(() => {
    if (invalid) {
      validate();
    } else if (checked && !changed) {
      reset();
    }
  }, [changed, checked, invalid, reset, validate]);
};

/** Translates a field message; the visit messages are Czech copy, shown as they are. */
export const useMessageTranslator = () => {
  const { t } = useModernI18n();
  return (message: string) => t(message, { defaultValue: message });
};

/** Fields shared by "record" and "correct" (and by completing a planned contact). */
export const VisitFields = ({
  form,
  idPrefix,
  records,
  showClient,
  showNextStep = true,
  showSalesperson,
}: {
  readonly form: VisitFieldsForm;
  readonly idPrefix: string;
  readonly records: RecordsResponse;
  readonly showClient: boolean;
  readonly showNextStep?: boolean;
  readonly showSalesperson: boolean;
}) => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const clients = writableClients(records);
  const today = localInputs(records.now).date;
  return (
    <>
      {showClient && (
        <form.clientId
          clearable={false}
          helpText="Jen klienti, ke kterým smíte zapisovat."
          items={clients.map((client) => ({ label: client.name, value: client.id }))}
          label={t('crm.ciClientsVisits.fields.client')}
          noResultsMessage="Žádný klient neodpovídá"
          placeholder={t('crm.ciClientsVisits.visits.clientPlaceholder')}
          required
          requiredLabel={requiredLabel}
          size="sm"
          translations={comboboxTranslations}
        />
      )}
      <form.kind
        items={visitKinds.map((kind) => ({ label: visitKindMeta[kind].label, value: kind }))}
        label="Typ kontaktu"
      />
      <div className="grid grid-cols-2 gap-150">
        <form.date
          id={`${idPrefix}-date`}
          label={t('crm.ciClientsVisits.fields.date')}
          max={today}
          name="date"
          required
          requiredLabel={requiredLabel}
          size="sm"
          type="date"
        />
        <form.time
          id={`${idPrefix}-time`}
          label={t('crm.ciClientsVisits.fields.time')}
          name="time"
          required
          requiredLabel={requiredLabel}
          size="sm"
          type="time"
        />
      </div>
      {showSalesperson && (
        <form.salespersonId
          items={[
            { label: 'Podle přidělení klienta', value: '' },
            ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
          ]}
          label={t('crm.ciClientsVisits.fields.salesperson')}
          placeholder="Podle přidělení klienta"
        />
      )}
      <form.result
        autoComplete="off"
        helpText="Jedna věta: s čím jednání skončilo."
        id={`${idPrefix}-result`}
        label={t('crm.ciClientsVisits.visits.result')}
        maxLength={200}
        name="result"
        required
        requiredLabel={requiredLabel}
        size="sm"
      />
      <form.note
        id={`${idPrefix}-note`}
        label={t('crm.ciClientsVisits.fields.note')}
        maxLength={4000}
        name="note"
        rows={3}
        size="sm"
      />
      {showNextStep && (
        <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
          <span className="font-medium text-sm">Další krok (volitelně)</span>
          <form.nextStep
            autoComplete="off"
            id={`${idPrefix}-next-step`}
            label={t('crm.ciClientsVisits.visits.nextStep')}
            name="nextStep"
            size="sm"
          />
          <form.nextStepDate
            id={`${idPrefix}-next-date`}
            label={t('crm.ciClientsVisits.fields.dueDate')}
            name="nextStepDate"
            size="sm"
            type="date"
          />
        </div>
      )}
    </>
  );
};

/** A visit as the record forms hold it: the visit and whether its next step also goes into the plan. */
export type RecordVisitDraft = VisitDraft & { readonly addToPlan: boolean };

/** The RecordVisit command of a complete draft; none while the client, result or time is missing. */
export const recordVisitCommandOf = (
  draft: RecordVisitDraft,
  clientId: string,
  writeAll: boolean,
): Option.Option<CrmCommandInput> => {
  const occurredAt = isoFromLocal(draft.date, draft.time);
  const kind = visitKindOf(draft.kind);
  if (clientId === '' || draft.result.trim() === '' || occurredAt === undefined || Option.isNone(kind)) {
    return Option.none();
  }
  const nextStep = draft.nextStep.trim();
  const command: Extract<CrmCommandInput, { readonly _tag: 'RecordVisit' }> = {
    _tag: 'RecordVisit',
    clientId,
    kind: kind.value,
    occurredAt,
    result: draft.result.trim(),
  };
  if (draft.note.trim() !== '') {
    Object.assign(command, { note: draft.note.trim() });
  }
  if (nextStep !== '') {
    Object.assign(command, { nextStep });
  }
  if (draft.nextStepDate !== '') {
    Object.assign(command, { addToPlan: draft.addToPlan, nextStepDate: draft.nextStepDate });
  }
  if (writeAll && draft.salespersonId !== '') {
    Object.assign(command, { salespersonId: draft.salespersonId });
  }
  return Option.some(command);
};

/** Recording a visit in the side panel. Enter never sends the record: only Uložit does, through the panel's one save. */
const recordVisitForm = FormReact.make(visitFields.addField('addToPlan', Schema.Boolean), {
  fields: { ...visitControls, addToPlan: CheckboxField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

/** Record a new visit / call / video / e-mail (C02). `clientId` fixes the client (client card). */
export const RecordVisitPanel = ({
  clientId,
  onOpenChange,
  open,
  records,
  submit,
}: {
  readonly clientId?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const translate = useMessageTranslator();
  const opened: RecordVisitDraft = { ...emptyVisitDraft(records, clientId), addToPlan: true };
  const draft = Option.getOrElse(useAtomValue(recordVisitForm.values), () => opened);
  const form = useCrmFormSave<RecordVisitDraft>({
    command: (value) => recordVisitCommandOf(value, clientId ?? value.clientId, records.viewer.writeAll),
    failureText: (message) => czechError(message, 'Záznam se nepodařilo uložit.'),
    onSaved: (value) => {
      toaster.create({
        description: value.nextStepDate !== '' && value.addToPlan ? 'Další krok je v plánu K oslovení.' : undefined,
        title: `${visitKindLabel(value.kind)} zapsán(a)`,
        type: 'success',
      });
      onOpenChange(false);
    },
    submit,
    value: draft,
  });
  useMessagesWhileInvalid(recordVisitForm, form.record.status === 'invalid');
  const close = () => onOpenChange(false);
  return (
    <SidePanel
      actions={<CrmFormSaveActions form={form} onCancel={close} />}
      description={
        clientId === undefined
          ? 'Zapište kontakt, který proběhl. Plánované kontakty patří do K oslovení.'
          : clientLabel(records, clientId)
      }
      guard={form.guard}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      open={open}
      resizeLabel={RESIZE_LABEL}
      size="lg"
      title={t('crm.ciClientsVisits.visits.recordVisit')}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={opened}
        form={recordVisitForm}
        translateMessage={translate}
      >
        <VisitFields
          form={recordVisitForm}
          idPrefix="crm-visit-new"
          records={records}
          showClient={clientId === undefined}
          showSalesperson={records.viewer.writeAll}
        />
        {draft.nextStepDate !== '' && (
          <recordVisitForm.addToPlan
            id="crm-visit-new-plan"
            label={t('crm.ciClientsVisits.visits.addNextStepToMyPlan')}
          />
        )}
      </FormRoot>
    </SidePanel>
  );
};

const initialVisitDraft = (target: Visit): VisitDraft => {
  const local = localInputs(target.occurredAt);
  return {
    clientId: target.clientId,
    date: local.date,
    kind: target.kind,
    nextStep: target.nextStep ?? '',
    nextStepDate: target.nextStepDate ?? '',
    note: target.note ?? '',
    result: target.result,
    salespersonId: target.salespersonId ?? '',
    time: local.time,
  };
};

/** A correction as typed: the corrected fields and why. */
type CorrectionDraft = VisitDraft & { readonly reason: string };

const correctedFields: readonly (keyof VisitDraft)[] = [
  'kind',
  'date',
  'time',
  'result',
  'note',
  'nextStep',
  'nextStepDate',
];

/** The CorrectVisit command with only the changed fields; none while nothing changed or result and time are missing. */
const correctionCommandOf = (draft: CorrectionDraft, target: Visit): Option.Option<CrmCommandInput> => {
  const original = initialVisitDraft(target);
  const occurredAt = isoFromLocal(draft.date, draft.time);
  const kind = visitKindOf(draft.kind);
  const changed = (field: keyof VisitDraft) => draft[field] !== original[field];
  if (draft.result.trim() === '' || occurredAt === undefined || Option.isNone(kind) || !correctedFields.some(changed)) {
    return Option.none();
  }
  const command: CrmCommandInput = { _tag: 'CorrectVisit', visitId: target.id };
  if (changed('kind')) {
    Object.assign(command, { kind: kind.value });
  }
  if (changed('date') || changed('time')) {
    Object.assign(command, { occurredAt });
  }
  if (changed('result')) {
    Object.assign(command, { result: draft.result.trim() });
  }
  if (changed('note')) {
    Object.assign(command, { note: draft.note.trim() });
  }
  if (changed('nextStep')) {
    Object.assign(command, { nextStep: draft.nextStep.trim() });
  }
  if (changed('nextStepDate')) {
    Object.assign(command, { nextStepDate: draft.nextStepDate });
  }
  if (draft.reason.trim() !== '') {
    Object.assign(command, { reason: draft.reason.trim() });
  }
  return Option.some(command);
};

/** The correction of one visit. Enter never sends it: only Uložit does. */
const correctVisitForm = FormReact.make(visitFields.addField('reason', Schema.String), {
  fields: { ...visitControls, reason: TextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

const CorrectVisitForm = ({
  onClose,
  records,
  submit,
  visit,
}: {
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
  readonly visit: Visit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const translate = useMessageTranslator();
  const opened: CorrectionDraft = { ...initialVisitDraft(visit), reason: '' };
  const draft = Option.getOrElse(useAtomValue(correctVisitForm.values), () => opened);
  const form = useCrmFormSave<CorrectionDraft>({
    command: (value) => correctionCommandOf(value, visit),
    failureText: (message) => czechError(message, 'Opravu se nepodařilo uložit.'),
    onSaved: () => {
      toaster.create({
        description: 'Původní hodnoty zůstávají v historii oprav.',
        title: 'Záznam opraven',
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
  useMessagesWhileInvalid(correctVisitForm, form.record.status === 'invalid');
  return (
    <SidePanel
      actions={<CrmFormSaveActions form={form} onCancel={onClose} />}
      description={`${clientLabel(records, visit.clientId)} · zapsal(a) ${principalLabel(records, visit.authorPrincipalId)}`}
      guard={form.guard}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="lg"
      title={t('crm.ciClientsVisits.visits.correctRecord')}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={opened}
        form={correctVisitForm}
        translateMessage={translate}
      >
        <StatusText showIcon size="sm" status="default">
          Oprava záznam nepřepíše: původní hodnota, autor a čas opravy zůstanou v historii.
        </StatusText>
        <VisitFields
          form={correctVisitForm}
          idPrefix="crm-visit-fix"
          records={records}
          showClient={false}
          showSalesperson={false}
        />
        <correctVisitForm.reason
          autoComplete="off"
          id="crm-visit-fix-reason"
          label={t('crm.ciClientsVisits.visits.correctionReason')}
          name="reason"
          placeholder={t('crm.ciClientsVisits.visits.correctionExample')}
          size="sm"
        />
      </FormRoot>
    </SidePanel>
  );
};

/** Correct a visit. Every changed field is kept in the correction history (C02-03). */
export const CorrectVisitPanel = ({
  onClose,
  records,
  submit,
  visit,
}: {
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
  readonly visit: Visit | undefined;
}) =>
  visit === undefined ? null : (
    // A different visit starts a new correction.
    <CorrectVisitForm key={visit.id} onClose={onClose} records={records} submit={submit} visit={visit} />
  );

/** Read-only detail of one visit with its full correction history. */
export const VisitDetailPanel = ({
  canCorrect,
  onClose,
  onCorrect,
  onOpenClient,
  records,
  visit,
}: {
  readonly canCorrect: boolean;
  readonly onClose: () => void;
  readonly onCorrect: (visit: Visit) => void;
  readonly onOpenClient?: (clientId: string) => void;
  readonly records: RecordsResponse;
  readonly visit: Visit | undefined;
}) => {
  if (visit === undefined) {
    return null;
  }
  const { plan } = records.state.visits;
  const createdPlan = plan.find((item) => item.sourceVisitId === visit.id);
  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={onClose} severity="secondary">
            Zavřít
          </Button>
          {canCorrect && (
            <Button icon="icon-[mdi--pencil-outline]" onClick={() => onCorrect(visit)} severity="primary">
              Opravit záznam
            </Button>
          )}
        </>
      }
      description={formatVisitTime(visit.occurredAt)}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="lg"
      title={visit.result}
    >
      <div className="flex flex-col gap-300 py-200">
        <DetailList
          items={[
            {
              label: 'Klient',
              value:
                onOpenClient === undefined ? (
                  clientLabel(records, visit.clientId)
                ) : (
                  <Button
                    className="cursor-pointer font-medium underline underline-offset-2"
                    composition
                    onClick={() => onOpenClient(visit.clientId)}
                    size="current"
                    unstyled
                  >
                    {clientLabel(records, visit.clientId)}
                  </Button>
                ),
            },
            { label: 'Typ', value: <VisitKindBadge kind={visit.kind} /> },
            { label: 'Obchodník', value: salespersonLabel(records, visit.salespersonId) },
            { label: 'Zapsal(a)', value: principalLabel(records, visit.authorPrincipalId) },
            { label: 'Datum a čas', value: formatVisitTime(visit.occurredAt) },
            { label: 'Zapsáno', value: formatVisitTime(visit.createdAt) },
            { label: 'Výsledek', value: visit.result },
            { label: 'Poznámka', value: visit.note ?? <span className="text-fg-secondary">bez poznámky</span> },
            {
              label: 'Další krok',
              value:
                visit.nextStep === undefined && visit.nextStepDate === undefined ? (
                  <span className="text-fg-secondary">neuveden</span>
                ) : (
                  `${visit.nextStep ?? 'bez popisu'}${visit.nextStepDate === undefined ? '' : [' · ', formatDay(visit.nextStepDate)].join('')}`
                ),
            },
            {
              label: 'Plán K oslovení',
              value:
                createdPlan === undefined && visit.planItemId === undefined ? (
                  <span className="text-fg-secondary">bez vazby na plán</span>
                ) : (
                  <span className="flex flex-col gap-50">
                    {visit.planItemId !== undefined && <span>Zapsáno při vyřízení plánovaného kontaktu</span>}
                    {createdPlan !== undefined && (
                      <span>{`Naplánováno na ${formatDay(createdPlan.dueDate)} (${createdPlan.status === 'done' ? 'vyřízeno' : 'otevřené'})`}</span>
                    )}
                  </span>
                ),
            },
          ]}
        />
        <section className="flex flex-col gap-150">
          <h3 className="flex items-center gap-100 font-semibold text-sm">
            Historie oprav
            <Badge severity={visit.corrections.length === 0 ? 'neutral' : 'warning'} size="sm">
              {String(visit.corrections.length)}
            </Badge>
          </h3>
          {visit.corrections.length === 0 ? (
            <p className="text-fg-secondary text-sm">Záznam nebyl opravován.</p>
          ) : (
            <ol className="flex flex-col gap-150">
              {visit.corrections.toReversed().map((correction, index) => (
                <li
                  className={`${surfaceTileClassName} flex flex-col gap-50 p-150 text-sm`}
                  key={`${DateTime.formatIso(correction.at)}-${correction.field}-${String(index)}`}
                >
                  <span className="text-fg-secondary text-xs">
                    {`${formatVisitTime(correction.at)} · ${principalLabel(records, correction.by)} · ${correction.field}`}
                  </span>
                  <span className="text-fg-secondary line-through">{correction.previous ?? '(prázdné)'}</span>
                  <span>{correction.next ?? '(smazáno)'}</span>
                  {correction.reason !== undefined && (
                    <span className="text-fg-secondary text-xs">{`Důvod: ${correction.reason}`}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </SidePanel>
  );
};
