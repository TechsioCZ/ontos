import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
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
  candidateRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
  currentDecision: CurrentPricingDecisionRequestSchema,
  reason: ManageQuotationReasonSchema,
});
export type ManageQuotationPayload = typeof ManageQuotationPayloadSchema.Type;

export const ManageQuotationResultSchema = Schema.Struct({
  outcome: Schema.Literal('QUOTATION_ISSUED'),
  quotation: Schema.toType(PricingQuotationIssuedSchema),
});
export type ManageQuotationResult = typeof ManageQuotationResultSchema.Type;
