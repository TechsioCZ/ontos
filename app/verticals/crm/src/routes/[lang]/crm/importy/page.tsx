import { pipe, DateTime, Schema } from 'effect';
import { orderDateText, needsReview } from '../../../../../shared/domain/imports.ts';
import type { ImportBatch, ImportedOrder } from '../../../../../shared/domain/imports.ts';
// AREA: imports — owned by the crm-imports lane. C03 Import objednávek: imported orders with their source state,
// CSV import with preview, import history with per-row results, the documented template and sample files.
import {
  DetailList,
  EmptyState,
  PageHeader,
  SectionCard,
  SidePanel,
  StatCard,
  StatRow,
  formatDateTime,
  formatNumber,
  matchesSearch,
  surfaceTileClassName,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';

import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { ComponentProps } from 'react';

import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';

import { ORDERS_CSV_FORMAT, ordersCsvColumns, ordersCsvTemplate } from '../../../../../shared/imports/csv.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import {
  CrmScopeNote,
  CrmStateGate,
  useCrmRouteSelection,
  crmPaginationProps,
  crmTableTranslations,
} from '../../../../crm/ui.tsx';
import { ImportPanel, RowResults } from './import-panel.tsx';
import type { ImportDraft } from './import-panel.tsx';

import {
  RESIZE_LABEL,
  batchStatusMeta,
  clientLabel,
  downloadText,
  useFormatAmount,
  lastChange,
  orderDate,
  orderSearchText,
  orderTitle,
  principalLabel,
  reviewCount,
  sourcesOf,
} from './order-model.ts';
import { OrderDetailPanel, PairingStateBadge, RawStatusBadge } from './order-panels.tsx';

const ALL = '__all__';
const OrderFilterSchema = Schema.Literals(['all', 'paired', 'queue', 'review']);
type OrderFilter = typeof OrderFilterSchema.Type;
const isOrderFilter = Schema.is(OrderFilterSchema);

const orderColumns = (
  records: RecordsResponse,
  formatAmount: ReturnType<typeof useFormatAmount>,
): ColumnDef<ImportedOrder>[] => [
  {
    accessorFn: (order) => orderTitle(order),
    cell: (info) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{info.row.original.number ?? info.row.original.externalId}</span>
        <span className="truncate text-fg-secondary text-xs">{`ID ${info.row.original.externalId}`}</span>
      </div>
    ),
    header: 'Objednávka',
    id: 'number',
    meta: { type: 'string', width: 155 },
  },
  { accessorKey: 'source', header: 'Zdroj', meta: { type: 'string', width: 115 } },
  {
    accessorFn: (order) => orderDateText(order.orderedAt) ?? '',
    cell: (info) => orderDate(info.row.original),
    header: 'Datum',
    id: 'orderedAt',
    meta: { type: 'string', width: 110 },
  },
  {
    accessorFn: (order) => clientLabel(records, order.clientId) ?? '',
    cell: (info) => {
      const order = info.row.original;
      return order.clientId === undefined ? (
        <div className="flex min-w-0 flex-col items-start gap-50">
          <PairingStateBadge order={order} />
          <span className="truncate text-fg-secondary text-xs">
            {order.customerName ?? order.externalCustomerId ?? '—'}
          </span>
        </div>
      ) : (
        <span className="truncate">{clientLabel(records, order.clientId)}</span>
      );
    },
    header: 'Klient',
    id: 'client',
    meta: { type: 'string', width: 190 },
  },
  {
    accessorFn: (order) => Number(order.amount ?? 0),
    cell: (info) => (
      <span className={`tabular-nums ${info.row.original.amount === undefined ? 'text-fg-secondary' : ''}`}>
        {formatAmount(info.row.original.amount, info.row.original.currency)}
      </span>
    ),
    header: 'Částka',
    id: 'amount',
    meta: { align: 'end', type: 'number', width: 135 },
  },
  {
    accessorKey: 'rawStatus',
    cell: (info) => <RawStatusBadge status={info.row.original.rawStatus} />,
    header: 'Stav ve zdroji',
    meta: { type: 'string', width: 130 },
  },
  {
    accessorFn: (order) => DateTime.formatIso(order.lastEventAt ?? order.receivedAt),
    cell: (info) => <span className="text-sm">{lastChange(info.row.original)}</span>,
    header: 'Poslední změna',
    id: 'lastEventAt',
    meta: { type: 'string', width: 145 },
  },
  {
    accessorFn: (order) => (needsReview(order) ? 1 : 0),
    cell: (info) => {
      const order = info.row.original;
      if (needsReview(order)) {
        return (
          <Badge size="sm" variant="warning">
            Ke kontrole
          </Badge>
        );
      }
      return order.duplicateOf === undefined ? null : (
        <Badge size="sm" variant="outline">
          Duplicita
        </Badge>
      );
    },
    header: 'Kontrola',
    id: 'review',
    meta: { type: 'number', width: 110 },
  },
];

const batchColumns = (records: RecordsResponse): ColumnDef<ImportBatch>[] => [
  {
    accessorFn: (batch) => DateTime.formatIso(batch.importedAt),
    cell: (info) => pipe(info.row.original.importedAt, orderDateText, formatDateTime),
    header: 'Importováno',
    id: 'importedAt',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorKey: 'fileName',
    cell: (info) => <span className="block truncate font-medium">{info.row.original.fileName}</span>,
    header: 'Soubor',
    meta: { type: 'string', width: 300 },
  },
  { accessorKey: 'source', header: 'Zdroj', meta: { type: 'string', width: 160 } },
  {
    accessorFn: (batch) => principalLabel(records, batch.importedBy),
    header: 'Autor',
    id: 'importedBy',
    meta: { type: 'string', width: 190 },
  },
  { accessorKey: 'rowCount', header: 'Řádků', meta: { align: 'end', type: 'number', width: 80 } },
  {
    accessorFn: (batch) => batch.created ?? 0,
    header: 'Nové',
    id: 'created',
    meta: { align: 'end', type: 'number', width: 80 },
  },
  {
    accessorFn: (batch) => batch.updated ?? 0,
    header: 'Změny',
    id: 'updated',
    meta: { align: 'end', type: 'number', width: 80 },
  },
  { accessorKey: 'duplicates', header: 'Duplicity', meta: { align: 'end', type: 'number', width: 90 } },
  {
    accessorFn: (batch) => batch.review ?? 0,
    header: 'Ke kontrole',
    id: 'review',
    meta: { align: 'end', type: 'number', width: 100 },
  },
  { accessorKey: 'rejected', header: 'Chyby', meta: { align: 'end', type: 'number', width: 80 } },
  {
    accessorKey: 'status',
    cell: (info) => {
      const meta = batchStatusMeta[info.row.original.status];
      return (
        <Badge size="sm" variant={meta.variant}>
          {meta.label}
        </Badge>
      );
    },
    header: 'Stav',
    meta: { type: 'string', width: 170 },
  },
];

const BatchPanel = ({
  batch,
  onClose,
  records,
}: {
  readonly batch: ImportBatch | undefined;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
}) => {
  if (batch === undefined) {
    return null;
  }
  const meta = batchStatusMeta[batch.status];
  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          Zavřít
        </Button>
      }
      description={`${pipe(batch.importedAt, orderDateText, formatDateTime)} · ${principalLabel(records, batch.importedBy)}`}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="xl"
      title={`Importní dávka ${batch.fileName}`}
    >
      <div className="flex flex-col gap-250">
        <div className="flex flex-wrap gap-100">
          <Badge size="sm" variant={meta.variant}>
            {meta.label}
          </Badge>
          <Badge size="sm" variant="secondary">
            {`Formát ${batch.format}`}
          </Badge>
        </div>
        <DetailList
          items={[
            { label: 'Zdroj', value: batch.source },
            { label: 'Řádků s daty', value: formatNumber(batch.rowCount) },
            { label: 'Přijato', value: formatNumber(batch.accepted) },
            { label: 'Odmítnuto (chyby)', value: formatNumber(batch.rejected) },
            { label: 'Nové objednávky', value: formatNumber(batch.created ?? 0) },
            { label: 'Změny stavu', value: formatNumber(batch.updated ?? 0) },
            { label: 'Duplicity (beze změny)', value: formatNumber(batch.duplicates) },
            { label: 'Vyžaduje kontrolu', value: formatNumber(batch.review ?? 0) },
            { label: 'Nové bez klienta', value: formatNumber(batch.unpaired ?? 0) },
            { label: 'Soubor dávky', value: batch.fileName },
            { label: 'Importováno', value: pipe(batch.importedAt, orderDateText, formatDateTime) },
          ]}
        />
        {batch.errors.length > 0 && (
          <div className="flex flex-col gap-100 rounded-lg bg-bg-danger-subtle p-150">
            <span className="font-medium text-sm">{`Chybné řádky (${String(batch.errors.length)}) – ostatní řádky se uložily`}</span>
            <ul className="flex flex-col gap-50 text-sm">
              {batch.errors.map((error) => (
                <li key={`${String(error.row)}-${error.message}`}>{`Řádek ${String(error.row)}: ${error.message}`}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-100">
          <h3 className="font-semibold text-sm">Výsledek po řádcích</h3>
          {batch.results === undefined || batch.results.length === 0 ? (
            <span className="text-fg-secondary text-sm">bez dat</span>
          ) : (
            <RowResults results={batch.results} />
          )}
        </div>
      </div>
    </SidePanel>
  );
};

const TemplateTab = ({
  canImport,
  onImportSample,
  samples,
}: {
  readonly canImport: boolean;
  readonly onImportSample: (draft: ImportDraft) => void;
  readonly samples: NonNullable<RecordsResponse['importSamples']>;
}) => (
  <div className="grid grid-cols-1 gap-250 xl:grid-cols-[3fr_2fr]">
    <SectionCard
      actions={
        <Button
          icon="icon-[mdi--download]"
          onClick={() => downloadText('sablona-import-objednavek.csv', ordersCsvTemplate())}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Stáhnout šablonu
        </Button>
      }
      title={`Šablona ${ORDERS_CSV_FORMAT}`}
    >
      <p className="text-fg-secondary text-sm">
        Středník nebo čárka jako oddělovač, UTF-8, první řádek hlavička. Čas bez časového pásma se čte jako čas v Praze.
        Šablona obsahuje nezávislý fiktivní příklad, nikoli objednávku z evidence firmy. Až dodá WR tým finální šablonu,
        mapování sloupců se upraví – pravidla níže zůstanou.
      </p>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface text-fg-secondary text-xs">
            <tr>
              <th className="px-150 py-100 text-left font-normal">Sloupec</th>
              <th className="px-150 py-100 text-left font-normal">Význam</th>
              <th className="px-150 py-100 text-left font-normal">Příklad</th>
            </tr>
          </thead>
          <tbody>
            {ordersCsvColumns.map((column) => (
              <tr className="border-border-primary border-t align-top" key={column.key}>
                <td className="px-150 py-100">
                  <span className="font-mono text-xs">{column.key}</span>
                  {column.required && (
                    <Badge className="ms-100" size="sm" variant="info">
                      povinné
                    </Badge>
                  )}
                </td>
                <td className="px-150 py-100">{column.label}</td>
                <td className="max-w-64 break-all px-150 py-100 font-mono text-fg-secondary text-xs">
                  {column.example}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex list-disc flex-col gap-50 ps-250 text-sm">
        <li>
          Objednávku určuje dvojice zdroj + ID objednávky. Další řádek se stejným ID přidá stav do historie, nikdy
          druhou objednávku.
        </li>
        <li>Stejná událost (ID události, nebo stav + čas) se při opakovaném importu ignoruje – počty se nezmění.</li>
        <li>Starší nebo současně sporná událost nepřepíše novější stav; uloží se a označí „vyžaduje kontrolu“.</li>
        <li>
          Klient se přiřadí jen podle schválené vazby ID zákazníka. Shoda IČO, e-mailu nebo názvu je jen návrh k ruční
          kontrole.
        </li>
        <li>Stejné číslo objednávky ze dvou zdrojů se nesčítá dvakrát – čeká na rozhodnutí.</li>
        <li>
          Chybný řádek dostane čitelnou chybu, ostatní řádky se uloží. Položky se ukládají jen, když je zdroj posílá.
        </li>
      </ul>
    </SectionCard>
    <SectionCard title="Vzorové soubory">
      <div className="flex flex-col gap-150">
        {!canImport && (
          <p className="text-fg-secondary text-sm">
            Vzorové soubory obsahují objednávky celé firmy, proto jsou dostupné jen vedení obchodu s právem importu.
            Šablonu s fiktivním příkladem si můžete stáhnout i bez tohoto oprávnění; popis formátu najdete vedle.
          </p>
        )}
        {canImport &&
          samples.map((sample, index) => (
            <div className={`${surfaceTileClassName} flex flex-col gap-100 p-200`} key={sample.key}>
              <div className="flex items-center gap-100">
                <Badge size="sm" variant="secondary">
                  {String(index + 1)}
                </Badge>
                <span className="font-medium text-sm">{sample.title}</span>
              </div>
              <span className="text-fg-secondary text-sm">{sample.description}</span>
              <span className="font-mono text-fg-secondary text-xs">{sample.fileName}</span>
              <div className="flex flex-wrap gap-100">
                <Button
                  icon="icon-[mdi--download]"
                  onClick={() => downloadText(sample.fileName, sample.csv)}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  Stáhnout
                </Button>
                <Button
                  icon="icon-[mdi--database-import-outline]"
                  onClick={() => onImportSample({ csv: sample.csv, fileName: sample.fileName })}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  Otevřít v importu
                </Button>
              </div>
            </div>
          ))}
      </div>
    </SectionCard>
  </div>
);

const ImportsContent = () => {
  const formatAmount = useFormatAmount();
  const { t } = useModernI18n();
  const { busy, load, state, submit } = useCrmRecords();
  const [orderId, setOrderId] = useCrmRouteSelection('objednavka');
  const [tab, setTab] = useState('orders');
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [source, setSource] = useState(ALL);
  const [search, setSearch] = useState('');
  const [batchId, setBatchId] = useState<string | undefined>();
  const [importDraft, setImportDraft] = useState<ImportDraft | undefined>();
  const [importOpen, setImportOpen] = useState(false);

  const openImport = (draft?: ImportDraft) => {
    setImportDraft(draft);
    setImportOpen(true);
  };

  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => {
        const { batches, orders } = records.state.imports;
        const lead = canSeeEverything(records.viewer);
        const canImport = records.viewer.writeAll;
        const queue = orders.filter((order) => order.pairing !== 'paired');
        const sources = sourcesOf(orders);
        const visible = orders
          .filter((order) => {
            let matchesFilter = true;
            if (filter === 'paired') {
              matchesFilter = order.pairing === 'paired';
            } else if (filter === 'queue') {
              matchesFilter = order.pairing !== 'paired';
            } else if (filter === 'review') {
              matchesFilter = needsReview(order);
            }
            return (
              matchesFilter &&
              (source === ALL || order.source === source) &&
              matchesSearch(orderSearchText(records, order), search)
            );
          })
          .toSorted((left, right) =>
            DateTime.Order(right.lastEventAt ?? right.receivedAt, left.lastEventAt ?? left.receivedAt),
          );
        const [lastBatch] = batches;
        const detail = orders.find((order) => order.id === orderId);
        const initialImport: Pick<ComponentProps<typeof ImportPanel>, 'initial'> = {};
        if (importDraft !== undefined) {
          Object.assign(initialImport, { initial: importDraft });
        }
        return (
          <>
            <PageHeader
              actions={
                canImport ? (
                  <>
                    <Button
                      icon="icon-[mdi--download]"
                      onClick={() => downloadText('sablona-import-objednavek.csv', ordersCsvTemplate())}
                      size="sm"
                      theme="outlined"
                      variant="secondary"
                    >
                      Šablona CSV
                    </Button>
                    <Button icon="icon-[mdi--upload]" onClick={() => openImport()} size="sm" variant="primary">
                      Importovat CSV
                    </Button>
                  </>
                ) : undefined
              }
              description={t('crm.pages.imports.description')}
              meta={
                <Badge size="sm" variant="outline">
                  CSV import
                </Badge>
              }
              title={t('crm.pages.imports.title')}
            />
            <StatRow>
              <StatCard
                hint={sources.length === 0 ? 'bez dat' : `Zdroje: ${sources.join(', ')}`}
                label={lead ? 'Evidované objednávky' : 'Objednávky mých klientů'}
                value={formatNumber(orders.length)}
              />
              {lead && (
                <StatCard
                  hint={
                    lastBatch === undefined
                      ? 'zatím žádný import'
                      : `Poslední ${pipe(lastBatch.importedAt, orderDateText, formatDateTime)}`
                  }
                  label="Importní dávky"
                  value={formatNumber(batches.length)}
                />
              )}
              {lead && (
                <StatCard
                  hint="bez schválené vazby na klienta"
                  label="K napárování"
                  value={formatNumber(queue.length)}
                />
              )}
              <StatCard
                hint="sporné pořadí stavů nebo duplicita zdrojů"
                label="Vyžaduje kontrolu"
                value={formatNumber(reviewCount(orders))}
              />
            </StatRow>
            <CrmScopeNote records={records} />
            {!lead && (
              <p className="text-fg-secondary text-sm">
                Import, frontu k napárování a historii importů spravuje vedení obchodu. Vidíte jen objednávky napárované
                na vaše klienty.
              </p>
            )}
            <Tabs onValueChange={setTab} size="sm" value={tab} variant="line">
              <Tabs.List>
                <Tabs.Trigger value="orders">{`Objednávky (${String(orders.length)})`}</Tabs.Trigger>
                {lead && <Tabs.Trigger value="batches">{`Historie importů (${String(batches.length)})`}</Tabs.Trigger>}
                <Tabs.Trigger value="template">Šablona a vzorové soubory</Tabs.Trigger>
                <Tabs.Indicator />
              </Tabs.List>
              <Tabs.Content className="flex flex-col gap-200 pt-250" value="orders">
                <div className="flex flex-wrap items-end gap-150">
                  <Input
                    aria-label="Hledat objednávku"
                    className="w-72"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Číslo, ID, zákazník, IČO, stav"
                    size="sm"
                    type="search"
                    value={search}
                  />
                  <div className="w-48">
                    <SelectTemplate
                      items={[
                        { label: 'Všechny objednávky', value: 'all' },
                        { label: 'Napárované', value: 'paired' },
                        ...(lead ? [{ label: 'K napárování', value: 'queue' }] : []),
                        { label: 'Vyžaduje kontrolu', value: 'review' },
                      ]}
                      label="Zobrazit"
                      name="orderFilter"
                      onValueChange={(details) => {
                        const selected = details.value[0] ?? 'all';
                        if (isOrderFilter(selected)) {
                          setFilter(selected);
                        }
                      }}
                      size="sm"
                      value={[filter]}
                    />
                  </div>
                  <div className="w-44">
                    <SelectTemplate
                      items={[
                        { label: 'Všechny zdroje', value: ALL },
                        ...sources.map((entry) => ({ label: entry, value: entry })),
                      ]}
                      label="Zdroj"
                      name="sourceFilter"
                      onValueChange={(details) => setSource(details.value[0] ?? ALL)}
                      size="sm"
                      value={[source]}
                    />
                  </div>
                </div>
                {orders.length === 0 ? (
                  <SectionCard>
                    <EmptyState
                      action={
                        canImport ? (
                          <Button onClick={() => openImport()} size="sm" variant="primary">
                            Importovat CSV
                          </Button>
                        ) : undefined
                      }
                      description={
                        lead
                          ? 'Naimportujte první soubor objednávek.'
                          : 'Vašim klientům zatím nebyla přiřazena žádná objednávka.'
                      }
                      title="Zatím žádné objednávky"
                    />
                  </SectionCard>
                ) : (
                  <DataTable
                    columns={orderColumns(records, formatAmount)}
                    data={visible}
                    enablePagination
                    enableSorting
                    getRowId={(row) => row.id}
                    getRowLabel={(row) => `Objednávka ${orderTitle(row.original)}`}
                    maxHeight="calc(100dvh - 24rem)"
                    onRowClick={(row) => setOrderId(row.original.id)}
                    pageSizeOptions={[50, 100]}
                    paginationProps={crmPaginationProps}
                    size="sm"
                    stickyHeader
                    tableLayout="fixed"
                    translations={crmTableTranslations}
                  />
                )}
              </Tabs.Content>
              {lead && (
                <Tabs.Content className="flex flex-col gap-200 pt-250" value="batches">
                  {batches.length === 0 ? (
                    <SectionCard>
                      <EmptyState
                        description="Každý import se tu uloží s počty a chybami po řádcích."
                        title="Zatím žádný import"
                      />
                    </SectionCard>
                  ) : (
                    <DataTable
                      columns={batchColumns(records)}
                      data={[...batches]}
                      enableSorting
                      getRowId={(row) => row.id}
                      getRowLabel={(row) => `Dávka ${row.original.fileName}`}
                      onRowClick={(row) => setBatchId(row.original.id)}
                      size="sm"
                      tableLayout="fixed"
                      translations={crmTableTranslations}
                    />
                  )}
                </Tabs.Content>
              )}
              <Tabs.Content className="pt-250" value="template">
                <TemplateTab canImport={canImport} onImportSample={openImport} samples={records.importSamples ?? []} />
              </Tabs.Content>
            </Tabs>
            {detail !== undefined && (
              <OrderDetailPanel
                busy={busy}
                key={detail.id}
                onClose={() => setOrderId(undefined)}
                order={detail}
                records={records}
                submit={submit}
              />
            )}
            <BatchPanel
              batch={batches.find((batch) => batch.id === batchId)}
              onClose={() => setBatchId(undefined)}
              records={records}
            />
            {canImport && importOpen && (
              <ImportPanel
                busy={busy}
                {...initialImport}
                onClose={() => setImportOpen(false)}
                onImported={(id) => {
                  setImportOpen(false);
                  setTab('batches');
                  setBatchId(id);
                }}
                records={records}
                submit={submit}
              />
            )}
          </>
        );
      }}
    </CrmStateGate>
  );
};

export const ImportsPage = () => (
  <CrmPage titleKey="crm.pages.imports.title">
    <ImportsContent />
  </CrmPage>
);

/** The Shell awaits this before it reveals the page, so the first render already has the records. */
export { preloadCrmRecords as preloadPage } from '../../../../crm/records.ts';
export default ImportsPage;
