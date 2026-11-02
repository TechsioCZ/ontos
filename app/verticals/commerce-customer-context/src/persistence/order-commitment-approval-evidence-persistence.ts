import { defineScopedRoutine, ReadHandlerNotFound, ReadHandlerUnavailable, ReadPolicyDenied } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import {
  OrderCommitmentApprovalEvidenceRequestSchema,
  OrderCommitmentApprovalEvidenceResponseSchema,
} from '../../shared/apis/order-commitment-approval-evidence.ts';
import type {
  OrderCommitmentApprovalProofSchema,
  OrderCommitmentApprovalRequestSnapshotSchema,
  OrderCommitmentApprovalEvidenceRequest,
  OrderCommitmentApprovalEvidenceResponse,
} from '../../shared/apis/order-commitment-approval-evidence.ts';
import { computePurchaseProposalCanonicalHash } from '../../shared/domain/purchasing-approval.ts';
import type {
  PurchaseApprovalFinalBinding,
  PurchaseProposalRevisionSchema,
} from '../../shared/domain/purchasing-approval.ts';

type RequestSnapshot = typeof OrderCommitmentApprovalRequestSnapshotSchema.Type;
type Proposal = typeof PurchaseProposalRevisionSchema.Type;
type Proof = typeof OrderCommitmentApprovalProofSchema.Type;
type EvidenceReadFailure = ReadHandlerNotFound | ReadHandlerUnavailable | ReadPolicyDenied;
export interface OrderCommitmentApprovalEvidenceServices {
  readonly read: (
    input: OrderCommitmentApprovalEvidenceRequest,
  ) => Effect.Effect<OrderCommitmentApprovalEvidenceResponse, EvidenceReadFailure>;
}

const missing = () =>
  new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'Approval evidence is unavailable' });
const unavailable = (cause: unknown) => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Approval evidence could not be verified',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId;
const sameBinding = (left: PurchaseApprovalFinalBinding, right: PurchaseApprovalFinalBinding): boolean =>
  sameRef(left.attemptRef, right.attemptRef) &&
  sameRef(left.bundleRef, right.bundleRef) &&
  left.bundleHash === right.bundleHash &&
  left.bundleVersion === right.bundleVersion;

/** The permission target is caller input; compare it with durable owner facts before returning any record. */
export const approvalEvidenceMatchesTrustedScope = (
  input: OrderCommitmentApprovalEvidenceRequest,
  scope: Pick<OperationalScope, 'tenantId' | 'legalEntityId' | 'principalId' | 'trustedStorefrontId'>,
  request: RequestSnapshot,
  proposal: Proposal,
): boolean =>
  scope.legalEntityId !== undefined &&
  input.requestRef.tenantId === scope.tenantId &&
  input.counterpartyRef.tenantId === scope.tenantId &&
  sameRef(input.requestRef, request.requestRef) &&
  sameRef(input.counterpartyRef, proposal.identity.counterpartyRef) &&
  sameRef(request.proposal.proposalRevisionRef, proposal.proposalRevisionRef) &&
  request.proposal.revision === proposal.revision &&
  request.proposal.state === proposal.state &&
  request.proposal.canonicalHash === proposal.canonicalHash &&
  computePurchaseProposalCanonicalHash(proposal) === proposal.canonicalHash &&
  computePurchaseProposalCanonicalHash(request.proposal) === proposal.canonicalHash &&
  proposal.proposalRevisionRef.tenantId === scope.tenantId &&
  proposal.context.tenantId === scope.tenantId &&
  proposal.context.sellingLegalEntityId === scope.legalEntityId &&
  proposal.identity.buyer.tenantId === scope.tenantId &&
  proposal.identity.buyer.principalId === scope.principalId &&
  proposal.context.storefrontId === input.storefrontId &&
  (scope.trustedStorefrontId === undefined || scope.trustedStorefrontId === input.storefrontId);

const proofMatchesRequestLifecycle = (
  binding: PurchaseApprovalFinalBinding,
  request: RequestSnapshot,
  proof: Proof,
): boolean =>
  request.status === 'APPROVED'
    ? proof.evidence.requestRevision === request.requestRevision
    : request.status === 'CONSUMED' &&
      proof.evidence.requestRevision !== undefined &&
      proof.evidence.requestRevision + 1 === request.requestRevision &&
      request.consumptionProofRef !== undefined &&
      sameRef(request.consumptionProofRef, proof.revalidationRef) &&
      request.consumptionFinalBinding !== undefined &&
      sameBinding(request.consumptionFinalBinding, binding);

export const approvalProofMatchesRetainedRequest = (
  input: Extract<OrderCommitmentApprovalEvidenceRequest, { readonly operation: 'VERIFY_PROOF' }>,
  request: RequestSnapshot,
  proposal: Proposal,
  proof: Proof,
  principalId: string,
): boolean =>
  sameRef(proof.revalidationRef, input.revalidationRef) &&
  sameRef(proof.requestRef, request.requestRef) &&
  sameRef(proof.proposalRevisionRef, proposal.proposalRevisionRef) &&
  proof.status === 'APPROVAL_VALID' &&
  proof.evidence.actorPrincipalId === principalId &&
  proof.evidence.proposalHash === proposal.canonicalHash &&
  proof.evidence.decisionBundleHash === request.decisionBundleHash &&
  proof.evidence.decisionBundleVersion === request.decisionBundleVersion &&
  request.lastDecisionRef !== null &&
  sameRef(proof.evidence.decisionRef, request.lastDecisionRef) &&
  sameRef(proof.evidence.routeRef, request.route.routeRef) &&
  sameRef(proof.evidence.hierarchyRef, request.route.hierarchyRef) &&
  proof.evidence.finalBindingEvidence !== undefined &&
  sameBinding(proof.evidence.finalBindingEvidence.binding, input.finalBinding) &&
  proofMatchesRequestLifecycle(input.finalBinding, request, proof);

const recoveryConflict = () =>
  new ReadPolicyDenied({
    code: 'read_policy_denied',
    httpStatus: 409,
    policyReasonCode: 'APPROVAL_REVALIDATION_INTENT_CONFLICT',
    reason: 'The original approval revalidation intent does not match the retained evidence',
  });

const recoverEvidenceRoutine = defineScopedRoutine({
  name: 'recover_buyer_approval_revalidation',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ result: Schema.Json }),
  routineKey: 'purchasing-approval.recover-buyer-revalidation',
  schema: 'commerce_customer_context',
});

const readEvidenceRoutine = defineScopedRoutine({
  name: 'read_order_commitment_approval_evidence',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ result: Schema.Json }),
  routineKey: 'purchasing-approval.read-order-commitment-evidence',
  schema: 'commerce_customer_context',
});

/** Only the Core-owned read factory receives this transaction. Handlers get the closed reader. */
export const orderCommitmentApprovalEvidenceServices = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): Effect.Effect<OrderCommitmentApprovalEvidenceServices> =>
  Effect.succeed({
    read: Effect.fn('OrderCommitmentApprovalEvidence.read')(function* readOrderCommitmentApprovalEvidence(
      input: OrderCommitmentApprovalEvidenceRequest,
    ) {
      if (
        scope.legalEntityId === undefined ||
        input.requestRef.tenantId !== scope.tenantId ||
        input.counterpartyRef.tenantId !== scope.tenantId
      ) {
        return yield* missing();
      }
      const encoded = yield* Schema.encodeEffect(OrderCommitmentApprovalEvidenceRequestSchema)(input).pipe(
        Effect.mapError(unavailable),
      );
      const payload =
        scope.trustedStorefrontId === undefined
          ? { ...encoded, actorPrincipalId: scope.principalId }
          : { ...encoded, actorPrincipalId: scope.principalId, trustedStorefrontId: scope.trustedStorefrontId };
      const routine = input.operation === 'RECOVER_REVALIDATION' ? recoverEvidenceRoutine : readEvidenceRoutine;
      const [row] = yield* transaction.invoke(routine, [payload]).pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* missing();
      }
      if (
        input.operation === 'RECOVER_REVALIDATION' &&
        Schema.is(Schema.Struct({ recovery: Schema.Literal('CONFLICT') }))(row.result)
      ) {
        return yield* recoveryConflict();
      }
      const result = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceResponseSchema)(row.result).pipe(
        Effect.mapError(unavailable),
      );
      if (result.operation === 'RECOVER_REVALIDATION') {
        if (input.operation !== 'RECOVER_REVALIDATION') {
          return yield* unavailable('Unexpected recovery operation');
        }
        if (result.recovery === 'NOT_FOUND') {
          return result;
        }
        const proof = result.result.revalidation;
        if (
          !approvalEvidenceMatchesTrustedScope(input, scope, result.request, result.proposal) ||
          !approvalProofMatchesRetainedRequest(
            { ...input, operation: 'VERIFY_PROOF', revalidationRef: proof.revalidationRef },
            result.request,
            result.proposal,
            proof,
            scope.principalId,
          ) ||
          proof.evidence.commitmentCorrelationId !== input.commitmentCorrelationId
        ) {
          return yield* recoveryConflict();
        }
        return result;
      }
      if (
        result.operation !== input.operation ||
        !approvalEvidenceMatchesTrustedScope(input, scope, result.request, result.proposal)
      ) {
        return yield* missing();
      }
      if (
        input.operation === 'VERIFY_PROOF' &&
        (result.operation !== 'VERIFY_PROOF' ||
          !approvalProofMatchesRetainedRequest(input, result.request, result.proposal, result.proof, scope.principalId))
      ) {
        return yield* missing();
      }
      return result;
    }),
  });
