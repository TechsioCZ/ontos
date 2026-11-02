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

  it('does not expose an unknown wire enum or inherited property as a label', () => {
    expect(statusPresentation('task', 'MYSTERY')).toEqual({ label: '—', variant: 'outline' });
    expect(statusPresentation('task', 'constructor')).toEqual({ label: '—', variant: 'outline' });
  });
});
