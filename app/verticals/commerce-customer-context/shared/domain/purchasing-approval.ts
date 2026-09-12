import { createHash } from 'node:crypto';

import { CoreSearchResourceRefSchema, PrincipalRefSchema } from '@app/core-runtime';
import type { CoreSearchResourceRef, PrincipalRef } from '@app/core-runtime';
import { DateTime, Result, Schema } from 'effect';

import { PurchaseApprovalRequestRefSchema } from '../resources/purchase-approval-request.ts';
import { ApprovalDecisionRefSchema } from '../resources/approval-decision.ts';
import { ApprovalHierarchyRefSchema } from '../resources/approval-hierarchy.ts';
import { ApprovalRevalidationRefSchema } from '../resources/approval-revalidation.ts';
import { ApprovalRouteRefSchema } from '../resources/approval-route.ts';
import { PurchaseProposalRevisionRefSchema } from '../resources/purchase-proposal-revision.ts';
import { HistoricalRecordRefSchema } from './record-visibility-contracts.ts';
import { MonetaryAmountSchema, PurchaseValueSchema, compareExactDecimals } from './purchase-limit.ts';
// oxlint-disable-next-line eslint/no-unused-vars -- PurchaseValue remains reserved beside the retained purchase-value contract helpers.
import type { MonetaryAmount, PurchaseValue } from './purchase-limit.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from './purchase-limit-evaluation.ts';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const shortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const revision = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const instant = Schema.DateTimeUtcFromString;
const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const ChannelIdSchema = shortText.pipe(Schema.brand('ChannelId'), Schema.decodeTo(Schema.String));
const MarketIdSchema = shortText.pipe(Schema.brand('MarketId'), Schema.decodeTo(Schema.String));
const SellingLegalEntityIdSchema = shortText.pipe(Schema.brand('SellingLegalEntityId'), Schema.decodeTo(Schema.String));
export const StorefrontIdSchema = shortText.pipe(Schema.brand('StorefrontId'), Schema.decodeTo(Schema.String));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('TenantId'),
  Schema.decodeTo(Schema.String),
);
const LineIdSchema = shortText.pipe(Schema.brand('LineId'), Schema.decodeTo(Schema.String));
const LevelIdSchema = shortText.pipe(Schema.brand('LevelId'), Schema.decodeTo(Schema.String));
const IdempotencyKeySchema = shortText.pipe(Schema.brand('IdempotencyKey'), Schema.decodeTo(Schema.String));
export const CommitmentCorrelationIdSchema = shortText.pipe(
  Schema.brand('CommitmentCorrelationId'),
  Schema.decodeTo(Schema.String),
);
const BuyerPermissionSchema = Schema.Literals(['ALLOWED', 'DENIED']);
const ProfileStateSchema = Schema.Literals(['ACTIVE', 'INACTIVE']);
export const DecisionBundleVersionSchema = Schema.Literal('approval-decision-bundle.v1');
const CreationOutcomeSchema = Schema.Literals(['CREATED', 'ALREADY_EXISTS']);
const ConsumptionOutcomeSchema = Schema.Literals(['CONSUMED', 'ALREADY_CONSUMED']);

/**
 * The Order owner publishes the generic historical-record reference shape, with this exact
 * owner/type pair for an accepted Order.  Keeping the canonical shape and constraining only the
 * published identity prevents the commitment seam from accepting a Cart or another Order-owned
 * record by accident.
 */
export const OrderResourceRefSchema = HistoricalRecordRefSchema.check(
  Schema.makeFilter((ref) =>
    ref.moduleId === 'commerce.order' && ref.resourceType === 'commerce.order.order'
      ? undefined
      : 'the commitment target must be the canonical commerce.order.order ResourceRef',
  ),
);
const ApprovalProductConfigurationSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(ApprovalProductConfigurationSchema),
    Schema.Record(Schema.String, ApprovalProductConfigurationSchema),
  ]),
);

const ApprovalContextSchema = Schema.Struct({
  channelId: ChannelIdSchema,
  evaluatedAt: instant,
  locale: shortText,
  marketId: MarketIdSchema,
  sellingLegalEntityId: SellingLegalEntityIdSchema,
  storefrontId: StorefrontIdSchema,
  tenantId: TenantIdSchema,
});

const ApprovalProductLineSchema = Schema.Struct({
  configuration: Schema.Record(Schema.String, ApprovalProductConfigurationSchema),
  discount: MonetaryAmountSchema,
  fees: Schema.Array(MonetaryAmountSchema).check(Schema.isMaxLength(50)),
  lineId: LineIdSchema,
  lineTotal: MonetaryAmountSchema,
  pricingRuleRevision: revision,
  productRef: CoreSearchResourceRefSchema,
  quantity: positiveInteger,
  tax: MonetaryAmountSchema,
  unitPrice: MonetaryAmountSchema,
});

const ApprovalDestinationSchema = Schema.Struct({
  address: Schema.Record(Schema.String, Schema.String),
  kind: Schema.Literals(['DELIVERY', 'INVOICE']),
  method: shortText,
  recipientRef: Schema.optionalKey(CoreSearchResourceRefSchema),
});

export const PurchaseProposalRevisionSchema = Schema.Struct({
  approvalEvaluation: Schema.Literals(['APPROVAL_REQUIRED', 'WITHIN_LIMIT']),
  approvalTrigger: Schema.Struct({
    policyRevision: revision,
    reasonCode: shortText,
    source: Schema.Literals(['PURCHASE_LIMIT', 'EXPLICIT_POLICY']),
  }),
  canonicalHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  canonicalizationVersion: Schema.Literal('purchase-proposal.v1'),
  context: ApprovalContextSchema,
  createdAt: instant,
  currency: shortText,
  deliveryDestination: ApprovalDestinationSchema,
  effectiveLimit: Schema.Union([MonetaryAmountSchema, Schema.Null]),
  expiresAt: instant,
  hierarchyInputs: Schema.Struct({
    counterpartyRef: CoreSearchResourceRefSchema,
    evaluatedAt: instant,
    purchaseValue: MonetaryAmountSchema,
    storefrontId: StorefrontIdSchema,
  }),
  identity: Schema.Struct({
    buyer: PrincipalRefSchema,
    counterpartyRef: CoreSearchResourceRefSchema,
    profileRef: CoreSearchResourceRefSchema,
  }),
  invoiceRecipient: ApprovalDestinationSchema,
  lines: Schema.Array(ApprovalProductLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  payment: Schema.Literal('NONE'),
  paymentTerm: Schema.Struct({
    code: shortText,
    definitionRef: CoreSearchResourceRefSchema,
    definitionRevision: revision,
  }),
  policyRefs: Schema.Array(CoreSearchResourceRefSchema).check(Schema.isMaxLength(100)),
  pricingRevision: revision,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  proposalSequence: positiveInteger,
  purchaseValue: PurchaseValueSchema,
  reservation: Schema.Literal('NONE'),
  revision: positiveInteger,
  sourceCart: Schema.Struct({
    cartRef: CoreSearchResourceRefSchema,
    revision,
  }),
  state: Schema.Literals(['CURRENT', 'SUPERSEDED', 'CONSUMED', 'CANCELLED']),
  taxRevision: revision,
  totals: Schema.Struct({
    discount: MonetaryAmountSchema,
    fees: Schema.Array(MonetaryAmountSchema).check(Schema.isMaxLength(50)),
    shipping: MonetaryAmountSchema,
    subtotal: MonetaryAmountSchema,
    tax: MonetaryAmountSchema,
    total: MonetaryAmountSchema,
  }),
});
export type PurchaseProposalRevision = typeof PurchaseProposalRevisionSchema.Type;

const ApprovalHierarchyLevelSchema = Schema.Struct({
  completionRule: Schema.Literal('ONE_APPROVER'),
  eligiblePrincipals: Schema.Array(PrincipalRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  levelId: LevelIdSchema,
  order: positiveInteger,
  scopeConstraints: Schema.Array(shortText).check(Schema.isMaxLength(50)),
});
type ApprovalHierarchyLevel = typeof ApprovalHierarchyLevelSchema.Type;

export const ApprovalHierarchySchema = Schema.Struct({
  createdAt: instant,
  effectiveFrom: instant,
  effectiveTo: Schema.Union([instant, Schema.Null]),
  hierarchyRef: ApprovalHierarchyRefSchema,
  levels: Schema.Array(ApprovalHierarchyLevelSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  ownerPrincipal: PrincipalRefSchema,
  reason: text,
  revision: positiveInteger,
  selector: Schema.Struct({
    counterpartyRef: CoreSearchResourceRefSchema,
    maximumPurchaseValue: Schema.Union([MonetaryAmountSchema, Schema.Null]),
    minimumPurchaseValue: MonetaryAmountSchema,
    storefrontId: Schema.Union([StorefrontIdSchema, Schema.Null]),
  }),
  selfApprovalPolicy: Schema.Literals(['DENY', 'ALLOW']),
  state: Schema.Literal('ACTIVE'),
});
export type ApprovalHierarchy = typeof ApprovalHierarchySchema.Type;

const ApprovalRouteLevelSchema = Schema.Struct({
  candidates: Schema.Array(PrincipalRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  completedAt: Schema.Union([instant, Schema.Null]),
  completedBy: Schema.Union([PrincipalRefSchema, Schema.Null]),
  completionRule: Schema.Literal('ONE_APPROVER'),
  levelId: LevelIdSchema,
  order: positiveInteger,
});
type ApprovalRouteLevel = typeof ApprovalRouteLevelSchema.Type;

export const ApprovalRouteSchema = Schema.Struct({
  capturedAt: instant,
  currentLevelOrder: positiveInteger,
  hierarchyRef: ApprovalHierarchyRefSchema,
  hierarchyRevision: positiveInteger,
  levels: Schema.Array(ApprovalRouteLevelSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  rerouteReason: Schema.Union([shortText, Schema.Null]),
  routeRef: ApprovalRouteRefSchema,
  status: Schema.Literals(['PENDING', 'APPROVED', 'REROUTE_REQUIRED', 'SUPERSEDED']),
});
type ApprovalRoute = typeof ApprovalRouteSchema.Type;

export const PurchaseApprovalRequestSchema = Schema.Struct({
  consumedAt: Schema.Union([instant, Schema.Null]),
  expiresAt: instant,
  idempotencyKey: IdempotencyKeySchema,
  proposal: PurchaseProposalRevisionSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  requestRevision: positiveInteger,
  route: ApprovalRouteSchema,
  status: Schema.Literals([
    'PENDING',
    'APPROVED',
    'RETURNED',
    'REJECTED',
    'CANCELLED',
    'EXPIRED',
    'SUPERSEDED',
    'CONSUMED',
  ]),
  submittedAt: instant,
  /** Set only by the owner consume/reconciliation routine after Order commit is proven. */
  committedOrderRef: Schema.Union([CoreSearchResourceRefSchema, Schema.Null]),
  consumptionCommitmentId: Schema.Union([shortText, Schema.Null]),
  decisionBundleHash: Schema.Union([sha256, Schema.Null]),
  decisionBundleVersion: Schema.Union([shortText, Schema.Null]),
  lastDecisionRef: Schema.Union([ApprovalDecisionRefSchema, Schema.Null]),
});
export type PurchaseApprovalRequest = typeof PurchaseApprovalRequestSchema.Type;

const ApprovalDecisionKindSchema = Schema.Literals(['APPROVE', 'RETURN', 'REJECT']);
type ApprovalDecisionKind = typeof ApprovalDecisionKindSchema.Type;

export const ApprovalDecisionSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  decisionBundleHash: sha256,
  decisionBundleVersion: DecisionBundleVersionSchema,
  decisionRef: ApprovalDecisionRefSchema,
  hierarchyRef: ApprovalHierarchyRefSchema,
  hierarchyRevision: positiveInteger,
  idempotencyKey: IdempotencyKeySchema,
  kind: ApprovalDecisionKindSchema,
  levelOrder: positiveInteger,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  reason: Schema.Union([text, Schema.Null]),
  recordedAt: instant,
  requestRef: PurchaseApprovalRequestRefSchema,
  requestRevision: positiveInteger,
  routeRef: ApprovalRouteRefSchema,
}).check(
  Schema.makeFilter(({ kind, reason }) =>
    (kind === 'RETURN' || kind === 'REJECT') && (reason === null || reason.trim().length === 0)
      ? 'Return and reject decisions require a non-empty reason'
      : undefined,
  ),
);

export const ApprovalRevalidationSchema = Schema.Struct({
  approvedRoute: ApprovalRouteSchema,
  checkedAt: instant,
  committedOrderRef: Schema.Union([CoreSearchResourceRefSchema, Schema.Null]),
  evidence: Schema.Struct({
    buyerPermission: BuyerPermissionSchema,
    commitmentCorrelationId: CommitmentCorrelationIdSchema,
    decisionBundleHash: sha256,
    decisionBundleVersion: DecisionBundleVersionSchema,
    decisionRef: ApprovalDecisionRefSchema,
    hierarchyRef: ApprovalHierarchyRefSchema,
    policyRouteCurrent: Schema.Boolean,
    profileState: ProfileStateSchema,
    proposalHash: sha256,
    routeRef: ApprovalRouteRefSchema,
    sourceRevisions: Schema.Array(Schema.Struct({ revision, source: shortText })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  revalidationRef: ApprovalRevalidationRefSchema,
  status: Schema.Literals(['APPROVAL_VALID', 'ALREADY_CONSUMED', 'INVALID']),
  validUntil: instant,
});

export const CreatePurchaseProposalRevisionInputSchema = Schema.Struct({
  idempotencyKey: IdempotencyKeySchema,
  proposal: PurchaseProposalRevisionSchema,
  verifiedEvidence: Schema.Struct({
    buyerPermission: Schema.Literal('ALLOWED'),
    profileState: Schema.Literal('ACTIVE'),
    proposalCurrent: Schema.Literal(true),
    sourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
  }),
});
export type CreatePurchaseProposalRevisionInput = typeof CreatePurchaseProposalRevisionInputSchema.Type;

export const SubmitPurchaseApprovalRequestInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  /** Binds submission to one immutable proposal revision; the ref alone is not a revision key. */
  idempotencyKey: IdempotencyKeySchema,
  proposalRevision: positiveInteger,
  requestExpiresAt: instant,
  storefrontId: StorefrontIdSchema,
});
export type SubmitPurchaseApprovalRequestInput = typeof SubmitPurchaseApprovalRequestInputSchema.Type;

export const CreateApprovalHierarchyInputSchema = Schema.Struct({
  hierarchy: ApprovalHierarchySchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type CreateApprovalHierarchyInput = typeof CreateApprovalHierarchyInputSchema.Type;

export const DecidePurchaseApprovalRequestInputSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  counterpartyRef: CoreSearchResourceRefSchema,
  decidedAt: instant,
  decision: ApprovalDecisionKindSchema,
  expectedRequestRevision: positiveInteger,
  idempotencyKey: IdempotencyKeySchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  reason: Schema.Union([text, Schema.Null]),
  requestRef: PurchaseApprovalRequestRefSchema,
  storefrontId: StorefrontIdSchema,
}).check(
  Schema.makeFilter(({ decision, reason }) =>
    (decision === 'RETURN' || decision === 'REJECT') && (reason === null || reason.trim().length === 0)
      ? 'Return and reject decisions require a non-empty reason'
      : undefined,
  ),
);
export type DecidePurchaseApprovalRequestInput = typeof DecidePurchaseApprovalRequestInputSchema.Type;

export const ReroutePurchaseApprovalRequestInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  expectedRequestRevision: positiveInteger,
  idempotencyKey: IdempotencyKeySchema,
  reason: text,
  requestRef: PurchaseApprovalRequestRefSchema,
  reroutedAt: instant,
  storefrontId: StorefrontIdSchema,
});
export type ReroutePurchaseApprovalRequestInput = typeof ReroutePurchaseApprovalRequestInputSchema.Type;

export const RevalidatePurchaseApprovalInputSchema = Schema.Struct({
  buyerPermission: BuyerPermissionSchema,
  checkedAt: instant,
  commitmentCorrelationId: CommitmentCorrelationIdSchema,
  counterpartyRef: CoreSearchResourceRefSchema,
  decisionBundleHash: sha256,
  decisionBundleVersion: DecisionBundleVersionSchema,
  decisionRef: ApprovalDecisionRefSchema,
  expectedProposalHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  hierarchyRef: ApprovalHierarchyRefSchema,
  idempotencyKey: IdempotencyKeySchema,
  profileState: ProfileStateSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  routeCurrent: Schema.Boolean,
  routeRef: ApprovalRouteRefSchema,
  sourceRevisions: Schema.Array(Schema.Struct({ revision, source: shortText })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  storefrontId: StorefrontIdSchema,
  validUntil: instant,
});
export type RevalidatePurchaseApprovalInput = typeof RevalidatePurchaseApprovalInputSchema.Type;

/** Order-owner reconciliation seam. It is the only operation that can move an approved request
 * to CONSUMED, and it requires the exact proposal/decision bundle/commitment identity and the
 * committed Order reference. The Order owner remains authoritative for commit mechanics. */
export const ConsumePurchaseApprovalInputSchema = Schema.Struct({
  commitmentCorrelationId: CommitmentCorrelationIdSchema,
  committedAt: instant,
  counterpartyRef: CoreSearchResourceRefSchema,
  decisionBundleHash: sha256,
  decisionBundleVersion: DecisionBundleVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
  orderRef: OrderResourceRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  storefrontId: StorefrontIdSchema,
});
export type ConsumePurchaseApprovalInput = typeof ConsumePurchaseApprovalInputSchema.Type;

export const ConsumePurchaseApprovalResultSchema = Schema.Struct({
  outcome: ConsumptionOutcomeSchema,
  request: PurchaseApprovalRequestSchema,
});
export type ConsumePurchaseApprovalResult = typeof ConsumePurchaseApprovalResultSchema.Type;

const PurchaseApprovalFailureCodeSchema = Schema.Literals([
  'PERMISSION_DENIED',
  'NOT_ROUTE_ELIGIBLE',
  'SELF_APPROVAL_DENIED',
  'REQUEST_NOT_PENDING',
  'LEVEL_ALREADY_COMPLETED',
  'REQUEST_EXPIRED',
  'REQUEST_SUPERSEDED',
  'STALE_PROPOSAL_REVISION',
  'IDEMPOTENCY_CONFLICT',
  'EVIDENCE_PERSISTENCE_FAILED',
  'HIERARCHY_NOT_FOUND',
  'HIERARCHY_AMBIGUOUS',
  'HIERARCHY_RANGE_INVALID',
  'NO_ELIGIBLE_ROUTE',
  'PROPOSAL_NOT_CURRENT',
  'PROPOSAL_MATERIAL_CHANGE',
  'BUYER_PERMISSION_DENIED',
  'PROFILE_INACTIVE',
  'POLICY_ROUTE_INVALID',
  'OWNER_CONFIRMATION_EXPIRED',
  'COMMIT_CONFLICT',
  'CURRENT_STATE_INDETERMINATE',
  'DEPENDENCY_UNAVAILABLE',
]);

export class PurchasingApprovalRejected extends Schema.TaggedError<PurchasingApprovalRejected>()(
  'PurchasingApprovalRejected',
  {
    code: PurchaseApprovalFailureCodeSchema,
    reason: text,
    retryable: Schema.Boolean,
  },
) {}

export const CreatePurchaseProposalRevisionResultSchema = Schema.Struct({
  outcome: CreationOutcomeSchema,
  proposal: PurchaseProposalRevisionSchema,
});
export type CreatePurchaseProposalRevisionResult = typeof CreatePurchaseProposalRevisionResultSchema.Type;

export const SubmitPurchaseApprovalRequestResultSchema = Schema.Struct({
  outcome: Schema.Literals(['SUBMITTED', 'ALREADY_SUBMITTED']),
  request: PurchaseApprovalRequestSchema,
});
export type SubmitPurchaseApprovalRequestResult = typeof SubmitPurchaseApprovalRequestResultSchema.Type;

export const CreateApprovalHierarchyResultSchema = Schema.Struct({
  hierarchy: ApprovalHierarchySchema,
  outcome: CreationOutcomeSchema,
});
export type CreateApprovalHierarchyResult = typeof CreateApprovalHierarchyResultSchema.Type;

export const DecidePurchaseApprovalRequestResultSchema = Schema.Struct({
  decision: ApprovalDecisionSchema,
  outcome: Schema.Literals(['DECISION_RECORDED', 'ALREADY_RECORDED']),
  request: PurchaseApprovalRequestSchema,
});
export type DecidePurchaseApprovalRequestResult = typeof DecidePurchaseApprovalRequestResultSchema.Type;

export const ReroutePurchaseApprovalRequestResultSchema = Schema.Struct({
  outcome: Schema.Literals(['REROUTED', 'REROUTE_REQUIRED']),
  request: PurchaseApprovalRequestSchema,
  route: ApprovalRouteSchema,
});
export type ReroutePurchaseApprovalRequestResult = typeof ReroutePurchaseApprovalRequestResultSchema.Type;

export const RevalidatePurchaseApprovalResultSchema = Schema.Struct({
  outcome: Schema.Literals(['APPROVAL_VALID', 'ALREADY_CONSUMED']),
  revalidation: ApprovalRevalidationSchema,
});
export type RevalidatePurchaseApprovalResult = typeof RevalidatePurchaseApprovalResultSchema.Type;

const sameResourceRef = (left: CoreSearchResourceRef, right: CoreSearchResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const {
  canonicalHash: _canonicalHash,
  state: _state,
  ...canonicalPurchaseProposalFields
} = PurchaseProposalRevisionSchema.fields;
const canonicalPurchaseProposalJsonSchema = Schema.fromJsonString(Schema.Struct(canonicalPurchaseProposalFields));

/** Stable JSON representation used for the proposal hash and idempotency evidence. */
const canonicalizePurchaseProposal = (proposal: PurchaseProposalRevision): string =>
  Result.getOrThrow(Schema.encodeResult(canonicalPurchaseProposalJsonSchema)(proposal));

/** Deterministic, lowercase SHA-256 hash of the canonical proposal snapshot. */
export const computePurchaseProposalCanonicalHash = (proposal: PurchaseProposalRevision): string =>
  createHash('sha256').update(canonicalizePurchaseProposal(proposal)).digest('hex');

const monetaryRangeContains = (value: MonetaryAmount, selector: ApprovalHierarchy['selector']): boolean => {
  if (value.currency !== selector.minimumPurchaseValue.currency) {
    return false;
  }
  if (compareExactDecimals(value.amount, selector.minimumPurchaseValue.amount) < 0) {
    return false;
  }
  return (
    selector.maximumPurchaseValue === null ||
    (selector.maximumPurchaseValue.currency === value.currency &&
      compareExactDecimals(value.amount, selector.maximumPurchaseValue.amount) <= 0)
  );
};

const hierarchyIsEffective = (
  hierarchy: ApprovalHierarchy,
  input: {
    readonly at: typeof instant.Type;
    readonly counterpartyRef: CoreSearchResourceRef;
    readonly purchaseValue: MonetaryAmount;
    readonly storefrontId: string;
  },
): boolean =>
  sameResourceRef(hierarchy.selector.counterpartyRef, input.counterpartyRef) &&
  (hierarchy.selector.storefrontId === null || hierarchy.selector.storefrontId === input.storefrontId) &&
  monetaryRangeContains(input.purchaseValue, hierarchy.selector) &&
  DateTime.toEpochMillis(hierarchy.effectiveFrom) <= DateTime.toEpochMillis(input.at) &&
  (hierarchy.effectiveTo === null || DateTime.toEpochMillis(input.at) < DateTime.toEpochMillis(hierarchy.effectiveTo));

const ApprovalHierarchyResolvedSchema = Schema.TaggedStruct('HIERARCHY_RESOLVED', {
  hierarchy: ApprovalHierarchySchema,
});
const ApprovalHierarchyNotFoundSchema = Schema.TaggedStruct('HIERARCHY_NOT_FOUND', {});
const ApprovalHierarchyAmbiguousSchema = Schema.TaggedStruct('HIERARCHY_AMBIGUOUS', {
  hierarchyRefs: Schema.Array(Schema.suspend(() => ApprovalHierarchyRefSchema)),
});
const ApprovalHierarchyRangeInvalidSchema = Schema.TaggedStruct('HIERARCHY_RANGE_INVALID', {});
const ApprovalHierarchyResolutionSchema = Schema.Union([
  ApprovalHierarchyResolvedSchema,
  ApprovalHierarchyNotFoundSchema,
  ApprovalHierarchyAmbiguousSchema,
  ApprovalHierarchyRangeInvalidSchema,
]);
export type ApprovalHierarchyResolution = typeof ApprovalHierarchyResolutionSchema.Type;

/** Resolves the most-specific, non-overlapping hierarchy without inferring relationships. */
export const resolveApprovalHierarchy = (input: {
  readonly at: typeof instant.Type;
  readonly candidates: readonly ApprovalHierarchy[];
  readonly counterpartyRef: CoreSearchResourceRef;
  readonly purchaseValue: MonetaryAmount;
  readonly storefrontId: string;
}): ApprovalHierarchyResolution => {
  const malformed = input.candidates.some(
    ({ selector }) =>
      selector.minimumPurchaseValue.currency === selector.maximumPurchaseValue?.currency &&
      selector.maximumPurchaseValue !== null &&
      compareExactDecimals(selector.minimumPurchaseValue.amount, selector.maximumPurchaseValue.amount) > 0,
  );
  if (malformed) {
    return { _tag: 'HIERARCHY_RANGE_INVALID' } satisfies ApprovalHierarchyResolution;
  }
  const matches = input.candidates.filter((candidate) => hierarchyIsEffective(candidate, input));
  if (matches.length === 0) {
    return { _tag: 'HIERARCHY_NOT_FOUND' } satisfies ApprovalHierarchyResolution;
  }
  const exact = matches.filter(({ selector }) => selector.storefrontId === input.storefrontId);
  const selected = exact.length > 0 ? exact : matches;
  if (selected.length !== 1) {
    return {
      _tag: 'HIERARCHY_AMBIGUOUS',
      hierarchyRefs: selected.map(({ hierarchyRef }) => hierarchyRef),
    } satisfies ApprovalHierarchyResolution;
  }
  const [hierarchy] = selected;
  if (hierarchy === undefined) {
    return { _tag: 'HIERARCHY_NOT_FOUND' } satisfies ApprovalHierarchyResolution;
  }
  return { _tag: 'HIERARCHY_RESOLVED', hierarchy } satisfies ApprovalHierarchyResolution;
};

// oxlint-disable-next-line eslint/no-unused-vars -- Retained private route-ordering helper preserves the approval contract structure.
const orderedLevels = (levels: readonly ApprovalHierarchyLevel[]): readonly ApprovalHierarchyLevel[] =>
  [...levels].toSorted((left, right) => left.order - right.order);

const NoEligibleRouteSchema = Schema.TaggedStruct('NO_ELIGIBLE_ROUTE', { reason: Schema.String });
// oxlint-disable-next-line eslint/no-unused-vars -- Retained private route result type preserves the approval contract structure.
type NoEligibleRoute = typeof NoEligibleRouteSchema.Type;

const approvalRouteCurrentLevel = (route: ApprovalRoute): ApprovalRouteLevel | undefined =>
  route.levels.find(({ order }) => order === route.currentLevelOrder && route.status === 'PENDING');

const approvalRouteAllows = (route: ApprovalRoute, principal: PrincipalRef): boolean => {
  const current = approvalRouteCurrentLevel(route);
  return (
    current?.candidates.some(
      (candidate) => candidate.principalId === principal.principalId && candidate.tenantId === principal.tenantId,
    ) ?? false
  );
};

const ApprovalDecisionAppliedSchema = Schema.TaggedStruct('APPLIED', {
  route: ApprovalRouteSchema,
  status: PurchaseApprovalRequestSchema.fields.status,
});
const ApprovalDecisionAlreadyCompletedSchema = Schema.TaggedStruct('ALREADY_COMPLETED', {});
const ApprovalDecisionNotRouteEligibleSchema = Schema.TaggedStruct('NOT_ROUTE_ELIGIBLE', {});
const ApprovalDecisionSelfApprovalDeniedSchema = Schema.TaggedStruct('SELF_APPROVAL_DENIED', {});
const ApprovalDecisionRequestNotPendingSchema = Schema.TaggedStruct('REQUEST_NOT_PENDING', {});
const ApprovalDecisionRequestExpiredSchema = Schema.TaggedStruct('REQUEST_EXPIRED', {});
const ApprovalDecisionApplicationSchema = Schema.Union([
  ApprovalDecisionAppliedSchema,
  ApprovalDecisionAlreadyCompletedSchema,
  ApprovalDecisionNotRouteEligibleSchema,
  ApprovalDecisionSelfApprovalDeniedSchema,
  ApprovalDecisionRequestNotPendingSchema,
  ApprovalDecisionRequestExpiredSchema,
]);
export type ApprovalDecisionApplication = typeof ApprovalDecisionApplicationSchema.Type;

type ApprovalDecisionInput = Readonly<{
  actor: PrincipalRef;
  hierarchy: ApprovalHierarchy;
  kind: ApprovalDecisionKind;
  now: typeof instant.Type;
  request: PurchaseApprovalRequest;
}>;

type ApprovalDecisionReadiness =
  | Exclude<ApprovalDecisionApplication, { readonly _tag: 'APPLIED' }>
  // oxlint-disable-next-line effect-native/no-hand-rolled-tagged-union -- READY is a private transient control-flow state layered over schema-derived public outcomes, not a serialized domain contract.
  | { readonly _tag: 'READY'; readonly current: ApprovalRouteLevel };

const approvalDecisionReadiness = (input: ApprovalDecisionInput): ApprovalDecisionReadiness => {
  if (input.request.status !== 'PENDING' || input.request.route.status !== 'PENDING') {
    return { _tag: 'REQUEST_NOT_PENDING' };
  }
  if (DateTime.toEpochMillis(input.now) >= DateTime.toEpochMillis(input.request.expiresAt)) {
    return { _tag: 'REQUEST_EXPIRED' };
  }
  const current = approvalRouteCurrentLevel(input.request.route);
  if (current === undefined) {
    return { _tag: 'ALREADY_COMPLETED' };
  }
  if (!approvalRouteAllows(input.request.route, input.actor)) {
    return { _tag: 'NOT_ROUTE_ELIGIBLE' };
  }
  if (
    input.hierarchy.selfApprovalPolicy === 'DENY' &&
    input.request.proposal.identity.buyer.principalId === input.actor.principalId &&
    input.request.proposal.identity.buyer.tenantId === input.actor.tenantId
  ) {
    return { _tag: 'SELF_APPROVAL_DENIED' };
  }
  return { _tag: 'READY', current };
};

const applyCompletedApprovalLevel = (
  input: ApprovalDecisionInput,
  current: ApprovalRouteLevel,
): ApprovalDecisionApplication => {
  const completed = input.request.route.levels.map((level) =>
    level.order === current.order ? { ...level, completedAt: input.now, completedBy: input.actor } : level,
  );
  const next = completed.find(({ completedBy, order }) => completedBy === null && order > current.order);
  const final = next === undefined;
  return {
    _tag: 'APPLIED',
    route: {
      ...input.request.route,
      currentLevelOrder: final ? current.order : next.order,
      levels: completed,
      status: final ? 'APPROVED' : 'PENDING',
    },
    status: final ? 'APPROVED' : 'PENDING',
  };
};

/** Pure state transition; persistence must serialize this transition in the owner transaction. */
export const applyApprovalDecision = (input: ApprovalDecisionInput): ApprovalDecisionApplication => {
  const readiness = approvalDecisionReadiness(input);
  // oxlint-disable-next-line effect-native/no-manual-tag-comparison -- This early return preserves direct discriminant narrowing so only READY exposes current to the completion transition.
  if (readiness._tag !== 'READY') {
    return readiness;
  }
  if (input.kind === 'RETURN' || input.kind === 'REJECT') {
    return {
      _tag: 'APPLIED',
      route: input.request.route,
      status: input.kind === 'RETURN' ? 'RETURNED' : 'REJECTED',
    };
  }
  return applyCompletedApprovalLevel(input, readiness.current);
};

const ApprovalRevalidationValidSchema = Schema.TaggedStruct('APPROVAL_VALID', { validUntil: instant });
const ApprovalRevalidationAlreadyConsumedSchema = Schema.TaggedStruct('ALREADY_CONSUMED', {});
const ApprovalRevalidationRequestNotApprovedSchema = Schema.TaggedStruct('REQUEST_NOT_APPROVED', {});
const ApprovalRevalidationRequestExpiredSchema = Schema.TaggedStruct('REQUEST_EXPIRED', {});
const ApprovalRevalidationMaterialChangeSchema = Schema.TaggedStruct('PROPOSAL_MATERIAL_CHANGE', {});
const ApprovalRevalidationBuyerPermissionDeniedSchema = Schema.TaggedStruct('BUYER_PERMISSION_DENIED', {});
const ApprovalRevalidationProfileInactiveSchema = Schema.TaggedStruct('PROFILE_INACTIVE', {});
const ApprovalRevalidationPolicyRouteInvalidSchema = Schema.TaggedStruct('POLICY_ROUTE_INVALID', {});
const ApprovalRevalidationDecisionSchema = Schema.Union([
  ApprovalRevalidationValidSchema,
  ApprovalRevalidationAlreadyConsumedSchema,
  ApprovalRevalidationRequestNotApprovedSchema,
  ApprovalRevalidationRequestExpiredSchema,
  ApprovalRevalidationMaterialChangeSchema,
  ApprovalRevalidationBuyerPermissionDeniedSchema,
  ApprovalRevalidationProfileInactiveSchema,
  ApprovalRevalidationPolicyRouteInvalidSchema,
]);
export type ApprovalRevalidationDecision = typeof ApprovalRevalidationDecisionSchema.Type;

/** Revalidation deliberately accepts owner-confirmed facts instead of reaching across owners. */
export const revalidateApproval = (input: {
  readonly buyerPermission: 'ALLOWED' | 'DENIED';
  readonly checkedAt: typeof instant.Type;
  readonly exactProposalHashMatches: boolean;
  readonly profileState: 'ACTIVE' | 'INACTIVE';
  readonly request: PurchaseApprovalRequest;
  readonly routeCurrent: boolean;
  readonly validUntil: typeof instant.Type;
}): ApprovalRevalidationDecision => {
  if (input.request.status === 'CONSUMED') {
    return { _tag: 'ALREADY_CONSUMED' };
  }
  if (input.request.status !== 'APPROVED') {
    return { _tag: 'REQUEST_NOT_APPROVED' };
  }
  if (
    DateTime.toEpochMillis(input.checkedAt) >= DateTime.toEpochMillis(input.request.expiresAt) ||
    DateTime.toEpochMillis(input.validUntil) <= DateTime.toEpochMillis(input.checkedAt) ||
    DateTime.toEpochMillis(input.validUntil) > DateTime.toEpochMillis(input.request.expiresAt)
  ) {
    return { _tag: 'REQUEST_EXPIRED' };
  }
  if (!input.exactProposalHashMatches) {
    return { _tag: 'PROPOSAL_MATERIAL_CHANGE' };
  }
  if (input.buyerPermission !== 'ALLOWED') {
    return { _tag: 'BUYER_PERMISSION_DENIED' };
  }
  if (input.profileState !== 'ACTIVE') {
    return { _tag: 'PROFILE_INACTIVE' };
  }
  if (!input.routeCurrent) {
    return { _tag: 'POLICY_ROUTE_INVALID' };
  }
  return { _tag: 'APPROVAL_VALID', validUntil: input.validUntil };
};

// oxlint-disable-next-line eslint/no-unused-vars -- Retained private monetary comparison helper preserves the approval contract structure.
const approvalMoneyEqual = (left: MonetaryAmount, right: MonetaryAmount): boolean =>
  left.currency === right.currency && left.amount === right.amount;
