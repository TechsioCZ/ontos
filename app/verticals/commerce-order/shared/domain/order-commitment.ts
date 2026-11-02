import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { FinalCartCandidateRefSchema } from '@app/commerce-cart-finalization-contracts/final-candidate';
import {
  OrderCommitmentApprovalProofSchema,
  OrderCommitmentApprovalRequestSnapshotSchema,
  PurchaseProposalRevisionSchema,
} from '@app/commerce-customer-context/api/order-commitment-approval-evidence';
import { Schema } from 'effect';
import {
  OrderServiceApprovalEvidenceResponseSchema,
  OrderServiceApprovalTerminalWitnessSchema,
} from '@app/commerce-customer-context/api/order-service-approval-evidence';
import {
  PricingCommitmentConfirmationExpiredSchema,
  PricingCommitmentConfirmationBindingSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  PricingQuotationAuthenticityVerificationEvidenceSchema,
  PricingQuotationExpiredSchema,
} from '@app/pricing-contracts/domain/quotation';
import {
  OrderBuyerPrincipalIdSchema,
  OrderBundleVersionSchema,
  OrderFinalBindingSchema,
  OrderLegalEntityIdSchema,
  OrderResourceRefSchema,
} from '@app/commerce-order-contracts/verify-order-commitment-binding';

import {
  OrderFinalizationContextSchema,
  OrderFinalPurchaseEvidenceSchema,
  OrderPricingCommitProofSchema,
  OrderTaxCandidateSchema,
} from './order-finalization-evidence.ts';
import { AcceptanceBundleRefSchema } from '../resources/acceptance-bundle.ts';
import { OrderRefSchema } from '../resources/order.ts';

export {
  OrderFinalBindingSchema,
  VerifiedOrderBindingSchema,
} from '@app/commerce-order-contracts/verify-order-commitment-binding';
export type {
  OrderFinalBinding,
  VerifyOrderBindingInput,
} from '@app/commerce-order-contracts/verify-order-commitment-binding';

const commitmentIdText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const OrderCommitmentIdSchema = commitmentIdText.pipe(
  Schema.brand('OrderCommitmentId'),
  Schema.decodeTo(commitmentIdText),
);
const ServiceProofActorPrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('OrderServiceProofActorPrincipalId'),
  Schema.decodeTo(Schema.String.check(Schema.isUUID())),
);
export const OrderFinalizationStageSchema = Schema.Literals(['PREPARE', 'PROOF', 'CONSUME']);
export const OrderCommitmentHashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const OrderCommitmentInstantSchema = Schema.DateTimeUtcFromString;

export class OrderCommitmentRejected extends Schema.TaggedError<OrderCommitmentRejected>()('OrderCommitmentRejected', {
  code: Schema.Literals([
    'order_commitment_conflict',
    'order_commitment_not_found',
    'order_commitment_permission_denied',
    'order_commitment_unavailable',
    'order_commitment_ineligible',
  ]),
  reason: Schema.String,
}) {}

/** The owner captures this exact CCC-issued proposal; proofs never enter its identity. */
export const OrderAcceptanceBundleSchema = Schema.Struct({
  approvalDecisionBundleHash: OrderCommitmentHashSchema,
  approvalDecisionBundleVersion: Schema.Literal('approval-decision-bundle.v1'),
  approvalRequestRef: OrderCommitmentApprovalRequestSnapshotSchema.fields.requestRef,
  bundleHash: OrderCommitmentHashSchema,
  bundleRef: AcceptanceBundleRefSchema,
  bundleVersion: OrderBundleVersionSchema,
  buyerPrincipalId: OrderBuyerPrincipalIdSchema,
  finalization: OrderFinalPurchaseEvidenceSchema,
  legalEntityId: OrderLegalEntityIdSchema,
  orderCommitmentTime: OrderCommitmentInstantSchema,
  preparedAt: OrderCommitmentInstantSchema,
  proposal: PurchaseProposalRevisionSchema,
  storefrontId: OrderCommitmentIdSchema,
});
export type OrderAcceptanceBundle = typeof OrderAcceptanceBundleSchema.Type;
type OrderAcceptanceBundleEncodedFields = typeof OrderAcceptanceBundleSchema.Encoded;
/** Named persisted encoding keeps table declarations below the compiler's serialization limit. */
export interface OrderAcceptanceBundleEncoded {
  readonly approvalDecisionBundleHash: OrderAcceptanceBundleEncodedFields['approvalDecisionBundleHash'];
  readonly approvalDecisionBundleVersion: OrderAcceptanceBundleEncodedFields['approvalDecisionBundleVersion'];
  readonly approvalRequestRef: OrderAcceptanceBundleEncodedFields['approvalRequestRef'];
  readonly bundleHash: OrderAcceptanceBundleEncodedFields['bundleHash'];
  readonly bundleRef: OrderAcceptanceBundleEncodedFields['bundleRef'];
  readonly bundleVersion: OrderAcceptanceBundleEncodedFields['bundleVersion'];
  readonly buyerPrincipalId: OrderAcceptanceBundleEncodedFields['buyerPrincipalId'];
  readonly finalization: OrderAcceptanceBundleEncodedFields['finalization'];
  readonly legalEntityId: OrderAcceptanceBundleEncodedFields['legalEntityId'];
  readonly orderCommitmentTime: OrderAcceptanceBundleEncodedFields['orderCommitmentTime'];
  readonly preparedAt: OrderAcceptanceBundleEncodedFields['preparedAt'];
  readonly proposal: OrderAcceptanceBundleEncodedFields['proposal'];
  readonly storefrontId: OrderAcceptanceBundleEncodedFields['storefrontId'];
}

export const OrderCommitmentAttemptSchema = Schema.Struct({
  binding: OrderFinalBindingSchema,
  commitmentCorrelationId: OrderCommitmentIdSchema,
  createdAt: OrderCommitmentInstantSchema,
  orderRef: Schema.NullOr(OrderRefSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Literals(['READY', 'PRECOMMIT_FAILED', 'CANCELLED', 'COMMITTED']),
  updatedAt: OrderCommitmentInstantSchema,
});

export const OrderApprovalProofIssuerSchema = Schema.Union([
  Schema.Struct({ buyerPrincipalId: OrderBuyerPrincipalIdSchema, kind: Schema.Literal('BUYER') }),
  Schema.Struct({
    kind: Schema.Literal('ORDER_SERVICE'),
    serviceProofActorPrincipalId: ServiceProofActorPrincipalIdSchema,
  }),
]);
export const CommittedOrderSchema = Schema.Struct({
  acceptedAt: OrderCommitmentInstantSchema,
  approvalIssuer: OrderApprovalProofIssuerSchema,
  approvalProof: OrderCommitmentApprovalProofSchema,
  approvalRequestRef: OrderCommitmentApprovalRequestSnapshotSchema.fields.requestRef,
  binding: OrderFinalBindingSchema,
  commitmentCorrelationId: OrderCommitmentIdSchema,
  committedAt: OrderCommitmentInstantSchema,
  consumptionIntent: OrderCommitmentIdSchema,
  consumptionStatus: Schema.Literals(['PENDING', 'COMPLETE']),
  orderRef: OrderRefSchema,
  pricingProof: OrderPricingCommitProofSchema,
});

export const OrderCommitmentHistoryEntrySchema = Schema.Struct({
  at: OrderCommitmentInstantSchema,
  kind: Schema.Literals(['PREPARED', 'PRECOMMIT_FAILED', 'CANCELLED', 'COMMITTED', 'APPROVAL_CONSUMED']),
  operationId: OrderCommitmentIdSchema,
  proofRef: Schema.NullOr(CoreSearchResourceRefSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export const OrderCommitmentStateSchema = Schema.Struct({
  attempt: OrderCommitmentAttemptSchema,
  bundle: OrderAcceptanceBundleSchema,
  history: Schema.Array(OrderCommitmentHistoryEntrySchema).check(Schema.isMaxLength(1000)),
  order: Schema.NullOr(CommittedOrderSchema),
});
export type OrderCommitmentState = typeof OrderCommitmentStateSchema.Type;

export const PrepareOrderCommitmentInputSchema = Schema.Struct({
  candidateHash: OrderCommitmentHashSchema,
  candidateRef: FinalCartCandidateRefSchema,
  commitmentCorrelationId: OrderCommitmentIdSchema,
  counterpartyRef: CoreSearchResourceRefSchema,
  quotationRef: OrderCommitmentIdSchema,
  requestRef: OrderCommitmentApprovalRequestSnapshotSchema.fields.requestRef,
  storefrontId: OrderCommitmentIdSchema,
  taxCandidate: OrderTaxCandidateSchema,
});
export type PrepareOrderCommitmentInput = typeof PrepareOrderCommitmentInputSchema.Type;

export const OrderAttemptMutationSchema = Schema.Struct({
  binding: OrderFinalBindingSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export const RecordPrecommitFailureInputSchema = Schema.Struct({
  ...OrderAttemptMutationSchema.fields,
  revalidationRef: Schema.optional(OrderResourceRefSchema),
});
export type RecordPrecommitFailureInput = typeof RecordPrecommitFailureInputSchema.Type;

export const CommitOrderInputSchema = Schema.Struct({
  ...OrderAttemptMutationSchema.fields,
  revalidationRef: OrderResourceRefSchema,
});
export type CommitOrderInput = typeof CommitOrderInputSchema.Type;

/** Durable buyer intents are separate from authentication scope, immutable Bundle and proofs. */
export const OrderPreparationProgressSchema = Schema.Struct({
  binding: Schema.NullOr(OrderFinalBindingSchema),
  intentRef: OrderResourceRefSchema,
  status: Schema.Literals(['PREPARATION_PENDING', 'PREPARED', 'FAILED']),
});
export type OrderPreparationProgress = typeof OrderPreparationProgressSchema.Type;
export const OrderProofProgressSchema = Schema.Struct({
  binding: OrderFinalBindingSchema,
  intentRef: OrderResourceRefSchema,
  revalidationRef: Schema.NullOr(OrderResourceRefSchema),
  status: Schema.Literals(['PROOFS_PENDING', 'READY', 'EXPIRED', 'FAILED', 'CANCELLED']),
  validUntil: Schema.NullOr(OrderCommitmentInstantSchema),
});
export type OrderProofProgress = typeof OrderProofProgressSchema.Type;
export const OrderPreparationIntentDataSchema = Schema.Struct({
  evidence: OrderServiceApprovalEvidenceResponseSchema,
  input: PrepareOrderCommitmentInputSchema,
  work: OrderFinalizationContextSchema,
});
export const OrderProofIntentDataSchema = Schema.Struct({
  binding: OrderFinalBindingSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  idempotencyKey: OrderCommitmentIdSchema,
  work: OrderFinalizationContextSchema,
});
export const OrderRetainedProofSetSchema = Schema.Struct({
  approvalEvidence: OrderServiceApprovalEvidenceResponseSchema,
  pricingProof: OrderPricingCommitProofSchema,
});
export type OrderRetainedProofSet = typeof OrderRetainedProofSetSchema.Type;
/** Pricing's authenticated expiry of one exact retained Quotation, as Order retains it. */
const quotationExpiryWitness = <Kind extends string>(kind: Kind) =>
  Schema.Struct({
    authenticityEvidence: PricingQuotationAuthenticityVerificationEvidenceSchema,
    kind: Schema.Literal(kind),
    pricing: PricingQuotationExpiredSchema,
    quotationRef: OrderCommitmentIdSchema,
  }).check(
    Schema.makeFilter(({ authenticityEvidence, pricing, quotationRef }) =>
      pricing.quotationRef === quotationRef && authenticityEvidence.quotationRef === quotationRef
        ? undefined
        : 'Quotation expiry must name the exact retained Quotation',
    ),
  );
/** Pricing's authenticated expiry of the exact retained Quotation closes preparation without an Attempt. */
export const OrderPreparationTerminalResultSchema = quotationExpiryWitness('PREPARATION_QUOTATION_EXPIRED');
export const OrderProofTerminalResultSchema = Schema.Union([
  // The Bundle's Quotation expired before any Confirmation could be issued from it.
  quotationExpiryWitness('PRICING_QUOTATION_EXPIRED'),
  Schema.Struct({
    kind: Schema.Literal('APPROVAL_REQUEST_TERMINAL'),
    witness: OrderServiceApprovalTerminalWitnessSchema,
  }),
  Schema.Struct({
    approvalEvidence: OrderServiceApprovalEvidenceResponseSchema,
    confirmationRef: OrderCommitmentIdSchema,
    kind: Schema.Literal('PRICING_PROOF_EXPIRED'),
    pricing: Schema.toType(PricingCommitmentConfirmationExpiredSchema),
    quotationRef: OrderCommitmentIdSchema,
    requestedBinding: PricingCommitmentConfirmationBindingSchema,
    revalidationRef: OrderResourceRefSchema,
  }),
]);
export const OrderFinalizationWorkRequestSchema = Schema.Struct({
  intentRef: OrderResourceRefSchema,
  stage: OrderFinalizationStageSchema,
});
const pendingWork = {
  intentRef: OrderResourceRefSchema,
  status: Schema.Literal('PENDING'),
  work: OrderFinalizationContextSchema,
};
export const OrderFinalizationWorkResponseSchema = Schema.Union([
  Schema.Struct({
    intentRef: OrderResourceRefSchema,
    stage: OrderFinalizationStageSchema,
    status: Schema.Literals(['COMPLETE', 'FAILED', 'CANCELLED']),
  }),
  Schema.Struct({
    ...pendingWork,
    evidence: OrderServiceApprovalEvidenceResponseSchema,
    input: PrepareOrderCommitmentInputSchema,
    stage: Schema.Literal('PREPARE'),
  }),
  Schema.Struct({
    ...pendingWork,
    approvalIdempotencyKey: OrderCommitmentIdSchema,
    pricingIdempotencyKey: OrderCommitmentIdSchema,
    stage: Schema.Literal('PROOF'),
    state: OrderCommitmentStateSchema,
  }),
  Schema.Struct({ ...pendingWork, stage: Schema.Literal('CONSUME'), state: OrderCommitmentStateSchema }),
]);
export type OrderFinalizationWorkRequest = typeof OrderFinalizationWorkRequestSchema.Type;
export type OrderFinalizationWorkResponse = typeof OrderFinalizationWorkResponseSchema.Type;
export const CompleteOrderPreparationInputSchema = Schema.Struct({ intentRef: OrderResourceRefSchema });
export const OrderProofSetSelectorsSchema = Schema.Struct({
  confirmationRef: OrderCommitmentIdSchema,
  intentRef: OrderResourceRefSchema,
  revalidationRef: OrderResourceRefSchema,
});
export const RecordOrderProofSetInputSchema = Schema.Union([
  OrderProofSetSelectorsSchema,
  Schema.Struct({
    intentRef: OrderResourceRefSchema,
    outcome: Schema.Literals(['APPROVAL_REQUEST_TERMINAL', 'PRICING_QUOTATION_EXPIRED']),
  }),
]);
export const CompleteOrderApprovalConsumptionInputSchema = Schema.Struct({ intentRef: OrderResourceRefSchema });
export type CompleteOrderPreparationInput = typeof CompleteOrderPreparationInputSchema.Type;
export type RecordOrderProofSetInput = typeof RecordOrderProofSetInputSchema.Type;
export type CompleteOrderApprovalConsumptionInput = typeof CompleteOrderApprovalConsumptionInputSchema.Type;
