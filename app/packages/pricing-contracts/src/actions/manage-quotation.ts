import { CurrentPricingDecisionRequestSchema } from '../apis/current-pricing-decision.ts';
import { PricingQuotationIssuedSchema } from '../domain/quotation.ts';
import { Schema } from 'effect';

export const ManageQuotationReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

export const QuotationActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('QuotationActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

/** A request for a new guarantee; quoted money and validity are never client input. */
export const ManageQuotationPayloadSchema = Schema.Struct({
  candidateHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  candidateRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
  currentDecision: CurrentPricingDecisionRequestSchema,
  reason: ManageQuotationReasonSchema,
});
export type ManageQuotationPayload = typeof ManageQuotationPayloadSchema.Type;

export const ManageQuotationResultSchema = Schema.Struct({
  outcome: Schema.Literal('QUOTATION_ISSUED'),
  // Retained evidence carries instants, so the Action result travels in its JSON form.
  quotation: Schema.toCodecJson(PricingQuotationIssuedSchema),
});
export type ManageQuotationResult = typeof ManageQuotationResultSchema.Type;
