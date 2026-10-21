// @effect-diagnostics *:off
// Receipt types copied verbatim from app/scripts/demo/email-dispatcher/contract.ts (no cross-package import).
export type EmailDeliveryEvent =
  | 'ORDER_CREATED'
  | 'CONFIRMED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'PAYMENT_REMINDER';
export type EmailDeliveryStatus = 'SENDING' | 'SENT' | 'RETRY' | 'FAILED' | 'UNKNOWN';
export interface EmailDeliveryView {
  readonly createdAt: string;
  readonly event: EmailDeliveryEvent;
  readonly eventAt: string;
  /** Czech label as e-mailed ('Připraveno k vyzvednutí' for pickup orders); null on older rows. */
  readonly eventLabel: string | null;
  readonly sentAt: string | null;
  readonly source: string;
  readonly status: EmailDeliveryStatus;
  readonly subjectId: string;
  readonly subjectNumber: string;
}
export const emailEventLabels: Readonly<Record<EmailDeliveryEvent, string>> = {
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Potvrzená',
  DELIVERED: 'Dokončená',
  ORDER_CREATED: 'Přijetí objednávky',
  PAYMENT_REMINDER: 'Upomínka k úhradě',
  SHIPPED: 'Předáno dopravci',
};
export const emailStatusLabels: Readonly<Record<EmailDeliveryStatus, string>> = {
  FAILED: 'Odeslání selhalo',
  RETRY: 'Čeká na opakování – SMTP server nedostupný',
  SENDING: 'Odesílá se…',
  SENT: 'Odesláno e-mailem',
  UNKNOWN: 'Výsledek odeslání nejistý – neopakuje se',
};
export const emailStatusVariant: Readonly<Record<EmailDeliveryStatus, 'danger' | 'info' | 'success' | 'warning'>> = {
  FAILED: 'danger',
  RETRY: 'warning',
  SENDING: 'info',
  SENT: 'success',
  UNKNOWN: 'warning',
};
export const deliveryLabel = (delivery: EmailDeliveryView, formatTime: (iso: string) => string): string =>
  delivery.status === 'SENT' && delivery.sentAt !== null
    ? `${emailStatusLabels.SENT} · ${formatTime(delivery.sentAt)}`
    : emailStatusLabels[delivery.status];
