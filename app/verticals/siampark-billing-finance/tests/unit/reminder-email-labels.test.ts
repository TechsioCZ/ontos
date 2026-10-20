import { describe, expect, test } from '@rstest/core';
import {
  deliveryLabel,
  emailStatusVariant,
  type EmailDeliveryView,
} from '../../src/routes/[lang]/siampark/finance/reminder-email-labels.ts';

const delivery = (overrides: Partial<EmailDeliveryView>): EmailDeliveryView => ({
  createdAt: '2026-10-21T08:40:00.000Z',
  event: 'PAYMENT_REMINDER',
  eventAt: '2026-10-21T08:40:00.000Z',
  sentAt: null,
  source: 'siampark-reminder',
  status: 'SENDING',
  subjectId: 'reminder-1',
  subjectNumber: 'FV-2026-001',
  ...overrides,
});

describe('reminder e-mail labels', () => {
  test('SENT with sentAt shows the formatted send time', () => {
    const label = deliveryLabel(
      delivery({ sentAt: '2026-10-21T08:41:00.000Z', status: 'SENT' }),
      (iso) => `T(${iso})`,
    );
    expect(label).toBe('Odesláno e-mailem · T(2026-10-21T08:41:00.000Z)');
  });

  test('SENT without sentAt falls back to the plain status label', () => {
    expect(deliveryLabel(delivery({ sentAt: null, status: 'SENT' }), (iso) => iso)).toBe('Odesláno e-mailem');
  });

  test('RETRY shows the retry label', () => {
    expect(deliveryLabel(delivery({ status: 'RETRY' }), (iso) => iso)).toBe(
      'Čeká na opakování – SMTP server nedostupný',
    );
  });

  test('FAILED maps to the danger variant', () => {
    expect(emailStatusVariant.FAILED).toBe('danger');
  });
});
