// AREA: clients (C00/C01) — owned by the crm-clients lane. Scaffold version: list + create.
import { PageHeader, StatCard, StatRow, dialogCloseLabel, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { salespersonName, useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate, crmPaginationProps, crmTableTranslations } from '../../../../crm/ui.tsx';

const columns = (records: RecordsResponse): ColumnDef<Client>[] => [
  {
    accessorKey: 'name',
    cell: (info) => <span className="font-medium">{info.getValue<string>()}</span>,
    header: 'Klient',
    meta: { type: 'string', width: 260 },
  },
  {
    accessorFn: (client) => client.regNo ?? '',
    header: 'IČO',
    id: 'regNo',
    meta: { type: 'string', width: 110 },
  },
  {
    accessorFn: (client) => client.email ?? '',
    header: 'E-mail',
    id: 'email',
    meta: { type: 'string', width: 220 },
  },
  {
    accessorFn: (client) => client.phone ?? '',
    header: 'Telefon',
    id: 'phone',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorFn: (client) => salespersonName(records, client.ownerSalespersonId) ?? '',
    cell: (info) => {
      const name = info.getValue<string>();
      return name === '' ? <span className="text-fg-secondary">Nepřiděleno</span> : name;
    },
    header: 'Obchodník',
    id: 'owner',
    meta: { type: 'string', width: 170 },
  },
  {
    accessorKey: 'status',
    cell: (info) =>
      info.getValue<string>() === 'active' ? (
        <Badge size="sm" variant="success">
          Aktivní
        </Badge>
      ) : (
        <Badge size="sm" variant="outline">
          Archivovaný
        </Badge>
      ),
    header: 'Stav',
    meta: { type: 'string', width: 120 },
  },
];

const ClientsContent = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const { busy, load, state, submit } = useCrmRecords();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const create = () => {
    void submit({
      _tag: 'CreateClient',
      kind: 'organization',
      name: name.trim(),
      ...(regNo.trim() === '' ? {} : { regNo: regNo.trim() }),
      ...(email.trim() === '' ? {} : { email: email.trim() }),
      ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
    }).then((outcome) => {
      toaster.create(
        outcome.ok
          ? { title: t('crm.common.saved'), type: 'success' }
          : { description: outcome.message, title: t('crm.common.saveFailed'), type: 'error' },
      );
      if (outcome.ok) {
        setCreateOpen(false);
        setName('');
        setRegNo('');
        setEmail('');
        setPhone('');
      }
    });
  };

  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => {
        const query = search.trim().toLowerCase();
        const active = records.state.clients.items.filter((client) => client.status === 'active');
        const visible = active.filter(
          (client) =>
            query === '' ||
            [client.name, client.regNo, client.email, client.phone]
              .filter((value) => value !== undefined)
              .join(' ')
              .toLowerCase()
              .includes(query),
        );
        const canCreate = records.viewer.writeAll || records.viewer.writeAssigned;
        return (
          <>
            <PageHeader
              actions={
                canCreate ? (
                  <Button icon="icon-[mdi--plus]" onClick={() => setCreateOpen(true)} size="sm" variant="primary">
                    Nový klient
                  </Button>
                ) : undefined
              }
              description={t('crm.pages.clients.description')}
              title={t('crm.pages.clients.title')}
            />
            <StatRow>
              <StatCard label="Aktivní klienti" value={formatNumber(active.length)} />
              <StatCard
                label="Nepřidělení"
                value={formatNumber(active.filter((client) => client.ownerSalespersonId === undefined).length)}
              />
              <StatCard label="Kontaktní osoby" value={formatNumber(records.state.clients.contacts.length)} />
            </StatRow>
            <CrmScopeNote records={records} />
            <Input
              aria-label="Hledat klienta"
              className="w-72"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Hledat název, IČO, e-mail, telefon"
              size="sm"
              type="search"
              value={search}
            />
            <DataTable
              columns={columns(records)}
              data={visible}
              enablePagination
              enableSorting
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.original.name}
              maxHeight="calc(100dvh - 18rem)"
              pageSizeOptions={[50, 100]}
              paginationProps={crmPaginationProps}
              size="sm"
              stickyHeader
              tableLayout="fixed"
              translations={crmTableTranslations}
            />
            <Dialog
              actions={
                <>
                  <Button onClick={() => setCreateOpen(false)} theme="outlined" variant="secondary">
                    {t('crm.common.cancel')}
                  </Button>
                  <Button
                    disabled={name.trim() === ''}
                    isLoading={busy}
                    loadingText={t('crm.common.saving')}
                    onClick={create}
                    variant="primary"
                  >
                    {t('crm.common.save')}
                  </Button>
                </>
              }
              closeLabel={dialogCloseLabel}
              customTrigger
              onOpenChange={({ open }) => setCreateOpen(open)}
              open={createOpen}
              size="md"
              title="Nový klient"
            >
              <div className="flex flex-col gap-150">
                <FormInput
                  autoComplete="off"
                  id="crm-client-name"
                  label="Název firmy"
                  name="name"
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
                <FormInput
                  autoComplete="off"
                  id="crm-client-regno"
                  label="IČO"
                  name="regNo"
                  onChange={(event) => setRegNo(event.target.value)}
                  value={regNo}
                />
                <FormInput
                  autoComplete="off"
                  id="crm-client-email"
                  label="E-mail"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  value={email}
                />
                <FormInput
                  autoComplete="off"
                  id="crm-client-phone"
                  label="Telefon"
                  name="phone"
                  onChange={(event) => setPhone(event.target.value)}
                  value={phone}
                />
              </div>
            </Dialog>
          </>
        );
      }}
    </CrmStateGate>
  );
};

export const ClientsPage = () => (
  <CrmPage titleKey="crm.pages.clients.title">
    <ClientsContent />
  </CrmPage>
);

export default ClientsPage;
