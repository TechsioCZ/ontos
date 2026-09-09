import { PrincipalRefSchema } from '@app/core-runtime';
import type { PrincipalRef } from '@app/core-runtime';
import { DateTime, Schema } from 'effect';

import { PurchaseApprovalRequestRefSchema } from '../resources/purchase-approval-request.ts';
import { ApprovalDecisionRefSchema } from '../resources/approval-decision.ts';
import { ApprovalHierarchyRefSchema } from '../resources/approval-hierarchy.ts';
import type { ApprovalHierarchyRef } from '../resources/approval-hierarchy.ts';
import { ApprovalRevalidationRefSchema } from '../resources/approval-revalidation.ts';
import { ApprovalRouteRefSchema } from '../resources/approval-route.ts';
import { PurchaseProposalRevisionRefSchema } from '../resources/purchase-proposal-revision.ts';
import { HistoricalRecordRefSchema } from './record-visibility-contracts.ts';
import { CoreSearchResourceRefSchema, type CoreSearchResourceRef } from '@app/core-runtime';
import { MonetaryAmountSchema, PurchaseValueSchema } from './purchase-limit.ts';
import { compareExactDecimals } from './purchase-limit.ts';
import type { MonetaryAmount, PurchaseValue } from './purchase-limit.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from './purchase-limit-evaluation.ts';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const shortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const revision = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const instant = Schema.DateTimeUtcFromString;
const positiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const nonNegativeInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

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
export type OrderResourceRef = typeof OrderResourceRefSchema.Type;
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

export const ApprovalContextSchema = Schema.Struct({
  channelId: shortText,
  locale: shortText,
  marketId: shortText,
  storefrontId: shortText,
  tenantId: Schema.String.check(Schema.isUUID()),
  sellingLegalEntityId: shortText,
  evaluatedAt: instant,
});
export type ApprovalContext = typeof ApprovalContextSchema.Type;

export const ApprovalProductLineSchema = Schema.Struct({
  lineId: shortText,
  productRef: CoreSearchResourceRefSchema,
  configuration: Schema.Record(Schema.String, ApprovalProductConfigurationSchema),
  quantity: positiveInteger,
  unitPrice: MonetaryAmountSchema,
  discount: MonetaryAmountSchema,
  fees: Schema.Array(MonetaryAmountSchema).check(Schema.isMaxLength(50)),
  tax: MonetaryAmountSchema,
  lineTotal: MonetaryAmountSchema,
  pricingRuleRevision: revision,
});
export type ApprovalProductLine = typeof ApprovalProductLineSchema.Type;

export const ApprovalDestinationSchema = Schema.Struct({
  kind: Schema.Literals(['DELIVERY', 'INVOICE']),
  recipientRef: Schema.optionalKey(CoreSearchResourceRefSchema),
  address: Schema.Record(Schema.String, Schema.String),
  method: shortText,
});
export type ApprovalDestination = typeof ApprovalDestinationSchema.Type;

export const PurchaseProposalRevisionSchema = Schema.Struct({
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  revision: positiveInteger,
  proposalSequence: positiveInteger,
  identity: Schema.Struct({
    buyer: PrincipalRefSchema,
    counterpartyRef: CoreSearchResourceRefSchema,
    profileRef: CoreSearchResourceRefSchema,
  }),
  context: ApprovalContextSchema,
  sourceCart: Schema.Struct({
    cartRef: CoreSearchResourceRefSchema,
    revision,
  }),
  lines: Schema.Array(ApprovalProductLineSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  totals: Schema.Struct({
    subtotal: MonetaryAmountSchema,
    discount: MonetaryAmountSchema,
    fees: Schema.Array(MonetaryAmountSchema).check(Schema.isMaxLength(50)),
    shipping: MonetaryAmountSchema,
    tax: MonetaryAmountSchema,
    total: MonetaryAmountSchema,
  }),
  currency: shortText,
  pricingRevision: revision,
  taxRevision: revision,
  paymentTerm: Schema.Struct({
    definitionRef: CoreSearchResourceRefSchema,
    definitionRevision: revision,
    code: shortText,
  }),
  invoiceRecipient: ApprovalDestinationSchema,
  deliveryDestination: ApprovalDestinationSchema,
  policyRefs: Schema.Array(CoreSearchResourceRefSchema).check(Schema.isMaxLength(100)),
  purchaseValue: PurchaseValueSchema,
  effectiveLimit: Schema.Union([MonetaryAmountSchema, Schema.Null]),
  approvalEvaluation: Schema.Literals(['APPROVAL_REQUIRED', 'WITHIN_LIMIT']),
  approvalTrigger: Schema.Struct({
    source: Schema.Literals(['PURCHASE_LIMIT', 'EXPLICIT_POLICY']),
    policyRevision: revision,
    reasonCode: shortText,
  }),
  hierarchyInputs: Schema.Struct({
    counterpartyRef: CoreSearchResourceRefSchema,
    storefrontId: shortText,
    purchaseValue: MonetaryAmountSchema,
    evaluatedAt: instant,
  }),
  canonicalizationVersion: Schema.Literal('purchase-proposal.v1'),
  canonicalHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  createdAt: instant,
  expiresAt: instant,
  state: Schema.Literals(['CURRENT', 'SUPERSEDED', 'CONSUMED', 'CANCELLED']),
  reservation: Schema.Literal('NONE'),
  payment: Schema.Literal('NONE'),
});
export type PurchaseProposalRevision = typeof PurchaseProposalRevisionSchema.Type;

export const ApprovalHierarchyLevelSchema = Schema.Struct({
  levelId: shortText,
  order: positiveInteger,
  completionRule: Schema.Literal('ONE_APPROVER'),
  eligiblePrincipals: Schema.Array(PrincipalRefSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  scopeConstraints: Schema.Array(shortText).check(Schema.isMaxLength(50)),
});
export type ApprovalHierarchyLevel = typeof ApprovalHierarchyLevelSchema.Type;

export const ApprovalHierarchySchema = Schema.Struct({
  hierarchyRef: ApprovalHierarchyRefSchema,
  revision: positiveInteger,
  selector: Schema.Struct({
    counterpartyRef: CoreSearchResourceRefSchema,
    storefrontId: Schema.Union([shortText, Schema.Null]),
    minimumPurchaseValue: MonetaryAmountSchema,
    maximumPurchaseValue: Schema.Union([MonetaryAmountSchema, Schema.Null]),
  }),
  effectiveFrom: instant,
  effectiveTo: Schema.Union([instant, Schema.Null]),
  levels: Schema.Array(ApprovalHierarchyLevelSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  selfApprovalPolicy: Schema.Literals(['DENY', 'ALLOW']),
  ownerPrincipal: PrincipalRefSchema,
  reason: text,
  state: Schema.Literal('ACTIVE'),
  createdAt: instant,
});
export type ApprovalHierarchy = typeof ApprovalHierarchySchema.Type;

export const ApprovalRouteLevelSchema = Schema.Struct({
  levelId: shortText,
  order: positiveInteger,
  completionRule: Schema.Literal('ONE_APPROVER'),
  candidates: Schema.Array(PrincipalRefSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  completedBy: Schema.Union([PrincipalRefSchema, Schema.Null]),
  completedAt: Schema.Union([instant, Schema.Null]),
});
export type ApprovalRouteLevel = typeof ApprovalRouteLevelSchema.Type;

export const ApprovalRouteSchema = Schema.Struct({
  routeRef: ApprovalRouteRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  hierarchyRef: ApprovalHierarchyRefSchema,
  hierarchyRevision: positiveInteger,
  levels: Schema.Array(ApprovalRouteLevelSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  currentLevelOrder: positiveInteger,
  status: Schema.Literals(['PENDING', 'APPROVED', 'REROUTE_REQUIRED', 'SUPERSEDED']),
  capturedAt: instant,
  rerouteReason: Schema.Union([shortText, Schema.Null]),
});
export type ApprovalRoute = typeof ApprovalRouteSchema.Type;

export const PurchaseApprovalRequestSchema = Schema.Struct({
  requestRef: PurchaseApprovalRequestRefSchema,
  proposal: PurchaseProposalRevisionSchema,
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
  expiresAt: instant,
  idempotencyKey: shortText,
  requestRevision: positiveInteger,
  consumedAt: Schema.Union([instant, Schema.Null]),
  /** Set only by the owner consume/reconciliation routine after Order commit is proven. */
  committedOrderRef: Schema.Union([CoreSearchResourceRefSchema, Schema.Null]),
  consumptionCommitmentId: Schema.Union([shortText, Schema.Null]),
  decisionBundleHash: Schema.Union([sha256, Schema.Null]),
  decisionBundleVersion: Schema.Union([shortText, Schema.Null]),
  lastDecisionRef: Schema.Union([ApprovalDecisionRefSchema, Schema.Null]),
});
export type PurchaseApprovalRequest = typeof PurchaseApprovalRequestSchema.Type;

export const ApprovalDecisionKindSchema = Schema.Literals(['APPROVE', 'RETURN', 'REJECT']);
export type ApprovalDecisionKind = typeof ApprovalDecisionKindSchema.Type;

export const ApprovalDecisionSchema = Schema.Struct({
  decisionRef: ApprovalDecisionRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  actor: PrincipalRefSchema,
  kind: ApprovalDecisionKindSchema,
  levelOrder: positiveInteger,
  reason: Schema.Union([text, Schema.Null]),
  recordedAt: instant,
  requestRevision: positiveInteger,
  routeRef: ApprovalRouteRefSchema,
  hierarchyRef: ApprovalHierarchyRefSchema,
  hierarchyRevision: positiveInteger,
  decisionBundleHash: sha256,
  decisionBundleVersion: Schema.Literal('approval-decision-bundle.v1'),
  idempotencyKey: shortText,
}).check(
  Schema.makeFilter(({ kind, reason }) =>
    (kind === 'RETURN' || kind === 'REJECT') && (reason === null || reason.trim().length === 0)
      ? 'Return and reject decisions require a non-empty reason'
      : undefined,
  ),
);
export type ApprovalDecision = typeof ApprovalDecisionSchema.Type;

export const ApprovalRevalidationSchema = Schema.Struct({
  revalidationRef: ApprovalRevalidationRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  approvedRoute: ApprovalRouteSchema,
  checkedAt: instant,
  validUntil: instant,
  status: Schema.Literals(['APPROVAL_VALID', 'ALREADY_CONSUMED', 'INVALID']),
  committedOrderRef: Schema.Union([CoreSearchResourceRefSchema, Schema.Null]),
  evidence: Schema.Struct({
    proposalHash: sha256,
    decisionBundleHash: sha256,
    decisionBundleVersion: Schema.Literal('approval-decision-bundle.v1'),
    decisionRef: ApprovalDecisionRefSchema,
    hierarchyRef: ApprovalHierarchyRefSchema,
    routeRef: ApprovalRouteRefSchema,
    sourceRevisions: Schema.Array(Schema.Struct({ source: shortText, revision })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
    commitmentCorrelationId: shortText,
    buyerPermission: Schema.Literals(['ALLOWED', 'DENIED']),
    profileState: Schema.Literals(['ACTIVE', 'INACTIVE']),
    policyRouteCurrent: Schema.Boolean,
  }),
});
export type ApprovalRevalidation = typeof ApprovalRevalidationSchema.Type;

export const CreatePurchaseProposalRevisionInputSchema = Schema.Struct({
  proposal: PurchaseProposalRevisionSchema,
  idempotencyKey: shortText,
  verifiedEvidence: Schema.Struct({
    buyerPermission: Schema.Literal('ALLOWED'),
    profileState: Schema.Literal('ACTIVE'),
    proposalCurrent: Schema.Literal(true),
    sourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
  }),
});
export type CreatePurchaseProposalRevisionInput =
  typeof CreatePurchaseProposalRevisionInputSchema.Type;

export const SubmitPurchaseApprovalRequestInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  /** Binds submission to one immutable proposal revision; the ref alone is not a revision key. */
  proposalRevision: positiveInteger,
  idempotencyKey: shortText,
  requestExpiresAt: instant,
  storefrontId: shortText,
});
export type SubmitPurchaseApprovalRequestInput =
  typeof SubmitPurchaseApprovalRequestInputSchema.Type;

export const CreateApprovalHierarchyInputSchema = Schema.Struct({
  hierarchy: ApprovalHierarchySchema,
  idempotencyKey: shortText,
});
export type CreateApprovalHierarchyInput = typeof CreateApprovalHierarchyInputSchema.Type;

export const DecidePurchaseApprovalRequestInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  decision: ApprovalDecisionKindSchema,
  reason: Schema.Union([text, Schema.Null]),
  expectedRequestRevision: positiveInteger,
  idempotencyKey: shortText,
  actor: PrincipalRefSchema,
  decidedAt: instant,
  storefrontId: shortText,
}).check(
  Schema.makeFilter(({ decision, reason }) =>
    (decision === 'RETURN' || decision === 'REJECT') &&
    (reason === null || reason.trim().length === 0)
      ? 'Return and reject decisions require a non-empty reason'
      : undefined,
  ),
);
export type DecidePurchaseApprovalRequestInput =
  typeof DecidePurchaseApprovalRequestInputSchema.Type;

export const ReroutePurchaseApprovalRequestInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  reason: text,
  idempotencyKey: shortText,
  reroutedAt: instant,
  expectedRequestRevision: positiveInteger,
  storefrontId: shortText,
});
export type ReroutePurchaseApprovalRequestInput =
  typeof ReroutePurchaseApprovalRequestInputSchema.Type;

export const RevalidatePurchaseApprovalInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  expectedProposalHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  decisionBundleHash: sha256,
  decisionBundleVersion: Schema.Literal('approval-decision-bundle.v1'),
  decisionRef: ApprovalDecisionRefSchema,
  hierarchyRef: ApprovalHierarchyRefSchema,
  routeRef: ApprovalRouteRefSchema,
  sourceRevisions: Schema.Array(Schema.Struct({ source: shortText, revision })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  commitmentCorrelationId: shortText,
  idempotencyKey: shortText,
  checkedAt: instant,
  validUntil: instant,
  buyerPermission: Schema.Literals(['ALLOWED', 'DENIED']),
  profileState: Schema.Literals(['ACTIVE', 'INACTIVE']),
  routeCurrent: Schema.Boolean,
  storefrontId: shortText,
});
export type RevalidatePurchaseApprovalInput = typeof RevalidatePurchaseApprovalInputSchema.Type;

/** Order-owner reconciliation seam. It is the only operation that can move an approved request
 * to CONSUMED, and it requires the exact proposal/decision bundle/commitment identity and the
 * committed Order reference. The Order owner remains authoritative for commit mechanics. */
export const ConsumePurchaseApprovalInputSchema = Schema.Struct({
  counterpartyRef: CoreSearchResourceRefSchema,
  requestRef: PurchaseApprovalRequestRefSchema,
  proposalRevisionRef: PurchaseProposalRevisionRefSchema,
  decisionBundleHash: sha256,
  decisionBundleVersion: Schema.Literal('approval-decision-bundle.v1'),
  commitmentCorrelationId: shortText,
  orderRef: OrderResourceRefSchema,
  idempotencyKey: shortText,
  committedAt: instant,
  storefrontId: shortText,
});
export type ConsumePurchaseApprovalInput = typeof ConsumePurchaseApprovalInputSchema.Type;

export const ConsumePurchaseApprovalResultSchema = Schema.Struct({
  outcome: Schema.Literals(['CONSUMED', 'ALREADY_CONSUMED']),
  request: PurchaseApprovalRequestSchema,
});
export type ConsumePurchaseApprovalResult = typeof ConsumePurchaseApprovalResultSchema.Type;

export const PurchaseApprovalFailureCodeSchema = Schema.Literals([
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
export type PurchaseApprovalFailureCode = typeof PurchaseApprovalFailureCodeSchema.Type;

export class PurchasingApprovalRejected extends Schema.TaggedError<PurchasingApprovalRejected>()(
  'PurchasingApprovalRejected',
  {
    code: PurchaseApprovalFailureCodeSchema,
    reason: text,
    retryable: Schema.Boolean,
  },
) {}

export const CreatePurchaseProposalRevisionResultSchema = Schema.Struct({
  outcome: Schema.Literals(['CREATED', 'ALREADY_EXISTS']),
  proposal: PurchaseProposalRevisionSchema,
});
export type CreatePurchaseProposalRevisionResult =
  typeof CreatePurchaseProposalRevisionResultSchema.Type;

export const SubmitPurchaseApprovalRequestResultSchema = Schema.Struct({
  outcome: Schema.Literals(['SUBMITTED', 'ALREADY_SUBMITTED']),
  request: PurchaseApprovalRequestSchema,
});
export type SubmitPurchaseApprovalRequestResult =
  typeof SubmitPurchaseApprovalRequestResultSchema.Type;

export const CreateApprovalHierarchyResultSchema = Schema.Struct({
  outcome: Schema.Literals(['CREATED', 'ALREADY_EXISTS']),
  hierarchy: ApprovalHierarchySchema,
});
export type CreateApprovalHierarchyResult = typeof CreateApprovalHierarchyResultSchema.Type;

export const DecidePurchaseApprovalRequestResultSchema = Schema.Struct({
  outcome: Schema.Literals(['DECISION_RECORDED', 'ALREADY_RECORDED']),
  decision: ApprovalDecisionSchema,
  request: PurchaseApprovalRequestSchema,
});
export type DecidePurchaseApprovalRequestResult =
  typeof DecidePurchaseApprovalRequestResultSchema.Type;

export const ReroutePurchaseApprovalRequestResultSchema = Schema.Struct({
  outcome: Schema.Literals(['REROUTED', 'REROUTE_REQUIRED']),
  request: PurchaseApprovalRequestSchema,
  route: ApprovalRouteSchema,
});
export type ReroutePurchaseApprovalRequestResult =
  typeof ReroutePurchaseApprovalRequestResultSchema.Type;

export const RevalidatePurchaseApprovalResultSchema = Schema.Struct({
  outcome: Schema.Literals(['APPROVAL_VALID', 'ALREADY_CONSUMED']),
  revalidation: ApprovalRevalidationSchema,
});
export type RevalidatePurchaseApprovalResult = typeof RevalidatePurchaseApprovalResultSchema.Type;

export const sameResourceRef = (
  left: CoreSearchResourceRef,
  right: CoreSearchResourceRef,
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** Stable JSON representation used for the proposal hash and idempotency evidence. */
export const canonicalizePurchaseProposal = (proposal: PurchaseProposalRevision): string => {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== 'canonicalHash' && key !== 'state')
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(proposal));
};

/** Deterministic, lowercase SHA-256 hash of the canonical proposal snapshot. */
export const computePurchaseProposalCanonicalHash = (
  proposal: PurchaseProposalRevision,
): string => {
  // The hash is deliberately implemented without a mutable reference lookup.  The application
  // runtime provides node:crypto; consumers that only need equality can compare the canonical form.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(canonicalizePurchaseProposal(proposal)).digest('hex');
};

const monetaryRangeContains = (
  value: MonetaryAmount,
  selector: ApprovalHierarchy['selector'],
): boolean => {
  if (value.currency !== selector.minimumPurchaseValue.currency) return false;
  if (compareExactDecimals(value.amount, selector.minimumPurchaseValue.amount) < 0) return false;
  return (
    selector.maximumPurchaseValue === null ||
    (selector.maximumPurchaseValue.currency === value.currency &&
      compareExactDecimals(value.amount, selector.maximumPurchaseValue.amount) <= 0)
  );
};

const hierarchyIsEffective = (
  hierarchy: ApprovalHierarchy,
  input: {
    readonly counterpartyRef: CoreSearchResourceRef;
    readonly storefrontId: string;
    readonly purchaseValue: MonetaryAmount;
    readonly at: typeof instant.Type;
  },
): boolean =>
  sameResourceRef(hierarchy.selector.counterpartyRef, input.counterpartyRef) &&
  (hierarchy.selector.storefrontId === null ||
    hierarchy.selector.storefrontId === input.storefrontId) &&
  monetaryRangeContains(input.purchaseValue, hierarchy.selector) &&
  DateTime.toEpochMillis(hierarchy.effectiveFrom) <= DateTime.toEpochMillis(input.at) &&
  (hierarchy.effectiveTo === null ||
    DateTime.toEpochMillis(input.at) < DateTime.toEpochMillis(hierarchy.effectiveTo));

export type ApprovalHierarchyResolution =
  | { readonly _tag: 'HIERARCHY_RESOLVED'; readonly hierarchy: ApprovalHierarchy }
  | { readonly _tag: 'HIERARCHY_NOT_FOUND' }
  | {
      readonly _tag: 'HIERARCHY_AMBIGUOUS';
      readonly hierarchyRefs: readonly ApprovalHierarchyRef[];
    }
  | { readonly _tag: 'HIERARCHY_RANGE_INVALID' };

/** Resolves the most-specific, non-overlapping hierarchy without inferring relationships. */
export const resolveApprovalHierarchy = (input: {
  readonly candidates: readonly ApprovalHierarchy[];
  readonly counterpartyRef: CoreSearchResourceRef;
  readonly storefrontId: string;
  readonly purchaseValue: MonetaryAmount;
  readonly at: typeof instant.Type;
}): ApprovalHierarchyResolution => {
  const malformed = input.candidates.some(
    ({ selector }) =>
      selector.minimumPurchaseValue.currency === selector.maximumPurchaseValue?.currency &&
      selector.maximumPurchaseValue !== null &&
      compareExactDecimals(
        selector.minimumPurchaseValue.amount,
        selector.maximumPurchaseValue.amount,
      ) > 0,
  );
  if (malformed) return { _tag: 'HIERARCHY_RANGE_INVALID' };
  const matches = input.candidates.filter((candidate) => hierarchyIsEffective(candidate, input));
  if (matches.length === 0) return { _tag: 'HIERARCHY_NOT_FOUND' };
  const exact = matches.filter(({ selector }) => selector.storefrontId === input.storefrontId);
  const selected = exact.length > 0 ? exact : matches;
  if (selected.length !== 1) {
    return {
      _tag: 'HIERARCHY_AMBIGUOUS',
      hierarchyRefs: selected.map(({ hierarchyRef }) => hierarchyRef),
    };
  }
  return { _tag: 'HIERARCHY_RESOLVED', hierarchy: selected[0]! };
};

const orderedLevels = (
  levels: readonly ApprovalHierarchyLevel[],
): readonly ApprovalHierarchyLevel[] => [...levels].sort((left, right) => left.order - right.order);

export const buildApprovalRoute = (input: {
  readonly requestRef: typeof PurchaseApprovalRequestRefSchema.Type;
  readonly proposalRevisionRef: typeof PurchaseProposalRevisionRefSchema.Type;
  readonly hierarchy: ApprovalHierarchy;
  readonly routeRef: typeof ApprovalRouteRefSchema.Type;
  readonly capturedAt: typeof instant.Type;
}): ApprovalRoute | { readonly _tag: 'NO_ELIGIBLE_ROUTE'; readonly reason: string } => {
  const levels = orderedLevels(input.hierarchy.levels);
  if (
    levels.length === 0 ||
    levels.some(
      (level, index) => level.order !== index + 1 || level.eligiblePrincipals.length === 0,
    )
  ) {
    return { _tag: 'NO_ELIGIBLE_ROUTE', reason: 'Hierarchy has an empty or non-contiguous level' };
  }
  return {
    routeRef: input.routeRef,
    requestRef: input.requestRef,
    proposalRevisionRef: input.proposalRevisionRef,
    hierarchyRef: input.hierarchy.hierarchyRef,
    hierarchyRevision: input.hierarchy.revision,
    levels: levels.map((level) => ({
      levelId: level.levelId,
      order: level.order,
      completionRule: level.completionRule,
      candidates: level.eligiblePrincipals,
      completedBy: null,
      completedAt: null,
    })),
    currentLevelOrder: 1,
    status: 'PENDING',
    capturedAt: input.capturedAt,
    rerouteReason: null,
  };
};

export const approvalRouteCurrentLevel = (route: ApprovalRoute): ApprovalRouteLevel | undefined =>
  route.levels.find(({ order }) => order === route.currentLevelOrder && route.status === 'PENDING');

export const approvalRouteAllows = (route: ApprovalRoute, principal: PrincipalRef): boolean => {
  const current = approvalRouteCurrentLevel(route);
  return (
    current?.candidates.some(
      (candidate) =>
        candidate.principalId === principal.principalId &&
        candidate.tenantId === principal.tenantId,
    ) ?? false
  );
};

export type ApprovalDecisionApplication =
  | {
      readonly _tag: 'APPLIED';
      readonly route: ApprovalRoute;
      readonly status: PurchaseApprovalRequest['status'];
    }
  | { readonly _tag: 'ALREADY_COMPLETED' }
  | { readonly _tag: 'NOT_ROUTE_ELIGIBLE' }
  | { readonly _tag: 'SELF_APPROVAL_DENIED' }
  | { readonly _tag: 'REQUEST_NOT_PENDING' }
  | { readonly _tag: 'REQUEST_EXPIRED' };

/** Pure state transition; persistence must serialize this transition in the owner transaction. */
export const applyApprovalDecision = (input: {
  readonly request: PurchaseApprovalRequest;
  readonly hierarchy: ApprovalHierarchy;
  readonly actor: PrincipalRef;
  readonly kind: ApprovalDecisionKind;
  readonly now: typeof instant.Type;
}): ApprovalDecisionApplication => {
  if (input.request.status !== 'PENDING' || input.request.route.status !== 'PENDING') {
    return { _tag: 'REQUEST_NOT_PENDING' };
  }
  if (DateTime.toEpochMillis(input.now) >= DateTime.toEpochMillis(input.request.expiresAt))
    return { _tag: 'REQUEST_EXPIRED' };
  const current = approvalRouteCurrentLevel(input.request.route);
  if (current === undefined) return { _tag: 'ALREADY_COMPLETED' };
  if (!approvalRouteAllows(input.request.route, input.actor)) return { _tag: 'NOT_ROUTE_ELIGIBLE' };
  if (
    input.hierarchy.selfApprovalPolicy === 'DENY' &&
    input.request.proposal.identity.buyer.principalId === input.actor.principalId &&
    input.request.proposal.identity.buyer.tenantId === input.actor.tenantId
  ) {
    return { _tag: 'SELF_APPROVAL_DENIED' };
  }
  if (input.kind === 'RETURN' || input.kind === 'REJECT') {
    return {
      _tag: 'APPLIED',
      route: input.request.route,
      status: input.kind === 'RETURN' ? 'RETURNED' : 'REJECTED',
    };
  }
  const completed = input.request.route.levels.map((level) =>
    level.order === current.order
      ? { ...level, completedBy: input.actor, completedAt: input.now }
      : level,
  );
  const next = completed.find(
    ({ completedBy, order }) => completedBy === null && order > current.order,
  );
  const final = next === undefined;
  return {
    _tag: 'APPLIED',
    route: {
      ...input.request.route,
      levels: completed,
      currentLevelOrder: final ? current.order : next!.order,
      status: final ? 'APPROVED' : 'PENDING',
    },
    status: final ? 'APPROVED' : 'PENDING',
  };
};

export type ApprovalRevalidationDecision =
  | { readonly _tag: 'APPROVAL_VALID'; readonly validUntil: typeof instant.Type }
  | { readonly _tag: 'ALREADY_CONSUMED' }
  | { readonly _tag: 'REQUEST_NOT_APPROVED' }
  | { readonly _tag: 'REQUEST_EXPIRED' }
  | { readonly _tag: 'PROPOSAL_MATERIAL_CHANGE' }
  | { readonly _tag: 'BUYER_PERMISSION_DENIED' }
  | { readonly _tag: 'PROFILE_INACTIVE' }
  | { readonly _tag: 'POLICY_ROUTE_INVALID' };

/** Revalidation deliberately accepts owner-confirmed facts instead of reaching across owners. */
export const revalidateApproval = (input: {
  readonly request: PurchaseApprovalRequest;
  readonly exactProposalHashMatches: boolean;
  readonly buyerPermission: 'ALLOWED' | 'DENIED';
  readonly profileState: 'ACTIVE' | 'INACTIVE';
  readonly routeCurrent: boolean;
  readonly checkedAt: typeof instant.Type;
  readonly validUntil: typeof instant.Type;
}): ApprovalRevalidationDecision => {
  if (input.request.status === 'CONSUMED') return { _tag: 'ALREADY_CONSUMED' };
  if (input.request.status !== 'APPROVED') return { _tag: 'REQUEST_NOT_APPROVED' };
  if (
    DateTime.toEpochMillis(input.checkedAt) >= DateTime.toEpochMillis(input.request.expiresAt) ||
    DateTime.toEpochMillis(input.validUntil) <= DateTime.toEpochMillis(input.checkedAt) ||
    DateTime.toEpochMillis(input.validUntil) > DateTime.toEpochMillis(input.request.expiresAt)
  )
    return { _tag: 'REQUEST_EXPIRED' };
  if (!input.exactProposalHashMatches) return { _tag: 'PROPOSAL_MATERIAL_CHANGE' };
  if (input.buyerPermission !== 'ALLOWED') return { _tag: 'BUYER_PERMISSION_DENIED' };
  if (input.profileState !== 'ACTIVE') return { _tag: 'PROFILE_INACTIVE' };
  if (!input.routeCurrent) return { _tag: 'POLICY_ROUTE_INVALID' };
  return { _tag: 'APPROVAL_VALID', validUntil: input.validUntil };
};

export const approvalMoneyEqual = (left: MonetaryAmount, right: MonetaryAmount): boolean =>
  left.currency === right.currency && left.amount === right.amount;

export const approvalPurchaseValueEqual = (left: PurchaseValue, right: PurchaseValue): boolean =>
  approvalMoneyEqual(left.monetaryAmount, right.monetaryAmount) &&
  left.roundingRuleRevision === right.roundingRuleRevision &&
  left.sourceRef === right.sourceRef &&
  left.sourceRevision === right.sourceRevision;
