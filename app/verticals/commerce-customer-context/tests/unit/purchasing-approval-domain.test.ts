import { Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CoreSearchResourceRefSchema } from '@app/core-runtime';

import {
  ApprovalHierarchySchema,
  ApprovalDecisionSchema,
  DecidePurchaseApprovalRequestInputSchema,
  PurchaseApprovalRequestSchema,
  applyApprovalDecision,
  revalidateApproval,
  resolveApprovalHierarchy,
} from '../../shared/domain/purchasing-approval.ts';
import { purchasingApprovalPolicy } from '../../src/policies/purchasing-approval.policy.ts';
import { MonetaryAmountSchema } from '../../shared/domain/purchase-limit.ts';
import { createApprovalHierarchyAction } from '../../src/actions/create-approval-hierarchy.action.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';
import { reroutePurchaseApprovalRequestAction } from '../../src/actions/reroute-purchase-approval-request.action.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const buyerId = '10000000-0000-4000-8000-000000000002';
const approverId = '10000000-0000-4000-8000-000000000003';
const otherApproverId = '10000000-0000-4000-8000-000000000004';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const atText = '2026-09-09T12:00:00.000Z';
const at = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(atText);
const later = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-09T12:30:00.000Z');
const expiresAtText = '2026-09-09T13:00:00.000Z';
const expiresAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(expiresAtText);

const counterpartyRef = Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
});

const principal = (principalId: string) => ({ principalId, tenantId });
const money = (amount: string) => Schema.decodeUnknownSync(MonetaryAmountSchema)({ amount, currency: 'EUR' });

const proposalPaymentTerm = {
  code: 'NET30',
  definitionRef: {
    moduleId: 'payment-term-catalog',
    resourceId: 'net-30',
    resourceType: 'payment-term-catalog.payment-term-definition',
    tenantId,
  },
  definitionRevision: '1',
};

const proposalRevisionRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'proposal-1',
  resourceType: 'commerce.customer-context.purchase-proposal-revision',
  tenantId,
} as const;

const hierarchy = (resourceId: string, storefrontId: string | null) =>
  Schema.decodeUnknownSync(ApprovalHierarchySchema)({
    createdAt: atText,
    effectiveFrom: atText,
    effectiveTo: null,
    hierarchyRef: {
      moduleId: 'commerce.customer-context',
      resourceId,
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
    ownerPrincipal: principal(otherApproverId),
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

const request = () =>
  Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
    committedOrderRef: null,
    consumedAt: null,
    consumptionCommitmentId: null,
    decisionBundleHash: null,
    decisionBundleVersion: null,
    expiresAt: expiresAtText,
    idempotencyKey: 'request-idempotency-1',
    lastDecisionRef: null,
    proposal: {
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
        storefrontId: 'storefront-eu',
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
        storefrontId: 'storefront-eu',
      },
      identity: {
        buyer: principal(buyerId),
        counterpartyRef,
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: 'profile-1',
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId,
        },
      },
      invoiceRecipient: { address: { country: 'CZ' }, kind: 'INVOICE', method: 'BILLING_ADDRESS' },
      ...purchasingApprovalCommercialFixture({ money, tenantId }),
      payment: 'NONE',
      paymentTerm: proposalPaymentTerm,
      policyRefs: [],
      pricingRevision: 'pricing-r1',
      proposalRevisionRef,
      proposalSequence: 1,
      reservation: 'NONE',
      revision: 1,
      state: 'CURRENT',
      taxRevision: 'tax-r1',
    },
    requestRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'request-1',
      resourceType: 'commerce.customer-context.purchase-approval-request',
      tenantId,
    },
    requestRevision: 1,
    route: {
      capturedAt: atText,
      currentLevelOrder: 1,
      hierarchyRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'hierarchy-storefront',
        resourceType: 'commerce.customer-context.approval-hierarchy',
        tenantId,
      },
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
      proposalRevisionRef,
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
    },
    status: 'PENDING',
    submittedAt: atText,
  });

it('prefers an exact Storefront hierarchy and rejects ambiguous same-precedence matches', () => {
  const exact = resolveApprovalHierarchy({
    at,
    candidates: [hierarchy('counterparty-wide', null), hierarchy('storefront-specific', 'storefront-eu')],
    counterpartyRef,
    purchaseValue: money('120'),
    storefrontId: 'storefront-eu',
  });
  expect(Predicate.isTagged(exact, 'HIERARCHY_RESOLVED')).toBe(true);
  if (Predicate.isTagged(exact, 'HIERARCHY_RESOLVED')) {
    expect(exact.hierarchy.hierarchyRef.resourceId).toBe('storefront-specific');
  }

  const ambiguous = resolveApprovalHierarchy({
    at,
    candidates: [hierarchy('wide-a', null), hierarchy('wide-b', null)],
    counterpartyRef,
    purchaseValue: money('120'),
    storefrontId: 'storefront-eu',
  });
  expect(Predicate.isTagged(ambiguous, 'HIERARCHY_AMBIGUOUS')).toBe(true);
});

it('attaches the concrete purchasing policy to every governed approval Action', () => {
  const actions = [
    createPurchaseProposalRevisionAction,
    submitPurchaseApprovalRequestAction,
    createApprovalHierarchyAction,
    decidePurchaseApprovalRequestAction,
    reroutePurchaseApprovalRequestAction,
    revalidatePurchaseApprovalAction,
  ];
  for (const action of actions) {
    expect(action.descriptor.policies).toHaveLength(1);
    expect(action.descriptor.policies[0]).toBe(purchasingApprovalPolicy);
    expect(action.descriptor.policies[0]?.policyKey).toBe('commerce.customer-context.purchasing-approval.v1');
    expect(action.descriptor.auditEvidenceSchema).toBeDefined();
  }
});

it('requires both route eligibility and the explicit self-approval policy', () => {
  const pending = request();
  const deniedSelfApproval = applyApprovalDecision({
    actor: principal(buyerId),
    hierarchy: hierarchy('storefront-specific', 'storefront-eu'),
    kind: 'APPROVE',
    now: later,
    request: pending,
  });
  expect(Predicate.isTagged(deniedSelfApproval, 'NOT_ROUTE_ELIGIBLE')).toBe(true);

  const eligibleRoute = {
    ...pending,
    route: {
      ...pending.route,
      levels: [{ ...pending.route.levels[0], candidates: [principal(buyerId)] }],
    },
  };
  const denied = applyApprovalDecision({
    actor: principal(buyerId),
    hierarchy: hierarchy('storefront-specific', 'storefront-eu'),
    kind: 'APPROVE',
    now: later,
    request: eligibleRoute,
  });
  expect(Predicate.isTagged(denied, 'SELF_APPROVAL_DENIED')).toBe(true);
});

it('requires a reason for return and reject decisions in domain and Action input evidence', () => {
  const decisionInput = {
    actor: principal(approverId),
    counterpartyRef,
    decidedAt: at,
    decision: 'APPROVE' as const,
    expectedRequestRevision: 1,
    idempotencyKey: 'decision-reason-1',
    proposalRevisionRef: request().proposal.proposalRevisionRef,
    reason: null,
    requestRef: request().requestRef,
    storefrontId: 'storefront-eu',
  };
  expect(Schema.is(DecidePurchaseApprovalRequestInputSchema)(decisionInput)).toBe(true);
  expect(
    Schema.is(DecidePurchaseApprovalRequestInputSchema)({
      ...decisionInput,
      decision: 'RETURN',
    }),
  ).toBe(false);
  expect(
    Schema.is(DecidePurchaseApprovalRequestInputSchema)({
      ...decisionInput,
      decision: 'REJECT',
      reason: '   ',
    }),
  ).toBe(false);
  expect(
    Schema.is(DecidePurchaseApprovalRequestInputSchema)({
      ...decisionInput,
      decision: 'REJECT',
      reason: 'Budget policy requires a revised proposal',
    }),
  ).toBe(true);

  const approvalDecision = {
    actor: decisionInput.actor,
    decisionBundleHash: 'b'.repeat(64),
    decisionBundleVersion: 'approval-decision-bundle.v1' as const,
    decisionRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'decision-reason-1',
      resourceType: 'commerce.customer-context.approval-decision',
      tenantId,
    },
    hierarchyRef: request().route.hierarchyRef,
    hierarchyRevision: 1,
    idempotencyKey: 'decision-reason-1',
    kind: 'REJECT' as const,
    levelOrder: 1,
    proposalRevisionRef: decisionInput.proposalRevisionRef,
    reason: 'Budget policy requires a revised proposal',
    recordedAt: at,
    requestRef: decisionInput.requestRef,
    requestRevision: 2,
    routeRef: request().route.routeRef,
  };
  expect(Schema.is(ApprovalDecisionSchema)(approvalDecision)).toBe(true);
  expect(Schema.is(ApprovalDecisionSchema)({ ...approvalDecision, reason: null })).toBe(false);
});

it('revalidates only an approved exact revision and keeps consumed approval terminal', () => {
  const approved = { ...request(), status: 'APPROVED' as const };
  const valid = revalidateApproval({
    buyerPermission: 'ALLOWED',
    checkedAt: later,
    exactProposalHashMatches: true,
    profileState: 'ACTIVE',
    request: approved,
    routeCurrent: true,
    validUntil: expiresAt,
  });
  expect(Predicate.isTagged(valid, 'APPROVAL_VALID')).toBe(true);
  expect(valid).toMatchObject({ validUntil: expiresAt });

  const materialChange = revalidateApproval({
    buyerPermission: 'ALLOWED',
    checkedAt: later,
    exactProposalHashMatches: false,
    profileState: 'ACTIVE',
    request: approved,
    routeCurrent: true,
    validUntil: expiresAt,
  });
  expect(Predicate.isTagged(materialChange, 'PROPOSAL_MATERIAL_CHANGE')).toBe(true);

  const consumed = revalidateApproval({
    buyerPermission: 'ALLOWED',
    checkedAt: later,
    exactProposalHashMatches: true,
    profileState: 'ACTIVE',
    request: { ...approved, status: 'CONSUMED' },
    routeCurrent: true,
    validUntil: expiresAt,
  });
  expect(Predicate.isTagged(consumed, 'ALREADY_CONSUMED')).toBe(true);

  const expired = revalidateApproval({
    buyerPermission: 'ALLOWED',
    checkedAt: expiresAt,
    exactProposalHashMatches: true,
    profileState: 'ACTIVE',
    request: approved,
    routeCurrent: true,
    validUntil: expiresAt,
  });
  expect(Predicate.isTagged(expired, 'REQUEST_EXPIRED')).toBe(true);

  const late = revalidateApproval({
    buyerPermission: 'ALLOWED',
    checkedAt: later,
    exactProposalHashMatches: true,
    profileState: 'ACTIVE',
    request: approved,
    routeCurrent: true,
    validUntil: later,
  });
  expect(Predicate.isTagged(late, 'REQUEST_EXPIRED')).toBe(true);
});
