// @effect-diagnostics *:off
// Receipt types copied verbatim from app/scripts/demo/email-dispatcher/contract.ts (no cross-package import).
export type EmailDeliveryStatus = 'SENDING' | 'SENT' | 'RETRY' | 'FAILED' | 'UNKNOWN';
export interface EmailDeliveryView {
  readonly createdAt: string;
  readonly event: string;
  readonly eventAt: string;
  readonly sentAt: string | null;
  readonly source: string;
  readonly status: EmailDeliveryStatus;
  readonly subjectId: string;
  readonly subjectNumber: string;
}
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
/** „Odesláno e-mailem · 21. 10. 2026 9:41“ for SENT, the plain status label otherwise. */
export const deliveryLabel = (delivery: EmailDeliveryView, formatTime: (iso: string) => string): string =>
  delivery.status === 'SENT' && delivery.sentAt !== null
    ? `${emailStatusLabels.SENT} · ${formatTime(delivery.sentAt)}`
    : emailStatusLabels[delivery.status];
