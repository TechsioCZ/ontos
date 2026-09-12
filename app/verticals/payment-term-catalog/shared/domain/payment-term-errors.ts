import { Schema } from 'effect'; // oxlint-disable-line eslint/max-classes-per-file -- These exported tagged errors form one cohesive public vocabulary; remove when they can move without changing the module surface.
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

export class PaymentTermNotFound extends Schema.TaggedError<PaymentTermNotFound>()('PaymentTermNotFound', {
  code: Schema.Literal('payment_term_not_found'),
  reason: Schema.String,
}) {}

export class PaymentTermCodeConflict extends Schema.TaggedError<PaymentTermCodeConflict>()('PaymentTermCodeConflict', {
  code: Schema.Literal('payment_term_code_conflict'),
  conflictingCode: Schema.String,
  reason: Schema.String,
}) {}

export class PaymentTermDuplicateSemantics extends Schema.TaggedError<PaymentTermDuplicateSemantics>()(
  'PaymentTermDuplicateSemantics',
  {
    canonicalPaymentTermRef: PaymentTermRefSchema,
    code: Schema.Literal('payment_term_duplicate_semantics'),
    reason: Schema.String,
  },
) {}

export class PaymentTermRevisionConflict extends Schema.TaggedError<PaymentTermRevisionConflict>()(
  'PaymentTermRevisionConflict',
  {
    actualRevision: Schema.Finite,
    code: Schema.Literal('payment_term_revision_conflict'),
    expectedRevision: Schema.Finite,
    reason: Schema.String,
  },
) {}

export class PaymentTermLifecycleConflict extends Schema.TaggedError<PaymentTermLifecycleConflict>()(
  'PaymentTermLifecycleConflict',
  {
    code: Schema.Literal('payment_term_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}

export class PaymentTermInUse extends Schema.TaggedError<PaymentTermInUse>()('PaymentTermInUse', {
  code: Schema.Literal('payment_term_in_use'),
  currentCustomerEntitlementCount: Schema.Finite,
  openPurchaseCount: Schema.Finite,
  reason: Schema.String,
}) {}

export class PaymentTermAffectedUseAssessmentRejected extends Schema.TaggedError<PaymentTermAffectedUseAssessmentRejected>()(
  'PaymentTermAffectedUseAssessmentRejected',
  {
    code: Schema.Literal('payment_term_affected_use_assessment_rejected'),
    reason: Schema.String,
  },
) {}

export class PaymentTermAffectedUseAssessmentUnavailable extends Schema.TaggedError<PaymentTermAffectedUseAssessmentUnavailable>()(
  'PaymentTermAffectedUseAssessmentUnavailable',
  {
    code: Schema.Literal('payment_term_affected_use_assessment_unavailable'),
    reason: Schema.String,
  },
) {}

export class PaymentTermRetirementReservationRejected extends Schema.TaggedError<PaymentTermRetirementReservationRejected>()(
  'PaymentTermRetirementReservationRejected',
  {
    code: Schema.Literal('payment_term_retirement_reservation_rejected'),
    reason: Schema.String,
  },
) {}

export class PaymentTermRetirementReservationUnavailable extends Schema.TaggedError<PaymentTermRetirementReservationUnavailable>()(
  'PaymentTermRetirementReservationUnavailable',
  {
    code: Schema.Literal('payment_term_retirement_reservation_unavailable'),
    reason: Schema.String,
  },
) {}

class PaymentTermSemanticChangeRequired extends Schema.TaggedError<PaymentTermSemanticChangeRequired>()(
  'PaymentTermSemanticChangeRequired',
  {
    code: Schema.Literal('payment_term_semantic_change_required'),
    reason: Schema.String,
  },
) {}

export class PaymentTermReconciliationConflict extends Schema.TaggedError<PaymentTermReconciliationConflict>()(
  'PaymentTermReconciliationConflict',
  {
    code: Schema.Literal('payment_term_reconciliation_conflict'),
    reason: Schema.String,
  },
) {}

class PaymentTermPersistenceUnavailable extends Schema.TaggedError<PaymentTermPersistenceUnavailable>()(
  'PaymentTermPersistenceUnavailable',
  {
    code: Schema.Literal('payment_term_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

const PaymentTermMutationErrorSchema = Schema.Union([
  PaymentTermNotFound,
  PaymentTermCodeConflict,
  PaymentTermDuplicateSemantics,
  PaymentTermRevisionConflict,
  PaymentTermLifecycleConflict,
  PaymentTermInUse,
  PaymentTermAffectedUseAssessmentRejected,
  PaymentTermAffectedUseAssessmentUnavailable,
  PaymentTermRetirementReservationRejected,
  PaymentTermRetirementReservationUnavailable,
  PaymentTermSemanticChangeRequired,
  PaymentTermReconciliationConflict,
  PaymentTermPersistenceUnavailable,
]);
// eslint-disable-next-line no-unused-vars -- Retain the aggregate mutation-error type that structurally keeps its private schema union connected.
type PaymentTermMutationError = typeof PaymentTermMutationErrorSchema.Type;
