import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CurrentPaymentTermPolicySetSchema,
  CustomerCommercePolicyAdministrationRejected,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { CurrentPaymentTermPolicySet } from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { PaymentTermReference } from '../../shared/domain/payment-term-contracts.ts';
import {
  customerCommercePaymentTermsPolicyResolver,
  resolveCurrentCustomerCommercePaymentTermsPolicy,
} from '../../src/integrations/customer-commerce-payment-terms-policy.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const at = '2026-09-21T10:00:00.000Z';
const reference = (resourceId: string): PaymentTermReference => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});
const immediate = reference('immediate');
const net14 = reference('net-14');
const context = {
  at,
  audience: 'PROFILE' as const,
  purchasingContext: {
    channelId: 'web',
    marketId: 'cz',
    sellingLegalEntityId: sellerId,
    storefrontId: 'main',
  },
  tenantId,
  trustedStorefrontId: 'main',
};
const complete = (candidates: readonly unknown[], observedAt = at) =>
  Schema.decodeUnknownSync(CurrentPaymentTermPolicySetSchema)({
    candidates,
    completeness: {
      observedAt,
      ownerRevision: 'PAYMENT_TERM:9',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: `payment-term:${tenantId}:${sellerId}` },
    },
  });
type PolicyCandidate = CurrentPaymentTermPolicySet['candidates'][number];
const candidate = (policyRevisionId: string, scope: PolicyCandidate['scope'], value: PolicyCandidate['value']) => ({
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  policyRevisionId,
  scope,
  value,
});
const seller = { kind: 'SELLER', sellingLegalEntityId: sellerId } satisfies PolicyCandidate['scope'];
const channel = {
  channelId: 'web',
  kind: 'CHANNEL_SELLER',
  sellingLegalEntityId: sellerId,
} satisfies PolicyCandidate['scope'];
const market = {
  channelId: 'web',
  commerceMarketId: 'cz',
  kind: 'MARKET_CHANNEL_SELLER',
  sellingLegalEntityId: sellerId,
} satisfies PolicyCandidate['scope'];
const storefront = {
  channelId: 'web',
  commerceMarketId: 'cz',
  kind: 'STOREFRONT_MARKET_CHANNEL_SELLER',
  sellingLegalEntityId: sellerId,
  storefrontId: 'main',
} satisfies PolicyCandidate['scope'];

it('composes all ordinary ranks, narrows non-relaxable applicability, and selects highest-rank defaults', () => {
  const policy = complete([
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', seller, {
      kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT',
      paymentTermRef: immediate,
    }),
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', seller, {
      kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT',
      paymentTermRef: net14,
    }),
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', channel, {
      kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT',
      paymentTermRef: immediate,
    }),
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', market, {
      kind: 'FALLBACK_PAYMENT_TERM',
      paymentTermRef: immediate,
    }),
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', seller, {
      kind: 'FALLBACK_PAYMENT_TERM',
      paymentTermRef: net14,
    }),
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', seller, {
      enabled: false,
      kind: 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY',
    }),
    candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', storefront, {
      enabled: true,
      kind: 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY',
    }),
  ]);

  expect(resolveCurrentCustomerCommercePaymentTermsPolicy(policy, context)).toEqual({
    eligiblePaymentTermRefs: [immediate],
    explicitlyPermittedPaymentTermRefs: [immediate],
    fallbackPaymentTermRefs: [immediate],
    policyRevision: 'PAYMENT_TERM:9',
    policySource: 'commerce.customer-context/payment-term-policy-current',
  });
});

it('reports same-rank conflicts, broken fallbacks, missing policy, and unverifiable completeness distinctly', () => {
  const applicability = candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', seller, {
    kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT',
    paymentTermRef: immediate,
  });
  const conflict = resolveCurrentCustomerCommercePaymentTermsPolicy(
    complete([
      applicability,
      candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', market, {
        kind: 'FALLBACK_PAYMENT_TERM',
        paymentTermRef: immediate,
      }),
      candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', market, {
        kind: 'FALLBACK_PAYMENT_TERM',
        paymentTermRef: net14,
      }),
    ]),
    context,
  );
  expect(Predicate.isTagged(conflict, 'INCONSISTENT_PAYMENT_TERM_POLICY')).toBe(true);

  const broken = resolveCurrentCustomerCommercePaymentTermsPolicy(
    complete([
      applicability,
      candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', seller, {
        kind: 'FALLBACK_PAYMENT_TERM',
        paymentTermRef: net14,
      }),
    ]),
    context,
  );
  expect(Predicate.isTagged(broken, 'BROKEN_PAYMENT_TERM_POLICY')).toBe(true);

  expect(
    Predicate.isTagged(
      resolveCurrentCustomerCommercePaymentTermsPolicy(complete([]), context),
      'MISSING_PAYMENT_TERM_POLICY',
    ),
  ).toBe(true);
  expect(
    Predicate.isTagged(
      resolveCurrentCustomerCommercePaymentTermsPolicy(complete([applicability], '2026-09-21T09:59:59.000Z'), context),
      'PAYMENT_TERM_POLICY_UNVERIFIABLE',
    ),
  ).toBe(true);
});

it.effect('preserves policy-owner outage identity', () =>
  Effect.gen(function* ownerOutage() {
    const failure = yield* customerCommercePaymentTermsPolicyResolver(
      'PROFILE',
      { tenantId, trustedStorefrontId: 'main' },
      {
        readCurrentPaymentTermPolicy: () =>
          Effect.fail(
            new CustomerCommercePolicyAdministrationRejected({
              code: 'PERSISTENCE_UNAVAILABLE',
              reason: 'database unavailable',
              retryable: true,
            }),
          ),
      },
    )
      .resolve({ at, purchasingContext: context.purchasingContext })
      .pipe(Effect.flip);

    expect(failure).toMatchObject({
      dependency: 'CUSTOMER_COMMERCE_POLICY',
      reason: 'The Current Customer Commerce Payment Terms Policy could not be resolved',
    });
  }),
);
