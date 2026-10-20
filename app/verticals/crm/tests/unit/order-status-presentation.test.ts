import { describe, expect, it } from '@rstest/core';
import { orderStatusLabel, statusReviewReasonLabel } from '../../src/crm/order-status-presentation.ts';

describe('order status presentation', () => {
  it.each([
    ['nova', 'Nová'],
    ['zaplacena', 'Zaplacená'],
    ['odeslana', 'Odeslaná'],
    ['dorucena', 'Doručená'],
    ['stornovana', 'Stornovaná'],
    ['Přijatá', 'Přijatá'],
    ['Vyřízená', 'Vyřízená'],
    [' ZAPLACENA ', 'Zaplacená'],
    ['doručena', 'Doručená'],
    ['uhrazeno', 'Uhrazeno'],
  ])('renders %s as %s', (raw, expected) => {
    expect(orderStatusLabel(raw)).toBe(expected);
  });

  it('does not invent labels or report meanings for unknown source statuses', () => {
    for (const raw of ['WAITING_FOR_PICKUP_42', 'Vlastní stav dodavatele', '']) {
      expect(orderStatusLabel(raw)).toBe(raw);
    }
  });

  it('localizes only the generated status reference without changing timestamp or original input', () => {
    const raw = 'Událost je starší než poslední známý stav „zaplacena“ (14. 10. 2026 19:00), nepřepisuje ho';
    expect(statusReviewReasonLabel(raw)).toBe(
      'Událost je starší než poslední známý stav „Zaplacená“ (14. 10. 2026 19:00), nepřepisuje ho',
    );
    expect(raw).toContain('„zaplacena“');
    expect(statusReviewReasonLabel('Odběratel napsal „nova“, ověřeno telefonicky.')).toBe(
      'Odběratel napsal „nova“, ověřeno telefonicky.',
    );
    expect(statusReviewReasonLabel('Událost je starší než poslední známý stav „CUSTOM_42“')).toBe(
      'Událost je starší než poslední známý stav „CUSTOM_42“',
    );
  });
});
