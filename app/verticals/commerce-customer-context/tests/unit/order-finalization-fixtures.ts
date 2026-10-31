import { Schema } from 'effect';
import {
  PurchaseApprovalRequestSchema,
  PurchaseProposalRevisionSchema,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from '../../shared/domain/purchase-limit-evaluation.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';

const moduleId = 'commerce.customer-context';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const storefrontId = 'storefront-eu';
const atText = '2026-09-09T12:00:00.000Z';
const expiresAtText = '2026-09-09T13:00:00.000Z';
const money = (amount: string) => ({ amount, currency: 'EUR' });
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000007',
  resourceType: 'party.registry.counterparty',
  tenantId,
};
const profileRef = {
  moduleId,
  resourceId: 'profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
};
const principal = { principalId: '10000000-0000-4000-8000-000000000002', tenantId };
const originalProposal = Schema.decodeUnknownSync(PurchaseProposalRevisionSchema)({
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
  identity: { buyer: principal, counterpartyRef, profileRef },
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
    moduleId,
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

const sourceRevisions = Schema.decodeUnknownSync(PurchaseLimitSourceRevisionVectorSchema)([
  { revision: '1', source: 'counterparty-policy' },
  { revision: '1', source: 'customer-commerce-policy' },
  { revision: '1', source: 'principal-override' },
  { revision: '1', source: 'purchase-proposal' },
  { revision: '1', source: 'purchasing-profile' },
  { revision: '1', source: 'storefront-context' },
]);

const proposal = { ...originalProposal, canonicalHash: computePurchaseProposalCanonicalHash(originalProposal) };
const requestRef = {
  moduleId,
  resourceId: 'request-1',
  resourceType: 'commerce.customer-context.purchase-approval-request',
  tenantId,
};
const request = Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
  committedOrderRef: null,
  consumedAt: null,
  consumptionCommitmentId: null,
  decisionBundleHash: 'b'.repeat(64),
  decisionBundleVersion: '1',
  expiresAt: expiresAtText,
  idempotencyKey: 'order-finalization-test',
  lastDecisionRef: {
    moduleId,
    resourceId: 'decision-1',
    resourceType: 'commerce.customer-context.approval-decision',
    tenantId,
  },
  proposal: Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal),
  requestRef,
  requestRevision: 2,
  route: {
    capturedAt: atText,
    currentLevelOrder: 1,
    hierarchyRef: {
      moduleId,
      resourceId: 'hierarchy-1',
      resourceType: 'commerce.customer-context.approval-hierarchy',
      tenantId,
    },
    hierarchyRevision: 1,
    levels: [
      {
        candidates: [principal],
        completedAt: atText,
        completedBy: principal,
        completionRule: 'ONE_APPROVER',
        levelId: 'one',
        order: 1,
      },
    ],
    proposalRevisionRef: proposal.proposalRevisionRef,
    requestRef,
    rerouteReason: null,
    routeRef: { moduleId, resourceId: 'route-1', resourceType: 'commerce.customer-context.approval-route', tenantId },
    status: 'APPROVED',
  },
  status: 'APPROVED',
  submittedAt: atText,
});
export const orderFinalizationSnapshotFixture = { request, sourceRevisions };
