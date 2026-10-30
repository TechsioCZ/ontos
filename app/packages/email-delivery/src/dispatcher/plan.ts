import { DateTime, Match } from 'effect';
import type {
  AgendaRecipientInput,
  AkrosOrderInput,
  DeliveryOutcome,
  PlannedEmail,
  RentReminderInput,
  StorefrontInquiryTaskInput,
} from './contract.ts';
import { AGENDA_MANDATORY_EMAIL_CATEGORIES, AGENDA_OPTIONAL_EMAIL_CATEGORIES } from './contract.ts';
import type { AkrosOrderEmailEvent } from './templates.ts';
import {
  agendaNotificationEmail,
  akrosOrderEmail,
  escapeHtml,
  orderEventLabel,
  rentReminderEmail,
} from './templates.ts';

const epochMillis = (iso: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

export interface OrderEmailEvent {
  readonly at: string;
  readonly event: AkrosOrderEmailEvent;
  readonly reason?: string;
}

export const orderStatusEventOfLabel = (label: string | undefined): AkrosOrderEmailEvent | null => {
  if (label === undefined) {
    return null;
  }
  if (label.startsWith('Zpracovává se') || label.startsWith('Potvrzen')) {
    return 'CONFIRMED';
  }
  if (label.startsWith('Předáno dopravci')) {
    return 'SHIPPED';
  }
  if (label.startsWith('Dokončen')) {
    return 'DELIVERED';
  }
  if (label.startsWith('Stornovan') || label.startsWith('Zrušen')) {
    return 'CANCELLED';
  }
  return null;
};

export const orderStatusEventOfStatus = (status: string): AkrosOrderEmailEvent | null =>
  Match.value(status).pipe(
    Match.whenOr('CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', (event) => event),
    Match.orElse(() => null),
  );

export const orderEmailEvents = (order: AkrosOrderInput): readonly OrderEmailEvent[] => {
  const seen = new Set<AkrosOrderEmailEvent>(['ORDER_CREATED']);
  const events: OrderEmailEvent[] = [{ at: order.createdAt, event: 'ORDER_CREATED' }];
  for (const entry of order.history ?? []) {
    if (entry.kind === 'STATUS') {
      const event = orderStatusEventOfLabel(entry.after);
      if (event !== null && !seen.has(event)) {
        seen.add(event);
        const candidate = { at: entry.at, event };
        events.push(
          entry.reason === undefined || entry.reason === '' ? candidate : { ...candidate, reason: entry.reason },
        );
      }
    }
  }
  const current = orderStatusEventOfStatus(order.status);
  if (current !== null && !seen.has(current)) {
    events.push({ at: order.updatedAt, event: current });
  }
  const cutoff = order.demoCleanup === undefined ? null : epochMillis(order.demoCleanup.at);
  const kept = cutoff === null ? events : events.filter((e) => epochMillis(e.at) < cutoff);
  return kept.toSorted((a, b) => epochMillis(a.at) - epochMillis(b.at));
};

export const planAkrosOrderEmails = (
  order: AkrosOrderInput,
  options: {
    readonly enabledSince: string;
    readonly legalEntityId: string;
    readonly storefrontUrl: string;
    readonly tenantId: string;
  },
): readonly PlannedEmail[] => {
  const recipient = order.contact?.email?.trim() ?? '';
  if (
    order.channel !== 'STOREFRONT' ||
    recipient === '' ||
    epochMillis(order.createdAt) < epochMillis(options.enabledSince)
  ) {
    return [];
  }
  return orderEmailEvents(order).map((e) => {
    const rendered = akrosOrderEmail(
      order,
      e.event,
      e.reason === undefined
        ? { storefrontUrl: options.storefrontUrl }
        : { reason: e.reason, storefrontUrl: options.storefrontUrl },
    );
    return {
      dedupeKey: `akros-order:${order.id}:${e.event}`,
      event: e.event,
      eventAt: e.at,
      eventLabel: orderEventLabel(order, e.event),
      html: rendered.html,
      legalEntityId: options.legalEntityId,
      recipient,
      source: 'akros-order' as const,
      subject: rendered.subject,
      subjectId: order.id,
      subjectNumber: order.number,
      tenantId: options.tenantId,
      text: rendered.text,
    };
  });
};

export const planRentReminderEmail = (input: RentReminderInput, enabledSince: string): PlannedEmail | null => {
  const recipient = input.reminder.recipient.trim();
  if (
    input.reminder.deliveryMode !== 'EMAIL' ||
    recipient === '' ||
    epochMillis(input.reminder.createdAt) < epochMillis(enabledSince)
  ) {
    return null;
  }
  return {
    dedupeKey: `rent-reminder:${input.reminder.id}`,
    event: 'PAYMENT_REMINDER',
    eventAt: input.reminder.createdAt,
    eventLabel: 'Upomínka k úhradě',
    legalEntityId: input.legalEntityId,
    recipient,
    source: 'rent-reminder',
    subjectId: input.reminder.id,
    subjectNumber: input.invoiceNumber ?? '',
    tenantId: input.tenantId,
    ...rentReminderEmail(input),
  };
};

/**
 * Agenda e-mails of one person: only with e-mail switched on, only notifications created after it was switched on (and
 * after the dispatcher's first start), mandatory categories always, optional ones only when chosen. Older preference
 * rows without `emailCategories` get every optional category. One e-mail per delivery batch (same createdAt).
 */
export const planAgendaEmails = (
  input: AgendaRecipientInput,
  options: { readonly appUrl: string; readonly enabledSince: string },
): readonly PlannedEmail[] => {
  const recipient = input.email?.trim() ?? '';
  if (!input.preference.emailOptIn || recipient === '') {
    return [];
  }
  const since = Math.max(
    epochMillis(options.enabledSince),
    epochMillis(input.preference.emailSince ?? input.preference.updatedAt),
  );
  const optional = input.preference.emailCategories ?? AGENDA_OPTIONAL_EMAIL_CATEGORIES;
  const wanted = new Set([...AGENDA_MANDATORY_EMAIL_CATEGORIES, ...optional]);
  const batches = new Map<string, AgendaRecipientInput['notifications'][number][]>();
  for (const notification of input.notifications) {
    if (!wanted.has(notification.category) || epochMillis(notification.createdAt) < since) {
      continue;
    }
    const batch = batches.get(notification.createdAt) ?? [];
    batch.push(notification);
    batches.set(notification.createdAt, batch);
  }
  return [...batches.entries()].map(([createdAt, notifications]): PlannedEmail => {
    const subjectId = `${input.principalId}:${createdAt}`;
    return {
      dedupeKey: `facility-agenda:${subjectId}`,
      event: 'AGENDA_NOTIFICATION',
      eventAt: createdAt,
      eventLabel: notifications.length === 1 ? 'Upozornění z agendy' : `Upozornění z agendy (${notifications.length})`,
      legalEntityId: input.legalEntityId,
      recipient,
      source: 'facility-agenda',
      subjectId,
      subjectNumber: '',
      tenantId: input.tenantId,
      ...agendaNotificationEmail({ appUrl: options.appUrl, legalName: input.legalName, notifications }),
    };
  });
};

export const deliveryOutcomeOf = (error: { readonly _tag: string }): DeliveryOutcome =>
  Match.value(error).pipe(
    Match.when({ _tag: 'EmailDeliveryUnavailable' }, (failure): DeliveryOutcome => ({
      errorTag: failure._tag,
      status: 'RETRY',
    })),
    Match.whenOr(
      { _tag: 'EmailDeliveryRejected' },
      { _tag: 'EmailDeliveryInvalidMessage' },
      (failure): DeliveryOutcome => ({ errorTag: failure._tag, status: 'FAILED' }),
    ),
    Match.orElse((failure): DeliveryOutcome => ({ errorTag: failure._tag, status: 'UNKNOWN' })),
  );

/** One staff notification from committed inquiry task state. Ledger guarantees never-twice submission. */
export const planStorefrontInquiryEmail = (
  task: StorefrontInquiryTaskInput,
  options: {
    readonly appUrl: string;
    readonly enabledSince: string;
    readonly legalEntityId: string;
    readonly recipient: string;
    readonly tenantId: string;
  },
): PlannedEmail | null => {
  if (
    DateTime.toEpochMillis(DateTime.makeUnsafe(task.createdAt)) <
      DateTime.toEpochMillis(DateTime.makeUnsafe(options.enabledSince)) ||
    options.recipient.trim() === ''
  ) {
    return null;
  }
  const inquiry = task.storefrontInquiry;
  const labels = {
    COMPLAINT: 'Podnět k reklamaci (zatím ne reklamace)',
    CONTACT: 'Kontaktní dotaz',
    PRODUCT_QUESTION: 'Dotaz na produkt',
  };
  const text = [
    task.title,
    `Kontakt: ${inquiry.name} <${inquiry.email}>`,
    `Druh: ${labels[inquiry.kind]}`,
    ...(inquiry.productId !== undefined && inquiry.productId !== ''
      ? [`Produkt: ${inquiry.productName ?? inquiry.productId} (${inquiry.productId})`]
      : []),
    '',
    inquiry.message,
    '',
    `Úkol v OntOS: ${options.appUrl.replace(/\/+$/u, '')}/cs/ukoly`,
    `ID úkolu: ${task.ref.resourceId}`,
  ].join('\n');

  return {
    dedupeKey: `storefront-inquiry:${task.ref.resourceId}`,
    event: 'INQUIRY_RECEIVED',
    eventAt: task.createdAt,
    eventLabel: 'Nový dotaz z e-shopu',
    html: `<pre>${escapeHtml(text)}</pre>`,
    legalEntityId: options.legalEntityId,
    recipient: options.recipient.trim(),
    source: 'storefront-inquiry',
    subject: `AKROS: ${inquiry.subject}`,
    subjectId: task.ref.resourceId,
    subjectNumber: '',
    tenantId: options.tenantId,
    text,
  };
};
