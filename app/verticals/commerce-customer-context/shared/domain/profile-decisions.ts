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
export const ProfileCreateOutcomeSchema = Schema.Union([
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
    outcome: Schema.Literals([
      'SUBJECT_RESOLUTION_UNAVAILABLE',
      'PERSISTENCE_UNAVAILABLE',
      'COMMIT_INDETERMINATE',
    ]),
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

const targetState = (
  operation: ProfileLifecycleOperation,
  current: CommerceCustomerProfileState,
): CommerceCustomerProfileState | undefined => {
  if (operation === 'SUSPEND' && current === 'ACTIVE') {
    return 'SUSPENDED';
  }
  if (operation === 'REACTIVATE' && (current === 'SUSPENDED' || current === 'ARCHIVED')) {
    return 'ACTIVE';
  }
  if (operation === 'ARCHIVE' && (current === 'ACTIVE' || current === 'SUSPENDED')) {
    return 'ARCHIVED';
  }
  return undefined;
};

export const decideProfileLifecycleTransition = (input: {
  readonly currentRevision: number;
  readonly currentState: CommerceCustomerProfileState;
  readonly dependencyStatus: 'AVAILABLE' | 'UNAVAILABLE' | 'INDETERMINATE';
  readonly expectedRevision: number;
  readonly expectedState: CommerceCustomerProfileState;
  readonly operation: ProfileLifecycleOperation;
  readonly reconciliationRequired: boolean;
  readonly reconfirmationRequired: boolean;
}): ProfileLifecycleDecision => {
  if (input.reconciliationRequired) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'PROFILE_RECONCILIATION_REQUIRED',
    };
  }
  if (
    input.expectedRevision !== input.currentRevision ||
    input.expectedState !== input.currentState
  ) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'CURRENT_STATE_CONFLICT',
    };
  }
  if (
    (input.operation === 'SUSPEND' && input.currentState === 'SUSPENDED') ||
    (input.operation === 'REACTIVATE' && input.currentState === 'ACTIVE') ||
    (input.operation === 'ARCHIVE' && input.currentState === 'ARCHIVED')
  ) {
    return {
      currentRevision: input.currentRevision,
      outcome: 'IDEMPOTENT',
      resultingState: input.currentState,
    };
  }
  const next = targetState(input.operation, input.currentState);
  if (next === undefined) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'INVALID_LIFECYCLE_TRANSITION',
      requestedOperation: input.operation,
    };
  }
  if (input.operation === 'REACTIVATE' && input.dependencyStatus !== 'AVAILABLE') {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'DEPENDENCY_UNAVAILABLE',
    };
  }
  if (input.operation === 'REACTIVATE' && input.reconfirmationRequired) {
    return {
      currentRevision: input.currentRevision,
      currentState: input.currentState,
      outcome: 'REACTIVATION_RECONFIRMATION_REQUIRED',
    };
  }
  return { outcome: 'APPLIED', resultingRevision: input.currentRevision + 1, resultingState: next };
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
export const RetailBindingAuthorizationCurrentnessSchema = Schema.Literals([
  'ACTIVE',
  'REVOKED',
  'UNAVAILABLE',
]);
export type RetailBindingAuthorizationCurrentness =
  typeof RetailBindingAuthorizationCurrentnessSchema.Type;

export const decideRetailBindingAuthorizationCurrentness = (input: {
  readonly authorizationOperation: 'grant' | 'revoke';
  readonly authorizationState: AuthorizationMutationState;
  readonly bindingState: 'ACTIVE' | 'REVOKED';
}): RetailBindingAuthorizationCurrentness => {
  if (
    input.bindingState === 'REVOKED' ||
    input.authorizationState === 'REVOKED' ||
    input.authorizationState === 'PENDING_REVOKE' ||
    (input.authorizationOperation === 'revoke' &&
      input.authorizationState === 'RECONCILIATION_REQUIRED')
  ) {
    return 'REVOKED';
  }
  return input.bindingState === 'ACTIVE' && input.authorizationState === 'ACTIVE'
    ? 'ACTIVE'
    : 'UNAVAILABLE';
};

export const decideRetailPortalAccess = (input: {
  readonly authorizationOperation: 'grant' | 'revoke';
  readonly authorizationState: AuthorizationMutationState;
  readonly authorizationStatus: 'AVAILABLE' | 'INDETERMINATE';
  readonly bindingState: 'ACTIVE' | 'REVOKED' | 'MISSING' | 'AMBIGUOUS';
  readonly boundProfile?: CommerceCustomerProfileRef;
  readonly grantedPermissions: readonly RetailPortalPermissionCode[];
  readonly requestedPermission: RetailPortalPermissionCode;
  readonly requestedProfile: CommerceCustomerProfileRef;
}): RetailPortalAccessDecision => {
  if (input.bindingState === 'MISSING') {
    return { allowed: false, outcome: 'BINDING_NOT_FOUND' };
  }
  if (input.bindingState === 'AMBIGUOUS') {
    return { allowed: false, outcome: 'BINDING_AMBIGUOUS' };
  }
  if (input.bindingState === 'REVOKED') {
    return { allowed: false, outcome: 'BINDING_REVOKED' };
  }
  const currentness = decideRetailBindingAuthorizationCurrentness({
    authorizationOperation: input.authorizationOperation,
    authorizationState: input.authorizationState,
    bindingState: input.bindingState,
  });
  if (currentness === 'REVOKED') {
    return { allowed: false, outcome: 'BINDING_REVOKED' };
  }
  if (currentness === 'UNAVAILABLE' || input.authorizationStatus === 'INDETERMINATE') {
    return { allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' };
  }
  if (
    input.boundProfile === undefined ||
    input.boundProfile.kind !== 'RETAIL' ||
    input.requestedProfile.kind !== 'RETAIL' ||
    input.boundProfile.resourceId !== input.requestedProfile.resourceId ||
    input.boundProfile.tenantId !== input.requestedProfile.tenantId
  ) {
    return { allowed: false, outcome: 'PROFILE_SCOPE_MISMATCH' };
  }
  if (!input.grantedPermissions.includes(input.requestedPermission)) {
    return { allowed: false, outcome: 'PERMISSION_DENIED' };
  }
  return { allowed: true, outcome: 'ALLOWED' };
};

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
  if (
    input.caseState === 'BLOCKED' ||
    input.ownerOutcomes.some(({ status }) => status === 'BLOCKED')
  ) {
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
export const decideGuestAttribution = (input: {
  readonly partyResolution: GuestPartyResolutionOutcome;
  readonly profileOutcome?: ProfileCreateOutcome;
}): GuestAttributionOutcome => {
  if (input.partyResolution.outcome === 'AMBIGUOUS_MATCH') {
    return { canAcceptOrder: false, outcome: 'AMBIGUOUS_MATCH', portalAccessGranted: false };
  }
  if (input.partyResolution.outcome === 'INVALID_OR_INSUFFICIENT_EVIDENCE') {
    return {
      canAcceptOrder: false,
      outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
      portalAccessGranted: false,
    };
  }
  if (
    input.partyResolution.outcome === 'PARTY_OWNER_UNAVAILABLE' ||
    input.partyResolution.outcome === 'PARTY_OWNER_INDETERMINATE'
  ) {
    return {
      canAcceptOrder: false,
      outcome: 'PARTY_RESOLUTION_UNAVAILABLE',
      portalAccessGranted: false,
    };
  }
  if (input.profileOutcome?.outcome === 'PROFILE_RECONCILIATION_REQUIRED') {
    return {
      canAcceptOrder: false,
      outcome: 'PROFILE_RECONCILIATION_REQUIRED',
      portalAccessGranted: false,
    };
  }
  if (
    input.profileOutcome?.outcome === 'PROFILE_ALREADY_EXISTS_SUSPENDED' ||
    input.profileOutcome?.outcome === 'PROFILE_ALREADY_EXISTS_ARCHIVED'
  ) {
    return { canAcceptOrder: false, outcome: 'PROFILE_NOT_ACTIVE', portalAccessGranted: false };
  }
  if (
    input.profileOutcome === undefined ||
    (input.profileOutcome.outcome !== 'PROFILE_CREATED' &&
      input.profileOutcome.outcome !== 'PROFILE_ALREADY_EXISTS_ACTIVE') ||
    input.profileOutcome.profile.kind !== 'RETAIL'
  ) {
    return {
      canAcceptOrder: false,
      outcome: 'PROFILE_ENSURE_UNAVAILABLE',
      portalAccessGranted: false,
    };
  }
  return {
    canAcceptOrder: true,
    outcome: 'ATTRIBUTION_COMPLETED',
    partyRef: input.partyResolution.partyRef,
    portalAccessGranted: false,
    profile: input.profileOutcome.profile,
  };
};

export const GenericProfileMutationOutcomeSchema = Schema.Literals([
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
export const classifyGenericProfileMutation = (
  fieldOwner: GenericProfileFieldOwner,
): GenericProfileMutationOutcome =>
  Match.value(fieldOwner).pipe(
    Match.when('PARTY_REGISTRY', () => 'FIELD_OWNED_BY_PARTY_REGISTRY' as const),
    Match.when(
      'NAMED_COMMERCE_CAPABILITY',
      () => 'FIELD_OWNED_BY_NAMED_COMMERCE_CAPABILITY' as const,
    ),
    Match.when('PROFILE_SUBJECT', () => 'IMMUTABLE_PROFILE_SUBJECT' as const),
    Match.when('LIFECYCLE', () => 'LIFECYCLE_ACTION_REQUIRED' as const),
    Match.when('RECONCILIATION', () => 'RECONCILIATION_REQUIRED' as const),
    Match.when('GENERIC', () => 'GENERIC_PROFILE_UPDATE_NOT_SUPPORTED' as const),
    Match.exhaustive,
  );

export {
  CommerceCustomerProfileStateSchema,
  ProfileCreateObservedStateSchema,
  RetailPortalPermissionCodeSchema,
} from './profile-contracts.ts';
