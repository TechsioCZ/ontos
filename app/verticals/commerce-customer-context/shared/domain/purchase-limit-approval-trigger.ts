import { Context, Effect, Match, Schema } from 'effect';
import { CommerceCustomerProfileRefSchema, ProfileTradingGateSchema } from './profile-decisions.ts';
import { PurchaseLimitEvaluationContextSchema } from './purchase-limit-evaluation.ts';
import type {
  PurchaseLimitEvaluationContext,
  PurchaseLimitEvaluationResult,
} from './purchase-limit-evaluation.ts';
import { PurchaseLimitCounterpartyRefSchema } from './purchase-limit-policy.ts';
import { PurchaseValueSchema } from './purchase-limit.ts';
import type { PurchaseValue } from './purchase-limit.ts';

const ReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const TimestampSchema = Schema.DateTimeUtcFromString;

export const PurchaseApprovalProfileEvidenceSchema = Schema.Struct({
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  evaluatedAt: TimestampSchema,
  evaluationContext: PurchaseLimitEvaluationContextSchema,
  gate: ProfileTradingGateSchema,
  profileRef: CommerceCustomerProfileRefSchema,
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  sourceRevision: ReferenceSchema,
});
export type PurchaseApprovalProfileEvidence = typeof PurchaseApprovalProfileEvidenceSchema.Type;

export const PurchaseApprovalProposalEvidenceSchema = Schema.Struct({
  evaluatedAt: TimestampSchema,
  evaluationContext: PurchaseLimitEvaluationContextSchema,
  proposalRevisionRef: ReferenceSchema,
  purchaseValue: PurchaseValueSchema,
  revision: ReferenceSchema,
  state: Schema.Literals(['CURRENT', 'SUPERSEDED', 'INDETERMINATE']),
});
export type PurchaseApprovalProposalEvidence = typeof PurchaseApprovalProposalEvidenceSchema.Type;

const PurchaseApprovalSubmittedSchema = Schema.TaggedStruct('APPROVAL_SUBMITTED', {
  approvalRequestRef: ReferenceSchema,
});
const PurchaseApprovalAlreadySubmittedSchema = Schema.TaggedStruct('APPROVAL_ALREADY_SUBMITTED', {
  approvalRequestRef: ReferenceSchema,
});
const PurchaseApprovalRouteUnavailableSchema = Schema.TaggedStruct('APPROVAL_ROUTE_UNAVAILABLE', {
  reasonCode: Schema.String,
});

/** Exact outcomes owned by #317 after a valid approval-required evaluation reaches submission. */
export const PurchaseApprovalSubmissionResultSchema = Schema.Union([
  PurchaseApprovalSubmittedSchema,
  PurchaseApprovalAlreadySubmittedSchema,
  PurchaseApprovalRouteUnavailableSchema,
]);
export type PurchaseApprovalSubmissionResult = typeof PurchaseApprovalSubmissionResultSchema.Type;

export const PurchaseApprovalTriggerResultSchema = Schema.Union([
  Schema.TaggedStruct('DIRECT_PURCHASE_ALLOWED', {}),
  PurchaseApprovalSubmittedSchema,
  PurchaseApprovalAlreadySubmittedSchema,
  PurchaseApprovalRouteUnavailableSchema,
  Schema.TaggedStruct('APPROVAL_PRECONDITION_FAILED', { reasonCode: Schema.String }),
]);
export type PurchaseApprovalTriggerResult = typeof PurchaseApprovalTriggerResultSchema.Type;

export const PurchaseApprovalDependencyUnavailableSchema = Schema.TaggedStruct(
  'PurchaseApprovalDependencyUnavailable',
  {
    code: Schema.Literal('purchase_approval_dependency_unavailable'),
    dependency: Schema.Literals([
      'BUYER_AUTHORIZATION',
      'CUSTOMER_PROFILE',
      'PURCHASE_LIMIT_EVALUATION',
      'PURCHASING_APPROVAL',
    ]),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
);
export type PurchaseApprovalDependencyUnavailable =
  typeof PurchaseApprovalDependencyUnavailableSchema.Type;

export const PurchaseApprovalCurrentnessIndeterminateSchema = Schema.TaggedStruct(
  'PurchaseApprovalCurrentnessIndeterminate',
  {
    code: Schema.Literal('purchase_approval_currentness_indeterminate'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
    source: Schema.Literal('PURCHASE_PROPOSAL'),
  },
);
export type PurchaseApprovalCurrentnessIndeterminate =
  typeof PurchaseApprovalCurrentnessIndeterminateSchema.Type;

export const PurchaseApprovalTriggerErrorSchema = Schema.Union([
  PurchaseApprovalCurrentnessIndeterminateSchema,
  PurchaseApprovalDependencyUnavailableSchema,
]);
export type PurchaseApprovalTriggerError = typeof PurchaseApprovalTriggerErrorSchema.Type;

export type PurchaseApprovalSubmissionPort = Readonly<{
  /** Bind owner persistence to the Core Action invocation that authorized the command. */
  readonly forActionInvocation?: (actionInvocationId: string) => PurchaseApprovalSubmissionPort;
  submit: (input: {
    readonly evaluation: Extract<
      PurchaseLimitEvaluationResult,
      { readonly _tag: 'APPROVAL_REQUIRED' }
    >;
    readonly idempotencyKey: string;
    readonly profileEvidence: PurchaseApprovalProfileEvidence;
    readonly proposalEvidence: PurchaseApprovalProposalEvidence;
  }) => Effect.Effect<PurchaseApprovalSubmissionResult, PurchaseApprovalDependencyUnavailable>;
}>;

export class PurchaseApprovalSubmission extends Context.Service<
  PurchaseApprovalSubmission,
  PurchaseApprovalSubmissionPort
>()(
  '@app/commerce-customer-context/shared/domain/purchase-limit-approval-trigger/PurchaseApprovalSubmission',
) {}

type BusinessPurchaseLimitEvaluation = Extract<
  PurchaseLimitEvaluationResult,
  { readonly _tag: 'APPROVAL_REQUIRED' | 'WITHIN_LIMIT' }
>;

const sameCounterparty = (
  left: PurchaseApprovalProfileEvidence['counterpartyRef'],
  right: PurchaseApprovalProfileEvidence['counterpartyRef'],
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameEvaluationContext = (
  left: PurchaseLimitEvaluationContext,
  right: PurchaseLimitEvaluationContext,
): boolean =>
  sameCounterparty(left.counterpartyRef, right.counterpartyRef) &&
  left.principalId === right.principalId &&
  left.sellingLegalEntityId === right.sellingLegalEntityId &&
  left.storefrontId === right.storefrontId;

const samePurchaseValue = (left: PurchaseValue, right: PurchaseValue): boolean =>
  left.monetaryAmount.amount === right.monetaryAmount.amount &&
  left.monetaryAmount.currency === right.monetaryAmount.currency &&
  left.roundingRuleRevision === right.roundingRuleRevision &&
  left.sourceRef === right.sourceRef &&
  left.sourceRevision === right.sourceRevision;

const preconditionFailed = (reasonCode: string): PurchaseApprovalTriggerResult => ({
  _tag: 'APPROVAL_PRECONDITION_FAILED',
  reasonCode,
});

const triggerBusinessEvaluation = (
  input: {
    readonly buyerPermission: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
    readonly idempotencyKey: string;
    readonly profileEvidence: PurchaseApprovalProfileEvidence;
    readonly proposalEvidence: PurchaseApprovalProposalEvidence;
    readonly trustedContext: PurchaseLimitEvaluationContext;
  },
  evaluation: BusinessPurchaseLimitEvaluation,
): Effect.Effect<
  PurchaseApprovalTriggerResult,
  PurchaseApprovalTriggerError,
  PurchaseApprovalSubmission
> => {
  if (input.buyerPermission === 'UNAVAILABLE') {
    return Effect.fail({
      _tag: 'PurchaseApprovalDependencyUnavailable' as const,
      code: 'purchase_approval_dependency_unavailable' as const,
      dependency: 'BUYER_AUTHORIZATION' as const,
      reason: 'Current Buyer authorization is temporarily unavailable',
      retryable: true as const,
    });
  }
  if (input.buyerPermission === 'DENIED') {
    return Effect.succeed(preconditionFailed('buyer_permission_denied'));
  }
  if (!sameEvaluationContext(evaluation.evaluationContext, input.trustedContext)) {
    return Effect.succeed(preconditionFailed('evaluation_context_mismatch'));
  }
  if (!sameEvaluationContext(input.profileEvidence.evaluationContext, input.trustedContext)) {
    return Effect.succeed(preconditionFailed('profile_context_mismatch'));
  }
  if (!sameEvaluationContext(input.proposalEvidence.evaluationContext, input.trustedContext)) {
    return Effect.succeed(preconditionFailed('proposal_context_mismatch'));
  }
  if (
    !sameCounterparty(
      input.profileEvidence.counterpartyRef,
      evaluation.evaluationContext.counterpartyRef,
    )
  ) {
    return Effect.succeed(preconditionFailed('profile_counterparty_mismatch'));
  }
  if (input.profileEvidence.profileRef.tenantId !== input.trustedContext.counterpartyRef.tenantId) {
    return Effect.succeed(preconditionFailed('profile_tenant_mismatch'));
  }
  if (input.profileEvidence.gate.outcome === 'DEPENDENCY_UNAVAILABLE') {
    return Effect.fail({
      _tag: 'PurchaseApprovalDependencyUnavailable' as const,
      code: 'purchase_approval_dependency_unavailable' as const,
      dependency: 'CUSTOMER_PROFILE' as const,
      reason: 'Current Customer Profile trading eligibility is temporarily unavailable',
      retryable: true as const,
    });
  }
  if (
    input.profileEvidence.profileRef.kind !== 'COUNTERPARTY' ||
    !input.profileEvidence.gate.canAcceptNewOrder ||
    input.profileEvidence.gate.outcome !== 'ACTIVE'
  ) {
    return Effect.succeed(
      preconditionFailed(`profile_${input.profileEvidence.gate.outcome.toLowerCase()}`),
    );
  }
  if (input.proposalEvidence.state === 'INDETERMINATE') {
    return Effect.fail({
      _tag: 'PurchaseApprovalCurrentnessIndeterminate' as const,
      code: 'purchase_approval_currentness_indeterminate' as const,
      reason: 'Purchase proposal Currentness cannot be established',
      retryable: true as const,
      source: 'PURCHASE_PROPOSAL' as const,
    });
  }
  if (input.proposalEvidence.state === 'SUPERSEDED') {
    return Effect.succeed(preconditionFailed('proposal_superseded'));
  }
  if (
    input.proposalEvidence.proposalRevisionRef !== evaluation.purchaseValue.sourceRef ||
    input.proposalEvidence.purchaseValue.sourceRef !== evaluation.purchaseValue.sourceRef ||
    input.proposalEvidence.revision !== evaluation.purchaseValue.sourceRevision
  ) {
    return Effect.succeed(preconditionFailed('proposal_revision_mismatch'));
  }
  if (!samePurchaseValue(input.proposalEvidence.purchaseValue, evaluation.purchaseValue)) {
    return Effect.succeed(preconditionFailed('proposal_value_mismatch'));
  }
  if (
    !evaluation.currentSourceRevisions.some(
      ({ revision, source }) =>
        source === 'purchase-proposal' && revision === evaluation.purchaseValue.sourceRevision,
    )
  ) {
    return Effect.succeed(preconditionFailed('proposal_current_revision_missing'));
  }
  if (
    !evaluation.currentSourceRevisions.some(
      ({ revision, source }) =>
        source === 'purchasing-profile' && revision === input.profileEvidence.sourceRevision,
    )
  ) {
    return Effect.succeed(preconditionFailed('profile_current_revision_missing'));
  }
  return Match.value(evaluation).pipe(
    Match.tag('WITHIN_LIMIT', () => Effect.succeed({ _tag: 'DIRECT_PURCHASE_ALLOWED' as const })),
    Match.tag('APPROVAL_REQUIRED', (approvalEvaluation) =>
      PurchaseApprovalSubmission.pipe(
        Effect.flatMap((submission) =>
          submission.submit({
            evaluation: approvalEvaluation,
            idempotencyKey: input.idempotencyKey,
            profileEvidence: input.profileEvidence,
            proposalEvidence: input.proposalEvidence,
          }),
        ),
      ),
    ),
    Match.exhaustive,
  );
};

/** Keeps amount-policy evaluation separate from the approval workflow owner. */
export const triggerPurchaseApproval = (input: {
  readonly buyerPermission: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly evaluation: PurchaseLimitEvaluationResult;
  readonly idempotencyKey: string;
  readonly profileEvidence: PurchaseApprovalProfileEvidence;
  readonly proposalEvidence: PurchaseApprovalProposalEvidence;
  readonly trustedContext: PurchaseLimitEvaluationContext;
}): Effect.Effect<
  PurchaseApprovalTriggerResult,
  PurchaseApprovalTriggerError,
  PurchaseApprovalSubmission
> =>
  Match.value(input.evaluation).pipe(
    Match.tag('WITHIN_LIMIT', (evaluation) => triggerBusinessEvaluation(input, evaluation)),
    Match.tag('APPROVAL_REQUIRED', (evaluation) => triggerBusinessEvaluation(input, evaluation)),
    Match.tag('NO_EFFECTIVE_POLICY', () =>
      Effect.succeed({
        _tag: 'APPROVAL_PRECONDITION_FAILED' as const,
        reasonCode: 'no_effective_policy',
      }),
    ),
    Match.tag('INCONSISTENT_POLICY', () =>
      Effect.succeed({
        _tag: 'APPROVAL_PRECONDITION_FAILED' as const,
        reasonCode: 'inconsistent_policy',
      }),
    ),
    Match.tag('COMPARABLE_VALUE_REQUIRED', () =>
      Effect.succeed({
        _tag: 'APPROVAL_PRECONDITION_FAILED' as const,
        reasonCode: 'comparable_value_required',
      }),
    ),
    Match.tag('STALE_INPUT', () =>
      Effect.succeed({
        _tag: 'APPROVAL_PRECONDITION_FAILED' as const,
        reasonCode: 'stale_input',
      }),
    ),
    Match.exhaustive,
  );

export { PurchaseLimitEvaluationResultSchema } from './purchase-limit-evaluation.ts';
