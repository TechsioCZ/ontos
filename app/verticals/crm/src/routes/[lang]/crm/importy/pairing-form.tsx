// Manual pairing / re-pairing of one imported order with a reason (C04-03). Candidates are suggestions only.
// Picking and typing change only the draft; the shared Save button ("Uložit", last in the footer) sends one
// PairOrder command, and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { requiredLabelFor } from '@app/admin-ui';
import {
  CheckboxField,
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextAreaField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Schema } from 'effect';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { ImportedOrder } from '../../../../../shared/domain/imports.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import type { CrmFormSave } from '../../../../crm/form-save.tsx';
import { salespersonName } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { NOT_PROVIDED, clientLabel, orderTitle } from './order-model.ts';

/** A pairing as typed. */
export interface PairingDraft {
  /** Approve the source customer link with the pairing. */
  readonly approve: boolean;
  /** The target client; `""` until picked. */
  readonly clientId: string;
  readonly reason: string;
}

/** Enter never sends a pairing: only Uložit does. */
const makePairingForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('approve', Schema.Boolean)
      .addField('clientId', Schema.String)
      .addField('reason', Schema.String),
    {
      fields: { approve: CheckboxField, clientId: ChoiceField, reason: TextAreaField },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  );

/** Where a pairing form is: the pairing side panel, or inline in an order's detail. Both can be on screen at once. */
const PairingPlaceSchema = Schema.Literals(['inline', 'panel']);
type PairingPlace = typeof PairingPlaceSchema.Type;
const pairingForms = { inline: makePairingForm(), panel: makePairingForm() };
type PairingInstance = (typeof pairingForms)['panel'];

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
  /** The values the form opens with. */
  readonly opened: PairingDraft;
  /** Which pairing form the fields render. */
  readonly place: PairingPlace;
}

interface PairingOptions {
  readonly onSaved: () => void;
  readonly order: ImportedOrder;
  readonly submit: CrmCommandSubmit;
}

const usePairing = (place: PairingPlace, { onSaved, order, submit }: PairingOptions): PairingFormState => {
  const toaster = useToast();
  const instance = pairingForms[place];
  const opened: PairingDraft = { approve: false, clientId: order.candidates?.[0]?.clientId ?? '', reason: '' };
  const draft = Option.getOrElse(useAtomValue(instance.values), () => opened);
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
  return { draft, form, opened, place };
};

/** Draft and save of the pairing of `order` in its side panel; `onSaved` runs after the toast of a successful save. */
export const usePairingForm = (options: PairingOptions): PairingFormState => usePairing('panel', options);

const CandidateChoices = ({
  instance,
  order,
  picked,
  records,
}: {
  readonly instance: PairingInstance;
  readonly order: ImportedOrder;
  readonly picked: string;
  readonly records: RecordsResponse;
}) => {
  const pick = useAtomSet(instance.getFieldAtoms(instance.fields.clientId).setValue);
  const candidates = order.candidates ?? [];
  return candidates.length === 0 ? null : (
    <div className="flex flex-col gap-100 rounded-lg bg-bg-light-warning-base p-150">
      <span className="font-medium text-sm">Možní kandidáti – nepotvrzeno</span>
      <span className="text-fg-secondary text-xs">
        Shoda IČO, e-mailu nebo názvu není důkaz identity. Systém je sám nepřiřadí; vyberte klienta až po ověření.
      </span>
      <div className="flex flex-wrap gap-100">
        {candidates.map((candidate) => (
          <button
            className={`flex flex-col items-start gap-50 rounded-lg border px-150 py-100 text-left text-sm ${picked === candidate.clientId ? 'border-primary bg-surface' : 'border-border-primary bg-base'}`}
            key={candidate.clientId}
            onClick={() => pick(candidate.clientId)}
            type="button"
          >
            <span className="flex items-center gap-50 font-medium">
              {picked === candidate.clientId && (
                <span aria-hidden="true" className="icon-[mdi--check-circle] size-200 text-success" />
              )}
              {clientLabel(records, candidate.clientId) ?? NOT_PROVIDED}
            </span>
            <span className="text-fg-secondary text-xs">{candidate.reason}</span>
          </button>
        ))}
      </div>
    </div>
  );
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
  const { language, t } = useModernI18n();
  const { draft, opened, place } = state;
  const instance = pairingForms[place];
  const linkExists =
    order.externalCustomerId !== undefined &&
    records.state.imports.customerLinks.some(
      (link) => link.source === order.source && link.externalCustomerId === order.externalCustomerId,
    );
  const clients = records.state.clients.items
    .filter((client) => client.status === 'active' && client.id !== order.clientId)
    .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'));
  return (
    <FormRoot
      className="flex flex-col gap-150"
      defaultValues={opened}
      form={instance}
      translateMessage={(message) => t(message, { defaultValue: message })}
    >
      <CandidateChoices instance={instance} order={order} picked={draft.clientId} records={records} />
      <instance.clientId
        items={clients.map((client) => ({
          label: `${client.name} · ${salespersonName(records, client.ownerSalespersonId) ?? 'nepřiděleno'}`,
          value: client.id,
        }))}
        label={t('crm.ciWorkflow.targetClient')}
        placeholder={t('crm.ciWorkflow.selectClient')}
      />
      <instance.reason
        autoComplete="off"
        id={`pairing-reason-${order.id}`}
        label={t('crm.ciWorkflow.pairingReason')}
        maxLength={2000}
        required
        requiredLabel={requiredLabelFor(language)}
        rows={2}
        size="sm"
      />
      {order.externalCustomerId !== undefined && !linkExists && (
        <instance.approve
          id={`pairing-approve-${order.id}`}
          label={`Schválit vazbu: ${order.customerName ?? orderTitle(order)} (${order.source}) patří tomuto klientovi – další objednávky se napárují samy`}
        />
      )}
    </FormRoot>
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
  const state = usePairing('inline', { onSaved, order, submit });
  return (
    <div className="flex flex-col gap-150" data-testid={`crm-pairing-form-${order.id}`}>
      <PairingFields order={order} records={records} state={state} />
      <div className="flex flex-wrap items-center justify-end gap-100">
        <CrmFormSaveActions form={state.form} onCancel={onCancel} />
      </div>
    </div>
  );
};
