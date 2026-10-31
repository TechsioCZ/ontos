import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
// Link a CRM client to its canonical identity in Party Registry (CRM.md §3/§4, C04): pick an existing CUSTOMER of
// the company, or create the Party + CUSTOMER role from the client's facts. The CRM server re-reads the chosen
// Counterparty with the user's own registry rights before it stores the PartyRef; nothing is matched silently.
import { dialogCloseLabel, foldSearchText } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Effect, Fiber, Option } from 'effect';
import { useEffect, useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client, PartyLinkInput } from '../../../../../shared/domain/clients.ts';
import {
  loadRegistryCustomers,
  registerClientInRegistry,
  registryFailureMessage,
} from '../../../../crm/party-registry.ts';
import type { RegistryCustomer, RegistryFailure } from '../../../../crm/party-registry.ts';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

type Directory =
  | { readonly kind: 'loading' }
  | { readonly failure: RegistryFailure; readonly kind: 'failed' }
  | { readonly customers: readonly RegistryCustomer[]; readonly kind: 'ready' };

/** Registry customers that look like this client: same IČO first, then the same name. Only a suggestion. */
export const suggestedCustomer = (client: Client, customers: readonly RegistryCustomer[]) =>
  customers.find(
    (entry) => client.regNo !== undefined && Option.isSome(entry.companyId) && entry.companyId.value === client.regNo,
  ) ?? customers.find((entry) => foldSearchText(entry.displayName) === foldSearchText(client.name));

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
  const [choice, setChoice] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

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
  const selectedChoice = choice === '' ? (suggestion?.link.counterpartyId ?? '') : choice;
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

  const createInRegistry = Effect.suspend(() => {
    setFailure(undefined);
    setCreating(true);
    return registerClientInRegistry(client).pipe(
      Effect.matchEffect({
        onFailure: (reason) =>
          Effect.sync(() => {
            setCreating(false);
            setFailure(registryFailureMessage[reason]);
          }),
        onSuccess: (created) =>
          Effect.sync(() => setCreating(false)).pipe(Effect.andThen(link(created.link, client.name)), Effect.asVoid),
      }),
    );
  });

  let suggestionHelp = 'Návrh podle shodného IČO nebo názvu; před propojením ho zkontrolujte. Nic se nepropojí samo.';
  if (suggestion === undefined) {
    suggestionHelp =
      client.kind === 'organization'
        ? 'V registru není zákazník se stejným IČO ani názvem. Firmu můžete v registru založit z údajů karty.'
        : 'V registru není zákazník se stejným jménem. Fyzickou osobu založte v Prodej › Zákazníci a pak ji vyberte zde.';
  }
  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          {client.kind === 'organization' && (
            <Button
              disabled={creating || busy}
              icon="icon-[mdi--database-plus-outline]"
              isLoading={creating}
              loadingText="Zakládám v registru…"
              onClick={() => {
                browserRuntime.runFork(createInRegistry);
              }}
              theme="outlined"
              variant="secondary"
            >
              Založit v evidenci zákazníků
            </Button>
          )}
          <Button
            disabled={chosen === undefined || creating}
            icon="icon-[mdi--link-variant]"
            isLoading={busy && !creating}
            loadingText="Propojuji…"
            onClick={() => {
              if (chosen !== undefined) {
                browserRuntime.runFork(link(chosen.link, chosen.displayName));
              }
            }}
            variant="primary"
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
              : registryFailureMessage[directory.failure]}
          </StatusText>
        )}
        {directory.kind === 'ready' && (
          <>
            <SelectTemplate
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
              onValueChange={(details) => setChoice(details.value[0] ?? '')}
              value={[selectedChoice]}
            />
            <p className="text-fg-secondary text-xs">{suggestionHelp}</p>
          </>
        )}
        {failure !== undefined && (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};
