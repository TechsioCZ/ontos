import type { AuthorizationMutationState } from '@app/core-runtime';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { Match, Schema } from 'effect';
import type {
  CommerceCustomerProfileState,
  GuestPartyResolutionOutcome,
  ProfileCreateObservedState,
  ProfileLifecycleDecision,
  ProfileLifecycleOperation,
  ReconciliationOwnerOutcome,
  RetailPortalPermissionCode,
} from './profile-contracts.ts';
import { RECONCILIATION_REQUIRED_OWNERS } from './profile-contracts.ts';
import {
  CommerceCounterpartyPurchasingProfileSchema,
  CounterpartyPurchasingProfileRefSchema,
} from '../resources/counterparty-purchasing-profile.ts';
import {
  CommerceRetailCustomerProfileSchema,
  RetailCustomerProfileRefSchema,
} from '../resources/retail-customer-profile.ts';

export const CommerceCustomerProfileRefSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL'), ...RetailCustomerProfileRefSchema.fields }),
  Schema.Struct({
    kind: Schema.Literal('COUNTERPARTY'),
    ...CounterpartyPurchasingProfileRefSchema.fields,
  }),
]);
export type CommerceCustomerProfileRef = typeof CommerceCustomerProfileRefSchema.Type;

export const CommerceCustomerProfileSchema = Schema.Union([
  CommerceRetailCustomerProfileSchema,
  CommerceCounterpartyPurchasingProfileSchema,
]);
export type CommerceCustomerProfile = typeof CommerceCustomerProfileSchema.Type;

const ProfileCreateSuccessSchema = Schema.Struct({
  outcome: Schema.Literals([
    'PROFILE_CREATED',
    'PROFILE_ALREADY_EXISTS_ACTIVE',
    'PROFILE_ALREADY_EXISTS_SUSPENDED',
    'PROFILE_ALREADY_EXISTS_ARCHIVED',
  ]),
  profile: CommerceCustomerProfileRefSchema,
});
const ProfileCreateOutcomeSchema = Schema.Union([
  ProfileCreateSuccessSchema,
  Schema.Struct({
    outcome: Schema.Literals([
      'SUBJECT_NOT_RESOLVED_OR_INVALID',
      'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
      'PROFILE_KIND_OR_SUBJECT_CONFLICT',
      'PROFILE_RECONCILIATION_REQUIRED',
      'CURRENT_STATE_CONFLICT',
    ]),
  }),
  Schema.Struct({
    outcome: Schema.Literals(['SUBJECT_RESOLUTION_UNAVAILABLE', 'PERSISTENCE_UNAVAILABLE', 'COMMIT_INDETERMINATE']),
    retryable: Schema.Literal(true),
  }),
]);
export type ProfileCreateOutcome = typeof ProfileCreateOutcomeSchema.Type;

export const decideProfileCreateOutcome = (input: {
  readonly observedState: ProfileCreateObservedState;
  readonly profile?: CommerceCustomerProfileRef;
}): ProfileCreateOutcome => {
  const success = (
    outcome:
      | 'PROFILE_CREATED'
      | 'PROFILE_ALREADY_EXISTS_ACTIVE'
      | 'PROFILE_ALREADY_EXISTS_SUSPENDED'
      | 'PROFILE_ALREADY_EXISTS_ARCHIVED',
  ): ProfileCreateOutcome => {
    if (input.profile === undefined) {
      return { outcome: 'CURRENT_STATE_CONFLICT' };
    }
    return { outcome, profile: input.profile };
  };
  return Match.value(input.observedState).pipe(
    Match.when('DEPENDENCY_UNAVAILABLE', () => ({
      outcome: 'SUBJECT_RESOLUTION_UNAVAILABLE' as const,
      retryable: true as const,
    })),
    Match.when('PERSISTENCE_UNAVAILABLE', () => ({
      outcome: 'PERSISTENCE_UNAVAILABLE' as const,
      retryable: true as const,
    })),
    Match.when('COMMIT_INDETERMINATE', () => ({
      outcome: 'COMMIT_INDETERMINATE' as const,
      retryable: true as const,
    })),
    Match.when('ABSENT', () => success('PROFILE_CREATED')),
    Match.when('ACTIVE', () => success('PROFILE_ALREADY_EXISTS_ACTIVE')),
    Match.when('SUSPENDED', () => success('PROFILE_ALREADY_EXISTS_SUSPENDED')),
    Match.when('ARCHIVED', () => success('PROFILE_ALREADY_EXISTS_ARCHIVED')),
    Match.when('SUBJECT_NOT_RESOLVED_OR_INVALID', (outcome) => ({ outcome })),
    Match.when('COUNTERPARTY_ROLE_NOT_ELIGIBLE', (outcome) => ({ outcome })),
    Match.when('PROFILE_KIND_OR_SUBJECT_CONFLICT', (outcome) => ({ outcome })),
    Match.when('PROFILE_RECONCILIATION_REQUIRED', (outcome) => ({ outcome })),
    Match.when('CURRENT_STATE_CONFLICT', (outcome) => ({ outcome })),
    Match.exhaustive,
  );
};

interface ProfileLifecycleTransitionInput {
  readonly currentRevision: number;
  readonly currentState: CommerceCustomerProfileState;
  readonly dependencyStatus: 'AVAILABLE' | 'UNAVAILABLE' | 'INDETERMINATE';
  readonly expectedRevision: number;
  readonly expectedState: CommerceCustomerProfileState;
  readonly operation: ProfileLifecycleOperation;
  readonly reconciliationRequired: boolean;
  readonly reconfirmationRequired: boolean;
}

const decideSuspendProfileTransition = (input: ProfileLifecycleTransitionInput): ProfileLifecycleDecision => {
  if (input.currentState === 'SUSPENDED') {
    return {
      currentRevision: input.currentRevision,
      outcome: 'IDEMPOTENT',
      resultingState: input.currentState,
    };
  }
  if (input.currentState === 'ARCHIVED') {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'INVALID_LIFECYCLE_TRANSITION',
      requestedOperation: input.operation,
    };
  }
  return { outcome: 'APPLIED', resultingRevision: input.currentRevision + 1, resultingState: 'SUSPENDED' };
};

const decideReactivateProfileTransition = (input: ProfileLifecycleTransitionInput): ProfileLifecycleDecision => {
  if (input.currentState === 'ACTIVE') {
    return {
      currentRevision: input.currentRevision,
      outcome: 'IDEMPOTENT',
      resultingState: input.currentState,
    };
  }
  if (input.dependencyStatus !== 'AVAILABLE') {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'DEPENDENCY_UNAVAILABLE',
    };
  }
  if (input.reconfirmationRequired) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'REACTIVATION_RECONFIRMATION_REQUIRED',
    };
  }
  return { outcome: 'APPLIED', resultingRevision: input.currentRevision + 1, resultingState: 'ACTIVE' };
};

const decideArchiveProfileTransition = (input: ProfileLifecycleTransitionInput): ProfileLifecycleDecision =>
  input.currentState === 'ARCHIVED'
    ? {
        currentRevision: input.currentRevision,
        outcome: 'IDEMPOTENT',
        resultingState: input.currentState,
      }
    : { outcome: 'APPLIED', resultingRevision: input.currentRevision + 1, resultingState: 'ARCHIVED' };

export const decideProfileLifecycleTransition = (input: ProfileLifecycleTransitionInput): ProfileLifecycleDecision => {
  if (input.reconciliationRequired) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'PROFILE_RECONCILIATION_REQUIRED',
    };
  }
  if (input.expectedRevision !== input.currentRevision || input.expectedState !== input.currentState) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'CURRENT_STATE_CONFLICT',
    };
  }
  return Match.value(input.operation).pipe(
    Match.when('SUSPEND', () => decideSuspendProfileTransition(input)),
    Match.when('REACTIVATE', () => decideReactivateProfileTransition(input)),
    Match.when('ARCHIVE', () => decideArchiveProfileTransition(input)),
    Match.exhaustive,
  );
};

export const ProfileTradingGateSchema = Schema.Struct({
  canAcceptNewOrder: Schema.Boolean,
  outcome: Schema.Literals([
    'ACTIVE',
    'SUSPENDED',
    'ARCHIVED',
    'RECONCILIATION_REQUIRED',
    'DEPENDENCY_UNAVAILABLE',
    'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
  ]),
});
export type ProfileTradingGate = typeof ProfileTradingGateSchema.Type;
export const decideProfileTradingGate = (input: {
  readonly dependencyAvailable: boolean;
  readonly reconciliationRequired: boolean;
  readonly state: CommerceCustomerProfileState;
}): ProfileTradingGate => {
  if (!input.dependencyAvailable) {
    return { canAcceptNewOrder: false, outcome: 'DEPENDENCY_UNAVAILABLE' };
  }
  if (input.reconciliationRequired) {
    return { canAcceptNewOrder: false, outcome: 'RECONCILIATION_REQUIRED' };
  }
  return { canAcceptNewOrder: input.state === 'ACTIVE', outcome: input.state };
};

export const RetailPortalAccessDecisionSchema = Schema.Struct({
  allowed: Schema.Boolean,
  outcome: Schema.Literals([
    'ALLOWED',
    'BINDING_NOT_FOUND',
    'BINDING_REVOKED',
    'BINDING_AMBIGUOUS',
    'PROFILE_SCOPE_MISMATCH',
    'PERMISSION_DENIED',
    'AUTHORIZATION_UNAVAILABLE',
  ]),
});
export type RetailPortalAccessDecision = typeof RetailPortalAccessDecisionSchema.Type;
const RetailBindingAuthorizationCurrentnessSchema = Schema.Literals(['ACTIVE', 'REVOKED', 'UNAVAILABLE']);
export type RetailBindingAuthorizationCurrentness = typeof RetailBindingAuthorizationCurrentnessSchema.Type;

export const decideRetailBindingAuthorizationCurrentness = (input: {
  readonly authorizationOperation: 'grant' | 'revoke';
  readonly authorizationState: AuthorizationMutationState;
  readonly bindingState: 'ACTIVE' | 'REVOKED';
}): RetailBindingAuthorizationCurrentness => {
  if (
    input.bindingState === 'REVOKED' ||
    input.authorizationState === 'REVOKED' ||
    input.authorizationState === 'PENDING_REVOKE' ||
    (input.authorizationOperation === 'revoke' && input.authorizationState === 'RECONCILIATION_REQUIRED')
  ) {
    return 'REVOKED';
  }
  return input.bindingState === 'ACTIVE' && input.authorizationState === 'ACTIVE' ? 'ACTIVE' : 'UNAVAILABLE';
};

interface RetailPortalAccessInput {
  readonly authorizationOperation: 'grant' | 'revoke';
  readonly authorizationState: AuthorizationMutationState;
  readonly authorizationStatus: 'AVAILABLE' | 'INDETERMINATE';
  readonly bindingState: 'ACTIVE' | 'REVOKED' | 'MISSING' | 'AMBIGUOUS';
  readonly boundProfile?: CommerceCustomerProfileRef;
  readonly grantedPermissions: readonly RetailPortalPermissionCode[];
  readonly requestedPermission: RetailPortalPermissionCode;
  readonly requestedProfile: CommerceCustomerProfileRef;
}

const retailProfileScopeKey = (profile: CommerceCustomerProfileRef | undefined): string | undefined =>
  Match.value(profile).pipe(
    // oxlint-disable-next-line unicorn/no-useless-undefined -- The Match branch must explicitly produce the optional string result.
    Match.when(undefined, () => undefined),
    // oxlint-disable-next-line unicorn/no-useless-undefined -- The Match branch must explicitly produce the optional string result.
    Match.when({ kind: 'COUNTERPARTY' }, () => undefined),
    Match.when({ kind: 'RETAIL' }, ({ resourceId, tenantId }) => `${tenantId}\u0000${resourceId}`),
    Match.exhaustive,
  );

const hasMatchingRetailProfileScope = (
  boundProfile: CommerceCustomerProfileRef | undefined,
  requestedProfile: CommerceCustomerProfileRef,
): boolean => {
  const boundScopeKey = retailProfileScopeKey(boundProfile);
  return boundScopeKey === undefined ? false : boundScopeKey === retailProfileScopeKey(requestedProfile);
};

const decideCurrentRetailPortalAccess = (input: RetailPortalAccessInput): RetailPortalAccessDecision =>
  Match.value(hasMatchingRetailProfileScope(input.boundProfile, input.requestedProfile)).pipe(
    Match.when(false, () => ({ allowed: false, outcome: 'PROFILE_SCOPE_MISMATCH' }) as const),
    Match.when(true, () =>
      Match.value(input.grantedPermissions.includes(input.requestedPermission)).pipe(
        Match.when(false, () => ({ allowed: false, outcome: 'PERMISSION_DENIED' }) as const),
        Match.when(true, () => ({ allowed: true, outcome: 'ALLOWED' }) as const),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

const decideActiveRetailPortalAccess = (input: RetailPortalAccessInput): RetailPortalAccessDecision => {
  const currentness = decideRetailBindingAuthorizationCurrentness({
    authorizationOperation: input.authorizationOperation,
    authorizationState: input.authorizationState,
    bindingState: 'ACTIVE',
  });
  return Match.value(currentness).pipe(
    Match.when('REVOKED', () => ({ allowed: false, outcome: 'BINDING_REVOKED' }) as const),
    Match.when('UNAVAILABLE', () => ({ allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' }) as const),
    Match.when('ACTIVE', () =>
      Match.value(input.authorizationStatus).pipe(
        Match.when('INDETERMINATE', () => ({ allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' }) as const),
        Match.when('AVAILABLE', () => decideCurrentRetailPortalAccess(input)),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};

export const decideRetailPortalAccess = (input: RetailPortalAccessInput): RetailPortalAccessDecision =>
  Match.value(input.bindingState).pipe(
    Match.when('MISSING', () => ({ allowed: false, outcome: 'BINDING_NOT_FOUND' }) as const),
    Match.when('AMBIGUOUS', () => ({ allowed: false, outcome: 'BINDING_AMBIGUOUS' }) as const),
    Match.when('REVOKED', () => ({ allowed: false, outcome: 'BINDING_REVOKED' }) as const),
    Match.when('ACTIVE', () => decideActiveRetailPortalAccess(input)),
    Match.exhaustive,
  );

export const ReconciliationCompletionDecisionSchema = Schema.Struct({
  complete: Schema.Boolean,
  outcome: Schema.Literals([
    'COMPLETED',
    'ALREADY_COMPLETED',
    'RECONCILIATION_BLOCKED',
    'RECONCILIATION_INCOMPLETE',
    'OUT_OF_ORDER_EVENT',
  ]),
});
export type ReconciliationCompletionDecision = typeof ReconciliationCompletionDecisionSchema.Type;
export const decideReconciliationCompletion = (input: {
  readonly caseState: 'OPEN' | 'BLOCKED' | 'READY_TO_COMPLETE' | 'COMPLETED';
  readonly eventVersion: bigint;
  readonly lastProcessedEventVersion: bigint;
  readonly ownerOutcomes: readonly ReconciliationOwnerOutcome[];
  readonly resultingStateSelected: boolean;
  readonly survivorSelected: boolean;
}): ReconciliationCompletionDecision => {
  if (input.eventVersion < input.lastProcessedEventVersion) {
    return { complete: false, outcome: 'OUT_OF_ORDER_EVENT' };
  }
  if (input.caseState === 'COMPLETED') {
    return { complete: true, outcome: 'ALREADY_COMPLETED' };
  }
  if (input.caseState === 'BLOCKED' || input.ownerOutcomes.some(({ status }) => status === 'BLOCKED')) {
    return { complete: false, outcome: 'RECONCILIATION_BLOCKED' };
  }
  const byOwner = new Map(input.ownerOutcomes.map((entry) => [entry.owner, entry.status]));
  const allOwnersComplete = RECONCILIATION_REQUIRED_OWNERS.every((owner) => {
    const status = byOwner.get(owner);
    return status === 'RESOLVED' || status === 'NOT_APPLICABLE';
  });
  return allOwnersComplete && input.survivorSelected && input.resultingStateSelected
    ? { complete: true, outcome: 'COMPLETED' }
    : { complete: false, outcome: 'RECONCILIATION_INCOMPLETE' };
};

export const GuestAttributionOutcomeSchema = Schema.Union([
  Schema.Struct({
    canAcceptOrder: Schema.Literal(true),
    outcome: Schema.Literal('ATTRIBUTION_COMPLETED'),
    partyRef: PartyRefSchema,
    portalAccessGranted: Schema.Literal(false),
    profile: CommerceCustomerProfileRefSchema,
  }),
  Schema.Struct({
    canAcceptOrder: Schema.Literal(false),
    outcome: Schema.Literals([
      'AMBIGUOUS_MATCH',
      'INVALID_OR_INSUFFICIENT_EVIDENCE',
      'PARTY_RESOLUTION_UNAVAILABLE',
      'PROFILE_RECONCILIATION_REQUIRED',
      'PROFILE_NOT_ACTIVE',
      'PROFILE_ENSURE_UNAVAILABLE',
    ]),
    portalAccessGranted: Schema.Literal(false),
  }),
]);
export type GuestAttributionOutcome = typeof GuestAttributionOutcomeSchema.Type;
interface GuestAttributionInput {
  readonly partyResolution: GuestPartyResolutionOutcome;
  readonly profileOutcome?: ProfileCreateOutcome;
}
type ResolvedGuestPartyOutcome = Extract<GuestPartyResolutionOutcome, { readonly partyRef: unknown }>;
type UnresolvedGuestPartyOutcome = Exclude<GuestPartyResolutionOutcome, ResolvedGuestPartyOutcome>;
type GuestAttributionFailureOutcome = Exclude<GuestAttributionOutcome['outcome'], 'ATTRIBUTION_COMPLETED'>;

const guestAttributionFailure = (outcome: GuestAttributionFailureOutcome): GuestAttributionOutcome => ({
  canAcceptOrder: false,
  outcome,
  portalAccessGranted: false,
});

const decideUnresolvedGuestAttribution = (partyResolution: UnresolvedGuestPartyOutcome): GuestAttributionOutcome =>
  Match.value(partyResolution.outcome).pipe(
    Match.when('AMBIGUOUS_MATCH', () => guestAttributionFailure('AMBIGUOUS_MATCH')),
    Match.when('INVALID_OR_INSUFFICIENT_EVIDENCE', () => guestAttributionFailure('INVALID_OR_INSUFFICIENT_EVIDENCE')),
    Match.when('PARTY_OWNER_UNAVAILABLE', () => guestAttributionFailure('PARTY_RESOLUTION_UNAVAILABLE')),
    Match.when('PARTY_OWNER_INDETERMINATE', () => guestAttributionFailure('PARTY_RESOLUTION_UNAVAILABLE')),
    Match.exhaustive,
  );

const decideGuestAttributionForProfile = (
  partyResolution: ResolvedGuestPartyOutcome,
  profile: CommerceCustomerProfileRef,
): GuestAttributionOutcome =>
  Match.value(profile).pipe(
    Match.when({ kind: 'COUNTERPARTY' }, () => guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE')),
    Match.when(
      { kind: 'RETAIL' },
      (retailProfile) =>
        ({
          canAcceptOrder: true,
          outcome: 'ATTRIBUTION_COMPLETED',
          partyRef: partyResolution.partyRef,
          portalAccessGranted: false,
          profile: retailProfile,
        }) as const,
    ),
    Match.exhaustive,
  );

const decideResolvedGuestAttribution = (
  partyResolution: ResolvedGuestPartyOutcome,
  profileOutcome: ProfileCreateOutcome | undefined,
): GuestAttributionOutcome =>
  Match.value(profileOutcome).pipe(
    Match.when(undefined, () => guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE')),
    Match.when({ outcome: 'PROFILE_RECONCILIATION_REQUIRED' }, () =>
      guestAttributionFailure('PROFILE_RECONCILIATION_REQUIRED'),
    ),
    Match.when({ outcome: 'PROFILE_ALREADY_EXISTS_SUSPENDED' }, () => guestAttributionFailure('PROFILE_NOT_ACTIVE')),
    Match.when({ outcome: 'PROFILE_ALREADY_EXISTS_ARCHIVED' }, () => guestAttributionFailure('PROFILE_NOT_ACTIVE')),
    Match.when({ outcome: 'PROFILE_CREATED' }, ({ profile }) =>
      decideGuestAttributionForProfile(partyResolution, profile),
    ),
    Match.when({ outcome: 'PROFILE_ALREADY_EXISTS_ACTIVE' }, ({ profile }) =>
      decideGuestAttributionForProfile(partyResolution, profile),
    ),
    Match.when({ outcome: 'SUBJECT_NOT_RESOLVED_OR_INVALID' }, () =>
      guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE'),
    ),
    Match.when({ outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE' }, () =>
      guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE'),
    ),
    Match.when({ outcome: 'PROFILE_KIND_OR_SUBJECT_CONFLICT' }, () =>
      guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE'),
    ),
    Match.when({ outcome: 'CURRENT_STATE_CONFLICT' }, () => guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE')),
    Match.when({ outcome: 'SUBJECT_RESOLUTION_UNAVAILABLE' }, () =>
      guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE'),
    ),
    Match.when({ outcome: 'PERSISTENCE_UNAVAILABLE' }, () => guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE')),
    Match.when({ outcome: 'COMMIT_INDETERMINATE' }, () => guestAttributionFailure('PROFILE_ENSURE_UNAVAILABLE')),
    Match.exhaustive,
  );

export const decideGuestAttribution = (input: GuestAttributionInput): GuestAttributionOutcome =>
  input.partyResolution.outcome === 'EXISTING_PARTY_RESOLVED' ||
  input.partyResolution.outcome === 'UNRESOLVED_PARTY_CREATED'
    ? decideResolvedGuestAttribution(input.partyResolution, input.profileOutcome)
    : decideUnresolvedGuestAttribution(input.partyResolution);

const GenericProfileMutationOutcomeSchema = Schema.Literals([
  'GENERIC_PROFILE_UPDATE_NOT_SUPPORTED',
  'FIELD_OWNED_BY_PARTY_REGISTRY',
  'FIELD_OWNED_BY_NAMED_COMMERCE_CAPABILITY',
  'IMMUTABLE_PROFILE_SUBJECT',
  'LIFECYCLE_ACTION_REQUIRED',
  'RECONCILIATION_REQUIRED',
]);
export type GenericProfileMutationOutcome = typeof GenericProfileMutationOutcomeSchema.Type;
const GenericProfileFieldOwnerSchema = Schema.Literals([
  'GENERIC',
  'PARTY_REGISTRY',
  'NAMED_COMMERCE_CAPABILITY',
  'PROFILE_SUBJECT',
  'LIFECYCLE',
  'RECONCILIATION',
]);
type GenericProfileFieldOwner = typeof GenericProfileFieldOwnerSchema.Type;
export const classifyGenericProfileMutation = (fieldOwner: GenericProfileFieldOwner): GenericProfileMutationOutcome =>
  Match.value(fieldOwner).pipe(
    Match.when('PARTY_REGISTRY', () => 'FIELD_OWNED_BY_PARTY_REGISTRY' as const),
    Match.when('NAMED_COMMERCE_CAPABILITY', () => 'FIELD_OWNED_BY_NAMED_COMMERCE_CAPABILITY' as const),
    Match.when('PROFILE_SUBJECT', () => 'IMMUTABLE_PROFILE_SUBJECT' as const),
    Match.when('LIFECYCLE', () => 'LIFECYCLE_ACTION_REQUIRED' as const),
    Match.when('RECONCILIATION', () => 'RECONCILIATION_REQUIRED' as const),
    Match.when('GENERIC', () => 'GENERIC_PROFILE_UPDATE_NOT_SUPPORTED' as const),
    Match.exhaustive,
  );
