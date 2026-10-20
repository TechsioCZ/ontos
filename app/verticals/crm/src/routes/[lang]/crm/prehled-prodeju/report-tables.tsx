// Tables of the sales report (crm-reports lane): grouped summary, order rows, status mapping, items by SKU.
import { EmptyState, SectionCard, formatDate, formatNumber } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import type { CrmState } from '../../../../../shared/domain/state.ts';
import type {
  ReportGroup,
  ReportOrderRow,
  SalesReport,
  StatusMeaningOrUnmapped,
} from '../../../../../shared/domain/reports.ts';
import {
  UNASSIGNED,
  clientSalesFacts,
  orderMoney,
  rawStatusesInUse,
  statusMapping,
  statusMeaningLabels,
  unitsToDecimal,
} from '../../../../../shared/domain/reports.ts';
import { crmPaginationProps, crmTableTranslations } from '../../../../crm/ui.tsx';
import { formatDecimalMoney, totalIn } from './report-format.ts';

export type GroupingKey = 'salesperson' | 'client' | 'month' | 'status';

export const groupingLabels: Record<GroupingKey, string> = {
  client: 'Klient',
  month: 'Měsíc',
  salesperson: 'Obchodník',
  status: 'Význam stavu',
};

export const groupsOf = (report: SalesReport, grouping: GroupingKey): readonly ReportGroup[] => {
  switch (grouping) {
    case 'client':
      return report.byClient;
    case 'month':
      return report.byMonth.toReversed();
    case 'salesperson':
      return report.bySalesperson;
    case 'status':
      return report.byStatus;
  }
};

const meaningVariant: Record<StatusMeaningOrUnmapped, 'outline' | 'info' | 'success' | 'warning' | 'danger'> = {
  cancelled: 'outline',
  fulfilled: 'success',
  open: 'info',
  paid: 'success',
  unmapped: 'warning',
};

export const MeaningBadge = ({ meaning }: { readonly meaning: StatusMeaningOrUnmapped }) => (
  <Badge size="sm" variant={meaningVariant[meaning]}>
    {statusMeaningLabels[meaning]}
  </Badge>
);

export const clientCardHref = (lang: string, clientId: string) =>
  `/${lang}/crm/klienti?klient=${encodeURIComponent(clientId)}`;

const linkClass = 'font-medium underline decoration-border-primary underline-offset-2 hover:decoration-current';

// ---------------------------------------------------------------------------------------------------------------

export interface SummaryTableProps {
  readonly grouping: GroupingKey;
  readonly lang: string;
  readonly onExport: () => void;
  readonly onGroupingChange: (grouping: GroupingKey) => void;
  /** Narrow the whole report to one group (drill-down inside the report). */
  readonly onPick: (grouping: GroupingKey, key: string) => void;
  readonly report: SalesReport;
  readonly state: CrmState;
}

/** Summary by salesperson / client / month / status, one value column per currency. */
export const SummaryTable = ({
  grouping,
  lang,
  onExport,
  onGroupingChange,
  onPick,
  report,
  state,
}: SummaryTableProps) => {
  const groups = groupsOf(report, grouping);
  const maxCount = Math.max(1, ...groups.map((group) => group.count));
  return (
    <SectionCard
      actions={
        <>
          <fieldset
            aria-label="Seskupit podle"
            className="inline-flex flex-wrap rounded-button-sm border border-border-primary p-50"
          >
            {(Object.keys(groupingLabels) as GroupingKey[]).map((key) => (
              <Button
                aria-pressed={key === grouping}
                key={key}
                onClick={() => onGroupingChange(key)}
                size="sm"
                theme={key === grouping ? 'solid' : 'borderless'}
                variant={key === grouping ? 'primary' : 'secondary'}
              >
                {groupingLabels[key]}
              </Button>
            ))}
          </fieldset>
          <Button
            disabled={groups.length === 0}
            icon="icon-[mdi--download]"
            onClick={onExport}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Export souhrnu (CSV)
          </Button>
        </>
      }
      flush
      title={`Souhrn podle: ${groupingLabels[grouping].toLowerCase()}`}
    >
      {groups.length === 0 ? (
        <EmptyState description="Pro zvolené filtry neexistuje žádná započtená objednávka." title="Bez dat" />
      ) : (
        <div className="overflow-x-auto px-250 pb-250">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">Souhrn evidovaných objednávek podle: {groupingLabels[grouping]}</caption>
            <thead>
              <tr className="border-border-primary border-b text-left text-fg-secondary">
                <th className="py-100 pr-200 font-medium" scope="col">
                  {groupingLabels[grouping]}
                </th>
                <th className="py-100 pr-200 font-medium" scope="col">
                  Počet objednávek
                </th>
                {report.currencies.map((currency) => (
                  <th className="py-100 pr-200 text-right font-medium" key={currency} scope="col">
                    Hodnota {currency}
                  </th>
                ))}
                <th className="py-100 pr-200 text-right font-medium" scope="col">
                  Poslední objednávka
                </th>
                {grouping === 'client' && (
                  <th className="py-100 text-right font-medium" scope="col">
                    Poslední návštěva
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const clientFacts = grouping === 'client' ? clientSalesFacts(state, group.key) : undefined;
                return (
                  <tr className="border-border-primary border-b last:border-b-0" key={group.key}>
                    <th className="py-100 pr-200 text-left font-normal" scope="row">
                      {grouping === 'client' ? (
                        <a className={linkClass} href={clientCardHref(lang, group.key)}>
                          {group.label}
                        </a>
                      ) : grouping === 'month' && group.count === 0 ? (
                        <span>{group.label}</span>
                      ) : (
                        <button
                          className={`${linkClass} cursor-pointer text-left ${
                            group.key === UNASSIGNED ? 'text-fg-secondary' : ''
                          }`}
                          onClick={() => onPick(grouping, group.key)}
                          title="Zúžit přehled na tuto skupinu"
                          type="button"
                        >
                          {group.label}
                        </button>
                      )}
                    </th>
                    <td className="py-100 pr-200">
                      <span className="flex items-center gap-150">
                        <span className="w-8 text-right tabular-nums">{formatNumber(group.count)}</span>
                        <span aria-hidden className="h-2 w-28 rounded-sm bg-surface-secondary">
                          <span
                            className="block h-full rounded-sm"
                            style={{
                              backgroundColor: 'var(--color-chart-series-1)',
                              width: `${(group.count / maxCount) * 100}%`,
                            }}
                          />
                        </span>
                      </span>
                    </td>
                    {report.currencies.map((currency) => {
                      const total = totalIn(group.totals, currency);
                      return (
                        <td className="py-100 pr-200 text-right tabular-nums" key={currency}>
                          {total === undefined ? (
                            <span className="text-fg-secondary">—</span>
                          ) : (
                            formatDecimalMoney(total.amount, currency)
                          )}
                        </td>
                      );
                    })}
                    <td className="py-100 pr-200 text-right tabular-nums">
                      {group.lastOrderAt === undefined ? (
                        <span className="text-fg-secondary">—</span>
                      ) : (
                        formatDate(group.lastOrderAt)
                      )}
                    </td>
                    {grouping === 'client' && (
                      <td className="py-100 text-right tabular-nums">
                        {clientFacts?.lastVisitAt === undefined ? (
                          <span className="text-fg-secondary">bez záznamu</span>
                        ) : (
                          formatDate(clientFacts.lastVisitAt)
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-border-primary border-t font-semibold">
                <th className="py-100 pr-200 text-left" scope="row">
                  Celkem
                </th>
                <td className="py-100 pr-200">
                  <span className="inline-block w-8 text-right tabular-nums">{formatNumber(report.count)}</span>
                </td>
                {report.currencies.map((currency) => {
                  const total = totalIn(report.totals, currency);
                  return (
                    <td className="py-100 pr-200 text-right tabular-nums" key={currency}>
                      {total === undefined ? '—' : formatDecimalMoney(total.amount, currency)}
                    </td>
                  );
                })}
                <td className="py-100 pr-200 text-right tabular-nums">{formatDate(report.lastOrderAt)}</td>
                {grouping === 'client' && <td />}
              </tr>
            </tfoot>
          </table>
          {report.withoutAmount > 0 && (
            <p className="pt-150 text-fg-secondary text-xs">
              {formatNumber(report.withoutAmount)} započtených objednávek nemá od zdroje částku nebo měnu — jsou v
              počtech, ne v hodnotách (údaj neposkytnut).
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
};

// ---------------------------------------------------------------------------------------------------------------

const orderColumns = (lang: string): ColumnDef<ReportOrderRow>[] => [
  {
    accessorKey: 'date',
    cell: (info) => (
      <span className="tabular-nums">
        {formatDate(info.row.original.date)}
        {info.row.original.dateSource === 'received' && (
          <span className="text-fg-secondary" title="Zdroj neposkytl datum objednávky; použit čas přijetí">
            {' '}
            *
          </span>
        )}
      </span>
    ),
    header: 'Datum',
    meta: { type: 'string', width: 120 },
  },
  {
    accessorFn: (row) => row.order.number ?? row.order.externalId,
    cell: (info) => (
      <span className="flex flex-col">
        <span className="font-medium">{info.getValue<string>()}</span>
        <span className="text-fg-secondary text-xs">{info.row.original.order.source}</span>
      </span>
    ),
    header: 'Objednávka / zdroj',
    id: 'number',
    meta: { type: 'string', width: 170 },
  },
  {
    accessorKey: 'clientName',
    cell: (info) => (
      <a className={linkClass} href={clientCardHref(lang, info.row.original.clientId)}>
        {info.getValue<string>()}
      </a>
    ),
    header: 'Klient',
    meta: { type: 'string', width: 230 },
  },
  {
    accessorFn: (row) => row.salespersonName ?? 'Nepřiděleno',
    header: 'Obchodník',
    id: 'salesperson',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorFn: (row) => row.order.rawStatus,
    cell: (info) => (
      <span className="flex flex-wrap items-center gap-100">
        <code className="rounded-sm bg-surface-secondary px-50 text-xs">{info.getValue<string>()}</code>
        <MeaningBadge meaning={info.row.original.meaning} />
        {info.row.original.order.statusHistory.some((event) => event.review === true) && (
          <Badge size="sm" variant="warning">
            Sporná změna stavu
          </Badge>
        )}
      </span>
    ),
    header: 'Stav ze zdroje → význam',
    id: 'status',
    meta: { type: 'string', width: 280 },
  },
  {
    accessorFn: (row) => {
      const money = orderMoney(row.order);
      return money === undefined ? Number.NEGATIVE_INFINITY : Number(unitsToDecimal(money.units));
    },
    cell: (info) => {
      const money = orderMoney(info.row.original.order);
      return money === undefined ? (
        <span className="text-fg-secondary">údaj neposkytnut</span>
      ) : (
        <span className="tabular-nums">{formatDecimalMoney(unitsToDecimal(money.units), money.currency)}</span>
      );
    },
    header: 'Částka',
    id: 'amount',
    meta: { align: 'end', type: 'number', width: 140 },
  },
];

export const OrdersTable = ({ lang, report }: { readonly lang: string; readonly report: SalesReport }) => (
  <DataTable
    columns={orderColumns(lang)}
    data={[...report.rows]}
    enablePagination
    enableSorting
    getRowId={(row) => row.order.id}
    getRowLabel={(row) => row.original.order.number ?? row.original.order.externalId}
    pageSizeOptions={[25, 50, 100]}
    paginationProps={crmPaginationProps}
    size="sm"
    tableLayout="fixed"
    translations={{
      ...crmTableTranslations,
      emptyDescription: 'Pro zvolené filtry neexistuje žádná započtená objednávka.',
      emptyTitle: 'Bez dat',
    }}
  />
);

// ---------------------------------------------------------------------------------------------------------------

/** The raw -> meaning mapping for the statuses that really occur, plus the metric definition. */
export const StatusMappingCard = ({ state }: { readonly state: CrmState }) => {
  const statuses = rawStatusesInUse(state);
  return (
    <SectionCard
      title={`Význam stavů a definice metrik (mapování ${statusMapping.version}, schváleno ${formatDate(statusMapping.approvedOn)})`}
    >
      <div className="grid min-w-0 grid-cols-1 gap-250 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {statuses.length === 0 ? (
          <p className="text-fg-secondary text-sm">Zatím nebyla importována žádná objednávka — bez dat.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Mapování surových stavů ze zdroje na význam pro přehled</caption>
            <thead>
              <tr className="border-border-primary border-b text-left text-fg-secondary">
                <th className="py-100 pr-200 font-medium" scope="col">
                  Surový stav
                </th>
                <th className="py-100 pr-200 font-medium" scope="col">
                  Zdroj
                </th>
                <th className="py-100 font-medium" scope="col">
                  Význam pro přehled
                </th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((status) => (
                <tr className="border-border-primary border-b last:border-b-0" key={status.raw}>
                  <th className="py-100 pr-200 text-left font-normal" scope="row">
                    <code className="rounded-sm bg-surface-secondary px-50 text-xs">{status.raw}</code>
                  </th>
                  <td className="py-100 pr-200 text-fg-secondary">{status.sources.join(', ')}</td>
                  <td className="py-100">
                    <MeaningBadge meaning={status.meaning} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="flex flex-col gap-150 text-sm">
          <div>
            <dt className="font-medium">Evidované objednávky</dt>
            <dd className="text-fg-secondary">
              Importované objednávky spárované s klientem, bez nepotvrzených duplicit ze dvou zdrojů. Objednávky „k
              napárování“, „vyžaduje kontrolu“ a možné duplikáty jsou mimo přehled a uvedeny bokem.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Hodnota objednávek</dt>
            <dd className="text-fg-secondary">
              Součet importovaných částek tak, jak je poslal zdroj, zvlášť pro každou měnu (žádný přepočet). Není to
              realizovaná tržba, zisk ani částka bez DPH.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Obchodník</dt>
            <dd className="text-fg-secondary">
              Aktuálně přidělený obchodník klienta. Po převodu klienta se souhrn odvozuje z nové platné vazby.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Význam stavů</dt>
            <dd className="text-fg-secondary">
              Stav ze zdroje zůstává vždy viditelný. Stav mimo mapování je „bez schváleného významu“. Definitivní význam
              storen a vratek potvrdí zákazník (R04).
            </dd>
          </div>
        </dl>
      </div>
    </SectionCard>
  );
};

// ---------------------------------------------------------------------------------------------------------------

/** Item sales by SKU — only from orders whose source really sent lines (C05-03: otherwise "bez dat", never 0). */
export const ItemsCard = ({ report }: { readonly report: SalesReport }) => (
  <SectionCard title="Prodejnost položek (SKU)">
    {report.items.ordersWithLines === 0 ? (
      <EmptyState
        description="Zdroj u započtených objednávek položky neposkytl. Nejde o nulový prodej."
        title="Položky neposkytnuty — bez dat"
      />
    ) : (
      <div className="flex flex-col gap-150">
        <p className="text-fg-secondary text-sm">
          Položky dodal zdroj u {formatNumber(report.items.ordersWithLines)} z {formatNumber(report.count)} započtených
          objednávek; u ostatních položky neposkytnuty. Množství je součet řádků, jak je zdroj poslal (vratky a
          dobropisy zatím nemají schválený význam).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] border-collapse text-sm">
            <caption className="sr-only">Prodané množství podle SKU</caption>
            <thead>
              <tr className="border-border-primary border-b text-left text-fg-secondary">
                <th className="py-100 pr-200 font-medium" scope="col">
                  SKU
                </th>
                <th className="py-100 pr-200 font-medium" scope="col">
                  Položka
                </th>
                <th className="py-100 pr-200 text-right font-medium" scope="col">
                  Množství
                </th>
                <th className="py-100 text-right font-medium" scope="col">
                  V objednávkách
                </th>
              </tr>
            </thead>
            <tbody>
              {report.items.rows.map((item) => (
                <tr className="border-border-primary border-b last:border-b-0" key={item.key}>
                  <td className="py-100 pr-200">
                    {item.sku === undefined ? (
                      <span className="text-fg-secondary">neuvedeno</span>
                    ) : (
                      <code className="text-xs">{item.sku}</code>
                    )}
                  </td>
                  <th className="py-100 pr-200 text-left font-normal" scope="row">
                    {item.name}
                  </th>
                  <td className="py-100 pr-200 text-right tabular-nums">{item.quantity.replace('.', ',')}</td>
                  <td className="py-100 text-right tabular-nums">{formatNumber(item.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </SectionCard>
);
