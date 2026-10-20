// AREA: reports (C05) — owned by the crm-reports lane. "Přehled prodejů": confirmed imported orders by period,
// salesperson, client and status meaning; values strictly per currency; excluded orders reported aside; CSV export
// of exactly the rows shown; drill-down to the client card. Data = the ACL-projected records of the signed-in
// principal (a salesperson only ever receives own clients, so the report and the CSV cannot contain others).
import { PageHeader, formatDateTime } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';
import { buildSalesReport, exclusionReasonLabels } from '../../../../../shared/domain/reports.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmStateGate } from '../../../../crm/ui.tsx';
import { ReportCharts } from './report-charts.tsx';
import type { ReportQuery } from './report-filters.tsx';
import {
  ALL,
  ReportFilterBar,
  describeFilters,
  filtersOf,
  readQuery,
  reportPeriodOptions,
  writeQuery,
} from './report-filters.tsx';
import { downloadCsv } from './report-format.ts';
import type { GroupingKey } from './report-tables.tsx';
import {
  ItemsCard,
  OrdersTable,
  StatusMappingCard,
  SummaryTable,
  groupingLabels,
  summaryCsv,
} from './report-tables.tsx';
import { SalesKpiTiles } from './sales-kpi-strip.tsx';

const fileSlug = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '');

const ReportView = ({ records }: { readonly records: RecordsResponse }) => {
  const { language } = useModernI18n();
  const lang = language ?? 'cs';
  const [query, setQueryState] = useState<ReportQuery>(readQuery);
  const setQuery = (patch: Partial<ReportQuery>) => {
    const next = { ...query, ...patch };
    setQueryState(next);
    writeQuery(next);
  };
  const scopeAll = canSeeEverything(records.viewer);
  const periods = reportPeriodOptions(records);
  const report = buildSalesReport(records.state, filtersOf(query, periods));
  const filterParts = describeFilters(query, records, periods);
  const stamp = records.now.slice(0, 10);
  const fileBase = `prehled-prodeju-${stamp}-${fileSlug(filterParts.join(' '))}`;
  const anyOrders = records.state.imports.orders.length > 0;

  const pick = (grouping: GroupingKey, key: string) => {
    if (grouping === 'salesperson') {
      setQuery({ grouping: 'client', salesperson: key });
    } else if (grouping === 'status') {
      setQuery({ status: `m:${key}` });
    } else if (grouping === 'month') {
      setQuery({ grouping: 'client', period: key });
    }
  };

  return (
    <>
      <PageHeader
        description="Počty a hodnoty importovaných objednávek spárovaných s klienty, po obdobích, obchodnících, klientech a stavech. Každá měna zvlášť."
        meta={
          scopeAll ? (
            <Badge size="sm" variant="info">
              Všichni klienti firmy
            </Badge>
          ) : (
            <Badge size="sm" variant="warning">
              Jen vaši klienti
            </Badge>
          )
        }
        title="Přehled prodejů"
      />

      <ReportFilterBar onChange={setQuery} periods={periods} query={query} records={records} scopeAll={scopeAll} />

      <div className="flex flex-col gap-50 text-sm">
        <p>
          <span className="text-fg-secondary">Zdroj: </span>
          importované objednávky
          {report.sources.length > 0 ? ` (${report.sources.join(', ')})` : ''}
          <span className="text-fg-secondary"> · Filtry: </span>
          {filterParts.join(', ')}
          <span className="text-fg-secondary"> · Stav dat: </span>
          {formatDateTime(records.now)}
        </p>
        {scopeAll ? (
          <p
            className={
              report.excludedTotal > 0
                ? 'rounded-md border border-border-primary bg-surface-secondary px-150 py-100'
                : 'text-fg-secondary'
            }
            data-testid="crm-report-excluded"
          >
            {report.excludedTotal > 0 ? (
              <>
                <span className="font-semibold">Vyloučeno z přehledu: {report.excludedTotal} </span>
                {report.excludedTotal === 1 ? 'objednávka' : report.excludedTotal < 5 ? 'objednávky' : 'objednávek'} (
                {report.excluded.map((entry) => `${entry.count}× ${exclusionReasonLabels[entry.reason]}`).join('; ')}
                ). Počet vyloučených záznamů platí pro celé zvolené období, bez filtru klienta, obchodníka a stavu.{' '}
                <a className="underline underline-offset-2" href={`/${lang}/crm/parovani`}>
                  Otevřít párování
                </a>
              </>
            ) : (
              'Vyloučeno z přehledu: 0 objednávek — v daném období nejsou nespárované ani sporné objednávky.'
            )}
          </p>
        ) : (
          <p className="text-fg-secondary">
            Vidíte jen objednávky svých klientů. Nespárované objednávky a importní dávky vidí a řeší vedení.
          </p>
        )}
        {report.reviewEvents > 0 && (
          <p className="text-fg-secondary">
            Počet započtených objednávek se změnou stavu v nejistém pořadí: {report.reviewEvents} (označení „Sporná
            změna stavu“). Přehled používá poslední potvrzený stav.
          </p>
        )}
        {report.rowsWithReceivedDate > 0 && (
          <p className="text-fg-secondary">
            * Počet objednávek bez data objednávky od zdroje: {report.rowsWithReceivedDate}. Pro období se použije čas
            přijetí.
          </p>
        )}
      </div>

      {anyOrders ? (
        <>
          <SalesKpiTiles report={report} scopeAll={scopeAll} />
          <ReportCharts report={report} />
          <SummaryTable
            grouping={query.grouping}
            lang={lang}
            onExport={() =>
              downloadCsv(
                summaryCsv(report, query.grouping, records.state),
                `${fileBase}-souhrn-${fileSlug(groupingLabels[query.grouping])}.csv`,
              )
            }
            onGroupingChange={(grouping) => setQuery({ grouping })}
            onPick={pick}
            report={report}
            state={records.state}
          />
          <section className="flex min-w-0 flex-col gap-150">
            <div className="flex flex-wrap items-baseline justify-between gap-150">
              <h2 className="font-semibold text-md">Započtené objednávky ({report.rows.length})</h2>
              <span className="text-fg-secondary text-sm">
                Kliknutím na klienta otevřete kartu klienta. Export obsahuje přesně tyto řádky.
              </span>
            </div>
            <OrdersTable fileName={`${fileBase}-objednavky.csv`} lang={lang} report={report} />
          </section>
          <ItemsCard report={report} />
        </>
      ) : (
        <div className="rounded-lg border border-border-primary bg-surface">
          <div className="flex flex-col items-center gap-150 p-450 text-center">
            <p className="font-semibold text-md">Bez dat</p>
            <p className="max-w-prose text-fg-secondary text-sm">
              {scopeAll
                ? 'Zatím nebyly importovány žádné objednávky. Po CSV importu se zde objeví počty a hodnoty po měsících, obchodnících a klientech.'
                : 'Vaši klienti zatím nemají žádné spárované objednávky.'}
            </p>
            {scopeAll && (
              <a className="text-sm underline underline-offset-2" href={`/${lang}/crm/importy`}>
                Přejít na import objednávek
              </a>
            )}
          </div>
        </div>
      )}
      <StatusMappingCard state={records.state} />
      {query.client !== ALL && (
        <p className="text-fg-secondary text-sm">
          Filtr klienta je aktivní.{' '}
          <a className="underline underline-offset-2" href={`/${lang}/crm/klienti?klient=${query.client}`}>
            Otevřít kartu klienta
          </a>
        </p>
      )}
    </>
  );
};

const ReportsContent = () => {
  const { load, state } = useCrmRecords();
  return (
    <CrmStateGate loadingTitle="Přehled prodejů" onRetry={load} state={state}>
      {(records) => <ReportView records={records} />}
    </CrmStateGate>
  );
};

export const ReportsPage = () => (
  <CrmPage titleKey="crm.pages.reports.title">
    <ReportsContent />
  </CrmPage>
);

export default ReportsPage;
