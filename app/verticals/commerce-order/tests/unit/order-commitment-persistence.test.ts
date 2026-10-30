import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { OrderAcceptanceBundleSchema } from '../../shared/domain/order-commitment.ts';
import { commitmentAttempts, committedOrders, consumptionObligations } from '../../src/db/schema.ts';
import { sameOrderBinding } from '../../src/services/order-commitment-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-21T12:00:00.000Z';
const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const cccRef = (kind: string, id: string) => ref('commerce.customer-context', `commerce.customer-context.${kind}`, id);
const money = { amount: '10', currency: 'CZK' };
const destination = { address: { city: 'Brno' }, kind: 'DELIVERY', method: 'COLLECTION' };
const buyer = { principalId, tenantId };
const counterpartyRef = ref('party.registry', 'party.registry.counterparty', 'counterparty');
const bundleInput = {
  approvalDecisionBundleHash: 'a'.repeat(64),
  approvalDecisionBundleVersion: 'approval-decision-bundle.v1',
  approvalRequestRef: cccRef('purchase-approval-request', 'request'),
  bundleHash: '0'.repeat(64),
  bundleRef: ref('commerce.order', 'commerce.order.acceptance-bundle', 'bundle'),
  bundleVersion: 'order-acceptance-bundle.v1',
  buyerPrincipalId: principalId,
  legalEntityId,
  preparedAt: at,
  proposal: {
    approvalEvaluation: 'APPROVAL_REQUIRED',
    approvalTrigger: { policyRevision: 'policy-1', reasonCode: 'LIMIT', source: 'PURCHASE_LIMIT' },
    canonicalHash: 'b'.repeat(64),
    canonicalizationVersion: 'purchase-proposal.v1',
    context: {
      channelId: 'web',
      evaluatedAt: at,
      locale: 'cs-CZ',
      marketId: 'CZ',
      sellingLegalEntityId: legalEntityId,
      storefrontId: 'storefront',
      tenantId,
    },
    createdAt: at,
    currency: 'CZK',
    deliveryDestination: destination,
    effectiveLimit: null,
    expiresAt: '2026-10-21T13:00:00.000Z',
    hierarchyInputs: { counterpartyRef, evaluatedAt: at, purchaseValue: money, storefrontId: 'storefront' },
    identity: { buyer, counterpartyRef, profileRef: cccRef('customer-profile', 'profile') },
    invoiceRecipient: { ...destination, kind: 'INVOICE' },
    lines: [
      {
        configuration: { color: 'blue', size: 'M' },
        discount: money,
        fees: [],
        lineId: 'line',
        lineTotal: money,
        pricingRuleRevision: 'price-1',
        productRef: ref('catalog', 'catalog.product', 'product'),
        quantity: 1,
        tax: money,
        unitPrice: money,
      },
    ],
    payment: 'NONE',
    paymentTerm: { code: 'PREPAID', definitionRef: cccRef('payment-term', 'term'), definitionRevision: 'term-1' },
    policyRefs: [],
    pricingRevision: 'price-1',
    proposalRevisionRef: cccRef('purchase-proposal-revision', 'proposal'),
    proposalSequence: 1,
    purchaseValue: {
      monetaryAmount: money,
      roundingRuleRevision: 'round-1',
      sourceRef: 'cart',
      sourceRevision: 'cart-1',
    },
    reservation: 'NONE',
    revision: 1,
    sourceCart: { cartRef: ref('commerce.cart', 'commerce.cart.cart', 'cart'), revision: 'cart-1' },
    state: 'CURRENT',
    taxRevision: 'tax-1',
    totals: { discount: money, fees: [], shipping: money, subtotal: money, tax: money, total: money },
  },
  storefrontId: 'storefront',
};

describe('Order durable commitment identity', () => {
  it.effect('rejects a legacy proposal that omits business T and real final source evidence', () =>
    Effect.gen(function* rejectLegacyBundle() {
      const missingTime = yield* Schema.decodeUnknownEffect(OrderAcceptanceBundleSchema)(bundleInput, {
        errors: 'all',
      }).pipe(Effect.flip);
      expect(String(missingTime)).toContain('orderCommitmentTime');
      const missingFinalSources = yield* Schema.decodeUnknownEffect(OrderAcceptanceBundleSchema)({
        ...bundleInput,
        orderCommitmentTime: at,
      }).pipe(Effect.flip);
      expect(String(missingFinalSources)).toContain('finalization');
      // Positive digest, reordering and semantic-change checks use the genuinely
      // PREPARED Bundle from the public multi-owner integration journey.
    }),
  );

  it('rejects substituting an Attempt, tenant, Bundle version or digest', () => {
    const binding = {
      attemptRef: ref('commerce.order', 'commerce.order.commitment-attempt', 'attempt'),
      bundleHash: 'a'.repeat(64),
      bundleRef: ref('commerce.order', 'commerce.order.acceptance-bundle', 'bundle'),
      bundleVersion: 'order-acceptance-bundle.v1',
    };
    expect(sameOrderBinding(binding, { ...binding })).toBe(true);
    expect(sameOrderBinding(binding, { ...binding, attemptRef: { ...binding.attemptRef, resourceId: 'other' } })).toBe(
      false,
    );
    expect(
      sameOrderBinding(binding, { ...binding, bundleRef: { ...binding.bundleRef, tenantId: legalEntityId } }),
    ).toBe(false);
    expect(sameOrderBinding(binding, { ...binding, bundleVersion: 'other' })).toBe(false);
    expect(sameOrderBinding(binding, { ...binding, bundleHash: 'b'.repeat(64) })).toBe(false);
  });

  it('places the approval single-use fence in durable Order uniqueness and scopes all owner links', () => {
    const orders = getTableConfig(committedOrders);
    const approvalFence = orders.uniqueConstraints.find(
      (constraint) => constraint.name === 'order_orders_approval_request_uk',
    );
    expect(approvalFence?.columns.map((column) => column.name)).toEqual([
      'tenant_id',
      'legal_entity_id',
      'approval_request_id',
    ]);
    expect(
      orders.uniqueConstraints
        .find((constraint) => constraint.name === 'order_orders_attempt_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'legal_entity_id', 'attempt_id']);
    for (const table of [commitmentAttempts, committedOrders, consumptionObligations]) {
      for (const key of getTableConfig(table).foreignKeys) {
        expect(
          key
            .reference()
            .columns.slice(0, 2)
            .map((column) => column.name),
        ).toEqual(['tenant_id', 'legal_entity_id']);
        expect(
          key
            .reference()
            .foreignColumns.slice(0, 2)
            .map((column) => column.name),
        ).toEqual(['tenant_id', 'legal_entity_id']);
      }
    }
  });
});
