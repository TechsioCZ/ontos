// AREA: visits (C06) — owned by the crm-visits lane. Plan a contact / reschedule it / complete it (+ visit).
import { DetailList, SidePanel, comboboxTranslations } from '@app/admin-ui';
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
import type { PlanItem } from '../../../../../shared/domain/visits.ts';
import { lastVisitOf } from '../../../../../shared/domain/visits.ts';
import type { Submit, VisitDraft } from '../navstevy/visit-panels.tsx';
import { VisitFields, emptyVisitDraft } from '../navstevy/visit-panels.tsx';
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
    const command = editing
      ? {
          _tag: 'UpdatePlanItem' as const,
          planItemId: item.id,
          ...(dueDate === item.dueDate ? {} : { dueDate }),
          ...(note.trim() === (item.note ?? '') ? {} : { note: note.trim() }),
        }
      : {
          _tag: 'PlanContact' as const,
          clientId: client,
          dueDate,
          ...(note.trim() === '' ? {} : { note: note.trim() }),
          ...(records.viewer.writeAll && salespersonId !== '' ? { salespersonId } : {}),
        };
    void submit(command).then((outcome) => {
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
    });
  };
  const quickDays = [
    { days: 1, label: 'Zítra' },
    { days: 7, label: 'Za týden' },
    { days: 14, label: 'Za 14 dní' },
    { days: 30, label: 'Za měsíc' },
  ];
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
            size="sm"
            clearable={false}
            helpText={submitted && client === '' ? 'Vyberte klienta.' : 'Jen klienti, ke kterým smíte zapisovat.'}
            items={writableClients(records).map((entry) => ({ label: entry.name, value: entry.id }))}
            label="Klient"
            noResultsMessage="Žádný klient neodpovídá"
            onChange={(values) => setClient(firstValue(values) ?? '')}
            placeholder="Vyhledejte klienta"
            required
            translations={comboboxTranslations}
            validateStatus={submitted && client === '' ? 'error' : 'default'}
            value={client === '' ? [] : [client]}
          />
        )}
        <FormInput
          size="sm"
          helpText={`${formatDay(dueDate)} · ${relativeDay(dueDate, today)}`}
          id="crm-plan-due"
          label="Ozvat se dne"
          min={today}
          name="dueDate"
          onChange={(event) => setDueDate(event.target.value)}
          required
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
          size="sm"
          id="crm-plan-note"
          label="Poznámka"
          maxLength={4000}
          name="note"
          onChange={(event) => setNote(event.target.value)}
          placeholder="např. zeptat se na zimní nabídku"
          rows={3}
          value={note}
        />
        {!editing && records.viewer.writeAll && (
          <SelectTemplate
            items={[
              { label: 'Přidělený obchodník klienta', value: '' },
              ...records.state.salespeople
                .filter((person) => person.active)
                .map((person) => ({ label: person.name, value: person.id })),
            ]}
            label="Odpovědný obchodník"
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
    void submit({
      _tag: 'CompletePlanItem',
      planItemId: item.id,
      ...(doneNote.trim() === '' ? {} : { doneNote: doneNote.trim() }),
      ...(withVisit && occurredAt !== undefined
        ? {
            visit: {
              kind: draft.kind,
              occurredAt,
              result: draft.result.trim(),
              ...(draft.note.trim() === '' ? {} : { note: draft.note.trim() }),
            },
          }
        : {}),
    }).then((outcome) => {
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
    });
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
      title="Vyřídit kontakt"
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
          size="sm"
          autoComplete="off"
          id="crm-plan-done-note"
          label="Jak to dopadlo (krátce)"
          name="doneNote"
          onChange={(event) => setDoneNote(event.target.value)}
          value={doneNote}
        />
        <FormCheckbox
          checked={withVisit}
          id="crm-plan-with-visit"
          label="Zároveň zapsat návštěvu / telefonát do historie"
          onCheckedChange={setWithVisit}
          size="sm"
        />
        {withVisit && (
          <div className="flex flex-col gap-200 rounded-md border border-border-primary p-200">
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
