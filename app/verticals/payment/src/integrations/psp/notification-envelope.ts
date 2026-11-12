import { Schema } from 'effect';

import { PaymentSourceOccurrenceIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema } from '../../../shared/domain/psp-configuration.ts';
import {
  GatewayEnvironmentSchema,
  ProviderNotificationAuthenticitySchema,
} from '../../../shared/domain/psp-vocabulary.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';

/**
 * Raw and verified provider notifications (#1157). Tenant and legal entity never come from these
 * fields: the capturing Action takes them from its admitted scope.
 */

export const RAW_PROVIDER_NOTIFICATION_MAXIMUM_BYTES = 65_536;

const headerText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));
const queryText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** The stored notification delivery identity bound (`psp_provider_notifications.delivery_identity`). */
export const DELIVERY_IDENTITY_MAX_LENGTH = 200;

/** Only the headers a verifier needs, lower-cased. Every other header is dropped by the relay. */
export const RawProviderNotificationHeadersSchema = Schema.Struct({
  contentType: Schema.Option(headerText),
  stripeSignature: Schema.Option(headerText),
});

/** Only the GoPay callback query parameters `id` and `parent_id`. */
export const RawProviderNotificationQuerySchema = Schema.Struct({
  parentPaymentRef: Schema.Option(queryText),
  paymentRef: Schema.Option(queryText),
});

export const RawProviderNotificationSchema = Schema.Struct({
  environment: GatewayEnvironmentSchema,
  family: PaymentGatewayProviderFamilySchema,
  headers: RawProviderNotificationHeadersSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  query: RawProviderNotificationQuerySchema,
  rawBody: Schema.Uint8Array.check(Schema.isMaxLength(RAW_PROVIDER_NOTIFICATION_MAXIMUM_BYTES)),
  receivedAt: Schema.DateTimeUtc,
  /** Relay-assigned delivery reference; part of the GoPay delivery identity. */
  transportDeliveryRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type RawProviderNotification = typeof RawProviderNotificationSchema.Type;

/**
 * An authentic (or lookup-required) trigger. `actionable: false` is stored and ACK-ed as IGNORED,
 * never submitted. Signed objects are re-read through lookup before a collection is confirmed.
 */
export const VerifiedNotificationTriggerSchema = Schema.Struct({
  actionable: Schema.Boolean,
  authenticity: ProviderNotificationAuthenticitySchema,
  claimedStatus: Schema.Option(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  /**
   * Unique per binding, e.g. `stripe:evt:<id>` or `gopay:<id>:<transportDeliveryRef>`. At most 200
   * characters, the stored column's bound; a family whose identity would be longer rejects the delivery.
   */
  deliveryIdentity: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(DELIVERY_IDENTITY_MAX_LENGTH)),
  family: PaymentGatewayProviderFamilySchema,
  providerEventAt: Schema.Option(Schema.DateTimeUtc),
  providerOccurrenceId: Schema.Option(PaymentSourceOccurrenceIdSchema),
  providerRefs: Schema.Array(ProviderObjectRefSchema),
  /** The signed provider object as JSON, decoded further by the provider MAP lane. */
  signedObject: Schema.Option(Schema.Json),
  verifiedAt: Schema.DateTimeUtc,
});
export type VerifiedNotificationTrigger = typeof VerifiedNotificationTriggerSchema.Type;
