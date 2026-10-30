import { isPostgresUniqueViolation } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import type { OrderServiceApprovalEvidenceResponse } from '@app/commerce-customer-context/api/order-service-approval-evidence';
import { PricingQuotationBindingSchema, PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import type { ConsumeOrderPurchaseApprovalResult } from '@app/commerce-customer-context/api/consume-order-purchase-approval-action';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema, Predicate } from 'effect';
import { Hex } from 'effect/encoding';
import {
  CommittedOrderSchema,
  OrderAcceptanceBundleSchema,
  OrderCommitmentRejected,
  OrderCommitmentStateSchema,
  OrderFinalBindingSchema,
  PrepareOrderCommitmentInputSchema,
  OrderPreparationIntentDataSchema,
  OrderProofIntentDataSchema,
  OrderRetainedProofSetSchema,
  OrderPreparationProgressSchema,
  OrderPreparationTerminalResultSchema,
  VerifiedOrderBindingSchema,
} from '../../shared/domain/order-commitment.ts';
import type {
  CommitOrderInput,
  OrderAcceptanceBundle,
  OrderCommitmentState,
  OrderFinalBinding,
  OrderPreparationProgress,
  OrderProofProgress,
  OrderRetainedProofSet,
  PrepareOrderCommitmentInput,
  RecordPrecommitFailureInput,
  VerifyOrderBindingInput,
} from '../../shared/domain/order-commitment.ts';
import type { VerifiedOrderBinding } from '@app/commerce-order-contracts/verify-order-commitment-binding';
import {
  OrderFinalPurchaseEvidenceSchema,
  OrderPricingCommitProofSchema,
  OrderTaxCandidateSchema,
} from '../../shared/domain/order-finalization-evidence.ts';
import type {
  OrderFinalPurchaseEvidence,
  OrderPricingCommitProof,
} from '../../shared/domain/order-finalization-evidence.ts';
import type { OrderRef } from '../../shared/resources/order.ts';
import {
  acceptanceBundles,
  finalizationIntents,
  commitmentAttempts,
  commitmentHistory,
  committedOrders,
  consumptionObligations,
} from '../db/schema.ts';

type LoadEvidence = Extract<OrderServiceApprovalEvidenceResponse, { readonly operation: 'LOAD_PROPOSAL' }>;
type ProofEvidence = Extract<OrderServiceApprovalEvidenceResponse, { readonly operation: 'VERIFY_PROOF' }>;
export interface ResourceRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const sameRef = (left: ResourceRef, right: ResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId;
interface StructuralBinding {
  readonly attemptRef: ResourceRef;
  readonly bundleHash: string;
  readonly bundleRef: ResourceRef;
  readonly bundleVersion: string;
}
export const sameOrderBinding = (left: StructuralBinding, right: StructuralBinding): boolean =>
  sameRef(left.attemptRef, right.attemptRef) &&
  sameRef(left.bundleRef, right.bundleRef) &&
  left.bundleHash === right.bundleHash &&
  left.bundleVersion === right.bundleVersion;
const rejected = (code: OrderCommitmentRejected['code'], reason: string) =>
  new OrderCommitmentRejected({ code, reason });
const unavailable = (cause?: unknown) => {
  const failure = rejected('order_commitment_unavailable', 'Order commitment state could not be verified');
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause });
  }
  return failure;
};
const conflict = () => rejected('order_commitment_conflict', 'The Order commitment has changed or does not match');
const ownerConflictConstraints = new Set([
  'order_attempts_correlation_uk',
  'order_orders_attempt_uk',
  'order_orders_approval_request_uk',
  'order_finalization_business_uk',
  'order_finalization_scope_id_uk',
  'order_finalization_proof_uk',
]);
const writeFailure = (cause: unknown) =>
  isPostgresUniqueViolation(cause, ownerConflictConstraints)
    ? Object.defineProperty(conflict(), 'cause', { value: cause })
    : unavailable(cause);
const orderModuleId = 'commerce.order' as const;
const acceptanceBundleKind = 'acceptance-bundle' as const;
const commitmentAttemptKind = 'commitment-attempt' as const;
const acceptanceBundleVersion = 'order-acceptance-bundle.v1' as const;
const resourceRef = <Kind extends 'acceptance-bundle' | 'commitment-attempt' | 'order'>(
  kind: Kind,
  tenantId: string,
  resourceId: string,
) => ({ moduleId: orderModuleId, resourceId, resourceType: `commerce.order.${kind}` as const, tenantId });

const { bundleHash: _bundleHash, ...bundleIdentityFields } = OrderAcceptanceBundleSchema.fields;
const BundleIdentitySchema = Schema.Struct(bundleIdentityFields);
const CanonicalJsonSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(CanonicalJsonSchema),
    Schema.Record(Schema.String, CanonicalJsonSchema),
  ]),
);
const CanonicalJsonRecordSchema = Schema.Record(Schema.String, CanonicalJsonSchema);
const compareKeys = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};
const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (Schema.is(CanonicalJsonRecordSchema)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
};
/** Sorted JSON object keys keep the exact identity stable across PostgreSQL JSONB round trips. */
export const computeOrderBundleHash = (
  bundle: Omit<OrderAcceptanceBundle, 'bundleHash'> & { readonly bundleHash?: string },
) =>
  Schema.encodeEffect(Schema.toCodecJson(BundleIdentitySchema))(bundle).pipe(
    Effect.flatMap((encoded) => Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(canonicalJson(encoded))),
    Effect.map((encoded) => Hex.encode(sha256(utf8ToBytes(encoded)))),
    Effect.mapError(unavailable),
  );

const bundleStateMatchesBinding = (
  state: OrderCommitmentState,
  binding: OrderFinalBinding,
  principalId: string,
  legalEntityId: string,
): boolean =>
  !(
    state.bundle.bundleHash !== binding.bundleHash ||
    !sameRef(state.bundle.bundleRef, binding.bundleRef) ||
    state.bundle.buyerPrincipalId !== principalId ||
    state.bundle.legalEntityId !== legalEntityId ||
    (state.order !== null &&
      (!sameOrderBinding(state.order.binding, binding) ||
        !sameRef(state.order.approvalRequestRef, state.bundle.approvalRequestRef)))
  );

const approvalIssuerMatches = (
  issuer: NonNullable<OrderCommitmentState['order']>['approvalIssuer'],
  actorPrincipalId: string | undefined,
  buyerPrincipalId: string,
): boolean =>
  issuer.kind === 'BUYER'
    ? issuer.buyerPrincipalId === buyerPrincipalId && actorPrincipalId === buyerPrincipalId
    : actorPrincipalId === issuer.serviceProofActorPrincipalId;

const pricingProofMatchesBundle = (state: OrderCommitmentState, pricingProof: OrderPricingCommitProof): boolean => {
  const { confirmation } = pricingProof;
  return (
    Schema.is(OrderPricingCommitProofSchema)(pricingProof) &&
    confirmation.binding.attemptRef === state.attempt.binding.attemptRef.resourceId &&
    confirmation.binding.decisionBundleRef === state.bundle.bundleRef.resourceId &&
    confirmation.binding.decisionBundleHash === state.bundle.bundleHash &&
    confirmation.binding.decisionBundleVersion === state.bundle.bundleVersion &&
    Schema.toEquivalence(PricingQuotationBindingSchema)(
      confirmation.binding.purchase,
      state.bundle.finalization.pricing.quotation.binding,
    ) &&
    confirmation.source.kind === 'QUOTATION_BACKED' &&
    Schema.toEquivalence(Schema.toType(PricingQuotationIssuedSchema))(
      confirmation.source.quotationRevalidation.quotation,
      state.bundle.finalization.pricing.quotation,
    )
  );
};

const proofMatchesPreparedOrder = (
  state: OrderCommitmentState,
  input: CommitOrderInput,
  evidence: ProofEvidence,
  principalId: string,
): boolean => {
  const { proof } = evidence;
  return !(
    state.attempt.revision !== input.expectedRevision ||
    !['READY', 'PRECOMMIT_FAILED'].includes(state.attempt.status) ||
    evidence.request.status !== 'APPROVED' ||
    !sameRef(evidence.request.requestRef, state.bundle.approvalRequestRef) ||
    !sameRef(proof.revalidationRef, input.revalidationRef) ||
    !sameRef(proof.requestRef, state.bundle.approvalRequestRef) ||
    !sameRef(proof.proposalRevisionRef, state.bundle.proposal.proposalRevisionRef) ||
    evidence.proposal.canonicalHash !== state.bundle.proposal.canonicalHash ||
    proof.status !== 'APPROVAL_VALID' ||
    !approvalIssuerMatches(evidence.issuer, proof.evidence.actorPrincipalId, principalId) ||
    !sameRef(evidence.candidateRef, state.bundle.finalization.cart.candidateRef) ||
    evidence.candidateHash !== state.bundle.finalization.cart.candidateHash ||
    proof.evidence.commitmentCorrelationId !== state.attempt.commitmentCorrelationId ||
    proof.evidence.proposalHash !== state.bundle.proposal.canonicalHash ||
    proof.evidence.decisionBundleHash !== state.bundle.approvalDecisionBundleHash ||
    proof.evidence.decisionBundleVersion !== state.bundle.approvalDecisionBundleVersion ||
    proof.evidence.finalBindingEvidence === undefined ||
    !sameOrderBinding(proof.evidence.finalBindingEvidence.binding, input.binding)
  );
};

interface ConsumptionCompletionIdentity {
  readonly binding: OrderFinalBinding;
  readonly bundle: OrderCommitmentState['bundle'];
  readonly commitmentCorrelationId: string;
  readonly consumptionIntent: string;
  readonly order: NonNullable<OrderCommitmentState['order']>;
  readonly orderRef: OrderRef;
}
const consumedRequestMatchesCommit = (
  request: ConsumeOrderPurchaseApprovalResult['request'],
  expected: ConsumptionCompletionIdentity,
): boolean =>
  request.status === 'CONSUMED' &&
  request.consumedAt !== null &&
  request.committedOrderRef !== null &&
  sameRef(request.committedOrderRef, expected.orderRef) &&
  request.consumptionCommitmentId === expected.commitmentCorrelationId &&
  request.consumptionFinalBinding !== undefined &&
  sameOrderBinding(request.consumptionFinalBinding, expected.binding) &&
  request.consumptionProofRef !== undefined &&
  sameRef(request.consumptionProofRef, expected.order.approvalProof.revalidationRef) &&
  request.consumptionIdempotencyKey === expected.consumptionIntent &&
  sameRef(request.requestRef, expected.bundle.approvalRequestRef);
const consumedApprovalMatchesBundle = (
  request: ConsumeOrderPurchaseApprovalResult['request'],
  expected: ConsumptionCompletionIdentity,
): boolean =>
  request.proposal.canonicalHash === expected.bundle.proposal.canonicalHash &&
  request.proposal.revision === expected.bundle.proposal.revision &&
  sameRef(request.proposal.proposalRevisionRef, expected.bundle.proposal.proposalRevisionRef) &&
  request.decisionBundleHash === expected.bundle.approvalDecisionBundleHash &&
  request.decisionBundleVersion === expected.bundle.approvalDecisionBundleVersion &&
  request.lastDecisionRef !== null &&
  sameRef(request.lastDecisionRef, expected.order.approvalProof.evidence.decisionRef) &&
  sameRef(request.route.routeRef, expected.order.approvalProof.evidence.routeRef) &&
  sameRef(request.route.hierarchyRef, expected.order.approvalProof.evidence.hierarchyRef);
const consumptionEvidenceMatchesCommit = (
  request: ConsumeOrderPurchaseApprovalResult['request'],
  expected: ConsumptionCompletionIdentity,
): boolean => {
  const consumption = request.consumptionEvidence;
  return (
    consumption !== undefined &&
    sameRef(consumption.orderRef, expected.orderRef) &&
    consumption.revalidationRef !== undefined &&
    sameRef(consumption.revalidationRef, expected.order.approvalProof.revalidationRef) &&
    consumption.finalBinding !== undefined &&
    sameOrderBinding(consumption.finalBinding, expected.binding) &&
    consumption.commitmentCorrelationId === expected.commitmentCorrelationId &&
    consumption.idempotencyKey === expected.consumptionIntent &&
    consumption.decisionBundleHash === expected.bundle.approvalDecisionBundleHash &&
    consumption.decisionBundleVersion === expected.bundle.approvalDecisionBundleVersion &&
    consumption.storefrontId === expected.bundle.storefrontId &&
    sameRef(consumption.counterpartyRef, expected.bundle.proposal.identity.counterpartyRef) &&
    DateTime.toEpochMillis(consumption.committedAt) === DateTime.toEpochMillis(expected.order.committedAt)
  );
};

interface OwnerScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}
const isConfiguredApiKeyVerifier = (scope: OperationalScope, configuredPrincipalId: string | undefined): boolean =>
  configuredPrincipalId !== undefined &&
  scope.principalId === configuredPrincipalId &&
  scope.authMethod === 'api_key' &&
  scope.authBindingId !== undefined &&
  scope.impersonatedByPrincipalId === undefined;
const attemptMatchesBinding = (
  attempt: { readonly bundleHash: string; readonly bundleId: string },
  binding: OrderFinalBinding,
): boolean =>
  attempt.bundleId === binding.bundleRef.resourceId &&
  attempt.bundleHash === binding.bundleHash &&
  binding.bundleVersion === acceptanceBundleVersion;
const retainedRowsInconsistent = (
  attempt: { readonly orderId: string | null; readonly status: string },
  orderRow: { readonly orderId: string } | undefined,
  obligation: typeof consumptionObligations.$inferSelect | undefined,
): boolean =>
  (orderRow === undefined) !== (attempt.status !== 'COMMITTED') ||
  (orderRow !== undefined && (obligation === undefined || attempt.orderId !== orderRow.orderId));
const retainedOrderInconsistent = (state: OrderCommitmentState): boolean =>
  state.order !== null &&
  (!approvalIssuerMatches(
    state.order.approvalIssuer,
    state.order.approvalProof.evidence.actorPrincipalId,
    state.bundle.buyerPrincipalId,
  ) ||
    !pricingProofMatchesBundle(state, state.order.pricingProof) ||
    DateTime.toEpochMillis(state.order.acceptedAt) !== DateTime.toEpochMillis(state.bundle.orderCommitmentTime) ||
    DateTime.toEpochMillis(state.order.committedAt) < DateTime.toEpochMillis(state.order.acceptedAt));
const committedOrderRefInvalid = (
  input: { readonly orderRef: ResourceRef; readonly revalidationRef: ResourceRef },
  ownerScope: OwnerScope,
): boolean =>
  input.orderRef.tenantId !== ownerScope.tenantId ||
  input.orderRef.moduleId !== orderModuleId ||
  input.orderRef.resourceType !== 'commerce.order.order' ||
  input.revalidationRef.tenantId !== ownerScope.tenantId;
const committedProofInexact = (
  state: OrderCommitmentState,
  order: NonNullable<OrderCommitmentState['order']>,
  finalBinding: OrderFinalBinding,
): boolean => {
  const proof = order.approvalProof;
  const finalEvidence = proof.evidence.finalBindingEvidence;
  return (
    proof.status !== 'APPROVAL_VALID' ||
    finalEvidence === undefined ||
    !sameOrderBinding(finalEvidence.binding, finalBinding) ||
    !approvalIssuerMatches(order.approvalIssuer, proof.evidence.actorPrincipalId, state.bundle.buyerPrincipalId) ||
    !pricingProofMatchesBundle(state, order.pricingProof) ||
    DateTime.toEpochMillis(order.acceptedAt) !== DateTime.toEpochMillis(state.bundle.orderCommitmentTime) ||
    proof.evidence.commitmentCorrelationId !== state.attempt.commitmentCorrelationId ||
    order.commitmentCorrelationId !== state.attempt.commitmentCorrelationId ||
    proof.evidence.proposalHash !== state.bundle.proposal.canonicalHash ||
    !sameRef(proof.proposalRevisionRef, state.bundle.proposal.proposalRevisionRef) ||
    !sameRef(proof.requestRef, state.bundle.approvalRequestRef) ||
    proof.evidence.decisionBundleHash !== state.bundle.approvalDecisionBundleHash ||
    proof.evidence.decisionBundleVersion !== state.bundle.approvalDecisionBundleVersion
  );
};
const finalCartEvidenceUnbound = (
  finalization: OrderFinalPurchaseEvidence,
  input: PrepareOrderCommitmentInput,
  evidence: LoadEvidence,
  ownerScope: OwnerScope,
  buyerPrincipalId: string,
): boolean => {
  const { proposal } = evidence;
  const { cart } = finalization;
  return (
    !Schema.is(OrderFinalPurchaseEvidenceSchema)(finalization) ||
    !Schema.toEquivalence(OrderAcceptanceBundleSchema.fields.proposal.fields.purchaseValue)(
      finalization.purchaseValue,
      proposal.purchaseValue,
    ) ||
    !sameRef(cart.candidateRef, input.candidateRef) ||
    cart.candidateHash !== input.candidateHash ||
    !sameRef(evidence.candidateRef, cart.candidateRef) ||
    evidence.candidateHash !== cart.candidateHash ||
    cart.tenantId !== ownerScope.tenantId ||
    cart.legalEntityId !== ownerScope.legalEntityId ||
    cart.buyerPrincipalId !== buyerPrincipalId ||
    cart.storefrontId !== input.storefrontId ||
    !sameRef(cart.approval.requestRef, input.requestRef) ||
    !sameRef(cart.approval.proposalRevisionRef, proposal.proposalRevisionRef) ||
    cart.approval.proposalHash !== proposal.canonicalHash ||
    !sameRef(cart.sourceCart.cartRef, proposal.sourceCart.cartRef) ||
    String(cart.sourceCart.revision) !== proposal.sourceCart.revision
  );
};
const finalPricingTaxEvidenceUnbound = (
  finalization: OrderFinalPurchaseEvidence,
  input: PrepareOrderCommitmentInput,
  evidence: LoadEvidence,
  ownerScope: OwnerScope,
): boolean => {
  const { proposal } = evidence;
  const { cart, pricing, tax, taxIntent } = finalization;
  return (
    pricing.quotation.quotationRef !== input.quotationRef ||
    pricing.quotation.binding.tenantId !== ownerScope.tenantId ||
    pricing.quotation.binding.commercialScope.sellingLegalEntityId !== ownerScope.legalEntityId ||
    pricing.quotation.binding.candidateRef !== cart.candidateRef.resourceId ||
    pricing.quotation.binding.currencyCode !== proposal.currency ||
    !Schema.toEquivalence(OrderTaxCandidateSchema)(taxIntent.request.candidate, input.taxCandidate) ||
    taxIntent.request.candidate.purchase.currency !== proposal.currency ||
    taxIntent.request.candidate.purchase.tenantId !== ownerScope.tenantId ||
    taxIntent.request.candidate.purchase.purchaseCandidateRef !== cart.candidateRef.resourceId ||
    !Schema.toEquivalence(OrderTaxCandidateSchema.fields.purchase.fields.pricingResultRef)(
      taxIntent.request.candidate.purchase.pricingResultRef,
      pricing.pricingResultRef,
    ) ||
    DateTime.toEpochMillis(cart.orderCommitmentTime) !==
      DateTime.toEpochMillis(DateTime.makeUnsafe(taxIntent.request.orderCommitmentTime)) ||
    !Predicate.isTagged(tax.result, 'FINALIZED') ||
    tax.result.handoff.submissionRef !== taxIntent.request.submissionRef ||
    DateTime.toEpochMillis(tax.result.handoff.orderCommitmentTime) !==
      DateTime.toEpochMillis(taxIntent.request.orderCommitmentTime)
  );
};
const finalPaymentTermsEvidenceUnbound = (
  finalization: OrderFinalPurchaseEvidence,
  evidence: LoadEvidence,
): boolean => {
  const { proposal } = evidence;
  const { cart, paymentTerms } = finalization;
  const { resolution } = paymentTerms;
  return (
    !sameRef(paymentTerms.catalogDefinition.paymentTermRef, proposal.paymentTerm.definitionRef) ||
    paymentTerms.catalogDefinition.code !== proposal.paymentTerm.code ||
    paymentTerms.catalogDefinition.definitionRevisionId !== proposal.paymentTerm.definitionRevision ||
    (!Predicate.isTagged(resolution, 'EXPLICIT_CHOICE') &&
      !Predicate.isTagged(resolution, 'PREFERRED_ENTITLEMENT') &&
      !Predicate.isTagged(resolution, 'POLICY_FALLBACK')) ||
    !sameRef(resolution.definition.paymentTermRef, paymentTerms.catalogDefinition.paymentTermRef) ||
    resolution.definition.semanticRevisionId !== paymentTerms.catalogDefinition.semanticRevisionId ||
    DateTime.toEpochMillis(DateTime.makeUnsafe(paymentTerms.effectiveAt)) !==
      DateTime.toEpochMillis(cart.orderCommitmentTime) ||
    DateTime.toEpochMillis(DateTime.makeUnsafe(resolution.resolvedAt)) !==
      DateTime.toEpochMillis(cart.orderCommitmentTime)
  );
};
const proposalIneligible = (
  input: PrepareOrderCommitmentInput,
  evidence: LoadEvidence,
  scope: OperationalScope,
  ownerScope: OwnerScope,
  buyerPrincipalId: string,
): boolean => {
  const { proposal } = evidence;
  return (
    evidence.request.decisionBundleHash === null ||
    evidence.request.decisionBundleVersion !== 'approval-decision-bundle.v1' ||
    evidence.request.status !== 'APPROVED' ||
    !sameRef(input.requestRef, evidence.request.requestRef) ||
    !sameRef(input.counterpartyRef, proposal.identity.counterpartyRef) ||
    proposal.context.tenantId !== scope.tenantId ||
    proposal.context.sellingLegalEntityId !== ownerScope.legalEntityId ||
    proposal.identity.buyer.principalId !== buyerPrincipalId ||
    proposal.context.storefrontId !== input.storefrontId ||
    (scope.trustedStorefrontId !== undefined && scope.trustedStorefrontId !== input.storefrontId) ||
    proposal.state !== 'CURRENT'
  );
};
const retainedPreparationDiffers = (
  state: OrderCommitmentState,
  input: PrepareOrderCommitmentInput,
  proposalHash: string,
): boolean =>
  !sameRef(state.bundle.approvalRequestRef, input.requestRef) ||
  state.bundle.proposal.canonicalHash !== proposalHash ||
  state.bundle.storefrontId !== input.storefrontId ||
  !sameRef(state.bundle.finalization.cart.candidateRef, input.candidateRef) ||
  state.bundle.finalization.cart.candidateHash !== input.candidateHash ||
  state.bundle.finalization.pricing.quotation.quotationRef !== input.quotationRef ||
  !Schema.toEquivalence(OrderTaxCandidateSchema)(
    state.bundle.finalization.taxIntent.request.candidate,
    input.taxCandidate,
  );
const intentRef = (row: typeof finalizationIntents.$inferSelect) => ({
  moduleId: orderModuleId,
  resourceId: row.intentId,
  resourceType: row.stage === 'PREPARE' ? 'commerce.order.finalization-intent' : 'commerce.order.proof-request',
  tenantId: row.tenantId,
});
type OrderIntentRef = ReturnType<typeof intentRef>;
type FinalizationIntentRow = typeof finalizationIntents.$inferSelect;
export type OrderPreparationProgressRecord =
  | OrderPreparationProgress
  | { readonly binding: null; readonly intentRef: OrderIntentRef; readonly status: 'FAILED' | 'PREPARATION_PENDING' };
export type OrderProofProgressRecord =
  | {
      readonly binding: OrderFinalBinding;
      readonly intentRef: OrderIntentRef;
      readonly revalidationRef: null;
      readonly status: Extract<OrderProofProgress['status'], 'CANCELLED' | 'FAILED' | 'PROOFS_PENDING'>;
      readonly validUntil: null;
    }
  | {
      readonly binding: OrderFinalBinding;
      readonly intentRef: OrderIntentRef;
      readonly revalidationRef: ProofEvidence['proof']['revalidationRef'];
      readonly status: Extract<OrderProofProgress['status'], 'EXPIRED' | 'READY'>;
      readonly validUntil: DateTime.Utc;
    };
type OrderCommitmentTransition = (
  input: RecordPrecommitFailureInput,
  evidence?: ProofEvidence,
) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
/** Closed transaction-bound Order commitment methods handed to Order services. */
export interface OrderCommitmentPersistence {
  readonly assertNoPendingProof: (binding: OrderFinalBinding) => Effect.Effect<void, OrderCommitmentRejected>;
  readonly cancel: OrderCommitmentTransition;
  readonly commit: (
    input: CommitOrderInput,
    evidence?: ProofEvidence,
    pricingProof?: OrderPricingCommitProof,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly completeConsumption: (
    binding: OrderFinalBinding,
    orderRef: OrderRef,
    consumptionIntent: string,
    receipt: ConsumeOrderPurchaseApprovalResult,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly completeIntent: (
    row: FinalizationIntentRow,
    result: Schema.Json,
    proofRef?: string | null,
    status?: 'COMPLETE' | 'FAILED',
  ) => Effect.Effect<Option.Option<FinalizationIntentRow>, OrderCommitmentRejected>;
  readonly findIntent: (
    ref: ResourceRef,
    lock?: boolean,
  ) => Effect.Effect<FinalizationIntentRow, OrderCommitmentRejected>;
  readonly intentRef: (row: FinalizationIntentRow) => OrderIntentRef;
  readonly load: (
    binding: OrderFinalBinding,
    lock?: boolean,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly loadCommittedApprovalEvidence: (input: {
    readonly finalBinding: OrderFinalBinding;
    readonly orderRef: ResourceRef;
    readonly revalidationRef: ResourceRef;
  }) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly loadOrderForService: (ref: ResourceRef) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly loadPreparedForVerifier: (
    binding: OrderFinalBinding,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly markPrecommitFailure: OrderCommitmentTransition;
  readonly originalIntent: (
    stage: 'PREPARE' | 'PROOF',
    businessKey: string,
  ) => Effect.Effect<Option.Option<FinalizationIntentRow>, OrderCommitmentRejected>;
  readonly preparationProgress: (
    row: FinalizationIntentRow,
  ) => Effect.Effect<OrderPreparationProgressRecord, OrderCommitmentRejected>;
  readonly prepare: (
    input: PrepareOrderCommitmentInput,
    evidence: LoadEvidence,
    finalization: OrderFinalPurchaseEvidence,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected>;
  readonly proofProgress: (
    row: FinalizationIntentRow,
  ) => Effect.Effect<OrderProofProgressRecord, OrderCommitmentRejected>;
  readonly replayPreparation: (
    input: PrepareOrderCommitmentInput,
  ) => Effect.Effect<Option.Option<OrderCommitmentState>, OrderCommitmentRejected>;
  readonly requestPreparation: (
    input: PrepareOrderCommitmentInput,
    evidence: LoadEvidence,
  ) => Effect.Effect<OrderPreparationProgressRecord, OrderCommitmentRejected>;
  readonly requestProof: (input: {
    readonly binding: OrderFinalBinding;
    readonly idempotencyKey: string;
  }) => Effect.Effect<OrderProofProgressRecord, OrderCommitmentRejected>;
  readonly retainedProof: (input: CommitOrderInput) => Effect.Effect<OrderRetainedProofSet, OrderCommitmentRejected>;
  readonly verifyBinding: (
    input: VerifyOrderBindingInput,
  ) => Effect.Effect<VerifiedOrderBinding, OrderCommitmentRejected>;
}

/** Construction is private to a Core-owned transaction; handlers receive only these closed methods. */
export const makeOrderCommitmentPersistence = (
  transaction: ScopedTransactionExecutor,
  context: {
    readonly businessBuyerPrincipalId?: string;
    readonly committedEvidencePrincipalId?: string;
    readonly operationId: string;
    readonly preparedEvidencePrincipalId?: string;
    readonly scope: OperationalScope;
    readonly serviceActorPrincipalId?: string;
  },
): OrderCommitmentPersistence => {
  const { operationId, scope } = context;
  const buyerPrincipalId = context.businessBuyerPrincipalId ?? scope.principalId;
  const service =
    context.serviceActorPrincipalId !== undefined &&
    scope.principalId === context.serviceActorPrincipalId &&
    scope.authMethod === 'api_key' &&
    scope.authBindingId !== undefined &&
    scope.impersonatedByPrincipalId === undefined;
  const scoped = () => {
    if (
      (context.businessBuyerPrincipalId !== undefined && !service) ||
      scope.legalEntityId === undefined ||
      transaction.scope.tenantId !== scope.tenantId ||
      transaction.scope.legalEntityId !== scope.legalEntityId
    ) {
      return Effect.fail(rejected('order_commitment_permission_denied', 'A verified selling Legal Entity is required'));
    }
    return Effect.succeed({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
  };
  const loadForBuyer: (
    binding: OrderFinalBinding,
    owningBuyerPrincipalId: string,
    lock?: boolean,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected> = Effect.fn('OrderCommitment.loadForBuyer')(
    function* loadOrderForBuyer(binding: OrderFinalBinding, owningBuyerPrincipalId: string, lock = false) {
      const ownerScope = yield* scoped();
      if (binding.attemptRef.tenantId !== scope.tenantId || binding.bundleRef.tenantId !== scope.tenantId) {
        return yield* conflict();
      }
      const attemptQuery = transaction
        .select()
        .from(commitmentAttempts)
        .where(
          and(
            eq(commitmentAttempts.tenantId, ownerScope.tenantId),
            eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
            eq(commitmentAttempts.attemptId, binding.attemptRef.resourceId),
            eq(commitmentAttempts.buyerPrincipalId, owningBuyerPrincipalId),
          ),
        );
      const [attempt] = yield* (lock ? attemptQuery.for('update') : attemptQuery).pipe(Effect.mapError(unavailable));
      if (attempt === undefined || !attemptMatchesBinding(attempt, binding)) {
        return yield* rejected('order_commitment_not_found', 'Order commitment is unavailable');
      }
      const [bundleRow] = yield* transaction
        .select()
        .from(acceptanceBundles)
        .where(
          and(
            eq(acceptanceBundles.tenantId, ownerScope.tenantId),
            eq(acceptanceBundles.legalEntityId, ownerScope.legalEntityId),
            eq(acceptanceBundles.bundleId, attempt.bundleId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      if (
        bundleRow === undefined ||
        bundleRow.buyerPrincipalId !== owningBuyerPrincipalId ||
        bundleRow.bundleHash !== binding.bundleHash
      ) {
        return yield* conflict();
      }
      const history = yield* transaction
        .select()
        .from(commitmentHistory)
        .where(
          and(
            eq(commitmentHistory.tenantId, ownerScope.tenantId),
            eq(commitmentHistory.legalEntityId, ownerScope.legalEntityId),
            eq(commitmentHistory.attemptId, attempt.attemptId),
          ),
        )
        .orderBy(asc(commitmentHistory.revision))
        .limit(1001)
        .pipe(Effect.mapError(unavailable));
      if (history.length > 1000) {
        return yield* unavailable();
      }
      const [orderRow] = yield* transaction
        .select()
        .from(committedOrders)
        .where(
          and(
            eq(committedOrders.tenantId, ownerScope.tenantId),
            eq(committedOrders.legalEntityId, ownerScope.legalEntityId),
            eq(committedOrders.attemptId, attempt.attemptId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const [obligation] =
        orderRow === undefined
          ? []
          : yield* transaction
              .select()
              .from(consumptionObligations)
              .where(
                and(
                  eq(consumptionObligations.tenantId, ownerScope.tenantId),
                  eq(consumptionObligations.legalEntityId, ownerScope.legalEntityId),
                  eq(consumptionObligations.orderId, orderRow.orderId),
                ),
              )
              .pipe(Effect.mapError(unavailable));
      if (retainedRowsInconsistent(attempt, orderRow, obligation)) {
        return yield* unavailable();
      }
      const state = yield* Schema.decodeUnknownEffect(OrderCommitmentStateSchema)({
        attempt: {
          binding,
          commitmentCorrelationId: attempt.commitmentCorrelationId,
          createdAt: attempt.createdAt.toISOString(),
          orderRef: attempt.orderId === null ? null : resourceRef('order', scope.tenantId, attempt.orderId),
          revision: attempt.revision,
          status: attempt.status,
          updatedAt: attempt.updatedAt.toISOString(),
        },
        bundle: bundleRow.snapshot,
        history: history.map((entry) => ({
          at: entry.at.toISOString(),
          kind: entry.kind,
          operationId: entry.operationId,
          proofRef:
            entry.proofResourceId === null
              ? null
              : {
                  moduleId: 'commerce.customer-context',
                  resourceId: entry.proofResourceId,
                  resourceType: 'commerce.customer-context.approval-revalidation',
                  tenantId: scope.tenantId,
                },
          revision: entry.revision,
        })),
        order:
          orderRow === undefined
            ? null
            : { ...orderRow.snapshot, consumptionStatus: obligation?.completedAt === null ? 'PENDING' : 'COMPLETE' },
      }).pipe(Effect.mapError(unavailable));
      const actualHash = yield* computeOrderBundleHash(state.bundle);
      if (
        actualHash !== binding.bundleHash ||
        !bundleStateMatchesBinding(state, binding, owningBuyerPrincipalId, ownerScope.legalEntityId)
      ) {
        return yield* unavailable();
      }
      if (retainedOrderInconsistent(state)) {
        return yield* unavailable();
      }
      return state;
    },
  );
  const load: (
    binding: OrderFinalBinding,
    lock?: boolean,
  ) => Effect.Effect<OrderCommitmentState, OrderCommitmentRejected> = Effect.fn('OrderCommitment.load')(
    function* loadOrder(binding: OrderFinalBinding, lock = false) {
      return yield* loadForBuyer(binding, buyerPrincipalId, lock);
    },
  );
  /** Closed Pricing verifier read; buyer identity comes only from the retained owner Attempt. */
  const loadPreparedForVerifier = Effect.fn('OrderCommitment.loadPreparedForVerifier')(
    function* loadPreparedOrderForVerifier(binding: OrderFinalBinding) {
      const ownerScope = yield* scoped();
      if (!isConfiguredApiKeyVerifier(scope, context.preparedEvidencePrincipalId)) {
        return yield* rejected(
          'order_commitment_permission_denied',
          'Prepared Order evidence requires the configured verifier',
        );
      }
      if (binding.attemptRef.tenantId !== ownerScope.tenantId || binding.bundleRef.tenantId !== ownerScope.tenantId) {
        return yield* conflict();
      }
      const [attempt] = yield* transaction
        .select()
        .from(commitmentAttempts)
        .where(
          and(
            eq(commitmentAttempts.tenantId, ownerScope.tenantId),
            eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
            eq(commitmentAttempts.attemptId, binding.attemptRef.resourceId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      if (attempt === undefined) {
        return yield* rejected('order_commitment_not_found', 'Prepared Order evidence is unavailable');
      }
      const state = yield* loadForBuyer(binding, attempt.buyerPrincipalId);
      if (state.order !== null || (state.attempt.status !== 'READY' && state.attempt.status !== 'PRECOMMIT_FAILED')) {
        return yield* conflict();
      }
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(state.bundle.proposal.expiresAt)) {
        return yield* rejected('order_commitment_ineligible', 'The prepared proposal has expired');
      }
      return state;
    },
  );
  /** Only the configured, Core-authenticated CCC verifier may obtain committed historical proof. */
  const loadCommittedApprovalEvidence = Effect.fn('OrderCommitment.loadCommittedApprovalEvidence')(
    function* loadCommittedOrderEvidence(input: {
      readonly finalBinding: OrderFinalBinding;
      readonly orderRef: ResourceRef;
      readonly revalidationRef: ResourceRef;
    }) {
      const ownerScope = yield* scoped();
      if (!isConfiguredApiKeyVerifier(scope, context.committedEvidencePrincipalId)) {
        return yield* rejected(
          'order_commitment_permission_denied',
          'Committed approval evidence requires the configured verifier',
        );
      }
      if (committedOrderRefInvalid(input, ownerScope)) {
        return yield* conflict();
      }
      const [order] = yield* transaction
        .select()
        .from(committedOrders)
        .where(
          and(
            eq(committedOrders.tenantId, ownerScope.tenantId),
            eq(committedOrders.legalEntityId, ownerScope.legalEntityId),
            eq(committedOrders.orderId, input.orderRef.resourceId),
            eq(committedOrders.attemptId, input.finalBinding.attemptRef.resourceId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      if (order === undefined) {
        return yield* rejected('order_commitment_not_found', 'Committed Order evidence is unavailable');
      }
      const [attempt] = yield* transaction
        .select()
        .from(commitmentAttempts)
        .where(
          and(
            eq(commitmentAttempts.tenantId, ownerScope.tenantId),
            eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
            eq(commitmentAttempts.attemptId, order.attemptId),
            eq(commitmentAttempts.status, 'COMMITTED'),
            eq(commitmentAttempts.orderId, order.orderId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      if (attempt === undefined) {
        return yield* unavailable();
      }
      // The buyer is an immutable owner row fact. It never comes from the service caller or its payload.
      const state = yield* loadForBuyer(input.finalBinding, attempt.buyerPrincipalId);
      if (
        state.order === null ||
        !sameRef(state.order.orderRef, input.orderRef) ||
        !sameRef(state.order.approvalProof.revalidationRef, input.revalidationRef)
      ) {
        return yield* conflict();
      }
      const proof = state.order.approvalProof;
      const finalEvidence = proof.evidence.finalBindingEvidence;
      if (finalEvidence === undefined || committedProofInexact(state, state.order, input.finalBinding)) {
        return yield* conflict();
      }
      // Recovery uses the exact immutable proof that was valid at commit, not current source or clock state.
      const committedAt = DateTime.toEpochMillis(state.order.committedAt);
      if (
        committedAt <
          Math.max(
            DateTime.toEpochMillis(proof.checkedAt),
            DateTime.toEpochMillis(finalEvidence.observedAt),
            DateTime.toEpochMillis(DateTime.makeUnsafe(state.order.pricingProof.confirmation.issuedAt)),
            DateTime.toEpochMillis(DateTime.makeUnsafe(state.order.pricingProof.verifiedAt)),
          ) ||
        committedAt >=
          Math.min(
            DateTime.toEpochMillis(proof.validUntil),
            DateTime.toEpochMillis(finalEvidence.validUntil),
            DateTime.toEpochMillis(state.bundle.proposal.expiresAt),
            DateTime.toEpochMillis(DateTime.makeUnsafe(state.order.pricingProof.confirmation.expiresAt)),
          )
      ) {
        return yield* conflict();
      }
      return state;
    },
  );
  const appendHistory = Effect.fn('OrderCommitment.appendHistory')(function* appendOrderHistory(
    binding: OrderFinalBinding,
    revision: number,
    kind: typeof commitmentHistory.$inferInsert.kind,
    at: DateTime.Utc,
    proofResourceId: string | null,
  ) {
    const ownerScope = yield* scoped();
    yield* transaction
      .insert(commitmentHistory)
      .values({
        ...ownerScope,
        at: DateTime.toDateUtc(at),
        attemptId: binding.attemptRef.resourceId,
        kind,
        operationId,
        proofResourceId,
        revision,
      })
      .pipe(Effect.mapError(unavailable));
  });
  const updateAttempt = Effect.fn('OrderCommitment.updateAttempt')(function* updateOrderAttempt(
    state: OrderCommitmentState,
    status: typeof commitmentAttempts.$inferInsert.status,
    now: DateTime.Utc,
    orderId: string | null,
  ) {
    const ownerScope = yield* scoped();
    const rows = yield* transaction
      .update(commitmentAttempts)
      .set({ orderId, revision: state.attempt.revision + 1, status, updatedAt: DateTime.toDateUtc(now) })
      .where(
        and(
          eq(commitmentAttempts.tenantId, ownerScope.tenantId),
          eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
          eq(commitmentAttempts.attemptId, state.attempt.binding.attemptRef.resourceId),
          eq(commitmentAttempts.revision, state.attempt.revision),
        ),
      )
      .returning({ revision: commitmentAttempts.revision })
      .pipe(Effect.mapError(unavailable));
    if (rows.length !== 1) {
      return yield* conflict();
    }
    return yield* Effect.void;
  });
  /** Exact retained business intent replay precedes all remote observations and writes. */
  const replayPreparation = Effect.fn('OrderCommitment.replayPreparation')(function* replayPreparation(
    input: PrepareOrderCommitmentInput,
  ) {
    const ownerScope = yield* scoped();
    const [existing] = yield* transaction
      .select()
      .from(commitmentAttempts)
      .where(
        and(
          eq(commitmentAttempts.tenantId, ownerScope.tenantId),
          eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
          eq(commitmentAttempts.buyerPrincipalId, buyerPrincipalId),
          eq(commitmentAttempts.commitmentCorrelationId, input.commitmentCorrelationId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (existing === undefined) {
      return Option.none();
    }
    const binding = yield* Schema.decodeUnknownEffect(OrderFinalBindingSchema)({
      attemptRef: resourceRef(commitmentAttemptKind, scope.tenantId, existing.attemptId),
      bundleHash: existing.bundleHash,
      bundleRef: resourceRef(acceptanceBundleKind, scope.tenantId, existing.bundleId),
      bundleVersion: acceptanceBundleVersion,
    }).pipe(Effect.mapError(unavailable));
    const state = yield* load(binding);
    if (
      !sameRef(state.bundle.approvalRequestRef, input.requestRef) ||
      !sameRef(state.bundle.proposal.identity.counterpartyRef, input.counterpartyRef) ||
      state.bundle.storefrontId !== input.storefrontId ||
      (scope.trustedStorefrontId !== undefined && scope.trustedStorefrontId !== input.storefrontId) ||
      !sameRef(state.bundle.finalization.cart.candidateRef, input.candidateRef) ||
      state.bundle.finalization.cart.candidateHash !== input.candidateHash ||
      state.bundle.finalization.pricing.quotation.quotationRef !== input.quotationRef ||
      !Schema.toEquivalence(OrderTaxCandidateSchema)(
        state.bundle.finalization.taxIntent.request.candidate,
        input.taxCandidate,
      )
    ) {
      return yield* conflict();
    }
    return Option.some(state);
  });
  const prepare = Effect.fn('OrderCommitment.prepare')(function* prepareOrder(
    input: PrepareOrderCommitmentInput,
    evidence: LoadEvidence,
    finalization: OrderFinalPurchaseEvidence,
  ) {
    const ownerScope = yield* scoped();
    const { proposal } = evidence;
    const { cart } = finalization;
    if (
      finalCartEvidenceUnbound(finalization, input, evidence, ownerScope, buyerPrincipalId) ||
      finalPricingTaxEvidenceUnbound(finalization, input, evidence, ownerScope) ||
      finalPaymentTermsEvidenceUnbound(finalization, evidence)
    ) {
      return yield* rejected(
        'order_commitment_ineligible',
        'Final purchase evidence does not bind the approved Cart candidate',
      );
    }
    if (proposalIneligible(input, evidence, scope, ownerScope, buyerPrincipalId)) {
      return yield* rejected(
        'order_commitment_ineligible',
        'The approved proposal is not eligible for this buyer and scope',
      );
    }
    const [existing] = yield* transaction
      .select()
      .from(commitmentAttempts)
      .where(
        and(
          eq(commitmentAttempts.tenantId, ownerScope.tenantId),
          eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
          eq(commitmentAttempts.buyerPrincipalId, buyerPrincipalId),
          eq(commitmentAttempts.commitmentCorrelationId, input.commitmentCorrelationId),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
    if (existing !== undefined) {
      const existingBinding = yield* Schema.decodeUnknownEffect(OrderFinalBindingSchema)({
        attemptRef: resourceRef(commitmentAttemptKind, scope.tenantId, existing.attemptId),
        bundleHash: existing.bundleHash,
        bundleRef: resourceRef(acceptanceBundleKind, scope.tenantId, existing.bundleId),
        bundleVersion: acceptanceBundleVersion,
      }).pipe(Effect.mapError(unavailable));
      const state = yield* load(existingBinding);
      if (retainedPreparationDiffers(state, input, proposal.canonicalHash)) {
        return yield* conflict();
      }
      return state;
    }
    const now = yield* DateTime.now;
    const bundleRef = resourceRef(acceptanceBundleKind, scope.tenantId, `bundle:${operationId}`);
    const attemptRef = resourceRef(commitmentAttemptKind, scope.tenantId, `attempt:${operationId}`);
    const encodedFinalization = yield* Schema.encodeEffect(OrderFinalPurchaseEvidenceSchema)(finalization).pipe(
      Effect.mapError(unavailable),
    );
    const encodedProposal = yield* Schema.encodeEffect(OrderAcceptanceBundleSchema.fields.proposal)(proposal).pipe(
      Effect.mapError(unavailable),
    );
    const unsignedBundle = yield* Schema.decodeUnknownEffect(BundleIdentitySchema)({
      approvalDecisionBundleHash: evidence.request.decisionBundleHash,
      approvalDecisionBundleVersion: 'approval-decision-bundle.v1' as const,
      approvalRequestRef: input.requestRef,
      bundleRef,
      bundleVersion: acceptanceBundleVersion,
      buyerPrincipalId,
      finalization: encodedFinalization,
      legalEntityId: ownerScope.legalEntityId,
      orderCommitmentTime: DateTime.formatIso(cart.orderCommitmentTime),
      preparedAt: DateTime.formatIso(now),
      proposal: encodedProposal,
      storefrontId: input.storefrontId,
    }).pipe(Effect.mapError(unavailable));
    const bundleHash = yield* computeOrderBundleHash(unsignedBundle);
    const binding = yield* Schema.decodeUnknownEffect(OrderFinalBindingSchema)({
      attemptRef,
      bundleHash,
      bundleRef,
      bundleVersion: acceptanceBundleVersion,
    }).pipe(Effect.mapError(unavailable));
    const bundle: OrderAcceptanceBundle = { ...unsignedBundle, bundleHash };
    const snapshot = yield* Schema.encodeEffect(OrderAcceptanceBundleSchema)(bundle).pipe(Effect.mapError(unavailable));
    yield* transaction
      .insert(acceptanceBundles)
      .values({
        ...ownerScope,
        approvalRequestId: input.requestRef.resourceId,
        bundleHash,
        bundleId: bundleRef.resourceId,
        buyerPrincipalId,
        snapshot,
      })
      .pipe(Effect.mapError(unavailable));
    yield* transaction
      .insert(commitmentAttempts)
      .values({
        ...ownerScope,
        attemptId: attemptRef.resourceId,
        bundleHash,
        bundleId: bundleRef.resourceId,
        buyerPrincipalId,
        commitmentCorrelationId: input.commitmentCorrelationId,
        createdAt: DateTime.toDateUtc(now),
        revision: 1,
        status: 'READY',
        updatedAt: DateTime.toDateUtc(now),
      })
      .pipe(Effect.mapError(writeFailure));
    yield* appendHistory(binding, 1, 'PREPARED', now, null);
    return yield* load(binding);
  });
  const transition = (status: 'PRECOMMIT_FAILED' | 'CANCELLED') =>
    Effect.fn(`OrderCommitment.${status}`)(function* transitionOrder(
      input: RecordPrecommitFailureInput,
      evidence?: ProofEvidence,
    ) {
      const state = yield* load(input.binding, true);
      if (
        state.attempt.revision !== input.expectedRevision ||
        state.order !== null ||
        !['READY', 'PRECOMMIT_FAILED'].includes(state.attempt.status)
      ) {
        return yield* conflict();
      }
      if (
        status === 'PRECOMMIT_FAILED' &&
        input.revalidationRef !== undefined &&
        (evidence === undefined ||
          !sameRef(evidence.proof.revalidationRef, input.revalidationRef) ||
          !sameRef(evidence.proof.requestRef, state.bundle.approvalRequestRef) ||
          evidence.proof.evidence.proposalHash !== state.bundle.proposal.canonicalHash ||
          evidence.proof.evidence.commitmentCorrelationId !== state.attempt.commitmentCorrelationId ||
          !approvalIssuerMatches(evidence.issuer, evidence.proof.evidence.actorPrincipalId, buyerPrincipalId) ||
          !sameRef(evidence.candidateRef, state.bundle.finalization.cart.candidateRef) ||
          evidence.candidateHash !== state.bundle.finalization.cart.candidateHash ||
          evidence.proof.evidence.finalBindingEvidence === undefined ||
          !sameOrderBinding(evidence.proof.evidence.finalBindingEvidence.binding, input.binding))
      ) {
        return yield* conflict();
      }
      // This variant creates no reservation/payment or external precommit effects. Holding the
      // Attempt lock and proving no durable Order therefore establishes definite no-effect failure.
      const now = yield* DateTime.now;
      yield* updateAttempt(state, status, now, null);
      yield* appendHistory(
        input.binding,
        state.attempt.revision + 1,
        status,
        now,
        status === 'PRECOMMIT_FAILED' ? (input.revalidationRef?.resourceId ?? null) : null,
      );
      return yield* load(input.binding);
    });
  const commit = Effect.fn('OrderCommitment.commit')(function* commitOrder(
    input: CommitOrderInput,
    evidence?: ProofEvidence,
    pricingProof?: OrderPricingCommitProof,
  ) {
    const state = yield* load(input.binding, true);
    if (state.order !== null) {
      if (!sameRef(state.order.approvalProof.revalidationRef, input.revalidationRef)) {
        return yield* conflict();
      }
      return state;
    }
    if (evidence === undefined || pricingProof === undefined) {
      return yield* unavailable();
    }
    if (!pricingProofMatchesBundle(state, pricingProof)) {
      return yield* conflict();
    }
    const { proof } = evidence;
    const { finalBindingEvidence } = proof.evidence;
    if (finalBindingEvidence === undefined) {
      return yield* conflict();
    }
    if (!proofMatchesPreparedOrder(state, input, evidence, buyerPrincipalId)) {
      return yield* conflict();
    }
    // Read the real server clock after obtaining the row lock, never transaction-start now().
    const now = yield* DateTime.now;
    const { checkedAt, validUntil } = proof;
    const requestExpiry = evidence.request.expiresAt;
    if (
      DateTime.toEpochMillis(now) <
        Math.max(
          DateTime.toEpochMillis(checkedAt),
          DateTime.toEpochMillis(finalBindingEvidence.observedAt),
          DateTime.toEpochMillis(DateTime.makeUnsafe(pricingProof.confirmation.issuedAt)),
          DateTime.toEpochMillis(DateTime.makeUnsafe(pricingProof.verifiedAt)),
          DateTime.toEpochMillis(state.bundle.orderCommitmentTime),
        ) ||
      DateTime.toEpochMillis(now) >=
        Math.min(
          DateTime.toEpochMillis(validUntil),
          DateTime.toEpochMillis(requestExpiry),
          DateTime.toEpochMillis(state.bundle.proposal.expiresAt),
          DateTime.toEpochMillis(finalBindingEvidence.validUntil),
          DateTime.toEpochMillis(DateTime.makeUnsafe(pricingProof.confirmation.expiresAt)),
        )
    ) {
      return yield* rejected('order_commitment_ineligible', 'The approval proof has expired');
    }
    const orderRef = resourceRef('order', scope.tenantId, `order:${operationId}`);
    const consumptionIntent = `consume:${operationId}`;
    const order = {
      acceptedAt: state.bundle.orderCommitmentTime,
      approvalIssuer: evidence.issuer,
      approvalProof: proof,
      approvalRequestRef: state.bundle.approvalRequestRef,
      binding: input.binding,
      commitmentCorrelationId: state.attempt.commitmentCorrelationId,
      committedAt: now,
      consumptionIntent,
      consumptionStatus: 'PENDING' as const,
      orderRef,
      pricingProof,
    };
    const { consumptionStatus: _consumptionStatus, ...snapshot } = yield* Schema.encodeEffect(CommittedOrderSchema)(
      order,
    ).pipe(Effect.mapError(unavailable));
    const ownerScope = yield* scoped();
    yield* transaction
      .insert(committedOrders)
      .values({
        ...ownerScope,
        approvalRequestId: state.bundle.approvalRequestRef.resourceId,
        attemptId: input.binding.attemptRef.resourceId,
        orderId: orderRef.resourceId,
        snapshot,
      })
      .pipe(Effect.mapError(writeFailure));
    yield* transaction
      .insert(consumptionObligations)
      .values({ ...ownerScope, consumptionIntent, orderId: orderRef.resourceId })
      .pipe(Effect.mapError(unavailable));
    yield* updateAttempt(state, 'COMMITTED', now, orderRef.resourceId);
    yield* appendHistory(input.binding, state.attempt.revision + 1, 'COMMITTED', now, input.revalidationRef.resourceId);
    return yield* load(input.binding);
  });
  const completeConsumption = Effect.fn('OrderCommitment.completeConsumption')(function* completeOrderConsumption(
    binding: OrderFinalBinding,
    orderRef: OrderRef,
    consumptionIntent: string,
    receipt: ConsumeOrderPurchaseApprovalResult,
  ) {
    const state = yield* load(binding, true);
    if (
      state.order === null ||
      !sameRef(state.order.orderRef, orderRef) ||
      state.order.consumptionIntent !== consumptionIntent
    ) {
      return yield* conflict();
    }
    if (
      !approvalIssuerMatches(
        state.order.approvalIssuer,
        state.order.approvalProof.evidence.actorPrincipalId,
        state.bundle.buyerPrincipalId,
      )
    ) {
      return yield* conflict();
    }
    const { request } = receipt;
    const expected: ConsumptionCompletionIdentity = {
      binding,
      bundle: state.bundle,
      commitmentCorrelationId: state.attempt.commitmentCorrelationId,
      consumptionIntent,
      order: state.order,
      orderRef,
    };
    if (
      !consumedRequestMatchesCommit(request, expected) ||
      !consumedApprovalMatchesBundle(request, expected) ||
      !consumptionEvidenceMatchesCommit(request, expected)
    ) {
      return yield* conflict();
    }
    if (state.order.consumptionStatus === 'COMPLETE') {
      return state;
    }
    const ownerScope = yield* scoped();
    const now = yield* DateTime.now;
    yield* transaction
      .update(consumptionObligations)
      .set({ completedAt: DateTime.toDateUtc(now) })
      .where(
        and(
          eq(consumptionObligations.tenantId, ownerScope.tenantId),
          eq(consumptionObligations.legalEntityId, ownerScope.legalEntityId),
          eq(consumptionObligations.orderId, orderRef.resourceId),
          eq(consumptionObligations.consumptionIntent, consumptionIntent),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    yield* updateAttempt(state, 'COMMITTED', now, orderRef.resourceId);
    yield* appendHistory(
      binding,
      state.attempt.revision + 1,
      'APPROVAL_CONSUMED',
      now,
      state.order.approvalProof.revalidationRef.resourceId,
    );
    return yield* load(binding);
  });
  const verifyBinding = Effect.fn('OrderCommitment.verifyBinding')(function* verifyOrderBinding(
    input: VerifyOrderBindingInput,
  ) {
    const state = yield* load(input.binding);
    if (
      state.attempt.commitmentCorrelationId !== input.commitmentCorrelationId ||
      !sameRef(state.bundle.approvalRequestRef, input.requestRef) ||
      (input.mode === 'REVALIDATION' && state.bundle.proposal.canonicalHash !== input.proposalHash) ||
      !sameRef(state.bundle.proposal.proposalRevisionRef, input.proposalRevisionRef)
    ) {
      return yield* conflict();
    }
    if (
      input.mode === 'REVALIDATION'
        ? state.order !== null || !['READY', 'PRECOMMIT_FAILED'].includes(state.attempt.status)
        : state.order === null ||
          input.orderRef === undefined ||
          !sameRef(state.order.orderRef, input.orderRef) ||
          input.revalidationRef === undefined ||
          !sameRef(state.order.approvalProof.revalidationRef, input.revalidationRef)
    ) {
      return yield* conflict();
    }
    const now = yield* DateTime.now;
    return yield* Schema.decodeUnknownEffect(VerifiedOrderBindingSchema)({
      binding: input.binding,
      commitmentCorrelationId: state.attempt.commitmentCorrelationId,
      committedAt: state.order === null ? null : DateTime.formatIso(state.order.committedAt),
      observedAt: DateTime.formatIso(now),
      orderRef: state.order?.orderRef ?? null,
      provenance: 'commerce.order.durable-commitment.v1',
      revalidationRef: state.order?.approvalProof.revalidationRef ?? null,
      validUntil: DateTime.formatIso(DateTime.add(now, { seconds: 5 })),
    }).pipe(Effect.mapError(unavailable));
  });
  const intentWhere = (id: string) =>
    and(
      eq(finalizationIntents.tenantId, scope.tenantId),
      eq(finalizationIntents.legalEntityId, scope.legalEntityId ?? ''),
      eq(finalizationIntents.intentId, id),
    );
  const findIntent = Effect.fn('OrderCommitment.findIntent')(function* findIntent(ref: ResourceRef, lock = false) {
    yield* scoped();
    if (ref.moduleId !== orderModuleId || ref.tenantId !== scope.tenantId) {
      return yield* conflict();
    }
    const query = transaction.select().from(finalizationIntents).where(intentWhere(ref.resourceId));
    const [row] = yield* (lock === true ? query.for('update') : query).pipe(Effect.mapError(unavailable));
    if (row === undefined || !sameRef(ref, intentRef(row)) || (!service && row.buyerPrincipalId !== buyerPrincipalId)) {
      return yield* rejected('order_commitment_not_found', 'The original finalization intent was not found');
    }
    return row;
  });
  const originalIntent = Effect.fn('OrderCommitment.originalIntent')(function* originalIntent(
    stage: 'PREPARE' | 'PROOF',
    businessKey: string,
  ) {
    const ownerScope = yield* scoped();
    const [row] = yield* transaction
      .select()
      .from(finalizationIntents)
      .where(
        and(
          eq(finalizationIntents.tenantId, ownerScope.tenantId),
          eq(finalizationIntents.legalEntityId, ownerScope.legalEntityId),
          eq(finalizationIntents.buyerPrincipalId, buyerPrincipalId),
          eq(finalizationIntents.stage, stage),
          eq(finalizationIntents.businessKey, businessKey),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return Option.fromNullishOr(row);
  });
  const preparationProgress = Effect.fn('OrderCommitment.preparationProgress')(function* preparationProgress(
    row: typeof finalizationIntents.$inferSelect,
  ) {
    if (row.stage !== 'PREPARE') {
      return yield* conflict();
    }
    if (row.status === 'COMPLETE') {
      return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderPreparationProgressSchema))(row.result).pipe(
        Effect.mapError(unavailable),
      );
    }
    if (row.status === 'FAILED') {
      // Like a terminal proof request, the buyer sees only FAILED and starts a new
      // preparation with a fresh Quotation; the retained owner witness stays internal.
      yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderPreparationTerminalResultSchema))(row.result).pipe(
        Effect.mapError(unavailable),
      );
      return { binding: null, intentRef: intentRef(row), status: 'FAILED' as const };
    }
    return { binding: null, intentRef: intentRef(row), status: 'PREPARATION_PENDING' as const };
  });
  const proofProgress = Effect.fn('OrderCommitment.proofProgress')(function* proofProgress(
    row: typeof finalizationIntents.$inferSelect,
  ) {
    const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderProofIntentDataSchema))(row.data).pipe(
      Effect.mapError(unavailable),
    );
    if (row.stage !== 'PROOF') {
      return yield* conflict();
    }
    const [currentAttempt] = yield* transaction
      .select({ status: commitmentAttempts.status })
      .from(commitmentAttempts)
      .where(
        and(
          eq(commitmentAttempts.tenantId, row.tenantId),
          eq(commitmentAttempts.legalEntityId, row.legalEntityId),
          eq(commitmentAttempts.attemptId, row.attemptId ?? ''),
          eq(commitmentAttempts.buyerPrincipalId, row.buyerPrincipalId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (currentAttempt === undefined) {
      return yield* conflict();
    }
    if (currentAttempt.status === 'CANCELLED') {
      return {
        binding: data.binding,
        intentRef: intentRef(row),
        revalidationRef: null,
        status: 'CANCELLED' as const,
        validUntil: null,
      };
    }
    if (row.status === 'FAILED') {
      return {
        binding: data.binding,
        intentRef: intentRef(row),
        revalidationRef: null,
        status: 'FAILED' as const,
        validUntil: null,
      };
    }
    if (row.status !== 'COMPLETE') {
      return {
        binding: data.binding,
        intentRef: intentRef(row),
        revalidationRef: null,
        status: 'PROOFS_PENDING' as const,
        validUntil: null,
      };
    }
    const proof = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderRetainedProofSetSchema))(row.result).pipe(
      Effect.mapError(unavailable),
    );
    if (proof.approvalEvidence.operation !== 'VERIFY_PROOF') {
      return yield* conflict();
    }
    const until = DateTime.makeUnsafe(
      Math.min(
        DateTime.toEpochMillis(proof.approvalEvidence.request.expiresAt),
        DateTime.toEpochMillis(proof.approvalEvidence.proof.validUntil),
        DateTime.toEpochMillis(
          proof.approvalEvidence.proof.evidence.finalBindingEvidence?.validUntil ??
            proof.approvalEvidence.proof.validUntil,
        ),
        DateTime.toEpochMillis(proof.approvalEvidence.proposal.expiresAt),
        DateTime.toEpochMillis(DateTime.makeUnsafe(proof.pricingProof.confirmation.expiresAt)),
      ),
    );
    const now = yield* DateTime.now;
    return {
      binding: data.binding,
      intentRef: intentRef(row),
      revalidationRef: proof.approvalEvidence.proof.revalidationRef,
      status: DateTime.toEpochMillis(now) < DateTime.toEpochMillis(until) ? ('READY' as const) : ('EXPIRED' as const),
      validUntil: until,
    };
  });
  const requestPreparation = Effect.fn('OrderCommitment.requestPreparation')(function* requestPreparation(
    input: PrepareOrderCommitmentInput,
    evidence: LoadEvidence,
  ) {
    const existing = yield* originalIntent('PREPARE', input.commitmentCorrelationId);
    if (Option.isSome(existing)) {
      const retained = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderPreparationIntentDataSchema))(
        existing.value.data,
      ).pipe(Effect.mapError(unavailable));
      if (!Schema.toEquivalence(PrepareOrderCommitmentInputSchema)(retained.input, input)) {
        return yield* conflict();
      }
      return yield* preparationProgress(existing.value);
    }
    const ownerScope = yield* scoped();
    if (
      evidence.proposal.identity.buyer.principalId !== buyerPrincipalId ||
      !sameRef(evidence.candidateRef, input.candidateRef) ||
      evidence.candidateHash !== input.candidateHash
    ) {
      return yield* conflict();
    }
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(OrderPreparationIntentDataSchema))({
      evidence,
      input,
      work: { ...ownerScope, buyerPrincipalId, correlationId: input.commitmentCorrelationId },
    }).pipe(Effect.mapError(unavailable));
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(canonicalJson(data)).pipe(
      Effect.mapError(unavailable),
    );
    const row = {
      ...ownerScope,
      attemptId: null,
      businessKey: input.commitmentCorrelationId,
      buyerPrincipalId,
      data,
      inputHash: Hex.encode(sha256(utf8ToBytes(encoded))),
      intentId: `preparation:${operationId}`,
      proofRef: null,
      result: null,
      stage: 'PREPARE' as const,
      status: 'PENDING' as const,
    };
    yield* transaction.insert(finalizationIntents).values(row).pipe(Effect.mapError(writeFailure));
    return yield* preparationProgress(row);
  });
  const requestProof = Effect.fn('OrderCommitment.requestProof')(function* requestProof(input: {
    readonly binding: OrderFinalBinding;
    readonly idempotencyKey: string;
  }) {
    const { existing, state } = yield* Effect.all(
      { existing: originalIntent('PROOF', input.idempotencyKey), state: load(input.binding, true) },
      { concurrency: 1 },
    );
    if (Option.isSome(existing)) {
      const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderProofIntentDataSchema))(
        existing.value.data,
      ).pipe(Effect.mapError(unavailable));
      if (!sameOrderBinding(data.binding, input.binding)) {
        return yield* conflict();
      }
      return yield* proofProgress(existing.value);
    }
    if (state.order !== null || !['READY', 'PRECOMMIT_FAILED'].includes(state.attempt.status)) {
      return yield* conflict();
    }
    const prior = yield* transaction
      .select()
      .from(finalizationIntents)
      .where(
        and(
          eq(finalizationIntents.tenantId, scope.tenantId),
          eq(finalizationIntents.legalEntityId, scope.legalEntityId ?? ''),
          eq(finalizationIntents.attemptId, input.binding.attemptRef.resourceId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    // A pending/uncertain original side effect is never replaced with another key.
    if (
      prior.some((row) => row.status === 'PENDING') ||
      (prior.length > 0 && state.attempt.status !== 'PRECOMMIT_FAILED')
    ) {
      return yield* conflict();
    }
    const now = yield* DateTime.now;
    // Proof work for an expired proposal or Quotation could only fail; it is never enqueued.
    if (
      DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(state.bundle.proposal.expiresAt) ||
      DateTime.toEpochMillis(now) >=
        DateTime.toEpochMillis(DateTime.makeUnsafe(state.bundle.finalization.pricing.quotation.validity.validUntil))
    ) {
      return yield* conflict();
    }
    const ownerScope = yield* scoped();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(OrderProofIntentDataSchema))({
      binding: input.binding,
      expectedRevision: state.attempt.revision,
      idempotencyKey: input.idempotencyKey,
      work: { ...ownerScope, buyerPrincipalId, correlationId: state.attempt.commitmentCorrelationId },
    }).pipe(Effect.mapError(unavailable));
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(canonicalJson(data)).pipe(
      Effect.mapError(unavailable),
    );
    const row = {
      ...ownerScope,
      attemptId: input.binding.attemptRef.resourceId,
      businessKey: input.idempotencyKey,
      buyerPrincipalId,
      data,
      inputHash: Hex.encode(sha256(utf8ToBytes(encoded))),
      intentId: `proof:${operationId}`,
      proofRef: null,
      result: null,
      stage: 'PROOF' as const,
      status: 'PENDING' as const,
    };
    yield* transaction.insert(finalizationIntents).values(row).pipe(Effect.mapError(writeFailure));
    return yield* proofProgress(row);
  });
  const completeIntent = Effect.fn('OrderCommitment.completeIntent')(function* completeIntent(
    row: typeof finalizationIntents.$inferSelect,
    result: Schema.Json,
    proofRef: string | null = null,
    status: 'COMPLETE' | 'FAILED' = 'COMPLETE',
  ) {
    if (!service || row.status !== 'PENDING') {
      return yield* conflict();
    }
    const changed = yield* transaction
      .update(finalizationIntents)
      .set({ proofRef, result, status })
      .where(
        and(
          intentWhere(row.intentId),
          eq(finalizationIntents.status, 'PENDING'),
          eq(finalizationIntents.inputHash, row.inputHash),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (changed.length !== 1) {
      return yield* conflict();
    }
    return Option.fromNullishOr(changed[0]);
  });
  const assertNoPendingProof = Effect.fn('OrderCommitment.assertNoPendingProof')(function* assertNoPendingProof(
    binding: OrderFinalBinding,
  ) {
    yield* load(binding, true);
    const pending = yield* transaction
      .select({ intentId: finalizationIntents.intentId })
      .from(finalizationIntents)
      .where(
        and(
          eq(finalizationIntents.tenantId, scope.tenantId),
          eq(finalizationIntents.legalEntityId, scope.legalEntityId ?? ''),
          eq(finalizationIntents.attemptId, binding.attemptRef.resourceId),
          eq(finalizationIntents.status, 'PENDING'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (pending.length > 0) {
      return yield* rejected(
        'order_commitment_ineligible',
        'The original proof request is still unresolved; recover it before recording a precommit failure',
      );
    }
    return yield* Effect.void;
  });
  const retainedProof = Effect.fn('OrderCommitment.retainedProof')(function* retainedProof(input: CommitOrderInput) {
    const retainedRows = transaction
      .select()
      .from(finalizationIntents)
      .where(
        and(
          eq(finalizationIntents.tenantId, scope.tenantId),
          eq(finalizationIntents.legalEntityId, scope.legalEntityId ?? ''),
          eq(finalizationIntents.buyerPrincipalId, buyerPrincipalId),
          eq(finalizationIntents.attemptId, input.binding.attemptRef.resourceId),
          eq(finalizationIntents.proofRef, input.revalidationRef.resourceId),
          eq(finalizationIntents.status, 'COMPLETE'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const {
      rows: [row],
      state,
    } = yield* Effect.all({ rows: retainedRows, state: load(input.binding, true) }, { concurrency: 1 });
    if (row === undefined) {
      return yield* conflict();
    }
    const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderProofIntentDataSchema))(row.data).pipe(
      Effect.mapError(unavailable),
    );
    if (
      data.expectedRevision !== input.expectedRevision ||
      state.attempt.revision !== input.expectedRevision ||
      !sameOrderBinding(data.binding, input.binding)
    ) {
      return yield* conflict();
    }
    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OrderRetainedProofSetSchema))(row.result).pipe(
      Effect.mapError(unavailable),
    );
  });
  const loadOrderForService = Effect.fn('OrderCommitment.loadOrderForService')(function* loadOrderForService(
    ref: ResourceRef,
  ) {
    const ownerScope = yield* scoped();
    if (
      !service ||
      ref.resourceType !== 'commerce.order.order' ||
      ref.moduleId !== orderModuleId ||
      ref.tenantId !== scope.tenantId
    ) {
      return yield* conflict();
    }
    const [row] = yield* transaction
      .select()
      .from(committedOrders)
      .where(
        and(
          eq(committedOrders.tenantId, ownerScope.tenantId),
          eq(committedOrders.legalEntityId, ownerScope.legalEntityId),
          eq(committedOrders.orderId, ref.resourceId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* rejected('order_commitment_not_found', 'Order was not found');
    }
    const order = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CommittedOrderSchema))({
      ...row.snapshot,
      consumptionStatus: 'PENDING',
    }).pipe(Effect.mapError(unavailable));
    const [attempt] = yield* transaction
      .select()
      .from(commitmentAttempts)
      .where(
        and(
          eq(commitmentAttempts.tenantId, ownerScope.tenantId),
          eq(commitmentAttempts.legalEntityId, ownerScope.legalEntityId),
          eq(commitmentAttempts.attemptId, row.attemptId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (attempt === undefined) {
      return yield* conflict();
    }
    return yield* loadForBuyer(order.binding, attempt.buyerPrincipalId);
  });
  return {
    assertNoPendingProof,
    cancel: transition('CANCELLED'),
    commit,
    completeConsumption,
    completeIntent,
    findIntent,
    intentRef,
    load,
    loadCommittedApprovalEvidence,
    loadOrderForService,
    loadPreparedForVerifier,
    markPrecommitFailure: transition('PRECOMMIT_FAILED'),
    originalIntent,
    preparationProgress,
    prepare,
    proofProgress,
    replayPreparation,
    requestPreparation,
    requestProof,
    retainedProof,
    verifyBinding,
  };
};
