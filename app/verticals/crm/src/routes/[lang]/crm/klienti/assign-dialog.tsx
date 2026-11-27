// (Re)assign a client to a salesperson — Správce / Vedoucí only (the reassignment authority
// `demo.crm.client-owner.assign`, enforced by the reducer).
// The reason is stored in the assignment history; past visits keep their author (C00-03).
// Picking and typing change only the draft; the shared Save button ("Uložit", last in the footer) sends AssignClient,
// and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { dialogCloseLabel } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  TextAreaField,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import { assignableSalespeople, salespersonName } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const NONE = 'none';

/**
 * The new owner and the reason, as the dialog edits them. One dialog is open at a time, so the form holds one state;
 * the reason is a textarea, so Enter never sends: only Uložit does.
 */
const assignForm = FormReact.make(
  FormBuilder.empty.addField('reason', Schema.String).addField('target', Schema.String),
  {
    fields: { reason: TextAreaField, target: SelectTemplateField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type AssignDraft = typeof assignForm.schema.Encoded;

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier dialog left, so its values are read only after this.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

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
  // The values the dialog opens with; the form reads them once, when it starts.
  const opened: AssignDraft = { reason: '', target: current };
  const [ready, setReady] = useState(false);
  const draft = Option.getOrElse(
    Option.filter(useAtomValue(assignForm.values), () => ready),
    () => opened,
  );
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
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={assignForm}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        <FormReady onReady={setReady} />
        <assignForm.target
          items={[
            ...assignableSalespeople(records).map((person) => ({
              label: person.id === client.ownerSalespersonId ? `${person.name} (současný)` : person.name,
              value: person.id,
            })),
            { label: 'Bez obchodníka', value: NONE },
          ]}
          label={t('crm.ciClientsVisits.clients.newSalesperson')}
          name="assign-target"
        />
        <assignForm.reason
          id="crm-assign-reason"
          label={reassign ? 'Důvod převodu (povinný)' : 'Poznámka k přidělení'}
          maxLength={4000}
          placeholder={reassign ? 'např. Změna regionu, převzetí po kolegovi' : ''}
          rows={3}
        />
        {reasonMissing && (
          <StatusText showIcon status="error">
            Uveďte důvod převodu, zapíše se do historie klienta.
          </StatusText>
        )}
      </FormRoot>
    </Dialog>
  );
};
