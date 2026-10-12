import { describe, expect, it } from 'effect-rstest';
import { statusPresentation } from '../../src/status-presentation.ts';

describe('statusPresentation', () => {
  it('maps domain values to Czech labels and Akros variants', () => {
    expect(statusPresentation('payment', 'OVERDUE')).toEqual({ label: 'Po splatnosti', variant: 'danger' });
    expect(statusPresentation('task', 'DONE')).toEqual({ label: 'Dokončený', variant: 'success' });
    expect(statusPresentation('order', 'NEW')).toEqual({ label: 'Nová', variant: 'warning' });
    expect(statusPresentation('stock-movement', 'ADJUSTMENT')).toEqual({
      label: 'Inventurní úprava',
      variant: 'warning',
    });
  });

  it('falls back to the raw value on an outline badge for unknown input', () => {
    expect(statusPresentation('task', 'MYSTERY')).toEqual({ label: 'MYSTERY', variant: 'outline' });
    expect(statusPresentation('task', 'constructor')).toEqual({ label: 'constructor', variant: 'outline' });
  });
});
