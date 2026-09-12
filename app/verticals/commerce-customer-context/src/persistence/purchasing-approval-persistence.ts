/*
 * Purchasing Approval is an owner-owned aggregate. Every production mutation below is a
 * transaction-bound call to an allow-listed PostgreSQL routine. There is deliberately no module
 * cache: process restarts, multiple replicas, and concurrent requests all observe the same durable
 * CAS/idempotency state under tenant/legal-entity RLS.
 */
import { Context, Effect, Option, Schema } from 'effect';
import {
  CoreSearchResourceRefSchema,
  DatabaseTransactionFailure,
  decodeDatabaseDriverFailure,
  defineScopedRoutine,
} from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';

import type { PurchaseApprovalSubmissionPort } from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
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
  ApprovalHierarchy,
  CreateApprovalHierarchyInput,
  ConsumePurchaseApprovalInput,
  CreatePurchaseProposalRevisionInput,
  DecidePurchaseApprovalRequestInput,
  RevalidatePurchaseApprovalInput,
  ReroutePurchaseApprovalRequestInput,
  SubmitPurchaseApprovalRequestInput,
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

const JsonValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);
const JsonObjectSchema = Schema.Record(Schema.String, JsonValueSchema);
type JsonObject = typeof JsonObjectSchema.Type;

const encodeJson = <A>(schema: Schema.Codec<unknown, unknown>, value: A): Effect.Effect<JsonObject> =>
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

const routineConstraintValues = [
  'pa_not_route_eligible',
  'pa_self_approval',
  'pa_request_not_pending',
  'pa_request_expired',
  'pa_proposal_material',
  'pa_buyer_denied',
  'pa_profile_inactive',
  'pa_policy_route',
  'pa_proposal_not_current',
  'pa_proposal_lineage',
  'pa_hierarchy_invalid',
  'pa_submit_revision',
  'pa_target_mismatch',
  'pa_scope',
  'pa_decision_actor',
  'pa_reroute_target',
  'pa_revalidation_target',
  'pa_request_snapshot_missing',
  'pa_reroute_snapshot_missing',
  'pa_revalidation_snapshot_missing',
  'pa_currentness_not_found',
  'pa_request_cas',
  'pa_reroute_cas',
  'pa_hierarchy_missing',
  'pa_reroute_hierarchy_missing',
  'pa_hierarchy_ambiguous',
  'pa_reroute_hierarchy_ambiguous',
  'pa_route_empty',
  'pa_reroute_route_empty',
  'pa_reroute_required',
  'pa_decision_reason_required',
  'pa_revalidation_expired',
  'pa_commitment_malformed',
  'pa_commitment_not_found',
  'pa_commitment_target',
  'pa_commitment_not_approved',
  'pa_commitment_conflict',
  'pa_commitment_cas',
] as const;
const RoutineConstraintSchema = Schema.Literals(routineConstraintValues);
type RoutineConstraint = typeof RoutineConstraintSchema.Type;
type RoutineConstraintFailure = () => PurchasingApprovalRejected;
const approvalTargetScopeMismatchReason = 'The persisted approval target does not match the trusted operation scope';
const approvalRequestSnapshotUnavailableReason = 'The persisted approval request snapshot is unavailable';

const paNotRouteEligible = () =>
  reject('NOT_ROUTE_ELIGIBLE', 'The actor is not eligible for the captured approval route level');
const paSelfApproval = () => reject('SELF_APPROVAL_DENIED', 'The captured approval hierarchy denies self approval');
const paRequestNotPending = () =>
  reject('REQUEST_NOT_PENDING', 'The approval request is not in a state that accepts this owner operation');
const paRequestExpired = () => reject('REQUEST_EXPIRED', 'The approval request validity window has expired');
const paProposalMaterial = () =>
  reject('PROPOSAL_MATERIAL_CHANGE', 'The approval request no longer matches its captured proposal revision');
const paBuyerDenied = () =>
  reject('BUYER_PERMISSION_DENIED', 'Current buyer authorization does not permit this approval');
const paProfileInactive = () => reject('PROFILE_INACTIVE', 'The purchasing profile is no longer active');
const paPolicyRoute = () => reject('POLICY_ROUTE_INVALID', 'The captured approval route is no longer current');
const paProposalNotCurrent = () =>
  reject('PROPOSAL_NOT_CURRENT', 'The purchase proposal revision is no longer current');
const paProposalLineage = () =>
  reject('IDEMPOTENCY_CONFLICT', 'The purchase proposal lineage already has a current revision');
const paHierarchyInvalid = () => reject('HIERARCHY_RANGE_INVALID', 'The Approval Hierarchy snapshot is invalid');
const paSubmitRevision = () =>
  reject('STALE_PROPOSAL_REVISION', 'Submission must name a positive immutable proposal revision');
const paTargetMismatch = () => reject('PERMISSION_DENIED', approvalTargetScopeMismatchReason);
const paScope = () => reject('PERMISSION_DENIED', approvalTargetScopeMismatchReason);
const paDecisionActor = () => reject('PERMISSION_DENIED', approvalTargetScopeMismatchReason);
const paRerouteTarget = () => reject('PERMISSION_DENIED', approvalTargetScopeMismatchReason);
const paRevalidationTarget = () => reject('PERMISSION_DENIED', approvalTargetScopeMismatchReason);
const paRequestSnapshotMissing = () =>
  reject('CURRENT_STATE_INDETERMINATE', approvalRequestSnapshotUnavailableReason, true);
const paRerouteSnapshotMissing = () =>
  reject('CURRENT_STATE_INDETERMINATE', approvalRequestSnapshotUnavailableReason, true);
const paRevalidationSnapshotMissing = () =>
  reject('CURRENT_STATE_INDETERMINATE', approvalRequestSnapshotUnavailableReason, true);
const paCurrentnessNotFound = () =>
  reject('CURRENT_STATE_INDETERMINATE', approvalRequestSnapshotUnavailableReason, true);
const paRequestCas = () =>
  reject('COMMIT_CONFLICT', 'The approval request changed concurrently; retry with fresh evidence', true);
const paRerouteCas = () =>
  reject('COMMIT_CONFLICT', 'The approval request changed concurrently; retry with fresh evidence', true);
const paHierarchyMissing = () =>
  reject('HIERARCHY_NOT_FOUND', 'No current Approval Hierarchy matches the proposal scope and value');
const paRerouteHierarchyMissing = () =>
  reject('HIERARCHY_NOT_FOUND', 'No current Approval Hierarchy matches the proposal scope and value');
const paHierarchyAmbiguous = () => reject('HIERARCHY_AMBIGUOUS', 'Approval Hierarchy selection is ambiguous');
const paRerouteHierarchyAmbiguous = () => reject('HIERARCHY_AMBIGUOUS', 'Approval Hierarchy selection is ambiguous');
const paRouteEmpty = () => reject('NO_ELIGIBLE_ROUTE', 'The selected Approval Hierarchy has no eligible route');
const paRerouteRouteEmpty = () => reject('NO_ELIGIBLE_ROUTE', 'The selected Approval Hierarchy has no eligible route');
const paRerouteRequired = () =>
  reject('NO_ELIGIBLE_ROUTE', 'The captured approval route requires a fresh current route before it can proceed');
const paDecisionReasonRequired = () =>
  reject('PERMISSION_DENIED', 'Return and reject decisions require a non-empty reason');
const paRevalidationExpired = () =>
  reject('REQUEST_EXPIRED', 'The owner revalidation evidence is outside the trusted validity window');
const paCommitmentMalformed = () =>
  reject('PROPOSAL_MATERIAL_CHANGE', 'The Order commitment evidence is malformed or incomplete');
const paCommitmentNotFound = () =>
  reject('CURRENT_STATE_INDETERMINATE', 'The approval request is unavailable for commitment', true);
const paCommitmentTarget = () =>
  reject('PERMISSION_DENIED', 'The Order commitment target does not match the trusted approval scope');
const paCommitmentNotApproved = () =>
  reject('COMMIT_CONFLICT', 'Only a current APPROVED request can be consumed by an Order commitment');
const paCommitmentConflict = () =>
  reject('COMMIT_CONFLICT', 'The approval is already committed to a different Order or commitment attempt');
const paCommitmentCas = () =>
  reject('COMMIT_CONFLICT', 'The approval changed concurrently; retry with fresh commitment evidence', true);

const routineConstraintFailures = {
  pa_buyer_denied: paBuyerDenied,
  pa_commitment_cas: paCommitmentCas,
  pa_commitment_conflict: paCommitmentConflict,
  pa_commitment_malformed: paCommitmentMalformed,
  pa_commitment_not_approved: paCommitmentNotApproved,
  pa_commitment_not_found: paCommitmentNotFound,
  pa_commitment_target: paCommitmentTarget,
  pa_currentness_not_found: paCurrentnessNotFound,
  pa_decision_actor: paDecisionActor,
  pa_decision_reason_required: paDecisionReasonRequired,
  pa_hierarchy_ambiguous: paHierarchyAmbiguous,
  pa_hierarchy_invalid: paHierarchyInvalid,
  pa_hierarchy_missing: paHierarchyMissing,
  pa_not_route_eligible: paNotRouteEligible,
  pa_policy_route: paPolicyRoute,
  pa_profile_inactive: paProfileInactive,
  pa_proposal_lineage: paProposalLineage,
  pa_proposal_material: paProposalMaterial,
  pa_proposal_not_current: paProposalNotCurrent,
  pa_request_cas: paRequestCas,
  pa_request_expired: paRequestExpired,
  pa_request_not_pending: paRequestNotPending,
  pa_request_snapshot_missing: paRequestSnapshotMissing,
  pa_reroute_cas: paRerouteCas,
  pa_reroute_hierarchy_ambiguous: paRerouteHierarchyAmbiguous,
  pa_reroute_hierarchy_missing: paRerouteHierarchyMissing,
  pa_reroute_required: paRerouteRequired,
  pa_reroute_route_empty: paRerouteRouteEmpty,
  pa_reroute_snapshot_missing: paRerouteSnapshotMissing,
  pa_reroute_target: paRerouteTarget,
  pa_revalidation_expired: paRevalidationExpired,
  pa_revalidation_snapshot_missing: paRevalidationSnapshotMissing,
  pa_revalidation_target: paRevalidationTarget,
  pa_route_empty: paRouteEmpty,
  pa_scope: paScope,
  pa_self_approval: paSelfApproval,
  pa_submit_revision: paSubmitRevision,
  pa_target_mismatch: paTargetMismatch,
} satisfies Readonly<Record<RoutineConstraint, RoutineConstraintFailure>>;

const mapRoutineConstraintFailure = (constraint: string | undefined): PurchasingApprovalRejected | undefined => {
  const knownConstraint = Option.getOrUndefined(Schema.decodeUnknownOption(RoutineConstraintSchema)(constraint));
  return knownConstraint === undefined ? undefined : routineConstraintFailures[knownConstraint]();
};

const mapRoutineFailure = (
  routine: ApprovalRoutine,
  failure: ScopedRoutineInvocationError,
): PurchasingApprovalRejected => {
  const constraintFailure = mapRoutineConstraintFailure(Option.getOrUndefined(failure.constraint));
  if (constraintFailure !== undefined) {
    return constraintFailure;
  }

  const postgresCode = Option.getOrUndefined(failure.postgresCode);
  const driverFailure = failure.postgresCode.pipe(Option.flatMap((code) => decodeDatabaseDriverFailure({ code })));
  if (Option.exists(driverFailure, Schema.is(DatabaseTransactionFailure))) {
    return reject(
      'COMMIT_CONFLICT',
      `Purchasing Approval ${routine.routineKey} observed a concurrent durable state change; retry with fresh evidence`,
      true,
    );
  }
  // ScopedRoutineInvocationError carries SQLSTATE metadata already decoded by Core. These two
  // owner-boundary branches preserve the existing idempotency and RLS mappings until Core exposes
  // typed tags for uniqueness and permission violations.
  // oxlint-disable-next-line effect-native/no-driver-failure-inspection -- Core has already decoded this SQLSTATE into the typed scoped-routine error; this owner maps its stable metadata to its public domain outcome. remove-when: ScopedRoutineInvocationError exposes DatabaseUniqueViolation.
  if (postgresCode === '23505') {
    if (routine.routineKey === 'purchasing-approval.consume') {
      return reject('COMMIT_CONFLICT', 'The approval is already committed to a different Order or commitment attempt');
    }
    return reject(
      'IDEMPOTENCY_CONFLICT',
      `Purchasing Approval ${routine.routineKey} idempotency key conflicts with durable state`,
    );
  }
  // oxlint-disable-next-line effect-native/no-driver-failure-inspection -- Core has already decoded this SQLSTATE into the typed scoped-routine error; this owner maps its stable metadata to its public domain outcome. remove-when: ScopedRoutineInvocationError exposes DatabasePermissionDenied.
  if (postgresCode === '42501') {
    return reject('PERMISSION_DENIED', approvalTargetScopeMismatchReason);
  }
  // Core deliberately sanitizes SQL exception text. Owner routines must therefore expose
  // stable constraint identifiers for every expected business outcome; never branch on the
  // sanitized reason or leak it to the Action boundary.
  return reject('EVIDENCE_PERSISTENCE_FAILED', `Purchasing Approval owner routine ${routine.routineKey} failed`, true);
};

const isCounterpartyRef = (ref: {
  readonly moduleId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): boolean => ref.moduleId === 'party.registry' && ref.resourceType === 'party.registry.counterparty';

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
  _scope: OperationalScope,
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
            reject('CURRENT_STATE_INDETERMINATE', 'Purchasing Approval owner routine returned no result', true),
          )
        : Schema.decodeEffect(resultSchema)(row.result).pipe(
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

const validateHierarchy = (hierarchy: ApprovalHierarchy, tenantId: string): PurchasingApprovalRejected | undefined => {
  const ordered = hierarchy.levels.toSorted((left, right) => left.order - right.order);
  if (
    ordered.some(
      (level, index) =>
        level.order !== index + 1 || level.completionRule !== 'ONE_APPROVER' || level.eligiblePrincipals.length === 0,
    )
  ) {
    return reject('HIERARCHY_RANGE_INVALID', 'Hierarchy levels must be ordered, contiguous, and non-empty');
  }
  if (ordered.some((level) => level.eligiblePrincipals.some((principal) => principal.tenantId !== tenantId))) {
    return reject('NO_ELIGIBLE_ROUTE', 'Hierarchy levels cannot include principals outside the trusted tenant');
  }
  if (
    hierarchy.selector.maximumPurchaseValue !== null &&
    hierarchy.selector.maximumPurchaseValue.currency === hierarchy.selector.minimumPurchaseValue.currency &&
    compareExactDecimals(
      hierarchy.selector.maximumPurchaseValue.amount,
      hierarchy.selector.minimumPurchaseValue.amount,
    ) < 0
  ) {
    return reject('HIERARCHY_RANGE_INVALID', 'Hierarchy value range is inverted');
  }
  return undefined;
};

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This owner-facing contract is supplied through the existing scoped factory rather than a standalone Context tag.
export interface PurchasingApprovalWorkflowService extends PurchaseApprovalSubmissionPort {
  readonly consume: (
    input: ConsumePurchaseApprovalInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof ConsumePurchaseApprovalResultSchema>, PurchasingApprovalRejected>;
  readonly createHierarchy: (
    input: CreateApprovalHierarchyInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof CreateApprovalHierarchyResultSchema>, PurchasingApprovalRejected>;
  readonly createProposal: (
    input: CreatePurchaseProposalRevisionInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof CreatePurchaseProposalRevisionResultSchema>, PurchasingApprovalRejected>;
  readonly decide: (
    input: DecidePurchaseApprovalRequestInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof DecidePurchaseApprovalRequestResultSchema>, PurchasingApprovalRejected>;
  readonly forActionInvocation: (actionInvocationId: string) => PurchasingApprovalWorkflowService;
  readonly reroute: (
    input: ReroutePurchaseApprovalRequestInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof ReroutePurchaseApprovalRequestResultSchema>, PurchasingApprovalRejected>;
  readonly revalidate: (
    input: RevalidatePurchaseApprovalInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof RevalidatePurchaseApprovalResultSchema>, PurchasingApprovalRejected>;
  readonly submitRequest: (
    input: SubmitPurchaseApprovalRequestInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof SubmitPurchaseApprovalRequestResultSchema>, PurchasingApprovalRejected>;
}

export interface PurchasingApprovalWorkflowFactoryContract {
  readonly make: (
    transaction: PurchasingApprovalScopedRoutineInvoker,
    scope: OperationalScope,
  ) => Effect.Effect<PurchasingApprovalWorkflowService>;
}
export class PurchasingApprovalWorkflowFactory extends Context.Service<
  PurchasingApprovalWorkflowFactory,
  PurchasingApprovalWorkflowFactoryContract
>()('@app/commerce-customer-context/persistence/purchasing-approval-persistence/PurchasingApprovalWorkflowFactory') {}

const dependencyUnavailable = (reason: string) => ({
  _tag: 'PurchaseApprovalDependencyUnavailable' as const,
  code: 'purchase_approval_dependency_unavailable' as const,
  dependency: 'PURCHASING_APPROVAL' as const,
  reason,
  retryable: true as const,
});

type PurchaseProposal = CreatePurchaseProposalRevisionInput['proposal'];
type PurchaseProposalEvidence = CreatePurchaseProposalRevisionInput['verifiedEvidence'];

const proposalIdentityMatchesTrustedScope = (proposal: PurchaseProposal, scope: OperationalScope): boolean =>
  proposal.proposalRevisionRef.tenantId === scope.tenantId &&
  proposal.context.tenantId === scope.tenantId &&
  proposal.context.sellingLegalEntityId === scope.legalEntityId &&
  proposal.identity.buyer.tenantId === scope.tenantId &&
  proposal.identity.buyer.principalId === scope.principalId &&
  isCounterpartyRef(proposal.identity.counterpartyRef) &&
  proposal.identity.counterpartyRef.tenantId === scope.tenantId &&
  proposal.identity.profileRef.tenantId === scope.tenantId;

const proposalCartMatchesTrustedScope = (proposal: PurchaseProposal, scope: OperationalScope): boolean =>
  proposal.sourceCart.cartRef.moduleId === 'commerce.cart' &&
  proposal.sourceCart.cartRef.resourceType === 'commerce.cart.cart' &&
  proposal.sourceCart.cartRef.tenantId === scope.tenantId;

const proposalMatchesTrustedScope = (proposal: PurchaseProposal, scope: OperationalScope): boolean =>
  proposalIdentityMatchesTrustedScope(proposal, scope) && proposalCartMatchesTrustedScope(proposal, scope);

const proposalReferencesAreConsistent = (proposal: PurchaseProposal): boolean =>
  proposal.hierarchyInputs.counterpartyRef.resourceId === proposal.identity.counterpartyRef.resourceId &&
  proposal.hierarchyInputs.counterpartyRef.tenantId === proposal.identity.counterpartyRef.tenantId &&
  proposal.hierarchyInputs.storefrontId === proposal.context.storefrontId &&
  proposal.approvalEvaluation === 'APPROVAL_REQUIRED' &&
  proposal.hierarchyInputs.purchaseValue.amount === proposal.purchaseValue.monetaryAmount.amount &&
  proposal.hierarchyInputs.purchaseValue.currency === proposal.purchaseValue.monetaryAmount.currency;

const hasSingleSourceRevision = (
  evidence: PurchaseProposalEvidence,
  source: PurchaseProposalEvidence['sourceRevisions'][number]['source'],
  expectedRevision?: string,
): boolean => {
  const revisions = evidence.sourceRevisions.filter((revision) => revision.source === source);
  const [revision] = revisions;
  return revisions.length === 1 && revision !== undefined && revision.revision === expectedRevision;
};

const purchasingProfileSource = 'purchasing-profile';

const verifiedProposalEvidenceMatches = (proposal: PurchaseProposal, evidence: PurchaseProposalEvidence): boolean =>
  evidence.proposalCurrent &&
  evidence.buyerPermission === 'ALLOWED' &&
  evidence.profileState === 'ACTIVE' &&
  hasSingleSourceRevision(evidence, 'purchase-proposal', proposal.purchaseValue.sourceRevision) &&
  hasSingleSourceRevision(
    evidence,
    purchasingProfileSource,
    evidence.sourceRevisions.find(({ source }) => source === purchasingProfileSource)?.revision,
  ) &&
  evidence.sourceRevisions.find(({ source }) => source === purchasingProfileSource)?.revision.length !== 0;

const proposalIsCurrentForScope = (input: CreatePurchaseProposalRevisionInput, scope: OperationalScope): boolean =>
  proposalMatchesTrustedScope(input.proposal, scope) &&
  proposalReferencesAreConsistent(input.proposal) &&
  verifiedProposalEvidenceMatches(input.proposal, input.verifiedEvidence);

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- Transaction, trusted scope, and optional Action invocation id are cohesive workflow-instance data without a separate owner contract.
const makeWorkflow = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
  actionInvocationId?: string,
): PurchasingApprovalWorkflowService => {
  const createProposal = Effect.fn('makeWorkflow.createProposal')(function* createProposalEffect(
    input: CreatePurchaseProposalRevisionInput,
  ) {
    if (!proposalIsCurrentForScope(input, scope)) {
      return yield* reject(
        'PROPOSAL_NOT_CURRENT',
        'Verified buyer, profile, policy, currency, and proposal currentness evidence does not match the candidate',
      );
    }
    if (computePurchaseProposalCanonicalHash(input.proposal) !== input.proposal.canonicalHash) {
      return yield* reject('STALE_PROPOSAL_REVISION', 'Proposal canonical hash does not match the immutable snapshot');
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

  const createHierarchy = Effect.fn('makeWorkflow.createHierarchy')(function* createHierarchyEffect(
    input: CreateApprovalHierarchyInput,
  ) {
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

  const submitRequestWithInvocation = Effect.fn('makeWorkflow.submitRequestWithInvocation')(
    function* submitRequestEffect(input: SubmitPurchaseApprovalRequestInput, invocationId: string | undefined) {
      const encoded = yield* encodeJson(SubmitPurchaseApprovalRequestInputSchema, input);
      return yield* invokeRoutine(
        transaction,
        scope,
        submitRequestRoutine,
        withOwnerMetadata(encoded, scope, invocationId),
        SubmitPurchaseApprovalRequestResultSchema,
      );
    },
  );
  const submitRequest = (input: SubmitPurchaseApprovalRequestInput) =>
    submitRequestWithInvocation(input, actionInvocationId);

  const decide = Effect.fn('makeWorkflow.decide')(function* decideEffect(input: DecidePurchaseApprovalRequestInput) {
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

  const reroute = Effect.fn('makeWorkflow.reroute')(function* rerouteEffect(
    input: ReroutePurchaseApprovalRequestInput,
  ) {
    const encoded = yield* encodeJson(ReroutePurchaseApprovalRequestInputSchema, input);
    return yield* invokeRoutine(
      transaction,
      scope,
      rerouteRoutine,
      withOwnerMetadata(encoded, scope, actionInvocationId),
      ReroutePurchaseApprovalRequestResultSchema,
    );
  });

  const revalidate = Effect.fn('makeWorkflow.revalidate')(function* revalidateEffect(
    input: RevalidatePurchaseApprovalInput,
  ) {
    const encoded = yield* encodeJson(RevalidatePurchaseApprovalInputSchema, input);
    return yield* invokeRoutine(
      transaction,
      scope,
      revalidateRoutine,
      withOwnerMetadata(encoded, scope, actionInvocationId),
      RevalidatePurchaseApprovalResultSchema,
    );
  });

  const consume = Effect.fn('makeWorkflow.consume')(function* consumeEffect(input: ConsumePurchaseApprovalInput) {
    const encoded = yield* encodeJson(ConsumePurchaseApprovalInputSchema, input);
    return yield* invokeRoutine(
      transaction,
      scope,
      consumeRoutine,
      withOwnerMetadata(encoded, scope, actionInvocationId),
      ConsumePurchaseApprovalResultSchema,
    );
  });

  const submit: PurchaseApprovalSubmissionPort['submit'] = Effect.fn('makeWorkflow.submit')(function* submit(input) {
    return yield* Effect.gen(function* submitEffect() {
      const proposalRevision = Number(input.proposalEvidence.revision);
      if (!Number.isSafeInteger(proposalRevision) || proposalRevision < 1) {
        return yield* Effect.fail(
          dependencyUnavailable('The current Purchase Proposal evidence does not carry a valid immutable revision'),
        );
      }
      const counterpartyRef = yield* Schema.decodeEffect(CoreSearchResourceRefSchema)(
        input.profileEvidence.counterpartyRef,
      ).pipe(
        // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Any schema failure here maps to the established dependency-unavailable boundary without exposing decoder internals.
        Effect.mapError(() =>
          dependencyUnavailable('The current Purchase Profile evidence has an invalid Counterparty reference'),
        ),
      );
      if (actionInvocationId === undefined) {
        return yield* Effect.fail(
          dependencyUnavailable('Purchasing Approval submission requires the Core Action invocation context'),
        );
      }
      const result = yield* submitRequestWithInvocation(
        {
          counterpartyRef,
          idempotencyKey: input.idempotencyKey,
          proposalRevision,
          proposalRevisionRef: {
            moduleId: MODULE_KEY,
            resourceId: input.proposalEvidence.proposalRevisionRef,
            resourceType: `${MODULE_KEY}.purchase-proposal-revision`,
            tenantId: scope.tenantId,
          },
          // The SQL owner routine ignores this caller-provided value and uses the persisted proposal's
          // immutable expiresAt. It remains present for the public #305 adapter shape.
          requestExpiresAt: input.proposalEvidence.evaluatedAt,
          storefrontId: input.proposalEvidence.evaluationContext.storefrontId,
        },
        actionInvocationId,
      );
      return {
        _tag:
          result.outcome === 'SUBMITTED' ? ('APPROVAL_SUBMITTED' as const) : ('APPROVAL_ALREADY_SUBMITTED' as const),
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
          : Effect.fail(dependencyUnavailable(`Purchasing Approval submission failed: ${failure.code}`)),
      ),
    );
  });

  return {
    consume,
    createHierarchy,
    createProposal,
    decide,
    forActionInvocation: (invocationId) => makeWorkflow(transaction, scope, invocationId),
    reroute,
    revalidate,
    submit,
    submitRequest,
  };
};

export const purchasingApprovalWorkflowForScope = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PurchasingApprovalWorkflowService> => Effect.succeed(makeWorkflow(transaction, scope));
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
): Effect.Effect<PurchaseApprovalOrderCommitmentPort> =>
  Effect.succeed({
    consume: (input, actionInvocationId) => makeWorkflow(transaction, scope, actionInvocationId).consume(input),
  });

/** Compatibility seam for callers outside an Action factory. It is intentionally fail-closed. */
export const purchasingApprovalSubmissionLive: PurchaseApprovalSubmissionPort = {
  submit: () => Effect.fail(dependencyUnavailable('A scoped Purchasing Approval transaction is required')),
};
export const purchasingApprovalSubmissionForScope = (
  transaction: PurchasingApprovalScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PurchaseApprovalSubmissionPort> => Effect.succeed(makeWorkflow(transaction, scope));

export const purchasingApprovalWorkflowSchemas = {
  consumeInput: ConsumePurchaseApprovalInputSchema,
  consumeResult: ConsumePurchaseApprovalResultSchema,
  decision: ApprovalDecisionSchema,
  hierarchy: ApprovalHierarchySchema,
  proposal: PurchaseProposalRevisionSchema,
  request: PurchaseApprovalRequestSchema,
  revalidation: ApprovalRevalidationSchema,
  route: ApprovalRouteSchema,
};
