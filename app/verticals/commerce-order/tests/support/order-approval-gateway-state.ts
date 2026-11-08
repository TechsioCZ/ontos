import { OrderServiceApprovalEvidenceResponseSchema } from '@app/commerce-customer-context/api/order-service-approval-evidence';
import { ConsumeOrderPurchaseApprovalResultSchema } from '@app/commerce-customer-context/api/consume-order-purchase-approval-action';
import { PaymentTermDefinitionSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PricingCommitmentConfirmationIssued } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { Schema } from 'effect';

import { acceptedTaxTermsInput } from '../../../tax/tests/unit/tax-correction-fixtures.ts';
import { OrderCommitmentStateSchema } from '../../shared/domain/order-commitment.ts';
import type { OrderCommitmentState } from '../../shared/domain/order-commitment.ts';
import {
  OrderFinalizationContextSchema,
  OrderPricingCommitProofSchema,
  OrderTaxCandidateSchema,
} from '../../shared/domain/order-finalization-evidence.ts';
import { orderPreparationInput } from './order-preparation-input.ts';
import { ActionInvocationIdSchema, callAs } from '../../src/services/order-module-call.ts';

export const gatewayTenantId = '33333333-3333-4333-8333-333333333333';
export const gatewayLegalEntityId = '22222222-2222-4222-8222-222222222222';
export const gatewayBuyerPrincipalId = '11111111-1111-4111-8111-111111111111';
export const gatewayCorrelationId = 'order-approval-gateway-unit';
const businessTime = '2026-10-24T12:00:00.000Z';
const commitmentCorrelationId = 'commitment-correlation';
const candidateHash = 'b'.repeat(64);
const proposalHash = 'a'.repeat(64);
const czk = 'CZK';
const ten = '10';
const active = 'ACTIVE';
const cartModule = 'commerce.cart';
const catalogModule = 'commerce.catalog';
const storefront = 'storefront-1';
const routeId = 'route';
const hierarchyId = 'hierarchy';
const routeResourceType = 'approval-route';
const hierarchyResourceType = 'approval-hierarchy';
const decisionBundleVersion = 'approval-decision-bundle.v1';
const prepaidCode = 'PREPAID';
const fixtureReason = 'Order gateway unit fixture';
const consumedStatus = 'CONSUMED';
const approvalValidStatus = 'APPROVAL_VALID';
const evidenceValidUntil = '2026-10-24T13:00:00.000Z';

export const gatewayScope = callAs(
  Schema.decodeUnknownSync(OrderFinalizationContextSchema)({
    buyerPrincipalId: gatewayBuyerPrincipalId,
    correlationId: gatewayCorrelationId,
    legalEntityId: gatewayLegalEntityId,
    tenantId: gatewayTenantId,
  }),
  {
    _tag: 'Originator',
    actionInvocationId: Schema.decodeUnknownSync(ActionInvocationIdSchema)('80000000-0000-4000-8000-0000000000b1'),
  },
);

const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId: gatewayTenantId,
});
const cccRef = (kind: string, id: string) => ref('commerce.customer-context', `commerce.customer-context.${kind}`, id);
const orderRef = (kind: string, id: string) => ref('commerce.order', `commerce.order.${kind}`, id);

export const gatewayRequestRef = cccRef('purchase-approval-request', 'request');
export const gatewayProposalRevisionRef = cccRef('purchase-proposal-revision', 'proposal');
export const gatewayCandidateRef = ref(
  cartModule,
  'commerce.cart.final-cart-candidate',
  '99999999-9999-4999-8999-999999999999',
);
export const gatewayRevalidationRef = cccRef('approval-revalidation', 'revalidation');
export const gatewayOrderRef = orderRef('order', 'order');
const bundleRef = orderRef('acceptance-bundle', 'bundle');
const attemptRef = orderRef('commitment-attempt', 'attempt');
const counterpartyRef = ref('party.registry', 'party.registry.counterparty', 'counterparty');
const profileRef = ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile');
const unitRef = ref(catalogModule, 'commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555555');
const selection = {
  productRef: ref(catalogModule, 'commerce.catalog.product', '66666666-6666-4666-8666-666666666666'),
  variantRef: ref(catalogModule, 'commerce.catalog.variant', '77777777-7777-4777-8777-777777777777'),
};

const cartRef = ref(cartModule, 'commerce.cart.cart', '88888888-8888-4888-8888-888888888888');

/** One schema-valid Final Cart Candidate. Only the identity fields the gateway reads are meaningful here. */
const cartCandidate = {
  approval: {
    proposalHash,
    proposalRevisionRef: gatewayProposalRevisionRef,
    requestRef: gatewayRequestRef,
  },
  buyerPrincipalId: gatewayBuyerPrincipalId,
  candidateHash,
  candidateRef: gatewayCandidateRef,
  finalCartRevision: {
    cartRef,
    revision: 2,
    revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  legalEntityId: gatewayLegalEntityId,
  orderCommitmentTime: businessTime,
  pricing: {
    decision: {
      commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: gatewayLegalEntityId },
      currencyCode: czk,
      lines: [
        {
          catalog: {
            completeness: {
              observedAt: businessTime,
              ownerRevision: 'catalog:1',
              scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog:selection' },
            },
            divisible: false,
            equivalentSelectionKey: 'pricing-purpose:variant:1',
            evidence: {
              assessedAt: businessTime,
              basis: [
                { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
                { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
                {
                  provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
                  role: 'PRODUCT_TYPE_UNTYPED_DECISION',
                  source: { resourceRef: selection.productRef, revision: 1 },
                },
              ],
              membership: {
                attestationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                observedAt: businessTime,
                productRef: selection.productRef,
                source: 'CATALOG_OWNER_CURRENT_READ',
                variant: { resourceRef: selection.variantRef, revision: 1 },
              },
              purpose: 'PRICING',
              selection,
              status: 'VALID',
              validUntil: evidenceValidUntil,
            },
            hierarchyRevision: 'hierarchy:1',
            ownerRevision: 'catalog:1',
            quantity: {
              changed: false,
              notice: null,
              requested: '1',
              resulting: '1',
              rounding: 'HALF_UP',
              status: 'VALID',
              step: '1',
              targetId: selection.variantRef.resourceId,
              tenantId: gatewayTenantId,
              unitId: unitRef.resourceId,
              unitRuleRevision: 1,
            },
            quantityBasis: {
              targetDivisibilityRevision: 1,
              targetRef: selection.variantRef,
              unitRef,
              unitRuleRevision: 1,
            },
            selection,
            status: 'READY',
            unitRef,
          },
          occurrenceId: 'line:1',
          pricingBasis: { quantity: '1', unitRef },
        },
      ],
      monetaryBoundary: 'PRE_TAX',
      operationTime: businessTime,
      purchasingContext: {
        accessDecision: { decisionRef: 'access:1', decisionRevision: '1' },
        actor: { kind: 'PRINCIPAL', principalId: gatewayBuyerPrincipalId },
        commercialSettingsDecision: { decisionRef: 'settings:1', decisionRevision: '1' },
        contextRef: 'purchase-context:1',
        contextRevision: '1',
        currencyResolution: { currencyCode: czk, resolutionRef: 'currency:1', resolutionRevision: '1' },
        subject: { authorizationSubject: { kind: 'RETAIL' }, kind: 'PROFILE', profileRef },
      },
      tenantId: gatewayTenantId,
    },
    subject: { authorizationSubject: { kind: 'RETAIL' }, kind: 'PROFILE', profileRef },
  },
  sourceCart: {
    cartRef,
    revision: 1,
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  storefrontId: storefront,
  tenantId: gatewayTenantId,
  version: 'FINAL_CART_CANDIDATE.v1',
};

const proposal = {
  approvalEvaluation: 'APPROVAL_REQUIRED',
  approvalTrigger: { policyRevision: 'policy-1', reasonCode: 'LIMIT', source: 'PURCHASE_LIMIT' },
  canonicalHash: proposalHash,
  canonicalizationVersion: 'purchase-proposal.v1',
  context: {
    channelId: 'web',
    evaluatedAt: businessTime,
    locale: 'cs-CZ',
    marketId: 'CZ',
    sellingLegalEntityId: gatewayLegalEntityId,
    storefrontId: storefront,
    tenantId: gatewayTenantId,
  },
  createdAt: businessTime,
  currency: czk,
  deliveryDestination: { address: { city: 'Brno' }, kind: 'DELIVERY', method: 'COLLECTION' },
  effectiveLimit: null,
  expiresAt: evidenceValidUntil,
  hierarchyInputs: {
    counterpartyRef,
    evaluatedAt: businessTime,
    purchaseValue: { amount: ten, currency: czk },
    storefrontId: storefront,
  },
  identity: {
    buyer: { principalId: gatewayBuyerPrincipalId, tenantId: gatewayTenantId },
    counterpartyRef,
    profileRef,
  },
  invoiceRecipient: { address: { city: 'Brno' }, kind: 'INVOICE', method: 'COLLECTION' },
  lines: [
    {
      configuration: { color: 'blue' },
      discount: { amount: '0', currency: czk },
      fees: [],
      lineId: 'line',
      lineTotal: { amount: ten, currency: czk },
      pricingRuleRevision: 'price-1',
      productRef: ref(catalogModule, 'commerce.catalog.product', 'product'),
      quantity: 1,
      tax: { amount: '0', currency: czk },
      unitPrice: { amount: ten, currency: czk },
    },
  ],
  payment: 'NONE',
  paymentTerm: {
    code: prepaidCode,
    definitionRef: ref('payment.term-catalog', 'payment.term-catalog.payment-term', 'payment-term'),
    definitionRevision: 'term-1',
  },
  policyRefs: [],
  pricingRevision: 'price-1',
  proposalRevisionRef: gatewayProposalRevisionRef,
  proposalSequence: 1,
  purchaseValue: {
    monetaryAmount: { amount: ten, currency: czk },
    roundingRuleRevision: 'round-1',
    sourceRef: 'cart',
    sourceRevision: 'cart-1',
  },
  reservation: 'NONE',
  revision: 1,
  sourceCart: { cartRef: ref(cartModule, 'commerce.cart.cart', 'cart'), revision: 'cart-1' },
  state: 'CURRENT',
  taxRevision: 'tax-1',
  totals: {
    discount: { amount: '0', currency: czk },
    fees: [],
    shipping: { amount: '0', currency: czk },
    subtotal: { amount: ten, currency: czk },
    tax: { amount: '0', currency: czk },
    total: { amount: ten, currency: czk },
  },
};

const paymentTermRef = ref(
  'payment.term-catalog',
  'payment.term-catalog.payment-term',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
);
const paymentTermDefinition = Schema.decodeUnknownSync(PaymentTermDefinitionSchema)({
  code: prepaidCode,
  compatibilityId: 'prepaid',
  created: {
    actionInvocationId: 'invocation:payment-term',
    actorPrincipalId: '20000000-0000-4000-8000-000000000001',
    at: businessTime,
    reason: fixtureReason,
  },
  definitionRevisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  description: 'Paid before delivery.',
  lifecycle: { effectiveFrom: businessTime, effectiveTo: null, state: active },
  metadataRevision: 1,
  name: 'Prepaid',
  paymentTermRef,
  retired: null,
  semanticFingerprint: 'e'.repeat(64),
  semanticRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
  updated: {
    actionInvocationId: 'invocation:payment-term',
    actorPrincipalId: '20000000-0000-4000-8000-000000000001',
    at: businessTime,
    reason: fixtureReason,
  },
});

const paymentTerms = {
  catalogDefinition: paymentTermDefinition,
  effectiveAt: businessTime,
  observedAt: businessTime,
  resolution: {
    _tag: 'EXPLICIT_CHOICE',
    customerPaymentTermsRevision: null,
    definition: {
      code: prepaidCode,
      compatibilityId: 'prepaid',
      definitionRevisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      lifecycle: { effectiveFrom: businessTime, effectiveTo: null, state: active },
      metadataRevision: 1,
      name: 'Prepaid',
      paymentTermRef,
      semanticFingerprint: 'e'.repeat(64),
      semanticRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
    },
    policyRevision: 'policy:payment-terms',
    policySource: 'commerce.customer-context.payment-terms-policy.v1',
    purchasingContextRevision: '1',
    resolvedAt: businessTime,
  },
};

const taxIntent = {
  idempotencyKey: 'order-tax:gateway-unit',
  request: {
    candidate: Schema.encodeSync(OrderTaxCandidateSchema)(orderPreparationInput().taxCandidate),
    orderCommitmentTime: businessTime,
    provenanceRef: 'commerce.order.gateway-unit',
    reason: fixtureReason,
    submissionRef: 'order-tax-submission:gateway-unit',
  },
};

const finalBinding = {
  attemptRef,
  bundleHash: proposalHash,
  bundleRef,
  bundleVersion: 'order-acceptance-bundle.v1',
};

const attempt = {
  binding: finalBinding,
  commitmentCorrelationId,
  createdAt: businessTime,
  orderRef: null,
  revision: 1,
  status: 'READY' as const,
  updatedAt: businessTime,
};

/** Genuine owner-issued finalization evidence the gateway's state requires. */
const makeGatewayFinalization = (quotation: PricingQuotationIssued) => {
  const taxOutcome = acceptedTaxTermsInput([{ lineValue: '1000', occurrenceId: 'o1', quantity: '1' }]).finalTax;
  const tax = {
    result: {
      _tag: 'FINALIZED',
      created: true,
      customerSafe: {
        _tag: 'TAX_AMOUNT',
        contractVersion: 2,
        purchaseTaxTotal: { amount: '210.00', currency: czk },
      },
      evidence: {
        attempts: 1,
        discarded: [],
        foreignEvidenceOrigin: 'CALLER_SUPPLIED_UNVERIFIED',
        ruleSets: [],
        sellerVatRegime: {
          headRevision: 1,
          selectedFor: taxOutcome.decision.taxRelevantTime,
          selection: {
            _tag: 'DECLARED',
            declarationRevisionRef: { revision: 1 },
            effectiveFrom: taxOutcome.decision.taxRelevantTime,
            effectiveFromOrigin: 'DECLARED',
            provenance: 'MERCHANT_DECLARED',
            regime: 'VAT_PAYER',
          },
          setFingerprint: 'f'.repeat(64),
        },
        taxEvaluationTime: taxOutcome.decision.taxRelevantTime,
        taxRelevantTime: taxOutcome.decision.taxRelevantTime,
      },
      finalOrderTaxRef: {
        moduleId: 'commerce.tax',
        resourceId: 'tax-final',
        resourceType: 'commerce.tax.order-tax-finalization',
        tenantId: gatewayTenantId,
      },
      handoff: {
        foreignEvidenceOrigin: 'CALLER_SUPPLIED_UNVERIFIED',
        orderCommitmentTime: taxOutcome.decision.taxRelevantTime,
        outcome: taxOutcome,
        submissionRef: 'order-tax-submission:gateway-unit',
      },
    },
  };
  return {
    cart: cartCandidate,
    paymentTerms,
    pricing: {
      pricingResultRef: { pricingResultId: quotation.quotationRef, revision: 1 },
      quotation,
    },
    purchaseValue: proposal.purchaseValue,
    tax,
    taxIntent,
  };
};

const bundle = (quotation: PricingQuotationIssued) => {
  const finalization = makeGatewayFinalization(quotation);
  return {
    approvalDecisionBundleHash: '0'.repeat(64),
    approvalDecisionBundleVersion: decisionBundleVersion,
    approvalRequestRef: gatewayRequestRef,
    bundleHash: proposalHash,
    bundleRef,
    bundleVersion: 'order-acceptance-bundle.v1',
    buyerPrincipalId: gatewayBuyerPrincipalId,
    finalization,
    legalEntityId: gatewayLegalEntityId,
    orderCommitmentTime: businessTime,
    preparedAt: businessTime,
    proposal,
    storefrontId: storefront,
  };
};

/** The admissibility state for revalidation: an orderless READY attempt on the exact bundle. */
export const makeGatewayRevalidationState = (quotation: PricingQuotationIssued) =>
  Schema.decodeUnknownSync(OrderCommitmentStateSchema)({
    attempt,
    bundle: bundle(quotation),
    history: [],
    order: null,
  });

export const makeGatewayConsumptionState = (
  quotation: PricingQuotationIssued,
  confirmation: PricingCommitmentConfirmationIssued,
) => {
  const pricingProof = Schema.decodeUnknownSync(OrderPricingCommitProofSchema)({
    _tag: 'VERIFIED',
    authenticityEvidence: {
      authenticityRef: 'pricing:confirmation-verification:gateway-unit',
      confirmationRef: confirmation.confirmationRef,
      issuerRef: confirmation.authenticity.issuerRef,
      keyRef: confirmation.authenticity.keyRef,
      keyStatus: active,
      keyVersion: confirmation.authenticity.keyVersion,
      lineageRef: confirmation.authenticity.lineageRef,
      payloadDigest: confirmation.authenticity.payloadDigest,
      proofRef: confirmation.authenticity.proofRef,
      proofVersion: confirmation.authenticity.proofVersion,
      verifiedAt: confirmation.issuedAt,
    },
    confirmation,
    verifiedAt: confirmation.issuedAt,
  });
  return Schema.decodeUnknownSync(OrderCommitmentStateSchema)({
    attempt: { ...attempt, orderRef: gatewayOrderRef, status: 'COMMITTED' },
    bundle: bundle(quotation),
    history: [{ at: businessTime, kind: 'COMMITTED', operationId: 'operation:commit', proofRef: null, revision: 1 }],
    order: {
      acceptedAt: businessTime,
      approvalIssuer: { buyerPrincipalId: gatewayBuyerPrincipalId, kind: 'BUYER' },
      approvalProof: {
        checkedAt: businessTime,
        evidence: {
          buyerPermission: 'ALLOWED',
          commitmentCorrelationId,
          decisionBundleHash: '0'.repeat(64),
          decisionBundleVersion,
          decisionRef: cccRef('approval-decision', 'decision'),
          hierarchyRef: cccRef(hierarchyResourceType, hierarchyId),
          policyRouteCurrent: true,
          profileState: active,
          proposalHash,
          routeRef: cccRef(routeResourceType, routeId),
          sourceRevisions: [{ revision: 'revision-1', source: cartModule }],
        },
        proposalRevisionRef: gatewayProposalRevisionRef,
        requestRef: gatewayRequestRef,
        revalidationRef: gatewayRevalidationRef,
        status: approvalValidStatus,
        validUntil: evidenceValidUntil,
      },
      approvalRequestRef: gatewayRequestRef,
      binding: finalBinding,
      commitmentCorrelationId,
      committedAt: businessTime,
      consumptionIntent: 'consumption-intent',
      consumptionStatus: 'PENDING',
      orderRef: gatewayOrderRef,
      pricingProof,
    },
  });
};

const approvedRequestSnapshot = {
  committedOrderRef: null,
  consumedAt: businessTime,
  consumptionCommitmentId: null,
  decisionBundleHash: '0'.repeat(64),
  decisionBundleVersion,
  expiresAt: evidenceValidUntil,
  idempotencyKey: 'approval-request:gateway-unit',
  lastDecisionRef: null,
  proposal,
  requestRef: gatewayRequestRef,
  requestRevision: 1,
  route: {
    capturedAt: businessTime,
    currentLevelOrder: 1,
    hierarchyRef: cccRef(hierarchyResourceType, hierarchyId),
    hierarchyRevision: 1,
    levels: [
      {
        candidates: [{ principalId: gatewayBuyerPrincipalId, tenantId: gatewayTenantId }],
        completedAt: businessTime,
        completedBy: { principalId: gatewayBuyerPrincipalId, tenantId: gatewayTenantId },
        completionRule: 'ONE_APPROVER',
        levelId: 'level-1',
        order: 1,
      },
    ],
    proposalRevisionRef: gatewayProposalRevisionRef,
    requestRef: gatewayRequestRef,
    rerouteReason: null,
    routeRef: cccRef(routeResourceType, routeId),
    status: 'APPROVED',
  },
  status: 'APPROVED',
  submittedAt: businessTime,
} as const;

/** The owner's LOAD_PROPOSAL answer for an approval that is still merely APPROVED (nothing consumed). */
export const approvedProposalEvidence = Schema.decodeUnknownSync(OrderServiceApprovalEvidenceResponseSchema)({
  candidateHash: cartCandidate.candidateHash,
  candidateRef: cartCandidate.candidateRef,
  operation: 'LOAD_PROPOSAL',
  proposal,
  request: approvedRequestSnapshot,
});

/** The owner's LOAD_PROPOSAL answer retaining the exact consumption receipt for a committed Order. */
export const retainedConsumptionProposal = (state: OrderCommitmentState) => {
  if (state.order === null) {
    throw new Error('A retained consumption fixture requires a committed Order state');
  }
  return Schema.decodeUnknownSync(OrderServiceApprovalEvidenceResponseSchema)({
    candidateHash: state.bundle.finalization.cart.candidateHash,
    candidateRef: state.bundle.finalization.cart.candidateRef,
    operation: 'LOAD_PROPOSAL',
    proposal,
    request: {
      ...approvedRequestSnapshot,
      committedOrderRef: state.order.orderRef,
      consumptionCommitmentId: state.attempt.commitmentCorrelationId,
      consumptionEvidence: {
        commitmentCorrelationId: state.attempt.commitmentCorrelationId,
        committedAt: businessTime,
        counterpartyRef: proposal.identity.counterpartyRef,
        decisionBundleHash: state.bundle.approvalDecisionBundleHash,
        decisionBundleVersion: state.bundle.approvalDecisionBundleVersion,
        finalBinding: state.order.binding,
        idempotencyKey: state.order.consumptionIntent,
        orderRef: state.order.orderRef,
        revalidationRef: state.order.approvalProof.revalidationRef,
        storefrontId: state.bundle.storefrontId,
      },
      consumptionFinalBinding: state.order.binding,
      consumptionIdempotencyKey: state.order.consumptionIntent,
      consumptionProofRef: state.order.approvalProof.revalidationRef,
      status: consumedStatus,
    },
  });
};

/** The owner's RECOVER_REVALIDATION answer when it retained no revalidation for the exact request. */
export const notFoundRevalidationEvidence = (state: OrderCommitmentState) =>
  Schema.decodeUnknownSync(OrderServiceApprovalEvidenceResponseSchema)({
    candidateHash: state.bundle.finalization.cart.candidateHash,
    candidateRef: state.bundle.finalization.cart.candidateRef,
    operation: 'RECOVER_REVALIDATION',
    recovery: 'NOT_FOUND',
  });

/** The owner's RECOVER_REVALIDATION answer for a genuinely retained, exactly bound revalidation. */
export const recoveredRevalidationEvidence = (state: OrderCommitmentState) =>
  Schema.decodeUnknownSync(OrderServiceApprovalEvidenceResponseSchema)({
    candidateHash: state.bundle.finalization.cart.candidateHash,
    candidateRef: state.bundle.finalization.cart.candidateRef,
    operation: 'RECOVER_REVALIDATION',
    recovery: 'FOUND',
    result: {
      outcome: approvalValidStatus,
      revalidation: {
        approvedRoute: approvedRequestSnapshot.route,
        checkedAt: businessTime,
        committedOrderRef: null,
        evidence: {
          buyerPermission: 'ALLOWED',
          commitmentCorrelationId: state.attempt.commitmentCorrelationId,
          decisionBundleHash: state.bundle.approvalDecisionBundleHash,
          decisionBundleVersion: state.bundle.approvalDecisionBundleVersion,
          decisionRef: cccRef('approval-decision', 'decision'),
          finalBindingEvidence: {
            binding: state.attempt.binding,
            observedAt: businessTime,
            provenance: 'commerce.order.gateway-unit',
            validUntil: evidenceValidUntil,
          },
          hierarchyRef: cccRef(hierarchyResourceType, hierarchyId),
          policyRouteCurrent: true,
          profileState: active,
          proposalHash: state.bundle.proposal.canonicalHash,
          routeRef: cccRef(routeResourceType, routeId),
          sourceRevisions: [{ revision: 'revision-1', source: cartModule }],
        },
        proposalRevisionRef: state.bundle.proposal.proposalRevisionRef,
        requestRef: state.bundle.approvalRequestRef,
        revalidationRef: gatewayRevalidationRef,
        status: approvalValidStatus,
        validUntil: evidenceValidUntil,
      },
    },
  });

/** A genuine consumption result the owner Action answers for the committed Order. */
export const genuineConsumptionResult = (state: OrderCommitmentState) =>
  Schema.decodeUnknownSync(ConsumeOrderPurchaseApprovalResultSchema)({
    outcome: consumedStatus,
    request: {
      ...approvedRequestSnapshot,
      committedOrderRef: state.order?.orderRef ?? null,
      consumptionIdempotencyKey: state.order?.consumptionIntent,
      status: consumedStatus,
    },
  });
