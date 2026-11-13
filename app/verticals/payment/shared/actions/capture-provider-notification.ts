import { Schema } from 'effect';

import { PaymentGatewayProviderFamilySchema } from '../domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema } from '../domain/psp-configuration.ts';
import { GatewayEnvironmentSchema } from '../domain/psp-vocabulary.ts';

/**
 * Capture one provider notification delivered by the PSP notification relay workload (#1157).
 *
 * The relay forwards the exact raw body (base64 in JSON), only the allow-listed headers and query
 * parameters, and its own delivery reference. Tenant and Selling Legal Entity come only from the
 * Core-verified invocation scope, never from these fields; the receipt instant is OntOS's own clock.
 *
 * The relay acknowledges the provider (2xx) for CAPTURED, DUPLICATE and IGNORED, and answers non-2xx for
 * REJECTED and for every capture failure, so the provider retries what OntOS did not durably record.
 */

/** Largest raw notification body OntOS stores (64 KiB); equal to the adapter envelope limit. */
export const CAPTURED_NOTIFICATION_MAXIMUM_BYTES = 65_536;

const headerText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));
const queryText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Lower-cased `content-type` and `stripe-signature` only; the relay drops every other header. */
const CapturedNotificationHeadersSchema = Schema.Struct({
  contentType: Schema.optionalKey(headerText),
  stripeSignature: Schema.optionalKey(headerText),
});

/** The GoPay callback query parameters `id` (paymentRef) and `parent_id` (parentPaymentRef) only. */
const CapturedNotificationQuerySchema = Schema.Struct({
  parentPaymentRef: Schema.optionalKey(queryText),
  paymentRef: Schema.optionalKey(queryText),
});

export const CaptureProviderNotificationPayloadSchema = Schema.Struct({
  environment: GatewayEnvironmentSchema,
  family: PaymentGatewayProviderFamilySchema,
  headers: CapturedNotificationHeadersSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  query: CapturedNotificationQuerySchema,
  /** The exact bytes the provider sent, base64-encoded; at most 64 KiB once decoded. */
  rawBody: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(CAPTURED_NOTIFICATION_MAXIMUM_BYTES)),
  /** Relay-assigned delivery reference; part of the GoPay delivery identity. */
  transportDeliveryRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed()),
});
export type CaptureProviderNotificationPayload = typeof CaptureProviderNotificationPayloadSchema.Type;

/** Why a notification was refused before anything was stored. */
export const CAPTURE_REJECTION_REASONS = [
  'SIGNATURE_INVALID',
  'SIGNATURE_STALE',
  'SECRET_MISMATCH',
  'MERCHANT_MISMATCH',
  'ENVIRONMENT_MISMATCH',
  'MALFORMED',
  'BINDING_UNKNOWN',
] as const;
export const CaptureRejectionReasonSchema = Schema.Literals(CAPTURE_REJECTION_REASONS);

export const CapturedProviderNotificationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ProviderNotificationId'),
);

export const CaptureProviderNotificationResultSchema = Schema.Union([
  /** Authentic and actionable: stored with its processing message in the same transaction. */
  Schema.TaggedStruct('CAPTURED', { notificationId: CapturedProviderNotificationIdSchema }),
  /** The same delivery was already stored; nothing new was written. */
  Schema.TaggedStruct('DUPLICATE', { notificationId: CapturedProviderNotificationIdSchema }),
  /** Authentic but not actionable (e.g. an unmapped event type): stored, never processed. */
  Schema.TaggedStruct('IGNORED', { notificationId: CapturedProviderNotificationIdSchema }),
  /** Not authentic for this binding, or no such binding in this scope: nothing stored. */
  Schema.TaggedStruct('REJECTED', { reason: CaptureRejectionReasonSchema }),
]);
export type CaptureProviderNotificationResult = typeof CaptureProviderNotificationResultSchema.Type;
