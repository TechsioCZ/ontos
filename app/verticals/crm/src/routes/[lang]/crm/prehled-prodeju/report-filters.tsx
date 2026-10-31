// Filter bar of the sales report (crm-reports lane): období, obchodník, klient, stav (mapped meaning or raw).
// Filters live in the URL (?obdobi=&obchodnik=&klient=&stav=&seskupit=) so a drill-down and back keeps them.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Schema } from 'effect';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
import type { ReportFilters } from '../../../../../shared/domain/reports.ts';
import {
  UNASSIGNED,
  normalizeStatus,
  orderDate,
  rawStatusesInUse,
  reportMappingApproved,
  statusMeaningLabels,
  statusMeanings,
} from '../../../../../shared/domain/reports.ts';
import { orderStatusLabel } from '../../../../crm/order-status-presentation.ts';
import type { ReportQuery } from '../../../../crm/report-query.ts';
import { ALL, periodOf, periodWithDate } from '../../../../crm/report-query.ts';
import type { PeriodOption } from './report-format.ts';
import { periodOptions } from './report-format.ts';
import { formatDate, surfaceTileClassName } from '@app/admin-ui';

export type { ReportQuery } from '../../../../crm/report-query.ts';
export { ALL, readQuery, writeQuery } from '../../../../crm/report-query.ts';

const isStatusMeaning = Schema.is(Schema.Literals(statusMeanings));

export const reportPeriodOptions = (records: RecordsResponse) =>
  periodOptions(
    records.now,
    records.state.imports.orders.map((order) => orderDateText(orderDate(order)).slice(0, 7)),
  );

/** Query -> domain filters. Unknown values fall back to "all" (e.g. a client the viewer may not see). */
export const filtersOf = (query: ReportQuery, periods: readonly PeriodOption[]): ReportFilters => {
  const period = periodOf(query.period, periods);
  let status: ReportFilters['status'];
  if (query.status.startsWith('m:')) {
    const meaning = query.status.slice(2);
    status = isStatusMeaning(meaning) ? { kind: 'meaning', meaning } : undefined;
  } else if (query.status.startsWith('r:')) {
    status = { kind: 'raw', raw: query.status.slice(2) };
  }
  const filters: { -readonly [Key in keyof ReportFilters]: ReportFilters[Key] } = {};
  if (period !== undefined) {
    filters.period = period;
  }
  if (query.salesperson !== ALL) {
    filters.salespersonId = query.salesperson;
  }
  if (query.client !== ALL) {
    filters.clientId = query.client;
  }
  if (status !== undefined) {
    filters.status = status;
  }
  return filters;
};

/** "Filtry: …" sentence for the source line and the CSV file name. */
export const describeFilters = (
  query: ReportQuery,
  records: RecordsResponse,
  periods: readonly PeriodOption[],
): string[] => {
  const parts: string[] = [];
  const preset = periods.find((option) => option.value === query.period);
  const period = periodOf(query.period, periods);
  const range = [
    period?.from === undefined ? '' : `≥ ${formatDate(period.from)}`,
    period?.to === undefined ? '' : `≤ ${formatDate(period.to)}`,
  ].filter(Boolean);
  parts.push(`období ${preset?.label.toLowerCase() ?? (range.length > 0 ? range.join(', ') : 'celé')}`);
  if (query.salesperson !== ALL) {
    parts.push(
      `obchodník ${
        query.salesperson === UNASSIGNED
          ? 'nepřiděleno'
          : (records.state.salespeople.find((person) => person.id === query.salesperson)?.name ?? '—')
      }`,
    );
  }
  if (query.client !== ALL) {
    parts.push(`klient ${records.state.clients.items.find((client) => client.id === query.client)?.name ?? '—'}`);
  }
  if (query.status.startsWith('m:')) {
    const meaning = query.status.slice(2);
    parts.push(`stav ${isStatusMeaning(meaning) ? statusMeaningLabels[meaning] : '—'}`);
  } else if (query.status.startsWith('r:')) {
    parts.push(`stav ze zdroje „${orderStatusLabel(query.status.slice(2))}“`);
  }
  return parts;
};

const labelProps = { className: 'text-label-sm text-fg-secondary' };

export interface ReportFilterBarProps {
  readonly onChange: (patch: Partial<ReportQuery>) => void;
  readonly periods: readonly PeriodOption[];
  readonly query: ReportQuery;
  readonly records: RecordsResponse;
  readonly scopeAll: boolean;
}

export const ReportFilterBar = ({ onChange, periods, query, records, scopeAll }: ReportFilterBarProps) => {
  const { t } = useModernI18n();
  const period = periodOf(query.period, periods) ?? {};
  const periodItems = periods.map((option) => ({ label: option.label, value: option.value }));
  if (query.period.includes(':') && periodOf(query.period, periods) !== undefined) {
    periodItems.push({ label: t('crm.reports.customPeriod'), value: query.period });
  }
  const salespeopleItems = [
    { label: 'Všichni obchodníci', value: ALL },
    ...records.state.salespeople.map((person) => ({
      label: person.active ? person.name : `${person.name} (vyřazen)`,
      value: person.id,
    })),
    { label: 'Nepřiděleno', value: UNASSIGNED },
  ];
  const clientItems = [
    { label: 'Všichni klienti', value: ALL },
    ...records.state.clients.items
      .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'))
      .map((client) => ({
        label: client.status === 'archived' ? `${client.name} (archivovaný)` : client.name,
        value: client.id,
      })),
  ];
  const rawStatuses = rawStatusesInUse(records.state);
  const statusItems = [
    { label: 'Všechny stavy', value: ALL },
    // Meanings filter only after the customer approved the mapping (R04); until then raw statuses only (C05).
    ...(reportMappingApproved(records.state)
      ? statusMeanings.map((meaning) => ({ label: `Význam: ${statusMeaningLabels[meaning]}`, value: `m:${meaning}` }))
      : []),
    ...rawStatuses.map((status) => ({
      label: `Ze zdroje: ${orderStatusLabel(status.raw)}`,
      value: `r:${normalizeStatus(status.raw)}`,
    })),
  ];
  const own = records.state.salespeople.find((person) => person.id === records.viewer.salespersonId);
  const active = query.period !== ALL || query.salesperson !== ALL || query.client !== ALL || query.status !== ALL;

  return (
    <div className={`${surfaceTileClassName} flex flex-wrap items-end gap-150 p-200`}>
      <div className="w-52">
        <SelectTemplate
          id="crm-report-period"
          items={periodItems}
          label={t('crm.ciWorkflow.period')}
          labelProps={labelProps}
          onValueChange={(details) => onChange({ period: details.value[0] ?? ALL })}
          size="sm"
          value={[query.period]}
        />
      </div>
      <div className="w-44">
        <FormInput
          id="crm-report-from"
          label={t('crm.reports.dateFrom')}
          onChange={(event) => onChange({ period: periodWithDate(period, 'from', event.target.value) })}
          size="sm"
          type="date"
          value={period.from ?? ''}
        />
      </div>
      <div className="w-44">
        <FormInput
          id="crm-report-to"
          label={t('crm.reports.dateTo')}
          onChange={(event) => onChange({ period: periodWithDate(period, 'to', event.target.value) })}
          size="sm"
          type="date"
          value={period.to ?? ''}
        />
      </div>
      {scopeAll ? (
        <div className="w-52">
          <SelectTemplate
            id="crm-report-salesperson"
            items={salespeopleItems}
            label={t('crm.ciWorkflow.salesperson')}
            labelProps={labelProps}
            onValueChange={(details) => onChange({ salesperson: details.value[0] ?? ALL })}
            size="sm"
            value={[query.salesperson]}
          />
        </div>
      ) : (
        <div className="flex w-52 flex-col gap-50">
          <span className={labelProps.className}>Obchodník</span>
          <span className="flex h-form-control-sm items-center text-sm">{own?.name ?? 'Vy'} (jen vaši klienti)</span>
        </div>
      )}
      <div className="w-64">
        <SelectTemplate
          id="crm-report-client"
          items={clientItems}
          label={t('crm.ciWorkflow.client')}
          labelProps={labelProps}
          onValueChange={(details) => onChange({ client: details.value[0] ?? ALL })}
          size="sm"
          value={[query.client]}
        />
      </div>
      <div className="w-64">
        <SelectTemplate
          id="crm-report-status"
          items={statusItems}
          label={t('crm.ciWorkflow.status')}
          labelProps={labelProps}
          onValueChange={(details) => onChange({ status: details.value[0] ?? ALL })}
          size="sm"
          value={[query.status]}
        />
      </div>
      {active && (
        <Button
          icon="icon-[mdi--filter-remove-outline]"
          onClick={() => onChange({ client: ALL, period: ALL, salesperson: ALL, status: ALL })}
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          Zrušit filtry
        </Button>
      )}
    </div>
  );
};
