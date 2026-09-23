import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { getReadConditionalPermissionPlan } from '../../../../packages/core-runtime/src/reads/definition.ts';

import {
  PurchaseCurrencyResolutionDomainConflictProblem,
  PurchaseCurrencyResolutionDomainConflictProblemSchema,
  PurchaseCurrencyResolutionDomainPolicyProblem,
  PurchaseCurrencyResolutionDomainPolicyProblemSchema,
  PurchaseCurrencyResolutionDomainUnavailableProblem,
  PurchaseCurrencyResolutionDomainUnavailableProblemSchema,
  PurchaseCurrencyResolutionResponseSchema,
} from '../../shared/apis/purchase-currency-resolution.ts';
import { CurrencyCodeSchema } from '../../shared/domain/currency.ts';
import {
  ExplicitPurchaseCurrencyChoiceInvalid,
  InconsistentPurchaseCurrencyPolicy,
  NoUsablePurchaseCurrency,
  PurchaseCurrencyResolvedSchema,
  resolvePurchaseCurrency,
} from '../../shared/domain/purchase-currency-resolution.ts';
import {
  PurchaseCurrencyPurchasingContextPort,
  unavailablePurchaseCurrencyPurchasingContextPort,
} from '../../shared/domain/purchase-currency-context-port.ts';
import { PurchaseCurrencyPolicyPort } from '../../shared/domain/purchase-currency-policy-port.ts';
import { PurchaseCurrencyPricingPort } from '../../shared/domain/purchase-currency-pricing-port.ts';
import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import {
  CurrentPurchaseCurrencyPolicyCandidateSchema,
  CurrentPurchaseCurrencyPolicySetSchema,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type {
  CurrentPurchaseCurrencyPolicyCandidate,
  CurrentPurchaseCurrencyPolicySet,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import {
  handlePurchaseCurrencyResolution,
  makePurchaseCurrencyResolutionServices,
  purchaseCurrencyGuestPermissionTargets,
  purchaseCurrencyProfilePermissionTargets,
  purchaseCurrencyResolutionPermission,
} from '../../src/api/purchase-currency-resolution.read.ts';
import { composeCurrentPurchaseCurrencyPolicy } from '../../src/integrations/purchase-currency-policy.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const sellingLegalEntityId = '40000000-0000-4000-8000-000000000001';
const profileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const counterpartyProfileRef = {
  ...profileRef,
  resourceId: '10000000-0000-4000-8000-000000000002',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
};
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const purchasingContext = {
  cartId: 'cart-1',
  channelId: 'web',
  marketId: 'cz',
  sellingLegalEntityId,
  storefrontId: 'akros-cz',
  tenantId,
};
const policyCompleteness = {
  observedAt: '2026-09-09T10:00:01.000Z',
  ownerRevision: 'PURCHASE_CURRENCY:3',
  scope: {
    kind: 'EXACT_PREDICATE' as const,
    predicateRef: 'commerce.customer-context.policy.purchase_currency.current',
  },
};
const guestSubject = {
  guestEvidenceRef: 'guest-evidence-1',
  guestSessionRef: 'guest-session-1',
  kind: 'GUEST' as const,
};
const retailSubject = {
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef,
};
const policy = {
  allowedCurrencies: ['CZK', 'EUR'] as const,
  completeness: policyCompleteness,
  defaultCurrency: 'CZK' as const,
  policyRevisionIds: ['10000000-0000-4000-8000-000000000011'] as const,
};
const pricing = {
  pricingRevision: 'pricing-1',
  supportedCurrencies: ['CZK', 'EUR'] as const,
};
const launchCurrencyPolicy = {
  allowedCurrencies: ['CZK'] as const,
  completeness: policyCompleteness,
  defaultCurrency: 'CZK' as const,
  policyRevisionIds: ['10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000012'] as const,
};
const launchPricingCurrencySupport = {
  pricingRevision: 'pricing-czk-launch-v1',
  supportedCurrencies: ['CZK'] as const,
};
const baseResolution = () => ({
  policy,
  pricing,
  request: {
    contextRevision: 'context-1',
    purchasingContext,
    requestedAt: '2026-09-09T10:00:00.000Z',
    subject: retailSubject,
  },
});

const currentPolicySet = (
  candidates: CurrentPurchaseCurrencyPolicySet['candidates'],
  observedAt = policyCompleteness.observedAt,
) =>
  Schema.decodeUnknownSync(CurrentPurchaseCurrencyPolicySetSchema)({
    candidates,
    completeness: { ...policyCompleteness, observedAt },
  });

const policyCandidate = (
  policyRevisionId: string,
  value: CurrentPurchaseCurrencyPolicyCandidate['value'],
  scope?: CurrentPurchaseCurrencyPolicyCandidate['scope'],
) =>
  Schema.decodeUnknownSync(CurrentPurchaseCurrencyPolicyCandidateSchema)({
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    policyRevisionId,
    scope: scope ?? { kind: 'SELLER', sellingLegalEntityId },
    value,
  });

it('accepts only uppercase three-letter currency wire codes', () => {
  for (const value of ['CZK', 'EUR', 'USD']) {
    expect(Schema.is(CurrencyCodeSchema)(value)).toBe(true);
  }
  for (const value of ['czk', 'CZ', 'CZK1', ' CZK']) {
    expect(Schema.is(CurrencyCodeSchema)(value)).toBe(false);
  }
});

it('resolves explicit choice before the Launch CZK default', () => {
  const result = Schema.decodeUnknownSync(PurchaseCurrencyResolvedSchema)(
    resolvePurchaseCurrency({
      ...baseResolution(),
      request: { ...baseResolution().request, explicitChoice: 'EUR' },
    }),
  );
  expect(result).toMatchObject({ currencyCode: 'EUR', source: 'EXPLICIT_CHOICE' });
});

it('rejects an unsupported explicit choice without falling back', () => {
  const result = resolvePurchaseCurrency({
    policy: launchCurrencyPolicy,
    pricing: launchPricingCurrencySupport,
    request: { ...baseResolution().request, explicitChoice: 'EUR' },
  });
  expect(Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(result)).toBe(true);
  if (Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(result)) {
    expect(result.reason).toBe('POLICY_UNSUPPORTED');
  }
});

it('returns a typed no-usable result when no explicit choice or default exists', () => {
  const result = resolvePurchaseCurrency({
    ...baseResolution(),
    policy: { ...policy, defaultCurrency: null },
  });
  expect(Schema.is(NoUsablePurchaseCurrency)(result)).toBe(true);
});

it('rejects inconsistent Current policy facts before selecting a currency', () => {
  const result = resolvePurchaseCurrency({
    ...baseResolution(),
    policy: { ...policy, allowedCurrencies: ['CZK', 'CZK'] as const },
  });
  expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(result)).toBe(true);
});

it('accepts an explicit CZK choice under the Launch policy', () => {
  const result = resolvePurchaseCurrency({
    policy: launchCurrencyPolicy,
    pricing: launchPricingCurrencySupport,
    request: { ...baseResolution().request, explicitChoice: 'CZK' },
  });
  expect(result).toMatchObject({ currencyCode: 'CZK', source: 'EXPLICIT_CHOICE' });
});

it('keeps the accepted Akros Launch path exactly CZK for Guest and Profile subjects', () => {
  for (const subject of [guestSubject, retailSubject]) {
    const result = resolvePurchaseCurrency({
      policy: launchCurrencyPolicy,
      pricing: launchPricingCurrencySupport,
      request: {
        ...baseResolution().request,
        subject,
      },
    });
    expect(result).toMatchObject({ currencyCode: 'CZK', source: 'POLICY_DEFAULT' });
  }
});

it.effect('composes the complete Current CZK Launch policy and retains exact evidence', () =>
  Effect.gen(function* currentLaunchPolicy() {
    const current = currentPolicySet([
      policyCandidate('10000000-0000-4000-8000-000000000011', {
        currencyCode: 'CZK',
        kind: 'ALLOWED_CURRENCY_CONSTRAINT',
      }),
      policyCandidate('10000000-0000-4000-8000-000000000012', {
        currencyCode: 'CZK',
        kind: 'DEFAULT_CURRENCY',
      }),
    ]);
    const composed = yield* composeCurrentPurchaseCurrencyPolicy(
      current,
      purchasingContext,
      policyCompleteness.observedAt,
    );
    expect(composed).toMatchObject({
      allowedCurrencies: ['CZK'],
      completeness: policyCompleteness,
      defaultCurrency: 'CZK',
      policyRevisionIds: ['10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000012'],
    });
  }),
);

it.effect('rejects same-rank defaults as a typed policy conflict', () =>
  Effect.gen(function* conflictingDefaults() {
    const current = currentPolicySet([
      policyCandidate('10000000-0000-4000-8000-000000000021', {
        currencyCode: 'CZK',
        kind: 'ALLOWED_CURRENCY_CONSTRAINT',
      }),
      policyCandidate('10000000-0000-4000-8000-000000000022', {
        currencyCode: 'CZK',
        kind: 'DEFAULT_CURRENCY',
      }),
      policyCandidate('10000000-0000-4000-8000-000000000023', {
        currencyCode: 'EUR',
        kind: 'DEFAULT_CURRENCY',
      }),
    ]);
    const failure = yield* composeCurrentPurchaseCurrencyPolicy(
      current,
      purchasingContext,
      policyCompleteness.observedAt,
    ).pipe(Effect.flip);
    expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(failure)).toBe(true);
  }),
);

it.effect('fails closed when policy completeness is stale for the observed decision', () =>
  Effect.gen(function* staleCompleteness() {
    const current = currentPolicySet([], '2026-09-09T09:59:59.000Z');
    const failure = yield* composeCurrentPurchaseCurrencyPolicy(
      current,
      purchasingContext,
      policyCompleteness.observedAt,
    ).pipe(Effect.flip);
    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
    if (Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)) {
      expect(failure.code).toBe('currency_policy_unavailable');
    }
  }),
);

it.effect('distinguishes absent and broken complete candidate sets', () =>
  Effect.gen(function* absentAndBrokenCandidates() {
    const absent = yield* composeCurrentPurchaseCurrencyPolicy(
      currentPolicySet([]),
      purchasingContext,
      policyCompleteness.observedAt,
    ).pipe(Effect.flip);
    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(absent)).toBe(true);

    const broken = yield* composeCurrentPurchaseCurrencyPolicy(
      currentPolicySet([
        policyCandidate('10000000-0000-4000-8000-000000000031', {
          currencyCode: 'CZK',
          kind: 'DEFAULT_CURRENCY',
        }),
      ]),
      purchasingContext,
      policyCompleteness.observedAt,
    ).pipe(Effect.flip);
    expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(broken)).toBe(true);
  }),
);

it.effect('uses the most specific default and intersects every applicable non-relaxable allowed set', () =>
  Effect.gen(function* rankedComposition() {
    const marketScope = {
      channelId: purchasingContext.channelId,
      commerceMarketId: purchasingContext.marketId,
      kind: 'MARKET_CHANNEL_SELLER',
      sellingLegalEntityId,
    } as const;
    const current = currentPolicySet([
      policyCandidate('10000000-0000-4000-8000-000000000041', {
        currencyCode: 'CZK',
        kind: 'ALLOWED_CURRENCY_CONSTRAINT',
      }),
      policyCandidate('10000000-0000-4000-8000-000000000042', {
        currencyCode: 'EUR',
        kind: 'ALLOWED_CURRENCY_CONSTRAINT',
      }),
      policyCandidate(
        '10000000-0000-4000-8000-000000000043',
        { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
        marketScope,
      ),
      policyCandidate('10000000-0000-4000-8000-000000000044', {
        currencyCode: 'EUR',
        kind: 'DEFAULT_CURRENCY',
      }),
      policyCandidate(
        '10000000-0000-4000-8000-000000000045',
        { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
        marketScope,
      ),
    ]);
    const composed = yield* composeCurrentPurchaseCurrencyPolicy(
      current,
      purchasingContext,
      policyCompleteness.observedAt,
    );
    expect(composed.allowedCurrencies).toEqual(['CZK']);
    expect(composed.defaultCurrency).toBe('CZK');
  }),
);

it('rejects a Pricing-unsupported explicit currency without falling back', () => {
  const result = resolvePurchaseCurrency({
    ...baseResolution(),
    pricing: { pricingRevision: 'pricing-czk-only', supportedCurrencies: ['CZK'] },
    request: { ...baseResolution().request, explicitChoice: 'EUR' },
  });
  expect(Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(result)).toBe(true);
  if (Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(result)) {
    expect(result.reason).toBe('PRICING_UNSUPPORTED');
  }
});

it('returns no usable currency when Pricing does not support the policy default', () => {
  const result = resolvePurchaseCurrency({
    ...baseResolution(),
    pricing: { pricingRevision: 'pricing-eur-only', supportedCurrencies: ['EUR'] },
  });
  expect(Schema.is(NoUsablePurchaseCurrency)(result)).toBe(true);
});

it('keeps typed domain outcomes outside HTTP success', () => {
  const input = baseResolution();
  const success = resolvePurchaseCurrency(input);
  const ineligible = resolvePurchaseCurrency({
    ...input,
    policy: launchCurrencyPolicy,
    pricing: launchPricingCurrencySupport,
    request: { ...input.request, explicitChoice: 'EUR' },
  });
  expect(Schema.is(PurchaseCurrencyResolutionResponseSchema)(success)).toBe(true);
  expect(Schema.is(PurchaseCurrencyResolutionResponseSchema)(ineligible)).toBe(false);
  expect(
    Schema.is(PurchaseCurrencyResolutionDomainPolicyProblemSchema)(
      new PurchaseCurrencyResolutionDomainPolicyProblem({
        detail: 'The currency choice is not eligible.',
        reasonCode: 'EXPLICIT_CHOICE_INVALID',
        status: 422,
        title: 'Currency resolution ineligible',
        type: 'https://ontos.dev/problems/purchase-currency-ineligible',
      }),
    ),
  ).toBe(true);
  expect(
    Schema.is(PurchaseCurrencyResolutionDomainConflictProblemSchema)(
      new PurchaseCurrencyResolutionDomainConflictProblem({
        detail: 'The Current currency facts conflict.',
        reasonCode: 'INCONSISTENT_CURRENCY_POLICY',
        status: 409,
        title: 'Currency resolution conflict',
        type: 'https://ontos.dev/problems/purchase-currency-conflict',
      }),
    ),
  ).toBe(true);
  expect(
    Schema.is(PurchaseCurrencyResolutionDomainUnavailableProblemSchema)(
      new PurchaseCurrencyResolutionDomainUnavailableProblem({
        detail: 'Current Pricing support is unavailable.',
        reasonCode: 'pricing_currency_support_unavailable',
        retryable: true,
        status: 503,
        title: 'Currency resolution unavailable',
        type: 'https://ontos.dev/problems/purchase-currency-unavailable',
      }),
    ),
  ).toBe(true);
});

it.effect('resolves only from Current injected facts and server observation time', () =>
  Effect.gen(function* authoritativeCurrencyResolution() {
    const input = baseResolution().request;
    let suppliedObservedAt = '';
    const response = yield* handlePurchaseCurrencyResolution(input, {
      readKey: 'commerce.customer-context.api.purchase-currency-resolution',
      scope: {
        authMethod: 'system',
        correlationId: 'authoritative-currency-resolution',
        legalEntityId: sellingLegalEntityId,
        principalId: '50000000-0000-4000-8000-000000000001',
        tenantId,
        trustedStorefrontId: purchasingContext.storefrontId,
      },
      services: {
        loadCurrent: (_request, observedAt) => {
          suppliedObservedAt = observedAt;
          return Effect.succeed({
            contextRevision: input.contextRevision,
            policy: launchCurrencyPolicy,
            pricing: launchPricingCurrencySupport,
            purchasingContext,
            subject: input.subject,
          });
        },
      },
    });
    expect(suppliedObservedAt).not.toBe(input.requestedAt);
    expect(response.result).toMatchObject({
      currencyCode: 'CZK',
      evidence: { requestedAt: suppliedObservedAt },
      source: 'POLICY_DEFAULT',
    });
  }),
);

it.effect('preserves stale Current context as a typed conflict', () =>
  Effect.gen(function* staleCurrencyContext() {
    const input = baseResolution().request;
    const failure = yield* handlePurchaseCurrencyResolution(input, {
      readKey: 'commerce.customer-context.api.purchase-currency-resolution',
      scope: {
        authMethod: 'system',
        correlationId: 'stale-currency-context',
        legalEntityId: sellingLegalEntityId,
        principalId: '50000000-0000-4000-8000-000000000001',
        tenantId,
        trustedStorefrontId: purchasingContext.storefrontId,
      },
      services: {
        loadCurrent: () =>
          Effect.succeed({
            contextRevision: 'context-2',
            policy: launchCurrencyPolicy,
            pricing: launchPricingCurrencySupport,
            purchasingContext: { ...purchasingContext, storefrontId: 'different-storefront' },
            subject: input.subject,
          }),
      },
    }).pipe(Effect.flip);
    expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(failure)).toBe(true);
  }),
);

it.effect('binds Guest resolution to the exact Current cart session and evidence', () =>
  Effect.gen(function* exactGuestPurchaseContext() {
    const input = { ...baseResolution().request, subject: guestSubject };
    const failure = yield* handlePurchaseCurrencyResolution(input, {
      readKey: 'commerce.customer-context.api.purchase-currency-resolution',
      scope: {
        authMethod: 'system',
        correlationId: 'guest-purchase-context-isolation',
        legalEntityId: sellingLegalEntityId,
        principalId: '50000000-0000-4000-8000-000000000001',
        tenantId,
        trustedStorefrontId: purchasingContext.storefrontId,
      },
      services: {
        loadCurrent: () =>
          Effect.succeed({
            contextRevision: input.contextRevision,
            policy: launchCurrencyPolicy,
            pricing: launchPricingCurrencySupport,
            purchasingContext,
            subject: { ...guestSubject, guestSessionRef: 'different-current-session' },
          }),
      },
    }).pipe(Effect.flip);
    expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(failure)).toBe(true);
  }),
);

it.effect('rejects a Current profile subject with a different Counterparty', () =>
  Effect.gen(function* exactCounterpartyPurchaseSubject() {
    const input = {
      ...baseResolution().request,
      subject: {
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
        kind: 'PROFILE' as const,
        profileRef: counterpartyProfileRef,
      },
    };
    const failure = yield* handlePurchaseCurrencyResolution(input, {
      readKey: 'commerce.customer-context.api.purchase-currency-resolution',
      scope: {
        authMethod: 'system',
        correlationId: 'counterparty-purchase-subject-isolation',
        legalEntityId: sellingLegalEntityId,
        principalId: '50000000-0000-4000-8000-000000000001',
        tenantId,
        trustedStorefrontId: purchasingContext.storefrontId,
      },
      services: {
        loadCurrent: () =>
          Effect.succeed({
            contextRevision: input.contextRevision,
            policy: launchCurrencyPolicy,
            pricing: launchPricingCurrencySupport,
            purchasingContext,
            subject: {
              ...input.subject,
              authorizationSubject: {
                counterpartyRef: {
                  ...counterpartyRef,
                  resourceId: '30000000-0000-0000-8000-000000000099',
                },
                kind: 'COUNTERPARTY' as const,
              },
            },
          }),
      },
    }).pipe(Effect.flip);
    expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(failure)).toBe(true);
  }),
);

it('declares finite Guest and Profile authorization branches for Launch resolution', () => {
  const scope = {
    authMethod: 'system' as const,
    correlationId: 'purchase-currency-permission-targets',
    legalEntityId: sellingLegalEntityId,
    principalId: '50000000-0000-4000-8000-000000000001',
    tenantId,
    trustedStorefrontId: purchasingContext.storefrontId,
  };
  const plan = getReadConditionalPermissionPlan(purchaseCurrencyResolutionPermission);
  expect(purchaseCurrencyResolutionPermission.branchTags).toEqual(['GUEST', 'PROFILE']);
  expect(purchaseCurrencyGuestPermissionTargets()).toEqual([{ kind: 'module', moduleId: 'commerce.customer-context' }]);
  expect(plan.branches.GUEST.requiredKinds).toEqual(['module']);
  expect(plan.branches.PROFILE.requiredKinds).toEqual(['business_permission', 'resource_read']);
  expect(
    purchaseCurrencyProfilePermissionTargets(
      baseResolution().request,
      { authorizationSubject: { kind: 'RETAIL' }, kind: 'PROFILE', profileRef },
      scope,
    ),
  ).toMatchObject([
    {
      businessPermission: {
        permission: 'retail.profile.read',
        target: { kind: 'retail_profile', profileId: profileRef.resourceId },
      },
      kind: 'business_permission',
    },
    { kind: 'resource_read', permission: 'read', resource: { resourceId: profileRef.resourceId } },
  ]);
  expect(
    purchaseCurrencyProfilePermissionTargets(
      {
        ...baseResolution().request,
        subject: {
          authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
          kind: 'PROFILE',
          profileRef: counterpartyProfileRef,
        },
      },
      {
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        kind: 'PROFILE',
        profileRef: counterpartyProfileRef,
      },
      scope,
    ),
  ).toMatchObject([
    {
      businessPermission: {
        permission: 'counterparty.profile.read',
        target: { counterpartyId: counterpartyRef.resourceId, kind: 'counterparty' },
      },
      kind: 'business_permission',
    },
    {
      kind: 'resource_read',
      permission: 'read',
      resource: { resourceId: counterpartyProfileRef.resourceId },
    },
  ]);
});

it.effect('loads Current policy and pricing without a preference persistence dependency', () =>
  Effect.gen(function* ownerComposedCurrentFacts() {
    const input = baseResolution().request;
    const calls: string[] = [];
    const pricingInputs: unknown[] = [];
    const services = yield* makePurchaseCurrencyResolutionServices({
      scope: {
        legalEntityId: sellingLegalEntityId,
        storefrontId: purchasingContext.storefrontId,
        tenantId,
      },
    }).pipe(
      Effect.provideService(PurchaseCurrencyPolicyPort, {
        resolveCurrent: () => {
          calls.push('policy');
          return Effect.succeed(launchCurrencyPolicy);
        },
      }),
      Effect.provideService(PurchaseCurrencyPurchasingContextPort, {
        resolveCurrent: () => {
          calls.push('context');
          return Effect.succeed({
            contextRevision: input.contextRevision,
            purchasingContext,
            subject: input.subject,
          });
        },
      }),
      Effect.provideService(PurchaseCurrencyPricingPort, {
        resolveCurrent: (pricingInput) => {
          calls.push('pricing');
          pricingInputs.push(pricingInput);
          return Effect.succeed(launchPricingCurrencySupport);
        },
      }),
    );
    const current = yield* services.loadCurrent(input, '2026-09-09T10:00:01.000Z');
    expect(current).not.toHaveProperty('preference');
    expect(calls).toEqual(['context', 'policy', 'pricing']);
    expect(pricingInputs).toEqual([
      {
        context: {
          contextRevision: input.contextRevision,
          purchasingContext,
          subject: input.subject,
        },
        observedAt: '2026-09-09T10:00:01.000Z',
        subject: input.subject,
      },
    ]);
  }),
);

it.effect('propagates an unavailable Current owner as a typed dependency outcome', () =>
  Effect.gen(function* unavailableOwner() {
    const services = yield* makePurchaseCurrencyResolutionServices({
      scope: {
        legalEntityId: sellingLegalEntityId,
        storefrontId: purchasingContext.storefrontId,
        tenantId,
      },
    }).pipe(
      Effect.provideService(PurchaseCurrencyPolicyPort, {
        resolveCurrent: () => Effect.succeed(launchCurrencyPolicy),
      }),
      Effect.provideService(PurchaseCurrencyPurchasingContextPort, {
        resolveCurrent: () =>
          Effect.fail(
            PurchaseCurrencyDependencyUnavailable.make({
              code: 'purchasing_context_unavailable',
              reason: 'The Current Commerce Purchasing Context provider is unavailable',
              retryable: true,
            }),
          ),
      }),
      Effect.provideService(PurchaseCurrencyPricingPort, {
        resolveCurrent: () => Effect.succeed(launchPricingCurrencySupport),
      }),
    );
    const failure = yield* services.loadCurrent(baseResolution().request, '2026-09-09T10:00:01.000Z').pipe(Effect.flip);
    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
    if (Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)) {
      expect(failure.code).toBe('purchasing_context_unavailable');
    }
  }),
);

it.effect('fails closed when the purchasing-context owner is not configured', () =>
  Effect.gen(function* unavailablePurchasingContextOwner() {
    const input = baseResolution().request;
    const service = unavailablePurchaseCurrencyPurchasingContextPort();
    const failure = yield* service
      .resolveCurrent({
        claimedContext: input.purchasingContext,
        claimedContextRevision: input.contextRevision,
        claimedSubject: input.subject,
        observedAt: '2026-09-09T10:00:01.000Z',
        scope: {
          legalEntityId: sellingLegalEntityId,
          storefrontId: purchasingContext.storefrontId,
          tenantId,
        },
      })
      .pipe(Effect.flip);

    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
    if (Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)) {
      expect(failure.code).toBe('purchasing_context_unavailable');
      expect(failure.retryable).toBe(true);
    }
  }),
);
