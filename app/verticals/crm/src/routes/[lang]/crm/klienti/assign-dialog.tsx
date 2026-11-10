// (Re)assign a client to a salesperson — Správce / Vedoucí only (the reassignment authority
// `demo.crm.client-owner.assign`, enforced by the reducer).
// The reason is stored in the assignment history; past visits keep their author (C00-03).
// Picking and typing change only the draft; the shared Save button ("Uložit", last in the footer) sends AssignClient,
// and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { dialogCloseLabel } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Option } from 'effect';
import { useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import { assignableSalespeople, salespersonName } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';

const NONE = 'none';

interface AssignDraft {
  readonly reason: string;
  readonly target: string;
}

/** AssignClient for a changed owner; none while the owner is unchanged or a transfer has no reason. */
const assignCommandOf = (client: Client, draft: AssignDraft): Option.Option<CrmCommandInput> => {
  const current = client.ownerSalespersonId ?? NONE;
  const reassign = client.ownerSalespersonId !== undefined;
  if (draft.target === current || (reassign && draft.reason.trim() === '')) {
    return Option.none();
  }
  const command: Extract<CrmCommandInput, { readonly _tag: 'AssignClient' }> = {
    _tag: 'AssignClient',
    clientId: client.id,
  };
  if (draft.target !== NONE) {
    Object.assign(command, { toSalespersonId: draft.target });
  }
  if (draft.reason.trim() !== '') {
    Object.assign(command, { reason: draft.reason.trim() });
  }
  return Option.some(command);
};

export const AssignDialog = ({
  client,
  onClose,
  records,
  submit,
}: {
  readonly client: Client;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const current = client.ownerSalespersonId ?? NONE;
  const [draft, setDraft] = useState<AssignDraft>({ reason: '', target: current });
  const reassign = client.ownerSalespersonId !== undefined;
  const form = useCrmFormSave<AssignDraft>({
    command: (value) => assignCommandOf(client, value),
    failureText: (message) => message ?? 'Akce se nezdařila',
    onSaved: (value) => {
      toaster.create({
        title:
          value.target === NONE
            ? 'Klient je nyní bez obchodníka'
            : `Klient přidělen: ${salespersonName(records, value.target) ?? ''}`,
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
  const reasonMissing =
    form.record.status === 'invalid' && reassign && draft.target !== current && draft.reason.trim() === '';

  return (
    <Dialog
      actions={<CrmFormSaveActions form={form} onCancel={onClose} />}
      closeLabel={dialogCloseLabel}
      customTrigger
      description={`Nyní: ${salespersonName(records, client.ownerSalespersonId) ?? 'bez obchodníka'}. Nový obchodník uvidí klienta i celou jeho historii; návštěvy zapsané dosavadním obchodníkem zůstanou s původním autorem.`}
      onOpenChange={({ open }) => {
        if (!open) {
          form.guard.request(onClose);
        }
      }}
      open
      size="md"
      title={reassign ? `Převést klienta ${client.name}` : `Přidělit klienta ${client.name}`}
    >
      <div className="flex flex-col gap-200">
        <SelectTemplate
          items={[
            ...assignableSalespeople(records).map((person) => ({
              label: person.id === client.ownerSalespersonId ? `${person.name} (současný)` : person.name,
              value: person.id,
            })),
            { label: 'Bez obchodníka', value: NONE },
          ]}
          label={t('crm.ciClientsVisits.clients.newSalesperson')}
          name="assign-target"
          onValueChange={(details) => setDraft((value) => ({ ...value, target: details.value[0] ?? current }))}
          value={[draft.target]}
        />
        <FormTextarea
          id="crm-assign-reason"
          label={reassign ? 'Důvod převodu (povinný)' : 'Poznámka k přidělení'}
          maxLength={4000}
          onChange={(event) => setDraft((value) => ({ ...value, reason: event.target.value }))}
          placeholder={reassign ? 'např. Změna regionu, převzetí po kolegovi' : ''}
          rows={3}
          value={draft.reason}
        />
        {reasonMissing && (
          <StatusText showIcon status="error">
            Uveďte důvod převodu, zapíše se do historie klienta.
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};
