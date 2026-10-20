// @effect-diagnostics *:off
import { describe, expect, test } from '@rstest/core';
import type { AkrosOrderInput, SiamparkReminderInput } from './contract.ts';
import { deliveryOutcomeOf, orderEmailEvents, planAkrosOrderEmails, planSiamparkReminderEmail } from './plan.ts';
import { akrosOrderEmail, formatCzk } from './templates.ts';

const orderId = 'e8747ac9-8730-4fc5-b7ba-8ae9f9daade1';
const enabledSince = '2026-10-21T07:00:00.000Z';
const planOptions = {
  enabledSince,
  legalEntityId: '71000000-0000-4000-8000-000000000024',
  storefrontUrl: 'http://localhost:3070',
  tenantId: '70000000-0000-4000-8000-000000000020',
};

const baseOrder: AkrosOrderInput = {
  id: orderId,
  number: 'OBJ-2026-0030',
  channel: 'STOREFRONT',
  status: 'DELIVERED',
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:05:00.000Z',
  contact: { name: 'Pavel Dvořák', email: 'pavel@zakaznik.example' },
  deliveryAddress: { street: 'Průmyslová 1420', city: 'Praha 10', postalCode: '102 00', country: 'CZ' },
  pricesIncludeVat: true,
  shipping: { label: 'Osobní odběr – AKROS (simulace)', method: 'OSOBNI_ODBER', priceMinor: 0 },
  totalMinor: 54000,
  totalVatMinor: 9372,
  lines: [
    {
      productName: 'ŠROUBY DIN 912/A2',
      variantName: 'šroub M 1.6 x 4',
      sku: '10091200010004',
      quantity: 500,
      unitPriceMinor: 108,
      vatRate: 21,
    },
  ],
  history: [
    { kind: 'CREATED', at: '2026-10-21T08:00:00.000Z' },
    { kind: 'STATUS', after: 'Zpracovává se', at: '2026-10-21T08:01:00.000Z' },
    { kind: 'STATUS', after: 'Připravená k předání', at: '2026-10-21T08:02:00.000Z' },
    { kind: 'STATUS', after: 'Předáno dopravci (simulace)', at: '2026-10-21T08:03:00.000Z' },
    { kind: 'STATUS', after: 'Dokončená', at: '2026-10-21T08:04:00.000Z' },
  ],
};

const reminder: SiamparkReminderInput = {
  invoiceNumber: 'FV-2026-0007',
  legalEntityId: '71000000-0000-4000-8000-000000000001',
  reminder: {
    createdAt: '2026-10-21T09:00:00.000Z',
    deliveryMode: 'EMAIL',
    id: 'rem-0001',
    invoiceResourceId: 'inv-0007',
    recipient: ' obchod@siampark.demo ',
    text: 'Dobrý den,\n\nk faktuře FV-2026-0007 nebyla dosud přijata úhrada.',
  },
  tenantId: '70000000-0000-4000-8000-000000000001',
};

describe('AKROS order e-mail planning', () => {
  test('derives the lifecycle events from history in order', () => {
    const events = orderEmailEvents(baseOrder).map((e) => e.event);
    expect(events).toEqual(['ORDER_CREATED', 'CONFIRMED', 'SHIPPED', 'DELIVERED']);
  });

  test('uses current status with updatedAt when history has no matching entry', () => {
    const { history: _history, ...withoutHistory } = baseOrder;
    const order: AkrosOrderInput = { ...withoutHistory, status: 'CANCELLED' };
    const events = orderEmailEvents(order);
    expect(events.map((e) => e.event)).toEqual(['ORDER_CREATED', 'CANCELLED']);
    const cancelled = events.find((e) => e.event === 'CANCELLED');
    expect(cancelled?.at).toBe(order.updatedAt);
  });

  test('renders the cancellation reason from history into the CANCELLED e-mail', () => {
    const order: AkrosOrderInput = {
      ...baseOrder,
      status: 'CANCELLED',
      history: [
        { kind: 'CREATED', at: '2026-10-21T08:00:00.000Z' },
        { kind: 'STATUS', after: 'Stornovaná', at: '2026-10-21T08:06:00.000Z', reason: 'Zákazník zrušil' },
      ],
    };
    const emails = planAkrosOrderEmails(order, planOptions);
    const cancelled = emails.find((e) => e.event === 'CANCELLED');
    expect(cancelled?.text.includes('Důvod: Zákazník zrušil')).toBe(true);
    expect(cancelled?.subject).toBe('AKROS – objednávka OBJ-2026-0030 byla stornována');
  });

  test('plans one e-mail per event with stable dedupe keys and recipient', () => {
    const emails = planAkrosOrderEmails(baseOrder, planOptions);
    expect(emails.length).toBe(4);
    expect(emails.map((e) => e.dedupeKey)).toEqual([
      `akros-order:${orderId}:ORDER_CREATED`,
      `akros-order:${orderId}:CONFIRMED`,
      `akros-order:${orderId}:SHIPPED`,
      `akros-order:${orderId}:DELIVERED`,
    ]);
    expect(emails[0]?.subject).toBe('AKROS – přijali jsme vaši objednávku OBJ-2026-0030');
    expect(emails[0]?.recipient).toBe('pavel@zakaznik.example');
  });

  test('plans nothing before enabledSince, for non-storefront channels, or without a contact e-mail', () => {
    const early: AkrosOrderInput = { ...baseOrder, createdAt: '2026-10-21T06:59:00.000Z' };
    const staff: AkrosOrderInput = { ...baseOrder, channel: 'STAFF' };
    const { contact: _contact, ...withoutContact } = baseOrder;
    const noContact: AkrosOrderInput = withoutContact;
    expect(planAkrosOrderEmails(early, planOptions)).toEqual([]);
    expect(planAkrosOrderEmails(staff, planOptions)).toEqual([]);
    expect(planAkrosOrderEmails(noContact, planOptions)).toEqual([]);
  });

  test('drops events at or after the demo cleanup instant', () => {
    const order: AkrosOrderInput = { ...baseOrder, demoCleanup: { at: '2026-10-21T08:02:30.000Z' } };
    const events = orderEmailEvents(order).map((e) => e.event);
    expect(events).toEqual(['ORDER_CREATED', 'CONFIRMED']);
  });

  test('escapes product names in the HTML body', () => {
    const order: AkrosOrderInput = {
      ...baseOrder,
      lines: [{ ...baseOrder.lines[0]!, productName: '<b>Šroub</b>' }],
    };
    const emails = planAkrosOrderEmails(order, planOptions);
    const html = emails[0]?.html ?? '';
    expect(html.includes('&lt;b&gt;Šroub&lt;/b&gt;')).toBe(true);
    expect(html.includes('<b>Šroub')).toBe(false);
  });

  test('formats minor units as Czech koruna with decimals', () => {
    expect(formatCzk(54000).replace(/\s/gu, ' ')).toBe('540,00 Kč');
  });

  test('renders the order e-mail directly with the storefront link in the footer', () => {
    const rendered = akrosOrderEmail(baseOrder, 'SHIPPED', { storefrontUrl: 'http://localhost:3070' });
    expect(rendered.text.includes('Obchod AKROS: http://localhost:3070')).toBe(true);
  });
});

describe('Siampark reminder e-mail planning', () => {
  test('plans an EMAIL-mode reminder with the invoice number in the subject', () => {
    const planned = planSiamparkReminderEmail(reminder, enabledSince);
    expect(planned?.subject).toBe('Upomínka – faktura FV-2026-0007');
    expect(planned?.dedupeKey).toBe('siampark-reminder:rem-0001');
    expect(planned?.recipient).toBe('obchod@siampark.demo');
    expect(planned?.text.startsWith(reminder.reminder.text)).toBe(true);
  });

  test('plans nothing for SIMULATED mode or before enabledSince', () => {
    const simulated: SiamparkReminderInput = {
      ...reminder,
      reminder: { ...reminder.reminder, deliveryMode: 'SIMULATED' },
    };
    const early: SiamparkReminderInput = {
      ...reminder,
      reminder: { ...reminder.reminder, createdAt: '2026-10-21T06:00:00.000Z' },
    };
    expect(planSiamparkReminderEmail(simulated, enabledSince)).toBeNull();
    expect(planSiamparkReminderEmail(early, enabledSince)).toBeNull();
  });

  test('falls back to a generic subject when the invoice number is unknown', () => {
    const noInvoice: SiamparkReminderInput = { ...reminder, invoiceNumber: null };
    const planned = planSiamparkReminderEmail(noInvoice, enabledSince);
    expect(planned?.subject).toBe('Upomínka k neuhrazené faktuře');
    expect(planned?.subjectNumber).toBe('');
  });
});

describe('delivery outcome classification', () => {
  test('maps SMTP error tags to ledger statuses', () => {
    const statuses = [
      deliveryOutcomeOf({ _tag: 'EmailDeliveryUnavailable' }).status,
      deliveryOutcomeOf({ _tag: 'EmailDeliveryRejected' }).status,
      deliveryOutcomeOf({ _tag: 'EmailDeliveryInvalidMessage' }).status,
      deliveryOutcomeOf({ _tag: 'SomethingElse' }).status,
    ];
    expect(statuses).toEqual(['RETRY', 'FAILED', 'FAILED', 'UNKNOWN']);
  });
});
