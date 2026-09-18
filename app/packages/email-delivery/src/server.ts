import type { Effect, Redacted } from 'effect';
import { Context } from 'effect';

import type { EmailDeliveryAcceptanceIndeterminate } from './indeterminate.ts';
import type { EmailDeliveryInvalidMessage } from './invalid-message.ts';
import type { EmailDeliveryRejected } from './rejected.ts';
import type { EmailDeliveryUnavailable } from './unavailable.ts';

export { EmailDeliveryAcceptanceIndeterminate } from './indeterminate.ts';
export { EmailDeliveryInvalidMessage } from './invalid-message.ts';
export { EmailDeliveryRejected } from './rejected.ts';
export { EmailDeliveryUnavailable } from './unavailable.ts';

/** A server-owned message; credentials and delivery endpoints are deployment configuration. */
export interface EmailDeliveryMessage {
  readonly html?: Redacted.Redacted;
  /** An opaque provider idempotency key; this adapter never retries a submission automatically. */
  readonly idempotencyKey?: string;
  readonly subject: string;
  readonly text: Redacted.Redacted;
  readonly to: string;
}

/**
 * A provider submission receipt. `accepted` means the provider accepted the API submission;
 * it does not claim inbox delivery or recipient acceptance.
 */
export interface EmailDeliveryReceipt {
  readonly accepted: true;
  readonly id: string;
}

export type EmailDeliveryError =
  | EmailDeliveryAcceptanceIndeterminate
  | EmailDeliveryInvalidMessage
  | EmailDeliveryRejected
  | EmailDeliveryUnavailable;

/** A single provider submission attempt with no automatic retry or inbox-delivery guarantee. */
export interface EmailDeliveryServiceContract {
  readonly send: (message: EmailDeliveryMessage) => Effect.Effect<EmailDeliveryReceipt, EmailDeliveryError>;
}

/** Provider-neutral server seam for transactional email submission. */
export class EmailDeliveryService extends Context.Service<EmailDeliveryService, EmailDeliveryServiceContract>()(
  '@app/email-delivery/server/EmailDeliveryService',
) {}
