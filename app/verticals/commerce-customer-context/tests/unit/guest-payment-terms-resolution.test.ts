import { ConfigProvider, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { GuestPaymentTermsResolutionRequestSchema } from '../../shared/apis/guest-payment-terms-resolution.ts';
import type { PaymentTermDefinitionSnapshot } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import {
  CustomerCommercePaymentTermsPolicyConfigurationSchema,
  resolveCustomerCommercePaymentTermsPolicy,
} from '../../shared/domain/payment-terms.ts';
import {
  guestPaymentTermsResolutionEntrypoint,
  handleGuestPaymentTermsResolution,
} from '../../src/api/guest-payment-terms-resolution.read.ts';
import type {
  GuestPaymentTermsPolicyDecision,
  GuestPaymentTermsResolutionServices,
} from '../../src/api/guest-payment-terms-resolution.read.ts';
import {
  CUSTOMER_COMMERCE_PAYMENT_TERMS_POLICY_CONFIG,
  customerCommercePaymentTermsPolicyResolver,
} from '../../src/integrations/customer-commerce-payment-terms-policy.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
};
const fallbackRef = {
  ...paymentTermRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
};
const definition = (reference = paymentTermRef): PaymentTermDefinitionSnapshot => ({
  code: 'IMMEDIATE',
  compatibilityId: 'immediate.v1',
  compatibleWith: ['customer-payment-terms.v1'],
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Immediate',
  paymentTermRef: reference,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '66666666-6666-4666-8666-666666666666',
  semantics: {
    calculationRuleVersion: 1,
    calendarRule: 'NOT_APPLICABLE',
    kind: 'IMMEDIATE',
  },
});
const request = {
  at: '2026-09-09T10:00:00.000Z',
  purchasingContext: {
    channelId: 'guest-web',
    contextRevision: 'context-7',
    marketId: 'cz',
    sellingLegalEntityId: legalEntityId,
    storefrontId: 'main',
  },
};
const scope = {
  authBindingId: '88888888-8888-4888-8888-888888888888',
  authContextRef: 'better-auth-session:guest-payment-terms',
  authMethod: 'session' as const,
  correlationId: 'guest-payment-terms',
  legalEntityId,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
  trustedStorefrontId: request.purchasingContext.storefrontId,
};
const policy = (overrides: Partial<GuestPaymentTermsPolicyDecision> = {}): GuestPaymentTermsPolicyDecision => ({
  eligiblePaymentTermRefs: [paymentTermRef, fallbackRef],
  explicitlyPermittedPaymentTermRefs: [paymentTermRef],
  fallbackPaymentTermRefs: [fallbackRef],
  policyRevision: 'guest-policy-3',
  policySource: 'customer-commerce-policy',
  ...overrides,
});
const services = (
  decision: GuestPaymentTermsPolicyDecision,
  definitions: readonly PaymentTermDefinitionSnapshot[],
): GuestPaymentTermsResolutionServices => ({
  currentInstant: Effect.succeed(request.at),
  resolveDefinitions: () => Effect.succeed(definitions),
  resolvePolicy: () => Effect.succeed(decision),
});

it('exposes an authenticated Guest-only contract without caller-authored policy inputs', () => {
  expect(guestPaymentTermsResolutionEntrypoint.authorization).toEqual({
    kind: 'context_permission',
    permission: 'module.access',
  });
  expect(Schema.is(GuestPaymentTermsResolutionRequestSchema)(request)).toBe(true);
  expect('eligiblePaymentTermRefs' in GuestPaymentTermsResolutionRequestSchema.fields).toBe(false);
  expect('policyFallbackRefs' in GuestPaymentTermsResolutionRequestSchema.fields).toBe(false);
  expect('profileRef' in GuestPaymentTermsResolutionRequestSchema.fields).toBe(false);
});

it.effect('fails closed before policy resolution without a trusted Storefront', () =>
  Effect.gen(function* missingTrustedStorefront() {
    const failure = yield* handleGuestPaymentTermsResolution(request, {
      readKey: 'commerce.customer-context.api.guest-payment-terms-resolution',
      scope: {
        authBindingId: scope.authBindingId,
        authContextRef: scope.authContextRef,
        authMethod: scope.authMethod,
        correlationId: scope.correlationId,
        legalEntityId: scope.legalEntityId,
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      },
      services: services(policy(), []),
    }).pipe(Effect.flip);

    expect(failure).toMatchObject({
      code: 'read_handler_unavailable',
      reason: 'Guest Payment Term resolution requires a trusted Storefront context',
    });
  }),
);

it.effect('loads one exact Current owner-authored rule from deployment configuration', () =>
  Effect.gen(function* configuredPolicyResolution() {
    const configuration = Schema.decodeUnknownSync(CustomerCommercePaymentTermsPolicyConfigurationSchema)({
      configurationRevision: 'launch-policy-config-4',
      policySource: 'customer-commerce-policy:launch-config',
      rules: [
        {
          audience: 'BOTH',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          eligiblePaymentTermRefs: [paymentTermRef, fallbackRef],
          explicitlyPermittedPaymentTermRefs: [paymentTermRef],
          fallbackPaymentTermRefs: [fallbackRef],
          policyRevision: 'launch-policy-rule-7',
          scope: {
            channelId: request.purchasingContext.channelId,
            marketId: request.purchasingContext.marketId,
            sellingLegalEntityId: legalEntityId,
            storefrontId: request.purchasingContext.storefrontId,
            tenantId,
          },
        },
      ],
    });
    const resolution = yield* customerCommercePaymentTermsPolicyResolver('GUEST', {
      tenantId,
      trustedStorefrontId: request.purchasingContext.storefrontId,
    })
      .resolve(request)
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            [CUSTOMER_COMMERCE_PAYMENT_TERMS_POLICY_CONFIG]: JSON.stringify(configuration),
          }),
        ),
      );

    expect(resolution).toMatchObject({
      eligiblePaymentTermRefs: [paymentTermRef, fallbackRef],
      explicitlyPermittedPaymentTermRefs: [paymentTermRef],
      fallbackPaymentTermRefs: [fallbackRef],
      policyRevision: 'launch-policy-rule-7',
    });
  }),
);

it('uses the trusted Storefront to select policy and only verifies request Channel/Market claims', () => {
  const configuration = Schema.decodeUnknownSync(CustomerCommercePaymentTermsPolicyConfigurationSchema)({
    configurationRevision: 'launch-policy-config-4',
    policySource: 'customer-commerce-policy:launch-config',
    rules: [
      {
        audience: 'GUEST',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        eligiblePaymentTermRefs: [fallbackRef],
        explicitlyPermittedPaymentTermRefs: [],
        fallbackPaymentTermRefs: [fallbackRef],
        policyRevision: 'launch-policy-rule-7',
        scope: {
          channelId: request.purchasingContext.channelId,
          marketId: request.purchasingContext.marketId,
          sellingLegalEntityId: legalEntityId,
          storefrontId: request.purchasingContext.storefrontId,
          tenantId,
        },
      },
    ],
  });
  const outcome = resolveCustomerCommercePaymentTermsPolicy(configuration, {
    at: request.at,
    audience: 'GUEST',
    purchasingContext: { ...request.purchasingContext, marketId: 'caller-selected-market' },
    tenantId,
    trustedStorefrontId: request.purchasingContext.storefrontId,
  });

  expect(Predicate.isTagged(outcome, 'INCONSISTENT_CONFIGURATION')).toBe(true);
});

it.effect('uses the authoritative Guest fallback with exact policy and context provenance', () =>
  Effect.gen(function* resolvesFallback() {
    const handled = yield* handleGuestPaymentTermsResolution(request, {
      readKey: 'commerce.customer-context.api.guest-payment-terms-resolution',
      scope,
      services: services(policy(), [definition(paymentTermRef), definition(fallbackRef)]),
    });
    expect(Predicate.isTagged(handled.result, 'POLICY_FALLBACK')).toBe(true);
    if (Predicate.isTagged(handled.result, 'POLICY_FALLBACK')) {
      expect(handled.result.customerPaymentTermsRevision).toBeNull();
      expect(handled.result.definition.paymentTermRef).toEqual(fallbackRef);
      expect(handled.result.policyRevision).toBe('guest-policy-3');
      expect(handled.result.purchasingContextRevision).toBe('context-7');
    }
  }),
);

it.effect('never falls back after an invalid explicit Guest choice', () =>
  Effect.gen(function* rejectsExplicitChoice() {
    const handled = yield* handleGuestPaymentTermsResolution(
      { ...request, explicitChoice: fallbackRef },
      {
        readKey: 'commerce.customer-context.api.guest-payment-terms-resolution',
        scope,
        services: services(policy(), [definition(paymentTermRef), definition(fallbackRef)]),
      },
    );
    expect(Predicate.isTagged(handled.result, 'EXPLICIT_CHOICE_INVALID')).toBe(true);
  }),
);

it.effect('fails closed when the authoritative Guest policy is unavailable', () =>
  Effect.gen(function* unavailablePolicy() {
    const failure = yield* handleGuestPaymentTermsResolution(request, {
      readKey: 'commerce.customer-context.api.guest-payment-terms-resolution',
      scope,
      services: {
        currentInstant: Effect.succeed(request.at),
        resolveDefinitions: () => Effect.die('must not load definitions without policy'),
        resolvePolicy: () =>
          Effect.fail(
            new PaymentTermsDependencyUnavailable({
              code: 'payment_terms_dependency_unavailable',
              dependency: 'CUSTOMER_COMMERCE_POLICY',
              reason: 'Guest policy unavailable',
            }),
          ),
      },
    }).pipe(Effect.flip);
    expect(failure.reason).toBe('Guest policy unavailable');
  }),
);
