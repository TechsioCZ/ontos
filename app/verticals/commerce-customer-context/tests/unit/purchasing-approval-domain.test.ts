import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

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
import { createApprovalHierarchyAction } from '../../src/actions/create-approval-hierarchy.action.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';
import { reroutePurchaseApprovalRequestAction } from '../../src/actions/reroute-purchase-approval-request.action.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';

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

const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;

const principal = (principalId: string) => ({ principalId, tenantId });
const money = (amount: string) => ({ amount, currency: 'EUR' as const });

const hierarchy = (resourceId: string, storefrontId: string | null) =>
  Schema.decodeUnknownSync(ApprovalHierarchySchema)({
    hierarchyRef: {
      moduleId: 'commerce.customer-context',
      resourceId,
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
    ownerPrincipal: principal(otherApproverId),
    reason: 'Launch policy',
    state: 'ACTIVE',
    createdAt: atText,
  });

const request = () =>
  Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
    requestRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'request-1',
      resourceType: 'commerce.customer-context.purchase-approval-request',
      tenantId,
    },
    proposal: {
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
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: 'profile-1',
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId,
        },
      },
      context: {
        channelId: 'portal',
        locale: 'en-US',
        marketId: 'eu',
        storefrontId: 'storefront-eu',
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
        storefrontId: 'storefront-eu',
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
    },
    route: {
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
      proposalRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'proposal-1',
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId,
      },
      hierarchyRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'hierarchy-storefront',
        resourceType: 'commerce.customer-context.approval-hierarchy',
        tenantId,
      },
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
    },
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

it('prefers an exact Storefront hierarchy and rejects ambiguous same-precedence matches', () => {
  const exact = resolveApprovalHierarchy({
    candidates: [
      hierarchy('counterparty-wide', null),
      hierarchy('storefront-specific', 'storefront-eu'),
    ],
    counterpartyRef,
    storefrontId: 'storefront-eu',
    purchaseValue: money('120'),
    at,
  });
  expect(exact._tag).toBe('HIERARCHY_RESOLVED');
  if (exact._tag === 'HIERARCHY_RESOLVED') {
    expect(exact.hierarchy.hierarchyRef.resourceId).toBe('storefront-specific');
  }

  const ambiguous = resolveApprovalHierarchy({
    candidates: [hierarchy('wide-a', null), hierarchy('wide-b', null)],
    counterpartyRef,
    storefrontId: 'storefront-eu',
    purchaseValue: money('120'),
    at,
  });
  expect(ambiguous._tag).toBe('HIERARCHY_AMBIGUOUS');
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
    expect(action.descriptor.policies[0]?.policyKey).toBe(
      'commerce.customer-context.purchasing-approval.v1',
    );
    expect(action.descriptor.auditEvidenceSchema).toBeDefined();
  }
});

it('requires both route eligibility and the explicit self-approval policy', () => {
  const pending = request();
  const deniedSelfApproval = applyApprovalDecision({
    request: pending,
    hierarchy: hierarchy('storefront-specific', 'storefront-eu'),
    actor: principal(buyerId),
    kind: 'APPROVE',
    now: later,
  });
  expect(deniedSelfApproval._tag).toBe('NOT_ROUTE_ELIGIBLE');

  const eligibleRoute = {
    ...pending,
    route: {
      ...pending.route,
      levels: [{ ...pending.route.levels[0]!, candidates: [principal(buyerId)] }],
    },
  };
  const denied = applyApprovalDecision({
    request: eligibleRoute,
    hierarchy: hierarchy('storefront-specific', 'storefront-eu'),
    actor: principal(buyerId),
    kind: 'APPROVE',
    now: later,
  });
  expect(denied._tag).toBe('SELF_APPROVAL_DENIED');
});

it('requires a reason for return and reject decisions in domain and Action input evidence', () => {
  const decisionInput = {
    actor: principal(approverId),
    counterpartyRef,
    requestRef: request().requestRef,
    proposalRevisionRef: request().proposal.proposalRevisionRef,
    decision: 'APPROVE' as const,
    reason: null,
    expectedRequestRevision: 1,
    idempotencyKey: 'decision-reason-1',
    decidedAt: at,
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
    decisionRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'decision-reason-1',
      resourceType: 'commerce.customer-context.approval-decision',
      tenantId,
    },
    requestRef: decisionInput.requestRef,
    proposalRevisionRef: decisionInput.proposalRevisionRef,
    actor: decisionInput.actor,
    kind: 'REJECT' as const,
    levelOrder: 1,
    reason: 'Budget policy requires a revised proposal',
    recordedAt: at,
    requestRevision: 2,
    routeRef: request().route.routeRef,
    hierarchyRef: request().route.hierarchyRef,
    hierarchyRevision: 1,
    decisionBundleHash: 'b'.repeat(64),
    decisionBundleVersion: 'approval-decision-bundle.v1' as const,
    idempotencyKey: 'decision-reason-1',
  };
  expect(Schema.is(ApprovalDecisionSchema)(approvalDecision)).toBe(true);
  expect(Schema.is(ApprovalDecisionSchema)({ ...approvalDecision, reason: null })).toBe(false);
});

it('revalidates only an approved exact revision and keeps consumed approval terminal', () => {
  const approved = { ...request(), status: 'APPROVED' as const };
  expect(
    revalidateApproval({
      request: approved,
      exactProposalHashMatches: true,
      buyerPermission: 'ALLOWED',
      profileState: 'ACTIVE',
      routeCurrent: true,
      checkedAt: later,
      validUntil: expiresAt,
    }),
  ).toEqual({ _tag: 'APPROVAL_VALID', validUntil: expiresAt });
  expect(
    revalidateApproval({
      request: approved,
      exactProposalHashMatches: false,
      buyerPermission: 'ALLOWED',
      profileState: 'ACTIVE',
      routeCurrent: true,
      checkedAt: later,
      validUntil: expiresAt,
    }),
  ).toEqual({ _tag: 'PROPOSAL_MATERIAL_CHANGE' });
  expect(
    revalidateApproval({
      request: { ...approved, status: 'CONSUMED' },
      exactProposalHashMatches: true,
      buyerPermission: 'ALLOWED',
      profileState: 'ACTIVE',
      routeCurrent: true,
      checkedAt: later,
      validUntil: expiresAt,
    }),
  ).toEqual({ _tag: 'ALREADY_CONSUMED' });
  expect(
    revalidateApproval({
      request: approved,
      exactProposalHashMatches: true,
      buyerPermission: 'ALLOWED',
      profileState: 'ACTIVE',
      routeCurrent: true,
      checkedAt: expiresAt,
      validUntil: expiresAt,
    }),
  ).toEqual({ _tag: 'REQUEST_EXPIRED' });
  expect(
    revalidateApproval({
      request: approved,
      exactProposalHashMatches: true,
      buyerPermission: 'ALLOWED',
      profileState: 'ACTIVE',
      routeCurrent: true,
      checkedAt: later,
      validUntil: later,
    }),
  ).toEqual({ _tag: 'REQUEST_EXPIRED' });
});
