import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getReadConditionalPermissionPlan,
  getReadResourcePermissionTargetResolver,
  getReadServiceFactory,
} from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  PurchaseCurrencyResolutionDomainConflictProblem,
  PurchaseCurrencyResolutionDomainConflictProblemSchema,
  PurchaseCurrencyResolutionDomainPolicyProblem,
  PurchaseCurrencyResolutionDomainPolicyProblemSchema,
  PurchaseCurrencyResolutionDomainUnavailableProblem,
  PurchaseCurrencyResolutionDomainUnavailableProblemSchema,
  PurchaseCurrencyResolutionResponseSchema,
} from '../../shared/apis/purchase-currency-resolution.ts';
import {
  ChangeCustomerCurrencyPreferenceCommandSchema,
  CustomerCurrencyCodeUnrecognized,
  CustomerCurrencyPreferenceChangeResultSchema,
  CustomerCurrencyPreferencePersistenceUnavailable,
  decideCustomerCurrencyPreferenceChange,
} from '../../shared/domain/customer-currency-preference.ts';
import type {
  CustomerCurrencyPreference,
  CustomerCurrencyPreferenceSnapshot,
  CustomerProfileRef,
} from '../../shared/domain/customer-currency-preference.ts';
import { CurrencyCodeSchema } from '../../shared/domain/currency.ts';
import {
  RecognizedCurrencyCatalogUnavailable,
  unavailableRecognizedCurrencyCatalogPort,
} from '../../shared/domain/currency-catalog-port.ts';
import { OutboxPayloadSchema as CurrencyPreferenceChangedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-currency-preference-changed-v1.ts';
import {
  AKROS_LAUNCH_CURRENCY_POLICY,
  AKROS_LAUNCH_PRICING_CURRENCY_SUPPORT,
  ExplicitPurchaseCurrencyChoiceInvalid,
  InconsistentPurchaseCurrencyPolicy,
  NoUsablePurchaseCurrency,
  PurchaseCurrencyResolvedSchema,
  resolvePurchaseCurrency,
} from '../../shared/domain/purchase-currency-resolution.ts';
import { PurchaseCurrencyPurchasingContextPort } from '../../shared/domain/purchase-currency-context-port.ts';
import { PurchaseCurrencyPolicyPort } from '../../shared/domain/purchase-currency-policy-port.ts';
import { PurchaseCurrencyPricingPort } from '../../shared/domain/purchase-currency-pricing-port.ts';
import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import {
  changeCustomerCurrencyPreferenceAction,
  customerCurrencyPreferenceBusinessPermission,
  handleChangeCustomerCurrencyPreference,
} from '../../src/actions/change-customer-currency-preference.action.ts';
import { createChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxMessage as createCurrencyPreferenceChangedOutboxMessage } from '../../src/actions/change-customer-currency-preference.commerce-customer-context-currency-preference-changed-v1.outbox-message.ts';
import {
  customerCurrencyPreferenceReadPermissionTarget,
  customerCurrencyPreferenceReadRead,
} from '../../src/api/customer-currency-preference-read.read.ts';
import {
  handlePurchaseCurrencyResolution,
  makePurchaseCurrencyResolutionServices,
  purchaseCurrencyGuestPermissionTargets,
  purchaseCurrencyProfilePermissionTargets,
  purchaseCurrencyResolutionPermission,
} from '../../src/api/purchase-currency-resolution.read.ts';
import type { CustomerCurrencyPreferencePersistence } from '../../src/persistence/currency-persistence.ts';
import type {
  CurrencyPolicyDecision,
  PricingCurrencySupport,
  PurchaseCurrencyResolutionInput,
} from '../../shared/domain/purchase-currency-resolution.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const sellingLegalEntityId = '40000000-0000-4000-8000-000000000001';
const profileRef: CustomerProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.retail-customer-profile',
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
const retailAuthorization = { kind: 'RETAIL' as const };
const purchasingContext = {
  cartId: 'cart-1',
  channelId: 'web',
  marketId: 'cz',
  sellingLegalEntityId,
  storefrontId: 'akros-cz',
  tenantId,
};
const guestSubject = {
  guestEvidenceRef: 'guest-evidence-1',
  guestSessionRef: 'guest-session-1',
  kind: 'GUEST' as const,
};
const policy: CurrencyPolicyDecision = {
  customerPreferenceEnabled: true,
  defaultCurrency: 'CZK',
  explicitChoiceEnabled: true,
  policyRevision: 'policy-1',
  supportedCurrencies: ['CZK', 'EUR'],
};
const pricing: PricingCurrencySupport = {
  pricingRevision: 'pricing-1',
  supportedCurrencies: ['CZK', 'EUR'],
};
const baseResolution = (): PurchaseCurrencyResolutionInput => ({
  policy,
  preference: { currencyCode: 'EUR', profileRef, revision: 7 },
  pricing,
  request: {
    contextRevision: 'context-1',
    purchasingContext,
    requestedAt: '2026-09-09T10:00:00.000Z',
    subject: {
      authorizationSubject: retailAuthorization,
      kind: 'PROFILE',
      profileRef,
    },
  },
});

const preference = (currencyCode: 'CZK' | 'EUR', revision = 1): CustomerCurrencyPreference => ({
  createdAt: '2026-09-09T09:00:00.000Z',
  currencyCode,
  preferenceRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '30000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.customer-currency-preference',
    tenantId,
  },
  profileRef,
  revision,
  updatedAt: '2026-09-09T09:00:00.000Z',
});

const snapshot = (
  currencyCode: 'CZK' | 'EUR',
  revision = 1,
): CustomerCurrencyPreferenceSnapshot => ({
  preference: preference(currencyCode, revision),
  profileRef,
  revision,
  state: 'PRESENT',
});

const makeCurrencyPreferenceCollector = () =>
  createActionCollector(
    changeCustomerCurrencyPreferenceAction.descriptor.domainEvents,
    'commerce.customer-context',
    changeCustomerCurrencyPreferenceAction.descriptor.accessEvidencePolicy,
    changeCustomerCurrencyPreferenceAction.descriptor.auditEvidenceSchema,
  );

it('accepts only uppercase three-letter currency wire codes', () => {
  for (const value of ['CZK', 'EUR', 'USD']) {
    expect(Schema.is(CurrencyCodeSchema)(value)).toBe(true);
  }
  for (const value of ['czk', 'CZ', 'CZK1', ' CZK']) {
    expect(Schema.is(CurrencyCodeSchema)(value)).toBe(false);
  }
});

it.effect('fails closed when no trusted recognized-currency catalog is configured', () =>
  Effect.gen(function* unavailableCurrencyCatalog() {
    const failure = yield* unavailableRecognizedCurrencyCatalogPort()
      .resolveCurrent({ legalEntityId: sellingLegalEntityId, tenantId })
      .pipe(Effect.flip);
    expect(Schema.is(RecognizedCurrencyCatalogUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'recognized_currency_catalog_unavailable',
      retryable: true,
    });
  }),
);

it('requires a profile-kind-compatible authorization subject', () => {
  const base = {
    change: { currencyCode: 'CZK', kind: 'SET' },
    expectedRevision: 0,
  } as const;
  expect(
    Schema.is(ChangeCustomerCurrencyPreferenceCommandSchema)({
      ...base,
      authorizationSubject: retailAuthorization,
      profileRef,
    }),
  ).toBe(true);
  expect(
    Schema.is(ChangeCustomerCurrencyPreferenceCommandSchema)({
      ...base,
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
      profileRef: counterpartyProfileRef,
    }),
  ).toBe(true);
  expect(
    Schema.is(ChangeCustomerCurrencyPreferenceCommandSchema)({
      ...base,
      authorizationSubject: retailAuthorization,
      profileRef: counterpartyProfileRef,
    }),
  ).toBe(false);
});

it('selects exact retail and Counterparty permissions before handler execution', () => {
  const scope = {
    authMethod: 'system' as const,
    correlationId: 'currency-permission-targets',
    legalEntityId: sellingLegalEntityId,
    principalId: '50000000-0000-4000-8000-000000000001',
    tenantId,
  };
  const change = { change: { kind: 'CLEAR' as const }, expectedRevision: 0 };
  expect(
    customerCurrencyPreferenceBusinessPermission(
      { ...change, authorizationSubject: retailAuthorization, profileRef },
      scope,
    ),
  ).toMatchObject({
    permission: 'retail.settings.currency.manage',
    target: { kind: 'retail_profile', profileId: profileRef.resourceId },
  });
  expect(
    customerCurrencyPreferenceBusinessPermission(
      {
        ...change,
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        profileRef: counterpartyProfileRef,
      },
      scope,
    ),
  ).toMatchObject({
    permission: 'counterparty.settings.currency.manage',
    target: {
      counterpartyId: counterpartyRef.resourceId,
      kind: 'counterparty',
    },
  });
  expect(
    customerCurrencyPreferenceReadPermissionTarget(
      { authorizationSubject: retailAuthorization, profileRef },
      scope,
    ),
  ).toMatchObject({
    businessPermission: { permission: 'retail.profile.read' },
  });
  expect(
    customerCurrencyPreferenceReadPermissionTarget(
      {
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        profileRef: counterpartyProfileRef,
      },
      scope,
    ),
  ).toMatchObject({
    businessPermission: { permission: 'counterparty.profile.read' },
  });

  const resourcePermission = getReadResourcePermissionTargetResolver(
    customerCurrencyPreferenceReadRead,
  );
  expect(
    resourcePermission?.({ authorizationSubject: retailAuthorization, profileRef }, scope),
  ).toEqual({
    permission: 'read',
    resource: {
      moduleId: profileRef.moduleId,
      resourceId: profileRef.resourceId,
      resourceType: profileRef.resourceType,
    },
  });
  expect(
    resourcePermission?.(
      {
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        profileRef: counterpartyProfileRef,
      },
      scope,
    ),
  ).toEqual({
    permission: 'read',
    resource: {
      moduleId: counterpartyProfileRef.moduleId,
      resourceId: counterpartyProfileRef.resourceId,
      resourceType: counterpartyProfileRef.resourceType,
    },
  });
});

it('declares finite Guest and Profile authorization branches for purchase resolution', () => {
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
  expect(purchaseCurrencyGuestPermissionTargets()).toEqual([
    { kind: 'module', moduleId: 'commerce.customer-context' },
  ]);
  expect(plan.branches.GUEST.requiredKinds).toEqual(['module']);
  expect(plan.branches.PROFILE.requiredKinds).toEqual(['business_permission', 'resource_read']);
  expect(
    purchaseCurrencyProfilePermissionTargets(
      baseResolution().request,
      {
        authorizationSubject: retailAuthorization,
        kind: 'PROFILE',
        profileRef,
      },
      scope,
    ),
  ).toEqual([
    {
      businessPermission: {
        permission: 'retail.profile.read',
        target: {
          kind: 'retail_profile',
          legalEntityId: sellingLegalEntityId,
          profileId: profileRef.resourceId,
          tenantId,
        },
      },
      kind: 'business_permission',
    },
    {
      kind: 'resource_read',
      permission: 'read',
      resource: {
        moduleId: profileRef.moduleId,
        resourceId: profileRef.resourceId,
        resourceType: profileRef.resourceType,
      },
    },
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
        target: {
          counterpartyId: counterpartyRef.resourceId,
          kind: 'counterparty',
        },
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

it('treats an equivalent preference change as idempotent before revision conflict', () => {
  const current = snapshot('CZK', 4);
  const result = decideCustomerCurrencyPreferenceChange({
    command: {
      authorizationSubject: retailAuthorization,
      change: { currencyCode: 'CZK', kind: 'SET' },
      expectedRevision: 1,
      profileRef,
    },
    current,
    recognizedCurrencies: ['CZK'],
  });
  expect(Schema.decodeUnknownSync(CustomerCurrencyPreferenceChangeResultSchema)(result)).toEqual({
    changed: false,
    current,
    previousCurrencyCode: 'CZK',
  });
});

it('preserves a monotonic revision when a preference is cleared', () => {
  const result = decideCustomerCurrencyPreferenceChange({
    command: {
      authorizationSubject: retailAuthorization,
      change: { kind: 'CLEAR' },
      expectedRevision: 4,
      profileRef,
    },
    current: snapshot('EUR', 4),
    recognizedCurrencies: ['CZK', 'EUR'],
  });
  const changed = Schema.decodeUnknownSync(CustomerCurrencyPreferenceChangeResultSchema)(result);
  expect(changed.current).toEqual({ profileRef, revision: 5, state: 'ABSENT' });
});

it('rejects a preference code missing from the recognized catalog', () => {
  const result = decideCustomerCurrencyPreferenceChange({
    command: {
      authorizationSubject: retailAuthorization,
      change: { currencyCode: 'EUR', kind: 'SET' },
      expectedRevision: 0,
      profileRef,
    },
    current: { profileRef, revision: 0, state: 'ABSENT' },
    recognizedCurrencies: ['CZK'],
  });
  expect(Schema.is(CustomerCurrencyCodeUnrecognized)(result)).toBe(true);
});

it('fails closed when persistence returns the wrong value or next revision', () => {
  const current = snapshot('CZK', 4);
  const result = decideCustomerCurrencyPreferenceChange({
    command: {
      authorizationSubject: retailAuthorization,
      change: { currencyCode: 'EUR', kind: 'SET' },
      expectedRevision: 4,
      profileRef,
    },
    current,
    nextPreference: preference('CZK', 6),
    recognizedCurrencies: ['CZK', 'EUR'],
  });
  expect(Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(result)).toBe(true);
});

it('uses an exact safe currency-preference outbox contract', () => {
  const payload = {
    currentCurrencyCode: 'EUR',
    preferenceRevision: 2,
    previousCurrencyCode: 'CZK',
    profileRef,
  } as const;
  expect(Schema.is(CurrencyPreferenceChangedOutboxPayloadSchema)(payload)).toBe(true);
  expect(Schema.is(CurrencyPreferenceChangedOutboxPayloadSchema)({ data: payload })).toBe(false);
  expect(createCurrencyPreferenceChangedOutboxMessage(payload)).toEqual({
    payloadJson: payload,
    producerModuleKey: 'commerce.customer-context',
    topic: 'commerce.customer-context.currency-preference-changed.v1',
  });
});

it.effect('attaches one outbox message only for a material preference change', () =>
  Effect.gen(function* materialPreferenceChange() {
    const command = {
      authorizationSubject: retailAuthorization,
      change: { currencyCode: 'EUR' as const, kind: 'SET' as const },
      expectedRevision: 1,
      profileRef,
    };
    const scope = {
      authMethod: 'system' as const,
      correlationId: 'currency-preference-change',
      legalEntityId: sellingLegalEntityId,
      principalId: '50000000-0000-4000-8000-000000000001',
      tenantId,
    };
    const changedCollector = makeCurrencyPreferenceCollector();
    yield* handleChangeCustomerCurrencyPreference(command, {
      actionInvocationId: '60000000-0000-4000-8000-000000000001',
      addDomainEvent: changedCollector.addDomainEvent,
      addOutboxMessage: changedCollector.addOutboxMessage,
      recordAuditEvidence: changedCollector.recordAuditEvidence,
      recordDataAccess: changedCollector.recordDataAccess,
      scope,
      services: {
        change: () =>
          Effect.succeed({
            recognizedCurrencyCatalogRevision: 'currency-catalog-1',
            result: {
              changed: true,
              current: snapshot('EUR', 2),
              previousCurrencyCode: 'CZK' as const,
            },
          }),
      },
    });
    const changedEvidence = changedCollector.snapshot();
    expect(changedEvidence.domainEvents).toHaveLength(1);
    expect(changedEvidence.outboxMessages).toHaveLength(1);
    expect(changedEvidence.outboxMessages[0]).toMatchObject({
      domainEventIndex: 0,
      message: {
        payloadJson: {
          currentCurrencyCode: 'EUR',
          previousCurrencyCode: 'CZK',
        },
        topic: 'commerce.customer-context.currency-preference-changed.v1',
      },
    });

    const equivalentCollector = makeCurrencyPreferenceCollector();
    yield* handleChangeCustomerCurrencyPreference(command, {
      actionInvocationId: '60000000-0000-4000-8000-000000000002',
      addDomainEvent: equivalentCollector.addDomainEvent,
      addOutboxMessage: equivalentCollector.addOutboxMessage,
      recordAuditEvidence: equivalentCollector.recordAuditEvidence,
      recordDataAccess: equivalentCollector.recordDataAccess,
      scope,
      services: {
        change: () =>
          Effect.succeed({
            recognizedCurrencyCatalogRevision: 'currency-catalog-1',
            result: {
              changed: false,
              current: snapshot('EUR', 2),
              previousCurrencyCode: 'EUR' as const,
            },
          }),
      },
    });
    expect(equivalentCollector.snapshot().domainEvents).toHaveLength(0);
    expect(equivalentCollector.snapshot().outboxMessages).toHaveLength(0);
  }),
);

it.effect('clears a preference without requiring recognized-currency catalog evidence', () =>
  Effect.gen(function* clearWithoutCurrencyCatalog() {
    const collector = makeCurrencyPreferenceCollector();
    const result = yield* handleChangeCustomerCurrencyPreference(
      {
        authorizationSubject: retailAuthorization,
        change: { kind: 'CLEAR' },
        expectedRevision: 2,
        profileRef,
      },
      {
        actionInvocationId: '60000000-0000-4000-8000-000000000003',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'currency-preference-clear',
          legalEntityId: sellingLegalEntityId,
          principalId: '50000000-0000-4000-8000-000000000001',
          tenantId,
        },
        services: {
          change: () =>
            Effect.succeed({
              recognizedCurrencyCatalogRevision: null,
              result: {
                changed: true,
                current: { profileRef, revision: 3, state: 'ABSENT' },
                previousCurrencyCode: 'EUR' as const,
              },
            }),
        },
      },
    );
    expect(result.current.state).toBe('ABSENT');
    expect(
      collector
        .snapshot()
        .dataAccessEvents.some(
          ({ targetResourceType }) => targetResourceType === 'recognized-currency-catalog',
        ),
    ).toBe(false);
  }),
);

it('captures the owner-local persistence adapter in the currency Read runtime factory', () => {
  const readFactory = getReadServiceFactory(customerCurrencyPreferenceReadRead);
  expect(readFactory.toString()).toContain('customerCurrencyPreferencePersistenceForTransaction');
  expect(readFactory.toString()).not.toContain('persistence is not configured');
});

it('resolves explicit choice before preference and default', () => {
  const input = baseResolution();
  const result = Schema.decodeUnknownSync(PurchaseCurrencyResolvedSchema)(
    resolvePurchaseCurrency({
      ...input,
      request: { ...input.request, explicitChoice: 'CZK' },
    }),
  );
  expect(result).toMatchObject({
    currencyCode: 'CZK',
    source: 'EXPLICIT_CHOICE',
  });
});

it('never falls back after an invalid explicit choice', () => {
  const input = baseResolution();
  const result = resolvePurchaseCurrency({
    ...input,
    pricing: { ...pricing, supportedCurrencies: ['CZK'] },
    request: { ...input.request, explicitChoice: 'EUR' },
  });
  expect(Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(result)).toBe(true);
});

it('falls back from an invalid preference without altering its evidence', () => {
  const input = baseResolution();
  const result = Schema.decodeUnknownSync(PurchaseCurrencyResolvedSchema)(
    resolvePurchaseCurrency({
      ...input,
      pricing: { ...pricing, supportedCurrencies: ['CZK'] },
    }),
  );
  expect(result).toMatchObject({
    currencyCode: 'CZK',
    evidence: {
      ignoredPreferenceReason: 'PRICING_UNSUPPORTED',
      preferenceRevision: 7,
    },
    source: 'POLICY_DEFAULT',
  });
});

it("never resolves another profile's preference or a profile preference for a Guest", () => {
  const input = baseResolution();
  const otherProfilePreference = {
    currencyCode: 'EUR' as const,
    profileRef: {
      ...profileRef,
      resourceId: '10000000-0000-4000-8000-000000000099',
    },
    revision: 7,
  };
  expect(
    Schema.is(InconsistentPurchaseCurrencyPolicy)(
      resolvePurchaseCurrency({ ...input, preference: otherProfilePreference }),
    ),
  ).toBe(true);
  expect(
    Schema.is(InconsistentPurchaseCurrencyPolicy)(
      resolvePurchaseCurrency({
        ...input,
        request: { ...input.request, subject: guestSubject },
      }),
    ),
  ).toBe(true);
});

it('never selects by technical order when no explicit choice or default exists', () => {
  const input = baseResolution();
  const { preference: _ignoredPreference, ...withoutPreference } = input;
  const result = resolvePurchaseCurrency({
    ...withoutPreference,
    policy: {
      ...policy,
      customerPreferenceEnabled: false,
      defaultCurrency: null,
    },
  });
  expect(Schema.is(NoUsablePurchaseCurrency)(result)).toBe(true);
});

it('keeps currency failures out of HTTP success and exposes typed reason codes', () => {
  const input = baseResolution();
  const success = resolvePurchaseCurrency(input);
  const ineligible = resolvePurchaseCurrency({
    ...input,
    pricing: { ...pricing, supportedCurrencies: ['CZK'] },
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

it('enforces the Akros Launch CZK cutline', () => {
  const request = {
    contextRevision: 'akros-context-1',
    purchasingContext,
    requestedAt: '2026-09-09T10:00:00.000Z',
    subject: guestSubject,
  };
  expect(
    Schema.is(PurchaseCurrencyResolvedSchema)(
      resolvePurchaseCurrency({
        policy: AKROS_LAUNCH_CURRENCY_POLICY,
        pricing: AKROS_LAUNCH_PRICING_CURRENCY_SUPPORT,
        request,
      }),
    ),
  ).toBe(true);
  expect(
    Schema.is(ExplicitPurchaseCurrencyChoiceInvalid)(
      resolvePurchaseCurrency({
        policy: AKROS_LAUNCH_CURRENCY_POLICY,
        pricing: AKROS_LAUNCH_PRICING_CURRENCY_SUPPORT,
        request: { ...request, explicitChoice: 'EUR' },
      }),
    ),
  ).toBe(true);
});

it.effect('resolves currency only from Current injected facts and server observation time', () =>
  Effect.gen(function* authoritativeCurrencyResolution() {
    const input = {
      ...baseResolution().request,
      requestedAt: '2020-01-01T00:00:00.000Z',
    };
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
            policy,
            preference: { currencyCode: 'EUR', profileRef, revision: 7 },
            pricing,
            purchasingContext,
            subject: input.subject,
          });
        },
      },
    });
    expect(suppliedObservedAt).not.toBe(input.requestedAt);
    expect(Schema.is(PurchaseCurrencyResolvedSchema)(response.result)).toBe(true);
    expect(response.result).toMatchObject({
      currencyCode: 'EUR',
      evidence: { requestedAt: suppliedObservedAt },
      source: 'CUSTOMER_PREFERENCE',
    });
  }),
);

it.effect('loads Current profile preference through the production-composed owner service', () =>
  Effect.gen(function* ownerComposedCurrentFacts() {
    const input = baseResolution().request;
    const calls: string[] = [];
    const contextPort = {
      resolveCurrent: () => {
        calls.push('context');
        return Effect.succeed({
          contextRevision: input.contextRevision,
          purchasingContext,
          subject: input.subject,
        });
      },
    };
    const persistence: CustomerCurrencyPreferencePersistence = {
      change: () => Effect.die('not used by purchase currency resolution'),
      findCurrent: ({ authorizationSubject, profileRef: requestedProfileRef }) => {
        calls.push('preference');
        expect(authorizationSubject).toEqual(retailAuthorization);
        expect(requestedProfileRef).toEqual(profileRef);
        return Effect.succeed(snapshot('EUR', 7));
      },
    };
    const policyPort = {
      resolveCurrent: () => {
        calls.push('policy');
        return Effect.succeed(policy);
      },
    };
    const pricingPort = {
      resolveCurrent: () => {
        calls.push('pricing');
        return Effect.succeed(pricing);
      },
    };
    const services = yield* makePurchaseCurrencyResolutionServices({
      persistence,
      scope: {
        legalEntityId: sellingLegalEntityId,
        storefrontId: 'akros-cz',
        tenantId,
      },
    }).pipe(
      Effect.provideService(PurchaseCurrencyPurchasingContextPort, contextPort),
      Effect.provideService(PurchaseCurrencyPolicyPort, policyPort),
      Effect.provideService(PurchaseCurrencyPricingPort, pricingPort),
    );
    const current = yield* services.loadCurrent(input, '2026-09-09T10:00:01.000Z');
    expect(current).toMatchObject({
      preference: { currencyCode: 'EUR', profileRef, revision: 7 },
    });
    expect(calls).toEqual(['context', 'preference', 'policy', 'pricing']);
  }),
);

it.effect(
  'fails closed when owner persistence rejects a Counterparty A/profile B association',
  () =>
    Effect.gen(function* rejectedCrossCounterpartyPreference() {
      const services = yield* makePurchaseCurrencyResolutionServices({
        persistence: {
          change: () => Effect.die('not used by purchase currency resolution'),
          findCurrent: () =>
            Effect.fail(
              CustomerCurrencyPreferencePersistenceUnavailable.make({
                code: 'customer_currency_preference_persistence_unavailable',
                reason: 'The Customer Profile is unavailable in the verified scope',
              }),
            ),
        },
        scope: {
          legalEntityId: sellingLegalEntityId,
          storefrontId: 'akros-cz',
          tenantId,
        },
      }).pipe(
        Effect.provideService(PurchaseCurrencyPurchasingContextPort, {
          resolveCurrent: ({ claimedSubject }) =>
            Effect.succeed({
              contextRevision: 'context-1',
              purchasingContext,
              subject: claimedSubject,
            }),
        }),
        Effect.provideService(PurchaseCurrencyPolicyPort, {
          resolveCurrent: () => Effect.succeed(policy),
        }),
        Effect.provideService(PurchaseCurrencyPricingPort, {
          resolveCurrent: () => Effect.succeed(pricing),
        }),
      );
      const input = {
        ...baseResolution().request,
        subject: {
          authorizationSubject: {
            counterpartyRef,
            kind: 'COUNTERPARTY' as const,
          },
          kind: 'PROFILE' as const,
          profileRef: counterpartyProfileRef,
        },
      };
      const failure = yield* services
        .loadCurrent(input, '2026-09-09T10:00:01.000Z')
        .pipe(Effect.flip);
      expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
      expect(failure.code).toBe('customer_currency_preference_unavailable');
    }),
);

it.effect('fails with typed inconsistency for a caller context that is not Current', () =>
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
            policy: AKROS_LAUNCH_CURRENCY_POLICY,
            pricing: AKROS_LAUNCH_PRICING_CURRENCY_SUPPORT,
            purchasingContext: {
              ...purchasingContext,
              storefrontId: 'unknown-storefront',
            },
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
            policy,
            pricing,
            purchasingContext,
            subject: {
              ...guestSubject,
              guestSessionRef: 'different-current-session',
            },
          }),
      },
    }).pipe(Effect.flip);
    expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(failure)).toBe(true);
  }),
);

it.effect(
  'rejects a Current profile subject with a different Counterparty even when the profile matches',
  () =>
    Effect.gen(function* exactCounterpartyPurchaseSubject() {
      const input = {
        ...baseResolution().request,
        subject: {
          authorizationSubject: {
            counterpartyRef,
            kind: 'COUNTERPARTY' as const,
          },
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
              policy,
              pricing,
              purchasingContext,
              subject: {
                ...input.subject,
                authorizationSubject: {
                  counterpartyRef: {
                    ...counterpartyRef,
                    resourceId: '30000000-0000-4000-8000-000000000099',
                  },
                  kind: 'COUNTERPARTY',
                },
              },
            }),
        },
      }).pipe(Effect.flip);
      expect(Schema.is(InconsistentPurchaseCurrencyPolicy)(failure)).toBe(true);
    }),
);
