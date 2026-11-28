import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
// Link a CRM client to its canonical identity in Party Registry (CRM.md §3/§4, C04): pick an existing CUSTOMER of
// the company. The CRM server re-reads the chosen Counterparty with the user's own registry rights before it stores
// the PartyRef; nothing is matched silently. Registry records are created by CRM's intake workload, not here.
import { dialogCloseLabel, foldSearchText } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormBuilder, FormReact, FormRoot, SelectTemplateField, useAtomValue } from '@app/core-runtime/ui/form';
import { Effect, Fiber, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client, PartyLinkInput } from '../../../../../shared/domain/clients.ts';
import { loadRegistryCustomers } from '../../../../crm/party-registry.ts';
import type { RegistryCustomer, RegistryFailure } from '../../../../crm/party-registry.ts';

import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

type Directory =
  | { readonly kind: 'loading' }
  | { readonly failure: RegistryFailure; readonly kind: 'failed' }
  | { readonly customers: readonly RegistryCustomer[]; readonly kind: 'ready' };

/** Registry customers that look like this client: same IČO first, then the same name. Only a suggestion. */
export const suggestedCustomer = (client: Client, customers: readonly RegistryCustomer[]) =>
  customers.find(
    (entry) => client.regNo !== undefined && Option.isSome(entry.companyId) && entry.companyId.value === client.regNo,
  ) ?? customers.find((entry) => foldSearchText(entry.displayName) === foldSearchText(client.name));

/** The registry customer picked to link; linking itself is the dialog's command, so the form is never submitted. */
const partyLinkForm = FormReact.make(FormBuilder.empty.addField('target', Schema.String), {
  fields: { target: SelectTemplateField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const partyLinkTarget = partyLinkForm.getFieldAtoms(partyLinkForm.fields.target);

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold the pick of an earlier dialog, so the pick is read only after this.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

export const PartyLinkDialog = ({
  busy,
  client,
  onClose,
  records,
  run,
}: {
  readonly busy: boolean;
  readonly client: Client;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly run: (command: CrmCommandInput, success: string) => Effect.Effect<boolean>;
}) => {
  const { t } = useModernI18n();
  const [directory, setDirectory] = useState<Directory>({ kind: 'loading' });
  const [ready, setReady] = useState(false);
  const picked = Option.getOrElse(useAtomValue(partyLinkTarget.value), () => '');

  useEffect(() => {
    const fiber = browserRuntime.runFork(
      loadRegistryCustomers.pipe(
        Effect.match({
          onFailure: (reason) => setDirectory({ failure: reason, kind: 'failed' }),
          onSuccess: (customers) => setDirectory({ customers, kind: 'ready' }),
        }),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  // A Party already linked to another CRM client is not offered again, unless that client has the same IČO
  // (the same organization entered twice shares its registry identity).
  const taken = new Set(
    records.state.clients.items.flatMap((entry) => {
      if (entry.id === client.id) {
        return [];
      }
      const anotherOrganization =
        (client.regNo ?? '').trim() === '' ||
        (entry.regNo ?? '').replaceAll(/\s+/gu, '') !== (client.regNo ?? '').replaceAll(/\s+/gu, '');
      return anotherOrganization && entry.partyRef?.counterpartyId !== undefined ? [entry.partyRef.counterpartyId] : [];
    }),
  );
  const offered =
    directory.kind === 'ready' ? directory.customers.filter((entry) => !taken.has(entry.link.counterpartyId)) : [];
  const suggestion = suggestedCustomer(client, offered);
  // The suggestion is the pick the dialog opens with; once the form holds it, the form's pick is the one linked.
  const selectedChoice = ready ? picked : (suggestion?.link.counterpartyId ?? '');
  const chosen = offered.find((entry) => entry.link.counterpartyId === selectedChoice);

  const link = (partyRef: PartyLinkInput, name: string) =>
    run({ _tag: 'LinkClientParty', clientId: client.id, partyRef }, `Propojeno s evidencí zákazníků: ${name}`).pipe(
      Effect.tap((ok) =>
        Effect.sync(() => {
          if (ok) {
            onClose();
          }
        }),
      ),
    );

  let suggestionHelp = 'Návrh podle shodného IČO nebo názvu; před propojením ho zkontrolujte. Nic se nepropojí samo.';
  if (suggestion === undefined) {
    suggestionHelp =
      client.kind === 'organization'
        ? 'V registru není zákazník se stejným IČO ani názvem. Firmu založte v Prodej › Zákazníci a pak ji vyberte zde.'
        : 'V registru není zákazník se stejným jménem. Fyzickou osobu založte v Prodej › Zákazníci a pak ji vyberte zde.';
  }
  return (
    <Dialog
      actions={
        <>
          <Button appearance="outline" onClick={onClose} severity="secondary">
            Zrušit
          </Button>
          {/* A command, not a form: linking applies one pick from the registry, with nothing typed to keep. */}
          <Button
            disabled={chosen === undefined}
            icon="icon-[mdi--link-variant]"
            isLoading={busy}
            loadingText="Propojuji…"
            onClick={() => {
              if (chosen !== undefined) {
                browserRuntime.runFork(link(chosen.link, chosen.displayName));
              }
            }}
            severity="primary"
          >
            Propojit vybraného
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description="Identita firmy patří do evidence zákazníků (Prodej › Zákazníci). CRM si ukládá jen ověřený odkaz; kontakty, návštěvy a objednávky zůstávají v CRM."
      onOpenChange={({ open }) => {
        if (!open) {
          onClose();
        }
      }}
      open
      size="md"
      title={`Propojit ${client.name} s evidencí zákazníků`}
    >
      <div className="flex flex-col gap-200">
        {directory.kind === 'loading' && <p className="text-fg-secondary text-sm">Načítám zákazníky z registru…</p>}
        {directory.kind === 'failed' && (
          <StatusText showIcon status={directory.failure === 'forbidden' ? 'warning' : 'error'}>
            {directory.failure === 'forbidden'
              ? 'Seznam zákazníků v evidenci zákazníků vám není přístupný. Propojení provede správce nebo vedoucí obchodu.'
              : 'Evidence zákazníků je dočasně nedostupná. Zkuste to prosím za chvíli.'}
          </StatusText>
        )}
        {directory.kind === 'ready' && (
          <>
            <FormRoot
              defaultValues={{ target: selectedChoice }}
              form={partyLinkForm}
              translateMessage={(message) => t(message, { defaultValue: message })}
            >
              <FormReady onReady={setReady} />
              <partyLinkForm.target
                items={[
                  { label: offered.length === 0 ? 'Žádný volný zákazník v registru' : 'Vyberte zákazníka…', value: '' },
                  ...offered.map((entry) => ({
                    label: `${entry.displayName}${Option.isNone(entry.companyId) ? '' : [' · IČO ', entry.companyId.value].join('')}${
                      entry === suggestion ? ' (shoda)' : ''
                    }`,
                    value: entry.link.counterpartyId,
                  })),
                ]}
                label={t('crm.ciClientsVisits.clients.existingRegistryCustomer')}
                name="party-link-target"
              />
            </FormRoot>
            <p className="text-fg-secondary text-xs">{suggestionHelp}</p>
          </>
        )}
      </div>
    </Dialog>
  );
};
