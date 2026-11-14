// Manual pairing / re-pairing of one imported order with a reason (C04-03). Candidates are suggestions only.
// Picking and typing change only the draft; the shared Save button ("Uložit", last in the footer) sends one
// PairOrder command, and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormTextarea } from '@app/admin-ui/form-controls';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Option } from 'effect';
import { useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { ImportedOrder } from '../../../../../shared/domain/imports.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import type { CrmFormSave } from '../../../../crm/form-save.tsx';
import { salespersonName } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { NOT_PROVIDED, clientLabel, orderTitle } from './order-model.ts';

export interface PairingDraft {
  readonly approve: boolean;
  readonly clientId: string;
  readonly reason: string;
}

/** PairOrder of a complete draft; none while no client is chosen or the reason is shorter than three characters. */
export const pairingCommandOf = (order: ImportedOrder, draft: PairingDraft): Option.Option<CrmCommandInput> => {
  if (draft.clientId === '' || draft.reason.trim().length < 3) {
    return Option.none();
  }
  const command: Extract<CrmCommandInput, { readonly _tag: 'PairOrder' }> = {
    _tag: 'PairOrder',
    clientId: draft.clientId,
    orderId: order.id,
    reason: draft.reason.trim(),
  };
  if (draft.approve) {
    Object.assign(command, { approveCustomerLink: true });
  }
  return Option.some(command);
};

export interface PairingFormState {
  readonly draft: PairingDraft;
  readonly form: CrmFormSave<PairingDraft>;
  readonly patch: (next: Partial<PairingDraft>) => void;
}

/** Draft and save of the pairing of `order`; `onSaved` runs after the toast of a successful save. */
export const usePairingForm = ({
  onSaved,
  order,
  submit,
}: {
  readonly onSaved: () => void;
  readonly order: ImportedOrder;
  readonly submit: CrmCommandSubmit;
}): PairingFormState => {
  const toaster = useToast();
  const [draft, setDraft] = useState<PairingDraft>(() => ({
    approve: false,
    clientId: order.candidates?.[0]?.clientId ?? '',
    reason: '',
  }));
  const form = useCrmFormSave<PairingDraft>({
    command: (value) => pairingCommandOf(order, value),
    failureText: (message) => message ?? 'Uložení se nezdařilo',
    onSaved: () => {
      toaster.create({
        title: order.clientId === undefined ? 'Objednávka napárována' : 'Přiřazení opraveno',
        type: 'success',
      });
      onSaved();
    },
    submit,
    value: draft,
  });
  return { draft, form, patch: (next) => setDraft((current) => ({ ...current, ...next })) };
};

/** The fields of the pairing form. Enter never sends it: only Uložit does. */
export const PairingFields = ({
  order,
  records,
  state,
}: {
  readonly order: ImportedOrder;
  readonly records: RecordsResponse;
  readonly state: PairingFormState;
}) => {
  const { t } = useModernI18n();
  const { draft, patch } = state;
  const linkExists =
    order.externalCustomerId !== undefined &&
    records.state.imports.customerLinks.some(
      (link) => link.source === order.source && link.externalCustomerId === order.externalCustomerId,
    );
  const clients = records.state.clients.items
    .filter((client) => client.status === 'active' && client.id !== order.clientId)
    .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'));
  const candidates = order.candidates ?? [];
  return (
    <form className="flex flex-col gap-150" onSubmit={(event) => event.preventDefault()}>
      {candidates.length > 0 && (
        <div className="flex flex-col gap-100 rounded-lg bg-bg-light-warning-base p-150">
          <span className="font-medium text-sm">Možní kandidáti – nepotvrzeno</span>
          <span className="text-fg-secondary text-xs">
            Shoda IČO, e-mailu nebo názvu není důkaz identity. Systém je sám nepřiřadí; vyberte klienta až po ověření.
          </span>
          <div className="flex flex-wrap gap-100">
            {candidates.map((candidate) => (
              <button
                className={`flex flex-col items-start gap-50 rounded-lg border px-150 py-100 text-left text-sm ${draft.clientId === candidate.clientId ? 'border-primary bg-surface' : 'border-border-primary bg-base'}`}
                key={candidate.clientId}
                onClick={() => patch({ clientId: candidate.clientId })}
                type="button"
              >
                <span className="flex items-center gap-50 font-medium">
                  {draft.clientId === candidate.clientId && (
                    <span aria-hidden="true" className="icon-[mdi--check-circle] size-200 text-success" />
                  )}
                  {clientLabel(records, candidate.clientId) ?? NOT_PROVIDED}
                </span>
                <span className="text-fg-secondary text-xs">{candidate.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <SelectTemplate
        items={clients.map((client) => ({
          label: `${client.name} · ${salespersonName(records, client.ownerSalespersonId) ?? 'nepřiděleno'}`,
          value: client.id,
        }))}
        label={t('crm.ciWorkflow.targetClient')}
        name="pairing-client"
        onValueChange={(details) => patch({ clientId: details.value[0] ?? '' })}
        placeholder={t('crm.ciWorkflow.selectClient')}
        size="sm"
        value={draft.clientId === '' ? [] : [draft.clientId]}
      />
      <FormTextarea
        autoComplete="off"
        id={`pairing-reason-${order.id}`}
        label={t('crm.ciWorkflow.pairingReason')}
        maxLength={2000}
        onChange={(event) => patch({ reason: event.target.value })}
        required
        rows={2}
        size="sm"
        value={draft.reason}
      />
      {order.externalCustomerId !== undefined && !linkExists && (
        <FormCheckbox
          checked={draft.approve}
          id={`pairing-approve-${order.id}`}
          label={`Schválit vazbu: ${order.customerName ?? orderTitle(order)} (${order.source}) patří tomuto klientovi – další objednávky se napárují samy`}
          onCheckedChange={(checked) => patch({ approve: checked })}
          size="sm"
        />
      )}
    </form>
  );
};

/** The pairing form inline in another panel, with its own Zrušit and Uložit. */
export const PairingForm = ({
  onCancel,
  onSaved,
  order,
  records,
  submit,
}: {
  /** Zrušit, through the unsaved-changes guard. */
  readonly onCancel: () => void;
  /** The order was paired; the toast is shown already. */
  readonly onSaved: () => void;
  readonly order: ImportedOrder;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}) => {
  const state = usePairingForm({ onSaved, order, submit });
  return (
    <div className="flex flex-col gap-150" data-testid={`crm-pairing-form-${order.id}`}>
      <PairingFields order={order} records={records} state={state} />
      <div className="flex flex-wrap items-center justify-end gap-100">
        <CrmFormSaveActions form={state.form} onCancel={onCancel} />
      </div>
    </div>
  );
};
