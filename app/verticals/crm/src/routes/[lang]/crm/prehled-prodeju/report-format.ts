// Display helpers of the sales report (crm-reports lane): exact-decimal money, CSV download, period presets.
import { DateTime, Effect } from 'effect';
import { CalendarDateSchema } from '../../../../../shared/domain/common.ts';
import { useCrmMoneyFormats } from '../../../../crm/number-formats.tsx';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { monthLabel } from '../../../../../shared/domain/reports.ts';
import type { MoneyTotal, ReportPeriod } from '../../../../../shared/domain/reports.ts';

/** "48250.50" + "CZK" -> "48 250,50 Kč". Display only; sums stay exact decimals. */
export const useFormatDecimalMoney = () => {
  const { formatReportCurrency } = useCrmMoneyFormats();
  return (amount: string, currency: string) => formatReportCurrency(Number(amount), currency);
};

export const totalIn = (totals: readonly MoneyTotal[], currency: string) =>
  totals.find((total) => total.currency === currency);

/** Saves text as a UTF-8 CSV with BOM (Czech Excel opens it with diacritics intact). */
export const downloadCsv = (content: string, fileName: string) => {
  const url = URL.createObjectURL(new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  let clicked = false;
  try {
    document.body.append(anchor);
    anchor.click();
    clicked = true;
  } finally {
    anchor.remove();
    if (clicked) {
      browserRuntime.runFork(
        Effect.sleep('10 seconds').pipe(Effect.ensuring(Effect.sync(() => URL.revokeObjectURL(url)))),
      );
    } else {
      URL.revokeObjectURL(url);
    }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Period presets (string date math on the server's "now"; no browser clock)
// ---------------------------------------------------------------------------------------------------------------

export interface PeriodOption {
  readonly label: string;
  readonly period: ReportPeriod;
  readonly value: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

const daysInMonth = (year: number, month: number) => {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const monthRange = (month: string): ReportPeriod => ({
  from: CalendarDateSchema.make(`${month}-01`),
  to: CalendarDateSchema.make(`${month}-${pad(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`),
});

const shiftMonth = (month: string, delta: number) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
};

/** Presets relative to the server's "now", then one entry per month that has data (newest first). */
export const periodOptions = (now: DateTime.Utc, monthsWithData: readonly string[]): PeriodOption[] => {
  const today = CalendarDateSchema.make(DateTime.formatIsoDateUtc(now));
  const thisMonth = today.slice(0, 7);
  const presets: PeriodOption[] = [
    { label: 'Celé období', period: {}, value: 'vse' },
    {
      label: 'Tento měsíc',
      period: { from: CalendarDateSchema.make(`${thisMonth}-01`), to: today },
      value: 'tento-mesic',
    },
    { label: 'Minulý měsíc', period: monthRange(shiftMonth(thisMonth, -1)), value: 'minuly-mesic' },
    {
      label: 'Poslední 3 měsíce',
      period: { from: CalendarDateSchema.make(`${shiftMonth(thisMonth, -2)}-01`), to: today },
      value: '3-mesice',
    },
    {
      label: 'Posledních 12 měsíců',
      period: { from: CalendarDateSchema.make(`${shiftMonth(thisMonth, -11)}-01`), to: today },
      value: '12-mesicu',
    },
    {
      label: `Rok ${today.slice(0, 4)}`,
      period: { from: CalendarDateSchema.make(`${today.slice(0, 4)}-01-01`), to: today },
      value: 'letos',
    },
  ];
  const months = [...new Set(monthsWithData)]
    .toSorted((left, right) => right.localeCompare(left))
    .map((month) => ({
      label: monthLabel(month).replace(/^./u, (first) => first.toUpperCase()),
      period: monthRange(month),
      value: month,
    }));
  return [...presets, ...months];
};
