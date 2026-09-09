import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { ActionHandlerContext, OperationalScope } from '@app/core-runtime';
import {
  CoreSearchResourceRefSchema,
  PrincipalRefSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { ActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { DomainEventContractMap } from '../../../../packages/core-runtime/src/actions/events.ts';
import type {
  CreatePurchaseProposalRevisionPayload,
  CreatePurchaseProposalRevisionResult,
} from '../../shared/actions/create-purchase-proposal-revision.ts';
import type {
  CreateApprovalHierarchyPayload,
  CreateApprovalHierarchyResult,
} from '../../shared/actions/create-approval-hierarchy.ts';
import type {
  SubmitPurchaseApprovalRequestPayload,
  SubmitPurchaseApprovalRequestResult,
} from '../../shared/actions/submit-purchase-approval-request.ts';
import type {
  DecidePurchaseApprovalRequestPayload,
  DecidePurchaseApprovalRequestResult,
} from '../../shared/actions/decide-purchase-approval-request.ts';
import type {
  ReroutePurchaseApprovalRequestPayload,
  ReroutePurchaseApprovalRequestResult,
} from '../../shared/actions/reroute-purchase-approval-request.ts';
import type {
  RevalidatePurchaseApprovalPayload,
  RevalidatePurchaseApprovalResult,
} from '../../shared/actions/revalidate-purchase-approval.ts';
import type {
  ConsumePurchaseApprovalPayload,
  ConsumePurchaseApprovalResult,
} from '../../shared/actions/consume-purchase-approval.ts';
import {
  ApprovalDecisionSchema,
  ApprovalHierarchySchema,
  ApprovalRevalidationSchema,
  ApprovalRouteSchema,
  PurchaseApprovalRequestSchema,
  PurchaseProposalRevisionSchema,
  OrderResourceRefSchema,
  PurchasingApprovalRejected,
} from '../../shared/domain/purchasing-approval.ts';
import type { PurchaseApprovalCurrentnessService } from '../../shared/domain/purchase-approval-currentness-port.ts';
import type { PurchasingApprovalWorkflowService } from '../../src/persistence/purchasing-approval-persistence.ts';
import type { PurchaseApprovalOrderCommitmentPort } from '../../shared/domain/purchase-approval-order-commitment-port.ts';
import { createApprovalHierarchyAction } from '../../src/actions/create-approval-hierarchy.action.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';
import { reroutePurchaseApprovalRequestAction } from '../../src/actions/reroute-purchase-approval-request.action.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const buyerId = '10000000-0000-4000-8000-000000000002';
const approverId = '10000000-0000-4000-8000-000000000003';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const storefrontId = 'storefront-eu';
const atText = '2026-09-09T12:00:00.000Z';
const expiresAtText = '2026-09-09T13:00:00.000Z';
const at = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(atText);
const expiresAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(expiresAtText);

const scope: OperationalScope = trustVerifiedGatewayPrincipalContext({
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-api-key:commerce-order-owner',
  authMethod: 'api_key' as const,
  correlationId: 'purchasing-approval-action-evidence',
  legalEntityId,
  principalId: buyerId,
  tenantId,
  trustedStorefrontId: storefrontId,
});

const counterpartyRef = Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
});

const profileRef = Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: 'profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
});

const principal = (principalId: string) =>
  Schema.decodeUnknownSync(PrincipalRefSchema)({ principalId, tenantId });
const money = (amount: string) => ({ amount, currency: 'EUR' });

const proposal = Schema.decodeUnknownSync(PurchaseProposalRevisionSchema)({
  proposalRevisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'proposal-1',
    resourceType: 'commerce.customer-context.purchase-proposal-revision',
    tenantId,
  },
  revision: 1,
  proposalSequence: 1,
  identity: {
    buyer: principal(buyerId),
    counterpartyRef,
    profileRef,
  },
  context: {
    channelId: 'portal',
    locale: 'en-US',
    marketId: 'eu',
    storefrontId,
    tenantId,
    sellingLegalEntityId: legalEntityId,
    evaluatedAt: atText,
  },
  sourceCart: {
    cartRef: {
      moduleId: 'commerce.cart',
      resourceId: 'cart-1',
      resourceType: 'commerce.cart.cart',
      tenantId,
    },
    revision: 'cart-r1',
  },
  lines: [
    {
      lineId: 'line-1',
      productRef: {
        moduleId: 'catalog',
        resourceId: 'product-1',
        resourceType: 'catalog.product',
        tenantId,
      },
      configuration: {},
      quantity: 1,
      unitPrice: money('100'),
      discount: money('0'),
      fees: [],
      tax: money('20'),
      lineTotal: money('120'),
      pricingRuleRevision: 'pricing-r1',
    },
  ],
  totals: {
    subtotal: money('100'),
    discount: money('0'),
    fees: [],
    shipping: money('0'),
    tax: money('20'),
    total: money('120'),
  },
  currency: 'EUR',
  pricingRevision: 'pricing-r1',
  taxRevision: 'tax-r1',
  paymentTerm: {
    definitionRef: {
      moduleId: 'payment-term-catalog',
      resourceId: 'net-30',
      resourceType: 'payment-term-catalog.payment-term-definition',
      tenantId,
    },
    definitionRevision: '1',
    code: 'NET30',
  },
  invoiceRecipient: { kind: 'INVOICE', address: { country: 'CZ' }, method: 'BILLING_ADDRESS' },
  deliveryDestination: {
    kind: 'DELIVERY',
    address: { country: 'CZ' },
    method: 'DELIVERY_ADDRESS',
  },
  policyRefs: [],
  purchaseValue: {
    monetaryAmount: money('120'),
    roundingRuleRevision: 'rounding-r1',
    sourceRef: 'proposal-1',
    sourceRevision: '1',
  },
  effectiveLimit: money('50'),
  approvalEvaluation: 'APPROVAL_REQUIRED',
  approvalTrigger: {
    source: 'PURCHASE_LIMIT',
    policyRevision: 'limit-r1',
    reasonCode: 'over_limit',
  },
  hierarchyInputs: {
    counterpartyRef,
    storefrontId,
    purchaseValue: money('120'),
    evaluatedAt: atText,
  },
  canonicalizationVersion: 'purchase-proposal.v1',
  canonicalHash: 'a'.repeat(64),
  createdAt: atText,
  expiresAt: expiresAtText,
  state: 'CURRENT',
  reservation: 'NONE',
  payment: 'NONE',
});
const proposalEncoded = Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal);

const hierarchy = Schema.decodeUnknownSync(ApprovalHierarchySchema)({
  hierarchyRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'hierarchy-1',
    resourceType: 'commerce.customer-context.approval-hierarchy',
    tenantId,
  },
  revision: 1,
  selector: {
    counterpartyRef,
    storefrontId,
    minimumPurchaseValue: money('0'),
    maximumPurchaseValue: null,
  },
  effectiveFrom: atText,
  effectiveTo: null,
  levels: [
    {
      levelId: 'level-1',
      order: 1,
      completionRule: 'ONE_APPROVER',
      eligiblePrincipals: [principal(approverId)],
      scopeConstraints: ['exact-storefront'],
    },
  ],
  selfApprovalPolicy: 'DENY',
  ownerPrincipal: principal(buyerId),
  reason: 'Launch policy',
  state: 'ACTIVE',
  createdAt: atText,
});

const route = Schema.decodeUnknownSync(ApprovalRouteSchema)({
  routeRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'route-1',
    resourceType: 'commerce.customer-context.approval-route',
    tenantId,
  },
  requestRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'request-1',
    resourceType: 'commerce.customer-context.purchase-approval-request',
    tenantId,
  },
  proposalRevisionRef: proposal.proposalRevisionRef,
  hierarchyRef: hierarchy.hierarchyRef,
  hierarchyRevision: 1,
  levels: [
    {
      levelId: 'level-1',
      order: 1,
      completionRule: 'ONE_APPROVER',
      candidates: [principal(approverId)],
      completedBy: null,
      completedAt: null,
    },
  ],
  currentLevelOrder: 1,
  status: 'PENDING',
  capturedAt: atText,
  rerouteReason: null,
});
const routeEncoded = Schema.encodeSync(ApprovalRouteSchema)(route);

const request = Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
  requestRef: route.requestRef,
  proposal: proposalEncoded,
  route: routeEncoded,
  status: 'PENDING',
  submittedAt: atText,
  expiresAt: expiresAtText,
  idempotencyKey: 'request-idempotency-1',
  requestRevision: 1,
  consumedAt: null,
  committedOrderRef: null,
  consumptionCommitmentId: null,
  decisionBundleHash: null,
  decisionBundleVersion: null,
  lastDecisionRef: null,
});

const decision = Schema.decodeUnknownSync(ApprovalDecisionSchema)({
  decisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'decision-1',
    resourceType: 'commerce.customer-context.approval-decision',
    tenantId,
  },
  requestRef: request.requestRef,
  proposalRevisionRef: proposal.proposalRevisionRef,
  actor: principal(buyerId),
  kind: 'APPROVE',
  levelOrder: 1,
  reason: null,
  recordedAt: atText,
  requestRevision: 2,
  routeRef: route.routeRef,
  hierarchyRef: hierarchy.hierarchyRef,
  hierarchyRevision: hierarchy.revision,
  decisionBundleHash: 'b'.repeat(64),
  decisionBundleVersion: 'approval-decision-bundle.v1',
  idempotencyKey: 'decision-idempotency-1',
});

const revalidation = Schema.decodeUnknownSync(ApprovalRevalidationSchema)({
  revalidationRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'revalidation-1',
    resourceType: 'commerce.customer-context.approval-revalidation',
    tenantId,
  },
  requestRef: request.requestRef,
  proposalRevisionRef: proposal.proposalRevisionRef,
  approvedRoute: routeEncoded,
  checkedAt: atText,
  validUntil: expiresAtText,
  status: 'APPROVAL_VALID',
  committedOrderRef: null,
  evidence: {
    proposalHash: proposal.canonicalHash,
    decisionBundleHash: decision.decisionBundleHash,
    decisionBundleVersion: decision.decisionBundleVersion,
    decisionRef: decision.decisionRef,
    hierarchyRef: hierarchy.hierarchyRef,
    routeRef: route.routeRef,
    sourceRevisions: [{ source: 'purchase-proposal', revision: '1' }],
    commitmentCorrelationId: 'commitment-1',
    buyerPermission: 'ALLOWED',
    profileState: 'ACTIVE',
    policyRouteCurrent: true,
  },
});

type WorkflowOverrides = Partial<
  Pick<
    PurchasingApprovalWorkflowService,
    | 'createProposal'
    | 'createHierarchy'
    | 'submitRequest'
    | 'decide'
    | 'reroute'
    | 'revalidate'
    | 'consume'
  >
>;

const makeWorkflow = (overrides: WorkflowOverrides): PurchasingApprovalWorkflowService => {
  let workflow!: PurchasingApprovalWorkflowService;
  workflow = {
    forActionInvocation: () => workflow,
    createProposal: overrides.createProposal ?? (() => Effect.die('unused')),
    createHierarchy: overrides.createHierarchy ?? (() => Effect.die('unused')),
    consume: overrides.consume ?? (() => Effect.die('unused')),
    submitRequest: overrides.submitRequest ?? (() => Effect.die('unused')),
    decide: overrides.decide ?? (() => Effect.die('unused')),
    reroute: overrides.reroute ?? (() => Effect.die('unused')),
    revalidate: overrides.revalidate ?? (() => Effect.die('unused')),
    submit: () => Effect.die('unused'),
  };
  return workflow;
};

/** Test-only owner adapter: production composition uses the transaction-bound SQL Currentness port. */
const currentness = {
  loadCurrent: ({ payload, trustedContext }) =>
    Effect.succeed({
      currentSourceRevisions: payload.expectedSourceRevisions,
      profileEvidence: {
        counterpartyRef: payload.counterpartyRef,
        evaluatedAt: atText,
        evaluationContext: trustedContext,
        gate: { canAcceptNewOrder: true, outcome: 'ACTIVE' as const },
        profileRef: payload.profileRef,
        revision: 1,
        sourceRevision: '1',
      },
      proposalEvidence: {
        evaluatedAt: atText,
        evaluationContext: trustedContext,
        proposalRevisionRef: payload.proposalRevisionRef,
        purchaseValue: payload.purchaseValue,
        revision: '1',
        state: 'CURRENT' as const,
      },
    }),
  loadCandidateCurrent: ({ payload, trustedContext }) =>
    Effect.succeed({
      currentSourceRevisions: payload.expectedSourceRevisions,
      profileEvidence: {
        counterpartyRef: payload.counterpartyRef,
        evaluatedAt: atText,
        evaluationContext: trustedContext,
        gate: { canAcceptNewOrder: true, outcome: 'ACTIVE' as const },
        profileRef: payload.profileRef,
        revision: 1,
        sourceRevision: '1',
      },
      proposalEvidence: {
        evaluatedAt: atText,
        evaluationContext: trustedContext,
        proposalRevisionRef: payload.proposalRevisionRef,
        purchaseValue: payload.purchaseValue,
        revision: '1',
        state: 'CURRENT' as const,
      },
    }),
  // These two methods model the transaction-bound owner adapter used by submit/revalidate.
  // The action evidence test intentionally supplies already validated fixtures; production
  // composition never installs this test adapter.
  resolveSubmission: ({ claimed }) => Effect.succeed(claimed),
  resolveRevalidation: ({ claimed }) => Effect.succeed(claimed),
};

const contextFor = <DomainEvents extends DomainEventContractMap>(
  collector: ActionCollector<DomainEvents>,
  workflow: PurchasingApprovalWorkflowService,
  actionInvocationId: string,
  currentnessOverride: PurchaseApprovalCurrentnessService = currentness,
): ActionHandlerContext<
  DomainEvents,
  {
    readonly workflow: PurchasingApprovalWorkflowService;
    readonly currentness: PurchaseApprovalCurrentnessService;
    readonly commitment: PurchaseApprovalOrderCommitmentPort;
  }
> => ({
  actionInvocationId,
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope,
  services: {
    workflow,
    currentness: currentnessOverride,
    commitment: {
      consume: (input) => workflow.consume(input),
    },
  },
});

const expectCommittedEvidence = (
  snapshot: ReturnType<ActionCollector<Readonly<Record<string, never>>>['snapshot']>,
  targetResourceIds: readonly string[],
) => {
  expect(snapshot.auditEvidence).toBeDefined();
  expect(snapshot.dataAccessEvents).toHaveLength(targetResourceIds.length);
  expect(snapshot.dataAccessEvents.map(({ targetResourceId }) => targetResourceId)).toEqual(
    targetResourceIds,
  );
  expect(
    snapshot.dataAccessEvents.every(
      ({ evidenceCaptureMode }) => evidenceCaptureMode === 'metadata_only',
    ),
  ).toBe(true);
  expect(snapshot.domainEvents).toHaveLength(1);
  expect(snapshot.outboxMessages).toHaveLength(1);
};

it.effect(
  'successful Purchasing Approval Actions commit audit, metadata-only access, and events',
  () =>
    Effect.gen(function* verifyApprovalActionEvidence() {
      const createProposalPayload: CreatePurchaseProposalRevisionPayload = {
        proposal,
        idempotencyKey: 'proposal-idempotency-1',
        verifiedEvidence: {
          buyerPermission: 'ALLOWED',
          profileState: 'ACTIVE',
          proposalCurrent: true,
          sourceRevisions: [
            { source: 'counterparty-policy', revision: '1' },
            { source: 'customer-commerce-policy', revision: '1' },
            { source: 'principal-override', revision: '1' },
            { source: 'purchase-proposal', revision: '1' },
            { source: 'purchasing-profile', revision: '1' },
            { source: 'storefront-context', revision: '1' },
          ],
        },
      };
      const proposalResult: CreatePurchaseProposalRevisionResult = {
        outcome: 'CREATED',
        proposal,
      };
      const proposalCollector = createActionCollector(
        createPurchaseProposalRevisionAction.descriptor.domainEvents,
        'commerce.customer-context',
        createPurchaseProposalRevisionAction.descriptor.accessEvidencePolicy,
        createPurchaseProposalRevisionAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(createPurchaseProposalRevisionAction)(
        createProposalPayload,
        contextFor(
          proposalCollector,
          makeWorkflow({ createProposal: () => Effect.succeed(proposalResult) }),
          'proposal-action-1',
        ),
      );
      expectCommittedEvidence(proposalCollector.snapshot(), [
        'proposal-1',
        'profile-1',
        'counterparty-1',
      ]);

      const hierarchyPayload: CreateApprovalHierarchyPayload = {
        hierarchy,
        idempotencyKey: 'hierarchy-idempotency-1',
      };
      const hierarchyResult: CreateApprovalHierarchyResult = {
        outcome: 'CREATED',
        hierarchy,
      };
      const hierarchyCollector = createActionCollector(
        createApprovalHierarchyAction.descriptor.domainEvents,
        'commerce.customer-context',
        createApprovalHierarchyAction.descriptor.accessEvidencePolicy,
        createApprovalHierarchyAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(createApprovalHierarchyAction)(
        hierarchyPayload,
        contextFor(
          hierarchyCollector,
          makeWorkflow({ createHierarchy: () => Effect.succeed(hierarchyResult) }),
          'hierarchy-action-1',
        ),
      );
      expectCommittedEvidence(hierarchyCollector.snapshot(), ['hierarchy-1', 'counterparty-1']);

      const submitPayload: SubmitPurchaseApprovalRequestPayload = {
        counterpartyRef,
        proposalRevisionRef: proposal.proposalRevisionRef,
        proposalRevision: proposal.revision,
        idempotencyKey: 'submit-idempotency-1',
        requestExpiresAt: expiresAt,
        storefrontId,
      };
      const submitResult: SubmitPurchaseApprovalRequestResult = {
        outcome: 'SUBMITTED',
        request,
      };
      const submitCollector = createActionCollector(
        submitPurchaseApprovalRequestAction.descriptor.domainEvents,
        'commerce.customer-context',
        submitPurchaseApprovalRequestAction.descriptor.accessEvidencePolicy,
        submitPurchaseApprovalRequestAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(submitPurchaseApprovalRequestAction)(
        submitPayload,
        contextFor(
          submitCollector,
          makeWorkflow({ submitRequest: () => Effect.succeed(submitResult) }),
          'submit-action-1',
        ),
      );
      expectCommittedEvidence(submitCollector.snapshot(), [
        'request-1',
        'proposal-1',
        'route-1',
        'hierarchy-1',
        'profile-1',
        'counterparty-1',
      ]);

      const decidePayload: DecidePurchaseApprovalRequestPayload = {
        actor: principal(approverId),
        counterpartyRef,
        requestRef: request.requestRef,
        proposalRevisionRef: proposal.proposalRevisionRef,
        decision: 'APPROVE',
        reason: null,
        expectedRequestRevision: 1,
        idempotencyKey: 'decision-idempotency-1',
        decidedAt: at,
        storefrontId,
      };
      const decideResult: DecidePurchaseApprovalRequestResult = {
        outcome: 'DECISION_RECORDED',
        decision,
        request: {
          ...request,
          status: 'APPROVED',
          requestRevision: 2,
          lastDecisionRef: decision.decisionRef,
        },
      };
      const decideCollector = createActionCollector(
        decidePurchaseApprovalRequestAction.descriptor.domainEvents,
        'commerce.customer-context',
        decidePurchaseApprovalRequestAction.descriptor.accessEvidencePolicy,
        decidePurchaseApprovalRequestAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(decidePurchaseApprovalRequestAction)(
        decidePayload,
        contextFor(
          decideCollector,
          makeWorkflow({ decide: () => Effect.succeed(decideResult) }),
          'decide-action-1',
        ),
      );
      expectCommittedEvidence(decideCollector.snapshot(), [
        'request-1',
        'proposal-1',
        'route-1',
        'hierarchy-1',
        'decision-1',
        'profile-1',
        'counterparty-1',
      ]);

      const reroutePayload: ReroutePurchaseApprovalRequestPayload = {
        counterpartyRef,
        requestRef: request.requestRef,
        reason: 'Policy changed',
        idempotencyKey: 'reroute-idempotency-1',
        reroutedAt: at,
        expectedRequestRevision: 1,
        storefrontId,
      };
      const rerouteResult: ReroutePurchaseApprovalRequestResult = {
        outcome: 'REROUTED',
        request,
        route,
      };
      const rerouteCollector = createActionCollector(
        reroutePurchaseApprovalRequestAction.descriptor.domainEvents,
        'commerce.customer-context',
        reroutePurchaseApprovalRequestAction.descriptor.accessEvidencePolicy,
        reroutePurchaseApprovalRequestAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(reroutePurchaseApprovalRequestAction)(
        reroutePayload,
        contextFor(
          rerouteCollector,
          makeWorkflow({ reroute: () => Effect.succeed(rerouteResult) }),
          'reroute-action-1',
        ),
      );
      expectCommittedEvidence(rerouteCollector.snapshot(), [
        'request-1',
        'proposal-1',
        'route-1',
        'hierarchy-1',
        'profile-1',
        'counterparty-1',
      ]);

      const revalidatePayload: RevalidatePurchaseApprovalPayload = {
        counterpartyRef,
        requestRef: request.requestRef,
        proposalRevisionRef: proposal.proposalRevisionRef,
        expectedProposalHash: proposal.canonicalHash,
        decisionBundleHash: decision.decisionBundleHash,
        decisionBundleVersion: decision.decisionBundleVersion,
        decisionRef: decision.decisionRef,
        hierarchyRef: hierarchy.hierarchyRef,
        routeRef: route.routeRef,
        sourceRevisions: [{ source: 'purchase-proposal', revision: '1' }],
        commitmentCorrelationId: 'commitment-1',
        idempotencyKey: 'revalidate-idempotency-1',
        checkedAt: at,
        validUntil: expiresAt,
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        routeCurrent: true,
        storefrontId,
      };
      const revalidateResult: RevalidatePurchaseApprovalResult = {
        outcome: 'APPROVAL_VALID',
        revalidation,
      };
      const revalidateCollector = createActionCollector(
        revalidatePurchaseApprovalAction.descriptor.domainEvents,
        'commerce.customer-context',
        revalidatePurchaseApprovalAction.descriptor.accessEvidencePolicy,
        revalidatePurchaseApprovalAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(revalidatePurchaseApprovalAction)(
        revalidatePayload,
        contextFor(
          revalidateCollector,
          makeWorkflow({ revalidate: () => Effect.succeed(revalidateResult) }),
          'revalidate-action-1',
        ),
      );
      expectCommittedEvidence(revalidateCollector.snapshot(), [
        'request-1',
        'proposal-1',
        'route-1',
        'hierarchy-1',
        'revalidation-1',
        'counterparty-1',
      ]);
    }),
);

it.effect(
  'does not let forged favorable submission or revalidation evidence bypass owner currentness',
  () =>
    Effect.gen(function* rejectsForgedApprovalEvidence() {
      const submitPayload: SubmitPurchaseApprovalRequestPayload = {
        counterpartyRef,
        proposalRevisionRef: proposal.proposalRevisionRef,
        proposalRevision: proposal.revision,
        idempotencyKey: 'forged-submit-idempotency',
        requestExpiresAt: expiresAt,
        storefrontId,
      };
      const revalidatePayload: RevalidatePurchaseApprovalPayload = {
        counterpartyRef,
        requestRef: request.requestRef,
        proposalRevisionRef: proposal.proposalRevisionRef,
        expectedProposalHash: proposal.canonicalHash,
        decisionBundleHash: decision.decisionBundleHash,
        decisionBundleVersion: decision.decisionBundleVersion,
        decisionRef: decision.decisionRef,
        hierarchyRef: hierarchy.hierarchyRef,
        routeRef: route.routeRef,
        sourceRevisions: [{ source: 'purchase-proposal', revision: '1' }],
        commitmentCorrelationId: 'forged-commitment',
        idempotencyKey: 'forged-revalidate-idempotency',
        checkedAt: at,
        validUntil: expiresAt,
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        routeCurrent: true,
        storefrontId,
      };
      const rejectingCurrentness: PurchaseApprovalCurrentnessService = {
        resolveSubmission: () =>
          Effect.fail(
            new PurchasingApprovalRejected({
              code: 'BUYER_PERMISSION_DENIED',
              reason: 'Current buyer authorization is denied',
              retryable: false,
            }),
          ),
        resolveRevalidation: () =>
          Effect.fail(
            new PurchasingApprovalRejected({
              code: 'CURRENT_STATE_INDETERMINATE',
              reason: 'Current approval evidence is unavailable',
              retryable: true,
            }),
          ),
      };
      let submitWorkflowCalls = 0;
      let revalidateWorkflowCalls = 0;
      const submitCollector = createActionCollector(
        submitPurchaseApprovalRequestAction.descriptor.domainEvents,
        'commerce.customer-context',
        submitPurchaseApprovalRequestAction.descriptor.accessEvidencePolicy,
        submitPurchaseApprovalRequestAction.descriptor.auditEvidenceSchema,
      );
      const submitExit = yield* Effect.exit(
        getActionHandler(submitPurchaseApprovalRequestAction)(
          submitPayload,
          contextFor(
            submitCollector,
            makeWorkflow({
              submitRequest: () => {
                submitWorkflowCalls += 1;
                return Effect.die('forged submission reached the owner workflow');
              },
            }),
            'forged-submit-action',
            rejectingCurrentness,
          ),
        ),
      );
      const revalidateCollector = createActionCollector(
        revalidatePurchaseApprovalAction.descriptor.domainEvents,
        'commerce.customer-context',
        revalidatePurchaseApprovalAction.descriptor.accessEvidencePolicy,
        revalidatePurchaseApprovalAction.descriptor.auditEvidenceSchema,
      );
      const revalidateExit = yield* Effect.exit(
        getActionHandler(revalidatePurchaseApprovalAction)(
          revalidatePayload,
          contextFor(
            revalidateCollector,
            makeWorkflow({
              revalidate: () => {
                revalidateWorkflowCalls += 1;
                return Effect.die('forged revalidation reached the owner workflow');
              },
            }),
            'forged-revalidate-action',
            rejectingCurrentness,
          ),
        ),
      );
      expect(Exit.isFailure(submitExit)).toBe(true);
      expect(Exit.isFailure(revalidateExit)).toBe(true);
      expect(submitWorkflowCalls).toBe(0);
      expect(revalidateWorkflowCalls).toBe(0);
    }),
);

it.effect('fails closed when proposal candidate currentness is not owner-configured', () =>
  Effect.gen(function* rejectsWithoutCandidateOwner() {
    const { loadCandidateCurrent: _loadCandidateCurrent, ...currentnessWithoutCandidate } =
      currentness;
    const payload: CreatePurchaseProposalRevisionPayload = {
      proposal,
      idempotencyKey: 'candidate-owner-missing',
      verifiedEvidence: {
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        proposalCurrent: true,
        sourceRevisions: [
          { source: 'counterparty-policy', revision: '1' },
          { source: 'customer-commerce-policy', revision: '1' },
          { source: 'principal-override', revision: '1' },
          { source: 'purchase-proposal', revision: '1' },
          { source: 'purchasing-profile', revision: '1' },
          { source: 'storefront-context', revision: '1' },
        ],
      },
    };
    let workflowCalls = 0;
    const collector = createActionCollector(
      createPurchaseProposalRevisionAction.descriptor.domainEvents,
      'commerce.customer-context',
      createPurchaseProposalRevisionAction.descriptor.accessEvidencePolicy,
      createPurchaseProposalRevisionAction.descriptor.auditEvidenceSchema,
    );
    const failure = yield* Effect.flip(
      getActionHandler(createPurchaseProposalRevisionAction)(
        payload,
        contextFor(
          collector,
          makeWorkflow({
            createProposal: () => {
              workflowCalls += 1;
              return Effect.die('caller evidence reached the owner workflow');
            },
          }),
          'candidate-owner-missing-action',
          currentnessWithoutCandidate,
        ),
      ),
    );
    expect(failure).toMatchObject({
      _tag: 'PurchasingApprovalRejected',
      code: 'CURRENT_STATE_INDETERMINATE',
      retryable: true,
    });
    expect(workflowCalls).toBe(0);
    expect(collector.snapshot().dataAccessEvents).toHaveLength(0);
    expect(collector.snapshot().auditEvidence).toEqual({});
  }),
);

it.effect('consumes the exact Order commit once and keeps replay idempotent', () =>
  Effect.gen(function* verifyConsumeActionEvidence() {
    const orderRef = Schema.decodeUnknownSync(OrderResourceRefSchema)({
      moduleId: 'commerce.order',
      resourceId: 'order-1',
      resourceType: 'commerce.order.order',
      tenantId,
    });
    const approvedRoute = Schema.decodeUnknownSync(ApprovalRouteSchema)({
      ...routeEncoded,
      levels: [
        {
          ...routeEncoded.levels[0]!,
          completedBy: principal(approverId),
          completedAt: atText,
        },
      ],
      currentLevelOrder: 1,
      status: 'APPROVED',
    });
    const consumedRequest = Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
      requestRef: request.requestRef,
      proposal: { ...proposalEncoded, state: 'CONSUMED' },
      route: Schema.encodeSync(ApprovalRouteSchema)(approvedRoute),
      status: 'CONSUMED',
      submittedAt: atText,
      expiresAt: expiresAtText,
      idempotencyKey: request.idempotencyKey,
      requestRevision: request.requestRevision + 1,
      consumedAt: atText,
      committedOrderRef: orderRef,
      consumptionCommitmentId: 'commitment-1',
      decisionBundleHash: 'b'.repeat(64),
      decisionBundleVersion: 'approval-decision-bundle.v1',
      lastDecisionRef: decision.decisionRef,
    });
    const payload: ConsumePurchaseApprovalPayload = {
      counterpartyRef,
      requestRef: consumedRequest.requestRef,
      proposalRevisionRef: consumedRequest.proposal.proposalRevisionRef,
      decisionBundleHash: 'b'.repeat(64),
      decisionBundleVersion: 'approval-decision-bundle.v1',
      commitmentCorrelationId: 'commitment-1',
      orderRef,
      idempotencyKey: 'commitment-1',
      committedAt: at,
      storefrontId,
    };
    const result: ConsumePurchaseApprovalResult = {
      outcome: 'CONSUMED',
      request: consumedRequest,
    };
    const collector = createActionCollector(
      consumePurchaseApprovalAction.descriptor.domainEvents,
      'commerce.customer-context',
      consumePurchaseApprovalAction.descriptor.accessEvidencePolicy,
      consumePurchaseApprovalAction.descriptor.auditEvidenceSchema,
    );
    const workflow = makeWorkflow({ consume: () => Effect.succeed(result) });
    yield* getActionHandler(consumePurchaseApprovalAction)(
      payload,
      contextFor(collector, workflow, 'consume-action-1'),
    );
    expect(
      collector.snapshot().dataAccessEvents.map(({ targetResourceId }) => targetResourceId),
    ).toEqual([
      'request-1',
      'proposal-1',
      'route-1',
      'hierarchy-1',
      'profile-1',
      'counterparty-1',
      'order-1',
    ]);
    expect(collector.snapshot().auditEvidence).toMatchObject({
      completionRule: 'ONE_APPROVER',
      decisionBundleHash: 'b'.repeat(64),
      orderRef: 'order-1',
    });
    expect(collector.snapshot().domainEvents).toHaveLength(1);
    expect(collector.snapshot().outboxMessages).toHaveLength(1);

    const replayCollector = createActionCollector(
      consumePurchaseApprovalAction.descriptor.domainEvents,
      'commerce.customer-context',
      consumePurchaseApprovalAction.descriptor.accessEvidencePolicy,
      consumePurchaseApprovalAction.descriptor.auditEvidenceSchema,
    );
    const replayResult: ConsumePurchaseApprovalResult = {
      ...result,
      outcome: 'ALREADY_CONSUMED',
    };
    yield* getActionHandler(consumePurchaseApprovalAction)(
      payload,
      contextFor(
        replayCollector,
        makeWorkflow({ consume: () => Effect.succeed(replayResult) }),
        'consume-action-replay',
      ),
    );
    expect(replayCollector.snapshot().auditEvidence).toMatchObject({
      outcome: 'ALREADY_CONSUMED',
      completionRule: 'ONE_APPROVER',
    });
    expect(replayCollector.snapshot().dataAccessEvents).toHaveLength(7);
    expect(replayCollector.snapshot().domainEvents).toHaveLength(0);
    expect(replayCollector.snapshot().outboxMessages).toHaveLength(0);

    const untrustedCollector = createActionCollector(
      consumePurchaseApprovalAction.descriptor.domainEvents,
      'commerce.customer-context',
      consumePurchaseApprovalAction.descriptor.accessEvidencePolicy,
      consumePurchaseApprovalAction.descriptor.auditEvidenceSchema,
    );
    const untrustedFailure = yield* Effect.flip(
      getActionHandler(consumePurchaseApprovalAction)(payload, {
        ...contextFor(
          untrustedCollector,
          makeWorkflow({ consume: () => Effect.succeed(result) }),
          'consume-action-untrusted',
        ),
        // Spreading the redeemed context intentionally drops its non-enumerable provenance
        // marker; an authMethod-shaped object must not gain Order commit authority.
        scope: { ...scope },
      }),
    );
    expect(untrustedFailure).toMatchObject({
      _tag: 'PurchasingApprovalRejected',
      code: 'PERMISSION_DENIED',
    });
    expect(untrustedCollector.snapshot().dataAccessEvents).toHaveLength(0);
  }),
);
