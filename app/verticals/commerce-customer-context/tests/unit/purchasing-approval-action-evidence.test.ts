import { Effect, Exit, Predicate, Schema } from 'effect';
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
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import {
  PurchaseApprovalProfileEvidenceSchema,
  PurchaseApprovalProposalEvidenceSchema,
} from '../../shared/domain/purchase-limit-approval-trigger.ts';
import type { PurchasingApprovalWorkflowService } from '../../src/persistence/purchasing-approval-persistence.ts';
import type { PurchaseApprovalOrderCommitmentPort } from '../../shared/domain/purchase-approval-order-commitment-port.ts';
import { createApprovalHierarchyAction } from '../../src/actions/create-approval-hierarchy.action.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';
import { reroutePurchaseApprovalRequestAction } from '../../src/actions/reroute-purchase-approval-request.action.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';
import type { PurchaseApprovalTriggerEvidenceSource } from '../../src/actions/trigger-purchase-approval.action.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';

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

const principal = (principalId: string) => Schema.decodeUnknownSync(PrincipalRefSchema)({ principalId, tenantId });
const money = (amount: string) => ({ amount, currency: 'EUR' });

const proposal = Schema.decodeUnknownSync(PurchaseProposalRevisionSchema)({
  approvalEvaluation: 'APPROVAL_REQUIRED',
  approvalTrigger: {
    policyRevision: 'limit-r1',
    reasonCode: 'over_limit',
    source: 'PURCHASE_LIMIT',
  },
  canonicalHash: 'a'.repeat(64),
  canonicalizationVersion: 'purchase-proposal.v1',
  context: {
    channelId: 'portal',
    evaluatedAt: atText,
    locale: 'en-US',
    marketId: 'eu',
    sellingLegalEntityId: legalEntityId,
    storefrontId,
    tenantId,
  },
  createdAt: atText,
  currency: 'EUR',
  deliveryDestination: {
    address: { country: 'CZ' },
    kind: 'DELIVERY',
    method: 'DELIVERY_ADDRESS',
  },
  effectiveLimit: money('50'),
  expiresAt: expiresAtText,
  hierarchyInputs: {
    counterpartyRef,
    evaluatedAt: atText,
    purchaseValue: money('120'),
    storefrontId,
  },
  identity: {
    buyer: principal(buyerId),
    counterpartyRef,
    profileRef,
  },
  invoiceRecipient: { address: { country: 'CZ' }, kind: 'INVOICE', method: 'BILLING_ADDRESS' },
  ...purchasingApprovalCommercialFixture({ money, tenantId }),
  payment: 'NONE',
  paymentTerm: {
    code: 'NET30',
    definitionRef: {
      moduleId: 'payment-term-catalog',
      resourceId: 'net-30',
      resourceType: 'payment-term-catalog.payment-term-definition',
      tenantId,
    },
    definitionRevision: '1',
  },
  policyRefs: [],
  pricingRevision: 'pricing-r1',
  proposalRevisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'proposal-1',
    resourceType: 'commerce.customer-context.purchase-proposal-revision',
    tenantId,
  },
  proposalSequence: 1,
  reservation: 'NONE',
  revision: 1,
  state: 'CURRENT',
  taxRevision: 'tax-r1',
});
const proposalEncoded = Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal);

const hierarchy = Schema.decodeUnknownSync(ApprovalHierarchySchema)({
  createdAt: atText,
  effectiveFrom: atText,
  effectiveTo: null,
  hierarchyRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'hierarchy-1',
    resourceType: 'commerce.customer-context.approval-hierarchy',
    tenantId,
  },
  levels: [
    {
      completionRule: 'ONE_APPROVER',
      eligiblePrincipals: [principal(approverId)],
      levelId: 'level-1',
      order: 1,
      scopeConstraints: ['exact-storefront'],
    },
  ],
  ownerPrincipal: principal(buyerId),
  reason: 'Launch policy',
  revision: 1,
  selector: {
    counterpartyRef,
    maximumPurchaseValue: null,
    minimumPurchaseValue: money('0'),
    storefrontId,
  },
  selfApprovalPolicy: 'DENY',
  state: 'ACTIVE',
});

const route = Schema.decodeUnknownSync(ApprovalRouteSchema)({
  capturedAt: atText,
  currentLevelOrder: 1,
  hierarchyRef: hierarchy.hierarchyRef,
  hierarchyRevision: 1,
  levels: [
    {
      candidates: [principal(approverId)],
      completedAt: null,
      completedBy: null,
      completionRule: 'ONE_APPROVER',
      levelId: 'level-1',
      order: 1,
    },
  ],
  proposalRevisionRef: proposal.proposalRevisionRef,
  requestRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'request-1',
    resourceType: 'commerce.customer-context.purchase-approval-request',
    tenantId,
  },
  rerouteReason: null,
  routeRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'route-1',
    resourceType: 'commerce.customer-context.approval-route',
    tenantId,
  },
  status: 'PENDING',
});
const routeEncoded = Schema.encodeSync(ApprovalRouteSchema)(route);

const request = Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
  committedOrderRef: null,
  consumedAt: null,
  consumptionCommitmentId: null,
  decisionBundleHash: null,
  decisionBundleVersion: null,
  expiresAt: expiresAtText,
  idempotencyKey: 'request-idempotency-1',
  lastDecisionRef: null,
  proposal: proposalEncoded,
  requestRef: route.requestRef,
  requestRevision: 1,
  route: routeEncoded,
  status: 'PENDING',
  submittedAt: atText,
});

const decision = Schema.decodeUnknownSync(ApprovalDecisionSchema)({
  actor: principal(buyerId),
  decisionBundleHash: 'b'.repeat(64),
  decisionBundleVersion: 'approval-decision-bundle.v1',
  decisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'decision-1',
    resourceType: 'commerce.customer-context.approval-decision',
    tenantId,
  },
  hierarchyRef: hierarchy.hierarchyRef,
  hierarchyRevision: hierarchy.revision,
  idempotencyKey: 'decision-idempotency-1',
  kind: 'APPROVE',
  levelOrder: 1,
  proposalRevisionRef: proposal.proposalRevisionRef,
  reason: null,
  recordedAt: atText,
  requestRef: request.requestRef,
  requestRevision: 2,
  routeRef: route.routeRef,
});

const revalidation = Schema.decodeUnknownSync(ApprovalRevalidationSchema)({
  approvedRoute: routeEncoded,
  checkedAt: atText,
  committedOrderRef: null,
  evidence: {
    buyerPermission: 'ALLOWED',
    commitmentCorrelationId: 'commitment-1',
    decisionBundleHash: decision.decisionBundleHash,
    decisionBundleVersion: decision.decisionBundleVersion,
    decisionRef: decision.decisionRef,
    hierarchyRef: hierarchy.hierarchyRef,
    policyRouteCurrent: true,
    profileState: 'ACTIVE',
    proposalHash: proposal.canonicalHash,
    routeRef: route.routeRef,
    sourceRevisions: [{ revision: '1', source: 'purchase-proposal' }],
  },
  proposalRevisionRef: proposal.proposalRevisionRef,
  requestRef: request.requestRef,
  revalidationRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'revalidation-1',
    resourceType: 'commerce.customer-context.approval-revalidation',
    tenantId,
  },
  status: 'APPROVAL_VALID',
  validUntil: expiresAtText,
});

type WorkflowOverrides = Partial<
  Pick<
    PurchasingApprovalWorkflowService,
    'createProposal' | 'createHierarchy' | 'submitRequest' | 'decide' | 'reroute' | 'revalidate' | 'consume'
  >
>;

const makeWorkflow = (overrides: WorkflowOverrides): PurchasingApprovalWorkflowService => {
  // oxlint-disable-next-line eslint/prefer-const -- The self-referential test fixture must be declared before its object initializer captures it.
  let workflow!: PurchasingApprovalWorkflowService;
  workflow = {
    consume: overrides.consume ?? (() => Effect.die('unused')),
    createHierarchy: overrides.createHierarchy ?? (() => Effect.die('unused')),
    createProposal: overrides.createProposal ?? (() => Effect.die('unused')),
    decide: overrides.decide ?? (() => Effect.die('unused')),
    forActionInvocation: () => workflow,
    reroute: overrides.reroute ?? (() => Effect.die('unused')),
    revalidate: overrides.revalidate ?? (() => Effect.die('unused')),
    submit: () => Effect.die('unused'),
    submitRequest: overrides.submitRequest ?? (() => Effect.die('unused')),
  };
  return workflow;
};

/** Test-only owner adapter: production composition uses the transaction-bound SQL Currentness port. */
const loadCurrentness: NonNullable<PurchaseApprovalTriggerEvidenceSource['loadCandidateCurrent']> = ({
  payload,
  trustedContext,
}) =>
  Effect.succeed({
    currentSourceRevisions: payload.expectedSourceRevisions,
    profileEvidence: Schema.decodeUnknownSync(PurchaseApprovalProfileEvidenceSchema)({
      counterpartyRef: payload.counterpartyRef,
      evaluatedAt: atText,
      evaluationContext: trustedContext,
      gate: { canAcceptNewOrder: true, outcome: 'ACTIVE' as const },
      profileRef: payload.profileRef,
      revision: 1,
      sourceRevision: '1',
    }),
    proposalEvidence: Schema.decodeUnknownSync(PurchaseApprovalProposalEvidenceSchema)({
      evaluatedAt: atText,
      evaluationContext: trustedContext,
      proposalRevisionRef: payload.proposalRevisionRef,
      purchaseValue: payload.purchaseValue,
      revision: '1',
      state: 'CURRENT' as const,
    }),
  });

type TestCurrentness = PurchaseApprovalCurrentnessService & PurchaseApprovalTriggerEvidenceSource;

const currentness: TestCurrentness = {
  loadCandidateCurrent: loadCurrentness,
  loadCurrent: loadCurrentness,
  resolveCandidate: ({ input }) =>
    Effect.succeed(
      Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
        channelId: 'test-channel',
        contextRevision: '1',
        currentSourceRevisions: input.expectedSourceRevisions,
        marketId: 'test-market',
        purchaseValue: input.claimedPurchaseValue,
      }),
    ),
  // These two methods model the transaction-bound owner adapter used by submit/revalidate.
  // The action evidence test intentionally supplies already validated fixtures; production
  // composition never installs this test adapter.
  resolveRevalidation: ({ claimed }) => Effect.succeed(claimed),
  resolveSubmission: ({ claimed }) => Effect.succeed(claimed),
};

const contextFor = <DomainEvents extends DomainEventContractMap>(
  collector: ActionCollector<DomainEvents>,
  workflow: PurchasingApprovalWorkflowService,
  actionInvocationId: string,
  currentnessOverride: TestCurrentness = currentness,
): ActionHandlerContext<
  DomainEvents,
  {
    readonly commitment: PurchaseApprovalOrderCommitmentPort;
    readonly currentness: TestCurrentness;
    readonly workflow: PurchasingApprovalWorkflowService;
  }
> => ({
  actionInvocationId,
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope,
  services: {
    commitment: {
      consume: (input) => workflow.consume(input),
    },
    currentness: currentnessOverride,
    workflow,
  },
});

const expectCommittedEvidence = (
  snapshot: ReturnType<ActionCollector<Readonly<Record<string, never>>>['snapshot']>,
  targetResourceIds: readonly string[],
) => {
  expect(snapshot.auditEvidence).toBeDefined();
  expect(snapshot.dataAccessEvents).toHaveLength(targetResourceIds.length);
  expect(snapshot.dataAccessEvents.map(({ targetResourceId }) => targetResourceId)).toEqual(targetResourceIds);
  expect(snapshot.dataAccessEvents.every(({ evidenceCaptureMode }) => evidenceCaptureMode === 'metadata_only')).toBe(
    true,
  );
  expect(snapshot.domainEvents).toHaveLength(1);
  expect(snapshot.outboxMessages).toHaveLength(1);
};

it.effect('successful Purchasing Approval Actions commit audit, metadata-only access, and events', () =>
  // @ts-expect-error -- Direct-handler evidence tests intentionally omit production-only service Layers and supply explicit context doubles for each exercised path.
  Effect.gen(function* verifyApprovalActionEvidence() {
    const createProposalPayload: CreatePurchaseProposalRevisionPayload = {
      idempotencyKey: 'proposal-idempotency-1',
      proposal,
      verifiedEvidence: {
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        proposalCurrent: true,
        sourceRevisions: [
          { revision: '1', source: 'counterparty-policy' },
          { revision: '1', source: 'customer-commerce-policy' },
          { revision: '1', source: 'principal-override' },
          { revision: '1', source: 'purchase-proposal' },
          { revision: '1', source: 'purchasing-profile' },
          { revision: '1', source: 'storefront-context' },
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
    expectCommittedEvidence(proposalCollector.snapshot(), ['proposal-1', 'profile-1', 'counterparty-1']);

    const hierarchyPayload: CreateApprovalHierarchyPayload = {
      hierarchy,
      idempotencyKey: 'hierarchy-idempotency-1',
    };
    const hierarchyResult: CreateApprovalHierarchyResult = {
      hierarchy,
      outcome: 'CREATED',
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
      idempotencyKey: 'submit-idempotency-1',
      proposalRevision: proposal.revision,
      proposalRevisionRef: proposal.proposalRevisionRef,
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
      // @ts-expect-error -- The direct-handler test supplies the exact runtime doubles used by this path while the generic service map remains intentionally narrower.
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
      decidedAt: at,
      decision: 'APPROVE',
      expectedRequestRevision: 1,
      idempotencyKey: 'decision-idempotency-1',
      proposalRevisionRef: proposal.proposalRevisionRef,
      reason: null,
      requestRef: request.requestRef,
      storefrontId,
    };
    const decideResult: DecidePurchaseApprovalRequestResult = {
      decision,
      outcome: 'DECISION_RECORDED',
      request: {
        ...request,
        lastDecisionRef: decision.decisionRef,
        requestRevision: 2,
        status: 'APPROVED',
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
      contextFor(decideCollector, makeWorkflow({ decide: () => Effect.succeed(decideResult) }), 'decide-action-1'),
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
      expectedRequestRevision: 1,
      idempotencyKey: 'reroute-idempotency-1',
      reason: 'Policy changed',
      requestRef: request.requestRef,
      reroutedAt: at,
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
      contextFor(rerouteCollector, makeWorkflow({ reroute: () => Effect.succeed(rerouteResult) }), 'reroute-action-1'),
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
      buyerPermission: 'ALLOWED',
      checkedAt: at,
      commitmentCorrelationId: 'commitment-1',
      counterpartyRef,
      decisionBundleHash: decision.decisionBundleHash,
      decisionBundleVersion: decision.decisionBundleVersion,
      decisionRef: decision.decisionRef,
      expectedProposalHash: proposal.canonicalHash,
      hierarchyRef: hierarchy.hierarchyRef,
      idempotencyKey: 'revalidate-idempotency-1',
      profileState: 'ACTIVE',
      proposalRevisionRef: proposal.proposalRevisionRef,
      requestRef: request.requestRef,
      routeCurrent: true,
      routeRef: route.routeRef,
      sourceRevisions: [{ revision: '1', source: 'purchase-proposal' }],
      storefrontId,
      validUntil: expiresAt,
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
      // @ts-expect-error -- The direct-handler test supplies the exact runtime doubles used by this path while the generic service map remains intentionally narrower.
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

it.effect('does not let forged favorable submission or revalidation evidence bypass owner currentness', () =>
  // @ts-expect-error -- Direct-handler rejection tests intentionally omit production-only service Layers and supply rejecting context doubles.
  Effect.gen(function* rejectsForgedApprovalEvidence() {
    const submitPayload: SubmitPurchaseApprovalRequestPayload = {
      counterpartyRef,
      idempotencyKey: 'forged-submit-idempotency',
      proposalRevision: proposal.revision,
      proposalRevisionRef: proposal.proposalRevisionRef,
      requestExpiresAt: expiresAt,
      storefrontId,
    };
    const revalidatePayload: RevalidatePurchaseApprovalPayload = {
      buyerPermission: 'ALLOWED',
      checkedAt: at,
      commitmentCorrelationId: 'forged-commitment',
      counterpartyRef,
      decisionBundleHash: decision.decisionBundleHash,
      decisionBundleVersion: decision.decisionBundleVersion,
      decisionRef: decision.decisionRef,
      expectedProposalHash: proposal.canonicalHash,
      hierarchyRef: hierarchy.hierarchyRef,
      idempotencyKey: 'forged-revalidate-idempotency',
      profileState: 'ACTIVE',
      proposalRevisionRef: proposal.proposalRevisionRef,
      requestRef: request.requestRef,
      routeCurrent: true,
      routeRef: route.routeRef,
      sourceRevisions: [{ revision: '1', source: 'purchase-proposal' }],
      storefrontId,
      validUntil: expiresAt,
    };
    const rejectingCurrentness: TestCurrentness = {
      ...currentness,
      resolveRevalidation: () =>
        Effect.fail(
          new PurchasingApprovalRejected({
            code: 'CURRENT_STATE_INDETERMINATE',
            reason: 'Current approval evidence is unavailable',
            retryable: true,
          }),
        ),
      resolveSubmission: () =>
        Effect.fail(
          new PurchasingApprovalRejected({
            code: 'BUYER_PERMISSION_DENIED',
            reason: 'Current buyer authorization is denied',
            retryable: false,
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
        // @ts-expect-error -- This fail-closed direct invocation intentionally uses the rejecting test service map rather than production composition.
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
        // @ts-expect-error -- This fail-closed direct invocation intentionally uses the rejecting test service map rather than production composition.
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
  // @ts-expect-error -- This direct-handler failure test intentionally omits the production candidate-currentness Layer.
  Effect.gen(function* rejectsWithoutCandidateOwner() {
    const { loadCandidateCurrent: _loadCandidateCurrent, ...currentnessWithoutCandidate } = currentness;
    const payload: CreatePurchaseProposalRevisionPayload = {
      idempotencyKey: 'candidate-owner-missing',
      proposal,
      verifiedEvidence: {
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        proposalCurrent: true,
        sourceRevisions: [
          { revision: '1', source: 'counterparty-policy' },
          { revision: '1', source: 'customer-commerce-policy' },
          { revision: '1', source: 'principal-override' },
          { revision: '1', source: 'purchase-proposal' },
          { revision: '1', source: 'purchasing-profile' },
          { revision: '1', source: 'storefront-context' },
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
    expect(Predicate.isTagged(failure, 'PurchasingApprovalRejected')).toBe(true);
    expect(failure).toMatchObject({
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
      currentLevelOrder: 1,
      levels: [
        {
          ...routeEncoded.levels[0],
          completedAt: atText,
          completedBy: principal(approverId),
        },
      ],
      status: 'APPROVED',
    });
    const consumedRequest = Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
      committedOrderRef: orderRef,
      consumedAt: atText,
      consumptionCommitmentId: 'commitment-1',
      decisionBundleHash: 'b'.repeat(64),
      decisionBundleVersion: 'approval-decision-bundle.v1',
      expiresAt: expiresAtText,
      idempotencyKey: request.idempotencyKey,
      lastDecisionRef: decision.decisionRef,
      proposal: { ...proposalEncoded, state: 'CONSUMED' },
      requestRef: request.requestRef,
      requestRevision: request.requestRevision + 1,
      route: Schema.encodeSync(ApprovalRouteSchema)(approvedRoute),
      status: 'CONSUMED',
      submittedAt: atText,
    });
    const payload: ConsumePurchaseApprovalPayload = {
      commitmentCorrelationId: 'commitment-1',
      committedAt: at,
      counterpartyRef,
      decisionBundleHash: 'b'.repeat(64),
      decisionBundleVersion: 'approval-decision-bundle.v1',
      idempotencyKey: 'commitment-1',
      orderRef,
      proposalRevisionRef: consumedRequest.proposal.proposalRevisionRef,
      requestRef: consumedRequest.requestRef,
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
    expect(collector.snapshot().dataAccessEvents.map(({ targetResourceId }) => targetResourceId)).toEqual([
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
      completionRule: 'ONE_APPROVER',
      outcome: 'ALREADY_CONSUMED',
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
    expect(Predicate.isTagged(untrustedFailure, 'PurchasingApprovalRejected')).toBe(true);
    expect(untrustedFailure).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(untrustedCollector.snapshot().dataAccessEvents).toHaveLength(0);
  }),
);
