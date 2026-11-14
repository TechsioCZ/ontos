// Presentation of Shell-owned receipts; nullable wire fields remain nullable in this view.
import { emailStatusLabels } from '@app/email-delivery/receipt-api';
import type { EmailDeliveryReceiptSchema, EmailDeliveryStatusSchema } from '@app/email-delivery/receipt-api';

export { emailEventLabels } from '@app/email-delivery/receipt-api';

export type EmailDeliveryStatus = typeof EmailDeliveryStatusSchema.Type;
type ReceiptView = typeof EmailDeliveryReceiptSchema.Encoded;
/** A missing legacy event label falls back to the canonical event wording. */
export type EmailDeliveryView = Omit<ReceiptView, 'eventLabel'> & Partial<Pick<ReceiptView, 'eventLabel'>>;

export const emailStatusVariant = {
  FAILED: 'danger',
  RETRY: 'warning',
  SENDING: 'info',
  SENT: 'success',
  SKIPPED: 'warning',
  UNKNOWN: 'warning',
} as const satisfies Readonly<Record<EmailDeliveryStatus, 'danger' | 'info' | 'success' | 'warning'>>;
export const deliveryLabel = (delivery: EmailDeliveryView, formatTime: (iso: string) => string): string =>
  delivery.status === 'SENT' && delivery.sentAt !== null
    ? `${emailStatusLabels.SENT} · ${formatTime(delivery.sentAt)}`
    : emailStatusLabels[delivery.status];
