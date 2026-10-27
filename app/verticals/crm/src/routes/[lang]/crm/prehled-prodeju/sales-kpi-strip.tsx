import { pipe } from 'effect';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
// Compact sales KPI strip (crm-reports lane) for the CRM home and the report page. Facts over the ACL-projected
// records only: confirmed order count, value per currency (never summed across currencies), excluded orders.
import { StatCard, StatRow, formatDate, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { buildSalesReport, exclusionReasonLabels } from '../../../../../shared/domain/reports.ts';
import type { SalesReport } from '../../../../../shared/domain/reports.ts';

import { useFormatDecimalMoney } from './report-format.ts';

const ordersWord = (count: number) => {
  if (count === 1) {
    return 'objednávka';
  }
  return count >= 2 && count <= 4 ? 'objednávky' : 'objednávek';
};

export const excludedSummary = (report: SalesReport) =>
  report.excluded.map((entry) => `${formatNumber(entry.count)} ${exclusionReasonLabels[entry.reason]}`).join(', ');

/**
 * "21 objednávek · z toho stornované 1 240 Kč · není to tržba" — the cancelled share only with an approved mapping;
 * otherwise the sum is explicitly "včetně všech stavů ze zdroje".
 */
const valueHint = (
  report: SalesReport,
  currency: string,
  count: number,
  formatDecimalMoney: ReturnType<typeof useFormatDecimalMoney>,
) => {
  const cancelled = report.byStatus
    .find((group) => group.key === 'cancelled')
    ?.totals.find((total) => total.currency === currency);
  const parts = [`${formatNumber(count)} ${ordersWord(count)}`];
  // "stornované" is a business meaning: shown only once the customer approved the status mapping (R04).
  if (report.mappingApproved && cancelled !== undefined) {
    parts.push(`z toho stornované ${formatDecimalMoney(cancelled.amount, currency)}`);
  }
  if (!report.mappingApproved) {
    parts.push('včetně všech stavů ze zdroje');
  }
  parts.push('není to tržba ani zisk');
  return parts.join(' · ');
};

/** KPI tiles for a computed report. */
export const SalesKpiTiles = ({ report, scopeAll }: { readonly report: SalesReport; readonly scopeAll: boolean }) => {
  const formatDecimalMoney = useFormatDecimalMoney();
  const { t } = useModernI18n();
  const noData = t('crm.common.noData');
  return (
    <StatRow>
      <StatCard
        hint={
          report.count === 0
            ? noData
            : `Poslední ${pipe(report.lastOrderAt, orderDateText, formatDate)} · spárované, bez duplicit`
        }
        label="Evidované objednávky"
        value={formatNumber(report.count)}
      />
      {report.totals.length === 0 ? (
        <StatCard hint="Žádná objednávka s částkou a měnou" label="Hodnota evidovaných objednávek" value={noData} />
      ) : (
        report.totals.map((total) => (
          <StatCard
            hint={valueHint(report, total.currency, total.count, formatDecimalMoney)}
            key={total.currency}
            label={`Hodnota objednávek v ${total.currency}`}
            value={formatDecimalMoney(total.amount, total.currency)}
          />
        ))
      )}
      {scopeAll ? (
        <StatCard
          hint={report.excludedTotal === 0 ? 'Všechny objednávky jsou spárované' : excludedSummary(report)}
          label="Vyloučeno z přehledu"
          value={formatNumber(report.excludedTotal)}
        />
      ) : (
        <StatCard
          hint="Nespárované objednávky řeší vedení"
          label="Klienti s objednávkou"
          value={formatNumber(report.byClient.length)}
        />
      )}
    </StatRow>
  );
};

/**
 * CRM home strip: <CrmSalesKpiStrip records={records} /> (records from useCrmRecords). Links to the full report.
 */
export const CrmSalesKpiStrip = ({ records }: { readonly records: RecordsResponse }) => {
  const { language } = useModernI18n();
  const report = buildSalesReport(records.state);
  const scopeAll = records.viewer.readAll || records.viewer.writeAll;
  return (
    <section aria-label="Prodeje v kostce" className="flex min-w-0 flex-col gap-100">
      <div className="flex flex-wrap items-baseline justify-between gap-150">
        <h2 className="font-semibold text-md">Prodeje v kostce</h2>
        <a className="text-sm underline underline-offset-2" href={`/${language ?? 'cs'}/crm/prehled-prodeju`}>
          Přehled prodejů →
        </a>
      </div>
      <SalesKpiTiles report={report} scopeAll={scopeAll} />
    </section>
  );
};
