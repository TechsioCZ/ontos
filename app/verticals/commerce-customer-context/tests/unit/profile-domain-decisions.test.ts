import { expect, it } from 'effect-rstest';
import {
  RETAIL_PORTAL_PERMISSION_CODES,
  RETAIL_PORTAL_PERMISSION_CATALOG,
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RECONCILIATION_REQUIRED_OWNERS,
} from '../../shared/domain/profile-contracts.ts';
import {
  classifyGenericProfileMutation,
  decideGuestAttribution,
  decideProfileCreateOutcome,
  decideProfileLifecycleTransition,
  decideProfileTradingGate,
  decideReconciliationCompletion,
  decideRetailBindingAuthorizationCurrentness,
  decideRetailPortalAccess,
} from '../../shared/domain/profile-decisions.ts';

const retailProfile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

it('keeps the permission catalog exact and the launch baseline explicit', () => {
  expect(RETAIL_PORTAL_PERMISSION_CATALOG.map(({ code }) => code)).toEqual(
    RETAIL_PORTAL_PERMISSION_CODES,
  );
  expect(RETAIL_PORTAL_SELF_SERVICE_BASELINE).toEqual([
    'retail.profile.read',
    'retail.address_book.use',
    'retail.address_book.manage',
    'retail.history.read',
    'retail.repeat_order',
    'retail.aftercare.read',
    'retail.claim.create',
    'retail.consent.manage',
  ]);
});

it('reuses non-Active profiles without reactivation and gates new Orders', () => {
  expect(
    decideProfileCreateOutcome({ observedState: 'ARCHIVED', profile: retailProfile }).outcome,
  ).toBe('PROFILE_ALREADY_EXISTS_ARCHIVED');
  expect(
    decideProfileTradingGate({
      dependencyAvailable: true,
      reconciliationRequired: false,
      state: 'ARCHIVED',
    }),
  ).toEqual({ canAcceptNewOrder: false, outcome: 'ARCHIVED' });
  expect(
    decideProfileLifecycleTransition({
      currentRevision: 3,
      currentState: 'ARCHIVED',
      dependencyStatus: 'AVAILABLE',
      expectedRevision: 3,
      expectedState: 'ARCHIVED',
      operation: 'REACTIVATE',
      reconciliationRequired: false,
      reconfirmationRequired: true,
    }).outcome,
  ).toBe('REACTIVATION_RECONFIRMATION_REQUIRED');
});

it('requires the exact Active binding, Active authorization, and exact Permission', () => {
  expect(
    decideRetailPortalAccess({
      authorizationOperation: 'grant',
      authorizationState: 'ACTIVE',
      authorizationStatus: 'AVAILABLE',
      bindingState: 'ACTIVE',
      boundProfile: retailProfile,
      grantedPermissions: ['retail.profile.read'],
      requestedPermission: 'retail.history.read',
      requestedProfile: retailProfile,
    }),
  ).toEqual({ allowed: false, outcome: 'PERMISSION_DENIED' });
  expect(
    decideRetailPortalAccess({
      authorizationOperation: 'revoke',
      authorizationState: 'REVOKED',
      authorizationStatus: 'AVAILABLE',
      bindingState: 'REVOKED',
      boundProfile: retailProfile,
      grantedPermissions: ['retail.history.read'],
      requestedPermission: 'retail.history.read',
      requestedProfile: retailProfile,
    }),
  ).toEqual({ allowed: false, outcome: 'BINDING_REVOKED' });
});

it('fails closed while a Retail binding authorization grant is pending or unresolved', () => {
  for (const authorizationState of ['PENDING_GRANT', 'RECONCILIATION_REQUIRED'] as const) {
    expect(
      decideRetailPortalAccess({
        authorizationOperation: 'grant',
        authorizationState,
        authorizationStatus: 'AVAILABLE',
        bindingState: 'ACTIVE',
        boundProfile: retailProfile,
        grantedPermissions: ['retail.profile.read'],
        requestedPermission: 'retail.profile.read',
        requestedProfile: retailProfile,
      }),
    ).toEqual({ allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' });
  }
});

it('treats a pending or unresolved revoke as definitely revoked', () => {
  for (const authorizationState of ['PENDING_REVOKE', 'RECONCILIATION_REQUIRED'] as const) {
    expect(
      decideRetailPortalAccess({
        authorizationOperation: 'revoke',
        authorizationState,
        authorizationStatus: 'INDETERMINATE',
        bindingState: 'ACTIVE',
        boundProfile: retailProfile,
        grantedPermissions: ['retail.profile.read'],
        requestedPermission: 'retail.profile.read',
        requestedProfile: retailProfile,
      }),
    ).toEqual({ allowed: false, outcome: 'BINDING_REVOKED' });
  }
  expect(
    decideRetailBindingAuthorizationCurrentness({
      authorizationOperation: 'grant',
      authorizationState: 'ACTIVE',
      bindingState: 'REVOKED',
    }),
  ).toBe('REVOKED');
});

it('never completes partial reconciliation and ignores older evidence', () => {
  const resolved = RECONCILIATION_REQUIRED_OWNERS.map((owner) => ({
    evidenceRef: `evidence:${owner}`,
    owner,
    status: 'RESOLVED' as const,
  }));
  expect(
    decideReconciliationCompletion({
      caseState: 'READY_TO_COMPLETE',
      eventVersion: 2n,
      lastProcessedEventVersion: 2n,
      ownerOutcomes: resolved.slice(1),
      resultingStateSelected: true,
      survivorSelected: true,
    }).outcome,
  ).toBe('RECONCILIATION_INCOMPLETE');
  expect(
    decideReconciliationCompletion({
      caseState: 'READY_TO_COMPLETE',
      eventVersion: 1n,
      lastProcessedEventVersion: 2n,
      ownerOutcomes: resolved,
      resultingStateSelected: true,
      survivorSelected: true,
    }).outcome,
  ).toBe('OUT_OF_ORDER_EVENT');
});

it('keeps Guest attribution fail-closed and never grants portal access', () => {
  const partyRef = {
    moduleId: 'party.registry',
    resourceId: 'party-1',
    resourceType: 'party.registry.party',
    tenantId: retailProfile.tenantId,
  } as const;
  expect(
    decideGuestAttribution({
      partyResolution: { outcome: 'EXISTING_PARTY_RESOLVED', partyRef },
      profileOutcome: { outcome: 'PROFILE_CREATED', profile: retailProfile },
    }),
  ).toEqual({
    canAcceptOrder: true,
    outcome: 'ATTRIBUTION_COMPLETED',
    partyRef,
    portalAccessGranted: false,
    profile: retailProfile,
  });
  expect(
    decideGuestAttribution({ partyResolution: { caseRef: 'case-1', outcome: 'AMBIGUOUS_MATCH' } }),
  ).toEqual({ canAcceptOrder: false, outcome: 'AMBIGUOUS_MATCH', portalAccessGranted: false });
});

it('classifies every accidental generic profile mutation without creating an endpoint', () => {
  expect(classifyGenericProfileMutation('PROFILE_SUBJECT')).toBe('IMMUTABLE_PROFILE_SUBJECT');
  expect(classifyGenericProfileMutation('LIFECYCLE')).toBe('LIFECYCLE_ACTION_REQUIRED');
  expect(classifyGenericProfileMutation('GENERIC')).toBe('GENERIC_PROFILE_UPDATE_NOT_SUPPORTED');
});
