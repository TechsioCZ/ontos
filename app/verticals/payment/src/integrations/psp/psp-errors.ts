import { Schema } from 'effect';

import { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayCapabilitySchema } from '../../../shared/domain/psp-vocabulary.ts';

/**
 * Provider-neutral typed failures of the C17 gateway adapters (#1154, #1156-#1158). None carries a
 * provider body, request or credential: an HTTP request object would hold the `Authorization`
 * header, so no `cause` field exists here. `reason` is a short snake_case code or sentence.
 */

const makePspError = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => {
  const schema = Schema.TaggedStruct(tag, fields);
  return Schema.TaggedError<Schema.Schema.Type<typeof schema>>()(tag, fields);
};

const reasonText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** The family does not support this capability (e.g. GoPay CANCEL_OR_VOID). Never a fallback trigger. */
export const GatewayProviderUnsupported = makePspError('GatewayProviderUnsupported', {
  capability: GatewayCapabilitySchema,
  code: Schema.Literal('gateway_provider_unsupported'),
  family: PaymentGatewayProviderFamilySchema,
  reason: reasonText,
});
export type GatewayProviderUnsupportedError = Schema.Schema.Type<typeof GatewayProviderUnsupported>;

/** The provider, its credentials or its binding could not be reached before any effect was possible. */
export const GatewayProviderUnavailable = makePspError('GatewayProviderUnavailable', {
  code: Schema.Literal('gateway_provider_unavailable'),
  family: PaymentGatewayProviderFamilySchema,
  reason: reasonText,
});
export type GatewayProviderUnavailableError = Schema.Schema.Type<typeof GatewayProviderUnavailable>;

/** A mutation may or may not have taken effect (timeout, drop after write, 5xx, unparseable 2xx). */
export const GatewayProviderOutcomeUnknown = makePspError('GatewayProviderOutcomeUnknown', {
  code: Schema.Literal('gateway_provider_outcome_unknown'),
  family: PaymentGatewayProviderFamilySchema,
  operationId: PaymentOperationIdSchema,
  reason: reasonText,
});
export type GatewayProviderOutcomeUnknownError = Schema.Schema.Type<typeof GatewayProviderOutcomeUnknown>;

/** A read response did not decode against the provider schema; never interpreted as absence. */
export const GatewayProviderResponseInvalid = makePspError('GatewayProviderResponseInvalid', {
  code: Schema.Literal('gateway_provider_response_invalid'),
  family: PaymentGatewayProviderFamilySchema,
  reason: reasonText,
});
export type GatewayProviderResponseInvalidError = Schema.Schema.Type<typeof GatewayProviderResponseInvalid>;

/** Why a raw provider notification was refused before it was stored (#1157). */
export const GATEWAY_NOTIFICATION_REJECTION_REASONS = [
  'SIGNATURE_INVALID',
  'SIGNATURE_STALE',
  'SECRET_MISMATCH',
  'MERCHANT_MISMATCH',
  'ENVIRONMENT_MISMATCH',
  'MALFORMED',
  'BINDING_UNKNOWN',
] as const;
export const GatewayNotificationRejectionReasonSchema = Schema.Literals(GATEWAY_NOTIFICATION_REJECTION_REASONS);
export type GatewayNotificationRejectionReason = typeof GatewayNotificationRejectionReasonSchema.Type;

export const GatewayNotificationRejected = makePspError('GatewayNotificationRejected', {
  code: Schema.Literal('gateway_notification_rejected'),
  family: PaymentGatewayProviderFamilySchema,
  reason: GatewayNotificationRejectionReasonSchema,
});
export type GatewayNotificationRejectedError = Schema.Schema.Type<typeof GatewayNotificationRejected>;

/** Provider evidence contradicts an existing correlation (another ref or another binding). */
export const GatewayCorrelationConflict = makePspError('GatewayCorrelationConflict', {
  code: Schema.Literal('gateway_correlation_conflict'),
  reason: reasonText,
});
export type GatewayCorrelationConflictError = Schema.Schema.Type<typeof GatewayCorrelationConflict>;

/** The same Payment Operation arrived with different material or request bytes (#1158). No provider call. */
export const GatewayDispatchConflict = makePspError('GatewayDispatchConflict', {
  code: Schema.Literal('gateway_dispatch_conflict'),
  operationId: PaymentOperationIdSchema,
  reason: reasonText,
});
export type GatewayDispatchConflictError = Schema.Schema.Type<typeof GatewayDispatchConflict>;

/** C17 worker-owned state (ledger, evidence, notifications) could not be read or written. Retryable. */
export const GatewayLedgerUnavailable = makePspError('GatewayLedgerUnavailable', {
  code: Schema.Literal('gateway_ledger_unavailable'),
  reason: reasonText,
});
export type GatewayLedgerUnavailableError = Schema.Schema.Type<typeof GatewayLedgerUnavailable>;
