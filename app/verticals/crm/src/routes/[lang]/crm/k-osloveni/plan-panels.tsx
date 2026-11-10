import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Option } from 'effect';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import { assignableSalespeople } from '../../../../crm/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
// AREA: visits (C06) — owned by the crm-visits lane. Plan a contact / reschedule it / complete it (+ visit).
import { DetailList, SidePanel, comboboxTranslations, surfaceTileClassName } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { lastVisitOf } from '../../../../../shared/domain/visits.ts';
import type { PlanItem } from '../../../../../shared/domain/visits.ts';

import { VisitFields, emptyVisitDraft } from '../navstevy/visit-panels.tsx';
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
  visitKindMeta,
  writableClients,
} from '../navstevy/visits-model.ts';

const RESIZE_LABEL = 'Změnit šířku panelu (šipky vlevo a vpravo)';
const firstValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

const quickDays = [
  { days: 1, label: 'Zítra' },
  { days: 7, label: 'Za týden' },
  { days: 14, label: 'Za 14 dní' },
  { days: 30, label: 'Za měsíc' },
];

/** A planned contact as typed. */
export interface PlanDraft {
  readonly client: string;
  readonly dueDate: Extract<CrmCommandInput, { readonly _tag: 'PlanContact' }>['dueDate'];
  readonly note: string;
  readonly salespersonId: string;
}

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
  const { t } = useModernI18n();
  const toaster = useToast();
  const today = localDay(records.now);
  const editing = item !== undefined;
  const fixedClient = editing || clientId !== undefined;
  const opened: PlanDraft = {
    client: item?.clientId ?? clientId ?? '',
    dueDate: item?.dueDate ?? shiftDay(today, 7),
    note: item?.note ?? '',
    salespersonId: '',
  };
  const [draft, setDraft] = useState<PlanDraft>(opened);
  const patch = (next: Partial<PlanDraft>) => setDraft((current) => ({ ...current, ...next }));
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
  const submitted = form.record.status === 'invalid';
  const { client, dueDate, note, salespersonId } = draft;

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
      {/* Enter never sends the plan: only Uložit does. */}
      <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
        {fixedClient ? (
          <DetailList items={[{ label: 'Klient', value: clientLabel(records, client) }]} />
        ) : (
          <Combobox
            clearable={false}
            helpText={submitted && client === '' ? 'Vyberte klienta.' : 'Jen klienti, ke kterým smíte zapisovat.'}
            items={writableClients(records).map((entry) => ({ label: entry.name, value: entry.id }))}
            label={t('crm.ciWorkflow.client')}
            noResultsMessage="Žádný klient neodpovídá"
            onChange={(values) => patch({ client: firstValue(values) ?? '' })}
            placeholder={t('crm.ciWorkflow.searchClient')}
            required
            size="sm"
            translations={comboboxTranslations}
            validateStatus={submitted && client === '' ? 'error' : 'default'}
            value={client === '' ? [] : [client]}
          />
        )}
        <FormInput
          helpText={`${formatDay(dueDate)} · ${relativeDay(dueDate, today)}`}
          id="crm-plan-due"
          label={t('crm.ciWorkflow.contactOn')}
          min={today}
          name="dueDate"
          onChange={(event) => patch({ dueDate: event.target.value })}
          required
          size="sm"
          type="date"
          value={dueDate}
        />
        <div className="flex flex-wrap gap-100">
          {quickDays.map((entry) => (
            <Button
              key={entry.days}
              onClick={() => patch({ dueDate: shiftDay(today, entry.days) })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <FormTextarea
          id="crm-plan-note"
          label={t('crm.ciWorkflow.note')}
          maxLength={4000}
          name="note"
          onChange={(event) => patch({ note: event.target.value })}
          placeholder={t('crm.ciWorkflow.planNotePlaceholder')}
          rows={3}
          size="sm"
          value={note}
        />
        {!editing && records.viewer.writeAll && (
          <SelectTemplate
            items={[
              { label: 'Přidělený obchodník klienta', value: '' },
              ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
            ]}
            label={t('crm.ciWorkflow.responsibleSalesperson')}
            name="salesperson"
            onValueChange={(details) => patch({ salespersonId: details.value[0] ?? '' })}
            size="sm"
            value={[salespersonId]}
          />
        )}
      </form>
    </SidePanel>
  );
};

/** Completing a planned contact as typed: the outcome, and the visit that fulfilled it when one is recorded. */
interface CompletionDraft {
  readonly doneNote: string;
  readonly visit: VisitDraft;
  readonly withVisit: boolean;
}

/** CompletePlanItem with the outcome and the visit; none while a recorded visit lacks its result or time. */
const completionCommandOf = (value: CompletionDraft, item: PlanItem): Option.Option<CrmCommandInput> => {
  const { visit: draft } = value;
  const occurredAt = isoFromLocal(draft.date, draft.time);
  if (value.withVisit && (draft.result.trim() === '' || occurredAt === undefined)) {
    return Option.none();
  }
  const command: Extract<CrmCommandInput, { readonly _tag: 'CompletePlanItem' }> = {
    _tag: 'CompletePlanItem',
    planItemId: item.id,
  };
  if (value.doneNote.trim() !== '') {
    Object.assign(command, { doneNote: value.doneNote.trim() });
  }
  if (value.withVisit && occurredAt !== undefined) {
    const visit: NonNullable<typeof command.visit> = { kind: draft.kind, occurredAt, result: draft.result.trim() };
    if (draft.note.trim() !== '') {
      Object.assign(visit, { note: draft.note.trim() });
    }
    Object.assign(command, { visit });
  }
  return Option.some(command);
};

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
  const [draft, setDraft] = useState<CompletionDraft>(() => ({
    doneNote: '',
    visit: { ...emptyVisitDraft(records, item.clientId, 'call'), result: '' },
    withVisit: true,
  }));
  const form = useCrmFormSave<CompletionDraft>({
    command: (value) => completionCommandOf(value, item),
    failureText: (message) => czechError(message, 'Uložení se nezdařilo.'),
    onSaved: (value) => {
      toaster.create({
        description: value.withVisit ? `${visitKindMeta[value.visit.kind].label} je v historii návštěv.` : undefined,
        title: 'Kontakt vyřízen',
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
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
      {/* Enter never completes the contact: only Uložit does. */}
      <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
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
        <FormInput
          autoComplete="off"
          id="crm-plan-done-note"
          label={t('crm.ciWorkflow.contactOutcome')}
          name="doneNote"
          onChange={(event) => {
            const doneNote = event.target.value;
            setDraft((current) => ({ ...current, doneNote }));
          }}
          size="sm"
          value={draft.doneNote}
        />
        <FormCheckbox
          checked={draft.withVisit}
          id="crm-plan-with-visit"
          label={t('crm.ciWorkflow.recordVisit')}
          onCheckedChange={(withVisit) => setDraft((current) => ({ ...current, withVisit }))}
          size="sm"
        />
        {draft.withVisit && (
          <div className={`${surfaceTileClassName} flex flex-col gap-200 p-200`}>
            <VisitFields
              draft={draft.visit}
              idPrefix="crm-plan-visit"
              onChange={(patch) => setDraft((current) => ({ ...current, visit: { ...current.visit, ...patch } }))}
              records={records}
              showClient={false}
              showNextStep={false}
              showSalesperson={false}
              submitted={form.record.status === 'invalid'}
            />
          </div>
        )}
      </form>
    </SidePanel>
  );
};
