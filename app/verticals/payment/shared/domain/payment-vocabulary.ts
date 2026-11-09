import { Schema } from 'effect';

/**
 * Canonical C16 Payment vocabulary (#1145, #1147-#1153). Every closed set is owned once here; the
 * database checks, calculators, Actions and Reads all derive from these arrays.
 */

/** The business way the customer pays (#1147). A gateway name is routing, never a method. */
export const PAYMENT_METHODS = [
  'ONLINE_GATEWAY',
  'BANK_TRANSFER_ADVANCE',
  'CASH_ON_DELIVERY',
  'DEFERRED_INVOICE',
  'PAY_ON_PICKUP_OR_ON_SITE',
] as const;
export const PaymentMethodSchema = Schema.Literals(PAYMENT_METHODS);
export type PaymentMethod = typeof PaymentMethodSchema.Type;

/** Methods whose commitment proof requires Current proven collection coverage (#1149). */
export const PREPAID_PAYMENT_METHODS = ['ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE'] as const;
export const PrepaidPaymentMethodSchema = Schema.Literals(PREPAID_PAYMENT_METHODS);

/** One logical monetary operation kind (#1148). Settlement is evidence, never an operation. */
export const PAYMENT_OPERATION_KINDS = ['COLLECT', 'CANCEL_OR_VOID', 'REFUND'] as const;
export const PaymentOperationKindSchema = Schema.Literals(PAYMENT_OPERATION_KINDS);
export type PaymentOperationKind = typeof PaymentOperationKindSchema.Type;

/** Business outcome of one operation, independent of provider status enums (#1148). */
export const PAYMENT_OPERATION_OUTCOMES = [
  'PENDING',
  'EFFECT_CONFIRMED',
  'NOT_EFFECTED_CONFIRMED',
  'INDETERMINATE',
  'CONFLICT',
] as const;
export const PaymentOperationOutcomeSchema = Schema.Literals(PAYMENT_OPERATION_OUTCOMES);
export type PaymentOperationOutcome = typeof PaymentOperationOutcomeSchema.Type;

/** Outcomes that still hold an unresolved monetary effect and its reservations (#1150). */
export const UNRESOLVED_PAYMENT_OPERATION_OUTCOMES = ['PENDING', 'INDETERMINATE', 'CONFLICT'] as const;
export const UnresolvedPaymentOperationOutcomeSchema = Schema.Literals(UNRESOLVED_PAYMENT_OPERATION_OUTCOMES);

/** Why an operation outcome row was appended. */
export const PAYMENT_OUTCOME_TRANSITION_CAUSES = ['CREATION', 'OBSERVATION', 'RECONCILIATION', 'RECOVERY'] as const;
export const PaymentOutcomeTransitionCauseSchema = Schema.Literals(PAYMENT_OUTCOME_TRANSITION_CAUSES);
export type PaymentOutcomeTransitionCause = typeof PaymentOutcomeTransitionCauseSchema.Type;

/** The two immutable REFUND business bases (#1150). */
export const PAYMENT_REFUND_BASIS_KINDS = ['REFUNDABLE_ITEMS', 'FAILED_COMMITMENT_COMPENSATION'] as const;
export const PaymentRefundBasisKindSchema = Schema.Literals(PAYMENT_REFUND_BASIS_KINDS);
export type PaymentRefundBasisKind = typeof PaymentRefundBasisKindSchema.Type;

/** Payment-owned availability of one authoritative refundable item (#1150). */
export const PAYMENT_REFUNDABLE_ITEM_AVAILABILITIES = ['AVAILABLE', 'RESERVED_BY_PENDING_REFUND', 'REFUNDED'] as const;
export const PaymentRefundableItemAvailabilitySchema = Schema.Literals(PAYMENT_REFUNDABLE_ITEM_AVAILABILITIES);
export type PaymentRefundableItemAvailability = typeof PaymentRefundableItemAvailabilitySchema.Type;

/** Typed applicability outcomes (#1147); absence, incompatibility and unverifiable facts stay distinct. */
export const PAYMENT_APPLICABILITY_OUTCOMES = [
  'AVAILABLE',
  'NOT_ENABLED',
  'INCOMPATIBLE_TERM',
  'UNSUPPORTED_CAPABILITY',
  'MISSING_REQUIRED_INPUT',
  'UNAVAILABLE_TO_VERIFY',
  'CONFLICTING_CONFIGURATION',
] as const;
export const PaymentApplicabilityOutcomeSchema = Schema.Literals(PAYMENT_APPLICABILITY_OUTCOMES);
export type PaymentApplicabilityOutcome = typeof PaymentApplicabilityOutcomeSchema.Type;

/** Minimum Launch observation fact vocabulary (#1151). Provider names stay source metadata. */
export const PAYMENT_OBSERVATION_FACT_KINDS = [
  'COLLECTION_PENDING',
  'COLLECTION_CONFIRMED',
  'COLLECTION_NOT_EFFECTED',
  'CANCEL_CONFIRMED',
  'CANCEL_NOT_EFFECTED',
  'REFUND_PENDING',
  'REFUND_CONFIRMED',
  'REFUND_NOT_EFFECTED',
  'SETTLEMENT_OBSERVED',
  'SOURCE_CORRECTION',
  'UNRECOGNIZED',
] as const;
export const PaymentObservationFactKindSchema = Schema.Literals(PAYMENT_OBSERVATION_FACT_KINDS);
export type PaymentObservationFactKind = typeof PaymentObservationFactKindSchema.Type;

/** Recorded acceptance decision of one observation (#1151/#1152). */
export const PAYMENT_OBSERVATION_ACCEPTANCE_OUTCOMES = [
  'ACCEPTED_OBSERVATION',
  'DUPLICATE',
  'HELD_UNRESOLVED',
  'CONFLICT',
  'UNAUTHORIZED_SOURCE',
  'UNSUPPORTED_FACT',
] as const;
export const PaymentObservationAcceptanceOutcomeSchema = Schema.Literals(PAYMENT_OBSERVATION_ACCEPTANCE_OUTCOMES);
export type PaymentObservationAcceptanceOutcome = typeof PaymentObservationAcceptanceOutcomeSchema.Type;

/** Authority is qualified per fact family (#1152), never by a global source precedence. */
export const PAYMENT_SOURCE_FACT_FAMILIES = [
  'BANK_ACCOUNTING_RECEIPT',
  'DEFERRED_INVOICE_RECEIPT',
  'COD_CUSTOMER_COLLECTION',
  'COD_REMITTANCE',
  'LOCAL_POS_COLLECTION',
  'GATEWAY_OUTCOME',
  'REFUND_EXECUTION',
  'SETTLEMENT_REMITTANCE',
] as const;
export const PaymentSourceFactFamilySchema = Schema.Literals(PAYMENT_SOURCE_FACT_FAMILIES);
export type PaymentSourceFactFamily = typeof PaymentSourceFactFamilySchema.Type;

export const PAYMENT_SOURCE_KINDS = [
  'BANK_ACCOUNTING',
  'CARRIER',
  'LOCAL_POS_OPERATOR',
  'PAYMENT_GATEWAY',
  'MANUAL_EXTERNAL_REFUND',
] as const;
export const PaymentSourceKindSchema = Schema.Literals(PAYMENT_SOURCE_KINDS);
export type PaymentSourceKind = typeof PaymentSourceKindSchema.Type;

export const PAYMENT_SOURCE_AUTHORITY_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const PaymentSourceAuthorityStatusSchema = Schema.Literals(PAYMENT_SOURCE_AUTHORITY_STATUSES);
export type PaymentSourceAuthorityStatus = typeof PaymentSourceAuthorityStatusSchema.Type;

/** Payment Authorization proof kinds (#1149); deferred/handover conditions never become prepaid proofs. */
export const PAYMENT_AUTHORIZATION_PROOF_KINDS = ['PREPAID_COVERAGE', 'METHOD_CONDITION'] as const;
export const PaymentAuthorizationProofKindSchema = Schema.Literals(PAYMENT_AUTHORIZATION_PROOF_KINDS);
export type PaymentAuthorizationProofKind = typeof PaymentAuthorizationProofKindSchema.Type;

/** Allowed recovery modes of one original operation (#1151). */
export const PAYMENT_RECOVERY_MODES = [
  'PROVIDER_IDEMPOTENT_REPLAY',
  'AUTHORITATIVE_LOOKUP',
  'AWAIT_QUALIFIED_EVIDENCE',
  'GOVERNED_RECONCILIATION',
] as const;
export const PaymentRecoveryModeSchema = Schema.Literals(PAYMENT_RECOVERY_MODES);
export type PaymentRecoveryMode = typeof PaymentRecoveryModeSchema.Type;

export const PAYMENT_RECONCILIATION_CASE_STATUSES = ['OPEN', 'CLOSED'] as const;
export const PaymentReconciliationCaseStatusSchema = Schema.Literals(PAYMENT_RECONCILIATION_CASE_STATUSES);
export type PaymentReconciliationCaseStatus = typeof PaymentReconciliationCaseStatusSchema.Type;

/** What a reconciliation case holds: evidence that could not be assigned, a conflicting operation, or funds. */
export const PAYMENT_RECONCILIATION_CASE_KINDS = [
  'HELD_OBSERVATION',
  'OPERATION_CONFLICT',
  'AMBIGUOUS_FUNDS',
  'UNRESOLVED_OPERATION',
] as const;
export const PaymentReconciliationCaseKindSchema = Schema.Literals(PAYMENT_RECONCILIATION_CASE_KINDS);
export type PaymentReconciliationCaseKind = typeof PaymentReconciliationCaseKindSchema.Type;

export const PAYMENT_RECONCILIATION_DECISION_KINDS = ['ATTACH_EVIDENCE', 'CLASSIFY_CONFLICT', 'CLOSE_CASE'] as const;
export const PaymentReconciliationDecisionKindSchema = Schema.Literals(PAYMENT_RECONCILIATION_DECISION_KINDS);
export type PaymentReconciliationDecisionKind = typeof PaymentReconciliationDecisionKindSchema.Type;

/** Gateway families supported at Launch (#1146/#1155); routing identity, never a Payment Method. */
export const PAYMENT_GATEWAY_PROVIDER_FAMILIES = ['GOPAY', 'STRIPE', 'COMGATE'] as const;
export const PaymentGatewayProviderFamilySchema = Schema.Literals(PAYMENT_GATEWAY_PROVIDER_FAMILIES);
export type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

/** Immutable execution binding kinds stored on a Payment and its operations. */
export const PAYMENT_EXECUTION_BINDING_KINDS = [
  'GATEWAY_ACCOUNT',
  'BANK_ACCOUNTING_RECEIPT',
  'COD_DELIVERY_OFFER',
  'PICKUP_CAPABILITY',
] as const;
export const PaymentExecutionBindingKindSchema = Schema.Literals(PAYMENT_EXECUTION_BINDING_KINDS);
export type PaymentExecutionBindingKind = typeof PaymentExecutionBindingKindSchema.Type;
