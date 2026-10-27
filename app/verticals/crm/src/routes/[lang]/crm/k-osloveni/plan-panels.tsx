import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect } from 'effect';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import { assignableSalespeople } from '../../../../crm/records.ts';
// AREA: visits (C06) — owned by the crm-visits lane. Plan a contact / reschedule it / complete it (+ visit).
import { DetailList, SidePanel, comboboxTranslations, surfaceTileClassName } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
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

/** New planned contact, or rescheduling an open one (`item`). */
export const PlanContactPanel = ({
  busy,
  clientId,
  item,
  onClose,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly clientId?: string;
  readonly item?: PlanItem;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const today = localDay(records.now);
  const [client, setClient] = useState(item?.clientId ?? clientId ?? '');
  const [dueDate, setDueDate] = useState(item?.dueDate ?? shiftDay(today, 7));
  const [note, setNote] = useState(item?.note ?? '');
  const [salespersonId, setSalespersonId] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>();
  const editing = item !== undefined;
  const fixedClient = editing || clientId !== undefined;
  const save = () => {
    setSubmitted(true);
    if (client === '' || !/^\d{4}-\d{2}-\d{2}$/u.test(dueDate)) {
      return;
    }
    let command: CrmCommandInput;
    if (editing) {
      command = { _tag: 'UpdatePlanItem', planItemId: item.id };
      if (dueDate !== item.dueDate) {
        Object.assign(command, { dueDate });
      }
      if (note.trim() !== (item.note ?? '')) {
        Object.assign(command, { note: note.trim() });
      }
    } else {
      command = { _tag: 'PlanContact', clientId: client, dueDate };
      if (note.trim() !== '') {
        Object.assign(command, { note: note.trim() });
      }
      if (records.viewer.writeAll && salespersonId !== '') {
        Object.assign(command, { salespersonId });
      }
    }
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              toaster.create({
                description: `${clientLabel(records, client)} · ${formatDay(dueDate)}`,
                title: editing ? 'Kontakt přeplánován' : 'Kontakt naplánován',
                type: 'success',
              });
              onClose();
            } else {
              setServerError(czechError(outcome.message, 'Uložení se nezdařilo.'));
            }
          }),
        ),
      ),
    );
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} variant="primary">
            {editing ? 'Přeplánovat' : 'Naplánovat'}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description="Ruční plán obchodníka. Systém sám nic neplánuje ani nedoporučuje."
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
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        {fixedClient ? (
          <DetailList items={[{ label: 'Klient', value: clientLabel(records, client) }]} />
        ) : (
          <Combobox
            clearable={false}
            helpText={submitted && client === '' ? 'Vyberte klienta.' : 'Jen klienti, ke kterým smíte zapisovat.'}
            items={writableClients(records).map((entry) => ({ label: entry.name, value: entry.id }))}
            label={t('crm.ciWorkflow.client')}
            noResultsMessage="Žádný klient neodpovídá"
            onChange={(values) => setClient(firstValue(values) ?? '')}
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
          onChange={(event) => setDueDate(event.target.value)}
          required
          size="sm"
          type="date"
          value={dueDate}
        />
        <div className="flex flex-wrap gap-100">
          {quickDays.map((entry) => (
            <Button
              key={entry.days}
              onClick={() => setDueDate(shiftDay(today, entry.days))}
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
          onChange={(event) => setNote(event.target.value)}
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
            onValueChange={(details) => setSalespersonId(details.value[0] ?? '')}
            size="sm"
            value={[salespersonId]}
          />
        )}
      </form>
    </SidePanel>
  );
};

/** Mark a planned contact done; optionally record the visit / call that fulfilled it (C06). */
export const CompletePlanPanel = ({
  busy,
  item,
  onClose,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly item: PlanItem;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [withVisit, setWithVisit] = useState(true);
  const [draft, setDraft] = useState<VisitDraft>(() => ({
    ...emptyVisitDraft(records, item.clientId, 'call'),
    result: '',
  }));
  const [doneNote, setDoneNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>();
  const last = lastVisitOf(records.state.visits.items, item.clientId);
  const save = () => {
    setSubmitted(true);
    const occurredAt = isoFromLocal(draft.date, draft.time);
    if (withVisit && (draft.result.trim() === '' || occurredAt === undefined)) {
      return;
    }
    const command: Extract<CrmCommandInput, { readonly _tag: 'CompletePlanItem' }> = {
      _tag: 'CompletePlanItem',
      planItemId: item.id,
    };
    if (doneNote.trim() !== '') {
      Object.assign(command, { doneNote: doneNote.trim() });
    }
    if (withVisit && occurredAt !== undefined) {
      const visit: NonNullable<typeof command.visit> = { kind: draft.kind, occurredAt, result: draft.result.trim() };
      if (draft.note.trim() !== '') {
        Object.assign(visit, { note: draft.note.trim() });
      }
      Object.assign(command, { visit });
    }
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              toaster.create({
                description: withVisit ? `${visitKindMeta[draft.kind].label} je v historii návštěv.` : undefined,
                title: 'Kontakt vyřízen',
                type: 'success',
              });
              onClose();
            } else {
              setServerError(czechError(outcome.message, 'Uložení se nezdařilo.'));
            }
          }),
        ),
      ),
    );
  };
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} variant="primary">
            Označit jako vyřízené
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description={`${clientLabel(records, item.clientId)} · plánováno na ${formatDay(item.dueDate)}`}
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
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
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
          onChange={(event) => setDoneNote(event.target.value)}
          size="sm"
          value={doneNote}
        />
        <FormCheckbox
          checked={withVisit}
          id="crm-plan-with-visit"
          label={t('crm.ciWorkflow.recordVisit')}
          onCheckedChange={setWithVisit}
          size="sm"
        />
        {withVisit && (
          <div className={`${surfaceTileClassName} flex flex-col gap-200 p-200`}>
            <VisitFields
              draft={draft}
              idPrefix="crm-plan-visit"
              onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
              records={records}
              showClient={false}
              showNextStep={false}
              showSalesperson={false}
              submitted={submitted}
            />
          </div>
        )}
      </form>
    </SidePanel>
  );
};
