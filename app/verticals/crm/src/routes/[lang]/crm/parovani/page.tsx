// AREA: imports — owned by the crm-imports lane. C04 Párování objednávek: queue of orders without a confirmed
// client, orders flagged "vyžaduje kontrolu", approved external customer links and the full pairing history.
import {
  EmptyState,
  PageHeader,
  SectionCard,
  SidePanel,
  StatCard,
  StatRow,
  formatDateTime,
  formatNumber,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { CustomerLink, ImportedOrder, PairingChange } from '../../../../../shared/domain/imports.ts';
import { needsReview } from '../../../../../shared/domain/imports.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import type { CrmCommandOutcome } from '../../../../crm/records.ts';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmStateGate, crmPaginationProps, crmTableTranslations } from '../../../../crm/ui.tsx';
import {
  RESIZE_LABEL,
  clientLabel,
  formatAmount,
  orderDate,
  orderTitle,
  principalLabel,
  reviewSummary,
  sourcesOf,
} from '../importy/order-model.ts';
import { OrderDetailPanel, PairingForm, PairingStateBadge, RawStatusBadge } from '../importy/order-panels.tsx';

const queueColumns = (records: RecordsResponse): ColumnDef<ImportedOrder>[] => [
  {
    accessorFn: (order) => orderTitle(order),
    cell: (info) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{orderTitle(info.row.original)}</span>
        <span className="truncate text-fg-secondary text-xs">{`${info.row.original.source} · ID ${info.row.original.externalId}`}</span>
      </div>
    ),
    header: 'Objednávka',
    id: 'order',
    meta: { type: 'string', width: 200 },
  },
  {
    accessorFn: (order) => order.customerName ?? '',
    cell: (info) => {
      const order = info.row.original;
      return (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{order.customerName ?? 'název neposkytnut'}</span>
          <span className="truncate text-fg-secondary text-xs">
            {[order.externalCustomerId, order.customerRegNo && `IČO ${order.customerRegNo}`, order.customerEmail]
              .filter((part) => part !== undefined && part !== '')
              .join(' · ') || 'identifikace neposkytnuta'}
          </span>
        </div>
      );
    },
    header: 'Zákazník podle zdroje',
    id: 'customer',
    meta: { type: 'string', width: 280 },
  },
  {
    accessorFn: (order) => order.orderedAt ?? '',
    cell: (info) => orderDate(info.row.original),
    header: 'Datum',
    id: 'orderedAt',
    meta: { type: 'string', width: 110 },
  },
  {
    accessorFn: (order) => Number(order.amount ?? 0),
    cell: (info) => (
      <span className="tabular-nums">{formatAmount(info.row.original.amount, info.row.original.currency)}</span>
    ),
    header: 'Částka',
    id: 'amount',
    meta: { align: 'end', type: 'number', width: 130 },
  },
  {
    accessorFn: (order) => (order.candidates ?? []).length,
    cell: (info) => {
      const candidates = info.row.original.candidates ?? [];
      return candidates.length === 0 ? (
        <span className="text-fg-secondary text-xs">žádný návrh</span>
      ) : (
        <div className="flex min-w-0 flex-col gap-50">
          {candidates.map((candidate) => (
            <span className="truncate text-xs" key={candidate.clientId}>
              <span className="font-medium">{clientLabel(records, candidate.clientId)}</span>
              {` · ${candidate.reason}`}
            </span>
          ))}
        </div>
      );
    },
    header: 'Možní kandidáti (nepotvrzeno)',
    id: 'candidates',
    meta: { type: 'number', width: 280 },
  },
  {
    accessorKey: 'pairing',
    cell: (info) => <PairingStateBadge order={info.row.original} />,
    header: 'Stav',
    meta: { type: 'string', width: 140 },
  },
];

const reviewColumns = (records: RecordsResponse): ColumnDef<ImportedOrder>[] => [
  {
    accessorFn: (order) => orderTitle(order),
    cell: (info) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{orderTitle(info.row.original)}</span>
        <span className="truncate text-fg-secondary text-xs">{`${info.row.original.source} · ID ${info.row.original.externalId}`}</span>
      </div>
    ),
    header: 'Objednávka',
    id: 'order',
    meta: { type: 'string', width: 200 },
  },
  {
    accessorFn: (order) => clientLabel(records, order.clientId) ?? '',
    cell: (info) => clientLabel(records, info.row.original.clientId) ?? <PairingStateBadge order={info.row.original} />,
    header: 'Klient',
    id: 'client',
    meta: { type: 'string', width: 200 },
  },
  {
    accessorKey: 'rawStatus',
    cell: (info) => <RawStatusBadge status={info.row.original.rawStatus} />,
    header: 'Platný stav',
    meta: { type: 'string', width: 130 },
  },
  {
    accessorFn: (order) => reviewSummary(order) ?? '',
    cell: (info) => <span className="line-clamp-2 text-sm">{reviewSummary(info.row.original)}</span>,
    header: 'Proč vyžaduje kontrolu',
    id: 'reason',
    meta: { type: 'string', width: 460 },
  },
];

const historyColumns = (records: RecordsResponse): ColumnDef<PairingChange>[] => [
  {
    accessorKey: 'at',
    cell: (info) => formatDateTime(info.row.original.at),
    header: 'Kdy',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorFn: (change) => {
      const order = records.state.imports.orders.find((entry) => entry.id === change.orderId);
      return order === undefined ? change.orderId : orderTitle(order);
    },
    header: 'Objednávka',
    id: 'order',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorFn: (change) => clientLabel(records, change.fromClientId) ?? '',
    cell: (info) =>
      clientLabel(records, info.row.original.fromClientId) ?? <span className="text-fg-secondary">—</span>,
    header: 'Původně',
    id: 'from',
    meta: { type: 'string', width: 190 },
  },
  {
    accessorFn: (change) => clientLabel(records, change.toClientId) ?? '',
    cell: (info) =>
      clientLabel(records, info.row.original.toClientId) ?? <span className="text-fg-secondary">nenapárováno</span>,
    header: 'Nově',
    id: 'to',
    meta: { type: 'string', width: 190 },
  },
  {
    accessorKey: 'via',
    cell: (info) =>
      info.row.original.via === 'manual' ? (
        <Badge size="sm" variant="info">
          Ručně
        </Badge>
      ) : (
        <Badge size="sm" variant="outline">
          Schválená vazba
        </Badge>
      ),
    header: 'Způsob',
    meta: { type: 'string', width: 140 },
  },
  {
    accessorFn: (change) => principalLabel(records, change.by),
    header: 'Autor',
    id: 'by',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorKey: 'reason',
    cell: (info) => <span className="line-clamp-2 text-sm">{info.row.original.reason}</span>,
    header: 'Důvod',
    meta: { type: 'string', width: 320 },
  },
];

/** Registry name of the Counterparty an approved link correlates to (CRM.md C04), when the client is linked. */
const partyOfLink = (records: RecordsResponse, link: CustomerLink) => {
  const client = records.state.clients.items.find(
    (entry) =>
      (link.counterpartyId !== undefined && entry.partyRef?.counterpartyId === link.counterpartyId) ||
      entry.id === link.clientId,
  );
  return client?.partyRef?.counterpartyId === undefined ? undefined : (client.partyRef.registryName ?? client.name);
};

const linkColumns = (records: RecordsResponse): ColumnDef<CustomerLink>[] => [
  { accessorKey: 'source', header: 'Zdroj', meta: { type: 'string', width: 150 } },
  {
    accessorKey: 'externalCustomerId',
    cell: (info) => <span className="font-mono text-xs">{info.row.original.externalCustomerId}</span>,
    header: 'ID zákazníka ve zdroji',
    meta: { type: 'string', width: 180 },
  },
  {
    accessorFn: (link) => clientLabel(records, link.clientId) ?? '',
    cell: (info) => <span className="font-medium">{clientLabel(records, info.row.original.clientId)}</span>,
    header: 'Klient v CRM',
    id: 'client',
    meta: { type: 'string', width: 240 },
  },
  {
    accessorFn: (link) => partyOfLink(records, link) ?? '',
    cell: (info) => {
      const party = partyOfLink(records, info.row.original);
      return party === undefined ? (
        <span className="text-fg-secondary">jen klient CRM (bez Party)</span>
      ) : (
        <span title="Vazba vede na Counterparty v Party Registry">{party}</span>
      );
    },
    header: 'Party Registry',
    id: 'party',
    meta: { type: 'string', width: 200 },
  },
  {
    accessorFn: (link) => principalLabel(records, link.createdBy),
    header: 'Schválil(a)',
    id: 'createdBy',
    meta: { type: 'string', width: 160 },
  },
  {
    accessorKey: 'createdAt',
    cell: (info) => formatDateTime(info.row.original.createdAt),
    header: 'Kdy',
    meta: { type: 'string', width: 150 },
  },
];

const PairPanel = ({
  busy,
  onClose,
  order,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly order: ImportedOrder;
  readonly records: RecordsResponse;
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}) => (
  <SidePanel
    actions={
      <Button onClick={onClose} theme="outlined" variant="secondary">
        Zavřít
      </Button>
    }
    closeOnInteractOutside={false}
    description={`${order.source} · ID ${order.externalId} · ${orderDate(order)} · ${formatAmount(order.amount, order.currency)}`}
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
    open
    resizeLabel={RESIZE_LABEL}
    size="lg"
    title={`Napárovat ${orderTitle(order)}`}
  >
    <div className="flex flex-col gap-200">
      <div className="flex flex-col gap-50 rounded-lg border border-border-primary p-150 text-sm">
        <span className="text-fg-secondary text-xs">Zákazník podle zdroje</span>
        <span className="font-medium">{order.customerName ?? 'název neposkytnut'}</span>
        <span className="text-fg-secondary">
          {[
            order.externalCustomerId && `ID ${order.externalCustomerId}`,
            order.customerRegNo && `IČO ${order.customerRegNo}`,
            order.customerEmail,
          ]
            .filter((part) => part !== undefined && part !== '')
            .join(' · ') || 'identifikace neposkytnuta'}
        </span>
        <span className="flex items-center gap-100">
          Stav ve zdroji: <RawStatusBadge status={order.rawStatus} />
        </span>
      </div>
      <PairingForm busy={busy} onDone={onClose} order={order} records={records} submit={submit} />
    </div>
  </SidePanel>
);

const NewLinkPanel = ({
  busy,
  onClose,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}) => {
  const toaster = useToast();
  const sources = sourcesOf(records.state.imports.orders);
  const [source, setSource] = useState(sources[0] ?? 'E-shop');
  const [externalCustomerId, setExternalCustomerId] = useState('');
  const [clientId, setClientId] = useState('');
  const waiting = records.state.imports.orders.filter(
    (order) =>
      order.pairing !== 'paired' && order.source === source && order.externalCustomerId === externalCustomerId.trim(),
  ).length;
  const save = () =>
    void submit({ _tag: 'LinkExternalCustomer', clientId, externalCustomerId: externalCustomerId.trim(), source }).then(
      (outcome) => {
        toaster.create(
          outcome.ok
            ? {
                description:
                  outcome.entityIds.length > 1
                    ? `Napárováno čekajících objednávek: ${String(outcome.entityIds.length - 1)}`
                    : undefined,
                title: 'Vazba schválena',
                type: 'success',
              }
            : { description: outcome.message, title: 'Uložení se nezdařilo', type: 'error' },
        );
        if (outcome.ok) {
          onClose();
        }
      },
    );
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button
            disabled={clientId === '' || externalCustomerId.trim() === ''}
            isLoading={busy}
            loadingText="Ukládám…"
            onClick={save}
            variant="primary"
          >
            Schválit vazbu
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description="Potvrzená korelace ID zákazníka ze zdroje na klienta CRM. Objednávky s tímto ID se pak přiřadí samy."
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="md"
      title="Nová schválená vazba"
    >
      <div className="flex flex-col gap-150">
        <SelectTemplate
          items={(sources.length === 0 ? ['E-shop', 'Účetní systém'] : sources).map((entry) => ({
            label: entry,
            value: entry,
          }))}
          label="Zdrojový systém"
          name="link-source"
          onValueChange={(details) => setSource(details.value[0] ?? source)}
          size="sm"
          value={[source]}
        />
        <FormInput
          autoComplete="off"
          id="link-external-id"
          label="ID zákazníka ve zdroji"
          name="externalCustomerId"
          onChange={(event) => setExternalCustomerId(event.target.value)}
          required
          size="sm"
          value={externalCustomerId}
        />
        <SelectTemplate
          items={records.state.clients.items
            .filter((client) => client.status === 'active')
            .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'))
            .map((client) => ({ label: client.name, value: client.id }))}
          label="Klient v CRM"
          name="link-client"
          onValueChange={(details) => setClientId(details.value[0] ?? '')}
          placeholder="Vyberte klienta"
          size="sm"
          value={clientId === '' ? [] : [clientId]}
        />
        {waiting > 0 && (
          <span className="text-sm">{`Na tuto vazbu čeká ${String(waiting)} nenapárovaných objednávek – po schválení se přiřadí.`}</span>
        )}
      </div>
    </SidePanel>
  );
};

const Heading = ({ hint, title }: { readonly hint?: string; readonly title: string }) => (
  <div className="mt-100 flex flex-col gap-50">
    <h2 className="font-semibold text-md">{title}</h2>
    {hint !== undefined && <p className="max-w-prose text-fg-secondary text-sm">{hint}</p>}
  </div>
);

const PairingContent = () => {
  const { t } = useModernI18n();
  const { busy, load, state, submit } = useCrmRecords();
  const [pairId, setPairId] = useState<string | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => {
        const { customerLinks, orders, pairingHistory } = records.state.imports;
        if (!records.viewer.readAll && !records.viewer.writeAll) {
          return (
            <>
              <PageHeader description={t('crm.pages.pairing.description')} title={t('crm.pages.pairing.title')} />
              <SectionCard>
                <EmptyState
                  description="Frontu nenapárovaných objednávek a schvalování vazeb spravuje vedení obchodu. Objednávky vašich klientů najdete na kartě klienta v záložce Objednávky."
                  title="Párování provádí vedení obchodu"
                />
              </SectionCard>
            </>
          );
        }
        const canPair = records.viewer.writeAll;
        const queue = orders.filter((order) => order.pairing !== 'paired');
        const uncertain = queue.filter((order) => order.pairing === 'review');
        const review = orders.filter(needsReview);
        const pairOrder = orders.find((order) => order.id === pairId);
        const detail = orders.find((order) => order.id === detailId);
        return (
          <>
            <PageHeader
              actions={
                canPair ? (
                  <Button
                    icon="icon-[mdi--link-plus]"
                    onClick={() => setLinkOpen(true)}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    Nová schválená vazba
                  </Button>
                ) : undefined
              }
              description={t('crm.pages.pairing.description')}
              title={t('crm.pages.pairing.title')}
            />
            <StatRow>
              <StatCard
                hint="bez návrhu klienta"
                label="Nenapárované"
                value={formatNumber(queue.length - uncertain.length)}
              />
              <StatCard
                hint="shoda IČO, e-mailu nebo názvu"
                label="Nejistý klient"
                value={formatNumber(uncertain.length)}
              />
              <StatCard
                hint="sporné stavy a duplicity zdrojů"
                label="Vyžaduje kontrolu"
                value={formatNumber(review.length)}
              />
              <StatCard
                hint="ID zákazníka → klient"
                label="Schválené vazby"
                value={formatNumber(customerLinks.length)}
              />
            </StatRow>
            <p className="max-w-prose text-fg-secondary text-sm">
              Objednávka se ke klientovi přiřadí automaticky jen přes schválenou vazbu ID zákazníka. Ostatní čekají tady
              – shoda e-mailu, telefonu nebo názvu je jen návrh a nikdy se nepoužije sama. Nespárované objednávky se
              nezapočítávají do potvrzených souhrnů.
            </p>
            <Heading
              hint="Klikněte na objednávku, vyberte klienta a uveďte, jak jste ho ověřili."
              title={`Fronta k napárování (${String(queue.length)})`}
            />
            {queue.length === 0 && (
              <SectionCard>
                <EmptyState
                  description="Všechny importované objednávky mají potvrzeného klienta."
                  title="Fronta je prázdná"
                />
              </SectionCard>
            )}
            {queue.length > 0 && (
              <DataTable
                columns={queueColumns(records)}
                data={queue}
                enableSorting
                getRowId={(row) => row.id}
                getRowLabel={(row) => `Napárovat ${orderTitle(row.original)}`}
                onRowClick={(row) => (canPair ? setPairId(row.original.id) : setDetailId(row.original.id))}
                size="sm"
                tableLayout="fixed"
                translations={crmTableTranslations}
              />
            )}
            <Heading
              hint="Starší či sporné zprávy nepřepsaly platný stav a možné duplicity se nesčítají. Otevřete objednávku a rozhodněte s uvedením důvodu."
              title={`Vyžaduje kontrolu (${String(review.length)})`}
            />
            {review.length === 0 && (
              <SectionCard>
                <EmptyState
                  description="Žádné sporné pořadí stavů ani duplicita mezi zdroji."
                  title="Nic ke kontrole"
                />
              </SectionCard>
            )}
            {review.length > 0 && (
              <DataTable
                columns={reviewColumns(records)}
                data={review}
                getRowId={(row) => row.id}
                getRowLabel={(row) => `Kontrola ${orderTitle(row.original)}`}
                onRowClick={(row) => setDetailId(row.original.id)}
                size="sm"
                tableLayout="fixed"
                translations={crmTableTranslations}
              />
            )}
            <Heading
              hint="Každé přiřazení i oprava zůstává: původní a nová vazba, autor, čas a důvod."
              title={`Historie párování (${String(pairingHistory.length)})`}
            />
            {pairingHistory.length > 0 && (
              <DataTable
                columns={historyColumns(records)}
                data={pairingHistory.toReversed()}
                enablePagination
                enableSorting
                getRowId={(row) => row.id}
                getRowLabel={(row) => `Změna ${row.original.id}`}
                onRowClick={(row) => setDetailId(row.original.orderId)}
                pageSizeOptions={[10, 50]}
                paginationProps={crmPaginationProps}
                size="sm"
                tableLayout="fixed"
                translations={crmTableTranslations}
              />
            )}
            <Heading
              hint="Potvrzené korelace ID zákazníka ze zdroje na klienta CRM. Jen podle nich se objednávky přiřazují automaticky."
              title={`Schválené vazby zákaznických ID (${String(customerLinks.length)})`}
            />
            {customerLinks.length > 0 && (
              <DataTable
                columns={linkColumns(records)}
                data={[...customerLinks]}
                enableSorting
                getRowId={(row) => `${row.source}-${row.externalCustomerId}`}
                getRowLabel={(row) => `Vazba ${row.original.externalCustomerId}`}
                size="sm"
                tableLayout="fixed"
                translations={crmTableTranslations}
              />
            )}
            {pairOrder !== undefined && (
              <PairPanel
                busy={busy}
                key={pairOrder.id}
                onClose={() => setPairId(undefined)}
                order={pairOrder}
                records={records}
                submit={submit}
              />
            )}
            {detail !== undefined && (
              <OrderDetailPanel
                busy={busy}
                key={detail.id}
                onClose={() => setDetailId(undefined)}
                order={detail}
                records={records}
                submit={submit}
              />
            )}
            {linkOpen && (
              <NewLinkPanel busy={busy} onClose={() => setLinkOpen(false)} records={records} submit={submit} />
            )}
          </>
        );
      }}
    </CrmStateGate>
  );
};

export const PairingPage = () => (
  <CrmPage titleKey="crm.pages.pairing.title">
    <PairingContent />
  </CrmPage>
);

export default PairingPage;
