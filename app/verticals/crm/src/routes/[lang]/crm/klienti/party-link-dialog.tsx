// Link a CRM client to its canonical identity in Party Registry (CRM.md §3/§4, C04): pick an existing CUSTOMER of
// the company, or create the Party + CUSTOMER role from the client's facts. The CRM server re-reads the chosen
// Counterparty with the user's own registry rights before it stores the PartyRef; nothing is matched silently.
import { dialogCloseLabel, foldSearchText } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Effect } from 'effect';
import { useEffect, useMemo, useState } from 'react';
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import type { RegistryCustomer, RegistryFailure } from '../../../../crm/party-registry.ts';
import {
  loadRegistryCustomers,
  registerClientInRegistry,
  registryFailureMessage,
} from '../../../../crm/party-registry.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

type Directory =
  | { readonly kind: 'loading' }
  | { readonly failure: RegistryFailure; readonly kind: 'failed' }
  | { readonly customers: readonly RegistryCustomer[]; readonly kind: 'ready' };

/** Registry customers that look like this client: same IČO first, then the same name. Only a suggestion. */
export const suggestedCustomer = (client: Client, customers: readonly RegistryCustomer[]) =>
  customers.find((entry) => client.regNo !== undefined && entry.companyId === client.regNo) ??
  customers.find((entry) => foldSearchText(entry.displayName) === foldSearchText(client.name));

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
  readonly run: (command: CrmCommand, success: string) => Promise<boolean>;
}) => {
  const [directory, setDirectory] = useState<Directory>({ kind: 'loading' });
  const [choice, setChoice] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    void browserRuntime.runPromise(
      loadRegistryCustomers.pipe(
        Effect.match({
          onFailure: (reason) => setDirectory({ failure: reason, kind: 'failed' }),
          onSuccess: (customers) => setDirectory({ customers, kind: 'ready' }),
        }),
      ),
    );
  }, []);

  // A Party already linked to another CRM client is not offered again, unless that client has the same IČO
  // (the same organization entered twice shares its registry identity).
  const taken = useMemo(
    () =>
      new Set(
        records.state.clients.items
          .filter(
            (entry) =>
              entry.id !== client.id &&
              ((client.regNo ?? '').trim() === '' ||
                (entry.regNo ?? '').replaceAll(/\s+/gu, '') !== (client.regNo ?? '').replaceAll(/\s+/gu, '')),
          )
          .flatMap((entry) => (entry.partyRef?.counterpartyId === undefined ? [] : [entry.partyRef.counterpartyId])),
      ),
    [client.id, records],
  );
  const offered =
    directory.kind === 'ready' ? directory.customers.filter((entry) => !taken.has(entry.link.counterpartyId)) : [];
  const suggestion = suggestedCustomer(client, offered);
  useEffect(() => {
    if (choice === '' && suggestion !== undefined) {
      setChoice(suggestion.link.counterpartyId);
    }
  }, [choice, suggestion]);
  const chosen = offered.find((entry) => entry.link.counterpartyId === choice);

  const link = (partyRef: { readonly counterpartyId: string; readonly partyId: string }, name: string) =>
    run({ _tag: 'LinkClientParty', clientId: client.id, partyRef }, `Propojeno s evidencí zákazníků: ${name}`).then(
      (ok) => {
        if (ok) {
          onClose();
        }
      },
    );

  const createInRegistry = () => {
    setFailure(undefined);
    setCreating(true);
    void browserRuntime
      .runPromise(
        registerClientInRegistry(client).pipe(
          Effect.match({
            onFailure: (reason) => ({ failure: reason, ok: false as const }),
            onSuccess: (created) => ({ created, ok: true as const }),
          }),
        ),
      )
      .then((outcome) => {
        setCreating(false);
        if (!outcome.ok) {
          setFailure(registryFailureMessage[outcome.failure]);
          return;
        }
        void link(outcome.created.link, client.name);
      });
  };

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
              onClick={createInRegistry}
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
                void link(chosen.link, chosen.displayName);
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
                  label: `${entry.displayName}${entry.companyId === undefined ? '' : ` · IČO ${entry.companyId}`}${
                    entry === suggestion ? ' (shoda)' : ''
                  }`,
                  value: entry.link.counterpartyId,
                })),
              ]}
              label="Existující zákazník v evidenci zákazníků"
              name="party-link-target"
              onValueChange={(details) => setChoice(details.value[0] ?? '')}
              value={[choice]}
            />
            <p className="text-fg-secondary text-xs">
              {suggestion === undefined
                ? client.kind === 'organization'
                  ? 'V registru není zákazník se stejným IČO ani názvem. Firmu můžete v registru založit z údajů karty.'
                  : 'V registru není zákazník se stejným jménem. Fyzickou osobu založte v Prodej › Zákazníci a pak ji vyberte zde.'
                : 'Návrh podle shodného IČO nebo názvu; před propojením ho zkontrolujte. Nic se nepropojí samo.'}
            </p>
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
