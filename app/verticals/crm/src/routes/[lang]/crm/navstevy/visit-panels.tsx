import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime, Option } from 'effect';
import { assignableSalespeople } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
// AREA: visits — owned by the crm-visits lane. Side panels: record a visit, correct it (with history), detail.
import { DetailList, SidePanel, comboboxTranslations, surfaceTileClassName } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useState } from 'react';
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

export interface VisitDraft {
  readonly addToPlan: boolean;
  readonly clientId: string;
  readonly date: string;
  readonly kind: VisitKind;
  readonly nextStep: string;
  readonly nextStepDate: NonNullable<Extract<CrmCommandInput, { readonly _tag: 'RecordVisit' }>['nextStepDate']>;
  readonly note: string;
  readonly result: string;
  readonly salespersonId: string;
  readonly time: string;
}

export const emptyVisitDraft = (records: RecordsResponse, clientId = '', kind: VisitKind = 'visit'): VisitDraft => {
  const now = localInputs(records.now);
  return {
    addToPlan: true,
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

const firstValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

/** Fields shared by "record" and "correct" (and by completing a planned contact). */
export const VisitFields = ({
  draft,
  idPrefix,
  onChange,
  records,
  showClient,
  showNextStep = true,
  showSalesperson,
  submitted,
}: {
  readonly draft: VisitDraft;
  readonly idPrefix: string;
  readonly onChange: (patch: Partial<VisitDraft>) => void;
  readonly records: RecordsResponse;
  readonly showClient: boolean;
  readonly showNextStep?: boolean;
  readonly showSalesperson: boolean;
  readonly submitted: boolean;
}) => {
  const { t } = useModernI18n();
  const clients = writableClients(records);
  const today = localInputs(records.now).date;
  const resultError = submitted && draft.result.trim() === '' ? 'Vyplňte krátký výsledek jednání.' : undefined;
  const dateError =
    submitted && isoFromLocal(draft.date, draft.time) === undefined ? 'Vyplňte datum a čas.' : undefined;
  return (
    <>
      {showClient && (
        <Combobox
          clearable={false}
          helpText={submitted && draft.clientId === '' ? 'Vyberte klienta.' : 'Jen klienti, ke kterým smíte zapisovat.'}
          items={clients.map((client) => ({ label: client.name, value: client.id }))}
          label={t('crm.ciClientsVisits.fields.client')}
          noResultsMessage="Žádný klient neodpovídá"
          onChange={(values) => onChange({ clientId: firstValue(values) ?? '' })}
          placeholder={t('crm.ciClientsVisits.visits.clientPlaceholder')}
          required
          size="sm"
          translations={comboboxTranslations}
          validateStatus={submitted && draft.clientId === '' ? 'error' : 'default'}
          value={draft.clientId === '' ? [] : [draft.clientId]}
        />
      )}
      <RadioGroup
        onValueChange={(next) => {
          const kind = visitKinds.find((candidate) => candidate === next);
          if (kind !== undefined) {
            onChange({ kind });
          }
        }}
        size="sm"
        value={draft.kind}
      >
        <RadioGroup.Label>Typ kontaktu</RadioGroup.Label>
        <RadioGroup.ItemGroup className="flex flex-wrap gap-x-300 gap-y-100">
          {visitKinds.map((kind) => (
            <RadioGroup.Item key={kind} value={kind}>
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemText>{visitKindMeta[kind].label}</RadioGroup.ItemText>
            </RadioGroup.Item>
          ))}
        </RadioGroup.ItemGroup>
      </RadioGroup>
      <div className="grid grid-cols-2 gap-150">
        <FormInput
          helpText={dateError}
          id={`${idPrefix}-date`}
          label={t('crm.ciClientsVisits.fields.date')}
          max={today}
          name="date"
          onChange={(event) => onChange({ date: event.target.value })}
          required
          size="sm"
          type="date"
          validateStatus={dateError === undefined ? 'default' : 'error'}
          value={draft.date}
        />
        <FormInput
          id={`${idPrefix}-time`}
          label={t('crm.ciClientsVisits.fields.time')}
          name="time"
          onChange={(event) => onChange({ time: event.target.value })}
          required
          size="sm"
          type="time"
          value={draft.time}
        />
      </div>
      {showSalesperson && (
        <SelectTemplate
          items={[
            { label: 'Podle přidělení klienta', value: '' },
            ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
          ]}
          label={t('crm.ciClientsVisits.fields.salesperson')}
          name="salesperson"
          onValueChange={(details) => onChange({ salespersonId: details.value[0] ?? '' })}
          size="sm"
          value={[draft.salespersonId]}
        />
      )}
      <FormInput
        autoComplete="off"
        helpText={resultError ?? 'Jedna věta: s čím jednání skončilo.'}
        id={`${idPrefix}-result`}
        label={t('crm.ciClientsVisits.visits.result')}
        maxLength={200}
        name="result"
        onChange={(event) => onChange({ result: event.target.value })}
        required
        size="sm"
        validateStatus={resultError === undefined ? 'default' : 'error'}
        value={draft.result}
      />
      <FormTextarea
        id={`${idPrefix}-note`}
        label={t('crm.ciClientsVisits.fields.note')}
        maxLength={4000}
        name="note"
        onChange={(event) => onChange({ note: event.target.value })}
        rows={3}
        size="sm"
        value={draft.note}
      />
      {showNextStep && (
        <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
          <span className="font-medium text-sm">Další krok (volitelně)</span>
          <FormInput
            autoComplete="off"
            id={`${idPrefix}-next-step`}
            label={t('crm.ciClientsVisits.visits.nextStep')}
            name="nextStep"
            onChange={(event) => onChange({ nextStep: event.target.value })}
            size="sm"
            value={draft.nextStep}
          />
          <FormInput
            id={`${idPrefix}-next-date`}
            label={t('crm.ciClientsVisits.fields.dueDate')}
            name="nextStepDate"
            onChange={(event) => onChange({ nextStepDate: event.target.value })}
            size="sm"
            type="date"
            value={draft.nextStepDate}
          />
        </div>
      )}
    </>
  );
};

/** The RecordVisit command of a complete draft; none while the client, result or time is missing. */
const recordVisitCommandOf = (
  draft: VisitDraft,
  clientId: string,
  writeAll: boolean,
): Option.Option<CrmCommandInput> => {
  const occurredAt = isoFromLocal(draft.date, draft.time);
  if (clientId === '' || draft.result.trim() === '' || occurredAt === undefined) {
    return Option.none();
  }
  const nextStep = draft.nextStep.trim();
  const command: Extract<CrmCommandInput, { readonly _tag: 'RecordVisit' }> = {
    _tag: 'RecordVisit',
    clientId,
    kind: draft.kind,
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
  const [draft, setDraft] = useState<VisitDraft>(() => emptyVisitDraft(records, clientId));
  const patch = (next: Partial<VisitDraft>) => setDraft((current) => ({ ...current, ...next }));
  const form = useCrmFormSave<VisitDraft>({
    command: (value) => recordVisitCommandOf(value, clientId ?? value.clientId, records.viewer.writeAll),
    failureText: (message) => czechError(message, 'Záznam se nepodařilo uložit.'),
    onSaved: (value) => {
      toaster.create({
        description: value.nextStepDate !== '' && value.addToPlan ? 'Další krok je v plánu K oslovení.' : undefined,
        title: `${visitKindMeta[value.kind].label} zapsán(a)`,
        type: 'success',
      });
      onOpenChange(false);
    },
    submit,
    value: draft,
  });
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
      {/* Enter never sends the record: only Uložit does. */}
      <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
        <VisitFields
          draft={draft}
          idPrefix="crm-visit-new"
          onChange={patch}
          records={records}
          showClient={clientId === undefined}
          showSalesperson={records.viewer.writeAll}
          submitted={form.record.status === 'invalid'}
        />
        {draft.nextStepDate !== '' && (
          <FormCheckbox
            checked={draft.addToPlan}
            id="crm-visit-new-plan"
            label={t('crm.ciClientsVisits.visits.addNextStepToMyPlan')}
            onCheckedChange={(checked) => patch({ addToPlan: checked })}
            size="sm"
          />
        )}
      </form>
    </SidePanel>
  );
};

const initialVisitDraft = (target: Visit): VisitDraft => {
  const local = localInputs(target.occurredAt);
  return {
    addToPlan: false,
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
interface CorrectionDraft {
  readonly reason: string;
  readonly visit: VisitDraft;
}

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
const correctionCommandOf = (value: CorrectionDraft, target: Visit): Option.Option<CrmCommandInput> => {
  const { visit: draft } = value;
  const original = initialVisitDraft(target);
  const occurredAt = isoFromLocal(draft.date, draft.time);
  const changed = (field: keyof VisitDraft) => draft[field] !== original[field];
  if (draft.result.trim() === '' || occurredAt === undefined || !correctedFields.some(changed)) {
    return Option.none();
  }
  const command: CrmCommandInput = { _tag: 'CorrectVisit', visitId: target.id };
  if (changed('kind')) {
    Object.assign(command, { kind: draft.kind });
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
  if (value.reason.trim() !== '') {
    Object.assign(command, { reason: value.reason.trim() });
  }
  return Option.some(command);
};

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
  const [draft, setDraft] = useState<CorrectionDraft>(() => ({ reason: '', visit: initialVisitDraft(visit) }));
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
      {/* Enter never sends the correction: only Uložit does. */}
      <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
        <StatusText showIcon size="sm" status="default">
          Oprava záznam nepřepíše: původní hodnota, autor a čas opravy zůstanou v historii.
        </StatusText>
        <VisitFields
          draft={draft.visit}
          idPrefix="crm-visit-fix"
          onChange={(patch) => setDraft((current) => ({ ...current, visit: { ...current.visit, ...patch } }))}
          records={records}
          showClient={false}
          showSalesperson={false}
          submitted
        />
        <FormInput
          autoComplete="off"
          id="crm-visit-fix-reason"
          label={t('crm.ciClientsVisits.visits.correctionReason')}
          name="reason"
          onChange={(event) => {
            const reason = event.target.value;
            setDraft((current) => ({ ...current, reason }));
          }}
          placeholder={t('crm.ciClientsVisits.visits.correctionExample')}
          size="sm"
          value={draft.reason}
        />
      </form>
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
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zavřít
          </Button>
          {canCorrect && (
            <Button icon="icon-[mdi--pencil-outline]" onClick={() => onCorrect(visit)} variant="primary">
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
                  <button
                    className="cursor-pointer font-medium underline underline-offset-2"
                    onClick={() => onOpenClient(visit.clientId)}
                    type="button"
                  >
                    {clientLabel(records, visit.clientId)}
                  </button>
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
            <Badge size="sm" variant={visit.corrections.length === 0 ? 'outline' : 'warning'}>
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
