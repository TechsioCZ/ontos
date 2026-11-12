import { Schema } from 'effect';

import type { PaymentObservationFactKind } from './payment-vocabulary.ts';

/**
 * Closed PSP gateway vocabulary (#1154-#1159). Owned once here; the database CHECK constraints
 * (W1-DB), the worker ledger, the adapters and the Reads all derive from these arrays.
 */

/** Gateway environment of one Provider Account Binding. SANDBOX and LIVE are never interchangeable (#1155). */
export const GATEWAY_ENVIRONMENTS = ['SANDBOX', 'LIVE'] as const;
export const GatewayEnvironmentSchema = Schema.Literals(GATEWAY_ENVIRONMENTS);
export type GatewayEnvironment = typeof GatewayEnvironmentSchema.Type;

/** Current gives new-intent selection; retired bindings stay addressable for historical operations (#1155). */
export const GATEWAY_BINDING_STATUSES = ['CURRENT', 'RETIRED_FOR_NEW_INTENTS'] as const;
export const GatewayBindingStatusSchema = Schema.Literals(GATEWAY_BINDING_STATUSES);
export type GatewayBindingStatus = typeof GatewayBindingStatusSchema.Type;

/** Credential revision state. Rotation retires the previous revision; the account identity does not change. */
export const GATEWAY_CREDENTIAL_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export const GatewayCredentialStatusSchema = Schema.Literals(GATEWAY_CREDENTIAL_STATUSES);
export type GatewayCredentialStatus = typeof GatewayCredentialStatusSchema.Type;

/** Worker-side dispatch ledger state of one provider-executed Payment Operation (#1156, #1158). */
export const PROVIDER_DISPATCH_STATES = [
  'AWAITING_TARGET',
  'PREPARED',
  'ACKNOWLEDGED',
  'REJECTED_BEFORE_EFFECT',
  'OUTCOME_UNKNOWN',
  'UNSUPPORTED',
  'NOT_SENT',
  'TARGET_UNRESOLVED',
] as const;
export const ProviderDispatchStateSchema = Schema.Literals(PROVIDER_DISPATCH_STATES);
export type ProviderDispatchState = typeof ProviderDispatchStateSchema.Type;

/**
 * Why a Payment Operation was never sent to the provider. PRIOR_REFUND_UNRESOLVED: a GoPay or Comgate
 * refund stayed deferred behind another unresolved refund of the same provider payment until the
 * executor's deferral was exhausted (refunds per provider payment are serialized, plan §2.1).
 */
export const PROVIDER_NOT_SENT_REASONS = [
  'WITHHELD_FOR_CANCELLATION',
  'TARGET_WITHHELD',
  'TARGET_NOT_EFFECTED',
  'PREPARE_UNAVAILABLE',
  'PRIOR_REFUND_UNRESOLVED',
] as const;
export const ProviderNotSentReasonSchema = Schema.Literals(PROVIDER_NOT_SENT_REASONS);
export type ProviderNotSentReason = typeof ProviderNotSentReasonSchema.Type;

/** Processing state of one raw provider notification. Rejected notifications are not stored (Action returns REJECTED). */
export const PROVIDER_NOTIFICATION_STATES = [
  'CAPTURED',
  'IGNORED',
  'HELD_UNCORRELATED',
  'SUBMITTED',
  'SUBMISSION_HELD',
  'SUBMISSION_DENIED',
] as const;
export const ProviderNotificationStateSchema = Schema.Literals(PROVIDER_NOTIFICATION_STATES);
export type ProviderNotificationState = typeof ProviderNotificationStateSchema.Type;

/** How a provider notification was authenticated before it was trusted. */
export const PROVIDER_NOTIFICATION_AUTHENTICITY = [
  'SIGNATURE_VERIFIED',
  'SHARED_SECRET_VERIFIED',
  'LOOKUP_REQUIRED',
] as const;
export const ProviderNotificationAuthenticitySchema = Schema.Literals(PROVIDER_NOTIFICATION_AUTHENTICITY);
export type ProviderNotificationAuthenticity = typeof ProviderNotificationAuthenticitySchema.Type;

/** Result of capturing one verified notification into the notification store. */
export const PROVIDER_CAPTURE_RESULTS = ['CAPTURED', 'DUPLICATE', 'IGNORED', 'REJECTED'] as const;
export const ProviderCaptureResultSchema = Schema.Literals(PROVIDER_CAPTURE_RESULTS);
export type ProviderCaptureResult = typeof ProviderCaptureResultSchema.Type;

/** Where a provider evidence item came from. */
export const PROVIDER_EVIDENCE_ORIGINS = [
  'NOTIFICATION_LOOKUP',
  'NOTIFICATION_SIGNED',
  'DISPATCH_RESPONSE',
  'LOCAL_NOT_SENT',
  'RECOVERY_LOOKUP',
  'RECOVERY_REPLAY',
] as const;
export const ProviderEvidenceOriginSchema = Schema.Literals(PROVIDER_EVIDENCE_ORIGINS);
export type ProviderEvidenceOrigin = typeof ProviderEvidenceOriginSchema.Type;

/**
 * C16 observation facts a gateway adapter may state. Never UNRECOGNIZED; never SOURCE_CORRECTION (an
 * adapter cannot name the corrected observation, so a later contrary provider state is a new occurrence of
 * the contrary fact); never SETTLEMENT_OBSERVED (settlement is not mapped at Launch, plan N15).
 */
export const PROVIDER_EVIDENCE_FACT_KINDS = [
  'COLLECTION_PENDING',
  'COLLECTION_CONFIRMED',
  'COLLECTION_NOT_EFFECTED',
  'CANCEL_CONFIRMED',
  'CANCEL_NOT_EFFECTED',
  'REFUND_PENDING',
  'REFUND_INDETERMINATE',
  'REFUND_CONFIRMED',
  'REFUND_NOT_EFFECTED',
] as const satisfies readonly PaymentObservationFactKind[];
export const ProviderEvidenceFactKindSchema = Schema.Literals(PROVIDER_EVIDENCE_FACT_KINDS);
export type ProviderEvidenceFactKind = typeof ProviderEvidenceFactKindSchema.Type;

/** Submission state of one evidence item sent to the Payment observation owner. */
export const PROVIDER_EVIDENCE_SUBMISSION_STATES = [
  'PENDING_SUBMISSION',
  'ACCEPTED',
  'DUPLICATE',
  'HELD',
  'CONFLICT',
  'DENIED',
] as const;
export const ProviderEvidenceSubmissionStateSchema = Schema.Literals(PROVIDER_EVIDENCE_SUBMISSION_STATES);
export type ProviderEvidenceSubmissionState = typeof ProviderEvidenceSubmissionStateSchema.Type;

/**
 * Adapter finding about one operation, independent of any provider status enum. An unsupported
 * capability and an unreachable provider are typed adapter failures (`GatewayProviderUnsupported`,
 * `GatewayProviderUnavailable`), never findings.
 */
export const PROVIDER_FINDINGS = [
  'ACCEPTED_PENDING',
  'CUSTOMER_ACTION_REQUIRED',
  'EFFECT_CONFIRMED',
  'NOT_EFFECTED',
  'INDETERMINATE',
  'VERIFICATION_CONFLICT',
] as const;
export const ProviderFindingSchema = Schema.Literals(PROVIDER_FINDINGS);
export type ProviderFinding = typeof ProviderFindingSchema.Type;

/** Operations a gateway family can perform at Launch. Unsupported capabilities are declared, never guessed. */
export const GATEWAY_CAPABILITIES = ['COLLECT', 'RETRIEVE', 'CANCEL_OR_VOID', 'REFUND', 'NOTIFICATION'] as const;
export const GatewayCapabilitySchema = Schema.Literals(GATEWAY_CAPABILITIES);
export type GatewayCapability = typeof GatewayCapabilitySchema.Type;
