import { ReadHandlerUnavailable } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import {
  CustomerProfileReadRequestSchema,
  CustomerProfileReadResponseSchema,
} from '../../shared/apis/customer-profile-read.ts';
import {
  CustomerProfileTradingGateRequestSchema,
  CustomerProfileTradingGateResponseSchema,
} from '../../shared/apis/customer-profile-trading-gate.ts';
import {
  GuestAttributionStatusRequestSchema,
  GuestAttributionStatusResponseSchema,
} from '../../shared/apis/guest-attribution-status.ts';
import { ProfileReconciliationReadRequestSchema } from '../../shared/apis/profile-reconciliation-read.ts';
import { RetailAccessDecisionRequestSchema } from '../../shared/apis/retail-access-decision.ts';
import { RetailPortalProfileBindingReadRequestSchema } from '../../shared/apis/retail-portal-profile-binding-read.ts';
import { RetailPrincipalResolutionRequestSchema } from '../../shared/apis/retail-principal-resolution.ts';
import { ProfileReconciliationCaseRefSchema } from '../../shared/resources/profile-reconciliation-case.ts';
import {
  customerProfileReadPermissionTarget,
  readCustomerProfileFromServices,
} from '../../src/api/customer-profile-read.read.ts';
import { customerProfileTradingGatePermissionTarget } from '../../src/api/customer-profile-trading-gate.read.ts';
import { profileReconciliationReadPermissionTarget } from '../../src/api/profile-reconciliation-read.read.ts';
import {
  decideRetailAccessFromCurrentOwnerSnapshot,
  retailAccessDecisionPermissionTarget,
  retailAccessDecisionServicesUnavailable,
} from '../../src/api/retail-access-decision.read.ts';
import {
  retailPortalProfileBindingReadPermissionTarget,
  retailPortalProfileBindingReadServicesUnavailable,
} from '../../src/api/retail-portal-profile-binding-read.read.ts';
import {
  resolveRetailPrincipalFromServices,
  retailPrincipalResolutionPermissionTarget,
  retailPrincipalResolutionServicesUnavailable,
} from '../../src/api/retail-principal-resolution.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const legalEntityId = '44444444-4444-4444-8444-444444444444';

const retailProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const taggedRetailProfileRef = { ...retailProfileRef, kind: 'RETAIL' as const };
const counterpartyProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const taggedCounterpartyProfileRef = {
  ...counterpartyProfileRef,
  kind: 'COUNTERPARTY' as const,
};
const bindingRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'binding-1',
  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
  tenantId,
} as const;
const reconciliationCaseRef = Schema.decodeUnknownSync(ProfileReconciliationCaseRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: 'case-1',
  resourceType: 'commerce.customer-context.profile-reconciliation-case',
  tenantId,
});
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: 'selling-legal-entity-1',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const retailSubject = { kind: 'RETAIL', partyRef, sellingLegalEntityRef } as const;
const counterpartySubject = { counterpartyRef, kind: 'COUNTERPARTY' } as const;
const provenance = [
  {
    freshness: {
      observedAt: '2026-09-09T10:00:00.000Z',
      revision: 'profile-revision-1',
      sourceModuleId: 'commerce.customer-context',
      status: 'CURRENT',
    },
    projection: 'PROFILE',
    sourceResourceRef: 'retail-profile-1',
  },
] as const;

const unavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Test dependency unavailable',
  });

it.effect('profile API requests require concrete profile, binding, case, and Permission identity', () =>
  Effect.gen(function* profileApiRequestContracts() {
    expect(
      (yield* Schema.decodeUnknownEffect(CustomerProfileReadRequestSchema)({
        authorizationSubject: counterpartySubject,
        profileRef: taggedCounterpartyProfileRef,
      })).profileRef.resourceType,
    ).toBe('commerce.customer-context.counterparty-purchasing-profile');
    expect(
      (yield* Schema.decodeUnknownEffect(CustomerProfileTradingGateRequestSchema)({
        authorizationSubject: retailSubject,
        profileRef: taggedRetailProfileRef,
      })).profileRef.resourceType,
    ).toBe('commerce.customer-context.retail-customer-profile');
    expect(
      (yield* Schema.decodeUnknownEffect(RetailAccessDecisionRequestSchema)({
        profileRef: retailProfileRef,
        requiredPermission: 'retail.profile.read',
      })).requiredPermission,
    ).toBe('retail.profile.read');
    expect(
      (yield* Schema.decodeUnknownEffect(RetailPortalProfileBindingReadRequestSchema)({
        bindingRef,
        profileRef: retailProfileRef,
      })).bindingRef,
    ).toEqual(bindingRef);
    expect(
      (yield* Schema.decodeUnknownEffect(ProfileReconciliationReadRequestSchema)({
        reconciliationCaseRef,
      })).reconciliationCaseRef,
    ).toEqual(reconciliationCaseRef);
    expect(
      (yield* Schema.decodeUnknownEffect(RetailPrincipalResolutionRequestSchema)({
        profileRef: retailProfileRef,
      })).profileRef,
    ).toEqual(retailProfileRef);
    expect(
      (yield* Schema.decodeUnknownEffect(GuestAttributionStatusRequestSchema)({
        attributionCorrelationId: 'checkout-1',
        sellingLegalEntityRef,
      })).sellingLegalEntityRef,
    ).toEqual(sellingLegalEntityRef);
  }),
);

it.effect('profile reads expose fail-closed reconciliation, trading, and Guest dependency outcomes', () =>
  Effect.gen(function* profileApiResponseContracts() {
    const profileRead = yield* Schema.decodeUnknownEffect(CustomerProfileReadResponseSchema)({
      _tag: 'PROFILE_RECONCILIATION_REQUIRED',
      profileRef: taggedRetailProfileRef,
      provenance,
      reconciliationCaseRef,
      targetSubject: retailSubject,
    });
    expect(
      Match.value(profileRead).pipe(
        Match.tag('PROFILE_RECONCILIATION_REQUIRED', () => true),
        Match.tag('PROFILE_AVAILABLE', () => false),
        Match.exhaustive,
      ),
    ).toBe(true);

    const tradingGate = yield* Schema.decodeUnknownEffect(CustomerProfileTradingGateResponseSchema)({
      evaluatedAt: '2026-09-09T10:00:00.000Z',
      gate: { canAcceptNewOrder: false, outcome: 'SUSPENDED' },
      profileRef: taggedRetailProfileRef,
      provenance,
      revision: 3,
      state: 'SUSPENDED',
      subject: retailSubject,
    });
    expect(tradingGate.gate.canAcceptNewOrder).toBe(false);

    const guestStatus = yield* Schema.decodeUnknownEffect(GuestAttributionStatusResponseSchema)({
      attributionCorrelationId: 'checkout-1',
      observedAt: '2026-09-09T10:00:00.000Z',
      outcome: {
        canAcceptOrder: false,
        outcome: 'PARTY_RESOLUTION_UNAVAILABLE',
        portalAccessGranted: false,
      },
      partyFreshness: {
        observedAt: '2026-09-09T10:00:00.000Z',
        sourceModuleId: 'party.registry',
        status: 'UNAVAILABLE',
      },
      partyRef: null,
      profileRef: null,
      provenance,
      sellingLegalEntityRef,
    });
    expect(guestStatus.outcome.canAcceptOrder).toBe(false);
  }),
);

it('targets the exact requested owner business Permission, never broad module authority', () => {
  const expectedProfileTarget = {
    businessPermission: {
      permission: 'retail.profile.read',
      target: {
        kind: 'retail_profile',
        legalEntityId,
        profileId: retailProfileRef.resourceId,
        tenantId,
      },
    },
    kind: 'business_permission',
  };
  const scope = {
    authBindingId: '55555555-5555-4555-8555-555555555555',
    authContextRef: 'better-auth-session:profile-api-test',
    authMethod: 'session' as const,
    correlationId: 'profile-api-test',
    legalEntityId,
    principalId,
    tenantId,
  };
  expect(
    customerProfileReadPermissionTarget(
      { authorizationSubject: retailSubject, profileRef: taggedRetailProfileRef },
      scope,
    ),
  ).toEqual(expectedProfileTarget);
  expect(
    customerProfileTradingGatePermissionTarget(
      { authorizationSubject: retailSubject, profileRef: taggedRetailProfileRef },
      scope,
    ),
  ).toEqual(expectedProfileTarget);
  expect(
    customerProfileTradingGatePermissionTarget(
      {
        authorizationSubject: counterpartySubject,
        profileRef: taggedCounterpartyProfileRef,
      },
      scope,
    ),
  ).toEqual({
    businessPermission: {
      permission: 'counterparty.purchase.submit',
      target: { counterpartyId: 'counterparty-1', kind: 'counterparty', legalEntityId, tenantId },
    },
    kind: 'business_permission',
  });
  expect(
    customerProfileReadPermissionTarget(
      {
        authorizationSubject: counterpartySubject,
        profileRef: taggedCounterpartyProfileRef,
      },
      scope,
    ),
  ).toEqual({
    businessPermission: {
      permission: 'counterparty.profile.read',
      target: { counterpartyId: 'counterparty-1', kind: 'counterparty', legalEntityId, tenantId },
    },
    kind: 'business_permission',
  });
  expect(
    retailAccessDecisionPermissionTarget(
      {
        profileRef: retailProfileRef,
        requiredPermission: 'retail.profile.read',
      },
      scope,
    ),
  ).toEqual({
    businessPermission: {
      permission: 'retail.profile.read',
      target: {
        kind: 'retail_profile',
        legalEntityId,
        profileId: retailProfileRef.resourceId,
        tenantId,
      },
    },
    kind: 'business_permission',
  });
  expect(retailPrincipalResolutionPermissionTarget({ profileRef: retailProfileRef }, scope)).toEqual(
    expectedProfileTarget,
  );
  expect(retailPortalProfileBindingReadPermissionTarget({ bindingRef, profileRef: retailProfileRef }, scope)).toEqual(
    expectedProfileTarget,
  );
  expect(profileReconciliationReadPermissionTarget({ reconciliationCaseRef })).toEqual({
    kind: 'resource',
    resource: {
      moduleId: reconciliationCaseRef.moduleId,
      resourceId: reconciliationCaseRef.resourceId,
      resourceType: reconciliationCaseRef.resourceType,
    },
  });
});

it.effect('fails closed before invoking profile services for a cross-Tenant ResourceRef', () =>
  Effect.gen(function* crossTenantProfileRead() {
    let invoked = false;
    const error = yield* Effect.flip(
      readCustomerProfileFromServices(
        {
          authorizationSubject: retailSubject,
          profileRef: { ...taggedRetailProfileRef, tenantId: otherTenantId },
        },
        tenantId,
        legalEntityId,
        {
          readProfile: () =>
            Effect.sync(() => {
              invoked = true;
            }).pipe(Effect.flatMap(() => Effect.fail(unavailable()))),
        },
      ),
    );
    expect(invoked).toBe(false);
    expect(Predicate.isTagged(error, 'ReadHandlerNotFound')).toBe(true);
  }),
);

it.effect('fails closed when the authorized subject does not match the durable profile', () =>
  Effect.gen(function* profileSubjectConfusedDeputy() {
    const error = yield* Effect.flip(
      readCustomerProfileFromServices(
        { authorizationSubject: retailSubject, profileRef: taggedRetailProfileRef },
        tenantId,
        legalEntityId,
        {
          readProfile: () =>
            Effect.succeed({
              _tag: 'PROFILE_AVAILABLE' as const,
              completeness: 'PARTIAL' as const,
              profile: {
                createdAt: '2026-09-09T10:00:00.000Z',
                kind: 'RETAIL' as const,
                profileRef: retailProfileRef,
                revision: 1,
                state: 'ACTIVE' as const,
                stateChangedAt: '2026-09-09T10:00:00.000Z',
                subject: {
                  ...retailSubject,
                  partyRef: { ...partyRef, resourceId: 'different-party' },
                },
                updatedAt: '2026-09-09T10:00:00.000Z',
              },
              provenance,
              unavailableSections: ['PARTY_IDENTITY'] as const,
            }),
        },
      ),
    );
    expect(Predicate.isTagged(error, 'ReadHandlerNotFound')).toBe(true);
  }),
);

it.effect('derives the Retail Principal exclusively from trusted governed-read scope', () =>
  Effect.gen(function* principalResolutionScope() {
    let observedPrincipalId: string | undefined;
    const error = yield* Effect.flip(
      resolveRetailPrincipalFromServices({ profileRef: retailProfileRef }, principalId, tenantId, {
        resolvePrincipal: (_input, trustedPrincipalId) => {
          observedPrincipalId = trustedPrincipalId;
          return Effect.fail(unavailable());
        },
      }),
    );
    expect(observedPrincipalId).toBe(principalId);
    expect(Predicate.isTagged(error, 'ReadHandlerUnavailable')).toBe(true);
  }),
);

const currentAuthorizationFreshness = {
  observedAt: '2026-09-09T10:00:00.000Z',
  revision: 'authorization-1',
  sourceModuleId: 'core.identity',
  status: 'CURRENT',
} as const;

it('allows Retail access only when the owner snapshot has an Active binding and authorization', () => {
  const result = decideRetailAccessFromCurrentOwnerSnapshot(
    { profileRef: retailProfileRef, requiredPermission: 'retail.profile.read' },
    {
      authorizationFreshness: currentAuthorizationFreshness,
      authorizationOperation: 'grant',
      authorizationState: 'ACTIVE',
      bindingRef,
      bindingState: 'ACTIVE',
      grantedPermissions: ['retail.profile.read'],
      profileRef: retailProfileRef,
      provenance,
    },
  );

  expect(result.decision).toEqual({ allowed: true, outcome: 'ALLOWED' });
  expect(result.bindingRef).toEqual(Option.some(bindingRef));
  expect(result.bindingState).toEqual(Option.some('ACTIVE'));
});

it('does not authorize an Active binding while the owner authorization is pending', () => {
  const result = decideRetailAccessFromCurrentOwnerSnapshot(
    { profileRef: retailProfileRef, requiredPermission: 'retail.profile.read' },
    {
      authorizationFreshness: currentAuthorizationFreshness,
      authorizationOperation: 'grant',
      authorizationState: 'PENDING_GRANT',
      bindingRef,
      bindingState: 'ACTIVE',
      grantedPermissions: ['retail.profile.read'],
      profileRef: retailProfileRef,
      provenance,
    },
  );

  expect(result.decision).toEqual({ allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' });
});

it('treats a pending owner revoke as revoked even while stale permission facts look Current', () => {
  const result = decideRetailAccessFromCurrentOwnerSnapshot(
    { profileRef: retailProfileRef, requiredPermission: 'retail.profile.read' },
    {
      authorizationFreshness: currentAuthorizationFreshness,
      authorizationOperation: 'revoke',
      authorizationState: 'PENDING_REVOKE',
      bindingRef,
      bindingState: 'ACTIVE',
      grantedPermissions: ['retail.profile.read'],
      profileRef: retailProfileRef,
      provenance,
    },
  );

  expect(result.decision).toEqual({ allowed: false, outcome: 'BINDING_REVOKED' });
});

it.effect('keeps every Retail binding-dependent production read unavailable without owner state', () =>
  Effect.gen(function* unavailableRetailOwnerState() {
    const errors = yield* Effect.all([
      Effect.flip(
        retailAccessDecisionServicesUnavailable().decideAccess(
          { profileRef: retailProfileRef, requiredPermission: 'retail.profile.read' },
          principalId,
          tenantId,
        ),
      ),
      Effect.flip(
        retailPrincipalResolutionServicesUnavailable().resolvePrincipal(
          { profileRef: retailProfileRef },
          principalId,
          tenantId,
        ),
      ),
      Effect.flip(
        retailPortalProfileBindingReadServicesUnavailable().readBinding(
          { bindingRef, profileRef: retailProfileRef },
          principalId,
          tenantId,
        ),
      ),
    ]);

    expect(errors.every((error) => Predicate.isTagged(error, 'ReadHandlerUnavailable'))).toBe(true);
  }),
);
