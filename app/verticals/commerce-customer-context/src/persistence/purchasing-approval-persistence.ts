/*
 * Purchasing Approval is an owner-owned aggregate. Every production mutation below is a
 * transaction-bound call to an allow-listed PostgreSQL routine. There is deliberately no module
 * cache: process restarts, multiple replicas, and concurrent requests all observe the same durable
 * CAS/idempotency state under tenant/legal-entity RLS.
 */
import { Context, Effect, Option, Schema } from 'effect';
import { CoreSearchResourceRefSchema, defineScopedRoutine } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';

import type { PurchaseApprovalSubmissionPort } from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
  type ApprovalHierarchy,
  ConsumePurchaseApprovalInputSchema,
  ConsumePurchaseApprovalResultSchema,
  CreateApprovalHierarchyInputSchema,
  CreateApprovalHierarchyResultSchema,
  CreatePurchaseProposalRevisionInputSchema,
  CreatePurchaseProposalRevisionResultSchema,
  DecidePurchaseApprovalRequestInputSchema,
  DecidePurchaseApprovalRequestResultSchema,
  PurchaseApprovalRequestSchema,
  PurchaseProposalRevisionSchema,
  ApprovalDecisionSchema,
  ApprovalHierarchySchema,
  ApprovalRevalidationSchema,
  ApprovalRouteSchema,
  RevalidatePurchaseApprovalInputSchema,
  RevalidatePurchaseApprovalResultSchema,
  ReroutePurchaseApprovalRequestInputSchema,
  ReroutePurchaseApprovalRequestResultSchema,
  SubmitPurchaseApprovalRequestInputSchema,
  SubmitPurchaseApprovalRequestResultSchema,
  PurchasingApprovalRejected,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';
import type {
  CreateApprovalHierarchyInput,
  CreateApprovalHierarchyResult,
  ConsumePurchaseApprovalInput,
  CreatePurchaseProposalRevisionInput,
  CreatePurchaseProposalRevisionResult,
  DecidePurchaseApprovalRequestInput,
  DecidePurchaseApprovalRequestResult,
  RevalidatePurchaseApprovalInput,
  RevalidatePurchaseApprovalResult,
  ReroutePurchaseApprovalRequestInput,
  ReroutePurchaseApprovalRequestResult,
  SubmitPurchaseApprovalRequestInput,
  SubmitPurchaseApprovalRequestResult,
} from '../../shared/domain/purchasing-approval.ts';
import { compareExactDecimals } from '../../shared/domain/purchase-limit.ts';
import type { PurchaseApprovalOrderCommitmentPort } from '../../shared/domain/purchase-approval-order-commitment-port.ts';

const MODULE_KEY = 'commerce.customer-context' as const;
const ROUTINE_SCHEMA = 'commerce_customer_context' as const;
const RoutineResultSchema = Schema.Struct({ result: Schema.Json });
const routineParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'jsonb' },
] as const;

const createProposalRoutine = defineScopedRoutine({
  name: 'create_purchase_proposal_revision',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.create-proposal-revision',
  schema: ROUTINE_SCHEMA,
});
const createHierarchyRoutine = defineScopedRoutine({
  name: 'create_approval_hierarchy',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.create-hierarchy',
  schema: ROUTINE_SCHEMA,
});
const submitRequestRoutine = defineScopedRoutine({
  name: 'submit_purchase_approval_request',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.submit-request',
  schema: ROUTINE_SCHEMA,
});
const decideRoutine = defineScopedRoutine({
  name: 'decide_purchase_approval_request',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.decide-request',
  schema: ROUTINE_SCHEMA,
});
const rerouteRoutine = defineScopedRoutine({
  name: 'reroute_purchase_approval_request',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.reroute-request',
  schema: ROUTINE_SCHEMA,
});
export const readCurrentPurchaseApprovalRevalidationRoutine = defineScopedRoutine({
  name: 'read_current_purchase_approval_revalidation',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.read-current-revalidation',
  schema: ROUTINE_SCHEMA,
});
const revalidateRoutine = defineScopedRoutine({
  name: 'revalidate_purchase_approval',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.revalidate',
  schema: ROUTINE_SCHEMA,
});
const consumeRoutine = defineScopedRoutine({
  name: 'consume_purchase_approval',
  ownerModuleKey: MODULE_KEY,
  parameters: routineParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'purchasing-approval.consume',
  schema: ROUTINE_SCHEMA,
});

/** The complete owner boundary.  Keeping this list explicit makes accidental raw-table or
 * process-local persistence regressions visible in contract tests and review. */
export const purchasingApprovalRoutineAllowlist = Object.freeze([
  createProposalRoutine,
  createHierarchyRoutine,
  submitRequestRoutine,
  decideRoutine,
  rerouteRoutine,
  readCurrentPurchaseApprovalRevalidationRoutine,
  revalidateRoutine,
  consumeRoutine,
] as const);

const reject = (
  code: ConstructorParameters<typeof PurchasingApprovalRejected>[0]['code'],
  reason: string,
  retryable = false,
): PurchasingApprovalRejected => new PurchasingApprovalRejected({ code, reason, retryable });

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
type JsonObject = typeof JsonObjectSchema.Type;

const encodeJson = <A>(
  schema: Schema.Codec<unknown, unknown>,
  value: A,
): Effect.Effect<JsonObject, never> =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(JsonObjectSchema)(encoded)),
    Effect.orDie,
  );

const withOwnerMetadata = (
  encoded: JsonObject,
  scope: OperationalScope,
  actionInvocationId: string | undefined,
): JsonObject =>
  actionInvocationId === undefined
    ? { ...encoded, actorPrincipalId: scope.principalId }
    : { ...encoded, actionInvocationId, actorPrincipalId: scope.principalId };

const mapRoutineFailure = (
  routine: ApprovalRoutine,
  failure: ScopedRoutineInvocationError,
): PurchasingApprovalRejected => {
  const postgresCode = Option.getOrUndefined(failure.postgresCode);
  const constraint = Option.getOrUndefined(failure.constraint);
  switch (constraint) {
    case 'pa_not_route_eligible':
      return reject(
        'NOT_ROUTE_ELIGIBLE',
        'The actor is not eligible for the captured approval route level',
      );
    case 'pa_self_approval':
      return reject('SELF_APPROVAL_DENIED', 'The captured approval hierarchy denies self approval');
    case 'pa_request_not_pending':
      return reject(
        'REQUEST_NOT_PENDING',
        'The approval request is not in a state that accepts this owner operation',
      );
    case 'pa_request_expired':
      return reject('REQUEST_EXPIRED', 'The approval request validity window has expired');
    case 'pa_proposal_material':
      return reject(
        'PROPOSAL_MATERIAL_CHANGE',
        'The approval request no longer matches its captured proposal revision',
      );
    case 'pa_buyer_denied':
      return reject(
        'BUYER_PERMISSION_DENIED',
        'Current buyer authorization does not permit this approval',
      );
    case 'pa_profile_inactive':
      return reject('PROFILE_INACTIVE', 'The purchasing profile is no longer active');
    case 'pa_policy_route':
      return reject('POLICY_ROUTE_INVALID', 'The captured approval route is no longer current');
    case 'pa_proposal_not_current':
      return reject('PROPOSAL_NOT_CURRENT', 'The purchase proposal revision is no longer current');
    case 'pa_proposal_lineage':
      return reject(
        'IDEMPOTENCY_CONFLICT',
        'The purchase proposal lineage already has a current revision',
      );
    case 'pa_hierarchy_invalid':
      return reject('HIERARCHY_RANGE_INVALID', 'The Approval Hierarchy snapshot is invalid');
    case 'pa_submit_revision':
      return reject(
        'STALE_PROPOSAL_REVISION',
        'Submission must name a positive immutable proposal revision',
      );
    case 'pa_target_mismatch':
    case 'pa_scope':
    case 'pa_decision_actor':
    case 'pa_reroute_target':
    case 'pa_revalidation_target':
      return reject(
        'PERMISSION_DENIED',
        'The persisted approval target does not match the trusted operation scope',
      );
    case 'pa_request_snapshot_missing':
    case 'pa_reroute_snapshot_missing':
    case 'pa_revalidation_snapshot_missing':
    case 'pa_currentness_not_found':
      return reject(
        'CURRENT_STATE_INDETERMINATE',
        'The persisted approval request snapshot is unavailable',
        true,
      );
    case 'pa_request_cas':
    case 'pa_reroute_cas':
      return reject(
        'COMMIT_CONFLICT',
        'The approval request changed concurrently; retry with fresh evidence',
        true,
      );
    case 'pa_hierarchy_missing':
    case 'pa_reroute_hierarchy_missing':
      return reject(
        'HIERARCHY_NOT_FOUND',
        'No current Approval Hierarchy matches the proposal scope and value',
      );
    case 'pa_hierarchy_ambiguous':
    case 'pa_reroute_hierarchy_ambiguous':
      return reject('HIERARCHY_AMBIGUOUS', 'Approval Hierarchy selection is ambiguous');
    case 'pa_route_empty':
    case 'pa_reroute_route_empty':
      return reject('NO_ELIGIBLE_ROUTE', 'The selected Approval Hierarchy has no eligible route');
    case 'pa_reroute_required':
      return reject(
        'NO_ELIGIBLE_ROUTE',
        'The captured approval route requires a fresh current route before it can proceed',
      );
    case 'pa_decision_reason_required':
      return reject('PERMISSION_DENIED', 'Return and reject decisions require a non-empty reason');
    case 'pa_revalidation_expired':
      return reject(
        'REQUEST_EXPIRED',
        'The owner revalidation evidence is outside the trusted validity window',
      );
    case 'pa_commitment_malformed':
      return reject(
        'PROPOSAL_MATERIAL_CHANGE',
        'The Order commitment evidence is malformed or incomplete',
      );
    case 'pa_commitment_not_found':
      return reject(
        'CURRENT_STATE_INDETERMINATE',
        'The approval request is unavailable for commitment',
        true,
      );
    case 'pa_commitment_target':
      return reject(
        'PERMISSION_DENIED',
        'The Order commitment target does not match the trusted approval scope',
      );
    case 'pa_commitment_not_approved':
      return reject(
        'COMMIT_CONFLICT',
        'Only a current APPROVED request can be consumed by an Order commitment',
      );
    case 'pa_commitment_conflict':
      return reject(
        'COMMIT_CONFLICT',
        'The approval is already committed to a different Order or commitment attempt',
      );
    case 'pa_commitment_cas':
      return reject(
        'COMMIT_CONFLICT',
        'The approval changed concurrently; retry with fresh commitment evidence',
        true,
      );
    default:
      break;
  }
  if (postgresCode === '23505') {
    if (routine.routineKey === 'purchasing-approval.consume') {
      return reject(
        'COMMIT_CONFLICT',
        'The approval is already committed to a different Order or commitment attempt',
      );
    }
    return reject(
      'IDEMPOTENCY_CONFLICT',
      `Purchasing Approval ${routine.routineKey} idempotency key conflicts with durable state`,
    );
  }
  if (postgresCode === '40001') {
    return reject(
      'COMMIT_CONFLICT',
      `Purchasing Approval ${routine.routineKey} observed a concurrent durable state change; retry with fresh evidence`,
      true,
    );
  }
  if (postgresCode === '42501') {
    return reject(
      'PERMISSION_DENIED',
      'The persisted approval target does not match the trusted operation scope',
    );
  }
  // Core deliberately sanitizes SQL exception text. Owner routines must therefore expose
  // stable constraint identifiers for every expected business outcome; never branch on the
  // sanitized reason or leak it to the Action boundary.
  return reject(
    'EVIDENCE_PERSISTENCE_FAILED',
    `Purchasing Approval owner routine ${routine.routineKey} failed`,
    true,
  );
};

const isCounterpartyRef = (ref: {
  readonly moduleId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): boolean =>
  ref.moduleId === 'party.registry' && ref.resourceType === 'party.registry.counterparty';

type ApprovalRoutine = typeof createProposalRoutine;

/**
 * The smallest transaction capability this owner needs.  Keep this local instead of exposing
 * Core's transaction type through the Action service requirement; Core still supplies its
 * transaction-bound implementation at runtime, while the owner can only invoke its declared
 * routines.
 */
export interface PurchasingApprovalScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const invokeRoutine = <Result>(
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
  routine: ApprovalRoutine,
  payload: JsonObject,
  resultSchema: Schema.Decoder<Result>,
): Effect.Effect<Result, PurchasingApprovalRejected> =>
  transaction.invoke(routine, [payload]).pipe(
    Effect.mapError((failure) => mapRoutineFailure(routine, failure)),
    Effect.flatMap((rows) => {
      const [row] = rows;
      return row === undefined
        ? Effect.fail(
            reject(
              'CURRENT_STATE_INDETERMINATE',
              'Purchasing Approval owner routine returned no result',
              true,
            ),
          )
        : Schema.decodeUnknownEffect(resultSchema)(row.result).pipe(
            Effect.mapError((failure) =>
              reject(
                'EVIDENCE_PERSISTENCE_FAILED',
                `Purchasing Approval owner routine returned an invalid result: ${String(failure)}`,
                true,
              ),
            ),
          );
    }),
    Effect.withSpan('commerce.customer-context.purchasing-approval.owner-routine'),
  );

const validateHierarchy = (
  hierarchy: ApprovalHierarchy,
  tenantId: string,
): PurchasingApprovalRejected | undefined => {
  const ordered = hierarchy.levels.toSorted((left, right) => left.order - right.order);
  if (
    ordered.some(
      (level, index) =>
        level.order !== index + 1 ||
        level.completionRule !== 'ONE_APPROVER' ||
        level.eligiblePrincipals.length === 0,
    )
  ) {
    return reject(
      'HIERARCHY_RANGE_INVALID',
      'Hierarchy levels must be ordered, contiguous, and non-empty',
    );
  }
  if (
    ordered.some((level) =>
      level.eligiblePrincipals.some((principal) => principal.tenantId !== tenantId),
    )
  ) {
    return reject(
      'NO_ELIGIBLE_ROUTE',
      'Hierarchy levels cannot include principals outside the trusted tenant',
    );
  }
  if (
    hierarchy.selector.maximumPurchaseValue !== null &&
    hierarchy.selector.maximumPurchaseValue.currency ===
      hierarchy.selector.minimumPurchaseValue.currency &&
    compareExactDecimals(
      hierarchy.selector.maximumPurchaseValue.amount,
      hierarchy.selector.minimumPurchaseValue.amount,
    ) < 0
  ) {
    return reject('HIERARCHY_RANGE_INVALID', 'Hierarchy value range is inverted');
  }
  return undefined;
};

export interface PurchasingApprovalWorkflowService extends PurchaseApprovalSubmissionPort {
  readonly forActionInvocation: (actionInvocationId: string) => PurchasingApprovalWorkflowService;
  readonly createProposal: (
    input: CreatePurchaseProposalRevisionInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof CreatePurchaseProposalRevisionResultSchema>,
    PurchasingApprovalRejected
  >;
  readonly createHierarchy: (
    input: CreateApprovalHierarchyInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof CreateApprovalHierarchyResultSchema>,
    PurchasingApprovalRejected
  >;
  readonly consume: (
    input: ConsumePurchaseApprovalInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof ConsumePurchaseApprovalResultSchema>,
    PurchasingApprovalRejected
  >;
  readonly submitRequest: (
    input: SubmitPurchaseApprovalRequestInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof SubmitPurchaseApprovalRequestResultSchema>,
    PurchasingApprovalRejected
  >;
  readonly decide: (
    input: DecidePurchaseApprovalRequestInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof DecidePurchaseApprovalRequestResultSchema>,
    PurchasingApprovalRejected
  >;
  readonly reroute: (
    input: ReroutePurchaseApprovalRequestInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof ReroutePurchaseApprovalRequestResultSchema>,
    PurchasingApprovalRejected
  >;
  readonly revalidate: (
    input: RevalidatePurchaseApprovalInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof RevalidatePurchaseApprovalResultSchema>,
    PurchasingApprovalRejected
  >;
}

export interface PurchasingApprovalWorkflowFactoryContract {
  readonly make: (
    transaction: PurchasingApprovalScopedRoutineInvoker,
    scope: OperationalScope,
  ) => Effect.Effect<PurchasingApprovalWorkflowService, never>;
}
export class PurchasingApprovalWorkflowFactory extends Context.Service<
  PurchasingApprovalWorkflowFactory,
  PurchasingApprovalWorkflowFactoryContract
>()(
  '@app/commerce-customer-context/persistence/purchasing-approval-persistence/PurchasingApprovalWorkflowFactory',
) {}

const dependencyUnavailable = (reason: string) => ({
  _tag: 'PurchaseApprovalDependencyUnavailable' as const,
  code: 'purchase_approval_dependency_unavailable' as const,
  dependency: 'PURCHASING_APPROVAL' as const,
  reason,
  retryable: true as const,
});

const makeWorkflow = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
  actionInvocationId: string | undefined = undefined,
): PurchasingApprovalWorkflowService => {
  const createProposal = (input: CreatePurchaseProposalRevisionInput) =>
    Effect.gen(function* createProposalEffect() {
      const { proposal, verifiedEvidence } = input;
      const proposalSources = verifiedEvidence.sourceRevisions.filter(
        ({ source }) => source === 'purchase-proposal',
      );
      const profileSources = verifiedEvidence.sourceRevisions.filter(
        ({ source }) => source === 'purchasing-profile',
      );
      const hasProposalSource =
        proposalSources.length === 1 &&
        proposalSources[0]?.revision === proposal.purchaseValue.sourceRevision;
      const [profileSource] = profileSources;
      const hasProfileSource =
        profileSources.length === 1 &&
        profileSource !== undefined &&
        profileSource.revision.length > 0;
      if (
        proposal.proposalRevisionRef.tenantId !== scope.tenantId ||
        proposal.context.tenantId !== scope.tenantId ||
        proposal.context.sellingLegalEntityId !== scope.legalEntityId ||
        proposal.identity.buyer.tenantId !== scope.tenantId ||
        proposal.identity.buyer.principalId !== scope.principalId ||
        !isCounterpartyRef(proposal.identity.counterpartyRef) ||
        proposal.identity.counterpartyRef.tenantId !== scope.tenantId ||
        proposal.identity.profileRef.tenantId !== scope.tenantId ||
        proposal.sourceCart.cartRef.moduleId !== 'commerce.cart' ||
        proposal.sourceCart.cartRef.resourceType !== 'commerce.cart.cart' ||
        proposal.sourceCart.cartRef.tenantId !== scope.tenantId ||
        proposal.hierarchyInputs.counterpartyRef.resourceId !==
          proposal.identity.counterpartyRef.resourceId ||
        proposal.hierarchyInputs.counterpartyRef.tenantId !==
          proposal.identity.counterpartyRef.tenantId ||
        proposal.hierarchyInputs.storefrontId !== proposal.context.storefrontId ||
        proposal.approvalEvaluation !== 'APPROVAL_REQUIRED' ||
        proposal.hierarchyInputs.purchaseValue.amount !==
          proposal.purchaseValue.monetaryAmount.amount ||
        proposal.hierarchyInputs.purchaseValue.currency !==
          proposal.purchaseValue.monetaryAmount.currency ||
        !verifiedEvidence.proposalCurrent ||
        verifiedEvidence.buyerPermission !== 'ALLOWED' ||
        verifiedEvidence.profileState !== 'ACTIVE' ||
        !hasProposalSource ||
        !hasProfileSource
      ) {
        return yield* reject(
          'PROPOSAL_NOT_CURRENT',
          'Verified buyer, profile, policy, currency, and proposal currentness evidence does not match the candidate',
        );
      }
      if (computePurchaseProposalCanonicalHash(input.proposal) !== input.proposal.canonicalHash) {
        return yield* reject(
          'STALE_PROPOSAL_REVISION',
          'Proposal canonical hash does not match the immutable snapshot',
        );
      }
      const encoded = yield* encodeJson(CreatePurchaseProposalRevisionInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        createProposalRoutine,
        withOwnerMetadata(encoded, scope, actionInvocationId),
        CreatePurchaseProposalRevisionResultSchema,
      );
    });

  const createHierarchy = (input: CreateApprovalHierarchyInput) =>
    Effect.gen(function* createHierarchyEffect() {
      const invalid = validateHierarchy(input.hierarchy, scope.tenantId);
      if (invalid !== undefined) {
        return yield* invalid;
      }
      const encoded = yield* encodeJson(CreateApprovalHierarchyInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        createHierarchyRoutine,
        withOwnerMetadata(encoded, scope, actionInvocationId),
        CreateApprovalHierarchyResultSchema,
      );
    });

  const submitRequestWithInvocation = (
    input: SubmitPurchaseApprovalRequestInput,
    invocationId: string | undefined,
  ) =>
    Effect.gen(function* submitRequestEffect() {
      const encoded = yield* encodeJson(SubmitPurchaseApprovalRequestInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        submitRequestRoutine,
        withOwnerMetadata(encoded, scope, invocationId),
        SubmitPurchaseApprovalRequestResultSchema,
      );
    });
  const submitRequest = (input: SubmitPurchaseApprovalRequestInput) =>
    submitRequestWithInvocation(input, actionInvocationId);

  const decide = (input: DecidePurchaseApprovalRequestInput) =>
    Effect.gen(function* decideEffect() {
      const actor = { ...input.actor, principalId: scope.principalId, tenantId: scope.tenantId };
      const encoded = yield* encodeJson(DecidePurchaseApprovalRequestInputSchema, {
        ...input,
        actor,
      });
      return yield* invokeRoutine(
        transaction,
        scope,
        decideRoutine,
        withOwnerMetadata(encoded, scope, actionInvocationId),
        DecidePurchaseApprovalRequestResultSchema,
      );
    });

  const reroute = (input: ReroutePurchaseApprovalRequestInput) =>
    Effect.gen(function* rerouteEffect() {
      const encoded = yield* encodeJson(ReroutePurchaseApprovalRequestInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        rerouteRoutine,
        withOwnerMetadata(encoded, scope, actionInvocationId),
        ReroutePurchaseApprovalRequestResultSchema,
      );
    });

  const revalidate = (input: RevalidatePurchaseApprovalInput) =>
    Effect.gen(function* revalidateEffect() {
      const encoded = yield* encodeJson(RevalidatePurchaseApprovalInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        revalidateRoutine,
        withOwnerMetadata(encoded, scope, actionInvocationId),
        RevalidatePurchaseApprovalResultSchema,
      );
    });

  const consume = (input: ConsumePurchaseApprovalInput) =>
    Effect.gen(function* consumeEffect() {
      const encoded = yield* encodeJson(ConsumePurchaseApprovalInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        consumeRoutine,
        withOwnerMetadata(encoded, scope, actionInvocationId),
        ConsumePurchaseApprovalResultSchema,
      );
    });

  const submit: PurchaseApprovalSubmissionPort['submit'] = (input) =>
    Effect.gen(function* submitEffect() {
      const proposalRevision = Number(input.proposalEvidence.revision);
      if (!Number.isSafeInteger(proposalRevision) || proposalRevision < 1) {
        return yield* Effect.fail(
          dependencyUnavailable(
            'The current Purchase Proposal evidence does not carry a valid immutable revision',
          ),
        );
      }
      const counterpartyRef = yield* Schema.decodeUnknownEffect(CoreSearchResourceRefSchema)(
        input.profileEvidence.counterpartyRef,
      ).pipe(
        Effect.mapError(() =>
          dependencyUnavailable(
            'The current Purchase Profile evidence has an invalid Counterparty reference',
          ),
        ),
      );
      if (actionInvocationId === undefined) {
        return yield* Effect.fail(
          dependencyUnavailable(
            'Purchasing Approval submission requires the Core Action invocation context',
          ),
        );
      }
      const result = yield* submitRequestWithInvocation(
        {
          counterpartyRef,
          idempotencyKey: input.idempotencyKey,
          proposalRevisionRef: {
            moduleId: MODULE_KEY,
            resourceId: input.proposalEvidence.proposalRevisionRef,
            resourceType: `${MODULE_KEY}.purchase-proposal-revision`,
            tenantId: scope.tenantId,
          },
          proposalRevision,
          // The SQL owner routine ignores this caller-provided value and uses the persisted proposal's
          // immutable expiresAt. It remains present for the public #305 adapter shape.
          requestExpiresAt: input.proposalEvidence.evaluatedAt,
          storefrontId: input.proposalEvidence.evaluationContext.storefrontId,
        },
        actionInvocationId,
      );
      return {
        _tag:
          result.outcome === 'SUBMITTED'
            ? ('APPROVAL_SUBMITTED' as const)
            : ('APPROVAL_ALREADY_SUBMITTED' as const),
        approvalRequestRef: result.request.requestRef.resourceId,
      };
    }).pipe(
      Effect.catchTag('PurchasingApprovalRejected', (failure) =>
        failure.code === 'HIERARCHY_NOT_FOUND' ||
        failure.code === 'HIERARCHY_AMBIGUOUS' ||
        failure.code === 'NO_ELIGIBLE_ROUTE'
          ? Effect.succeed({
              _tag: 'APPROVAL_ROUTE_UNAVAILABLE' as const,
              reasonCode: failure.code,
            })
          : Effect.fail(
              dependencyUnavailable(`Purchasing Approval submission failed: ${failure.code}`),
            ),
      ),
    );

  return {
    consume,
    createProposal,
    createHierarchy,
    decide,
    forActionInvocation: (invocationId) => makeWorkflow(transaction, scope, invocationId),
    revalidate,
    reroute,
    submit,
    submitRequest,
  };
};

export const purchasingApprovalWorkflowForScope = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PurchasingApprovalWorkflowService, never> =>
  Effect.succeed(makeWorkflow(transaction, scope));
export const purchasingApprovalWorkflowLive = {
  make: (transaction: PurchasingApprovalScopedRoutineInvoker, scope: OperationalScope) =>
    Effect.succeed(makeWorkflow(transaction, scope)),
} satisfies PurchasingApprovalWorkflowFactoryContract;

/**
 * Public Order-owner adapter. It closes the scoped routine capability and the
 * Core invocation id together; callers cannot obtain the routine invoker or
 * mutate approval tables directly.
 */
export const purchasingApprovalOrderCommitmentForScope = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PurchaseApprovalOrderCommitmentPort, never> =>
  Effect.succeed({
    consume: (input, actionInvocationId) =>
      makeWorkflow(transaction, scope, actionInvocationId).consume(input),
  });

/** Compatibility seam for callers outside an Action factory. It is intentionally fail-closed. */
export const purchasingApprovalSubmissionLive: PurchaseApprovalSubmissionPort = {
  submit: () =>
    Effect.fail(dependencyUnavailable('A scoped Purchasing Approval transaction is required')),
};
export const purchasingApprovalSubmissionForScope = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PurchaseApprovalSubmissionPort, never> =>
  Effect.succeed(makeWorkflow(transaction, scope));

export const purchasingApprovalWorkflowSchemas = {
  hierarchy: ApprovalHierarchySchema,
  proposal: PurchaseProposalRevisionSchema,
  request: PurchaseApprovalRequestSchema,
  decision: ApprovalDecisionSchema,
  route: ApprovalRouteSchema,
  revalidation: ApprovalRevalidationSchema,
  consumeInput: ConsumePurchaseApprovalInputSchema,
  consumeResult: ConsumePurchaseApprovalResultSchema,
};
