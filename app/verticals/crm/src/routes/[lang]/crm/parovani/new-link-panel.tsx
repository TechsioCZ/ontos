// AREA: imports — owned by the crm-imports lane. A new approved link of a source customer ID to a CRM client (C04).
// Picking changes only the draft; the shared Save button ("Uložit", last in the footer) sends one
// LinkExternalCustomer command, and leaving with unsaved input asks Uložit / Zahodit změny / Zůstat.
import { SidePanel } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { readableName } from '@app/admin-ui/visible-text';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Option } from 'effect';
import { useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { CrmFormSaveActions, useCrmFormSave } from '../../../../crm/form-save.tsx';
import { clientOptions } from '../../../../crm/option-labels.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
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

interface LinkDraft {
  readonly clientId: string;
  readonly externalCustomerId: string;
  readonly source: string;
}

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
  const [draft, setDraft] = useState<LinkDraft>(() => ({
    clientId: '',
    externalCustomerId: '',
    source: sources[0] ?? 'E-shop',
  }));
  const { clientId, externalCustomerId, source } = draft;
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
      {/* Enter never sends the link: only Uložit does. */}
      <form className="flex flex-col gap-150" onSubmit={(event) => event.preventDefault()}>
        <SelectTemplate
          items={(sources.length === 0 ? ['E-shop', 'Účetní systém'] : sources).map((entry) => ({
            label: entry,
            value: entry,
          }))}
          label={t('crm.ciWorkflow.sourceSystem')}
          name="link-source"
          onValueChange={(details) =>
            setDraft((current) => ({ ...current, externalCustomerId: '', source: details.value[0] ?? current.source }))
          }
          size="sm"
          value={[source]}
        />
        <SelectTemplate
          items={sourceCustomerOptions(records, source)}
          label={t('crm.ciWorkflow.sourceCustomerId')}
          name="externalCustomerId"
          onValueChange={(details) =>
            setDraft((current) => ({ ...current, externalCustomerId: details.value[0] ?? '' }))
          }
          size="sm"
          value={externalCustomerId === '' ? [] : [externalCustomerId]}
        />
        <SelectTemplate
          items={clientOptions(records.state.clients.items.filter((client) => client.status === 'active'))}
          label={t('crm.ciWorkflow.crmClient')}
          name="link-client"
          onValueChange={(details) => setDraft((current) => ({ ...current, clientId: details.value[0] ?? '' }))}
          placeholder={t('crm.ciWorkflow.selectClient')}
          size="sm"
          value={clientId === '' ? [] : [clientId]}
        />
        {waiting > 0 && (
          <span className="text-sm">{`Na tuto vazbu čeká ${String(waiting)} nenapárovaných objednávek – po schválení se přiřadí.`}</span>
        )}
      </form>
    </SidePanel>
  );
};
