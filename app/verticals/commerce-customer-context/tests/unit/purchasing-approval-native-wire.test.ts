import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CounterpartyRefSchema } from '../../shared/domain/access-contract.ts';
import {
  ApprovalHierarchySchema,
  ApprovalRevalidationSchema,
  RevalidatePurchaseApprovalInputSchema,
  TrustedRevalidatePurchaseApprovalInputSchema,
  PurchaseApprovalFinalBindingSchema,
  PurchaseApprovalRequestSchema,
  DecidePurchaseApprovalRequestInputSchema,
  PurchaseProposalRevisionSchema,
} from '../../shared/domain/purchasing-approval.ts';
import { MonetaryAmountSchema } from '../../shared/domain/purchase-limit.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from '../../shared/domain/purchase-limit-evaluation.ts';
import { purchasingApprovalNativePayloads } from '../support/purchasing-approval-native.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { changeCounterpartyPurchaseLimitAction } from '../../src/actions/change-counterparty-purchase-limit.action.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { createApprovalHierarchyAction } from '../../src/actions/create-approval-hierarchy.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const buyerId = '10000000-0000-4000-8000-000000000002';
const approverId = '10000000-0000-4000-8000-000000000003';
const otherApproverId = '10000000-0000-4000-8000-000000000004';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const atText = '2026-09-09T12:00:00.000Z';
const later = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-09T12:30:00.000Z');
const expiresAtText = '2026-09-09T13:00:00.000Z';
const expiresAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(expiresAtText);

const counterpartyRef = Schema.decodeUnknownSync(CounterpartyRefSchema)({
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

it.effect('encodes the native producer graph before every strict registered Core payload decoder', () =>
  Effect.gen(function* verifyNativeApprovalWire() {
    const current = request();
    const selected = hierarchy('hierarchy-storefront', 'storefront-eu');
    const sources = Schema.decodeUnknownSync(PurchaseLimitSourceRevisionVectorSchema)(
      [
        'counterparty-policy',
        'customer-commerce-policy',
        'principal-override',
        'purchase-proposal',
        'purchasing-profile',
        'storefront-context',
      ].map((source) => ({ revision: '1', source })),
    );
    const command = Schema.decodeUnknownSync(DecidePurchaseApprovalRequestInputSchema)({
      actor: principal(approverId),
      counterpartyRef,
      decidedAt: atText,
      decision: 'APPROVE',
      expectedRequestRevision: 1,
      idempotencyKey: 'decision-key',
      proposalRevisionRef,
      reason: null,
      requestRef: current.requestRef,
      storefrontId: 'storefront-eu',
    });
    const profile = yield* purchasingApprovalNativePayloads.profile(counterpartyRef, atText);
    const limit = yield* purchasingApprovalNativePayloads.limit(counterpartyRef);
    expect(
      Schema.decodeUnknownSync(createCounterpartyPurchasingProfileAction.descriptor.payloadSchema, {
        onExcessProperty: 'error',
      })(profile).subject,
    ).toEqual({ counterpartyRef, kind: 'COUNTERPARTY' });
    expect(
      Schema.decodeUnknownSync(changeCounterpartyPurchaseLimitAction.descriptor.payloadSchema, {
        onExcessProperty: 'error',
      })(limit).counterpartyRef,
    ).toEqual(counterpartyRef);
    const created = yield* purchasingApprovalNativePayloads.proposal(current.proposal, sources, 'proposal-key');
    expect(
      Schema.toEquivalence(PurchaseProposalRevisionSchema)(
        Schema.decodeUnknownSync(createPurchaseProposalRevisionAction.descriptor.payloadSchema, {
          onExcessProperty: 'error',
        })(created).proposal,
        current.proposal,
      ),
    ).toBe(true);
    for (const time of [
      created.proposal.context.evaluatedAt,
      created.proposal.hierarchyInputs.evaluatedAt,
      created.proposal.createdAt,
      created.proposal.expiresAt,
    ]) {
      expect(Schema.is(Schema.String)(time)).toBe(true);
    }
    const routed = yield* purchasingApprovalNativePayloads.hierarchy(selected, 'hierarchy-key');
    expect(
      Schema.toEquivalence(ApprovalHierarchySchema)(
        Schema.decodeUnknownSync(createApprovalHierarchyAction.descriptor.payloadSchema, { onExcessProperty: 'error' })(
          routed,
        ).hierarchy,
        selected,
      ),
    ).toBe(true);
    expect(Schema.is(Schema.String)(routed.hierarchy.createdAt)).toBe(true);
    expect(Schema.is(Schema.String)(routed.hierarchy.effectiveFrom)).toBe(true);
    expect(routed.hierarchy.effectiveTo).toBeNull();
    const ended = yield* purchasingApprovalNativePayloads.hierarchy(
      { ...selected, effectiveTo: expiresAt },
      'hierarchy-key',
    );
    expect(ended.hierarchy.effectiveTo).toBe(expiresAtText);
    expect(
      Schema.toEquivalence(ApprovalHierarchySchema)(
        Schema.decodeUnknownSync(createApprovalHierarchyAction.descriptor.payloadSchema)(ended).hierarchy,
        { ...selected, effectiveTo: expiresAt },
      ),
    ).toBe(true);
    const submitted = yield* purchasingApprovalNativePayloads.submit(current.proposal, 'submit-key');
    expect(Schema.is(Schema.String)(submitted.requestExpiresAt)).toBe(true);
    expect(
      DateTime.formatIso(
        Schema.decodeUnknownSync(submitPurchaseApprovalRequestAction.descriptor.payloadSchema, {
          onExcessProperty: 'error',
        })(submitted).requestExpiresAt,
      ),
    ).toBe(expiresAtText);
    const decided = yield* purchasingApprovalNativePayloads.decide(command);
    const decoded = Schema.decodeUnknownSync(decidePurchaseApprovalRequestAction.descriptor.payloadSchema, {
      onExcessProperty: 'error',
    })(decided);
    expect(Schema.toEquivalence(decidePurchaseApprovalRequestAction.descriptor.payloadSchema)(decoded, command)).toBe(
      true,
    );
    expect(Schema.is(Schema.String)(decided.decidedAt)).toBe(true);
    const patched = yield* purchasingApprovalNativePayloads.decide(command, {
      actor: principal(otherApproverId),
      decidedAt: later,
      decision: 'RETURN',
      reason: 'Revise proposal',
    });
    const decodedPatch = Schema.decodeUnknownSync(decidePurchaseApprovalRequestAction.descriptor.payloadSchema, {
      onExcessProperty: 'error',
    })(patched);
    expect(decodedPatch.idempotencyKey).toBe(command.idempotencyKey);
    expect(decodedPatch.actor).toEqual(principal(otherApproverId));
    expect(decodedPatch.decision).toBe('RETURN');
    expect(decodedPatch.reason).toBe('Revise proposal');
    expect(DateTime.formatIso(decodedPatch.decidedAt)).toBe(DateTime.formatIso(later));
    for (const [schema, wire, type] of [
      [
        createPurchaseProposalRevisionAction.descriptor.payloadSchema,
        created,
        { ...created, proposal: current.proposal },
      ],
      [createApprovalHierarchyAction.descriptor.payloadSchema, routed, { ...routed, hierarchy: selected }],
      [
        submitPurchaseApprovalRequestAction.descriptor.payloadSchema,
        submitted,
        { ...submitted, requestExpiresAt: expiresAt },
      ],
      [decidePurchaseApprovalRequestAction.descriptor.payloadSchema, decided, command],
    ] as const) {
      expect(Result.isFailure(Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(type))).toBe(true);
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })({ ...wire, unexpectedPublicField: true }),
        ),
      ).toBe(true);
    }
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(createPurchaseProposalRevisionAction.descriptor.payloadSchema)({
          ...created,
          proposal: { ...created.proposal, createdAt: 'invalid' },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(createApprovalHierarchyAction.descriptor.payloadSchema)({
          ...routed,
          hierarchy: { ...routed.hierarchy, effectiveFrom: 'invalid' },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(submitPurchaseApprovalRequestAction.descriptor.payloadSchema)({
          ...submitted,
          requestExpiresAt: 'invalid',
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(decidePurchaseApprovalRequestAction.descriptor.payloadSchema)({
          ...decided,
          decidedAt: 'invalid',
        }),
      ),
    ).toBe(true);
    const negativePatch = { ...command, expectedRequestRevision: 2 };
    expect(Schema.decodeUnknownSync(Schema.toType(DecidePurchaseApprovalRequestInputSchema))(negativePatch)).toEqual(
      negativePatch,
    );
    expect(Result.isFailure(Schema.decodeUnknownResult(DecidePurchaseApprovalRequestInputSchema)(negativePatch))).toBe(
      true,
    );
  }),
);

it('retains legacy proof decoding but never upgrades it to verified final-owner input', () => {
  const legacyRequest = request();
  const proof = Schema.decodeUnknownSync(ApprovalRevalidationSchema)({
    approvedRoute: Schema.encodeSync(PurchaseApprovalRequestSchema)(legacyRequest).route,
    checkedAt: atText,
    committedOrderRef: null,
    evidence: {
      buyerPermission: 'ALLOWED',
      commitmentCorrelationId: 'legacy-correlation',
      decisionBundleHash: 'a'.repeat(64),
      decisionBundleVersion: 'approval-decision-bundle.v1',
      decisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'decision-1',
        resourceType: 'commerce.customer-context.approval-decision',
        tenantId,
      },
      hierarchyRef: hierarchy('legacy-hierarchy', 'storefront-eu').hierarchyRef,
      policyRouteCurrent: true,
      profileState: 'ACTIVE',
      proposalHash: 'a'.repeat(64),
      routeRef: legacyRequest.route.routeRef,
      sourceRevisions: [{ revision: '1', source: 'purchase-proposal' }],
    },
    proposalRevisionRef,
    requestRef: legacyRequest.requestRef,
    revalidationRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'approval-revalidation:legacy:1',
      resourceType: 'commerce.customer-context.approval-revalidation',
      tenantId,
    },
    status: 'APPROVAL_VALID',
    validUntil: expiresAtText,
  });
  expect(proof.evidence.finalBindingEvidence).toBeUndefined();
  const binding = Schema.decodeUnknownSync(PurchaseApprovalFinalBindingSchema)({
    attemptRef: {
      moduleId: 'test.final-owner',
      resourceId: 'attempt',
      resourceType: 'test.final-owner.attempt',
      tenantId,
    },
    bundleHash: 'b'.repeat(64),
    bundleRef: {
      moduleId: 'test.final-owner',
      resourceId: 'bundle',
      resourceType: 'test.final-owner.bundle',
      tenantId,
    },
    bundleVersion: 'TEST_FINAL.v1',
  });
  const claim = Schema.decodeUnknownSync(RevalidatePurchaseApprovalInputSchema)({
    ...Schema.encodeSync(ApprovalRevalidationSchema)(proof).evidence,
    checkedAt: atText,
    counterpartyRef,
    expectedProposalHash: 'a'.repeat(64),
    finalBinding: Schema.encodeSync(PurchaseApprovalFinalBindingSchema)(binding),
    finalBindingEvidence: { binding, provenance: 'CALLER_CANNOT_INSTALL_AUTHORITY' },
    idempotencyKey: 'new-intent',
    proposalRevisionRef,
    requestRef: legacyRequest.requestRef,
    routeCurrent: true,
    storefrontId: 'storefront-eu',
    validUntil: expiresAtText,
  });
  expect(Schema.encodeSync(RevalidatePurchaseApprovalInputSchema)(claim)).not.toHaveProperty('finalBindingEvidence');
  expect(
    Result.isFailure(Schema.decodeUnknownResult(Schema.toType(TrustedRevalidatePurchaseApprovalInputSchema))(claim)),
  ).toBe(true);
});
