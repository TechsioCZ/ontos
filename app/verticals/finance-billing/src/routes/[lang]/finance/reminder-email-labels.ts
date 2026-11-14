import type { EmailDeliveryReceiptSchema, EmailDeliveryStatusSchema } from '@app/email-delivery/receipt-api';

export type EmailDeliveryStatus = typeof EmailDeliveryStatusSchema.Type;
export type EmailDeliveryView = typeof EmailDeliveryReceiptSchema.Encoded;
export const emailStatusLabels = {
  FAILED: 'Odeslání selhalo',
  RETRY: 'Čeká na opakování – e-mailová služba nedostupná',
  SENDING: 'Odesílá se…',
  SENT: 'Odesláno e-mailem',
  SKIPPED: 'Přeskočeno – nedoručitelná adresa příjemce',
  UNKNOWN: 'Výsledek odeslání nejistý – neopakuje se',
} satisfies Readonly<Record<EmailDeliveryStatus, string>>;
export const emailStatusVariant = {
  FAILED: 'danger',
  RETRY: 'warning',
  SENDING: 'info',
  SENT: 'success',
  SKIPPED: 'warning',
  UNKNOWN: 'warning',
} as const satisfies Readonly<Record<EmailDeliveryStatus, 'danger' | 'info' | 'success' | 'warning'>>;
/** „Odesláno e-mailem · 21. 10. 2026 9:41“ for SENT, the plain status label otherwise. */
export const deliveryLabel = (delivery: EmailDeliveryView, formatTime: (iso: string) => string): string =>
  delivery.status === 'SENT' && delivery.sentAt !== null
    ? `${emailStatusLabels.SENT} · ${formatTime(delivery.sentAt)}`
    : emailStatusLabels[delivery.status];
