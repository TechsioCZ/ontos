// Client card (C01/C02/C04/C05 facts) in a SidePanel over the clients list. Header with key facts and the owner,
// then tabs Kontakty / Návštěvy / Objednávky / Historie. Návštěvy and Objednávky are rendered by the visits and
// imports lanes through the ClientCardTabProps contract (./card-tab-props.ts).
import { EmptyState, SidePanel, dialogCloseLabel, formatDate, formatNumber } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canWriteClient } from '../../../../../shared/domain/access.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import { clientSalesFacts } from '../../../../../shared/domain/reports.ts';
import type { CrmCommandOutcome } from '../../../../crm/records.ts';
import { salespersonName } from '../../../../crm/records.ts';
import { formatDecimalMoney } from '../prehled-prodeju/report-format.ts';
import { ClientOrdersTab } from '../importy/client-orders-tab.tsx';
import { ClientVisitsTab } from '../navstevy/client-visits-tab.tsx';
import { AssignDialog } from './assign-dialog.tsx';
import { ClientFormDialog } from './client-form-dialog.tsx';
import { activeContactsOf, kindLabels, segmentLabel } from './clients-model.ts';
import { ContactsTab } from './contacts-tab.tsx';
import { HistoryTab } from './history-tab.tsx';
import { SalespersonChip } from './salesperson-chip.tsx';

interface CardProps {
  readonly busy: boolean;
  readonly clientId: string;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}

const Fact = ({
  children,
  icon,
  label,
}: {
  readonly children: ReactNode;
  readonly icon: string;
  readonly label: string;
}) => (
  <div className="flex min-w-0 items-start gap-100">
    <span aria-hidden className={`${icon} mt-50 size-4 shrink-0 text-fg-secondary`} />
    <div className="flex min-w-0 flex-col">
      <dt className="text-fg-secondary text-xs">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  </div>
);

const Missing = ({ children = 'údaj neposkytnut' }: { readonly children?: ReactNode }) => (
  <span className="text-fg-secondary">{children}</span>
);

const NotVisible = ({ onClose }: { readonly onClose: () => void }) => (
  <SidePanel
    actions={
      <Button onClick={onClose} theme="outlined" variant="secondary">
        Zavřít
      </Button>
    }
    closeLabel={dialogCloseLabel}
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
    open
    resizeLabel="Změnit šířku panelu"
    size="md"
    title="Klient nenalezen"
  >
    <EmptyState
      description="Klient neexistuje nebo k němu nemáte přístup. Obchodník vidí jen klienty, které má přidělené."
      title="Kartu nelze otevřít"
    />
  </SidePanel>
);

const CardBody = ({
  busy,
  client,
  onClose,
  records,
  submit,
}: Omit<CardProps, 'clientId'> & { readonly client: Client }) => {
  const toaster = useToast();
  const [tab, setTab] = useState('contacts');
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const writable = canWriteClient(records.viewer, client);
  const archived = client.status === 'archived';
  const contacts = activeContactsOf(records, client.id);
  const visitCount = records.state.visits.items.filter((visit) => visit.clientId === client.id).length;
  const facts = clientSalesFacts(records.state, client.id);
  const owner = salespersonName(records, client.ownerSalespersonId);
  const segment = segmentLabel(client.segment);

  if (editing) {
    return (
      <ClientFormDialog
        busy={busy}
        client={client}
        mode="edit"
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
        records={records}
        submit={submit}
      />
    );
  }

  const run = (command: CrmCommand, success: string) =>
    submit(command).then((outcome) => {
      toaster.create(
        outcome.ok
          ? { title: success, type: 'success' }
          : { description: outcome.message, title: 'Akce se nezdařila', type: 'error' },
      );
      return outcome.ok;
    });

  const tabProps = { busy, client, records, submit };

  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          Zavřít
        </Button>
      }
      closeLabel={dialogCloseLabel}
      description={
        <span className="flex flex-wrap items-center gap-100">
          <Badge size="sm" variant="outline">
            {kindLabels[client.kind]}
          </Badge>
          {segment !== undefined && (
            <Badge size="sm" variant="info">
              {segment}
            </Badge>
          )}
          {archived ? (
            <Badge size="sm" variant="warning">
              {`Archivován ${formatDate(client.archivedAt)}`}
            </Badge>
          ) : (
            <Badge size="sm" variant="success">
              Aktivní
            </Badge>
          )}
          {!writable && (
            <Badge size="sm" variant="secondary">
              Jen pro čtení
            </Badge>
          )}
        </span>
      }
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel="Změnit šířku panelu"
      size="xl"
      title={client.name}
    >
      <div className="flex flex-col gap-250 py-100">
        <div className="flex flex-wrap gap-100">
          {writable && !archived && (
            <Button
              icon="icon-[mdi--pencil-outline]"
              onClick={() => setEditing(true)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Upravit údaje
            </Button>
          )}
          {records.viewer.assign && (
            <Button
              icon="icon-[mdi--account-switch-outline]"
              onClick={() => setAssigning(true)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {owner === undefined ? 'Přidělit obchodníkovi' : 'Změnit obchodníka'}
            </Button>
          )}
          {writable &&
            (archived ? (
              <Button
                icon="icon-[mdi--archive-arrow-up-outline]"
                isLoading={busy}
                onClick={() => void run({ _tag: 'RestoreClient', id: client.id }, 'Klient obnoven z archivu')}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Obnovit z archivu
              </Button>
            ) : (
              <Button
                icon="icon-[mdi--archive-outline]"
                onClick={() => setArchiving(true)}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                Archivovat
              </Button>
            ))}
        </div>

        <dl className="grid grid-cols-1 gap-200 rounded-lg border border-border-primary bg-surface p-200 sm:grid-cols-2 lg:grid-cols-3">
          <Fact icon="icon-[mdi--account-tie-outline]" label="Obchodník">
            <SalespersonChip name={owner} />
          </Fact>
          <Fact icon="icon-[mdi--calendar-check-outline]" label="Poslední návštěva">
            {facts.lastVisitAt === undefined ? <Missing>bez zapsané návštěvy</Missing> : formatDate(facts.lastVisitAt)}
          </Fact>
          <Fact icon="icon-[mdi--receipt-text-outline]" label="Evidované objednávky">
            {facts.orderCount === 0 ? (
              <Missing>bez dat</Missing>
            ) : (
              <>
                {formatNumber(facts.orderCount)}
                {facts.lastOrderAt === undefined ? '' : ` · poslední ${formatDate(facts.lastOrderAt)}`}
              </>
            )}
          </Fact>
          <Fact
            icon="icon-[mdi--card-account-details-outline]"
            label={client.kind === 'organization' ? 'IČO / DIČ' : 'Identifikace'}
          >
            {client.regNo === undefined && client.vatNo === undefined ? (
              <Missing />
            ) : (
              [client.regNo, client.vatNo].filter((value) => value !== undefined).join(' / ')
            )}
          </Fact>
          <Fact icon="icon-[mdi--phone-outline]" label="Telefon">
            {client.phone === undefined ? (
              <Missing />
            ) : (
              <Link href={`tel:${client.phone.replaceAll(' ', '')}`}>{client.phone}</Link>
            )}
          </Fact>
          <Fact icon="icon-[mdi--email-outline]" label="E-mail">
            {client.email === undefined ? <Missing /> : <Link href={`mailto:${client.email}`}>{client.email}</Link>}
          </Fact>
          <Fact icon="icon-[mdi--map-marker-outline]" label="Adresa">
            {client.address ?? <Missing />}
          </Fact>
          <Fact icon="icon-[mdi--cash-multiple]" label="Hodnota evidovaných objednávek">
            {facts.totals.length === 0 ? (
              <Missing>bez dat</Missing>
            ) : (
              <span className="flex flex-col">
                {facts.totals.map((total) => (
                  <span className="tabular-nums" key={total.currency}>
                    {formatDecimalMoney(total.amount, total.currency)}
                  </span>
                ))}
              </span>
            )}
          </Fact>
          <Fact icon="icon-[mdi--web]" label="Web">
            {client.website ?? <Missing />}
          </Fact>
        </dl>
        {client.note !== undefined && (
          <div className="flex gap-100 rounded-lg bg-surface-secondary p-200 text-sm">
            <span aria-hidden className="icon-[mdi--note-text-outline] mt-50 size-4 shrink-0 text-fg-secondary" />
            <p className="whitespace-pre-line">{client.note}</p>
          </div>
        )}

        <Tabs onValueChange={setTab} value={tab} variant="line">
          <Tabs.List>
            <Tabs.Trigger value="contacts">Kontakty ({contacts.length})</Tabs.Trigger>
            <Tabs.Trigger value="visits">Návštěvy ({visitCount})</Tabs.Trigger>
            <Tabs.Trigger value="orders">Objednávky ({facts.orderCount})</Tabs.Trigger>
            <Tabs.Trigger value="history">Historie</Tabs.Trigger>
            <Tabs.Indicator />
          </Tabs.List>
          <Tabs.Content className="py-200" value="contacts">
            <ContactsTab {...tabProps} writable={writable && !archived} />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="visits">
            <ClientVisitsTab {...tabProps} />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="orders">
            <ClientOrdersTab {...tabProps} />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="history">
            <HistoryTab client={client} records={records} />
          </Tabs.Content>
        </Tabs>
      </div>
      {assigning && (
        <AssignDialog busy={busy} client={client} onClose={() => setAssigning(false)} records={records} run={run} />
      )}
      <Dialog
        actions={
          <>
            <Button onClick={() => setArchiving(false)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button
              isLoading={busy}
              onClick={() =>
                void run({ _tag: 'ArchiveClient', id: client.id }, 'Klient archivován').then((ok) => {
                  if (ok) {
                    setArchiving(false);
                  }
                })
              }
              variant="primary"
            >
              Archivovat
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Klient zmizí z běžného seznamu. Kontakty, návštěvy, objednávky a historie zůstanou zachované a dohledatelné ve filtru Archivovaní; klienta lze kdykoli obnovit."
        onOpenChange={({ open }) => setArchiving(open)}
        open={archiving}
        size="sm"
        title={`Archivovat ${client.name}?`}
      />
    </SidePanel>
  );
};

export const ClientCard = ({ clientId, ...props }: CardProps) => {
  const client = props.records.state.clients.items.find((entry) => entry.id === clientId);
  return client === undefined ? <NotVisible onClose={props.onClose} /> : <CardBody {...props} client={client} />;
};
