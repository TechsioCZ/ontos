import { Schema } from 'effect';

import {
  PaymentOpenOperationViewSchema,
  PaymentReconciliationCaseViewSchema,
  PaymentReconciliationDecisionViewSchema,
} from './evidence-contract.ts';
import { PaymentExecutionBindingSchema } from './payment-execution-binding.ts';
import {
  PaymentAuthorizationIdSchema,
  PaymentEconomicEffectKeySchema,
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentMaterialHashSchema,
  PaymentObservationIdSchema,
  PaymentOperationIdSchema,
  PaymentOperationKeySchema,
  PaymentOrderCommitmentAttemptIdSchema,
  PaymentPurchaseCorrelationIdSchema,
  PaymentReasonSchema,
  PaymentRecoveryIdSchema,
  PaymentRevisionSchema,
  PaymentSourceAuthorityIdSchema,
  PaymentSourceOccurrenceIdSchema,
} from './payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from './payment-money.ts';
import { PaymentExecutionProvenanceSchema } from './payment-provenance.ts';
import {
  PaymentAuthorizationProofKindSchema,
  PaymentMethodSchema,
  PaymentObservationAcceptanceOutcomeSchema,
  PaymentObservationFactKindSchema,
  PaymentOperationKindSchema,
  PaymentOperationOutcomeSchema,
  PaymentOutcomeTransitionCauseSchema,
  PaymentRecoveryModeSchema,
  PaymentRefundBasisKindSchema,
  PaymentSourceFactFamilySchema,
  PaymentSourceKindSchema,
} from './payment-vocabulary.ts';

/**
 * Read contracts of the #1151 unresolved-debt projection and the explicit immutable Payment history
 * (`historical_read`). History rows are append-only facts with their own execution provenance; the
 * projection makes no Current-validity claim and has no live provider dependency.
 */

export const PaymentReconciliationDebtRequestFieldsSchema = Schema.Struct({
  /** Restricts the projection to one Payment; absent lists the whole trusted Selling Legal Entity scope. */
  paymentId: Schema.optionalKey(PaymentIdSchema),
});

export const PaymentReconciliationDebtViewSchema = Schema.Struct({
  /** PENDING operations: legitimate business waiting for qualified evidence, not reconciliation debt. */
  awaitingEvidence: Schema.Array(PaymentOpenOperationViewSchema),
  observedAt: Schema.DateTimeUtcFromString,
  openCases: Schema.Array(PaymentReconciliationCaseViewSchema),
  /** True when a bounded list was cut; the caller must narrow the request, never assume absence. */
  truncated: Schema.Boolean,
  /** INDETERMINATE and CONFLICT operations: outstanding monetary debt. */
  unresolvedOperations: Schema.Array(PaymentOpenOperationViewSchema),
});
export type PaymentReconciliationDebtView = typeof PaymentReconciliationDebtViewSchema.Type;

export const PaymentHistoryPaymentViewSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  createdAt: Schema.DateTimeUtcFromString,
  executionBinding: PaymentExecutionBindingSchema,
  method: PaymentMethodSchema,
  paymentId: PaymentIdSchema,
  predecessorPaymentId: Schema.OptionFromNullOr(PaymentIdSchema),
  provenance: PaymentExecutionProvenanceSchema,
  purchaseCorrelationId: PaymentPurchaseCorrelationIdSchema,
});

export const PaymentHistoryOperationViewSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  /** The original immutable binding; recovery and refunds never reroute it. */
  binding: PaymentExecutionBindingSchema,
  createdAt: Schema.DateTimeUtcFromString,
  materialHash: PaymentMaterialHashSchema,
  operationId: PaymentOperationIdSchema,
  operationKey: PaymentOperationKeySchema,
  operationKind: PaymentOperationKindSchema,
  provenance: PaymentExecutionProvenanceSchema,
  refundBasisKind: Schema.OptionFromNullOr(PaymentRefundBasisKindSchema),
  targetOperationId: Schema.OptionFromNullOr(PaymentOperationIdSchema),
});

export const PaymentHistoryTransitionViewSchema = Schema.Struct({
  causeId: Schema.OptionFromNullOr(Schema.String),
  causeKind: PaymentOutcomeTransitionCauseSchema,
  fromOutcome: Schema.OptionFromNullOr(PaymentOperationOutcomeSchema),
  operationId: PaymentOperationIdSchema,
  outcomeRevision: PaymentRevisionSchema,
  provenance: PaymentExecutionProvenanceSchema,
  recordedAt: Schema.DateTimeUtcFromString,
  toOutcome: PaymentOperationOutcomeSchema,
});

export const PaymentHistoryObservationViewSchema = Schema.Struct({
  acceptanceOutcome: PaymentObservationAcceptanceOutcomeSchema,
  amount: Schema.OptionFromNullOr(PaymentMonetaryAmountSchema),
  correctsObservationId: Schema.OptionFromNullOr(PaymentObservationIdSchema),
  economicEffectKey: Schema.OptionFromNullOr(PaymentEconomicEffectKeySchema),
  evidenceRef: Schema.OptionFromNullOr(PaymentEvidenceRefSchema),
  factFamily: PaymentSourceFactFamilySchema,
  factKind: PaymentObservationFactKindSchema,
  observationId: PaymentObservationIdSchema,
  operationId: Schema.OptionFromNullOr(PaymentOperationIdSchema),
  provenance: PaymentExecutionProvenanceSchema,
  receivedAt: Schema.DateTimeUtcFromString,
  sourceAuthorityId: Schema.OptionFromNullOr(PaymentSourceAuthorityIdSchema),
  sourceKind: PaymentSourceKindSchema,
  sourceOccurredAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  sourceOccurrenceId: PaymentSourceOccurrenceIdSchema,
  sourceRevision: Schema.Finite,
  verifiedAt: Schema.DateTimeUtcFromString,
});

/** A proof as it was issued; validity at use time belongs to the Current validation Read only. */
export const PaymentHistoryAuthorizationViewSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  authorizationId: PaymentAuthorizationIdSchema,
  coverageRevision: Schema.OptionFromNullOr(PaymentRevisionSchema),
  expiresAt: Schema.DateTimeUtcFromString,
  issuedAt: Schema.DateTimeUtcFromString,
  method: PaymentMethodSchema,
  orderCommitmentAttemptId: PaymentOrderCommitmentAttemptIdSchema,
  proofKind: PaymentAuthorizationProofKindSchema,
  provenance: PaymentExecutionProvenanceSchema,
});

export const PaymentHistoryRecoveryViewSchema = Schema.Struct({
  binding: PaymentExecutionBindingSchema,
  mode: PaymentRecoveryModeSchema,
  operationId: PaymentOperationIdSchema,
  provenance: PaymentExecutionProvenanceSchema,
  reason: PaymentReasonSchema,
  recoveryId: PaymentRecoveryIdSchema,
  requestedAt: Schema.DateTimeUtcFromString,
});

export const PaymentHistoryViewSchema = Schema.Struct({
  authorizations: Schema.Array(PaymentHistoryAuthorizationViewSchema),
  /** Explicit statement of the information boundary: no Current-validity claim is made. */
  currentValidityClaimed: Schema.Literal(false),
  observations: Schema.Array(PaymentHistoryObservationViewSchema),
  observedAt: Schema.DateTimeUtcFromString,
  operations: Schema.Array(PaymentHistoryOperationViewSchema),
  payment: PaymentHistoryPaymentViewSchema,
  projection: Schema.Literal('HISTORICAL_IMMUTABLE'),
  reconciliationCases: Schema.Array(PaymentReconciliationCaseViewSchema),
  reconciliationDecisions: Schema.Array(PaymentReconciliationDecisionViewSchema),
  recoveryRequests: Schema.Array(PaymentHistoryRecoveryViewSchema),
  transitions: Schema.Array(PaymentHistoryTransitionViewSchema),
  truncated: Schema.Boolean,
});
export type PaymentHistoryView = typeof PaymentHistoryViewSchema.Type;
