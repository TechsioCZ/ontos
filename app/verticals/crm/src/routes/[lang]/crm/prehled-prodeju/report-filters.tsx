// Filter bar of the sales report (crm-reports lane): období, obchodník, klient, stav (mapped meaning or raw).
// Filters live in the URL (?obdobi=&obchodnik=&klient=&stav=&seskupit=) so a drill-down and back keeps them.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
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
import { clientOptions, salespersonOptions } from '../../../../crm/option-labels.ts';
import { orderStatusLabel } from '../../../../crm/order-status-presentation.ts';
import type { ReportQuery } from '../../../../crm/report-query.ts';
import { ALL, periodOf, periodWithDate } from '../../../../crm/report-query.ts';
import type { PeriodOption } from './report-format.ts';
import { periodOptions } from './report-format.ts';
import { formatDate, surfaceTileClassName } from '@app/admin-ui';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

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

/**
 * The report filters as the bar edits them. The URL keeps them, so the form follows the URL and every change of the
 * form goes to the URL; the two dates edit the period. The bar is never submitted.
 */
const reportFilterForm = FormReact.make(
  FormBuilder.empty
    .addField('client', Schema.String)
    .addField('from', Schema.String)
    .addField('period', Schema.String)
    .addField('salesperson', Schema.String)
    .addField('status', Schema.String)
    .addField('to', Schema.String),
  {
    fields: {
      client: SelectTemplateField,
      from: TextField,
      period: SelectTemplateField,
      salesperson: SelectTemplateField,
      status: SelectTemplateField,
      to: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type ReportFilterValues = typeof reportFilterForm.schema.Encoded;

/** What the bar shows for a query: its period also as the two dates it spans. */
const filterValuesOf = (query: ReportQuery, periods: readonly PeriodOption[]): ReportFilterValues => {
  const period = periodOf(query.period, periods);
  return {
    client: query.client,
    from: period?.from ?? '',
    period: query.period,
    salesperson: query.salesperson,
    status: query.status,
    to: period?.to ?? '',
  };
};

const filterKeys = ['client', 'from', 'period', 'salesperson', 'status', 'to'] as const;
const sameFilterValues = (left: ReportFilterValues, right: ReportFilterValues) =>
  filterKeys.every((key) => left[key] === right[key]);

/** The query change one edit of the bar asks for; none when the bar shows the query as it is. */
const queryPatchOf = (
  next: ReportFilterValues,
  shown: ReportFilterValues,
  period: Parameters<typeof periodWithDate>[0],
): Partial<ReportQuery> => {
  const patch: { -readonly [Key in keyof ReportQuery]?: ReportQuery[Key] } = {};
  if (next.period !== shown.period) {
    patch.period = next.period === '' ? ALL : next.period;
  } else if (next.from !== shown.from) {
    patch.period = periodWithDate(period, 'from', next.from);
  } else if (next.to !== shown.to) {
    patch.period = periodWithDate(period, 'to', next.to);
  }
  if (next.salesperson !== shown.salesperson) {
    patch.salesperson = next.salesperson === '' ? ALL : next.salesperson;
  }
  if (next.client !== shown.client) {
    patch.client = next.client === '' ? ALL : next.client;
  }
  if (next.status !== shown.status) {
    patch.status = next.status === '' ? ALL : next.status;
  }
  return patch;
};

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier visit left, so its values are read only after this.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

export const ReportFilterBar = ({ onChange, periods, query, records, scopeAll }: ReportFilterBarProps) => {
  const { t } = useModernI18n();
  const period = periodOf(query.period, periods) ?? {};
  const periodItems = periods.map((option) => ({ label: option.label, value: option.value }));
  if (query.period.includes(':') && periodOf(query.period, periods) !== undefined) {
    periodItems.push({ label: t('crm.reports.customPeriod'), value: query.period });
  }
  const salespeopleItems = [
    { label: 'Všichni obchodníci', value: ALL },
    ...salespersonOptions(records.state.salespeople),
    { label: 'Nepřiděleno', value: UNASSIGNED },
  ];
  const clientItems = [{ label: 'Všichni klienti', value: ALL }, ...clientOptions(records.state.clients.items)];
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
  const shown = filterValuesOf(query, periods);
  const [ready, setReady] = useState(false);
  const values = Option.filter(useAtomValue(reportFilterForm.values), () => ready);
  const setValues = useAtomSet(reportFilterForm.setValues);
  useAtomSubscribe(
    reportFilterForm.values,
    (next) => {
      if (!ready || Option.isNone(next)) {
        return;
      }
      const patch = queryPatchOf(next.value, shown, period);
      if (Object.keys(patch).length > 0) {
        onChange(patch);
      }
    },
    { immediate: false },
  );
  // The URL changes without the bar too (Back, Zrušit filtry, a drill-down): the bar then shows it.
  const seen = useRef(shown);
  useEffect(() => {
    if (sameFilterValues(seen.current, shown)) {
      return;
    }
    seen.current = shown;
    if (Option.exists(values, (current) => !sameFilterValues(current, shown))) {
      setValues(shown);
    }
  }, [setValues, shown, values]);

  return (
    <FormRoot
      className={`${surfaceTileClassName} flex flex-wrap items-end gap-150 p-200`}
      defaultValues={shown}
      form={reportFilterForm}
      translateMessage={(message) => t(message, { defaultValue: message })}
    >
      <FormReady onReady={setReady} />
      <div className="w-52">
        <reportFilterForm.period
          id="crm-report-period"
          items={periodItems}
          label={t('crm.ciWorkflow.period')}
          labelProps={labelProps}
          size="sm"
        />
      </div>
      <div className="w-44">
        <reportFilterForm.from id="crm-report-from" label={t('crm.reports.dateFrom')} size="sm" type="date" />
      </div>
      <div className="w-44">
        <reportFilterForm.to id="crm-report-to" label={t('crm.reports.dateTo')} size="sm" type="date" />
      </div>
      {scopeAll ? (
        <div className="w-52">
          <reportFilterForm.salesperson
            id="crm-report-salesperson"
            items={salespeopleItems}
            label={t('crm.ciWorkflow.salesperson')}
            labelProps={labelProps}
            size="sm"
          />
        </div>
      ) : (
        <div className="flex w-52 flex-col gap-50">
          <span className={labelProps.className}>Obchodník</span>
          <span className="flex h-form-control-sm items-center text-sm">{own?.name ?? 'Vy'} (jen vaši klienti)</span>
        </div>
      )}
      <div className="w-64">
        <reportFilterForm.client
          id="crm-report-client"
          items={clientItems}
          label={t('crm.ciWorkflow.client')}
          labelProps={labelProps}
          size="sm"
        />
      </div>
      <div className="w-64">
        <reportFilterForm.status
          id="crm-report-status"
          items={statusItems}
          label={t('crm.ciWorkflow.status')}
          labelProps={labelProps}
          size="sm"
        />
      </div>
      {active && (
        <Button
          appearance="ghost"
          icon="icon-[mdi--filter-remove-outline]"
          onClick={() => onChange({ client: ALL, period: ALL, salesperson: ALL, status: ALL })}
          severity="secondary"
          size="sm"
        >
          Zrušit filtry
        </Button>
      )}
    </FormRoot>
  );
};
