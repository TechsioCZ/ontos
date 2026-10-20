// Filter bar of the sales report (crm-reports lane): období, obchodník, klient, stav (mapped meaning or raw).
// Filters live in the URL (?obdobi=&obchodnik=&klient=&stav=&seskupit=) so a drill-down and back keeps them.
import { Button } from '@techsio/ui-kit/atoms/button';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { ReportFilters, StatusMeaningOrUnmapped } from '../../../../../shared/domain/reports.ts';
import {
  UNASSIGNED,
  normalizeStatus,
  orderDate,
  rawStatusesInUse,
  statusMeaningLabels,
  statusMeanings,
} from '../../../../../shared/domain/reports.ts';
import type { PeriodOption } from './report-format.ts';
import { periodOptions } from './report-format.ts';
import type { GroupingKey } from './report-tables.tsx';
import { groupingLabels } from './report-tables.tsx';

export interface ReportQuery {
  readonly client: string;
  readonly grouping: GroupingKey;
  readonly period: string;
  readonly salesperson: string;
  readonly status: string;
}

export const ALL = 'vse';

const PARAMS = {
  client: 'klient',
  grouping: 'seskupit',
  period: 'obdobi',
  salesperson: 'obchodnik',
  status: 'stav',
} as const satisfies Record<keyof ReportQuery, string>;

const isGrouping = (value: string | null): value is GroupingKey =>
  value !== null && Object.hasOwn(groupingLabels, value);

export const readQuery = (): ReportQuery => {
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URL(window.location.href).searchParams;
  const grouping = params.get(PARAMS.grouping);
  return {
    client: params.get(PARAMS.client) ?? ALL,
    grouping: isGrouping(grouping) ? grouping : 'salesperson',
    period: params.get(PARAMS.period) ?? ALL,
    salesperson: params.get(PARAMS.salesperson) ?? ALL,
    status: params.get(PARAMS.status) ?? ALL,
  };
};

export const writeQuery = (query: ReportQuery) => {
  const url = new URL(window.location.href);
  for (const key of Object.keys(PARAMS) as (keyof ReportQuery)[]) {
    const value = query[key];
    if ((key === 'grouping' && value === 'salesperson') || value === ALL) {
      url.searchParams.delete(PARAMS[key]);
    } else {
      url.searchParams.set(PARAMS[key], value);
    }
  }
  window.history.replaceState(window.history.state, '', url);
};

export const reportPeriodOptions = (records: RecordsResponse) =>
  periodOptions(
    records.now,
    records.state.imports.orders.map((order) => orderDate(order).slice(0, 7)),
  );

/** Query -> domain filters. Unknown values fall back to "all" (e.g. a client the viewer may not see). */
export const filtersOf = (query: ReportQuery, periods: readonly PeriodOption[]): ReportFilters => {
  const period = periods.find((option) => option.value === query.period)?.period;
  let status: ReportFilters['status'];
  if (query.status.startsWith('m:')) {
    const meaning = query.status.slice(2) as StatusMeaningOrUnmapped;
    status = statusMeanings.includes(meaning) ? { kind: 'meaning', meaning } : undefined;
  } else if (query.status.startsWith('r:')) {
    status = { kind: 'raw', raw: query.status.slice(2) };
  }
  return {
    ...(period === undefined ? {} : { period }),
    ...(query.salesperson === ALL ? {} : { salespersonId: query.salesperson }),
    ...(query.client === ALL ? {} : { clientId: query.client }),
    ...(status === undefined ? {} : { status }),
  };
};

/** "Filtry: …" sentence for the source line and the CSV file name. */
export const describeFilters = (
  query: ReportQuery,
  records: RecordsResponse,
  periods: readonly PeriodOption[],
): string[] => {
  const parts: string[] = [];
  parts.push(`období ${periods.find((option) => option.value === query.period)?.label.toLowerCase() ?? 'celé'}`);
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
    parts.push(`stav ${statusMeaningLabels[query.status.slice(2) as StatusMeaningOrUnmapped] ?? '—'}`);
  } else if (query.status.startsWith('r:')) {
    parts.push(`surový stav „${query.status.slice(2)}“`);
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
  const salespeopleItems = [
    { label: 'Všichni obchodníci', value: ALL },
    ...records.state.salespeople.map((person) => ({ label: person.name, value: person.id })),
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
    ...statusMeanings.map((meaning) => ({ label: `Význam: ${statusMeaningLabels[meaning]}`, value: `m:${meaning}` })),
    ...rawStatuses.map((status) => ({
      label: `Ze zdroje: ${status.raw}`,
      value: `r:${normalizeStatus(status.raw)}`,
    })),
  ];
  const own = records.state.salespeople.find((person) => person.id === records.viewer.salespersonId);
  const active = query.period !== ALL || query.salesperson !== ALL || query.client !== ALL || query.status !== ALL;

  return (
    <div className="flex flex-wrap items-end gap-150 rounded-lg border border-border-primary bg-surface p-200">
      <div className="w-52">
        <SelectTemplate
          id="crm-report-period"
          items={periods.map((option) => ({ label: option.label, value: option.value }))}
          label="Období"
          labelProps={labelProps}
          onValueChange={(details) => onChange({ period: details.value[0] ?? ALL })}
          size="sm"
          value={[query.period]}
        />
      </div>
      {scopeAll ? (
        <div className="w-52">
          <SelectTemplate
            id="crm-report-salesperson"
            items={salespeopleItems}
            label="Obchodník"
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
          label="Klient"
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
          label="Stav"
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
