/* oxlint-disable effect-native/no-dependency-parameters effect-native/no-nullable-schema-field effect-native/no-string-timestamp-schema effect-native/no-unbranded-identifier-schema effect-native/no-duplicate-literal-vocabulary anti-slop/no-known-value-widening sonarjs/no-duplicate-string -- This adapter decodes nullable database wire rows and accepts optional owner-port composition inputs without exporting database capability; expires: 2027-03-31. */
import {
  BusinessPermissionCodeSchema,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  defineScopedRoutine,
} from '@app/core-runtime';
import type {
  BusinessPermissionRelationshipMutationService,
  OutboxWorkerLegalEntityScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { DateTime, Effect, Option, Result, Schema } from 'effect';

import { AttributeGuestRetailCustomerRejected } from '../../shared/actions/attribute-guest-retail-customer.ts';
import type {
  AttributeGuestRetailCustomerPayload,
  AttributeGuestRetailCustomerResult,
} from '../../shared/actions/attribute-guest-retail-customer.ts';
import {
  RetailPortalBindingActionRejected,
  RetailPortalBindingResultSchema,
} from '../../shared/actions/bind-retail-portal-profile.ts';
import type {
  RetailPortalBindingPayload,
  RetailPortalBindingResult,
} from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  CreateCounterpartyPurchasingProfileRejected,
  CreateCounterpartyPurchasingProfileResultSchema,
} from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import type {
  CreateCounterpartyPurchasingProfilePayload,
  CreateCounterpartyPurchasingProfileResult,
} from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import {
  EnsureRetailCustomerProfileRejected,
  EnsureRetailCustomerProfileResultSchema,
} from '../../shared/actions/ensure-retail-customer-profile.ts';
import type {
  EnsureRetailCustomerProfilePayload,
  EnsureRetailCustomerProfileResult,
} from '../../shared/actions/ensure-retail-customer-profile.ts';
import {
  OpenProfileReconciliationResultSchema,
  ProfileReconciliationActionRejected,
} from '../../shared/actions/open-profile-reconciliation.ts';
import type {
  OpenProfileReconciliationPayload,
  OpenProfileReconciliationResult,
} from '../../shared/actions/open-profile-reconciliation.ts';
import {
  ProfileReconciliationDurableProgressSchema,
  ResolveProfileReconciliationResultSchema,
} from '../../shared/actions/resolve-profile-reconciliation.ts';
import type {
  ProfileReconciliationDurableProgress,
  ProfileReconciliationOwnerOutcomeRecordRequest,
  ProfileReconciliationOwnerVerification,
  ResolveProfileReconciliationPayload,
  ResolveProfileReconciliationResult,
} from '../../shared/actions/resolve-profile-reconciliation.ts';
import {
  ProfileLifecycleActionRejected,
  ProfileLifecycleResultSchema,
} from '../../shared/actions/suspend-customer-profile.ts';
import type {
  ProfileLifecyclePayload,
  ProfileLifecycleResult,
} from '../../shared/actions/suspend-customer-profile.ts';
import type {
  CustomerProfileReadRequest,
  CustomerProfileReadResponse,
} from '../../shared/apis/customer-profile-read.ts';
import type {
  CustomerProfileTradingGateRequest,
  CustomerProfileTradingGateResponse,
} from '../../shared/apis/customer-profile-trading-gate.ts';
import type {
  GuestAttributionStatusRequest,
  GuestAttributionStatusResponse,
} from '../../shared/apis/guest-attribution-status.ts';
import type {
  ProfileReconciliationReadRequest,
  ProfileReconciliationReadResponse,
} from '../../shared/apis/profile-reconciliation-read.ts';
import type {
  RetailAccessDecisionRequest,
  RetailAccessDecisionResponse,
} from '../../shared/apis/retail-access-decision.ts';
import type { RetailAccessDecisionServices } from '../api/retail-access-decision.read.ts';
import type {
  RetailPortalProfileBindingReadRequest,
  RetailPortalProfileBindingReadResponse,
} from '../../shared/apis/retail-portal-profile-binding-read.ts';
import type {
  RetailPrincipalResolutionRequest,
  RetailPrincipalResolutionResponse,
} from '../../shared/apis/retail-principal-resolution.ts';
import {
  CommerceCustomerProfileSubjectSchema,
  ReconciliationOwnerSchema,
  ReconciliationOwnerOutcomeSchema,
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RetailPortalPermissionCodeSchema,
} from '../../shared/domain/profile-contracts.ts';
import type {
  GuestPartyResolutionOutcome,
  ProfileLifecycleOperation,
  ReconciliationOwner,
  RetailPortalBindingAuthorizationOperation,
  RetailPortalBindingAuthorizationState,
  RetailPortalPermissionCode,
} from '../../shared/domain/profile-contracts.ts';
import { decideRetailPortalAccess } from '../../shared/domain/profile-decisions.ts';
import type {
  CommerceCustomerProfile,
  CommerceCustomerProfileRef,
} from '../../shared/domain/profile-decisions.ts';
import {
  ProfileReconciliationOwnerVerificationFailure,
  profileReconciliationOwnerVerifierUnavailable,
} from '../profile-reconciliation-owner-verifier.ts';
import type { ProfileReconciliationOwnerVerifierService } from '../profile-reconciliation-owner-verifier.ts';
import {
  PartyMergeReconciliationCaseObservationSchema,
  ReconcilePartyMergeWorkerRejected,
} from '../workers/reconcile-party-merge.worker.ts';
import type {
  ReconcilePartyMergeObservation,
  ReconcilePartyMergeObservationResult,
  ReconcilePartyMergePersistenceService,
  ReconcilePartyMergeWorkerError,
} from '../workers/reconcile-party-merge.worker.ts';
import { RetailBindingAuthorizationMutationWorkerRejected } from '../workers/retail-binding-authorization-mutation-reconciliation.ts';
import type {
  RetailBindingAuthorizationMutationReconciliationResult,
  RetailBindingAuthorizationMutationReconciliationService,
  RetailBindingAuthorizationMutationRequest,
} from '../workers/retail-binding-authorization-mutation-reconciliation.ts';

/** Routine-only capability; this does not expose Core's database executor to owner services. */
export interface ProfileScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

export interface ProfilePersistenceScope {
  readonly authBindingId?: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

interface ProfileActionContext {
  readonly actionInvocationId: string;
  readonly scope: {
    readonly legalEntityId?: string;
    readonly tenantId: string;
  };
}

export interface AttributeGuestRetailCustomerServices {
  readonly attribute: (
    payload: AttributeGuestRetailCustomerPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<AttributeGuestRetailCustomerResult, AttributeGuestRetailCustomerRejected>;
}

export interface BindRetailPortalProfileServices {
  readonly bind: (
    payload: RetailPortalBindingPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected>;
}
export interface RecoverRetailPortalProfileBindingServices {
  readonly recover: (
    payload: RetailPortalBindingPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected>;
}
export interface RevokeRetailPortalProfileBindingServices {
  readonly revoke: (
    payload: RetailPortalBindingPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected>;
}

export interface CreateCounterpartyPurchasingProfileServices {
  readonly create: (
    payload: CreateCounterpartyPurchasingProfilePayload,
    context: ProfileActionContext,
  ) => Effect.Effect<
    CreateCounterpartyPurchasingProfileResult,
    CreateCounterpartyPurchasingProfileRejected
  >;
}

export interface EnsureRetailCustomerProfileServices {
  readonly ensure: (
    payload: EnsureRetailCustomerProfilePayload,
    context: ProfileActionContext,
  ) => Effect.Effect<EnsureRetailCustomerProfileResult, EnsureRetailCustomerProfileRejected>;
}

export interface OpenProfileReconciliationServices {
  readonly open: (
    payload: OpenProfileReconciliationPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<OpenProfileReconciliationResult, ProfileReconciliationActionRejected>;
}

export interface ResolveProfileReconciliationServices {
  readonly ownerReconciler: {
    readonly finalize: (
      payload: ResolveProfileReconciliationPayload,
      expectedCaseRevision: number,
      unavailableOwners: readonly ReconciliationOwner[],
      conflictingOwners: readonly ReconciliationOwner[],
      context: ProfileActionContext,
    ) => Effect.Effect<ResolveProfileReconciliationResult, ProfileReconciliationActionRejected>;
    readonly load: (
      caseRef: ResolveProfileReconciliationPayload['caseRef'],
      context: ProfileActionContext,
    ) => Effect.Effect<ProfileReconciliationDurableProgress, ProfileReconciliationActionRejected>;
    readonly record: (
      request: ProfileReconciliationOwnerOutcomeRecordRequest,
      context: ProfileActionContext,
    ) => Effect.Effect<ProfileReconciliationDurableProgress, ProfileReconciliationActionRejected>;
  };
  readonly ownerVerifier: ProfileReconciliationOwnerVerifierService;
}

export interface ProfileLifecycleServices {
  readonly transition: (
    payload: ProfileLifecyclePayload,
    context: ProfileActionContext,
  ) => Effect.Effect<ProfileLifecycleResult, ProfileLifecycleActionRejected>;
}
export type ArchiveCustomerProfileServices = ProfileLifecycleServices;
export type ReactivateCustomerProfileServices = ProfileLifecycleServices;
export type SuspendCustomerProfileServices = ProfileLifecycleServices;

export interface CustomerProfileReadServices {
  readonly readProfile: (
    input: CustomerProfileReadRequest,
    tenantId: string,
  ) => Effect.Effect<CustomerProfileReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
export interface CustomerProfileTradingGateServices {
  readonly evaluateGate: (
    input: CustomerProfileTradingGateRequest,
    tenantId: string,
  ) => Effect.Effect<
    CustomerProfileTradingGateResponse,
    ReadHandlerNotFound | ReadHandlerUnavailable
  >;
}
export interface GuestAttributionStatusServices {
  readonly readStatus: (
    input: GuestAttributionStatusRequest,
    tenantId: string,
  ) => Effect.Effect<GuestAttributionStatusResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
export interface ProfileReconciliationReadServices {
  readonly readCase: (
    input: ProfileReconciliationReadRequest,
    tenantId: string,
  ) => Effect.Effect<
    ProfileReconciliationReadResponse,
    ReadHandlerNotFound | ReadHandlerUnavailable
  >;
}
export interface RetailPortalProfileBindingReadServices {
  readonly readBinding: (
    input: RetailPortalProfileBindingReadRequest,
    principalId: string,
    tenantId: string,
  ) => Effect.Effect<
    RetailPortalProfileBindingReadResponse,
    ReadHandlerNotFound | ReadHandlerUnavailable
  >;
}
export interface RetailPrincipalResolutionServices {
  readonly resolvePrincipal: (
    input: RetailPrincipalResolutionRequest,
    principalId: string,
    tenantId: string,
  ) => Effect.Effect<
    RetailPrincipalResolutionResponse,
    ReadHandlerNotFound | ReadHandlerUnavailable
  >;
}

interface RetailPermissionProjection {
  readonly freshness: {
    readonly observedAt: string;
    readonly revision?: string;
    readonly sourceModuleId: 'core.identity';
    readonly status: 'CURRENT' | 'UNAVAILABLE';
  };
  readonly permissions: readonly RetailPortalPermissionCode[];
}

const RoutineRowSchema = Schema.Struct({
  outcome: Schema.String,
  payload: Schema.NullOr(Schema.Unknown),
});
const IntegerSchema = Schema.Finite.check(Schema.isInt());
const ObservationRowSchema = Schema.Struct({
  current_event_version: Schema.BigIntFromString,
  outcome: Schema.String,
  payload: Schema.NullOr(Schema.Unknown),
});
const ProfilePayloadSchema = Schema.Struct({
  createdAt: Schema.String,
  profileId: Schema.String,
  profileKind: Schema.Literals(['RETAIL', 'COUNTERPARTY']),
  revision: IntegerSchema,
  scopeLegalEntityId: Schema.optionalKey(Schema.String),
  state: Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']),
  subject: Schema.Union([
    Schema.Struct({
      attributionKind: Schema.String,
      kind: Schema.Literal('RETAIL'),
      partyResourceId: Schema.String,
      partyResourceRevision: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      counterpartyResourceId: Schema.String,
      counterpartyResourceRevision: Schema.NullOr(Schema.String),
      customerRoleResourceId: Schema.NullOr(Schema.String),
      customerRoleResourceRevision: Schema.NullOr(Schema.String),
      kind: Schema.Literal('COUNTERPARTY'),
    }),
  ]),
  updatedAt: Schema.String,
});
const BindingPermissionMutationPayloadSchema = Schema.Struct({
  mutationId: Schema.String,
  operation: Schema.Literals(['grant', 'revoke']),
  permission: RetailPortalPermissionCodeSchema,
  staged: Schema.Boolean,
  state: Schema.Literals([
    'ACTIVE',
    'REVOKED',
    'PENDING_GRANT',
    'PENDING_REVOKE',
    'RECONCILIATION_REQUIRED',
  ]),
});
const BindingPayloadSchema = Schema.Struct({
  actionInvocationId: Schema.String,
  actorPrincipalId: Schema.optionalKey(Schema.String),
  authorizationMutationId: Schema.optionalKey(Schema.String),
  authorizationOperation: Schema.optionalKey(Schema.Literals(['grant', 'revoke'])),
  authorizationState: Schema.optionalKey(
    Schema.Literals([
      'ACTIVE',
      'REVOKED',
      'PENDING_GRANT',
      'PENDING_REVOKE',
      'RECONCILIATION_REQUIRED',
    ]),
  ),
  bindingId: Schema.String,
  createdAt: Schema.String,
  enrollmentEvidenceRef: Schema.String,
  permissionMutations: Schema.optionalKey(Schema.Array(BindingPermissionMutationPayloadSchema)),
  principalId: Schema.String,
  profileId: Schema.String,
  reason: Schema.String,
  revision: IntegerSchema,
  revokedAt: Schema.NullOr(Schema.String),
  state: Schema.Literals(['ACTIVE', 'REVOKED']),
  updatedAt: Schema.String,
});
const BindingAuthorizationMutationPayloadSchema = Schema.Struct({
  actionInvocationId: Schema.String,
  actorPrincipalId: Schema.NullOr(Schema.String),
  bindingId: Schema.String,
  finalizedAt: Schema.NullOr(Schema.String),
  mutationId: Schema.String,
  operation: Schema.Literals(['grant', 'revoke']),
  permission: RetailPortalPermissionCodeSchema,
  principalId: Schema.String,
  profileId: Schema.String,
  reason: Schema.NullOr(Schema.String),
  revision: IntegerSchema,
  staged: Schema.Boolean,
  state: Schema.Literals([
    'ACTIVE',
    'REVOKED',
    'PENDING_GRANT',
    'PENDING_REVOKE',
    'RECONCILIATION_REQUIRED',
  ]),
});
const BindingAuthorizationMutationFinalizationPayloadSchema = Schema.Struct({
  ...BindingAuthorizationMutationPayloadSchema.fields,
  authorizationState: Schema.Literals([
    'ACTIVE',
    'REVOKED',
    'PENDING_GRANT',
    'PENDING_REVOKE',
    'RECONCILIATION_REQUIRED',
  ]),
  bindingRevision: IntegerSchema,
});
const BindingAuthorizationFinalizationPayloadSchema = Schema.Struct({
  authorizationOperation: Schema.Literals(['grant', 'revoke']),
  authorizationState: Schema.Literals(['ACTIVE', 'REVOKED']),
  bindingId: Schema.String,
  effectiveAt: Schema.String,
  operation: Schema.Literals(['grant', 'revoke']),
  principalId: Schema.String,
  profileId: Schema.String,
  revision: IntegerSchema,
  updatedAt: Schema.String,
});
const BindingAuthorizationPayloadSchema = Schema.Struct({
  authorizationOperation: Schema.Literals(['grant', 'revoke']),
  authorizationState: Schema.Literals([
    'ACTIVE',
    'REVOKED',
    'PENDING_GRANT',
    'PENDING_REVOKE',
    'RECONCILIATION_REQUIRED',
  ]),
  bindingId: Schema.String,
  operation: Schema.Literals(['grant', 'revoke']),
  pendingCount: IntegerSchema,
  principalId: Schema.String,
  profileId: Schema.String,
  revision: IntegerSchema,
  terminalCount: IntegerSchema,
  updatedAt: Schema.String,
});
const PrincipalPayloadSchema = Schema.Struct({
  bindingId: Schema.optionalKey(Schema.String),
  caseId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  observedAt: Schema.String,
  profileId: Schema.String,
  revision: IntegerSchema,
});
const ProfileReconciliationRequiredPayloadSchema = Schema.Struct({
  caseId: Schema.String,
  observedAt: Schema.String,
  revision: IntegerSchema,
  targetSubject: CommerceCustomerProfileSubjectSchema,
});
const BindingReconciliationRequiredPayloadSchema = Schema.Struct({
  caseId: Schema.String,
  observedAt: Schema.String,
  profileId: Schema.String,
  revision: IntegerSchema,
});
const ReconciliationPayloadSchema = Schema.Struct({
  caseId: Schema.String,
  createdAt: Schema.String,
  lastProcessedEventVersion: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  members: Schema.Array(
    Schema.Struct({
      profileId: Schema.String,
      profileKind: Schema.Literals(['RETAIL', 'COUNTERPARTY']),
    }),
  ),
  ownerOutcomes: Schema.Array(ReconciliationOwnerOutcomeSchema),
  profileKind: Schema.Literals(['RETAIL', 'COUNTERPARTY']),
  reason: Schema.String,
  resultingState: Schema.NullOr(Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED'])),
  revision: IntegerSchema,
  sourceCorrelationRef: Schema.String,
  state: Schema.Literals(['OPEN', 'BLOCKED', 'READY_TO_COMPLETE', 'COMPLETED']),
  survivorProfileId: Schema.NullOr(Schema.String),
  targetSubject: CommerceCustomerProfileSubjectSchema,
  trigger: Schema.Literals([
    'PARTY_ALIAS',
    'COUNTERPARTY_ALIAS',
    'CREATE_COLLISION',
    'IMPORT_CORRELATION',
  ]),
  updatedAt: Schema.String,
});
const GuestPayloadSchema = Schema.Struct({
  correlationRoot: Schema.String,
  observedAt: Schema.String,
  outcome: Schema.Literals([
    'ATTRIBUTED',
    'PARTY_UNRESOLVED',
    'PARTY_AMBIGUOUS',
    'PARTY_INVALID',
    'PROFILE_NOT_ACTIVE',
  ]),
  partyResourceId: Schema.NullOr(Schema.String),
  profileId: Schema.NullOr(Schema.String),
  reconciliationRef: Schema.NullOr(Schema.String),
});
const PartyMergeObservationPayloadSchema = Schema.Struct({
  cases: Schema.Array(PartyMergeReconciliationCaseObservationSchema),
});
const OwnerVerificationPayloadSchema = Schema.Struct({
  correlationRef: Schema.String,
  evidenceRef: Schema.String,
  owner: ReconciliationOwnerSchema,
  /** The owner receipt is bound to the exact survivor requested by Resolve. */
  resultingState: Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']),
  /** Stable provenance digest derived from the reconciliation case evidence. */
  provenanceRef: Schema.String,
  status: Schema.Literals(['RESOLVED', 'NOT_APPLICABLE']),
  survivorProfileId: Schema.String,
});

const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const routine = <const Parameters extends readonly ScopedRoutineParameter[]>(
  name: string,
  routineKey: string,
  parameters: Parameters,
) =>
  defineScopedRoutine({
    name,
    ownerModuleKey: 'commerce.customer-context',
    parameters,
    resultSchema: RoutineRowSchema,
    routineKey,
    schema: 'commerce_customer_context',
  });

const ensureRetailProfileRoutine = routine('ensure_retail_profile', 'profile.ensure-retail', [
  ...scopeParameters,
  { source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const ensureCounterpartyProfileRoutine = routine(
  'ensure_counterparty_profile',
  'profile.ensure-counterparty',
  [
    ...scopeParameters,
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
);
const transitionProfileRoutine = routine('transition_profile', 'profile.transition', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'integer' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'boolean' },
  { source: 'input', type: 'boolean' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const mutateBindingRoutine = routine('mutate_retail_portal_binding', 'profile.binding-mutate', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'integer' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const readProfileRoutine = routine('read_customer_profile', 'profile.read', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
] as const);
const readTradingGateRoutine = routine('read_profile_trading_gate', 'profile.read-trading-gate', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
] as const);
const readBindingRoutine = routine('read_retail_portal_binding', 'profile.read-binding', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const stageBindingAuthorizationMutationsRoutine = routine(
  'stage_retail_portal_profile_binding_permission_mutations',
  'profile.binding-authorization-intent-stage',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
);
const readBindingAuthorizationMutationRoutine = routine(
  'read_retail_portal_profile_binding_permission_mutation',
  'profile.binding-authorization-intent-read',
  [...scopeParameters, { source: 'input', type: 'uuid' }] as const,
);
const finalizeBindingAuthorizationMutationRoutine = routine(
  'finalize_retail_portal_profile_binding_permission_mutation',
  'profile.binding-authorization-intent-finalize',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ] as const,
);
const readBindingAuthorizationRoutine = routine(
  'read_retail_portal_binding_authorization',
  'profile.binding-authorization-read',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
);
const finalizeBindingAuthorizationRoutine = routine(
  'finalize_retail_portal_binding_authorization',
  'profile.binding-authorization-finalize',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
  ] as const,
);
const resolvePrincipalRoutine = routine('resolve_retail_principal', 'profile.resolve-principal', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const openReconciliationRoutine = routine(
  'open_profile_reconciliation',
  'profile.reconciliation-open',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid[]' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'uuid' },
  ] as const,
);
const resolveReconciliationRoutine = routine(
  'resolve_profile_reconciliation',
  'profile.reconciliation-resolve',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
);
const recordReconciliationOwnerOutcomeRoutine = routine(
  'record_profile_reconciliation_owner_outcome',
  'profile.reconciliation-owner-record',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
);
const verifyReconciliationOwnerRoutine = routine(
  'reconcile_profile_reconciliation_owner',
  'profile.reconciliation-owner-verify',
  [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
);
const readReconciliationRoutine = routine(
  'read_profile_reconciliation',
  'profile.reconciliation-read',
  [...scopeParameters, { source: 'input', type: 'uuid' }] as const,
);
const recordGuestAttributionRoutine = routine('record_guest_attribution', 'profile.guest-record', [
  ...scopeParameters,
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'uuid' },
  { nullable: true, source: 'input', type: 'text' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const readGuestAttributionRoutine = routine('read_guest_attribution', 'profile.guest-read', [
  ...scopeParameters,
  { source: 'input', type: 'text' },
] as const);
const observePartyMergeRoutine = defineScopedRoutine({
  name: 'observe_party_merge_reconciliation',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    ...scopeParameters,
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text[]' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: ObservationRowSchema,
  routineKey: 'profile.party-merge-observe',
  schema: 'commerce_customer_context',
});

export const profileRoutineAllowlist = Object.freeze([
  ensureRetailProfileRoutine,
  ensureCounterpartyProfileRoutine,
  transitionProfileRoutine,
  mutateBindingRoutine,
  readProfileRoutine,
  readTradingGateRoutine,
  readBindingRoutine,
  stageBindingAuthorizationMutationsRoutine,
  readBindingAuthorizationMutationRoutine,
  finalizeBindingAuthorizationMutationRoutine,
  readBindingAuthorizationRoutine,
  finalizeBindingAuthorizationRoutine,
  resolvePrincipalRoutine,
  openReconciliationRoutine,
  recordReconciliationOwnerOutcomeRoutine,
  verifyReconciliationOwnerRoutine,
  resolveReconciliationRoutine,
  readReconciliationRoutine,
  recordGuestAttributionRoutine,
  readGuestAttributionRoutine,
  observePartyMergeRoutine,
]);

/** Transaction-bound verifier for reconciliation owners backed by profile-owned tables. */
export const profileReconciliationOwnerVerifierForTransaction = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
): ProfileReconciliationOwnerVerifierService => ({
  verify: (request, context) => {
    if (
      request.desiredOutcome.owner === 'APPROVAL' ||
      request.desiredOutcome.owner === 'CONNECTOR_CORRELATION'
    ) {
      return Effect.succeed({
        _tag: 'UNAVAILABLE' as const,
        owner: request.desiredOutcome.owner,
        reason:
          request.desiredOutcome.owner === 'APPROVAL'
            ? 'Approval reconciliation evidence is owned by the Purchase Approval capability'
            : 'Connector correlation reconciliation evidence is owned by the Connector capability',
      });
    }
    if (
      context.tenantId !== scope.tenantId ||
      context.legalEntityId !== scope.legalEntityId ||
      request.caseRef.tenantId !== scope.tenantId ||
      request.survivorProfileRef.tenantId !== scope.tenantId
    ) {
      return Effect.fail(
        new ProfileReconciliationOwnerVerificationFailure({
          code: 'OUTCOME_INDETERMINATE',
          owner: request.desiredOutcome.owner,
          reason: 'Profile owner verification requires the exact verified operational scope',
          retryable: false,
        }),
      );
    }
    return transaction
      .invoke(verifyReconciliationOwnerRoutine, [
        request.caseRef.resourceId,
        request.desiredOutcome.owner,
        request.survivorProfileRef.resourceId,
        request.resultingState,
        request.desiredOutcome.status,
        request.expectedCaseRevision,
        request.expectedEventVersion,
        request.effectiveAt,
        request.reason,
        context.actionInvocationId,
        context.actorPrincipalId,
      ])
      .pipe(
        Effect.mapError((cause) => {
          const failure = new ProfileReconciliationOwnerVerificationFailure({
            code: 'OWNER_UNAVAILABLE',
            owner: request.desiredOutcome.owner,
            reason: 'Profile-owned reconciliation evidence is temporarily unavailable',
            retryable: true,
          });
          Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
          return failure;
        }),
        Effect.map(([row]): ProfileReconciliationOwnerVerification => {
          if (
            row?.outcome === 'VERIFIED' &&
            row.payload !== null &&
            Schema.is(OwnerVerificationPayloadSchema)(row.payload) &&
            row.payload.owner === request.desiredOutcome.owner &&
            row.payload.status === request.desiredOutcome.status &&
            row.payload.survivorProfileId === request.survivorProfileRef.resourceId &&
            row.payload.resultingState === request.resultingState &&
            row.payload.correlationRef.length > 0 &&
            row.payload.evidenceRef.length > 0 &&
            row.payload.provenanceRef.length > 0
          ) {
            return {
              _tag: 'VERIFIED',
              correlationRef: row.payload.correlationRef,
              durableOutcome: {
                evidenceRef: row.payload.evidenceRef,
                owner: row.payload.owner,
                status: row.payload.status,
              },
            };
          }
          return row?.outcome === 'OWNER_CONFLICT'
            ? {
                _tag: 'CONFLICT',
                owner: request.desiredOutcome.owner,
                reason: 'Profile-owned durable state conflicts with the requested reconciliation',
              }
            : {
                _tag: 'UNAVAILABLE',
                owner: request.desiredOutcome.owner,
                reason: 'This reconciliation owner is not backed by profile persistence',
              };
        }),
      );
  },
});

const routineFailureReason = (failure: ScopedRoutineInvocationError): string =>
  `The scoped Customer Profile routine failed (${failure.routineKey})`;
const preserveFailureCause = <Failure extends object>(
  failure: Failure,
  cause: unknown,
): Failure => {
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const readUnavailable = (reason: string) =>
  new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });
const readNotFound = (reason: string) =>
  new ReadHandlerNotFound({ code: 'read_handler_not_found', reason });
const readUnavailableFromRoutineFailure = (failure: ScopedRoutineInvocationError) => {
  const reason = routineFailureReason(failure);
  return readUnavailable(reason);
};
const succeedCustomerProfileRead = (result: CustomerProfileReadResponse) => Effect.succeed(result);
const succeedCustomerProfileTradingGate = (result: CustomerProfileTradingGateResponse) =>
  Effect.succeed(result);
const succeedGuestAttributionStatus = (result: GuestAttributionStatusResponse) =>
  Effect.succeed(result);
const succeedProfileReconciliationRead = (result: ProfileReconciliationReadResponse) =>
  Effect.succeed(result);
const succeedRetailPortalBindingRead = (result: RetailPortalProfileBindingReadResponse) =>
  Effect.succeed(result);
const succeedRetailPrincipalResolution = (result: RetailPrincipalResolutionResponse) =>
  Effect.succeed(result);
const succeedPartyMergeObservation = (result: ReconcilePartyMergeObservationResult) =>
  Effect.succeed(result);

const profileKind = (ref: { readonly kind: 'COUNTERPARTY' | 'RETAIL' }) => ref.kind;
const targetState = (operation: ProfileLifecycleOperation): 'ACTIVE' | 'ARCHIVED' | 'SUSPENDED' =>
  operation === 'REACTIVATE' ? 'ACTIVE' : operation === 'ARCHIVE' ? 'ARCHIVED' : 'SUSPENDED';

function profileRef(
  tenantId: string,
  resourceId: string,
  kind: 'RETAIL',
): Extract<CommerceCustomerProfileRef, { readonly kind: 'RETAIL' }>;
function profileRef(
  tenantId: string,
  resourceId: string,
  kind: 'COUNTERPARTY',
): Extract<CommerceCustomerProfileRef, { readonly kind: 'COUNTERPARTY' }>;
function profileRef(
  tenantId: string,
  resourceId: string,
  kind: 'COUNTERPARTY' | 'RETAIL',
): CommerceCustomerProfileRef;
function profileRef(
  tenantId: string,
  resourceId: string,
  kind: 'COUNTERPARTY' | 'RETAIL',
): CommerceCustomerProfileRef {
  if (kind === 'RETAIL') {
    return {
      kind,
      moduleId: 'commerce.customer-context',
      resourceId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    };
  }
  return {
    kind,
    moduleId: 'commerce.customer-context',
    resourceId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  };
}
const reconciliationRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'commerce.customer-context' as const,
  resourceId,
  resourceType: 'commerce.customer-context.profile-reconciliation-case' as const,
  tenantId,
});
const bindingRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'commerce.customer-context' as const,
  resourceId,
  resourceType: 'commerce.customer-context.retail-portal-profile-binding' as const,
  tenantId,
});
const sellingLegalEntityRef = (scope: ProfilePersistenceScope) => ({
  moduleId: 'core.identity' as const,
  resourceId: scope.legalEntityId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId: scope.tenantId,
});
const profileProvenance = (observedAt: string, revision: number) => [
  {
    freshness: {
      observedAt,
      revision: String(revision),
      sourceModuleId: 'commerce.customer-context',
      status: 'CURRENT' as const,
    },
    projection: 'PROFILE' as const,
  },
];
const profileFromPayload = (
  raw: typeof ProfilePayloadSchema.Type,
  scope: ProfilePersistenceScope,
): CommerceCustomerProfile => {
  if (raw.subject.kind === 'RETAIL') {
    return {
      createdAt: raw.createdAt,
      kind: 'RETAIL',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: raw.profileId,
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId: scope.tenantId,
      },
      revision: raw.revision,
      state: raw.state,
      stateChangedAt: raw.updatedAt,
      subject: {
        kind: 'RETAIL',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: raw.subject.partyResourceId,
          resourceType: 'party.registry.party',
          tenantId: scope.tenantId,
        },
        sellingLegalEntityRef: sellingLegalEntityRef(scope),
      },
      updatedAt: raw.updatedAt,
    };
  }
  return {
    createdAt: raw.createdAt,
    kind: 'COUNTERPARTY',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: raw.profileId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      tenantId: scope.tenantId,
    },
    revision: raw.revision,
    state: raw.state,
    stateChangedAt: raw.updatedAt,
    subject: {
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: raw.subject.counterpartyResourceId,
        resourceType: 'party.registry.counterparty',
        tenantId: scope.tenantId,
      },
      kind: 'COUNTERPARTY',
      sellingLegalEntityRef: sellingLegalEntityRef(scope),
    },
    updatedAt: raw.updatedAt,
  };
};

export type CounterpartyRoleEligibility =
  | {
      readonly managedLegalEntityId: string;
      readonly outcome: 'ELIGIBLE';
      readonly roleResourceId: string;
      readonly roleResourceRevision: string;
    }
  | { readonly outcome: 'INELIGIBLE' }
  | { readonly outcome: 'UNAVAILABLE' | 'INDETERMINATE' };

export class ProfilePersistenceDependencyFailure extends Schema.TaggedError<ProfilePersistenceDependencyFailure>()(
  'ProfilePersistenceDependencyFailure',
  { reason: Schema.String },
) {}

export interface ProfilePersistenceDependencies {
  readonly evaluateReactivation?: (payload: ProfileLifecyclePayload) => Effect.Effect<
    {
      readonly dependenciesSatisfied: boolean;
      readonly reconfirmationSatisfied: boolean;
    },
    ProfilePersistenceDependencyFailure
  >;
  readonly readRetailPermissions?: (input: {
    readonly bindingId: string;
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly profileId: string;
    readonly tenantId: string;
  }) => Effect.Effect<
    {
      readonly observedAt: string;
      readonly permissions: readonly RetailPortalPermissionCode[];
      readonly revision?: string;
    },
    ProfilePersistenceDependencyFailure
  >;
  readonly reconciliationOwnerVerifier?: ProfileReconciliationOwnerVerifierService;
  readonly resolveCounterpartyRole?: (input: {
    readonly counterpartyResourceId: string;
    readonly tenantId: string;
  }) => Effect.Effect<CounterpartyRoleEligibility, ProfilePersistenceDependencyFailure>;
  readonly resolveRetailParty?: (input: {
    readonly partyResourceId: string;
    readonly tenantId: string;
  }) => Effect.Effect<
    | {
        readonly outcome: 'CURRENT_PARTY_RESOLVED';
        readonly partyResourceId: string;
        readonly partyResourceRevision: string;
      }
    | { readonly outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' },
    ProfilePersistenceDependencyFailure
  >;
  readonly resolveGuestParty?: (input: {
    readonly correlationRoot: string;
    readonly guestEvidenceRef: string;
    readonly legalEntityId: string;
    readonly requestedAt: string;
    readonly tenantId: string;
  }) => Effect.Effect<GuestPartyResolutionOutcome, ProfilePersistenceDependencyFailure>;
}

const ensureServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies,
): EnsureRetailCustomerProfileServices => ({
  ensure: (payload, context) => {
    if (
      payload.subject.sellingLegalEntityRef.resourceId !== scope.legalEntityId ||
      payload.subject.partyRef.tenantId !== scope.tenantId ||
      context.scope.tenantId !== scope.tenantId ||
      context.scope.legalEntityId !== scope.legalEntityId
    ) {
      return Effect.fail(
        new EnsureRetailCustomerProfileRejected({
          code: 'SUBJECT_NOT_RESOLVED_OR_INVALID',
          reason: 'Retail profile creation must use the verified Tenant and Selling Legal Entity',
          retryable: false,
        }),
      );
    }
    const resolveParty = dependencies.resolveRetailParty;
    if (resolveParty === undefined) {
      return Effect.fail(
        new EnsureRetailCustomerProfileRejected({
          code: 'DEPENDENCY_UNAVAILABLE',
          reason: 'Current Party Registry owner identity is unavailable',
          retryable: true,
        }),
      );
    }
    return resolveParty({
      partyResourceId: payload.subject.partyRef.resourceId,
      tenantId: scope.tenantId,
    }).pipe(
      Effect.mapError((cause) =>
        preserveFailureCause(
          new EnsureRetailCustomerProfileRejected({
            code: 'DEPENDENCY_UNAVAILABLE',
            reason: 'Current Party Registry owner identity is unavailable',
            retryable: true,
          }),
          cause,
        ),
      ),
      Effect.flatMap((partyResolution) => {
        if (partyResolution.outcome !== 'CURRENT_PARTY_RESOLVED') {
          return Effect.fail(
            new EnsureRetailCustomerProfileRejected({
              code: 'SUBJECT_NOT_RESOLVED_OR_INVALID',
              reason: 'The authenticated Retail subject is not the current canonical Party',
              retryable: false,
            }),
          );
        }
        return transaction
          .invoke(ensureRetailProfileRoutine, [
            payload.subject.partyRef.resourceId,
            partyResolution.partyResourceRevision,
            payload.trigger === 'GUEST_RETAIL_ATTRIBUTION' ? 'GUEST_ACCEPTANCE' : 'AUTHENTICATED',
            payload.effectiveAt,
            payload.trigger,
            context.actionInvocationId,
            scope.principalId,
          ])
          .pipe(
            Effect.mapError(
              (failure) =>
                new EnsureRetailCustomerProfileRejected({
                  code: 'PERSISTENCE_UNAVAILABLE',
                  reason: routineFailureReason(failure),
                  retryable: true,
                }),
            ),
            Effect.flatMap(
              ([row]): Effect.Effect<
                EnsureRetailCustomerProfileResult,
                EnsureRetailCustomerProfileRejected
              > => {
                if (row === undefined) {
                  return Effect.fail(
                    new EnsureRetailCustomerProfileRejected({
                      code: 'OUTCOME_INDETERMINATE',
                      reason: 'The Retail profile routine returned no durable outcome',
                      retryable: true,
                    }),
                  );
                }
                if (
                  row.payload !== null &&
                  Schema.is(EnsureRetailCustomerProfileResultSchema)(row.payload)
                ) {
                  return Effect.succeed(row.payload);
                }
                const code = row.outcome;
                return Effect.fail(
                  new EnsureRetailCustomerProfileRejected({
                    code:
                      code === 'SUBJECT_NOT_RESOLVED_OR_INVALID' ||
                      code === 'PROFILE_KIND_OR_SUBJECT_CONFLICT' ||
                      code === 'PROFILE_RECONCILIATION_REQUIRED' ||
                      code === 'CURRENT_STATE_CONFLICT'
                        ? code
                        : 'OUTCOME_INDETERMINATE',
                    reason: 'The Retail profile could not be ensured from current scoped state',
                    retryable: false,
                  }),
                );
              },
            ),
          );
      }),
    );
  },
});

const counterpartyServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies,
): CreateCounterpartyPurchasingProfileServices => ({
  create: (payload, context) => {
    if (
      payload.subject.counterpartyRef.tenantId !== scope.tenantId ||
      context.scope.tenantId !== scope.tenantId ||
      context.scope.legalEntityId !== scope.legalEntityId
    ) {
      return Effect.fail(
        new CreateCounterpartyPurchasingProfileRejected({
          code: 'SUBJECT_NOT_RESOLVED_OR_INVALID',
          reason: 'Counterparty profile creation must use the verified scope',
          retryable: false,
        }),
      );
    }
    const resolveRole = dependencies.resolveCounterpartyRole;
    if (resolveRole === undefined) {
      return Effect.fail(
        new CreateCounterpartyPurchasingProfileRejected({
          code: 'DEPENDENCY_UNAVAILABLE',
          reason: 'Current Counterparty customer-role evidence is unavailable',
          retryable: true,
        }),
      );
    }
    return resolveRole({
      counterpartyResourceId: payload.subject.counterpartyRef.resourceId,
      tenantId: scope.tenantId,
    }).pipe(
      Effect.mapError((cause) =>
        preserveFailureCause(
          new CreateCounterpartyPurchasingProfileRejected({
            code: 'DEPENDENCY_UNAVAILABLE',
            reason: 'Current Counterparty customer-role evidence is unavailable',
            retryable: true,
          }),
          cause,
        ),
      ),
      Effect.flatMap((eligibility) => {
        if (
          eligibility.outcome !== 'ELIGIBLE' ||
          eligibility.managedLegalEntityId !== scope.legalEntityId
        ) {
          return Effect.fail(
            new CreateCounterpartyPurchasingProfileRejected({
              code:
                eligibility.outcome === 'INELIGIBLE' ||
                (eligibility.outcome === 'ELIGIBLE' &&
                  eligibility.managedLegalEntityId !== scope.legalEntityId)
                  ? 'COUNTERPARTY_ROLE_NOT_ELIGIBLE'
                  : 'DEPENDENCY_UNAVAILABLE',
              reason: 'A current Party-owned customer role is required',
              retryable: eligibility.outcome !== 'INELIGIBLE' && eligibility.outcome !== 'ELIGIBLE',
            }),
          );
        }
        return transaction
          .invoke(ensureCounterpartyProfileRoutine, [
            payload.subject.counterpartyRef.resourceId,
            null,
            eligibility.roleResourceId,
            eligibility.roleResourceRevision,
            payload.effectiveAt,
            payload.trigger,
            context.actionInvocationId,
            scope.principalId,
          ])
          .pipe(
            Effect.mapError(
              (failure) =>
                new CreateCounterpartyPurchasingProfileRejected({
                  code: 'PERSISTENCE_UNAVAILABLE',
                  reason: routineFailureReason(failure),
                  retryable: true,
                }),
            ),
            Effect.flatMap(
              ([row]): Effect.Effect<
                CreateCounterpartyPurchasingProfileResult,
                CreateCounterpartyPurchasingProfileRejected
              > => {
                if (
                  row?.payload !== null &&
                  row?.payload !== undefined &&
                  Schema.is(CreateCounterpartyPurchasingProfileResultSchema)(row.payload)
                ) {
                  return Effect.succeed(row.payload);
                }
                const code = row?.outcome;
                return Effect.fail(
                  new CreateCounterpartyPurchasingProfileRejected({
                    code:
                      code === 'COUNTERPARTY_ROLE_NOT_ELIGIBLE' ||
                      code === 'PROFILE_RECONCILIATION_REQUIRED' ||
                      code === 'CURRENT_STATE_CONFLICT'
                        ? code
                        : 'OUTCOME_INDETERMINATE',
                    reason:
                      'The Counterparty profile could not be created from current scoped state',
                    retryable: row === undefined,
                  }),
                );
              },
            ),
          );
      }),
    );
  },
});

const lifecycleServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: ProfileLifecycleOperation,
  dependencies: ProfilePersistenceDependencies,
): ProfileLifecycleServices => ({
  transition: (payload, context) => {
    if (
      payload.profileRef.tenantId !== scope.tenantId ||
      context.scope.tenantId !== scope.tenantId ||
      context.scope.legalEntityId !== scope.legalEntityId
    ) {
      return Effect.fail(
        new ProfileLifecycleActionRejected({
          code: 'CURRENT_STATE_CONFLICT',
          reason: 'Profile transition must use the verified scope',
          retryable: false,
        }),
      );
    }
    let evaluation: Effect.Effect<
      { readonly dependenciesSatisfied: boolean; readonly reconfirmationSatisfied: boolean },
      ProfilePersistenceDependencyFailure
    >;
    if (operation === 'REACTIVATE') {
      const { evaluateReactivation } = dependencies;
      if (evaluateReactivation === undefined) {
        return Effect.fail(
          new ProfileLifecycleActionRejected({
            code: 'OUTCOME_INDETERMINATE',
            reason: 'Current reactivation dependencies could not be evaluated',
            retryable: true,
          }),
        );
      }
      evaluation = evaluateReactivation(payload);
    } else {
      evaluation = Effect.succeed({
        dependenciesSatisfied: true,
        reconfirmationSatisfied: true,
      });
    }
    return evaluation.pipe(
      Effect.mapError((cause) =>
        preserveFailureCause(
          new ProfileLifecycleActionRejected({
            code: 'OUTCOME_INDETERMINATE',
            reason: 'Current reactivation dependencies could not be evaluated',
            retryable: true,
          }),
          cause,
        ),
      ),
      Effect.flatMap((eligibility) =>
        transaction
          .invoke(transitionProfileRoutine, [
            payload.profileRef.resourceId,
            profileKind(payload.profileRef),
            payload.expectedState,
            payload.expectedRevision,
            targetState(operation),
            payload.effectiveAt,
            payload.reason,
            eligibility.dependenciesSatisfied,
            eligibility.reconfirmationSatisfied,
            context.actionInvocationId,
            scope.principalId,
          ])
          .pipe(
            Effect.mapError(
              (failure) =>
                new ProfileLifecycleActionRejected({
                  code: 'PERSISTENCE_UNAVAILABLE',
                  reason: routineFailureReason(failure),
                  retryable: true,
                }),
            ),
          ),
      ),
      Effect.flatMap(([row]) => {
        if (
          row?.payload !== null &&
          row?.payload !== undefined &&
          Schema.is(ProfileLifecycleResultSchema)(row.payload)
        ) {
          return Effect.succeed(row.payload);
        }
        const code = row?.outcome;
        return Effect.fail(
          new ProfileLifecycleActionRejected({
            code:
              code === 'PROFILE_NOT_FOUND' ||
              code === 'INVALID_LIFECYCLE_TRANSITION' ||
              code === 'CURRENT_STATE_CONFLICT' ||
              code === 'PROFILE_RECONCILIATION_REQUIRED' ||
              code === 'REACTIVATION_RECONFIRMATION_REQUIRED'
                ? code
                : 'OUTCOME_INDETERMINATE',
            reason: 'The lifecycle transition was rejected by current scoped state',
            retryable: row === undefined,
          }),
        );
      }),
    );
  },
});

function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'BIND',
): BindRetailPortalProfileServices;
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'RECOVER',
): RecoverRetailPortalProfileBindingServices;
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'REVOKE',
): RevokeRetailPortalProfileBindingServices;
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'BIND' | 'RECOVER' | 'REVOKE',
):
  | BindRetailPortalProfileServices
  | RecoverRetailPortalProfileBindingServices
  | RevokeRetailPortalProfileBindingServices {
  const mutate = (
    payload: RetailPortalBindingPayload,
    actionInvocationId: string,
  ): Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected> => {
    if (
      scope.authBindingId === undefined ||
      payload.profileRef.tenantId !== scope.tenantId ||
      payload.principalRef.resourceId !== scope.principalId ||
      payload.principalRef.tenantId !== scope.tenantId ||
      payload.sellingLegalEntityRef.resourceId !== scope.legalEntityId
    ) {
      return Effect.fail(
        new RetailPortalBindingActionRejected({
          code: scope.authBindingId === undefined ? 'DEPENDENCY_UNAVAILABLE' : 'BINDING_CONFLICT',
          reason: 'A current verified authentication binding and exact profile scope are required',
          retryable: scope.authBindingId === undefined,
        }),
      );
    }
    return transaction
      .invoke(mutateBindingRoutine, [
        payload.profileRef.resourceId,
        payload.principalRef.resourceId,
        scope.authBindingId,
        payload.enrollmentEvidenceRef,
        payload.expectedState,
        payload.expectedRevision,
        operation,
        payload.effectiveAt,
        payload.reason,
        actionInvocationId,
        scope.principalId,
      ])
      .pipe(
        Effect.mapError(
          (failure) =>
            new RetailPortalBindingActionRejected({
              code: 'PERSISTENCE_UNAVAILABLE',
              reason: routineFailureReason(failure),
              retryable: true,
            }),
        ),
        Effect.flatMap(
          ([row]): Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected> => {
            if (
              row?.payload !== null &&
              row?.payload !== undefined &&
              Schema.is(RetailPortalBindingResultSchema)(row.payload)
            ) {
              return Effect.succeed(row.payload);
            }
            const code = row?.outcome;
            return Effect.fail(
              new RetailPortalBindingActionRejected({
                code:
                  code === 'PROFILE_NOT_FOUND' ||
                  code === 'PROFILE_NOT_ACTIVE' ||
                  code === 'BINDING_NOT_FOUND' ||
                  code === 'BINDING_CONFLICT' ||
                  code === 'BINDING_AMBIGUOUS' ||
                  code === 'ENROLLMENT_EVIDENCE_INSUFFICIENT' ||
                  code === 'CURRENT_STATE_CONFLICT'
                    ? code
                    : 'OUTCOME_INDETERMINATE',
                reason: 'The Retail Portal binding mutation was rejected by current scoped state',
                retryable: row === undefined,
              }),
            );
          },
        ),
      );
  };
  if (operation === 'BIND') {
    return { bind: (payload, context) => mutate(payload, context.actionInvocationId) };
  }
  if (operation === 'RECOVER') {
    return { recover: (payload, context) => mutate(payload, context.actionInvocationId) };
  }
  return { revoke: (payload, context) => mutate(payload, context.actionInvocationId) };
}

const reconciliationServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies,
): {
  readonly open: OpenProfileReconciliationServices;
  readonly resolve: ResolveProfileReconciliationServices;
} => {
  const reject = (
    code: ProfileReconciliationActionRejected['code'],
    reason: string,
    retryable: boolean,
  ) => new ProfileReconciliationActionRejected({ code, reason, retryable });
  const readProgress = (
    payload: ResolveProfileReconciliationPayload,
    unavailableOwners: Parameters<
      ResolveProfileReconciliationServices['ownerReconciler']['finalize']
    >[2],
    conflictingOwners: Parameters<
      ResolveProfileReconciliationServices['ownerReconciler']['finalize']
    >[3],
  ): Effect.Effect<ResolveProfileReconciliationResult, ProfileReconciliationActionRejected> =>
    transaction.invoke(readReconciliationRoutine, [payload.caseRef.resourceId]).pipe(
      Effect.mapError((failure) =>
        reject('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
      ),
      Effect.flatMap(
        ([row]): Effect.Effect<
          ResolveProfileReconciliationResult,
          ProfileReconciliationActionRejected
        > => {
          if (row === undefined || row.outcome === 'RECONCILIATION_NOT_FOUND') {
            return Effect.fail(
              reject('RECONCILIATION_NOT_FOUND', 'The reconciliation case does not exist', false),
            );
          }
          if (row.payload === null || !Schema.is(ReconciliationPayloadSchema)(row.payload)) {
            return Effect.fail(
              reject(
                'OUTCOME_INDETERMINATE',
                'The durable reconciliation progress is invalid',
                false,
              ),
            );
          }
          if (row.payload.state === 'COMPLETED') {
            return Effect.fail(
              reject(
                'RECONCILIATION_OUT_OF_ORDER',
                'The reconciliation case is already completed',
                false,
              ),
            );
          }
          return Effect.succeed<ResolveProfileReconciliationResult>({
            caseRef: payload.caseRef,
            conflictingOwners,
            lastProcessedEventVersion: BigInt(row.payload.lastProcessedEventVersion),
            outcome: 'RECONCILIATION_PROGRESS_RECORDED',
            ownerOutcomes: row.payload.ownerOutcomes,
            revision: row.payload.revision,
            state: row.payload.state,
            unavailableOwners,
          });
        },
      ),
    );

  const ownerVerifier =
    dependencies.reconciliationOwnerVerifier ?? profileReconciliationOwnerVerifierUnavailable;

  return {
    open: {
      open: (payload, context) => {
        if (
          context.scope.legalEntityId !== scope.legalEntityId ||
          payload.profileRefs.some(({ tenantId }) => tenantId !== scope.tenantId)
        ) {
          return Effect.fail(
            new ProfileReconciliationActionRejected({
              code: 'CROSS_LEGAL_ENTITY_RECONCILIATION_FORBIDDEN',
              reason: 'All reconciliation members must use the verified Selling Legal Entity',
              retryable: false,
            }),
          );
        }
        return transaction
          .invoke(openReconciliationRoutine, [
            payload.profileRefs.map(({ resourceId }) => resourceId),
            payload.evidenceRef,
            payload.trigger,
            payload.targetSubject,
            payload.canonicalizationEvidence,
            payload.detectedAt,
            payload.reason,
            context.actionInvocationId,
            scope.principalId,
          ])
          .pipe(
            Effect.mapError(
              (failure) =>
                new ProfileReconciliationActionRejected({
                  code: 'PERSISTENCE_UNAVAILABLE',
                  reason: routineFailureReason(failure),
                  retryable: true,
                }),
            ),
            Effect.flatMap(
              ([row]): Effect.Effect<
                OpenProfileReconciliationResult,
                ProfileReconciliationActionRejected
              > => {
                if (
                  row?.payload !== null &&
                  row?.payload !== undefined &&
                  Schema.is(OpenProfileReconciliationResultSchema)(row.payload)
                ) {
                  return Effect.succeed(row.payload);
                }
                const code = row?.outcome;
                return Effect.fail(
                  new ProfileReconciliationActionRejected({
                    code:
                      code === 'PROFILE_NOT_FOUND' || code === 'CURRENT_STATE_CONFLICT'
                        ? code
                        : 'OUTCOME_INDETERMINATE',
                    reason: 'The reconciliation case could not be opened from current scoped state',
                    retryable: row === undefined,
                  }),
                );
              },
            ),
          );
      },
    },
    resolve: {
      ownerReconciler: {
        load: (caseRef, context) => {
          if (caseRef.tenantId !== scope.tenantId || context.scope.tenantId !== scope.tenantId) {
            return Effect.fail(
              reject('CURRENT_STATE_CONFLICT', 'The reconciliation case is outside scope', false),
            );
          }
          return transaction.invoke(readReconciliationRoutine, [caseRef.resourceId]).pipe(
            Effect.mapError((failure) =>
              reject('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
            ),
            Effect.flatMap(([row]) => {
              if (row?.payload !== null && Schema.is(ReconciliationPayloadSchema)(row?.payload)) {
                if (row.payload.state === 'COMPLETED') {
                  return Effect.fail(
                    reject(
                      'RECONCILIATION_OUT_OF_ORDER',
                      'The reconciliation case is already completed',
                      false,
                    ),
                  );
                }
                return Effect.succeed<ProfileReconciliationDurableProgress>({
                  caseRef,
                  lastProcessedEventVersion: BigInt(row.payload.lastProcessedEventVersion),
                  ownerOutcomes: row.payload.ownerOutcomes,
                  revision: row.payload.revision,
                  state: row.payload.state,
                });
              }
              return Effect.fail(
                reject(
                  row?.outcome === 'RECONCILIATION_NOT_FOUND'
                    ? 'RECONCILIATION_NOT_FOUND'
                    : 'OUTCOME_INDETERMINATE',
                  'The durable reconciliation progress could not be loaded',
                  row === undefined,
                ),
              );
            }),
          );
        },
        finalize: (
          payload,
          expectedCaseRevision,
          unavailableOwners,
          conflictingOwners,
          context,
        ) => {
          if (unavailableOwners.length > 0 || conflictingOwners.length > 0) {
            return readProgress(payload, unavailableOwners, conflictingOwners);
          }
          return transaction
            .invoke(resolveReconciliationRoutine, [
              payload.caseRef.resourceId,
              payload.survivorProfileRef.resourceId,
              expectedCaseRevision,
              payload.expectedEventVersion,
              payload.ownerOutcomes,
              payload.resultingState,
              payload.effectiveAt,
              payload.reason,
              context.actionInvocationId,
              scope.principalId,
            ])
            .pipe(
              Effect.mapError((failure) =>
                reject('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
              ),
              Effect.flatMap(([row]) => {
                if (
                  row?.payload !== null &&
                  row?.payload !== undefined &&
                  Schema.is(ResolveProfileReconciliationResultSchema)(row.payload)
                ) {
                  return Effect.succeed(row.payload);
                }
                if (row?.outcome === 'RECONCILIATION_INCOMPLETE') {
                  return readProgress(payload, unavailableOwners, conflictingOwners);
                }
                const code = row?.outcome;
                return Effect.fail(
                  reject(
                    code === 'RECONCILIATION_NOT_FOUND' ||
                      code === 'RECONCILIATION_OUT_OF_ORDER' ||
                      code === 'CURRENT_STATE_CONFLICT'
                      ? code
                      : 'OUTCOME_INDETERMINATE',
                    'The reconciliation case could not be finalized',
                    row === undefined || code === 'RECONCILIATION_OUT_OF_ORDER',
                  ),
                );
              }),
            );
        },
        record: (
          request: ProfileReconciliationOwnerOutcomeRecordRequest,
          context,
        ): Effect.Effect<
          ProfileReconciliationDurableProgress,
          ProfileReconciliationActionRejected
        > =>
          transaction
            .invoke(recordReconciliationOwnerOutcomeRoutine, [
              request.caseRef.resourceId,
              request.survivorProfileRef.resourceId,
              request.resultingState,
              request.durableOutcome.owner,
              request.durableOutcome.status,
              request.durableOutcome.evidenceRef,
              request.expectedCaseRevision,
              request.expectedEventVersion,
              request.correlationRef,
              request.effectiveAt,
              request.reason,
              context.actionInvocationId,
              scope.principalId,
            ])
            .pipe(
              Effect.mapError((failure) =>
                reject('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
              ),
              Effect.flatMap(
                ([row]): Effect.Effect<
                  ProfileReconciliationDurableProgress,
                  ProfileReconciliationActionRejected
                > => {
                  if (
                    row?.payload !== null &&
                    row?.payload !== undefined &&
                    Schema.is(ProfileReconciliationDurableProgressSchema)(row.payload)
                  ) {
                    return Effect.succeed(row.payload);
                  }
                  const code = row?.outcome;
                  return Effect.fail(
                    reject(
                      code === 'RECONCILIATION_NOT_FOUND' ||
                        code === 'RECONCILIATION_OUT_OF_ORDER' ||
                        code === 'CURRENT_STATE_CONFLICT'
                        ? code
                        : 'OUTCOME_INDETERMINATE',
                      'The trusted owner outcome could not be recorded',
                      row === undefined || code === 'RECONCILIATION_OUT_OF_ORDER',
                    ),
                  );
                },
              ),
            ),
      },
      ownerVerifier,
    },
  };
};

const guestServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies,
): AttributeGuestRetailCustomerServices => ({
  attribute: (payload, context) => {
    if (payload.sellingLegalEntityRef.resourceId !== scope.legalEntityId) {
      return Effect.fail(
        new AttributeGuestRetailCustomerRejected({
          code: 'CURRENT_STATE_CONFLICT',
          reason: 'Guest attribution must use the verified Selling Legal Entity',
          retryable: false,
        }),
      );
    }
    const resolver = dependencies.resolveGuestParty;
    if (resolver === undefined) {
      return Effect.fail(
        new AttributeGuestRetailCustomerRejected({
          code: 'PARTY_REGISTRY_UNAVAILABLE',
          reason: 'The Party attribution owner is unavailable',
          retryable: true,
        }),
      );
    }
    return resolver({
      correlationRoot: payload.correlationRoot,
      guestEvidenceRef: payload.guestEvidenceRef,
      legalEntityId: scope.legalEntityId,
      requestedAt: payload.requestedAt,
      tenantId: scope.tenantId,
    }).pipe(
      Effect.mapError((cause) =>
        preserveFailureCause(
          new AttributeGuestRetailCustomerRejected({
            code: 'PARTY_REGISTRY_UNAVAILABLE',
            reason: 'The Party attribution owner is unavailable',
            retryable: true,
          }),
          cause,
        ),
      ),
      Effect.flatMap((partyResolution) => {
        if (
          partyResolution.outcome === 'PARTY_OWNER_UNAVAILABLE' ||
          partyResolution.outcome === 'PARTY_OWNER_INDETERMINATE'
        ) {
          return Effect.fail(
            new AttributeGuestRetailCustomerRejected({
              code: 'PARTY_REGISTRY_UNAVAILABLE',
              reason: 'The Party attribution outcome is not determinate',
              retryable: true,
            }),
          );
        }
        const actionResult: AttributeGuestRetailCustomerResult =
          partyResolution.outcome === 'AMBIGUOUS_MATCH'
            ? { outcome: 'PARTY_AMBIGUOUS', reconciliationRef: partyResolution.caseRef }
            : partyResolution.outcome === 'INVALID_OR_INSUFFICIENT_EVIDENCE'
              ? { outcome: 'PARTY_INVALID' }
              : { outcome: 'PARTY_UNRESOLVED' };
        if (
          partyResolution.outcome === 'EXISTING_PARTY_RESOLVED' ||
          partyResolution.outcome === 'UNRESOLVED_PARTY_CREATED'
        ) {
          if (partyResolution.partyRef.tenantId !== scope.tenantId) {
            return Effect.fail(
              new AttributeGuestRetailCustomerRejected({
                code: 'CURRENT_STATE_CONFLICT',
                reason: 'The Party attribution owner returned a Party outside the trusted Tenant',
                retryable: false,
              }),
            );
          }
          return transaction
            .invoke(ensureRetailProfileRoutine, [
              partyResolution.partyRef.resourceId,
              null,
              'GUEST_ACCEPTANCE',
              payload.requestedAt,
              'GUEST_RETAIL_ATTRIBUTION',
              context.actionInvocationId,
              scope.principalId,
            ])
            .pipe(
              Effect.mapError(
                (failure) =>
                  new AttributeGuestRetailCustomerRejected({
                    code: 'PERSISTENCE_UNAVAILABLE',
                    reason: routineFailureReason(failure),
                    retryable: true,
                  }),
              ),
              Effect.flatMap(([profileRow]) => {
                if (
                  profileRow?.payload === null ||
                  profileRow?.payload === undefined ||
                  !Schema.is(EnsureRetailCustomerProfileResultSchema)(profileRow.payload)
                ) {
                  return Effect.fail(
                    new AttributeGuestRetailCustomerRejected({
                      code:
                        profileRow?.outcome === 'PROFILE_RECONCILIATION_REQUIRED'
                          ? 'PROFILE_RECONCILIATION_REQUIRED'
                          : 'OUTCOME_INDETERMINATE',
                      reason: 'Guest Retail profile creation did not reach a determinate state',
                      retryable: profileRow === undefined,
                    }),
                  );
                }
                if (
                  profileRow.payload.outcome === 'PROFILE_ALREADY_EXISTS_ARCHIVED' ||
                  profileRow.payload.outcome === 'PROFILE_ALREADY_EXISTS_SUSPENDED'
                ) {
                  return recordGuestResult(
                    transaction,
                    scope,
                    payload,
                    { outcome: 'PROFILE_NOT_ACTIVE' },
                    context.actionInvocationId,
                  );
                }
                const attributed: AttributeGuestRetailCustomerResult = {
                  outcome: 'ATTRIBUTED',
                  partyRef: partyResolution.partyRef,
                  profileRef: profileRow.payload.profileRef,
                };
                return recordGuestResult(
                  transaction,
                  scope,
                  payload,
                  attributed,
                  context.actionInvocationId,
                );
              }),
            );
        }
        return recordGuestResult(
          transaction,
          scope,
          payload,
          actionResult,
          context.actionInvocationId,
        );
      }),
    );
  },
});

const recordGuestResult = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  payload: Parameters<AttributeGuestRetailCustomerServices['attribute']>[0],
  result: AttributeGuestRetailCustomerResult,
  actionInvocationId: string,
): Effect.Effect<AttributeGuestRetailCustomerResult, AttributeGuestRetailCustomerRejected> =>
  transaction
    .invoke(recordGuestAttributionRoutine, [
      payload.correlationRoot,
      payload.guestEvidenceRef,
      result.outcome,
      result.outcome === 'ATTRIBUTED' ? result.partyRef.resourceId : null,
      result.outcome === 'ATTRIBUTED' ? result.profileRef.resourceId : null,
      result.outcome === 'PARTY_AMBIGUOUS' ? result.reconciliationRef : null,
      payload.requestedAt,
      actionInvocationId,
      scope.principalId,
    ])
    .pipe(
      Effect.mapError(
        (failure) =>
          new AttributeGuestRetailCustomerRejected({
            code: 'PERSISTENCE_UNAVAILABLE',
            reason: routineFailureReason(failure),
            retryable: true,
          }),
      ),
      Effect.flatMap(([row]) =>
        row?.outcome === 'RECORDED' || row?.outcome === 'UNCHANGED'
          ? Effect.succeed(result)
          : Effect.fail(
              new AttributeGuestRetailCustomerRejected({
                code:
                  row?.outcome === 'CURRENT_STATE_CONFLICT'
                    ? 'CURRENT_STATE_CONFLICT'
                    : 'OUTCOME_INDETERMINATE',
                reason: 'Guest attribution correlation conflicts with durable current state',
                retryable: row === undefined,
              }),
            ),
      ),
    );

const readServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies,
): {
  readonly customerProfileRead: CustomerProfileReadServices;
  readonly customerProfileTradingGate: CustomerProfileTradingGateServices;
  readonly guestAttributionStatus: GuestAttributionStatusServices;
  readonly profileReconciliationRead: ProfileReconciliationReadServices;
  readonly retailAccessDecision: RetailAccessDecisionServices;
  readonly retailPortalProfileBindingRead: RetailPortalProfileBindingReadServices;
  readonly retailPrincipalResolution: RetailPrincipalResolutionServices;
} => {
  const readProfile = (
    input: Parameters<CustomerProfileReadServices['readProfile']>[0],
  ): Effect.Effect<CustomerProfileReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
    transaction
      .invoke(readProfileRoutine, [input.profileRef.resourceId, profileKind(input.profileRef)])
      .pipe(
        Effect.mapError(readUnavailableFromRoutineFailure),
        Effect.flatMap(
          ([row]): Effect.Effect<
            CustomerProfileReadResponse,
            ReadHandlerNotFound | ReadHandlerUnavailable
          > => {
            if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND') {
              return Effect.fail(
                readNotFound('The Customer Profile does not exist in the verified scope'),
              );
            }
            if (row.outcome === 'PROFILE_RECONCILIATION_REQUIRED') {
              if (
                row.payload === null ||
                !Schema.is(ProfileReconciliationRequiredPayloadSchema)(row.payload)
              ) {
                return Effect.fail(
                  readUnavailable('The Customer Profile reconciliation projection is invalid'),
                );
              }
              const raw = row.payload;
              return succeedCustomerProfileRead({
                _tag: 'PROFILE_RECONCILIATION_REQUIRED' as const,
                profileRef: input.profileRef,
                provenance: profileProvenance(raw.observedAt, raw.revision),
                reconciliationCaseRef: Option.some(reconciliationRef(scope.tenantId, raw.caseId)),
                targetSubject: raw.targetSubject,
              });
            }
            if (
              row.payload === null ||
              !Schema.is(ProfilePayloadSchema)(row.payload) ||
              (row.payload.scopeLegalEntityId !== undefined &&
                row.payload.scopeLegalEntityId !== scope.legalEntityId)
            ) {
              return Effect.fail(readUnavailable('The Customer Profile projection is invalid'));
            }
            const profile = profileFromPayload(row.payload, scope);
            return succeedCustomerProfileRead({
              _tag: 'PROFILE_AVAILABLE' as const,
              completeness: 'PARTIAL' as const,
              profile,
              provenance: [
                ...profileProvenance(row.payload.updatedAt, row.payload.revision),
                {
                  freshness: {
                    observedAt: row.payload.updatedAt,
                    sourceModuleId: 'party.registry',
                    status: 'UNAVAILABLE' as const,
                  },
                  projection: 'PARTY_REGISTRY' as const,
                },
              ],
              unavailableSections: [
                'PARTY_IDENTITY',
                'AUTHORIZATION',
                'COMMERCE_SETTINGS',
              ] as const,
            });
          },
        ),
      );

  const readRetailPermissionProjection = (
    bindingId: string,
    profileId: string,
    principalId: string,
    observedAt: string,
  ): Effect.Effect<RetailPermissionProjection> => {
    const readPermissions = dependencies.readRetailPermissions;
    if (readPermissions === undefined) {
      return Effect.succeed({
        freshness: {
          observedAt,
          sourceModuleId: 'core.identity' as const,
          status: 'UNAVAILABLE' as const,
        },
        permissions: [],
      });
    }
    return readPermissions({
      bindingId,
      legalEntityId: scope.legalEntityId,
      principalId,
      profileId,
      tenantId: scope.tenantId,
    }).pipe(
      Effect.map(({ observedAt: permissionObservedAt, permissions, revision }) => ({
        freshness: {
          observedAt: permissionObservedAt,
          ...(revision === undefined ? {} : { revision }),
          sourceModuleId: 'core.identity' as const,
          status: 'CURRENT' as const,
        },
        permissions,
      })),
      Effect.orElseSucceed(() => ({
        freshness: {
          observedAt,
          sourceModuleId: 'core.identity' as const,
          status: 'UNAVAILABLE' as const,
        },
        permissions: [],
      })),
    );
  };

  const deniedRetailAccess = (
    input: RetailAccessDecisionRequest,
    decision: Exclude<RetailAccessDecisionResponse['decision'], { readonly allowed: true }>,
    authorizationFreshness: RetailAccessDecisionResponse['authorizationFreshness'],
    resolvedBindingRef: RetailAccessDecisionResponse['bindingRef'],
    bindingState: RetailAccessDecisionResponse['bindingState'],
    provenance: RetailAccessDecisionResponse['provenance'],
  ): RetailAccessDecisionResponse => ({
    authorizationFreshness,
    bindingRef: resolvedBindingRef,
    bindingState,
    decision,
    evaluatedAt: authorizationFreshness.observedAt,
    profileRef: input.profileRef,
    provenance,
    requiredPermission: input.requiredPermission,
  });

  return {
    customerProfileRead: { readProfile: (input) => readProfile(input) },
    customerProfileTradingGate: {
      evaluateGate: (
        input,
      ): Effect.Effect<
        CustomerProfileTradingGateResponse,
        ReadHandlerNotFound | ReadHandlerUnavailable
      > =>
        transaction
          .invoke(readTradingGateRoutine, [
            input.profileRef.resourceId,
            profileKind(input.profileRef),
          ])
          .pipe(
            Effect.mapError(readUnavailableFromRoutineFailure),
            Effect.flatMap(
              ([row]): Effect.Effect<
                CustomerProfileTradingGateResponse,
                ReadHandlerNotFound | ReadHandlerUnavailable
              > => {
                if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND') {
                  return Effect.fail(
                    readNotFound('The Customer Profile does not exist in the verified scope'),
                  );
                }
                if (
                  row.payload === null ||
                  !Schema.is(ProfilePayloadSchema)(row.payload) ||
                  (row.payload.scopeLegalEntityId !== undefined &&
                    row.payload.scopeLegalEntityId !== scope.legalEntityId)
                ) {
                  return Effect.fail(
                    readUnavailable('The Customer Profile trading projection is invalid'),
                  );
                }
                const raw = row.payload;
                const profile = profileFromPayload(raw, scope);
                const profileReference = profileRef(scope.tenantId, raw.profileId, raw.profileKind);
                if (row.outcome === 'PROFILE_RECONCILIATION_REQUIRED') {
                  return succeedCustomerProfileTradingGate({
                    evaluatedAt: raw.updatedAt,
                    gate: { canAcceptNewOrder: false, outcome: 'RECONCILIATION_REQUIRED' as const },
                    profileRef: profileReference,
                    provenance: profileProvenance(raw.updatedAt, raw.revision),
                    revision: raw.revision,
                    state: raw.state,
                    subject: profile.subject,
                  });
                }

                if (profile.kind !== 'COUNTERPARTY') {
                  return succeedCustomerProfileTradingGate({
                    evaluatedAt: raw.updatedAt,
                    gate: { canAcceptNewOrder: profile.state === 'ACTIVE', outcome: profile.state },
                    profileRef: profileReference,
                    provenance: profileProvenance(raw.updatedAt, raw.revision),
                    revision: raw.revision,
                    state: raw.state,
                    subject: profile.subject,
                  });
                }

                const resolveRole = dependencies.resolveCounterpartyRole;
                if (resolveRole === undefined) {
                  return Effect.fail(
                    readUnavailable('Current Counterparty Role evidence is unavailable'),
                  );
                }
                return resolveRole({
                  counterpartyResourceId: profile.subject.counterpartyRef.resourceId,
                  tenantId: scope.tenantId,
                }).pipe(
                  Effect.mapError((cause) =>
                    readUnavailable(
                      `Current Counterparty Role evidence is unavailable (${String(cause)})`,
                    ),
                  ),
                  Effect.flatMap((eligibility) =>
                    DateTime.now.pipe(
                      Effect.map((now) => {
                        const evaluatedAt = DateTime.formatIso(now);
                        const eligibleForScope =
                          eligibility.outcome === 'ELIGIBLE' &&
                          eligibility.managedLegalEntityId === scope.legalEntityId;
                        const roleProvenance =
                          eligibility.outcome === 'ELIGIBLE' &&
                          eligibility.roleResourceId !== undefined
                            ? [
                                {
                                  freshness: {
                                    observedAt: evaluatedAt,
                                    revision: eligibility.roleResourceRevision,
                                    sourceModuleId: 'party.registry',
                                    status: eligibleForScope
                                      ? ('CURRENT' as const)
                                      : ('INDETERMINATE' as const),
                                  },
                                  projection: 'PARTY_REGISTRY' as const,
                                  sourceResourceRef: eligibility.roleResourceId,
                                },
                              ]
                            : [
                                {
                                  freshness: {
                                    observedAt: evaluatedAt,
                                    sourceModuleId: 'party.registry',
                                    status:
                                      eligibility.outcome === 'INELIGIBLE'
                                        ? ('CURRENT' as const)
                                        : ('UNAVAILABLE' as const),
                                  },
                                  projection: 'PARTY_REGISTRY' as const,
                                },
                              ];
                        const gate = eligibleForScope
                          ? {
                              canAcceptNewOrder: profile.state === 'ACTIVE',
                              outcome: profile.state,
                            }
                          : eligibility.outcome === 'INELIGIBLE' ||
                              (eligibility.outcome === 'ELIGIBLE' && !eligibleForScope)
                            ? {
                                canAcceptNewOrder: false,
                                outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE' as const,
                              }
                            : {
                                canAcceptNewOrder: false,
                                outcome: 'DEPENDENCY_UNAVAILABLE' as const,
                              };
                        return {
                          evaluatedAt,
                          gate,
                          profileRef: profileReference,
                          provenance: [
                            ...profileProvenance(raw.updatedAt, raw.revision),
                            ...roleProvenance,
                          ],
                          revision: raw.revision,
                          state: raw.state,
                          subject: profile.subject,
                        };
                      }),
                    ),
                  ),
                );
              },
            ),
          ),
    },
    guestAttributionStatus: {
      readStatus: (
        input,
      ): Effect.Effect<
        GuestAttributionStatusResponse,
        ReadHandlerNotFound | ReadHandlerUnavailable
      > =>
        transaction.invoke(readGuestAttributionRoutine, [input.attributionCorrelationId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<
              GuestAttributionStatusResponse,
              ReadHandlerNotFound | ReadHandlerUnavailable
            > => {
              if (row === undefined || row.outcome === 'ATTRIBUTION_NOT_FOUND')
                return Effect.fail(
                  readNotFound('The Guest attribution does not exist in the verified scope'),
                );
              if (row.payload === null || !Schema.is(GuestPayloadSchema)(row.payload))
                return Effect.fail(readUnavailable('The Guest attribution projection is invalid'));
              const raw = row.payload;
              const completed =
                raw.outcome === 'ATTRIBUTED' &&
                raw.partyResourceId !== null &&
                raw.profileId !== null;
              if (completed && raw.partyResourceId !== null && raw.profileId !== null) {
                const partyRef = {
                  moduleId: 'party.registry' as const,
                  resourceId: raw.partyResourceId,
                  resourceType: 'party.registry.party' as const,
                  tenantId: scope.tenantId,
                };
                const retailRef = profileRef(scope.tenantId, raw.profileId, 'RETAIL');
                return transaction.invoke(readTradingGateRoutine, [raw.profileId, 'RETAIL']).pipe(
                  Effect.mapError(readUnavailableFromRoutineFailure),
                  Effect.flatMap(([profileRow]) => {
                    if (
                      profileRow === undefined ||
                      profileRow.outcome === 'PROFILE_NOT_FOUND' ||
                      profileRow.outcome === 'PROFILE_RECONCILIATION_REQUIRED'
                    ) {
                      const reconciliationRequired =
                        profileRow?.outcome === 'PROFILE_RECONCILIATION_REQUIRED';
                      return succeedGuestAttributionStatus({
                        attributionCorrelationId: input.attributionCorrelationId,
                        observedAt: raw.observedAt,
                        outcome: {
                          canAcceptOrder: false,
                          outcome: reconciliationRequired
                            ? ('PROFILE_RECONCILIATION_REQUIRED' as const)
                            : ('PROFILE_NOT_ACTIVE' as const),
                          portalAccessGranted: false,
                        },
                        partyFreshness: {
                          observedAt: raw.observedAt,
                          sourceModuleId: 'party.registry',
                          status: 'CURRENT',
                        },
                        partyRef: Option.none(),
                        profileRef: Option.none(),
                        provenance: profileProvenance(raw.observedAt, 1),
                        sellingLegalEntityRef: input.sellingLegalEntityRef,
                      });
                    }
                    if (
                      profileRow.payload === null ||
                      !Schema.is(ProfilePayloadSchema)(profileRow.payload)
                    ) {
                      return Effect.fail(
                        readUnavailable('The Guest attribution trading projection is invalid'),
                      );
                    }
                    const profile = profileRow.payload;
                    if (profile.state !== 'ACTIVE') {
                      return succeedGuestAttributionStatus({
                        attributionCorrelationId: input.attributionCorrelationId,
                        observedAt: profile.updatedAt,
                        outcome: {
                          canAcceptOrder: false,
                          outcome: 'PROFILE_NOT_ACTIVE' as const,
                          portalAccessGranted: false,
                        },
                        partyFreshness: {
                          observedAt: raw.observedAt,
                          sourceModuleId: 'party.registry',
                          status: 'CURRENT',
                        },
                        partyRef: Option.none(),
                        profileRef: Option.none(),
                        provenance: profileProvenance(profile.updatedAt, profile.revision),
                        sellingLegalEntityRef: input.sellingLegalEntityRef,
                      });
                    }
                    return succeedGuestAttributionStatus({
                      attributionCorrelationId: input.attributionCorrelationId,
                      observedAt: profile.updatedAt,
                      outcome: {
                        canAcceptOrder: true,
                        outcome: 'ATTRIBUTION_COMPLETED',
                        partyRef,
                        portalAccessGranted: false,
                        profile: retailRef,
                      },
                      partyFreshness: {
                        observedAt: raw.observedAt,
                        sourceModuleId: 'party.registry',
                        status: 'CURRENT',
                      },
                      partyRef: Option.some(partyRef),
                      profileRef: Option.some(retailRef),
                      provenance: profileProvenance(profile.updatedAt, profile.revision),
                      sellingLegalEntityRef: input.sellingLegalEntityRef,
                    });
                  }),
                );
              }
              return succeedGuestAttributionStatus({
                attributionCorrelationId: input.attributionCorrelationId,
                observedAt: raw.observedAt,
                outcome: {
                  canAcceptOrder: false,
                  outcome:
                    raw.outcome === 'PARTY_AMBIGUOUS'
                      ? 'AMBIGUOUS_MATCH'
                      : raw.outcome === 'PROFILE_NOT_ACTIVE'
                        ? 'PROFILE_NOT_ACTIVE'
                        : 'INVALID_OR_INSUFFICIENT_EVIDENCE',
                  portalAccessGranted: false,
                },
                partyFreshness: {
                  observedAt: raw.observedAt,
                  sourceModuleId: 'party.registry',
                  status: 'INDETERMINATE',
                },
                partyRef: Option.none(),
                profileRef: Option.none(),
                provenance: profileProvenance(raw.observedAt, 1),
                sellingLegalEntityRef: input.sellingLegalEntityRef,
              });
            },
          ),
        ),
    },
    profileReconciliationRead: {
      readCase: (
        input,
      ): Effect.Effect<
        ProfileReconciliationReadResponse,
        ReadHandlerNotFound | ReadHandlerUnavailable
      > =>
        transaction
          .invoke(readReconciliationRoutine, [input.reconciliationCaseRef.resourceId])
          .pipe(
            Effect.mapError(readUnavailableFromRoutineFailure),
            Effect.flatMap(
              ([row]): Effect.Effect<
                ProfileReconciliationReadResponse,
                ReadHandlerNotFound | ReadHandlerUnavailable
              > => {
                if (row === undefined || row.outcome === 'RECONCILIATION_NOT_FOUND')
                  return Effect.fail(
                    readNotFound(
                      'The Profile Reconciliation Case does not exist in the verified scope',
                    ),
                  );
                if (row.payload === null || !Schema.is(ReconciliationPayloadSchema)(row.payload))
                  return Effect.fail(
                    readUnavailable('The Profile Reconciliation projection is invalid'),
                  );
                const raw = row.payload;
                const eventVersion = BigInt(raw.lastProcessedEventVersion);
                const ownerOutcomes = raw.ownerOutcomes;
                const involvedProfiles = raw.members.map((member) =>
                  profileRef(scope.tenantId, member.profileId, member.profileKind),
                );
                const survivorProfile =
                  raw.survivorProfileId === null
                    ? undefined
                    : profileRef(scope.tenantId, raw.survivorProfileId, raw.profileKind);
                return succeedProfileReconciliationRead({
                  case: {
                    caseRef: input.reconciliationCaseRef,
                    conflictingProfiles: involvedProfiles,
                    createdAt: raw.createdAt,
                    lastProcessedEventVersion: eventVersion,
                    ownerOutcomes,
                    reason: raw.reason,
                    ...(raw.resultingState === null ? {} : { resultingState: raw.resultingState }),
                    revision: raw.revision,
                    sourceCorrelationRef: raw.sourceCorrelationRef,
                    state: raw.state,
                    ...(survivorProfile === undefined ? {} : { survivorProfile }),
                    targetSubject: raw.targetSubject,
                    trigger: raw.trigger,
                    updatedAt: raw.updatedAt,
                  },
                  completion: {
                    complete: raw.state === 'COMPLETED',
                    outcome:
                      raw.state === 'COMPLETED'
                        ? ('ALREADY_COMPLETED' as const)
                        : ('RECONCILIATION_INCOMPLETE' as const),
                  },
                  involvedProfiles,
                  ownerOutcomes,
                  provenance: profileProvenance(raw.updatedAt, raw.revision),
                });
              },
            ),
          ),
    },
    retailAccessDecision: {
      decideAccess: (
        input,
        principalId,
        tenantId,
      ): Effect.Effect<
        RetailAccessDecisionResponse,
        ReadHandlerNotFound | ReadHandlerUnavailable
      > => {
        if (input.profileRef.tenantId !== tenantId || tenantId !== scope.tenantId) {
          return Effect.fail(
            readNotFound('The Retail Customer Profile does not exist in the trusted Tenant'),
          );
        }
        return transaction
          .invoke(resolvePrincipalRoutine, [input.profileRef.resourceId, principalId])
          .pipe(
            Effect.mapError(readUnavailableFromRoutineFailure),
            Effect.flatMap(
              ([principalRow]): Effect.Effect<
                RetailAccessDecisionResponse,
                ReadHandlerNotFound | ReadHandlerUnavailable
              > => {
                if (principalRow === undefined || principalRow.outcome === 'PROFILE_NOT_FOUND') {
                  return Effect.fail(
                    readNotFound(
                      'The Retail Customer Profile does not exist in the verified scope',
                    ),
                  );
                }
                if (
                  principalRow.payload === null ||
                  !Schema.is(PrincipalPayloadSchema)(principalRow.payload)
                ) {
                  return Effect.fail(
                    readUnavailable('The Retail Principal resolution projection is invalid'),
                  );
                }
                const principalPayload = principalRow.payload;
                const provenance = profileProvenance(
                  principalPayload.observedAt,
                  principalPayload.revision,
                );
                const currentOwnerFreshness = {
                  observedAt: principalPayload.observedAt,
                  sourceModuleId: 'commerce.customer-context' as const,
                  status: 'CURRENT' as const,
                };
                if (principalRow.outcome === 'RETAIL_PRINCIPAL_NOT_BOUND') {
                  return Effect.succeed(
                    deniedRetailAccess(
                      input,
                      { allowed: false, outcome: 'BINDING_NOT_FOUND' },
                      currentOwnerFreshness,
                      Option.none(),
                      Option.none(),
                      provenance,
                    ),
                  );
                }
                if (principalRow.outcome === 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS') {
                  return Effect.succeed(
                    deniedRetailAccess(
                      input,
                      { allowed: false, outcome: 'BINDING_AMBIGUOUS' },
                      currentOwnerFreshness,
                      Option.none(),
                      Option.none(),
                      provenance,
                    ),
                  );
                }
                if (principalPayload.bindingId === undefined) {
                  return Effect.fail(
                    readUnavailable('The Retail Principal binding reference is missing'),
                  );
                }
                const resolvedBindingRef = bindingRef(scope.tenantId, principalPayload.bindingId);
                return transaction
                  .invoke(readBindingRoutine, [principalPayload.bindingId, principalId])
                  .pipe(
                    Effect.mapError(readUnavailableFromRoutineFailure),
                    Effect.flatMap(
                      ([bindingRow]): Effect.Effect<
                        RetailAccessDecisionResponse,
                        ReadHandlerNotFound | ReadHandlerUnavailable
                      > => {
                        if (
                          bindingRow === undefined ||
                          bindingRow.outcome === 'BINDING_NOT_FOUND'
                        ) {
                          return Effect.succeed(
                            deniedRetailAccess(
                              input,
                              { allowed: false, outcome: 'BINDING_NOT_FOUND' },
                              {
                                ...currentOwnerFreshness,
                                status: 'INDETERMINATE' as const,
                              },
                              Option.some(resolvedBindingRef),
                              Option.none(),
                              provenance,
                            ),
                          );
                        }
                        if (bindingRow.outcome === 'BINDING_RECONCILIATION_REQUIRED') {
                          if (
                            bindingRow.payload === null ||
                            !Schema.is(BindingReconciliationRequiredPayloadSchema)(
                              bindingRow.payload,
                            )
                          ) {
                            return Effect.fail(
                              readUnavailable(
                                'The Retail Portal reconciliation projection is invalid',
                              ),
                            );
                          }
                          return Effect.succeed(
                            deniedRetailAccess(
                              input,
                              { allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' },
                              {
                                observedAt: bindingRow.payload.observedAt,
                                sourceModuleId: 'commerce.customer-context' as const,
                                status: 'INDETERMINATE' as const,
                              },
                              Option.some(resolvedBindingRef),
                              Option.none(),
                              [
                                ...provenance,
                                {
                                  freshness: {
                                    observedAt: bindingRow.payload.observedAt,
                                    revision: String(bindingRow.payload.revision),
                                    sourceModuleId: 'commerce.customer-context' as const,
                                    status: 'INDETERMINATE' as const,
                                  },
                                  projection: 'RETAIL_BINDING' as const,
                                },
                              ],
                            ),
                          );
                        }
                        if (
                          bindingRow.payload === null ||
                          !Schema.is(BindingPayloadSchema)(bindingRow.payload)
                        ) {
                          return Effect.fail(
                            readUnavailable('The Retail Portal binding projection is invalid'),
                          );
                        }
                        const raw = bindingRow.payload;
                        if (
                          raw.profileId !== input.profileRef.resourceId ||
                          raw.principalId !== principalId
                        ) {
                          return Effect.succeed(
                            deniedRetailAccess(
                              input,
                              { allowed: false, outcome: 'PROFILE_SCOPE_MISMATCH' },
                              {
                                ...currentOwnerFreshness,
                                status: 'INDETERMINATE' as const,
                              },
                              Option.some(resolvedBindingRef),
                              Option.some(raw.state),
                              provenance,
                            ),
                          );
                        }
                        if (
                          raw.authorizationOperation === undefined ||
                          raw.authorizationState === undefined
                        ) {
                          return Effect.succeed(
                            deniedRetailAccess(
                              input,
                              { allowed: false, outcome: 'AUTHORIZATION_UNAVAILABLE' },
                              {
                                observedAt: raw.updatedAt,
                                sourceModuleId: 'commerce.customer-context' as const,
                                status: 'INDETERMINATE' as const,
                              },
                              Option.some(resolvedBindingRef),
                              Option.some(raw.state),
                              provenance,
                            ),
                          );
                        }
                        const authorizationOperation: RetailPortalBindingAuthorizationOperation =
                          raw.authorizationOperation;
                        const authorizationStateFromBinding: RetailPortalBindingAuthorizationState =
                          raw.authorizationState;
                        return transaction
                          .invoke(readBindingAuthorizationRoutine, [
                            raw.bindingId,
                            authorizationOperation,
                          ])
                          .pipe(
                            Effect.mapError(readUnavailableFromRoutineFailure),
                            Effect.flatMap(
                              ([authorizationRow]): Effect.Effect<
                                RetailAccessDecisionResponse,
                                ReadHandlerNotFound | ReadHandlerUnavailable
                              > => {
                                const authorization =
                                  authorizationRow?.outcome === 'AUTHORIZATION_AVAILABLE' &&
                                  authorizationRow.payload !== null &&
                                  Schema.is(BindingAuthorizationPayloadSchema)(
                                    authorizationRow.payload,
                                  )
                                    ? authorizationRow.payload
                                    : undefined;
                                const authorizationState =
                                  authorization?.authorizationState ??
                                  authorizationStateFromBinding ??
                                  (raw.state === 'REVOKED' ? 'REVOKED' : 'RECONCILIATION_REQUIRED');
                                const authorizationFreshness = {
                                  observedAt: authorization?.updatedAt ?? raw.updatedAt,
                                  revision: raw.authorizationMutationId ?? String(raw.revision),
                                  sourceModuleId: 'commerce.customer-context' as const,
                                  status:
                                    authorization !== undefined &&
                                    ((authorization.authorizationOperation === 'grant' &&
                                      authorization.authorizationState === 'ACTIVE') ||
                                      (authorization.authorizationOperation === 'revoke' &&
                                        authorization.authorizationState === 'REVOKED'))
                                      ? ('CURRENT' as const)
                                      : ('INDETERMINATE' as const),
                                };
                                return readRetailPermissionProjection(
                                  raw.bindingId,
                                  raw.profileId,
                                  principalId,
                                  raw.updatedAt,
                                ).pipe(
                                  Effect.map(({ freshness, permissions }) => {
                                    const decision = decideRetailPortalAccess({
                                      authorizationOperation,
                                      authorizationState,
                                      authorizationStatus:
                                        authorizationFreshness.status === 'CURRENT' &&
                                        freshness.status === 'CURRENT'
                                          ? 'AVAILABLE'
                                          : 'INDETERMINATE',
                                      bindingState: raw.state,
                                      boundProfile: { ...input.profileRef, kind: 'RETAIL' },
                                      grantedPermissions: permissions,
                                      requestedPermission: input.requiredPermission,
                                      requestedProfile: { ...input.profileRef, kind: 'RETAIL' },
                                    });
                                    return {
                                      authorizationFreshness,
                                      bindingRef: Option.some(resolvedBindingRef),
                                      bindingState: Option.some(raw.state),
                                      decision,
                                      evaluatedAt: authorizationFreshness.observedAt,
                                      profileRef: input.profileRef,
                                      provenance: [
                                        ...provenance,
                                        {
                                          freshness: authorizationFreshness,
                                          projection: 'RETAIL_BINDING' as const,
                                        },
                                        { freshness, projection: 'OWNING_CAPABILITY' as const },
                                      ],
                                      requiredPermission: input.requiredPermission,
                                    } satisfies RetailAccessDecisionResponse;
                                  }),
                                );
                              },
                            ),
                          );
                      },
                    ),
                  );
              },
            ),
          );
      },
    },
    retailPortalProfileBindingRead: {
      readBinding: (
        input,
        principalId,
      ): Effect.Effect<
        RetailPortalProfileBindingReadResponse,
        ReadHandlerNotFound | ReadHandlerUnavailable
      > =>
        transaction.invoke(readBindingRoutine, [input.bindingRef.resourceId, principalId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<
              RetailPortalProfileBindingReadResponse,
              ReadHandlerNotFound | ReadHandlerUnavailable
            > => {
              if (row === undefined || row.outcome === 'BINDING_NOT_FOUND')
                return Effect.fail(
                  readNotFound('The Retail Portal binding does not exist in the verified scope'),
                );
              if (row.outcome === 'BINDING_RECONCILIATION_REQUIRED') {
                if (
                  row.payload === null ||
                  !Schema.is(BindingReconciliationRequiredPayloadSchema)(row.payload)
                )
                  return Effect.fail(
                    readUnavailable('The Retail Portal reconciliation projection is invalid'),
                  );
                const raw = row.payload;
                return succeedRetailPortalBindingRead({
                  _tag: 'BINDING_RECONCILIATION_REQUIRED' as const,
                  bindingRef: input.bindingRef,
                  profileRef: profileRef(scope.tenantId, raw.profileId, 'RETAIL'),
                  provenance: profileProvenance(raw.observedAt, raw.revision),
                  reconciliationCaseRef: Option.some(reconciliationRef(scope.tenantId, raw.caseId)),
                });
              }
              if (row.payload === null || !Schema.is(BindingPayloadSchema)(row.payload))
                return Effect.fail(
                  readUnavailable('The Retail Portal binding projection is invalid'),
                );
              const raw = row.payload;
              const observedAt = raw.updatedAt;
              if (
                raw.authorizationOperation === undefined ||
                raw.authorizationState === undefined
              ) {
                return Effect.fail(
                  readUnavailable(
                    'The Retail Portal binding authorization projection is unavailable',
                  ),
                );
              }
              const authorizationOperation = raw.authorizationOperation;
              const authorizationState = raw.authorizationState;
              const authorizationFreshness = {
                observedAt,
                revision: raw.authorizationMutationId ?? String(raw.revision),
                sourceModuleId: 'commerce.customer-context',
                status:
                  (raw.authorizationOperation === 'grant' && raw.authorizationState === 'ACTIVE') ||
                  (raw.authorizationOperation === 'revoke' && raw.authorizationState === 'REVOKED')
                    ? ('CURRENT' as const)
                    : ('INDETERMINATE' as const),
              };
              const readPermissions = dependencies.readRetailPermissions;
              const permissionsEffect: Effect.Effect<RetailPermissionProjection> =
                readPermissions === undefined
                  ? Effect.succeed<RetailPermissionProjection>({
                      freshness: {
                        observedAt,
                        sourceModuleId: 'core.identity',
                        status: 'UNAVAILABLE',
                      },
                      permissions: [],
                    })
                  : readPermissions({
                      bindingId: raw.bindingId,
                      legalEntityId: scope.legalEntityId,
                      principalId,
                      profileId: raw.profileId,
                      tenantId: scope.tenantId,
                    }).pipe(
                      Effect.map(
                        ({
                          observedAt: permissionObservedAt,
                          permissions,
                          revision,
                        }): RetailPermissionProjection =>
                          revision === undefined
                            ? {
                                freshness: {
                                  observedAt: permissionObservedAt,
                                  sourceModuleId: 'core.identity',
                                  status: 'CURRENT',
                                },
                                permissions,
                              }
                            : {
                                freshness: {
                                  observedAt: permissionObservedAt,
                                  revision,
                                  sourceModuleId: 'core.identity',
                                  status: 'CURRENT',
                                },
                                permissions,
                              },
                      ),
                      Effect.orElseSucceed((): RetailPermissionProjection => ({
                        freshness: {
                          observedAt,
                          sourceModuleId: 'core.identity',
                          status: 'UNAVAILABLE',
                        },
                        permissions: [],
                      })),
                    );
              return permissionsEffect.pipe(
                Effect.map(
                  ({ freshness, permissions }): RetailPortalProfileBindingReadResponse => ({
                    _tag: 'BINDING_AVAILABLE' as const,
                    authorizationFreshness,
                    binding: {
                      authorizationOperation,
                      authorizationState,
                      bindingRef: bindingRef(scope.tenantId, raw.bindingId),
                      createdAt: raw.createdAt,
                      enrollmentAuthorityGroup: 'RETAIL_PORTAL_SELF_SERVICE' as const,
                      enrollmentEvidenceRef: raw.enrollmentEvidenceRef,
                      lastTransitionReason: raw.reason,
                      principalRef: {
                        moduleId: 'core.identity' as const,
                        resourceId: raw.principalId,
                        resourceType: 'core.identity.principal' as const,
                        tenantId: scope.tenantId,
                      },
                      profileRef: profileRef(scope.tenantId, raw.profileId, 'RETAIL'),
                      revision: raw.revision,
                      ...(raw.revokedAt === null ? {} : { revokedAt: raw.revokedAt }),
                      sellingLegalEntityRef: sellingLegalEntityRef(scope),
                      state: raw.state,
                      updatedAt: raw.updatedAt,
                    },
                    completeness:
                      freshness.status === 'CURRENT' && authorizationFreshness.status === 'CURRENT'
                        ? ('FULL' as const)
                        : ('PARTIAL' as const),
                    grantedPermissions: permissions,
                    permissionsFreshness: freshness,
                    provenance: profileProvenance(observedAt, raw.revision),
                  }),
                ),
              );
            },
          ),
        ),
    },
    retailPrincipalResolution: {
      resolvePrincipal: (
        input,
        principalId,
      ): Effect.Effect<
        RetailPrincipalResolutionResponse,
        ReadHandlerNotFound | ReadHandlerUnavailable
      > =>
        transaction
          .invoke(resolvePrincipalRoutine, [input.profileRef.resourceId, principalId])
          .pipe(
            Effect.mapError(readUnavailableFromRoutineFailure),
            Effect.flatMap(
              ([row]): Effect.Effect<
                RetailPrincipalResolutionResponse,
                ReadHandlerNotFound | ReadHandlerUnavailable
              > => {
                if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND')
                  return Effect.fail(
                    readNotFound(
                      'The Retail Customer Profile does not exist in the verified scope',
                    ),
                  );
                if (row.payload === null || !Schema.is(PrincipalPayloadSchema)(row.payload))
                  return Effect.fail(
                    readUnavailable('The Retail Principal resolution projection is invalid'),
                  );
                const provenance = profileProvenance(row.payload.observedAt, row.payload.revision);
                if (row.outcome === 'RETAIL_PRINCIPAL_NOT_BOUND')
                  return succeedRetailPrincipalResolution({
                    _tag: 'RETAIL_PRINCIPAL_NOT_BOUND' as const,
                    profileRef: input.profileRef,
                    provenance,
                  });
                if (row.outcome === 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS')
                  return succeedRetailPrincipalResolution({
                    _tag: 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS' as const,
                    profileRef: input.profileRef,
                    provenance,
                    reconciliationCaseRef:
                      row.payload.caseId == null
                        ? Option.none()
                        : Option.some(reconciliationRef(scope.tenantId, row.payload.caseId)),
                  });
                if (row.payload.bindingId === undefined)
                  return Effect.fail(
                    readUnavailable('The Retail Principal binding reference is missing'),
                  );
                return succeedRetailPrincipalResolution({
                  _tag:
                    row.outcome === 'RETAIL_PRINCIPAL_BOUND'
                      ? ('RETAIL_PRINCIPAL_BOUND' as const)
                      : ('RETAIL_PRINCIPAL_BINDING_REVOKED' as const),
                  bindingRef: bindingRef(scope.tenantId, row.payload.bindingId),
                  profileRef: input.profileRef,
                  provenance,
                });
              },
            ),
          ),
    },
  };
};

export interface ProfilePersistenceServices {
  readonly archiveCustomerProfile: ArchiveCustomerProfileServices;
  readonly attributeGuestRetailCustomer: AttributeGuestRetailCustomerServices;
  readonly bindRetailPortalProfile: BindRetailPortalProfileServices;
  readonly createCounterpartyPurchasingProfile: CreateCounterpartyPurchasingProfileServices;
  readonly customerProfileRead: CustomerProfileReadServices;
  readonly customerProfileTradingGate: CustomerProfileTradingGateServices;
  readonly ensureRetailCustomerProfile: EnsureRetailCustomerProfileServices;
  readonly guestAttributionStatus: GuestAttributionStatusServices;
  readonly openProfileReconciliation: OpenProfileReconciliationServices;
  readonly profileReconciliationRead: ProfileReconciliationReadServices;
  readonly reactivateCustomerProfile: ReactivateCustomerProfileServices;
  readonly recoverRetailPortalProfileBinding: RecoverRetailPortalProfileBindingServices;
  readonly resolveProfileReconciliation: ResolveProfileReconciliationServices;
  readonly retailAccessDecision: RetailAccessDecisionServices;
  readonly retailPortalProfileBindingRead: RetailPortalProfileBindingReadServices;
  readonly retailPrincipalResolution: RetailPrincipalResolutionServices;
  readonly revokeRetailPortalProfileBinding: RevokeRetailPortalProfileBindingServices;
  readonly suspendCustomerProfile: SuspendCustomerProfileServices;
}

export const profilePersistenceServicesForTransaction = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies = {},
): ProfilePersistenceServices => {
  const reconciliation = reconciliationServices(transaction, scope, dependencies);
  const reads = readServices(transaction, scope, dependencies);
  return {
    archiveCustomerProfile: lifecycleServices(transaction, scope, 'ARCHIVE', dependencies),
    attributeGuestRetailCustomer: guestServices(transaction, scope, dependencies),
    bindRetailPortalProfile: bindingServices(transaction, scope, 'BIND'),
    createCounterpartyPurchasingProfile: counterpartyServices(transaction, scope, dependencies),
    customerProfileRead: reads.customerProfileRead,
    customerProfileTradingGate: reads.customerProfileTradingGate,
    ensureRetailCustomerProfile: ensureServices(transaction, scope, dependencies),
    guestAttributionStatus: reads.guestAttributionStatus,
    openProfileReconciliation: reconciliation.open,
    profileReconciliationRead: reads.profileReconciliationRead,
    reactivateCustomerProfile: lifecycleServices(transaction, scope, 'REACTIVATE', dependencies),
    recoverRetailPortalProfileBinding: bindingServices(transaction, scope, 'RECOVER'),
    resolveProfileReconciliation: reconciliation.resolve,
    retailAccessDecision: reads.retailAccessDecision,
    retailPortalProfileBindingRead: reads.retailPortalProfileBindingRead,
    retailPrincipalResolution: reads.retailPrincipalResolution,
    revokeRetailPortalProfileBinding: bindingServices(transaction, scope, 'REVOKE'),
    suspendCustomerProfile: lifecycleServices(transaction, scope, 'SUSPEND', dependencies),
  };
};

const retailBindingWorkerRejected = (
  code: InstanceType<typeof RetailBindingAuthorizationMutationWorkerRejected>['code'],
  reason: string,
) => new RetailBindingAuthorizationMutationWorkerRejected({ code, reason });

const retailPortalPermissionCodes: readonly RetailPortalPermissionCode[] = [
  ...RETAIL_PORTAL_SELF_SERVICE_BASELINE,
];

/**
 * Worker-only owner adapter for the Retail Portal authorization request topics.
 *
 * The binding Action commits the owner row and the request outbox message together. The worker
 * therefore re-loads that exact binding before touching the authorization graph, and uses the
 * Action invocation (the request mutation id) as the completion source identity. A stale request
 * cannot grant a superseded binding because the owner row's current state and principal/profile
 * are checked before any external relationship write.
 */
export const retailBindingAuthorizationMutationReconciliationForWorker = (
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
): RetailBindingAuthorizationMutationReconciliationService => {
  const service: RetailBindingAuthorizationMutationReconciliationService = {
    reconcile: (
      scope: OutboxWorkerLegalEntityScope,
      request: RetailBindingAuthorizationMutationRequest,
      actorPrincipalId,
    ) => {
      const expectedBindingState = request.operation === 'grant' ? 'ACTIVE' : 'REVOKED';
      const terminalAuthorizationState = request.operation === 'grant' ? 'ACTIVE' : 'REVOKED';
      const pendingAuthorizationState =
        request.operation === 'grant' ? 'PENDING_GRANT' : 'PENDING_REVOKE';
      const terminalEvidence = (
        binding: typeof BindingPayloadSchema.Type,
        finalized:
          | typeof BindingAuthorizationMutationFinalizationPayloadSchema.Type
          | typeof BindingAuthorizationFinalizationPayloadSchema.Type,
        alreadyFinal: boolean,
      ): RetailBindingAuthorizationMutationReconciliationResult => {
        const effectiveAt =
          'effectiveAt' in finalized
            ? finalized.effectiveAt
            : (finalized.finalizedAt ?? binding.updatedAt);
        const revision =
          'bindingRevision' in finalized ? finalized.bindingRevision : finalized.revision;
        const commonPayload = {
          bindingRef: request.bindingRef,
          effectiveAt,
          principalRef: request.principalRef,
          profileRef: request.profileRef,
          revision,
          sellingLegalEntityRef: request.sellingLegalEntityRef,
        };
        const outcome = alreadyFinal ? ('ALREADY_FINAL' as const) : ('FINALIZED' as const);
        const occurredAt = DateTime.toDateUtc(
          DateTime.makeUnsafe('updatedAt' in finalized ? finalized.updatedAt : effectiveAt),
        );
        if (request.transition === 'activation') {
          return {
            outcome,
            terminal: {
              completionId: request.mutationId,
              kind: 'ACTIVATION' as const,
              occurredAt,
              payload: { ...commonPayload, state: 'ACTIVE' as const },
              sourceActionInvocationId: request.mutationId,
            },
          };
        }
        if (request.transition === 'recovery') {
          return {
            outcome,
            terminal: {
              completionId: request.mutationId,
              kind: 'RECOVERY' as const,
              occurredAt,
              payload: { ...commonPayload, state: 'ACTIVE' as const },
              sourceActionInvocationId: request.mutationId,
            },
          };
        }
        return {
          outcome,
          terminal: {
            completionId: request.mutationId,
            kind: 'REVOCATION' as const,
            occurredAt,
            payload: { ...commonPayload, state: 'REVOKED' as const },
            sourceActionInvocationId: request.mutationId,
          },
        };
      };
      const workerConflict = (reason: string) =>
        Effect.fail(retailBindingWorkerRejected('RECONCILIATION_UNAVAILABLE', reason));
      const requestScopeIsExact =
        request.legalEntityId === scope.legalEntityId &&
        request.bindingRef.tenantId === scope.tenantId &&
        request.profileRef.tenantId === scope.tenantId &&
        request.principalRef.tenantId === scope.tenantId &&
        request.sellingLegalEntityRef.tenantId === scope.tenantId &&
        request.sellingLegalEntityRef.resourceId === scope.legalEntityId;
      const exactIntentSet = (
        intents: readonly (typeof BindingAuthorizationMutationPayloadSchema.Type)[],
      ): boolean => {
        const permissions = intents.map(({ permission }) => permission);
        const mutations = intents.map(({ mutationId }) => mutationId);
        const operations = new Set(intents.map(({ operation }) => operation));
        const expected = new Set(retailPortalPermissionCodes);
        return (
          intents.length === retailPortalPermissionCodes.length &&
          new Set(permissions).size === permissions.length &&
          new Set(mutations).size === mutations.length &&
          operations.size === 1 &&
          operations.has(request.operation) &&
          permissions.every((permission) => expected.has(permission)) &&
          expected.size === permissions.length
        );
      };
      const requestPermissionSetIsExact = (): boolean => {
        const requested = request.permissionMutations;
        if (requested === undefined) {
          return false;
        }
        const permissions = requested.map(({ permission }) => permission);
        const mutations = requested.map(({ mutationId }) => mutationId);
        const expected = new Set(retailPortalPermissionCodes);
        return (
          requested.length === retailPortalPermissionCodes.length &&
          new Set(permissions).size === permissions.length &&
          new Set(mutations).size === mutations.length &&
          requested.every(({ operation }) => operation === request.operation) &&
          permissions.every((permission) => expected.has(permission)) &&
          expected.size === permissions.length
        );
      };
      const requestMatchesIntents = (
        intents: readonly (typeof BindingAuthorizationMutationPayloadSchema.Type)[],
      ): boolean => {
        if (request.permissionMutations === undefined) {
          return true;
        }
        if (
          request.permissionMutations.length !== intents.length ||
          new Set(request.permissionMutations.map(({ permission }) => permission)).size !==
            request.permissionMutations.length ||
          new Set(request.permissionMutations.map(({ mutationId }) => mutationId)).size !==
            request.permissionMutations.length
        ) {
          return false;
        }
        const byPermission = new Map(intents.map((intent) => [intent.permission, intent]));
        return request.permissionMutations.every((requested) => {
          const intent = byPermission.get(requested.permission);
          return (
            intent !== undefined &&
            intent.mutationId === requested.mutationId &&
            requested.operation === request.operation &&
            intent.operation === requested.operation
          );
        });
      };
      const intentMatchesBinding = (
        intent: typeof BindingAuthorizationMutationPayloadSchema.Type,
        binding: typeof BindingPayloadSchema.Type,
      ): boolean =>
        intent.actionInvocationId === request.mutationId &&
        intent.bindingId === binding.bindingId &&
        intent.profileId === binding.profileId &&
        intent.principalId === binding.principalId &&
        intent.operation === request.operation;
      if (!requestScopeIsExact) {
        return workerConflict(
          'The Retail binding authorization request does not match the verified worker scope',
        );
      }
      return scope.routineInvoker
        .invoke(readBindingRoutine, [
          request.bindingRef.resourceId,
          request.principalRef.resourceId,
        ])
        .pipe(
          Effect.mapError((cause) =>
            preserveFailureCause(
              retailBindingWorkerRejected(
                'RECONCILIATION_UNAVAILABLE',
                'Retail binding authorization evidence is unavailable',
              ),
              cause,
            ),
          ),
          Effect.flatMap(([row]) => {
            if (
              row === undefined ||
              row.outcome !== 'BINDING_AVAILABLE' ||
              row.payload === null ||
              !Schema.is(BindingPayloadSchema)(row.payload)
            ) {
              return Effect.fail(
                retailBindingWorkerRejected(
                  'RECONCILIATION_UNAVAILABLE',
                  'The Retail binding authorization request is not linked to an available binding',
                ),
              );
            }
            const binding = row.payload;
            if (
              binding.bindingId !== request.bindingRef.resourceId ||
              binding.authorizationMutationId !== request.mutationId ||
              binding.profileId !== request.profileRef.resourceId ||
              binding.principalId !== request.principalRef.resourceId ||
              binding.state !== expectedBindingState ||
              binding.authorizationOperation !== request.operation ||
              (binding.authorizationState !== pendingAuthorizationState &&
                binding.authorizationState !== terminalAuthorizationState)
            ) {
              return workerConflict(
                'The Retail binding authorization request does not match current owner state',
              );
            }
            if (
              actorPrincipalId !== undefined &&
              binding.actorPrincipalId !== undefined &&
              binding.actorPrincipalId !== actorPrincipalId
            ) {
              return workerConflict(
                'The Retail binding authorization actor does not match the owner receipt',
              );
            }
            if (!requestPermissionSetIsExact()) {
              return workerConflict(
                'The Retail binding Permission mutation request set is not exact',
              );
            }
            const target = {
              kind: 'retail_profile' as const,
              legalEntityId: scope.legalEntityId,
              profileId: request.profileRef.resourceId,
              tenantId: scope.tenantId,
            };
            return scope.routineInvoker
              .invoke(readBindingAuthorizationRoutine, [
                request.bindingRef.resourceId,
                request.operation,
              ])
              .pipe(
                Effect.mapError((cause) =>
                  preserveFailureCause(
                    retailBindingWorkerRejected(
                      'RECONCILIATION_UNAVAILABLE',
                      'Retail Portal authorization intent evidence is unavailable',
                    ),
                    cause,
                  ),
                ),
                Effect.flatMap(([authorization]) => {
                  if (
                    authorization === undefined ||
                    authorization.outcome !== 'AUTHORIZATION_AVAILABLE' ||
                    authorization.payload === null ||
                    !Schema.is(BindingAuthorizationPayloadSchema)(authorization.payload)
                  ) {
                    return Effect.fail(
                      retailBindingWorkerRejected(
                        'RECONCILIATION_UNAVAILABLE',
                        'The Retail binding authorization intent set is unavailable',
                      ),
                    );
                  }
                  const authorizationPayload = authorization.payload;
                  const authorizationIsTerminal =
                    authorizationPayload.authorizationState === terminalAuthorizationState &&
                    authorizationPayload.pendingCount === 0 &&
                    authorizationPayload.terminalCount === retailPortalPermissionCodes.length;
                  const authorizationIsPending =
                    (authorizationPayload.authorizationState === pendingAuthorizationState ||
                      authorizationPayload.authorizationState === 'RECONCILIATION_REQUIRED') &&
                    authorizationPayload.pendingCount + authorizationPayload.terminalCount <=
                      retailPortalPermissionCodes.length;
                  if (
                    authorizationPayload.bindingId !== binding.bindingId ||
                    authorizationPayload.profileId !== binding.profileId ||
                    authorizationPayload.principalId !== binding.principalId ||
                    authorizationPayload.operation !== request.operation ||
                    authorizationPayload.authorizationOperation !== request.operation ||
                    authorizationPayload.revision !== binding.revision ||
                    (!authorizationIsTerminal && !authorizationIsPending)
                  ) {
                    return Effect.fail(
                      retailBindingWorkerRejected(
                        'RECONCILIATION_UNAVAILABLE',
                        'The Retail binding authorization intents do not match the owner receipt',
                      ),
                    );
                  }
                  const readIntent = (mutationId: string) =>
                    scope.routineInvoker
                      .invoke(readBindingAuthorizationMutationRoutine, [mutationId])
                      .pipe(
                        Effect.mapError((cause) =>
                          preserveFailureCause(
                            retailBindingWorkerRejected(
                              'RECONCILIATION_UNAVAILABLE',
                              'Retail Portal Permission mutation intent is unavailable',
                            ),
                            cause,
                          ),
                        ),
                        Effect.flatMap(([intent]) => {
                          if (
                            intent === undefined ||
                            intent.outcome !== 'AUTHORIZATION_AVAILABLE' ||
                            intent.payload === null ||
                            !Schema.is(BindingAuthorizationMutationPayloadSchema)(intent.payload)
                          ) {
                            return Effect.fail(
                              retailBindingWorkerRejected(
                                'RECONCILIATION_UNAVAILABLE',
                                'Retail Portal Permission mutation intent returned no durable state',
                              ),
                            );
                          }
                          return Effect.succeed(intent.payload);
                        }),
                      );
                  type IntentProgress = Readonly<{
                    readonly completed: boolean;
                    readonly mutated: boolean;
                  }>;
                  const reconcileIntent = (
                    intent: typeof BindingAuthorizationMutationPayloadSchema.Type,
                  ): Effect.Effect<
                    IntentProgress,
                    InstanceType<typeof RetailBindingAuthorizationMutationWorkerRejected>
                  > =>
                    readIntent(intent.mutationId).pipe(
                      Effect.flatMap(
                        (
                          current,
                        ): Effect.Effect<
                          IntentProgress,
                          InstanceType<typeof RetailBindingAuthorizationMutationWorkerRejected>
                        > => {
                          if (
                            current.actionInvocationId !== request.mutationId ||
                            current.bindingId !== request.bindingRef.resourceId ||
                            current.operation !== request.operation ||
                            current.principalId !== request.principalRef.resourceId ||
                            current.profileId !== request.profileRef.resourceId ||
                            current.permission !== intent.permission
                          ) {
                            return Effect.fail(
                              retailBindingWorkerRejected(
                                'RECONCILIATION_UNAVAILABLE',
                                'Retail Portal Permission mutation intent scope is inconsistent',
                              ),
                            );
                          }
                          if (current.state === terminalAuthorizationState) {
                            return Effect.succeed({ completed: true, mutated: false });
                          }
                          if (
                            current.state !== pendingAuthorizationState &&
                            current.state !== 'RECONCILIATION_REQUIRED'
                          ) {
                            return Effect.fail(
                              retailBindingWorkerRejected(
                                'RECONCILIATION_UNAVAILABLE',
                                'Retail Portal Permission mutation intent is not retryable',
                              ),
                            );
                          }
                          const permissionResult = Schema.decodeUnknownResult(
                            BusinessPermissionCodeSchema,
                          )(current.permission);
                          if (Result.isFailure(permissionResult)) {
                            return Effect.fail(
                              retailBindingWorkerRejected(
                                'RECONCILIATION_UNAVAILABLE',
                                'Retail Portal Permission mutation intent contains an invalid Permission code',
                              ),
                            );
                          }
                          return mutation
                            .mutate({
                              operation: request.operation,
                              permission: permissionResult.success,
                              principal: {
                                principalId: request.principalRef.resourceId,
                                tenantId: scope.tenantId,
                              },
                              target,
                            })
                            .pipe(
                              Effect.map(() => true),
                              Effect.orElseSucceed(() => false as const),
                              Effect.flatMap(
                                (
                                  applied,
                                ): Effect.Effect<
                                  IntentProgress,
                                  InstanceType<
                                    typeof RetailBindingAuthorizationMutationWorkerRejected
                                  >
                                > => {
                                  if (!applied) {
                                    return Effect.succeed({ completed: false, mutated: false });
                                  }
                                  return scope.routineInvoker
                                    .invoke(finalizeBindingAuthorizationMutationRoutine, [
                                      current.mutationId,
                                      request.operation,
                                      terminalAuthorizationState,
                                    ])
                                    .pipe(
                                      Effect.mapError((cause) =>
                                        preserveFailureCause(
                                          retailBindingWorkerRejected(
                                            'RECONCILIATION_UNAVAILABLE',
                                            'Retail Portal Permission mutation finalization is unavailable',
                                          ),
                                          cause,
                                        ),
                                      ),
                                      Effect.flatMap(([finalized]) => {
                                        if (
                                          finalized === undefined ||
                                          (finalized.outcome !== 'AUTHORIZATION_FINALIZED' &&
                                            finalized.outcome !== 'AUTHORIZATION_ALREADY_FINAL') ||
                                          finalized.payload === null ||
                                          !Schema.is(
                                            BindingAuthorizationMutationFinalizationPayloadSchema,
                                          )(finalized.payload) ||
                                          finalized.payload.mutationId !== current.mutationId ||
                                          finalized.payload.state !== terminalAuthorizationState
                                        ) {
                                          return Effect.fail(
                                            retailBindingWorkerRejected(
                                              'RECONCILIATION_UNAVAILABLE',
                                              'Retail Portal Permission mutation finalization returned no terminal state',
                                            ),
                                          );
                                        }
                                        return Effect.succeed({
                                          completed: true,
                                          mutated: finalized.outcome === 'AUTHORIZATION_FINALIZED',
                                        });
                                      }),
                                    );
                                },
                              ),
                            );
                        },
                      ),
                    );
                  const reconcileAll = (
                    intents: readonly (typeof BindingAuthorizationMutationPayloadSchema.Type)[],
                  ): Effect.Effect<
                    IntentProgress,
                    InstanceType<typeof RetailBindingAuthorizationMutationWorkerRejected>
                  > => {
                    const [intent, ...remaining] = intents;
                    if (intent === undefined) {
                      return Effect.succeed({ completed: true, mutated: false });
                    }
                    return reconcileIntent(intent).pipe(
                      Effect.flatMap((progress) =>
                        progress.completed
                          ? reconcileAll(remaining).pipe(
                              Effect.map((remainingProgress) => ({
                                completed: remainingProgress.completed,
                                mutated: progress.mutated || remainingProgress.mutated,
                              })),
                            )
                          : Effect.succeed(progress),
                      ),
                    );
                  };
                  const relationshipsApplied = scope.routineInvoker
                    .invoke(stageBindingAuthorizationMutationsRoutine, [
                      request.bindingRef.resourceId,
                      request.principalRef.resourceId,
                      request.mutationId,
                      request.operation,
                    ])
                    .pipe(
                      Effect.mapError((cause) =>
                        preserveFailureCause(
                          retailBindingWorkerRejected(
                            'RECONCILIATION_UNAVAILABLE',
                            'Retail Portal Permission mutation staging is unavailable',
                          ),
                          cause,
                        ),
                      ),
                      Effect.flatMap((rows) => {
                        const intents = rows.flatMap((entry) =>
                          entry.outcome === 'AUTHORIZATION_STAGED' &&
                          entry.payload !== null &&
                          Schema.is(BindingAuthorizationMutationPayloadSchema)(entry.payload)
                            ? [entry.payload]
                            : [],
                        );
                        if (
                          !exactIntentSet(intents) ||
                          !intents.every((intent) => intentMatchesBinding(intent, binding)) ||
                          !requestMatchesIntents(intents)
                        ) {
                          return Effect.fail(
                            retailBindingWorkerRejected(
                              'RECONCILIATION_UNAVAILABLE',
                              'The Retail binding Permission mutation set is not exact',
                            ),
                          );
                        }
                        return reconcileAll(intents);
                      }),
                    );
                  return relationshipsApplied.pipe(
                    Effect.flatMap((progress) => {
                      if (!progress.completed) {
                        return Effect.succeed({ outcome: 'INDETERMINATE' as const });
                      }
                      return scope.routineInvoker
                        .invoke(finalizeBindingAuthorizationRoutine, [
                          request.bindingRef.resourceId,
                          request.operation,
                          binding.revision,
                          request.mutationId,
                          binding.updatedAt,
                          binding.reason,
                          binding.actorPrincipalId ?? actorPrincipalId ?? null,
                        ])
                        .pipe(
                          Effect.mapError((cause) =>
                            preserveFailureCause(
                              retailBindingWorkerRejected(
                                'RECONCILIATION_UNAVAILABLE',
                                'Retail Portal authorization owner finalization is unavailable',
                              ),
                              cause,
                            ),
                          ),
                          Effect.flatMap(([finalized]) => {
                            if (
                              finalized === undefined ||
                              (finalized.outcome !== 'AUTHORIZATION_FINALIZED' &&
                                finalized.outcome !== 'AUTHORIZATION_ALREADY_FINAL') ||
                              finalized.payload === null ||
                              !Schema.is(BindingAuthorizationFinalizationPayloadSchema)(
                                finalized.payload,
                              )
                            ) {
                              return Effect.fail(
                                retailBindingWorkerRejected(
                                  'RECONCILIATION_UNAVAILABLE',
                                  'Retail Portal authorization owner finalization returned no terminal state',
                                ),
                              );
                            }
                            const finalPayload = finalized.payload;
                            if (
                              finalPayload.bindingId !== request.bindingRef.resourceId ||
                              finalPayload.profileId !== request.profileRef.resourceId ||
                              finalPayload.principalId !== request.principalRef.resourceId ||
                              finalPayload.operation !== request.operation ||
                              finalPayload.authorizationOperation !== request.operation ||
                              finalPayload.authorizationState !== terminalAuthorizationState ||
                              finalPayload.revision !== binding.revision
                            ) {
                              return Effect.fail(
                                retailBindingWorkerRejected(
                                  'RECONCILIATION_UNAVAILABLE',
                                  'Retail Portal authorization owner finalization returned mismatched evidence',
                                ),
                              );
                            }
                            return Effect.succeed(
                              terminalEvidence(
                                binding,
                                finalPayload,
                                finalized.outcome === 'AUTHORIZATION_ALREADY_FINAL' &&
                                  !progress.mutated,
                              ),
                            );
                          }),
                        );
                    }),
                  );
                }),
              );
          }),
        );
    },
  };
  return Object.freeze(service);
};

export const ensureRetailCustomerProfileServicesForTransaction = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
) => profilePersistenceServicesForTransaction(transaction, scope).ensureRetailCustomerProfile;

export const reconcilePartyMergePersistenceForTransaction =
  (): ReconcilePartyMergePersistenceService => ({
    observe: (verifiedScope, observation: ReconcilePartyMergeObservation) => {
      if (
        observation.tenantId !== verifiedScope.tenantId ||
        observation.legalEntityId !== verifiedScope.legalEntityId
      ) {
        return Effect.fail(
          new ReconcilePartyMergeWorkerRejected({
            code: 'CROSS_TENANT_EVENT',
            reason:
              'Party merge observation does not match the Core-verified Tenant and Selling Legal Entity scope',
            retryable: false,
          }),
        );
      }
      return verifiedScope.routineInvoker
        .invoke(observePartyMergeRoutine, [
          observation.mergeId,
          observation.domainEventId,
          observation.messageId,
          observation.eventVersion,
          observation.occurredAt,
          observation.policyVersion,
          observation.survivorPartyRef.resourceId,
          observation.absorbedPartyRefs.map(({ resourceId }) => resourceId),
          observation.initialOwnerOutcomes,
          observation.actorPrincipalId,
        ])
        .pipe(
          Effect.mapError(
            (failure) =>
              new ReconcilePartyMergeWorkerRejected({
                code: 'PERSISTENCE_UNAVAILABLE',
                reason: routineFailureReason(failure),
                retryable: true,
              }),
          ),
          Effect.flatMap(
            ([row]): Effect.Effect<
              ReconcilePartyMergeObservationResult,
              ReconcilePartyMergeWorkerError
            > => {
              if (row === undefined) {
                return Effect.fail(
                  new ReconcilePartyMergeWorkerRejected({
                    code: 'CURRENT_STATE_CONFLICT',
                    reason: 'The Party merge observer returned no durable outcome',
                    retryable: true,
                  }),
                );
              }
              if (
                row.outcome === 'NO_CONFLICTING_PROFILES' ||
                row.outcome === 'DUPLICATE' ||
                row.outcome === 'OUT_OF_ORDER' ||
                row.outcome === 'COMPLETED_NO_CHANGE'
              ) {
                return succeedPartyMergeObservation({
                  currentEventVersion: row.current_event_version,
                  outcome: row.outcome,
                });
              }
              const raw = row.payload;
              if (
                row.outcome !== 'RECONCILIATIONS_OBSERVED' ||
                raw === null ||
                !Schema.is(PartyMergeObservationPayloadSchema)(raw)
              ) {
                return Effect.fail(
                  new ReconcilePartyMergeWorkerRejected({
                    code: 'CURRENT_STATE_CONFLICT',
                    reason: 'The Party merge observer returned invalid reconciliation evidence',
                    retryable: true,
                  }),
                );
              }
              return succeedPartyMergeObservation({
                cases: raw.cases,
                currentEventVersion: row.current_event_version,
                outcome: 'RECONCILIATIONS_OBSERVED',
              });
            },
          ),
        );
    },
  });
