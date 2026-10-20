// @effect-diagnostics *:off
import type { AkrosOrderInput, DeliveryOutcome, PlannedEmail, SiamparkReminderInput } from './contract.ts';
import type { AkrosOrderEmailEvent } from './templates.ts';
import { akrosOrderEmail, siamparkReminderEmail } from './templates.ts';

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
    recipient,
    source: 'siampark-reminder',
    subjectId: input.reminder.id,
    subjectNumber: input.invoiceNumber ?? '',
    tenantId: input.tenantId,
    legalEntityId: input.legalEntityId,
    ...siamparkReminderEmail(input),
  };
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
