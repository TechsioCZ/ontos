import type { OrderFinalizationContext } from '../../shared/domain/order-finalization-evidence.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import {
  OrderServiceApprovalEvidenceRequestSchema,
  OrderServiceApprovalEvidencePolicyConflictProblemSchema,
} from '@app/commerce-customer-context/api/order-service-approval-evidence';
import type {
  OrderServiceApprovalTerminalWitness,
  OrderServiceApprovalEvidenceResponse,
} from '@app/commerce-customer-context/api/order-service-approval-evidence';
import { executeOrderServiceApprovalEvidenceWithAuthorization } from '@app/commerce-customer-context/api/order-service-approval-evidence/client';
import {
  RevalidateOrderPurchaseApprovalPayloadSchema,
  RevalidateOrderPurchaseApprovalActionConflictProblemSchema,
} from '@app/commerce-customer-context/api/revalidate-order-purchase-approval-action';
import { executeRevalidateOrderPurchaseApprovalWithAuthorization } from '@app/commerce-customer-context/api/revalidate-order-purchase-approval-action/client';
import {
  ConsumeOrderPurchaseApprovalPayloadSchema,
  ConsumeOrderPurchaseApprovalResultSchema,
  ConsumeOrderPurchaseApprovalActionConflictProblemSchema,
} from '@app/commerce-customer-context/api/consume-order-purchase-approval-action';
import { executeConsumeOrderPurchaseApprovalWithAuthorization } from '@app/commerce-customer-context/api/consume-order-purchase-approval-action/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Clock, Config, Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import type { OrderCommitmentState, PrepareOrderCommitmentInput } from '../../shared/domain/order-commitment.ts';

type ConsumePurchaseApprovalResult = Effect.Success<
  ReturnType<typeof executeConsumeOrderPurchaseApprovalWithAuthorization>
>;
type RevalidationResult = Effect.Success<ReturnType<typeof executeRevalidateOrderPurchaseApprovalWithAuthorization>>;
export type RevalidationRecoveryOutcome =
  | { readonly kind: 'VALID'; readonly result: RevalidationResult }
  | { readonly kind: 'TERMINAL'; readonly witness: OrderServiceApprovalTerminalWitness };
type ApprovalGatewayScope = OrderFinalizationContext;
type ProposalEvidence = Extract<OrderServiceApprovalEvidenceResponse, { readonly operation: 'LOAD_PROPOSAL' }>;
type ProofEvidence = Extract<OrderServiceApprovalEvidenceResponse, { readonly operation: 'VERIFY_PROOF' }>;
interface ProofLookup {
  readonly revalidationRef: RefFacts;
}
export interface ApprovalOwnerGatewayService {
  readonly consume: (
    state: OrderCommitmentState,
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<ConsumePurchaseApprovalResult, OrderCommitmentRejected>;
  readonly loadProposal: (
    input: PrepareOrderCommitmentInput,
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<ProposalEvidence, OrderCommitmentRejected>;
  readonly recoverConsumption: (
    state: OrderCommitmentState,
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<Option.Option<ConsumePurchaseApprovalResult>, OrderCommitmentRejected>;
  readonly recoverRevalidation: (
    state: OrderCommitmentState,
    input: { readonly idempotencyKey: string },
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<Option.Option<RevalidationResult>, OrderCommitmentRejected>;
  readonly recoverRevalidationOutcome: (
    state: OrderCommitmentState,
    input: { readonly idempotencyKey: string },
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<Option.Option<RevalidationRecoveryOutcome>, OrderCommitmentRejected>;
  readonly revalidate: (
    state: OrderCommitmentState,
    input: { readonly idempotencyKey: string },
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<RevalidationResult, OrderCommitmentRejected>;
  readonly revalidateOutcome: (
    state: OrderCommitmentState,
    input: { readonly idempotencyKey: string },
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<RevalidationRecoveryOutcome, OrderCommitmentRejected>;
  readonly verifyProof: (
    state: OrderCommitmentState,
    input: ProofLookup,
    scope: ApprovalGatewayScope,
  ) => Effect.Effect<ProofEvidence, OrderCommitmentRejected>;
}
export class ApprovalOwnerGateway extends Context.Service<ApprovalOwnerGateway, ApprovalOwnerGatewayService>()(
  '@app/commerce-order/services/approval-owner-gateway/ApprovalOwnerGateway',
) {}
const unavailable = (cause: unknown = 'Gateway configuration is unavailable') => {
  const failure = new OrderCommitmentRejected({
    code: 'order_commitment_unavailable',
    reason: 'The approval owner cannot currently verify the exact Order commitment',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const conflict = () =>
  new OrderCommitmentRejected({
    code: 'order_commitment_conflict',
    reason: 'The durable Order commitment does not match the requested approval operation',
  });
// Published exact-intent conflicts remain conflicts across the Order boundary.
// Transport, decoding and indeterminate owner observations remain unavailable.
const recoveryFailure = (cause: unknown) =>
  Schema.is(OrderServiceApprovalEvidencePolicyConflictProblemSchema)(cause) ||
  Schema.is(RevalidateOrderPurchaseApprovalActionConflictProblemSchema)(cause) ||
  Schema.is(ConsumeOrderPurchaseApprovalActionConflictProblemSchema)(cause)
    ? conflict()
    : unavailable(cause);
export const sameRef = (
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
) =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId;
interface RefFacts {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
interface BindingFacts {
  readonly attemptRef: RefFacts;
  readonly bundleHash: string;
  readonly bundleRef: RefFacts;
  readonly bundleVersion: string;
}
const sameBinding = (candidate: BindingFacts, expected: BindingFacts) =>
  sameRef(candidate.attemptRef, expected.attemptRef) &&
  sameRef(candidate.bundleRef, expected.bundleRef) &&
  candidate.bundleHash === expected.bundleHash &&
  candidate.bundleVersion === expected.bundleVersion;
const isRevalidationAdmissible = (state: OrderCommitmentState, scope: ApprovalGatewayScope) =>
  state.order === null &&
  (state.attempt.status === 'READY' || state.attempt.status === 'PRECOMMIT_FAILED') &&
  state.bundle.buyerPrincipalId === scope.buyerPrincipalId &&
  state.bundle.legalEntityId === scope.legalEntityId &&
  state.bundle.bundleRef.tenantId === scope.tenantId;
// Only a valid, exactly bound owner revalidation may be retained or consumed.
const isExactValidRevalidation = (state: OrderCommitmentState, result: RevalidationResult) => {
  const { revalidation } = result;
  const binding = revalidation.evidence.finalBindingEvidence?.binding;
  return (
    result.outcome === 'APPROVAL_VALID' &&
    revalidation.status === 'APPROVAL_VALID' &&
    sameRef(revalidation.requestRef, state.bundle.approvalRequestRef) &&
    sameRef(revalidation.proposalRevisionRef, state.bundle.proposal.proposalRevisionRef) &&
    revalidation.evidence.proposalHash === state.bundle.proposal.canonicalHash &&
    revalidation.evidence.commitmentCorrelationId === state.attempt.commitmentCorrelationId &&
    revalidation.evidence.decisionBundleHash === state.bundle.approvalDecisionBundleHash &&
    revalidation.evidence.decisionBundleVersion === state.bundle.approvalDecisionBundleVersion &&
    binding !== undefined &&
    sameBinding(binding, state.attempt.binding)
  );
};
const isTerminalWitnessRequestExact = (
  state: OrderCommitmentState,
  scope: ApprovalGatewayScope,
  witness: OrderServiceApprovalTerminalWitness,
  now: number,
) =>
  sameRef(witness.requestRef, state.bundle.approvalRequestRef) &&
  sameRef(witness.request.requestRef, state.bundle.approvalRequestRef) &&
  sameRef(witness.request.proposal.proposalRevisionRef, state.bundle.proposal.proposalRevisionRef) &&
  witness.request.proposal.canonicalHash === state.bundle.proposal.canonicalHash &&
  witness.request.proposal.identity.buyer.principalId === scope.buyerPrincipalId &&
  witness.request.proposal.identity.buyer.tenantId === scope.tenantId &&
  witness.request.proposal.context.sellingLegalEntityId === scope.legalEntityId &&
  witness.request.committedOrderRef === null &&
  witness.request.status !== 'CONSUMED' &&
  (witness.request.status === witness.terminalStatus ||
    (witness.request.status === 'APPROVED' &&
      witness.terminalStatus === 'EXPIRED' &&
      DateTime.toEpochMillis(witness.request.expiresAt) <= DateTime.toEpochMillis(witness.observedAt))) &&
  DateTime.toEpochMillis(witness.observedAt) <= now &&
  now - DateTime.toEpochMillis(witness.observedAt) <= 30_000;
const isTerminalWitnessOriginalExact = (state: OrderCommitmentState, witness: OrderServiceApprovalTerminalWitness) => {
  if (Option.isNone(witness.originalProof)) {
    return true;
  }
  const original = witness.originalProof.value;
  const originalBinding = original.evidence.finalBindingEvidence?.binding;
  return (
    sameRef(original.requestRef, state.bundle.approvalRequestRef) &&
    sameRef(original.proposalRevisionRef, state.bundle.proposal.proposalRevisionRef) &&
    original.evidence.proposalHash === state.bundle.proposal.canonicalHash &&
    original.evidence.commitmentCorrelationId === state.attempt.commitmentCorrelationId &&
    original.evidence.decisionBundleHash === state.bundle.approvalDecisionBundleHash &&
    original.evidence.decisionBundleVersion === state.bundle.approvalDecisionBundleVersion &&
    originalBinding !== undefined &&
    sameBinding(originalBinding, witness.finalBinding)
  );
};
const isTerminalWitnessExact = (
  state: OrderCommitmentState,
  scope: ApprovalGatewayScope,
  witness: OrderServiceApprovalTerminalWitness,
  idempotencyKey: string,
  now: number,
) =>
  isTerminalWitnessRequestExact(state, scope, witness, now) &&
  sameRef(witness.candidateRef, state.bundle.finalization.cart.candidateRef) &&
  witness.candidateHash === state.bundle.finalization.cart.candidateHash &&
  witness.idempotencyKey === idempotencyKey &&
  witness.commitmentCorrelationId === state.attempt.commitmentCorrelationId &&
  sameBinding(witness.finalBinding, state.attempt.binding) &&
  isTerminalWitnessOriginalExact(state, witness);
const isRetainedConsumptionExact = (
  state: OrderCommitmentState,
  order: NonNullable<OrderCommitmentState['order']>,
  request: ProposalEvidence['request'],
) => {
  const binding = request.consumptionFinalBinding;
  const consumed = request.consumptionEvidence;
  return (
    request.status === 'CONSUMED' &&
    request.committedOrderRef !== null &&
    sameRef(request.committedOrderRef, order.orderRef) &&
    request.consumptionIdempotencyKey === order.consumptionIntent &&
    request.consumptionCommitmentId === state.attempt.commitmentCorrelationId &&
    request.consumptionProofRef !== undefined &&
    sameRef(request.consumptionProofRef, order.approvalProof.revalidationRef) &&
    binding !== undefined &&
    sameBinding(binding, order.binding) &&
    consumed !== undefined &&
    consumed.idempotencyKey === order.consumptionIntent &&
    sameRef(consumed.orderRef, order.orderRef) &&
    DateTime.toEpochMillis(consumed.committedAt) === DateTime.toEpochMillis(order.committedAt)
  );
};
// A missing recovery fails with the supplied failure; a retained one resolves the debt.
const requireRecovered = <A>(
  recovery: Effect.Effect<Option.Option<A>, OrderCommitmentRejected>,
  failure: OrderCommitmentRejected,
) =>
  recovery.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(failure),
        onSome: Effect.succeed,
      }),
    ),
  );
// Owner conflicts stay conflicts; any other owner failure is resolved by exact retained recovery.
const recoverAfterOwnerFailure = <A>(
  failure: OrderCommitmentRejected,
  recovery: Effect.Effect<Option.Option<A>, OrderCommitmentRejected>,
) => (failure.code === 'order_commitment_conflict' ? Effect.fail(conflict()) : requireRecovered(recovery, failure));
const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'A trusted HTTP(S) gateway URL is required',
  ),
);
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_ORDER_APPROVAL_GATEWAY_API_KEY'),
  ownerBaseUrl: Config.schema(httpUrl, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

export const ApprovalOwnerGatewayLive = Layer.effect(
  ApprovalOwnerGateway,
  Effect.gen(function* approvalOwnerGatewayLayer() {
    const composition = yield* ActiveApplicationCompositionService;
    const configured = yield* configuration.pipe(Effect.match({ onFailure: Option.none, onSuccess: Option.some }));
    const credential = Effect.fn('ApprovalOwnerGateway.credential')(function* credential(scope: ApprovalGatewayScope) {
      if (Option.isNone(configured)) {
        return yield* unavailable();
      }
      const active = yield* composition.load.pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.mapError(unavailable),
      );
      const assertion = yield* issueApiKeyGatewayContext(
        {
          audience: 'commerce-customer-context',
          compositionRevision: active.composition.revision,
          legalEntityId: scope.legalEntityId,
        },
        {
          apiKey: configured.value.apiKey,
          baseUrl: configured.value.shellBaseUrl,
          requestCorrelation: scope.correlationId,
        },
      ).pipe(Effect.mapError(unavailable));
      if (
        assertion.compositionRevision !== active.composition.revision ||
        assertion.expiresAt * 1000 <= (yield* Clock.currentTimeMillis)
      ) {
        return yield* unavailable('Shell returned an expired or mismatched gateway credential');
      }
      return {
        authorization: `Bearer ${assertion.token}`,
        baseUrl: configured.value.ownerBaseUrl,
        compositionRevision: active.composition.revision,
      };
    });
    const recoverRevalidationOutcome = Effect.fn('ApprovalOwnerGateway.recoverRevalidationOutcome')(
      function* recoverRevalidationOutcome(
        state: OrderCommitmentState,
        idempotencyKey: string,
        scope: ApprovalGatewayScope,
      ) {
        const auth = yield* credential(scope);
        const payload = yield* Schema.decodeUnknownEffect(Schema.toType(OrderServiceApprovalEvidenceRequestSchema))({
          candidateHash: state.bundle.finalization.cart.candidateHash,
          candidateRef: state.bundle.finalization.cart.candidateRef,
          commitmentCorrelationId: state.attempt.commitmentCorrelationId,
          finalBinding: state.attempt.binding,
          idempotencyKey,
          operation: 'RECOVER_REVALIDATION',
          requestRef: state.bundle.approvalRequestRef,
        }).pipe(Effect.mapError(unavailable));
        const response = yield* executeOrderServiceApprovalEvidenceWithAuthorization(
          payload,
          auth.authorization,
          scope.correlationId,
          auth,
        ).pipe(Effect.mapError(recoveryFailure));
        if (
          response.operation !== 'RECOVER_REVALIDATION' ||
          !sameRef(response.candidateRef, state.bundle.finalization.cart.candidateRef) ||
          response.candidateHash !== state.bundle.finalization.cart.candidateHash
        ) {
          return yield* conflict();
        }
        if (response.recovery === 'NOT_FOUND') {
          return Option.none<RevalidationRecoveryOutcome>();
        }
        if (response.recovery === 'REQUEST_TERMINAL') {
          const { witness } = response;
          const now = yield* Clock.currentTimeMillis;
          if (!isTerminalWitnessExact(state, scope, witness, idempotencyKey, now)) {
            return yield* conflict();
          }
          return Option.some<RevalidationRecoveryOutcome>({ kind: 'TERMINAL', witness });
        }
        if (!isExactValidRevalidation(state, response.result)) {
          return yield* conflict();
        }
        return Option.some<RevalidationRecoveryOutcome>({ kind: 'VALID', result: response.result });
      },
    );
    const recoverRevalidation = Effect.fn('ApprovalOwnerGateway.recoverValidRevalidation')(
      function* recoverRevalidation(state: OrderCommitmentState, idempotencyKey: string, scope: ApprovalGatewayScope) {
        const retained = yield* recoverRevalidationOutcome(state, idempotencyKey, scope);
        if (Option.isNone(retained)) {
          return Option.none<RevalidationResult>();
        }
        if (retained.value.kind === 'TERMINAL') {
          return yield* new OrderCommitmentRejected({
            code: 'order_commitment_ineligible',
            reason: 'The original approval request is terminal',
          });
        }
        return Option.some(retained.value.result);
      },
    );
    const recoverConsumption = Effect.fn('ApprovalOwnerGateway.recoverConsumption')(function* recoverConsumption(
      state: OrderCommitmentState,
      scope: ApprovalGatewayScope,
    ) {
      const { order } = state;
      if (order === null) {
        return yield* conflict();
      }
      const auth = yield* credential(scope);
      const payload = yield* Schema.decodeUnknownEffect(Schema.toType(OrderServiceApprovalEvidenceRequestSchema))({
        candidateHash: state.bundle.finalization.cart.candidateHash,
        candidateRef: state.bundle.finalization.cart.candidateRef,
        operation: 'LOAD_PROPOSAL',
        requestRef: state.bundle.approvalRequestRef,
      }).pipe(Effect.mapError(unavailable));
      const response = yield* executeOrderServiceApprovalEvidenceWithAuthorization(
        payload,
        auth.authorization,
        scope.correlationId,
        auth,
      ).pipe(Effect.mapError(recoveryFailure));
      if (
        response.operation !== 'LOAD_PROPOSAL' ||
        !sameRef(response.candidateRef, state.bundle.finalization.cart.candidateRef) ||
        response.candidateHash !== state.bundle.finalization.cart.candidateHash ||
        !sameRef(response.request.requestRef, state.bundle.approvalRequestRef) ||
        response.proposal.canonicalHash !== state.bundle.proposal.canonicalHash
      ) {
        return yield* conflict();
      }
      const { request } = response;
      if (request.status === 'APPROVED') {
        return Option.none<ConsumePurchaseApprovalResult>();
      }
      if (!isRetainedConsumptionExact(state, order, request)) {
        return yield* conflict();
      }
      // A retained exact consumption receipt resolves durable debt without another write.
      // The persistence completion gate independently checks every receipt field.
      return yield* Schema.decodeEffect(Schema.toType(ConsumeOrderPurchaseApprovalResultSchema))({
        outcome: 'ALREADY_CONSUMED',
        request,
      }).pipe(Effect.mapError(unavailable), Effect.map(Option.some));
    });
    const issueOriginalRevalidation = Effect.fn('ApprovalOwnerGateway.issueOriginalRevalidation')(
      function* issueOriginalRevalidation(
        state: OrderCommitmentState,
        payload: Parameters<typeof executeRevalidateOrderPurchaseApprovalWithAuthorization>[0],
        idempotencyKey: string,
        scope: ApprovalGatewayScope,
      ) {
        const auth = yield* credential(scope);
        return yield* executeRevalidateOrderPurchaseApprovalWithAuthorization(
          payload,
          auth.authorization,
          scope.correlationId,
          { ...auth, idempotencyKey },
        ).pipe(
          Effect.catch((error) =>
            recoverAfterOwnerFailure(recoveryFailure(error), recoverRevalidation(state, idempotencyKey, scope)),
          ),
        );
      },
    );
    const revalidate = Effect.fn('ApprovalOwnerGateway.revalidate')(function* revalidate(
      state: OrderCommitmentState,
      input: { readonly idempotencyKey: string },
      scope: ApprovalGatewayScope,
    ) {
      if (!isRevalidationAdmissible(state, scope)) {
        return yield* conflict();
      }
      const retained = yield* recoverRevalidation(state, input.idempotencyKey, scope);
      const payload = yield* Schema.decodeUnknownEffect(Schema.toType(RevalidateOrderPurchaseApprovalPayloadSchema))({
        candidateHash: state.bundle.finalization.cart.candidateHash,
        candidateRef: state.bundle.finalization.cart.candidateRef,
        commitmentCorrelationId: state.attempt.commitmentCorrelationId,
        finalBinding: state.attempt.binding,
        idempotencyKey: input.idempotencyKey,
        requestRef: state.bundle.approvalRequestRef,
      }).pipe(Effect.mapError(unavailable));
      const result = Option.isSome(retained)
        ? retained.value
        : yield* issueOriginalRevalidation(state, payload, input.idempotencyKey, scope);
      if (!isExactValidRevalidation(state, result)) {
        return yield* conflict();
      }
      return result;
    });
    return {
      consume: Effect.fn('ApprovalOwnerGateway.consume')(function* consume(
        state: OrderCommitmentState,
        scope: ApprovalGatewayScope,
      ) {
        const { order } = state;
        if (
          order === null ||
          state.attempt.status !== 'COMMITTED' ||
          state.bundle.buyerPrincipalId !== scope.buyerPrincipalId ||
          state.bundle.legalEntityId !== scope.legalEntityId ||
          order.orderRef.tenantId !== scope.tenantId
        ) {
          return yield* conflict();
        }
        const retained = yield* recoverConsumption(state, scope);
        if (Option.isSome(retained)) {
          return retained.value;
        }
        const auth = yield* credential(scope);
        const payload = yield* Schema.decodeUnknownEffect(Schema.toType(ConsumeOrderPurchaseApprovalPayloadSchema))({
          finalBinding: order.binding,
          idempotencyKey: order.consumptionIntent,
          orderRef: order.orderRef,
          revalidationRef: order.approvalProof.revalidationRef,
        }).pipe(Effect.mapError(unavailable));
        return yield* executeConsumeOrderPurchaseApprovalWithAuthorization(
          payload,
          auth.authorization,
          scope.correlationId,
          { ...auth, idempotencyKey: order.consumptionIntent },
        ).pipe(
          Effect.catch((error) => recoverAfterOwnerFailure(recoveryFailure(error), recoverConsumption(state, scope))),
        );
      }),
      loadProposal: Effect.fn('ApprovalOwnerGateway.loadProposal')(function* loadProposal(
        input: PrepareOrderCommitmentInput,
        scope: ApprovalGatewayScope,
      ) {
        if (
          input.requestRef.tenantId !== scope.tenantId ||
          input.counterpartyRef.tenantId !== scope.tenantId ||
          input.candidateRef.tenantId !== scope.tenantId
        ) {
          return yield* conflict();
        }
        const auth = yield* credential(scope);
        const payload = yield* Schema.decodeUnknownEffect(Schema.toType(OrderServiceApprovalEvidenceRequestSchema))({
          candidateHash: input.candidateHash,
          candidateRef: input.candidateRef,
          operation: 'LOAD_PROPOSAL',
          requestRef: input.requestRef,
        }).pipe(Effect.mapError(unavailable));
        const response = yield* executeOrderServiceApprovalEvidenceWithAuthorization(
          payload,
          auth.authorization,
          scope.correlationId,
          auth,
        ).pipe(Effect.mapError(unavailable));
        if (
          response.operation !== 'LOAD_PROPOSAL' ||
          response.proposal.identity.buyer.principalId !== scope.buyerPrincipalId ||
          response.proposal.identity.buyer.tenantId !== scope.tenantId ||
          !sameRef(response.candidateRef, input.candidateRef) ||
          response.candidateHash !== input.candidateHash ||
          !sameRef(response.request.requestRef, input.requestRef) ||
          !sameRef(response.proposal.identity.counterpartyRef, input.counterpartyRef) ||
          response.proposal.context.storefrontId !== input.storefrontId ||
          response.proposal.context.sellingLegalEntityId !== scope.legalEntityId
        ) {
          return yield* conflict();
        }
        return response;
      }),
      recoverConsumption: Effect.fn('ApprovalOwnerGateway.recoverRetainedConsumption')(
        function* recoverRetainedConsumption(state: OrderCommitmentState, scope: ApprovalGatewayScope) {
          if (
            state.order === null ||
            state.attempt.status !== 'COMMITTED' ||
            state.bundle.buyerPrincipalId !== scope.buyerPrincipalId ||
            state.bundle.legalEntityId !== scope.legalEntityId ||
            state.bundle.bundleRef.tenantId !== scope.tenantId
          ) {
            return yield* conflict();
          }
          return yield* recoverConsumption(state, scope);
        },
      ),
      recoverRevalidation: Effect.fn('ApprovalOwnerGateway.recoverRetainedRevalidation')(
        function* recoverRetainedRevalidation(
          state: OrderCommitmentState,
          input: { readonly idempotencyKey: string },
          scope: ApprovalGatewayScope,
        ) {
          if (!isRevalidationAdmissible(state, scope)) {
            return yield* conflict();
          }
          return yield* recoverRevalidation(state, input.idempotencyKey, scope);
        },
      ),
      recoverRevalidationOutcome: Effect.fn('ApprovalOwnerGateway.recoverRetainedRevalidationOutcome')(
        function* recoverRetainedRevalidationOutcome(
          state: OrderCommitmentState,
          input: { readonly idempotencyKey: string },
          scope: ApprovalGatewayScope,
        ) {
          if (!isRevalidationAdmissible(state, scope)) {
            return yield* conflict();
          }
          return yield* recoverRevalidationOutcome(state, input.idempotencyKey, scope);
        },
      ),
      revalidate,
      revalidateOutcome: Effect.fn('ApprovalOwnerGateway.revalidateOutcome')(function* revalidateOutcome(
        state: OrderCommitmentState,
        input: { readonly idempotencyKey: string },
        scope: ApprovalGatewayScope,
      ) {
        if (!isRevalidationAdmissible(state, scope)) {
          return yield* conflict();
        }
        const retained = yield* recoverRevalidationOutcome(state, input.idempotencyKey, scope);
        if (Option.isSome(retained)) {
          return retained.value;
        }
        return yield* revalidate(state, input, scope).pipe(
          Effect.map((result) => ({ kind: 'VALID' as const, result })),
          Effect.catch((error) =>
            error.code === 'order_commitment_conflict'
              ? Effect.fail(error)
              : requireRecovered(recoverRevalidationOutcome(state, input.idempotencyKey, scope), error),
          ),
        );
      }),
      verifyProof: Effect.fn('ApprovalOwnerGateway.verifyProof')(function* verifyProof(
        state: OrderCommitmentState,
        input: ProofLookup,
        scope: ApprovalGatewayScope,
      ) {
        if (
          state.bundle.buyerPrincipalId !== scope.buyerPrincipalId ||
          state.bundle.legalEntityId !== scope.legalEntityId ||
          state.bundle.bundleRef.tenantId !== scope.tenantId
        ) {
          return yield* conflict();
        }
        const auth = yield* credential(scope);
        const payload = yield* Schema.decodeUnknownEffect(Schema.toType(OrderServiceApprovalEvidenceRequestSchema))({
          candidateHash: state.bundle.finalization.cart.candidateHash,
          candidateRef: state.bundle.finalization.cart.candidateRef,
          finalBinding: state.attempt.binding,
          operation: 'VERIFY_PROOF',
          requestRef: state.bundle.approvalRequestRef,
          revalidationRef: input.revalidationRef,
        }).pipe(Effect.mapError(unavailable));
        const response = yield* executeOrderServiceApprovalEvidenceWithAuthorization(
          payload,
          auth.authorization,
          scope.correlationId,
          auth,
        ).pipe(Effect.mapError(unavailable));
        if (
          response.operation !== 'VERIFY_PROOF' ||
          !sameRef(response.candidateRef, state.bundle.finalization.cart.candidateRef) ||
          response.candidateHash !== state.bundle.finalization.cart.candidateHash ||
          !sameRef(response.request.requestRef, state.bundle.approvalRequestRef) ||
          !sameRef(response.proof.revalidationRef, input.revalidationRef) ||
          response.proposal.canonicalHash !== state.bundle.proposal.canonicalHash ||
          response.proposal.identity.buyer.principalId !== state.bundle.buyerPrincipalId ||
          response.proposal.context.sellingLegalEntityId !== scope.legalEntityId ||
          response.proposal.context.tenantId !== scope.tenantId ||
          (response.issuer.kind === 'BUYER'
            ? response.issuer.buyerPrincipalId !== state.bundle.buyerPrincipalId ||
              response.proof.evidence.actorPrincipalId !== response.issuer.buyerPrincipalId
            : response.proof.evidence.actorPrincipalId !== response.issuer.serviceProofActorPrincipalId)
        ) {
          return yield* conflict();
        }
        return response;
      }),
    } satisfies ApprovalOwnerGatewayService;
  }),
);
