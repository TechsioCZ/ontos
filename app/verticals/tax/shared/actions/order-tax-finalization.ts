import { Schema } from 'effect';

import {
  TaxEvaluationEvidenceSchema,
  TaxEvaluationRequestRejectionReasonSchema,
  TaxEvaluationRequestSchema,
  TaxForeignEvidenceOriginSchema,
} from '../domain/tax-evaluation-contracts.ts';
import { CustomerSafeTaxProjectionSchema } from '../domain/tax-kernel/customer-safe-tax-projection.ts';
import { BoundedIdentifierSchema } from '../domain/tax-kernel/tax-domain-primitives.ts';
import { TaxNonSuccessOutcomeSchema } from '../domain/tax-kernel/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../domain/tax-kernel/tax-outcome.ts';
import { OrderCommitmentTimeSchema } from '../domain/tax-kernel/tax-time.ts';
import { OrderTaxFinalizationRefSchema } from '../resources/order-tax-finalization.ts';

/** Commerce-owned identity of the exact final submission; TAX never mints or derives it (#944 F2, #941 F2). */
export const OrderSubmissionRefSchema = BoundedIdentifierSchema.pipe(Schema.brand('OrderSubmissionRef'));
export type OrderSubmissionRef = typeof OrderSubmissionRefSchema.Type;

const { taxRelevantTime: _taxRelevantTime, ...frozenCandidateFields } = TaxEvaluationRequestSchema.fields;

/**
 * The exact frozen purchase candidate of one submission with its server-resolved owner evidence (#944 F1). Its
 * Tax-Relevant Time is not part of it: final Launch Order Tax-Relevant Time is exactly T (#941 F2-F4, #944 F3).
 */
export const FrozenOrderCandidateSchema = Schema.Struct(frozenCandidateFields);
export type FrozenOrderCandidate = typeof FrozenOrderCandidateSchema.Type;

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProvenanceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/**
 * Final Launch Order Tax request for one exact submission: Commerce's submission identity, its once-captured Order
 * Commitment Time T and the frozen candidate (#944 F1-F3, #941 F2). Tax Evaluation Time is never an input.
 */
export const FinalizeOrderTaxPayloadSchema = Schema.Struct({
  candidate: FrozenOrderCandidateSchema,
  orderCommitmentTime: OrderCommitmentTimeSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  submissionRef: OrderSubmissionRefSchema,
});
export type FinalizeOrderTaxPayload = typeof FinalizeOrderTaxPayloadSchema.Type;

/**
 * The exact final Tax content the #330 Bundle embeds before its Attempt. TAX re-checks that the Result's amounts
 * follow from the Decision whenever it accepts one; the published outcome schema binds them only (#944 F19, #907 F158; PO decision D6 default):
 * submission identity, T, the immutable Decision with its Result, and where its foreign facts came from. Under the
 * human decision A1 on #907 they are caller-supplied until #892, and the label travels with the result.
 */
export const FinalOrderTaxHandoffSchema = Schema.Struct({
  foreignEvidenceOrigin: TaxForeignEvidenceOriginSchema,
  orderCommitmentTime: OrderCommitmentTimeSchema,
  outcome: TaxOutcomeSuccessSchema,
  submissionRef: OrderSubmissionRefSchema,
});
export type FinalOrderTaxHandoff = typeof FinalOrderTaxHandoffSchema.Type;

/**
 * `FINALIZED` with `created: false` is the recovered original for the same submission and intent; nothing was
 * re-evaluated (#944 F10, #942 H). A non-success stores nothing, so the same candidate/T may be finalized again
 * (#944 F12). A rejection is a request that is not one bound purchase at T.
 */
export const FinalizeOrderTaxResultSchema = Schema.Union([
  Schema.TaggedStruct('FINALIZED', {
    created: Schema.Boolean,
    customerSafe: CustomerSafeTaxProjectionSchema,
    evidence: TaxEvaluationEvidenceSchema,
    finalOrderTaxRef: OrderTaxFinalizationRefSchema,
    handoff: FinalOrderTaxHandoffSchema,
  }),
  Schema.TaggedStruct('NOT_FINALIZED', {
    evidence: TaxEvaluationEvidenceSchema,
    outcome: TaxNonSuccessOutcomeSchema,
  }),
  Schema.TaggedStruct('FINALIZATION_REJECTED', {
    reasons: Schema.NonEmptyArray(TaxEvaluationRequestRejectionReasonSchema),
  }),
]);
export type FinalizeOrderTaxResult = typeof FinalizeOrderTaxResultSchema.Type;
