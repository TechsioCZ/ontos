// @effect-diagnostics globalTimers:off
// Display helpers of the sales report (crm-reports lane): exact-decimal money, CSV download, period presets.
import type { MoneyTotal, ReportPeriod } from '../../../../../shared/domain/reports.ts';
import { monthLabel } from '../../../../../shared/domain/reports.ts';

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** "48250.50" + "CZK" -> "48 250,50 Kč". Display only; sums are exact decimals in the domain. */
export const formatDecimalMoney = (amount: string, currency: string) => {
  let format = moneyFormats.get(currency);
  if (format === undefined) {
    format = new Intl.NumberFormat('cs-CZ', {
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
      style: 'currency',
    });
    moneyFormats.set(currency, format);
  }
  const value = Number(amount);
  return Number.isInteger(value)
    ? format.format(value)
    : new Intl.NumberFormat('cs-CZ', { currency, minimumFractionDigits: 2, style: 'currency' }).format(value);
};

export const totalIn = (totals: readonly MoneyTotal[], currency: string) =>
  totals.find((total) => total.currency === currency);

/** Saves text as a UTF-8 CSV with BOM (Czech Excel opens it with diacritics intact). */
export const downloadCsv = (content: string, fileName: string) => {
  const url = URL.createObjectURL(new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
  from: `${month}-01`,
  to: `${month}-${pad(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`,
});

const shiftMonth = (month: string, delta: number) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
};

/** Presets relative to the server's "now", then one entry per month that has data (newest first). */
export const periodOptions = (now: string, monthsWithData: readonly string[]): PeriodOption[] => {
  const today = now.slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const presets: PeriodOption[] = [
    { label: 'Celé období', period: {}, value: 'vse' },
    { label: 'Tento měsíc', period: { from: `${thisMonth}-01`, to: today }, value: 'tento-mesic' },
    { label: 'Minulý měsíc', period: monthRange(shiftMonth(thisMonth, -1)), value: 'minuly-mesic' },
    { label: 'Poslední 3 měsíce', period: { from: `${shiftMonth(thisMonth, -2)}-01`, to: today }, value: '3-mesice' },
    {
      label: 'Posledních 12 měsíců',
      period: { from: `${shiftMonth(thisMonth, -11)}-01`, to: today },
      value: '12-mesicu',
    },
    { label: `Rok ${today.slice(0, 4)}`, period: { from: `${today.slice(0, 4)}-01-01`, to: today }, value: 'letos' },
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
