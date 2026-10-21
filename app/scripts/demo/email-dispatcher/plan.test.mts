// @effect-diagnostics *:off
import { describe, expect, test } from '@rstest/core';
import type { AgendaRecipientInput, AkrosOrderInput, RentReminderInput } from './contract.ts';
import { deliveryOutcomeOf, orderEmailEvents, planAgendaEmails, planAkrosOrderEmails, planRentReminderEmail } from './plan.ts';
import { isTestRecipient, testCaptureFromEnvironment } from './recipients.ts';
import { addressOf, agendaSenderFor, senderFor } from './senders.ts';
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

const reminder: RentReminderInput = {
  invoiceNumber: 'FV-2026-0007',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  legalName: 'Siampark',
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

  test('a personal-pickup order is „připravena k vyzvednutí“, never „předána dopravci“, and no „simulace“', () => {
    const shipped = planAkrosOrderEmails(baseOrder, planOptions).find((e) => e.event === 'SHIPPED');
    expect(shipped?.subject).toBe('AKROS – objednávka OBJ-2026-0030 je připravena k vyzvednutí');
    expect(shipped?.eventLabel).toBe('Připraveno k vyzvednutí');
    expect(shipped?.text.includes('je připravena k vyzvednutí (Osobní odběr – AKROS)')).toBe(true);
    expect(shipped?.text.includes('dopravci (')).toBe(false);
    for (const email of planAkrosOrderEmails(baseOrder, planOptions)) {
      expect(email.text.includes('simulace')).toBe(false);
      expect(email.html.includes('simulace')).toBe(false);
    }
  });

  test('a carrier order is „předána dopravci“ with the label without the staff-side marker', () => {
    const order: AkrosOrderInput = {
      ...baseOrder,
      shipping: { label: 'PPL – doručení na adresu (simulace)', method: 'PPL', priceMinor: 12900 },
    };
    const shipped = planAkrosOrderEmails(order, planOptions).find((e) => e.event === 'SHIPPED');
    expect(shipped?.subject).toBe('AKROS – objednávka OBJ-2026-0030 byla předána dopravci');
    expect(shipped?.eventLabel).toBe('Předáno dopravci');
    expect(shipped?.text.includes('jsme předali dopravci (PPL – doručení na adresu).')).toBe(true);
  });
});

describe('Siampark reminder e-mail planning', () => {
  test('plans an EMAIL-mode reminder with the invoice number in the subject', () => {
    const planned = planRentReminderEmail(reminder, enabledSince);
    expect(planned?.subject).toBe('Siampark – upomínka k faktuře FV-2026-0007');
    expect(planned?.eventLabel).toBe('Upomínka k úhradě');
    expect(planned?.dedupeKey).toBe('rent-reminder:rem-0001');
    expect(planned?.recipient).toBe('obchod@siampark.demo');
    expect(planned?.text.startsWith(reminder.reminder.text)).toBe(true);
  });

  test('plans nothing for SIMULATED mode or before enabledSince', () => {
    const simulated: RentReminderInput = {
      ...reminder,
      reminder: { ...reminder.reminder, deliveryMode: 'SIMULATED' },
    };
    const early: RentReminderInput = {
      ...reminder,
      reminder: { ...reminder.reminder, createdAt: '2026-10-21T06:00:00.000Z' },
    };
    expect(planRentReminderEmail(simulated, enabledSince)).toBeNull();
    expect(planRentReminderEmail(early, enabledSince)).toBeNull();
  });

  test('falls back to a generic subject when the invoice number is unknown', () => {
    const noInvoice: RentReminderInput = { ...reminder, invoiceNumber: null };
    const planned = planRentReminderEmail(noInvoice, enabledSince);
    expect(planned?.subject).toBe('Siampark – upomínka k neuhrazené faktuře');
    expect(planned?.subjectNumber).toBe('');
  });
});

describe('reminders in the name of the issuing company', () => {
  const obchodni: RentReminderInput = {
    ...reminder,
    legalEntityId: '71000000-0000-4000-8000-000000000020',
    legalName: 'Obchodní firma',
  };

  test('an Obchodní firma reminder carries the Obchodní firma header, subject and footer, never Siampark', () => {
    const planned = planRentReminderEmail(obchodni, enabledSince);
    expect(planned?.subject).toBe('Obchodní firma – upomínka k faktuře FV-2026-0007');
    expect(planned?.html.includes('Siampark')).toBe(false);
    expect(planned?.text.includes('jménem společnosti Obchodní firma')).toBe(true);
  });

  test('each company sends from its own address; env overrides it; SMTP_FROM supplies the fallback address', () => {
    expect(senderFor(obchodni, 'Obchodní firma', {})).toBe('Obchodní firma – účtárna <ucetni@demo.ontos>');
    expect(senderFor(reminder, 'Siampark', {})).toBe('Siampark – finanční oddělení <finance@siampark.demo>');
    expect(senderFor({ legalEntityId: '71000000-0000-4000-8000-000000000024' }, 'AKROS', {})).toBe(
      'AKROS e-shop <eshop@akros.demo>',
    );
    expect(senderFor(reminder, 'Siampark', { SIAMPARK_EMAIL_FROM: 'Siampark <fakturace@siampark.cz>' })).toBe(
      'Siampark <fakturace@siampark.cz>',
    );
    expect(senderFor(obchodni, 'Obchodní firma', { SMTP_FROM: 'OntOS <noreply@vase-domena.cz>' })).toBe(
      'Obchodní firma – účtárna <noreply@vase-domena.cz>',
    );
    expect(senderFor({ legalEntityId: '71000000-0000-4000-8000-000000000022' }, 'Velkoobchod Hanák s.r.o.', {})).toBe(
      'Velkoobchod Hanák s.r.o. – finanční oddělení <oznameni@ontos.demo>',
    );
    expect(addressOf('Name <a@b.cz>')).toBe('a@b.cz');
    expect(addressOf('a@b.cz')).toBe('a@b.cz');
    expect(addressOf('bez adresy')).toBeNull();
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

describe('AKROS status label in e-mails', () => {
  test('CONFIRMED reads „Zpracovává se“ like the staff app and the storefront', () => {
    const email = akrosOrderEmail({ ...baseOrder, status: 'CONFIRMED' }, 'CONFIRMED', { storefrontUrl: 'http://localhost:3070' });
    expect(email.text).toContain('Aktuální stav: Zpracovává se');
    expect(email.text).not.toContain('Potvrzená');
    expect(email.subject).toBe('AKROS – objednávka OBJ-2026-0030 se zpracovává');
  });
});

describe('agenda notification e-mails', () => {
  const person: AgendaRecipientInput = {
    email: 'operations@siampark.demo',
    legalEntityId: '71000000-0000-4000-8000-000000000021',
    legalName: 'Siampark',
    principalId: '72000000-0000-4000-8000-000000000022',
    tenantId: '70000000-0000-4000-8000-000000000020',
    preference: { emailCategories: [], emailOptIn: true, emailSince: '2026-10-21T08:00:00.000Z', updatedAt: '2026-10-21T08:00:00.000Z' },
    notifications: [
      { category: 'ASSIGNED', createdAt: '2026-10-21T09:00:00.000Z', href: '/ukoly?resourceId=w1', id: 'n1', source: 'work', title: 'Zkontrolovat osvětlení' },
      { category: 'DEADLINE', createdAt: '2026-10-21T09:00:00.000Z', dueDate: '2026-10-31', id: 'n2', source: 'agreements', title: 'Konec smlouvy' },
      { category: 'OVERDUE', createdAt: '2026-10-21T09:00:00.000Z', id: 'n3', source: 'work', title: 'Revize hasicích přístrojů' },
      { category: 'ASSIGNED', createdAt: '2026-10-21T07:00:00.000Z', id: 'n0', source: 'work', title: 'Před zapnutím e-mailu' },
    ],
  };
  const options = { appUrl: 'http://localhost:3020', enabledSince: '2026-10-21T06:00:00.000Z' };

  test('mandatory categories always, optional only when chosen, never before e-mail was switched on', () => {
    const planned = planAgendaEmails(person, options);
    expect(planned).toHaveLength(1);
    const email = planned[0]!;
    expect(email.dedupeKey).toBe('facility-agenda:72000000-0000-4000-8000-000000000022:2026-10-21T09:00:00.000Z');
    expect(email.subject).toBe('Siampark – 2 nová upozornění v agendě');
    expect(email.text).toContain('Přiřazeno vám: Zkontrolovat osvětlení');
    expect(email.text).toContain('Otevřít: http://localhost:3020/cs/ukoly?resourceId=w1');
    expect(email.text).toContain('Po termínu: Revize hasicích přístrojů');
    expect(email.text).not.toContain('Konec smlouvy');
    expect(email.text).not.toContain('Před zapnutím e-mailu');
  });

  test('optional category chosen, old preference rows get every optional category', () => {
    const chosen = planAgendaEmails({ ...person, preference: { ...person.preference, emailCategories: ['DEADLINE'] } }, options);
    expect(chosen[0]!.text).toContain('Blíží se termín: Konec smlouvy');
    expect(chosen[0]!.text).toContain('Termín: 31. 10. 2026');
    const legacy = planAgendaEmails({ ...person, preference: { emailOptIn: true, updatedAt: '2026-10-21T08:00:00.000Z' } }, options);
    expect(legacy[0]!.text).toContain('Konec smlouvy');
  });

  test('nothing without opt-in or without an address; sender names the company', () => {
    expect(planAgendaEmails({ ...person, preference: { ...person.preference, emailOptIn: false } }, options)).toEqual([]);
    expect(planAgendaEmails({ ...person, email: null }, options)).toEqual([]);
    expect(agendaSenderFor(person, {})).toBe('Siampark – upozornění <provoz@siampark.demo>');
  });
});

describe('test recipients go to the separate test capture, never the demo inbox', () => {
  test('reserved test domains and QA markers are test recipients', () => {
    for (const address of ['jan.novak@example.invalid', 'Marek.Hruska@EXAMPLE.INVALID', 'x@shop.test', 'fakturace.audit@firma.cz', 'critic1@siampark.demo', 'fixer@hanak.demo', 'qa-test@akros.demo', 'a@audit.example']) {
      expect(isTestRecipient(address)).toBe(true);
    }
  });
  test('demo-story recipients stay in the demo inbox', () => {
    for (const address of ['operations@siampark.demo', 'pavel.dvorak@dvorak-stavby.demo', 'fakturace@kavarnauparku.cz', 'fakturace@odberatel.example', 'obchodnik.a@hanak.demo']) {
      expect(isTestRecipient(address)).toBe(false);
    }
  });
  test('test capture defaults to the second Mailpit and can be switched off', () => {
    expect(testCaptureFromEnvironment({})).toEqual({ host: '127.0.0.1', port: 1026 });
    expect(testCaptureFromEnvironment({ EMAIL_TEST_SMTP_HOST: 'mail-test', EMAIL_TEST_SMTP_PORT: '2525' })).toEqual({ host: 'mail-test', port: 2525 });
    expect(testCaptureFromEnvironment({ EMAIL_TEST_SMTP_HOST: 'none' })).toBeNull();
  });
});
