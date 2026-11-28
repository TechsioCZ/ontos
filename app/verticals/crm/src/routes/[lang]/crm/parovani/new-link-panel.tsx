// AREA: imports — owned by the crm-imports lane. A new approved link of a source customer ID to a CRM client (C04).
// Picking changes only the draft; the shared Save button ("Uložit", last in the footer) sends one
// LinkExternalCustomer command, and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { SidePanel } from '@app/admin-ui';
import { readableName } from '@app/admin-ui/visible-text';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import { clientOptions } from '../../../../crm/option-labels.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { RESIZE_LABEL, orderTitle, sourcesOf } from '../importy/order-model.ts';

/** One option per source customer, labelled with what the source says about it, never with its source key. */
const sourceCustomerOptions = (records: RecordsResponse, source: string) => [
  ...new Map(
    records.state.imports.orders.flatMap((order) =>
      order.source !== source || order.externalCustomerId === undefined
        ? []
        : [
            [
              order.externalCustomerId,
              {
                label:
                  [order.customerName, order.customerRegNo, order.customerEmail]
                    .map(readableName)
                    .filter((part) => part !== undefined)
                    .join(' · ') || orderTitle(order),
                value: order.externalCustomerId,
              },
            ] as const,
          ],
    ),
  ).values(),
];

/**
 * The source, its customer and the CRM client of the new link, as the panel edits them. One panel is open at a time,
 * so the form holds one state; it has only pickers, so Enter never sends: only Uložit does.
 */
const linkForm = FormReact.make(
  FormBuilder.empty
    .addField('clientId', Schema.String)
    .addField('externalCustomerId', Schema.String)
    .addField('source', Schema.String),
  {
    fields: { clientId: SelectTemplateField, externalCustomerId: SelectTemplateField, source: SelectTemplateField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type LinkDraft = typeof linkForm.schema.Encoded;

const customerField = linkForm.getFieldAtoms(linkForm.fields.externalCustomerId);
/**
 * The picked source as a plain string. It changes only when the source does: the field's own value atom reports every
 * change of the form, so clearing the customer on it would clear again forever.
 */
const pickedSource = linkForm.getFieldAtoms(linkForm.fields.source).value.pipe(Atom.map(Option.getOrElse(() => '')));

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier panel left, so its values are read only after this.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

const linkCommandOf = (draft: LinkDraft): Option.Option<CrmCommandInput> =>
  draft.clientId === '' || draft.externalCustomerId.trim() === ''
    ? Option.none()
    : Option.some({
        _tag: 'LinkExternalCustomer',
        clientId: draft.clientId,
        externalCustomerId: draft.externalCustomerId.trim(),
        source: draft.source,
      });

export const NewLinkPanel = ({
  onClose,
  records,
  submit,
}: {
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const sources = sourcesOf(records.state.imports.orders);
  // The values the panel opens with; the form reads them once, when it starts.
  const opened: LinkDraft = { clientId: '', externalCustomerId: '', source: sources[0] ?? 'E-shop' };
  const [ready, setReady] = useState(false);
  const draft = Option.getOrElse(
    Option.filter(useAtomValue(linkForm.values), () => ready),
    () => opened,
  );
  const { externalCustomerId, source } = draft;
  const setCustomer = useAtomSet(customerField.setValue);
  // A customer belongs to one source: picking another source drops it.
  useAtomSubscribe(pickedSource, () => setCustomer(''), { immediate: false });
  const form = useCrmFormSave<LinkDraft>({
    command: linkCommandOf,
    failureText: (message) => message ?? 'Uložení se nezdařilo',
    onSaved: (_value, entityIds) => {
      toaster.create({
        description:
          entityIds.length > 1 ? `Napárováno čekajících objednávek: ${String(entityIds.length - 1)}` : undefined,
        title: 'Vazba schválena',
        type: 'success',
      });
      onClose();
    },
    submit,
    value: draft,
  });
  const waiting = records.state.imports.orders.filter(
    (order) =>
      order.pairing !== 'paired' && order.source === source && order.externalCustomerId === externalCustomerId.trim(),
  ).length;
  return (
    <SidePanel
      actions={<CrmFormSaveActions form={form} onCancel={onClose} />}
      description="Vyberte zákazníka ze zdroje a odpovídajícího klienta CRM. Jeho další objednávky se pak přiřadí samy."
      guard={form.guard}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="md"
      title={t('crm.ciWorkflow.newApprovedLink')}
    >
      <FormRoot
        className="flex flex-col gap-150"
        defaultValues={opened}
        form={linkForm}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        <FormReady onReady={setReady} />
        <linkForm.source
          items={(sources.length === 0 ? ['E-shop', 'Účetní systém'] : sources).map((entry) => ({
            label: entry,
            value: entry,
          }))}
          label={t('crm.ciWorkflow.sourceSystem')}
          name="link-source"
          size="sm"
        />
        <linkForm.externalCustomerId
          items={sourceCustomerOptions(records, source)}
          label={t('crm.ciWorkflow.sourceCustomerId')}
          name="externalCustomerId"
          size="sm"
        />
        <linkForm.clientId
          items={clientOptions(records.state.clients.items.filter((client) => client.status === 'active'))}
          label={t('crm.ciWorkflow.crmClient')}
          name="link-client"
          placeholder={t('crm.ciWorkflow.selectClient')}
          size="sm"
        />
        {waiting > 0 && (
          <span className="text-sm">{`Na tuto vazbu čeká ${String(waiting)} nenapárovaných objednávek – po schválení se přiřadí.`}</span>
        )}
      </FormRoot>
    </SidePanel>
  );
};
