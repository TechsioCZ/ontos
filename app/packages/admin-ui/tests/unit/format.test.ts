import { describe, expect, it } from 'effect-rstest';
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent } from '../../src/format.ts';

// cs-CZ uses non-breaking spaces as group separators; compare with plain spaces.
const plain = (value: string) => value.replaceAll(/\s/gu, ' ');

describe('formatMoney', () => {
  it('formats minor units as CZK and keeps halere only when present', () => {
    expect(plain(formatMoney(123_400))).toBe('1 234 Kč');
    expect(plain(formatMoney(123_450))).toBe('1 234,50 Kč');
  });

  it('uses the currency minor-unit scale for other currencies', () => {
    expect(plain(formatMoney(1050, 'EUR'))).toBe('10,50 €');
  });
});

describe('formatDate', () => {
  it('formats an ISO date in cs-CZ', () => {
    expect(formatDate('2026-10-13')).toBe('13. 10. 2026');
  });

  it('renders in Prague time, so late-evening UTC instants roll over', () => {
    expect(formatDate('2026-10-13T23:30:00Z')).toBe('14. 10. 2026');
  });

  it('renders an em dash for missing or invalid input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate()).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats date and Prague local time', () => {
    expect(formatDateTime('2026-10-13T12:05:00Z')).toBe('13. 10. 2026 14:05');
  });
});

describe('formatNumber and formatPercent', () => {
  it('formats decimals with a comma', () => {
    expect(plain(formatNumber(1_234_567.5))).toBe('1 234 567,5');
  });

  it('takes a ratio and formats it as a percentage', () => {
    expect(plain(formatPercent(0.256))).toBe('25,6 %');
  });
});
