import { Schema } from 'effect';

import {
  PaymentActionInvocationIdSchema,
  PaymentCompositionRevisionSchema,
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentObservationIdSchema,
  PaymentOperationIdSchema,
  PaymentOperationKeySchema,
  PaymentProviderAccountRefSchema,
  PaymentReasonSchema,
  PaymentReconciliationCaseIdSchema,
  PaymentReconciliationDecisionIdSchema,
  PaymentRecoveryIdSchema,
  PaymentRevisionSchema,
  PaymentSourceEnvironmentSchema,
} from './payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from './payment-money.ts';
import {
  PaymentGatewayProviderFamilySchema,
  PaymentOperationKindSchema,
  PaymentOperationOutcomeSchema,
  PaymentReconciliationCaseKindSchema,
  PaymentReconciliationCaseStatusSchema,
  PaymentReconciliationDecisionKindSchema,
  PaymentRecoveryModeSchema,
} from './payment-vocabulary.ts';

/**
 * Public contracts of Payment evidence recovery and reconciliation (#1151): same-operation recovery,
 * governed reconciliation decisions and the unresolved-debt projection.
 */

/** Lane-specific refusals; conflict-like codes contain `already`/`conflict` so they map to HTTP 409. */
export const PAYMENT_EVIDENCE_REJECTION_CODES = [
  'payment_recovery_operation_already_resolved',
  'payment_reconciliation_case_not_found',
  'payment_reconciliation_case_already_closed',
  'payment_reconciliation_case_revision_conflict',
  'payment_reconciliation_evidence_not_found',
  'payment_reconciliation_evidence_not_qualified',
  'payment_reconciliation_decision_not_applicable',
  'payment_reconciliation_obligation_unresolved',
] as const;
export const PaymentEvidenceRejectionCodeSchema = Schema.Literals(PAYMENT_EVIDENCE_REJECTION_CODES);
export type PaymentEvidenceRejectionCode = typeof PaymentEvidenceRejectionCodeSchema.Type;

export class PaymentEvidenceRejected extends Schema.TaggedError<PaymentEvidenceRejected>()('PaymentEvidenceRejected', {
  code: PaymentEvidenceRejectionCodeSchema,
  reason: Schema.String,
}) {}

export const paymentEvidenceRejected = (code: PaymentEvidenceRejectionCode, reason: string): PaymentEvidenceRejected =>
  new PaymentEvidenceRejected({ code, reason });

const PaymentProviderIdempotencyKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[!-~]+$/u),
).pipe(Schema.brand('PaymentProviderIdempotencyKey'));

/**
 * C17-proven provider idempotency guarantee of one gateway operation (#1151 "Exact same-operation
 * replay only where C17 proves provider idempotency covers that operation in its current scope/window").
 * It is stored with the operation's immutable material request under `providerIdempotency`, bound to
 * the exact provider/account/environment of the original binding. The window starts no later than the
 * operation's admission time, so `createdAt + windowSeconds` is a conservative end of the guarantee.
 */
export const PaymentProviderIdempotencyGuaranteeSchema = Schema.Struct({
  environment: PaymentSourceEnvironmentSchema,
  providerAccountRef: PaymentProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  providerIdempotencyKey: PaymentProviderIdempotencyKeySchema,
  windowSeconds: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 31_536_000, minimum: 1 })),
});
export type PaymentProviderIdempotencyGuarantee = typeof PaymentProviderIdempotencyGuaranteeSchema.Type;

/** The operation material-request member that carries the guarantee. */
export const PaymentOperationIdempotencyMaterialSchema = Schema.Struct({
  providerIdempotency: PaymentProviderIdempotencyGuaranteeSchema,
});

/** Why recovery is requested; transport loss makes the original effect INDETERMINATE (#1151). */
export const PAYMENT_RECOVERY_TRIGGERS = [
  /** The execution route lost the create/refund response: the effect may or may not exist. */
  'EXECUTION_OUTCOME_UNKNOWN',
  /** No qualified outcome arrived in the expected business time. */
  'OUTCOME_OVERDUE',
  /** The route has no credentials/authority to look the effect up: held, never NOT_EFFECTED. */
  'LOOKUP_AUTHORITY_UNAVAILABLE',
  'OPERATOR_REQUEST',
] as const;
export const PaymentRecoveryTriggerSchema = Schema.Literals(PAYMENT_RECOVERY_TRIGGERS);
export type PaymentRecoveryTrigger = typeof PaymentRecoveryTriggerSchema.Type;

/** Whether the stored binding proves a provider replay guarantee covering the actual time of the request. */
export const PAYMENT_PROVIDER_REPLAY_ASSESSMENTS = ['COVERS_NOW', 'EXPIRED', 'NOT_PROVEN', 'NOT_APPLICABLE'] as const;
export const PaymentProviderReplayAssessmentSchema = Schema.Literals(PAYMENT_PROVIDER_REPLAY_ASSESSMENTS);
export type PaymentProviderReplayAssessment = typeof PaymentProviderReplayAssessmentSchema.Type;

export const PaymentRecoveryRequestViewSchema = Schema.Struct({
  /** True when the caller asked for a stronger mode than the stored evidence permits. */
  modeDowngraded: Schema.Boolean,
  operationId: PaymentOperationIdSchema,
  operationKey: PaymentOperationKeySchema,
  operationKind: PaymentOperationKindSchema,
  /** Outcome after this request; recovery never confirms or denies an effect by itself. */
  operationOutcome: PaymentOperationOutcomeSchema,
  /** The operation's admitted lineage (R1); this request's own provenance is separate. */
  originalCompositionRevision: PaymentCompositionRevisionSchema,
  paymentId: PaymentIdSchema,
  previousOutcome: PaymentOperationOutcomeSchema,
  providerReplay: PaymentProviderReplayAssessmentSchema,
  recoveryId: PaymentRecoveryIdSchema,
  requestedAt: Schema.DateTimeUtcFromString,
  /** Mode actually recorded; only PROVIDER_IDEMPOTENT_REPLAY permits resending the original request. */
  recoveryMode: PaymentRecoveryModeSchema,
  /** True when an executor task was admitted (Outbox); AWAIT/GOVERNED modes never fabricate one. */
  executorWorkAdmitted: Schema.Boolean,
  /** True when the request opened explicit reconciliation debt (held). */
  heldForReconciliation: Schema.Boolean,
});
export type PaymentRecoveryRequestView = typeof PaymentRecoveryRequestViewSchema.Type;

/** Governed reconciliation decision bodies (#1151 "Operator reconciliation cannot fabricate money"). */
export const PaymentReconciliationAttachEvidenceSchema = Schema.TaggedStruct('ATTACH_EVIDENCE', {
  /** An existing observation from a configured, currently ACTIVE source authority. */
  observationId: PaymentObservationIdSchema,
  /** Required only when the case names no operation: the operation of the same Payment the evidence proves. */
  operationId: Schema.optionalKey(PaymentOperationIdSchema),
});
export const PaymentReconciliationClassifyConflictSchema = Schema.TaggedStruct('CLASSIFY_CONFLICT', {});
export const PaymentReconciliationCloseCaseSchema = Schema.TaggedStruct('CLOSE_CASE', {
  /** Authoritative evidence that the administrative case is settled; no money is created by closing. */
  evidenceRef: PaymentEvidenceRefSchema,
});
export const PaymentReconciliationDecisionBodySchema = Schema.Union([
  PaymentReconciliationAttachEvidenceSchema,
  PaymentReconciliationClassifyConflictSchema,
  PaymentReconciliationCloseCaseSchema,
]);
export type PaymentReconciliationDecisionBody = typeof PaymentReconciliationDecisionBodySchema.Type;

export const PaymentOperationOutcomeChangeViewSchema = Schema.Struct({
  fromOutcome: PaymentOperationOutcomeSchema,
  operationId: PaymentOperationIdSchema,
  outcomeRevision: PaymentRevisionSchema,
  toOutcome: PaymentOperationOutcomeSchema,
});

export const PaymentReconciliationCaseViewSchema = Schema.Struct({
  caseId: PaymentReconciliationCaseIdSchema,
  caseKind: PaymentReconciliationCaseKindSchema,
  closedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  observationId: Schema.OptionFromNullOr(PaymentObservationIdSchema),
  openedAt: Schema.DateTimeUtcFromString,
  operationId: Schema.OptionFromNullOr(PaymentOperationIdSchema),
  paymentId: Schema.OptionFromNullOr(PaymentIdSchema),
  revision: PaymentRevisionSchema,
  status: PaymentReconciliationCaseStatusSchema,
});
export type PaymentReconciliationCaseView = typeof PaymentReconciliationCaseViewSchema.Type;

export const PaymentReconciliationDecisionViewSchema = Schema.Struct({
  actionInvocationId: PaymentActionInvocationIdSchema,
  caseId: PaymentReconciliationCaseIdSchema,
  compositionRevision: PaymentCompositionRevisionSchema,
  decidedAt: Schema.DateTimeUtcFromString,
  decisionId: PaymentReconciliationDecisionIdSchema,
  decisionKind: PaymentReconciliationDecisionKindSchema,
  evidenceRef: Schema.OptionFromNullOr(PaymentEvidenceRefSchema),
  reason: PaymentReasonSchema,
  resultingOutcome: Schema.OptionFromNullOr(PaymentOperationOutcomeSchema),
});
export type PaymentReconciliationDecisionView = typeof PaymentReconciliationDecisionViewSchema.Type;

/** One operation that still carries an unresolved effect (debt) or legitimate business waiting. */
export const PaymentOpenOperationViewSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  createdAt: Schema.DateTimeUtcFromString,
  operationId: PaymentOperationIdSchema,
  operationKind: PaymentOperationKindSchema,
  originalCompositionRevision: PaymentCompositionRevisionSchema,
  outcome: PaymentOperationOutcomeSchema,
  outcomeRevision: PaymentRevisionSchema,
  paymentId: PaymentIdSchema,
});
export type PaymentOpenOperationView = typeof PaymentOpenOperationViewSchema.Type;
