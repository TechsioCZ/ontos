import { expect, it } from 'effect-rstest';
import { Predicate } from 'effect';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { changeCustomerPaymentTermsAction } from '../../src/actions/change-customer-payment-terms.action.ts';
import { removeCustomerPaymentTermAction } from '../../src/actions/remove-customer-payment-term.action.ts';
import { customerPaymentTermEntitlementReadPermissionTarget } from '../../src/api/customer-payment-term-entitlement-read.read.ts';
import { paymentTermsResolutionPermissionTarget } from '../../src/api/payment-terms-resolution.read.ts';
import {
  changeCustomerPaymentTerms,
  projectCustomerPaymentTermsAt,
  removeCustomerPaymentTerm,
  resolveCustomerCommercePaymentTermsPolicy,
  resolvePaymentTerms,
} from '../../shared/domain/payment-terms.ts';
import type {
  CustomerPaymentTermsState,
  PaymentTermDefinitionSnapshot,
  PaymentTermReference,
} from '../../shared/domain/payment-term-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const profileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const counterpartyProfileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
  tenantId,
};
const entitlementRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.customer-context.customer-payment-term-entitlement' as const,
  tenantId,
};

const paymentTermRef = (resourceId: string): PaymentTermReference => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});

const immediate = (
  resourceId: string,
  overrides: Partial<PaymentTermDefinitionSnapshot> = {},
): PaymentTermDefinitionSnapshot => ({
  code: `TERM-${resourceId}`,
  compatibilityId: 'immediate.v1',
  compatibleWith: ['customer-payment-terms.v1'],
  definitionRevisionId: '88888888-8888-4888-8888-888888888888',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Immediate',
  paymentTermRef: paymentTermRef(resourceId),
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: resourceId,
  semantics: {
    calculationRuleVersion: 1,
    calendarRule: 'NOT_APPLICABLE',
    kind: 'IMMEDIATE',
  },
  ...overrides,
});

const emptyState = (): CustomerPaymentTermsState => ({
  entitlements: [],
  preferences: [],
  profileRef,
  revision: 1,
});

const expectTag = (value: { readonly _tag: string }, tag: string): void => {
  expect(Predicate.isTagged(value, tag)).toBe(true);
};

it('keeps both Counterparty mutations fail-closed behind the exact settings permission', () => {
  for (const action of [changeCustomerPaymentTermsAction, removeCustomerPaymentTermAction]) {
    expect(action.descriptor.idempotency).toBe('required');
    expect(action.descriptor.legalEntityScope).toBe('required');
    expect(action.descriptor.businessPermission?.kind).toBe('business_permission');
    expect(action.descriptor.auditEvidenceSchema).toBeDefined();
    expect(action.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
  }

  const permission = getActionBusinessPermissionTargetResolver(changeCustomerPaymentTermsAction)?.(
    {
      changes: [{ _tag: 'CLEAR_PREFERENCE', effectiveAt: '2026-01-01T00:00:00.000Z' }],
      counterpartyRef,
      expectedRevision: 1,
      profileRef: counterpartyProfileRef,
      reason: 'Customer request',
    },
    {
      authMethod: 'system',
      correlationId: 'payment-terms-permission',
      legalEntityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      principalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      tenantId,
    },
  );
  expect(permission).toMatchObject({
    permission: 'counterparty.settings.payment_terms.manage',
    target: { counterpartyId: counterpartyRef.resourceId, kind: 'counterparty' },
  });
});

it('resolves exact Retail and Counterparty read permissions from the public subject', () => {
  const scope = {
    legalEntityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  };
  expect(
    customerPaymentTermEntitlementReadPermissionTarget(
      {
        asOf: '2026-01-01T00:00:00.000Z',
        authorizationSubject: { kind: 'RETAIL' },
        includeHistorical: false,
        profileRef,
      },
      scope,
    ),
  ).toMatchObject({ businessPermission: { permission: 'retail.profile.read' } });
  expect(
    paymentTermsResolutionPermissionTarget(
      {
        at: '2026-01-01T00:00:00.000Z',
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
        profileRef: counterpartyProfileRef,
        purchasingContext: {
          channelId: 'web',
          contextRevision: 'context-1',
          marketId: 'cz',
          sellingLegalEntityId: scope.legalEntityId,
          storefrontId: 'main',
        },
      },
      scope,
    ),
  ).toMatchObject({ businessPermission: { permission: 'counterparty.profile.read' } });
});

it('grants a future entitlement and preference without making either current early', () => {
  const term = immediate('44444444-4444-4444-8444-444444444444');
  const changed = changeCustomerPaymentTerms({
    catalogDefinitions: [term],
    changes: [
      {
        _tag: 'GRANT_ENTITLEMENT',
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
      },
      {
        _tag: 'SET_PREFERENCE',
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        paymentTermRef: term.paymentTermRef,
      },
    ],
    expectedRevision: 1,
    state: emptyState(),
  });

  expectTag(changed, 'CHANGED');
  if (!Predicate.isTagged(changed, 'CHANGED')) {
    return;
  }
  expect(changed.state.revision).toBe(2);
  expectTag(
    resolvePaymentTerms({
      at: '2026-12-31T23:59:59.000Z',
      definitions: [term],
      eligiblePaymentTermRefs: [term.paymentTermRef],
      policyExplicitlyPermittedRefs: [],
      policyFallbackRefs: [],
      policyRevision: 'policy-revision-1',
      policySource: 'customer-commerce-policy',
      purchasingContextRevision: 'context-revision-1',
      state: changed.state,
    }),
    'NO_USABLE_PAYMENT_TERM',
  );
  expectTag(
    resolvePaymentTerms({
      at: '2027-01-01T00:00:00.000Z',
      definitions: [term],
      eligiblePaymentTermRefs: [term.paymentTermRef],
      policyExplicitlyPermittedRefs: [],
      policyFallbackRefs: [],
      policyRevision: 'policy-revision-1',
      policySource: 'customer-commerce-policy',
      purchasingContextRevision: 'context-revision-1',
      state: changed.state,
    }),
    'PREFERRED_ENTITLEMENT',
  );
});

it('rejects overlapping periods for the same profile and term', () => {
  const term = immediate('44444444-4444-4444-8444-444444444444');
  const first = changeCustomerPaymentTerms({
    catalogDefinitions: [term],
    changes: [
      {
        _tag: 'GRANT_ENTITLEMENT',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
      },
    ],
    expectedRevision: 1,
    state: emptyState(),
  });
  expectTag(first, 'CHANGED');
  if (!Predicate.isTagged(first, 'CHANGED')) {
    return;
  }

  const overlapping = changeCustomerPaymentTerms({
    catalogDefinitions: [term],
    changes: [
      {
        _tag: 'GRANT_ENTITLEMENT',
        effectiveFrom: '2026-06-30T00:00:00.000Z',
        entitlementRef: { ...entitlementRef, resourceId: '55555555-5555-4555-8555-555555555555' },
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
      },
    ],
    expectedRevision: 2,
    state: first.state,
  });
  expectTag(overlapping, 'ENTITLEMENT_OVERLAP');
});

it('rejects an entitlement absent from the current canonical catalog', () => {
  const term = immediate('44444444-4444-4444-8444-444444444444');
  const outcome = changeCustomerPaymentTerms({
    catalogDefinitions: [],
    changes: [
      {
        _tag: 'GRANT_ENTITLEMENT',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
      },
    ],
    expectedRevision: 1,
    state: emptyState(),
  });
  expectTag(outcome, 'PAYMENT_TERM_UNUSABLE');
  if (Predicate.isTagged(outcome, 'PAYMENT_TERM_UNUSABLE')) {
    expect(outcome.reason).toBe('MISSING_DEFINITION');
  }
});

it('ends a current entitlement, clears its preference, and treats the same removal as idempotent', () => {
  const term = immediate('44444444-4444-4444-8444-444444444444');
  const state: CustomerPaymentTermsState = {
    entitlements: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
        status: 'ACTIVE',
      },
    ],
    preferences: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        paymentTermRef: term.paymentTermRef,
      },
    ],
    profileRef,
    revision: 4,
  };
  const removed = removeCustomerPaymentTerm({
    effectiveAt: '2026-06-01T00:00:00.000Z',
    entitlementRef,
    expectedRevision: 4,
    state,
  });
  expectTag(removed, 'REMOVED');
  if (!Predicate.isTagged(removed, 'REMOVED')) {
    return;
  }
  expect(removed.removalKind).toBe('ENDED');
  expect(removed.preferenceCleared).toBe(true);
  expect(removed.state.preferences[0]?.effectiveTo).toBe('2026-06-01T00:00:00.000Z');

  const repeated = removeCustomerPaymentTerm({
    effectiveAt: '2026-06-01T00:00:00.000Z',
    entitlementRef,
    expectedRevision: 5,
    state: removed.state,
  });
  expectTag(repeated, 'REMOVED');
  if (Predicate.isTagged(repeated, 'REMOVED')) {
    expect(repeated.changed).toBe(false);
  }
});

it('cancels a never-effective future entitlement instead of recording effective history', () => {
  const term = immediate('44444444-4444-4444-8444-444444444444');
  const state: CustomerPaymentTermsState = {
    ...emptyState(),
    entitlements: [
      {
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
        status: 'ACTIVE',
      },
    ],
  };
  const removed = removeCustomerPaymentTerm({
    effectiveAt: '2026-06-01T00:00:00.000Z',
    entitlementRef,
    expectedRevision: 1,
    state,
  });
  expectTag(removed, 'REMOVED');
  if (!Predicate.isTagged(removed, 'REMOVED')) {
    return;
  }
  expect(removed.removalKind).toBe('CANCELLED');
  expect(removed.state.entitlements[0]?.status).toBe('CANCELLED');
});

it('projects half-open current state and excludes cancelled schedules from effective history', () => {
  const term = immediate('44444444-4444-4444-8444-444444444444');
  const state: CustomerPaymentTermsState = {
    entitlements: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-06-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
        status: 'ACTIVE',
      },
      {
        cancelledAt: '2026-01-15T00:00:00.000Z',
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        entitlementRef: {
          ...entitlementRef,
          resourceId: '55555555-5555-4555-8555-555555555555',
        },
        paymentTermRef: term.paymentTermRef,
        semanticRevisionId: term.semanticRevisionId,
        status: 'CANCELLED',
      },
    ],
    preferences: [],
    profileRef,
    revision: 2,
  };

  const beforeEnd = projectCustomerPaymentTermsAt(state, '2026-05-31T23:59:59.999Z', false);
  expect(beforeEnd.currentEntitlements).toHaveLength(1);
  expect(projectCustomerPaymentTermsAt(state, '2026-06-01T00:00:00.000Z', false).currentEntitlements).toHaveLength(0);
  expect(projectCustomerPaymentTermsAt(state, '2027-02-01T00:00:00.000Z', true).state.entitlements).toHaveLength(1);
});

it('implements explicit, preferred, fallback, invalid, broken, missing, and inconsistent outcomes', () => {
  const entitled = immediate('44444444-4444-4444-8444-444444444444');
  const fallback = immediate('66666666-6666-4666-8666-666666666666');
  const other = immediate('77777777-7777-4777-8777-777777777777');
  const state: CustomerPaymentTermsState = {
    entitlements: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: entitled.paymentTermRef,
        semanticRevisionId: entitled.semanticRevisionId,
        status: 'ACTIVE',
      },
    ],
    preferences: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        paymentTermRef: entitled.paymentTermRef,
      },
    ],
    profileRef,
    revision: 1,
  };
  const policy = resolveCustomerCommercePaymentTermsPolicy(
    {
      configurationRevision: 'policy-config-1',
      policySource: 'customer-commerce-policy:launch-config',
      rules: [
        {
          audience: 'PROFILE',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          eligiblePaymentTermRefs: [entitled.paymentTermRef, fallback.paymentTermRef, other.paymentTermRef],
          explicitlyPermittedPaymentTermRefs: [],
          fallbackPaymentTermRefs: [fallback.paymentTermRef],
          policyRevision: 'policy-revision-1',
          scope: {
            channelId: 'b2b-web',
            marketId: 'cz',
            sellingLegalEntityId: '99999999-9999-4999-8999-999999999999',
            storefrontId: 'akros-b2b',
            tenantId,
          },
        },
      ],
    },
    {
      at: '2026-06-01T00:00:00.000Z',
      audience: 'PROFILE',
      purchasingContext: {
        channelId: 'b2b-web',
        marketId: 'cz',
        sellingLegalEntityId: '99999999-9999-4999-8999-999999999999',
        storefrontId: 'akros-b2b',
      },
      tenantId,
      trustedStorefrontId: 'akros-b2b',
    },
  );
  if (Predicate.isTagged(policy, 'INCONSISTENT_CONFIGURATION')) {
    throw new Error(`Expected a resolved launch policy, received ${policy.reason}`);
  }
  const base = {
    at: '2026-06-01T00:00:00.000Z',
    definitions: [entitled, fallback, other],
    eligiblePaymentTermRefs: policy.eligiblePaymentTermRefs,
    policyExplicitlyPermittedRefs: policy.explicitlyPermittedPaymentTermRefs,
    policyRevision: policy.policyRevision,
    policySource: policy.policySource,
    purchasingContextRevision: 'context-revision-1',
    state,
  };

  expectTag(
    resolvePaymentTerms({
      ...base,
      explicitChoice: entitled.paymentTermRef,
      policyFallbackRefs: [],
    }),
    'EXPLICIT_CHOICE',
  );
  expectTag(resolvePaymentTerms({ ...base, policyFallbackRefs: [] }), 'PREFERRED_ENTITLEMENT');
  expectTag(
    resolvePaymentTerms({
      ...base,
      explicitChoice: other.paymentTermRef,
      policyFallbackRefs: [fallback.paymentTermRef],
    }),
    'EXPLICIT_CHOICE_INVALID',
  );
  expectTag(
    resolvePaymentTerms({
      ...base,
      eligiblePaymentTermRefs: [fallback.paymentTermRef],
      policyFallbackRefs: [fallback.paymentTermRef],
    }),
    'POLICY_FALLBACK',
  );
  expectTag(
    resolvePaymentTerms({
      ...base,
      definitions: [fallback],
      policyFallbackRefs: [fallback.paymentTermRef],
    }),
    'BROKEN_ENTITLEMENT',
  );
  expectTag(
    resolvePaymentTerms({
      ...base,
      eligiblePaymentTermRefs: [],
      policyFallbackRefs: [],
    }),
    'NO_USABLE_PAYMENT_TERM',
  );
  expectTag(
    resolvePaymentTerms({
      ...base,
      eligiblePaymentTermRefs: [fallback.paymentTermRef, other.paymentTermRef],
      policyFallbackRefs: [fallback.paymentTermRef, other.paymentTermRef],
    }),
    'INCONSISTENT_CONFIGURATION',
  );
});

it('honors a valid explicit choice before reporting an unrelated broken entitlement', () => {
  const entitled = immediate('44444444-4444-4444-8444-444444444444');
  const missing = immediate('66666666-6666-4666-8666-666666666666');
  const state: CustomerPaymentTermsState = {
    entitlements: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        entitlementRef,
        paymentTermRef: entitled.paymentTermRef,
        semanticRevisionId: entitled.semanticRevisionId,
        status: 'ACTIVE',
      },
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        entitlementRef: {
          ...entitlementRef,
          resourceId: '99999999-9999-4999-8999-999999999999',
        },
        paymentTermRef: missing.paymentTermRef,
        semanticRevisionId: missing.semanticRevisionId,
        status: 'ACTIVE',
      },
    ],
    preferences: [],
    profileRef,
    revision: 1,
  };

  expectTag(
    resolvePaymentTerms({
      at: '2026-06-01T00:00:00.000Z',
      definitions: [entitled],
      eligiblePaymentTermRefs: [entitled.paymentTermRef],
      explicitChoice: entitled.paymentTermRef,
      policyExplicitlyPermittedRefs: [],
      policyFallbackRefs: [],
      policyRevision: 'policy-revision-1',
      policySource: 'customer-commerce-policy',
      purchasingContextRevision: 'context-revision-1',
      state,
    }),
    'EXPLICIT_CHOICE',
  );
});
