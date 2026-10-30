import { FinalCartCandidateSchema } from '@app/commerce-cart-finalization-contracts/final-candidate';
import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import { PricingCommitmentConfirmationVerifiedSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { OrderServiceApprovalEvidenceRequestSchema } from '@app/commerce-customer-context/api/order-service-approval-evidence';
import { PaymentTermsResolutionResponseSchema } from '@app/commerce-customer-context/api';
import {
  PaymentTermDefinitionSchema,
  PaymentTermInstantSchema,
} from '@app/payment-term-catalog-contracts/payment-term';
import { FinalizeOrderTaxPayloadSchema, FinalizeOrderTaxResultSchema, FinalOrderTaxResponseSchema } from '@app/tax/api';
import { PurchaseProposalRevisionSchema } from '@app/commerce-customer-context/api/order-commitment-approval-evidence';
import {
  OrderBuyerPrincipalIdSchema,
  OrderCommitmentCorrelationIdSchema,
  OrderLegalEntityIdSchema,
  OrderTenantIdSchema,
} from '@app/commerce-order-contracts/verify-order-commitment-binding';
import { Schema, Predicate } from 'effect';

const idempotencyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const OrderIdempotencyKeySchema = idempotencyText.pipe(
  Schema.brand('OrderIdempotencyKey'),
  Schema.decodeTo(idempotencyText),
);

/** Owner-read-issued business identity; this is never an authentication OperationalScope. */
export const OrderFinalizationContextSchema = Schema.Struct({
  buyerPrincipalId: OrderBuyerPrincipalIdSchema,
  correlationId: OrderCommitmentCorrelationIdSchema,
  legalEntityId: OrderLegalEntityIdSchema,
  tenantId: OrderTenantIdSchema,
});
export type OrderFinalizationContext = typeof OrderFinalizationContextSchema.Type;

/** Private orchestration inputs. These types do not confer Cart or buyer authority. */
export const OrderTaxFinalizationIntentSchema = Schema.Struct({
  idempotencyKey: OrderIdempotencyKeySchema,
  request: FinalizeOrderTaxPayloadSchema,
});
export type OrderTaxFinalizationIntent = typeof OrderTaxFinalizationIntentSchema.Type;

export const OrderPaymentTermsFinalizationInputSchema = Schema.Struct({
  expectedPaymentTerm: PurchaseProposalRevisionSchema.fields.paymentTerm,
  request: OrderServiceApprovalEvidenceRequestSchema.check(
    Schema.makeFilter((request) =>
      request.operation === 'RESOLVE_PAYMENT_TERMS'
        ? undefined
        : 'Only the genuine final-candidate Payment Terms operation is allowed',
    ),
  ),
});
export type OrderPaymentTermsFinalizationInput = typeof OrderPaymentTermsFinalizationInputSchema.Type;

/** Preserve Tax's foreign-evidence label and complete immutable owner result without upgrading its provenance. */
export const OrderTaxFinalizationEvidenceSchema = Schema.Struct({
  result: FinalizeOrderTaxResultSchema.check(
    Schema.makeFilter((result) =>
      Predicate.isTagged(result, 'FINALIZED') ? undefined : 'A durable final Tax result is required',
    ),
  ),
});
export type OrderTaxFinalizationEvidence = typeof OrderTaxFinalizationEvidenceSchema.Type;

/** Definition and buyer/policy resolution are separately owned and both remain inspectable. */
export const OrderPaymentTermsFinalizationEvidenceSchema = Schema.Struct({
  catalogDefinition: PaymentTermDefinitionSchema,
  effectiveAt: PaymentTermInstantSchema,
  observedAt: PaymentTermInstantSchema,
  resolution: PaymentTermsResolutionResponseSchema.check(
    Schema.makeFilter((resolution) =>
      Predicate.isTagged(resolution, 'EXPLICIT_CHOICE') ||
      Predicate.isTagged(resolution, 'PREFERRED_ENTITLEMENT') ||
      Predicate.isTagged(resolution, 'POLICY_FALLBACK')
        ? undefined
        : 'A usable owner-resolved Payment Term is required',
    ),
  ),
});
export type OrderPaymentTermsFinalizationEvidence = typeof OrderPaymentTermsFinalizationEvidenceSchema.Type;

/** Retained Tax history is read as stored, including later governing-revision correction evidence. */
export const OrderTaxHistoricalEvidenceSchema = Schema.Struct({ historical: FinalOrderTaxResponseSchema });
export type OrderTaxHistoricalEvidence = typeof OrderTaxHistoricalEvidenceSchema.Type;

/** A1 foreign observations remain explicitly unverified; the receiving Order validates their exact owner purchase binding. */
export const OrderTaxCandidateSchema = FinalizeOrderTaxPayloadSchema.fields.candidate;
export const OrderFinalPurchaseEvidenceSchema = Schema.Struct({
  cart: FinalCartCandidateSchema,
  paymentTerms: OrderPaymentTermsFinalizationEvidenceSchema,
  pricing: Schema.Struct({
    pricingResultRef: FinalizeOrderTaxPayloadSchema.fields.candidate.fields.purchase.fields.pricingResultRef,
    quotation: Schema.toType(PricingQuotationIssuedSchema),
  }),
  purchaseValue: PurchaseProposalRevisionSchema.fields.purchaseValue,
  tax: OrderTaxFinalizationEvidenceSchema,
  taxIntent: OrderTaxFinalizationIntentSchema,
});
export type OrderFinalPurchaseEvidence = typeof OrderFinalPurchaseEvidenceSchema.Type;
/** Attempt-bound Pricing evidence is deliberately outside the immutable Bundle (accepted ADR0021). */
export const OrderPricingCommitProofSchema = Schema.toType(PricingCommitmentConfirmationVerifiedSchema);
export type OrderPricingCommitProof = typeof OrderPricingCommitProofSchema.Type;
