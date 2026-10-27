import { describe, expect, it as test } from 'effect-rstest';
import {
  deliveryLabel,
  emailEventLabels,
  emailStatusVariant,
} from '../../src/routes/[lang]/prodej/objednavky/order-email-labels.ts';
import type { EmailDeliveryView } from '../../src/routes/[lang]/prodej/objednavky/order-email-labels.ts';

const delivery = (overrides: Partial<EmailDeliveryView>): EmailDeliveryView => ({
  createdAt: '2026-10-21T08:40:00.000Z',
  event: 'CONFIRMED',
  eventAt: '2026-10-21T08:40:00.000Z',
  sentAt: null,
  source: 'akros-order',
  status: 'SENDING',
  subjectId: 'order-1',
  subjectNumber: 'AKR-0001',
  ...overrides,
});

describe('order e-mail labels', () => {
  test('SENT delivery shows sent label with formatted time', () => {
    const view = delivery({ sentAt: '2026-10-21T08:41:00.000Z', status: 'SENT' });
    expect(deliveryLabel(view, (iso) => `T(${iso})`)).toBe('Odesláno e-mailem · T(2026-10-21T08:41:00.000Z)');
  });

  test('FAILED delivery shows failure label', () => {
    const view = delivery({ status: 'FAILED' });
    expect(deliveryLabel(view, (iso) => `T(${iso})`)).toBe('Odeslání selhalo');
  });

  test('event label for SHIPPED', () => {
    expect(emailEventLabels.SHIPPED).toBe('Předáno dopravci');
  });

  test('CONFIRMED receipt matches the order status label „Zpracovává se“', () => {
    expect(emailEventLabels.CONFIRMED).toBe('Zpracovává se');
  });

  test('SENT status uses success variant', () => {
    expect(emailStatusVariant.SENT).toBe('success');
  });
});
