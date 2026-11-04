import { formatMoney } from '@app/admin-ui';

/** Money in whole Kč for list tables and stat cards: minor units rounded to the nearest koruna. */
export const formatKc = (minor: number): string => formatMoney(Math.round(minor / 100) * 100);

/** An order total in its currency: whole Kč for CZK, exact amounts (cents, grosze) for market currencies. */
export const formatOrderTotal = (minor: number, currency: string): string =>
  currency === 'CZK' ? formatKc(minor) : formatMoney(minor, currency);
