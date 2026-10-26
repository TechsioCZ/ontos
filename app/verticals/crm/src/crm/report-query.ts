import { CalendarDateWireSchema } from '@app/shared-contracts';
import { Schema } from 'effect';
import type { ReportPeriod } from '../../shared/domain/reports.ts';
import type { PeriodOption } from '../routes/[lang]/crm/prehled-prodeju/report-format.ts';

const ReportQuerySchema = Schema.Struct({
  client: Schema.String,
  grouping: Schema.Literals(['salesperson', 'client', 'month', 'status']),
  period: Schema.String,
  salesperson: Schema.String,
  status: Schema.String,
});

export type ReportQuery = typeof ReportQuerySchema.Type;

export const ALL = 'vse';

const PARAMS = {
  client: 'klient',
  grouping: 'seskupit',
  period: 'obdobi',
  salesperson: 'obchodnik',
  status: 'stav',
} as const satisfies Record<keyof ReportQuery, string>;

const isGrouping = Schema.is(ReportQuerySchema.fields.grouping);
const isCalendarDate = Schema.is(CalendarDateWireSchema);

/** Browser URL adapter. An SSR render has the same defaults as an unfiltered report. */
export const readQuery = (): ReportQuery => {
  const browser = globalThis.window;
  const params = browser === undefined ? new URLSearchParams() : new URL(browser.location.href).searchParams;
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
  for (const key of ['client', 'grouping', 'period', 'salesperson', 'status'] as const) {
    const value = query[key];
    if ((key === 'grouping' && value === 'salesperson') || value === ALL) {
      url.searchParams.delete(PARAMS[key]);
    } else {
      url.searchParams.set(PARAMS[key], value);
    }
  }
  window.history.replaceState(window.history.state, '', url);
};

/** Presets and date-only URL ranges use the same inclusive report period. */
export const periodOf = (value: string, periods: readonly PeriodOption[]): ReportPeriod | undefined => {
  const preset = periods.find((option) => option.value === value);
  if (preset !== undefined) {
    return preset.period;
  }
  const [from = '', to = '', ...extra] = value.split(':');
  if (
    !value.includes(':') ||
    extra.length > 0 ||
    (from === '' && to === '') ||
    (from !== '' && !isCalendarDate(from)) ||
    (to !== '' && !isCalendarDate(to)) ||
    (from !== '' && to !== '' && from > to)
  ) {
    return undefined;
  }
  if (from === '') {
    return { to };
  }
  return to === '' ? { from } : { from, to };
};

/** Keep the opposite date when editing a preset, moving it only if the bounds would cross. */
export const periodWithDate = (period: ReportPeriod, boundary: 'from' | 'to', value: string): string => {
  let from = boundary === 'from' ? value : (period.from ?? '');
  let to = boundary === 'to' ? value : (period.to ?? '');
  if (from !== '' && to !== '' && from > to) {
    if (boundary === 'from') {
      to = from;
    } else {
      from = to;
    }
  }
  return from === '' && to === '' ? ALL : `${from}:${to}`;
};
