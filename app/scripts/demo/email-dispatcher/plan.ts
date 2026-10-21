// @effect-diagnostics *:off
import type { AgendaRecipientInput, AkrosOrderInput, DeliveryOutcome, PlannedEmail, SiamparkReminderInput } from './contract.ts';
import { AGENDA_MANDATORY_EMAIL_CATEGORIES, AGENDA_OPTIONAL_EMAIL_CATEGORIES } from './contract.ts';
import type { AkrosOrderEmailEvent } from './templates.ts';
import { agendaNotificationEmail, akrosOrderEmail, orderEventLabel, siamparkReminderEmail } from './templates.ts';

export interface OrderEmailEvent {
  readonly at: string;
  readonly event: AkrosOrderEmailEvent;
  readonly reason?: string;
}

export const orderStatusEventOfLabel = (label: string | undefined): AkrosOrderEmailEvent | null => {
  if (label === undefined) return null;
  if (label.startsWith('Zpracovává se') || label.startsWith('Potvrzen')) return 'CONFIRMED';
  if (label.startsWith('Předáno dopravci')) return 'SHIPPED';
  if (label.startsWith('Dokončen')) return 'DELIVERED';
  if (label.startsWith('Stornovan') || label.startsWith('Zrušen')) return 'CANCELLED';
  return null;
};

export const orderStatusEventOfStatus = (status: string): AkrosOrderEmailEvent | null => {
  switch (status) {
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'SHIPPED':
      return 'SHIPPED';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return null;
  }
};

export const orderEmailEvents = (order: AkrosOrderInput): readonly OrderEmailEvent[] => {
  const seen = new Set<AkrosOrderEmailEvent>(['ORDER_CREATED']);
  const events: OrderEmailEvent[] = [{ event: 'ORDER_CREATED', at: order.createdAt }];
  for (const entry of order.history ?? []) {
    if (entry.kind !== 'STATUS') continue;
    const event = orderStatusEventOfLabel(entry.after);
    if (event === null || seen.has(event)) continue;
    seen.add(event);
    events.push({
      event,
      at: entry.at,
      ...(entry.reason !== undefined && entry.reason !== '' ? { reason: entry.reason } : {}),
    });
  }
  const current = orderStatusEventOfStatus(order.status);
  if (current !== null && !seen.has(current)) events.push({ event: current, at: order.updatedAt });
  const cutoff = order.demoCleanup === undefined ? null : Date.parse(order.demoCleanup.at);
  const kept = cutoff === null ? events : events.filter((e) => Date.parse(e.at) < cutoff);
  return kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
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
    Date.parse(order.createdAt) < Date.parse(options.enabledSince)
  ) {
    return [];
  }
  return orderEmailEvents(order).map((e) => {
    const rendered = akrosOrderEmail(
      order,
      e.event,
      e.reason === undefined ? { storefrontUrl: options.storefrontUrl } : { reason: e.reason, storefrontUrl: options.storefrontUrl },
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

export const planSiamparkReminderEmail = (input: SiamparkReminderInput, enabledSince: string): PlannedEmail | null => {
  const recipient = input.reminder.recipient.trim();
  if (
    input.reminder.deliveryMode !== 'EMAIL' ||
    recipient === '' ||
    Date.parse(input.reminder.createdAt) < Date.parse(enabledSince)
  ) {
    return null;
  }
  return {
    dedupeKey: `siampark-reminder:${input.reminder.id}`,
    event: 'PAYMENT_REMINDER',
    eventAt: input.reminder.createdAt,
    eventLabel: 'Upomínka k úhradě',
    recipient,
    source: 'siampark-reminder',
    subjectId: input.reminder.id,
    subjectNumber: input.invoiceNumber ?? '',
    tenantId: input.tenantId,
    legalEntityId: input.legalEntityId,
    ...siamparkReminderEmail(input),
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
  if (!input.preference.emailOptIn || recipient === '') return [];
  const since = Math.max(
    Date.parse(options.enabledSince),
    Date.parse(input.preference.emailSince ?? input.preference.updatedAt),
  );
  const optional = input.preference.emailCategories ?? AGENDA_OPTIONAL_EMAIL_CATEGORIES;
  const wanted = new Set([...AGENDA_MANDATORY_EMAIL_CATEGORIES, ...optional]);
  const batches = new Map<string, AgendaRecipientInput['notifications'][number][]>();
  for (const notification of input.notifications) {
    if (!wanted.has(notification.category) || Date.parse(notification.createdAt) < since) continue;
    const batch = batches.get(notification.createdAt) ?? [];
    batch.push(notification);
    batches.set(notification.createdAt, batch);
  }
  return [...batches.entries()].map(([createdAt, notifications]): PlannedEmail => {
    const subjectId = `${input.principalId}:${createdAt}`;
    return {
      dedupeKey: `siampark-agenda:${subjectId}`,
      event: 'AGENDA_NOTIFICATION',
      eventAt: createdAt,
      eventLabel: notifications.length === 1 ? 'Upozornění z agendy' : `Upozornění z agendy (${notifications.length})`,
      legalEntityId: input.legalEntityId,
      recipient,
      source: 'siampark-agenda',
      subjectId,
      subjectNumber: '',
      tenantId: input.tenantId,
      ...agendaNotificationEmail({ appUrl: options.appUrl, legalName: input.legalName, notifications }),
    };
  });
};

export const deliveryOutcomeOf = (error: { readonly _tag: string }): DeliveryOutcome => {
  switch (error._tag) {
    case 'EmailDeliveryUnavailable':
      return { errorTag: error._tag, status: 'RETRY' };
    case 'EmailDeliveryRejected':
    case 'EmailDeliveryInvalidMessage':
      return { errorTag: error._tag, status: 'FAILED' };
    default:
      return { errorTag: error._tag, status: 'UNKNOWN' };
  }
};
