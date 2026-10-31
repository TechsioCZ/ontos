import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { pipe, Match, Schema } from 'effect';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
// Tables of the sales report (crm-reports lane): grouped summary, order rows, status mapping, items by SKU.
import { EmptyState, SectionCard, formatDate, formatNumber } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';

import type { CrmState } from '../../../../../shared/domain/state.ts';
import {
  UNASSIGNED,
  clientSalesFacts,
  orderMoney,
  ordersCsv,
  toCsv,
  statusMeaningLabels,
  unitsToDecimal,
} from '../../../../../shared/domain/reports.ts';
import type {
  ReportGroup,
  ReportOrderRow,
  SalesReport,
  StatusMeaningOrUnmapped,
} from '../../../../../shared/domain/reports.ts';

import { crmPaginationProps, crmTableTranslations } from '../../../../crm/ui.tsx';
import { orderStatusLabel } from '../../../../crm/order-status-presentation.ts';
import { downloadCsv, useFormatDecimalMoney, totalIn } from './report-format.ts';

const groupingKeys = ['client', 'month', 'salesperson', 'status'] as const;
export const GroupingKeySchema = Schema.Literals(groupingKeys);
export type GroupingKey = typeof GroupingKeySchema.Type;

export const groupingLabels = {
  client: 'Klient',
  month: 'Měsíc',
  salesperson: 'Obchodník',
  status: 'Stav',
} satisfies Record<GroupingKey, string>;

export const groupsOf = (report: SalesReport, grouping: GroupingKey): readonly ReportGroup[] =>
  Match.value(grouping).pipe(
    Match.when('client', () => report.byClient),
    Match.when('month', () => report.byMonth.toReversed()),
    Match.when('salesperson', () => report.bySalesperson),
    Match.when('status', () => report.byStatus),
    Match.exhaustive,
  );

// Match the summary's displayed columns and order, including absent values (never invented zeroes).
export const summaryCsv = (report: SalesReport, grouping: GroupingKey, state: CrmState) =>
  toCsv(
    [
      groupingLabels[grouping],
      'Počet objednávek',
      ...report.currencies.map((currency) => `Hodnota ${currency}`),
      'Poslední objednávka',
      ...(grouping === 'client' ? ['Poslední návštěva'] : []),
    ],
    groupsOf(report, grouping).map((group) => [
      group.label,
      group.count,
      ...report.currencies.map((currency) => totalIn(group.totals, currency)?.amount.replace('.', ',') ?? '—'),
      group.lastOrderAt === undefined ? '—' : pipe(group.lastOrderAt, orderDateText, formatDate),
      ...(grouping === 'client'
        ? [
            clientSalesFacts(state, group.key).lastVisitAt === undefined
              ? 'bez návštěvy'
              : pipe(clientSalesFacts(state, group.key).lastVisitAt, orderDateText, formatDate),
          ]
        : []),
    ]),
  );

const meaningVariant = {
  cancelled: 'outline',
  fulfilled: 'success',
  open: 'info',
  paid: 'success',
  unmapped: 'warning',
} satisfies Record<StatusMeaningOrUnmapped, 'outline' | 'info' | 'success' | 'warning' | 'danger'>;

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

/** Link or drill down for one group label. */
const GroupLabel = ({
  group,
  grouping,
  lang,
  onPick,
}: {
  readonly group: ReportGroup;
  readonly grouping: GroupingKey;
  readonly lang: string;
  readonly onPick: (grouping: GroupingKey, key: string) => void;
}) => {
  if (grouping === 'client') {
    return (
      <a className={linkClass} href={clientCardHref(lang, group.key)}>
        {group.label}
      </a>
    );
  }
  if (grouping === 'month' && group.count === 0) {
    return <span>{group.label}</span>;
  }
  return (
    <button
      aria-label={`${group.label}: Zúžit přehled na tuto skupinu`}
      className={`${linkClass} cursor-pointer text-left ${group.key === UNASSIGNED ? 'text-fg-secondary' : ''}`}
      onClick={() => onPick(grouping, group.key)}
      type="button"
    >
      {group.label}
    </button>
  );
};

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
  const { t } = useModernI18n();
  const formatDecimalMoney = useFormatDecimalMoney();
  const groups = groupsOf(report, grouping);
  const maxCount = Math.max(1, ...groups.map((group) => group.count));
  return (
    <SectionCard
      actions={
        <>
          <fieldset
            aria-label={t('crm.ciWorkflow.groupBy')}
            className="inline-flex flex-wrap rounded-button-sm bg-surface p-50"
          >
            {groupingKeys.map((key) => (
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
        <EmptyState
          description="Pro zvolené filtry neexistuje žádná započtená objednávka."
          title={t('crm.ciWorkflow.noData')}
        />
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
                    <span className="sr-only"> · Jen osobní návštěvy; telefonáty a e-maily se nepočítají</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const clientFacts = grouping === 'client' ? clientSalesFacts(state, group.key) : undefined;
                return (
                  <tr className="border-border-primary/60 border-b last:border-b-0" key={group.key}>
                    <th className="py-100 pr-200 text-left font-normal" scope="row">
                      <GroupLabel group={group} grouping={grouping} lang={lang} onPick={onPick} />
                    </th>
                    <td aria-label={formatNumber(group.count)} className="py-100 pr-200">
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
                        pipe(group.lastOrderAt, orderDateText, formatDate)
                      )}
                    </td>
                    {grouping === 'client' && (
                      <td className="py-100 text-right tabular-nums">
                        {clientFacts?.lastVisitAt === undefined ? (
                          <span className="text-fg-secondary">bez návštěvy</span>
                        ) : (
                          pipe(clientFacts.lastVisitAt, orderDateText, formatDate)
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
                <td className="py-100 pr-200 text-right tabular-nums">
                  {pipe(report.lastOrderAt, orderDateText, formatDate)}
                </td>
                {grouping === 'client' && <td>—</td>}
              </tr>
            </tfoot>
          </table>
          {report.withoutAmount > 0 && (
            <p className="pt-150 text-fg-secondary text-xs">
              Počet započtených objednávek bez částky nebo měny od zdroje: {formatNumber(report.withoutAmount)}. Do
              hodnot se nezahrnují (údaj neposkytnut).
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
};

// ---------------------------------------------------------------------------------------------------------------

const orderColumns = (
  lang: string,
  formatDecimalMoney: ReturnType<typeof useFormatDecimalMoney>,
): ColumnDef<ReportOrderRow>[] => [
  {
    accessorFn: (row) => orderDateText(row.date),
    cell: (info) => (
      <span className="tabular-nums">
        {pipe(info.row.original.date, orderDateText, formatDate)}
        {info.row.original.dateSource === 'received' && (
          <span className="text-fg-secondary">
            <span aria-hidden> *</span>
            <span className="sr-only"> · Zdroj neposkytl datum objednávky; použit čas přijetí</span>
          </span>
        )}
      </span>
    ),
    header: 'Datum',
    id: 'date',
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
        <span>{orderStatusLabel(info.getValue<string>())}</span>
        {info.row.original.meaning !== 'unmapped' && <MeaningBadge meaning={info.row.original.meaning} />}
        {info.row.original.order.statusHistory.some((event) => event.review === true) && (
          <Badge size="sm" variant="warning">
            Sporná změna stavu
          </Badge>
        )}
      </span>
    ),
    header: 'Stav objednávky',
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

export const OrdersTable = ({
  fileName,
  lang,
  report,
}: {
  readonly fileName: string;
  readonly lang: string;
  readonly report: SalesReport;
}) => {
  const formatDecimalMoney = useFormatDecimalMoney();
  return (
    <DataTable
      columns={orderColumns(lang, formatDecimalMoney)}
      data={[...report.rows]}
      enablePagination
      enableSorting
      getRowId={(row) => row.order.id}
      getRowLabel={(row) => row.original.order.number ?? row.original.order.externalId}
      pageSizeOptions={[25, 50, 100]}
      paginationProps={crmPaginationProps}
      renderToolbar={(table) => (
        <div className="flex flex-wrap items-center justify-between gap-150">
          <span className="text-fg-secondary text-sm">
            CSV obsahuje pouze aktuální stránku, ve zvoleném pořadí. Pro všechny řádky zvyšte počet na stránku.
          </span>
          <Button
            disabled={table.getRowModel().rows.length === 0}
            icon="icon-[mdi--download]"
            onClick={() =>
              downloadCsv(ordersCsv({ ...report, rows: table.getRowModel().rows.map((row) => row.original) }), fileName)
            }
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Export objednávek (CSV)
          </Button>
        </div>
      )}
      size="sm"
      tableLayout="fixed"
      translations={{
        ...crmTableTranslations,
        emptyDescription: 'Pro zvolené filtry neexistuje žádná započtená objednávka.',
        emptyTitle: 'Bez dat',
      }}
    />
  );
};

// ---------------------------------------------------------------------------------------------------------------

/** Item sales by SKU — only from orders whose source really sent lines (C05-03: otherwise "bez dat", never 0). */
export const ItemsCard = ({ report }: { readonly report: SalesReport }) => {
  const { t } = useModernI18n();
  return (
    <SectionCard title={t('crm.ciWorkflow.importedSkuItems')}>
      {report.items.ordersWithLines === 0 ? (
        <EmptyState
          description="Zdroj u započtených objednávek položky neposkytl. Nejde o nulový prodej."
          title={t('crm.ciWorkflow.itemsNotProvided')}
        />
      ) : (
        <div className="flex flex-col gap-150">
          <p className="text-fg-secondary text-sm">
            Položky dodal zdroj u {formatNumber(report.items.ordersWithLines)} z {formatNumber(report.count)}{' '}
            započtených objednávek; u ostatních položky chybí. Množství odpovídá importovaným řádkům objednávek, nikoli
            čistému prodeji po odečtení vratek a dobropisů.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <caption className="sr-only">Importované množství podle SKU, nikoli potvrzený prodej</caption>
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
                  <tr className="border-border-primary/60 border-b last:border-b-0" key={item.key}>
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
};
