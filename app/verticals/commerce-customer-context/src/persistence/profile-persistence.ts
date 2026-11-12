import type { CurrentOrganizationCustomerRecordFactsSchema } from '@app/party-registry/apis/organization-record-facts';
import type {
  CustomerProfilePartySourceReference,
  CustomerProfileSourceAssertion,
} from '../../shared/domain/customer-profile-source.ts';
/* oxlint-disable effect-native/no-dependency-parameters effect-native/no-nullable-schema-field effect-native/no-string-timestamp-schema effect-native/no-unbranded-identifier-schema effect-native/no-duplicate-literal-vocabulary anti-slop/no-known-value-widening sonarjs/no-duplicate-string -- This adapter decodes nullable database wire rows and accepts optional owner-port composition inputs without exporting database capability; expires: 2027-03-31. */
import { ReadHandlerNotFound, ReadHandlerUnavailable, defineScopedRoutine } from '@app/core-runtime';
import type {
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import type { AccessPortalError, AccessPortalWrites } from '@app/core-runtime/access/portal';
import { DateTime, Effect, Option, Schema } from 'effect';

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
import type { ProfileLifecyclePayload, ProfileLifecycleResult } from '../../shared/actions/suspend-customer-profile.ts';
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
import type { MarketSubjectRestrictionsCurrentRequest } from '../../shared/apis/market-subject-restrictions-current.ts';
import {
  CommerceCustomerProfileSubjectSchema,
  ReconciliationOwnerSchema,
  ReconciliationOwnerOutcomeSchema,
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RetailPortalBindingAuthorizationOperationSchema,
  RetailPortalBindingStateSchema,
} from '../../shared/domain/profile-contracts.ts';
import type {
  GuestPartyResolutionOutcome,
  ProfileLifecycleOperation,
  ReconciliationOwner,
  RetailPortalBindingAuthorizationOperation,
  RetailPortalBindingState,
  RetailPortalPermissionCode,
} from '../../shared/domain/profile-contracts.ts';
import { decideRetailPortalAccess } from '../../shared/domain/profile-decisions.ts';
import { RETAIL_CUSTOMER_PORTAL_ROLE } from '../portal-access/portal-roles.ts';
import { retailPortalBindingActivationSource } from '../portal-access/portal-sources.ts';
import type { CommerceCustomerProfile, CommerceCustomerProfileRef } from '../../shared/domain/profile-decisions.ts';
import type {
  MarketSubjectRestrictionProfileResult,
  MarketSubjectRestrictionsCurrentServices,
} from '../api/market-subject-restrictions-current.read.ts';
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
  /** The call is this module's own enrollment continuation acting for the subject that started an Attempt. */
  readonly enrollmentContinuation?: true;
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

interface AttributeGuestRetailCustomerServices {
  readonly attribute: (
    payload: AttributeGuestRetailCustomerPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<AttributeGuestRetailCustomerResult, AttributeGuestRetailCustomerRejected>;
}

interface BindRetailPortalProfileServices {
  readonly bind: (
    payload: RetailPortalBindingPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected>;
}
interface RecoverRetailPortalProfileBindingServices {
  readonly recover: (
    payload: RetailPortalBindingPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected>;
}
interface RevokeRetailPortalProfileBindingServices {
  readonly revoke: (
    payload: RetailPortalBindingPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<RetailPortalBindingResult, RetailPortalBindingActionRejected>;
}

interface CreateCounterpartyPurchasingProfileServices {
  readonly create: (
    payload: CreateCounterpartyPurchasingProfilePayload,
    context: ProfileActionContext,
  ) => Effect.Effect<CreateCounterpartyPurchasingProfileResult, CreateCounterpartyPurchasingProfileRejected>;
}

interface EnsureRetailCustomerProfileServices {
  readonly ensure: (
    payload: EnsureRetailCustomerProfilePayload,
    context: ProfileActionContext & { readonly compositionRevision: string },
  ) => Effect.Effect<EnsureRetailCustomerProfileResult, EnsureRetailCustomerProfileRejected>;
}

interface OpenProfileReconciliationServices {
  readonly open: (
    payload: OpenProfileReconciliationPayload,
    context: ProfileActionContext,
  ) => Effect.Effect<OpenProfileReconciliationResult, ProfileReconciliationActionRejected>;
}

interface ResolveProfileReconciliationServices {
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

interface ProfileLifecycleServices {
  readonly transition: (
    payload: ProfileLifecyclePayload,
    context: ProfileActionContext,
  ) => Effect.Effect<ProfileLifecycleResult, ProfileLifecycleActionRejected>;
}
type ArchiveCustomerProfileServices = ProfileLifecycleServices;
type ReactivateCustomerProfileServices = ProfileLifecycleServices;
type SuspendCustomerProfileServices = ProfileLifecycleServices;

interface CustomerProfileReadServices {
  readonly readProfile: (
    input: CustomerProfileReadRequest,
    tenantId: string,
  ) => Effect.Effect<CustomerProfileReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
interface CustomerProfileTradingGateServices {
  readonly evaluateGate: (
    input: CustomerProfileTradingGateRequest,
    tenantId: string,
  ) => Effect.Effect<CustomerProfileTradingGateResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
interface GuestAttributionStatusServices {
  readonly readStatus: (
    input: GuestAttributionStatusRequest,
    tenantId: string,
  ) => Effect.Effect<GuestAttributionStatusResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
interface ProfileReconciliationReadServices {
  readonly readCase: (
    input: ProfileReconciliationReadRequest,
    tenantId: string,
  ) => Effect.Effect<ProfileReconciliationReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
interface RetailPortalProfileBindingReadServices {
  readonly readBinding: (
    input: RetailPortalProfileBindingReadRequest,
    principalId: string,
    tenantId: string,
  ) => Effect.Effect<RetailPortalProfileBindingReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}
export interface RetailPrincipalResolutionServices {
  readonly resolvePrincipal: (
    input: RetailPrincipalResolutionRequest,
    principalId: string,
    tenantId: string,
  ) => Effect.Effect<RetailPrincipalResolutionResponse, ReadHandlerNotFound | ReadHandlerUnavailable>;
}

interface RetailPermissionProjection {
  readonly freshness: {
    readonly observedAt: string;
    readonly revision?: string;
    readonly sourceModuleId: 'commerce.customer-context';
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
const BindingPayloadSchema = Schema.Struct({
  actionInvocationId: Schema.String,
  actorPrincipalId: Schema.optionalKey(Schema.String),
  authorizationOperation: Schema.optionalKey(RetailPortalBindingAuthorizationOperationSchema),
  authorizationState: Schema.optionalKey(RetailPortalBindingStateSchema),
  bindingId: Schema.String,
  createdAt: Schema.String,
  enrollmentEvidenceRef: Schema.String,
  principalId: Schema.String,
  profileId: Schema.String,
  reason: Schema.String,
  revision: IntegerSchema,
  revokedAt: Schema.NullOr(Schema.String),
  state: RetailPortalBindingStateSchema,
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
  trigger: Schema.Literals(['PARTY_ALIAS', 'COUNTERPARTY_ALIAS', 'CREATE_COLLISION', 'IMPORT_CORRELATION']),
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
const CompletedGuestPayloadSchema = Schema.Struct({
  ...GuestPayloadSchema.fields,
  outcome: Schema.Literal('ATTRIBUTED'),
  partyResourceId: Schema.String,
  profileId: Schema.String,
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

type RoutineRow = typeof RoutineRowSchema.Type;
type OwnerVerificationPayload = typeof OwnerVerificationPayloadSchema.Type;
type BindingPayload = typeof BindingPayloadSchema.Type;
type GuestPayload = typeof GuestPayloadSchema.Type;
type PrincipalPayload = typeof PrincipalPayloadSchema.Type;

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
const ensureCounterpartyProfileRoutine = routine('ensure_counterparty_profile', 'profile.ensure-counterparty', [
  ...scopeParameters,
  { source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const ensureSourceProfileRoutine = routine('ensure_source_customer_profile', 'profile.ensure-source', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'jsonb' },
] as const);

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
/** Read the owner profile through its existing scoped routine for address preparation. */
export const readAddressProfileSnapshot = (
  transaction: ProfileScopedRoutineInvoker,
  profileId: string,
  kind: 'RETAIL' | 'COUNTERPARTY',
) =>
  transaction
    .invoke(readProfileRoutine, [profileId, kind])
    .pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Array(RoutineRowSchema)))));
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
/** The SELECT-only half of `ensure_retail_profile`; it never creates the profile it looks for. */
const readRetailProfileByPartyRoutine = routine('read_retail_profile_by_party', 'profile.read-retail-by-party', [
  ...scopeParameters,
  { source: 'input', type: 'text' },
] as const);
const resolvePrincipalRoutine = routine('resolve_retail_principal', 'profile.resolve-principal', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const);
const openReconciliationRoutine = routine('open_profile_reconciliation', 'profile.reconciliation-open', [
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
] as const);
const resolveReconciliationRoutine = routine('resolve_profile_reconciliation', 'profile.reconciliation-resolve', [
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
] as const);
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
const readReconciliationRoutine = routine('read_profile_reconciliation', 'profile.reconciliation-read', [
  ...scopeParameters,
  { source: 'input', type: 'uuid' },
] as const);
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

const ownerVerificationPayloadFromRow = (row: RoutineRow | undefined): OwnerVerificationPayload | undefined =>
  row?.outcome === 'VERIFIED' && row.payload !== null && Schema.is(OwnerVerificationPayloadSchema)(row.payload)
    ? row.payload
    : undefined;
const ownerVerificationPayloadMatches = (
  payload: OwnerVerificationPayload,
  request: Parameters<ProfileReconciliationOwnerVerifierService['verify']>[0],
): boolean =>
  payload.owner === request.desiredOutcome.owner &&
  payload.status === request.desiredOutcome.status &&
  payload.survivorProfileId === request.survivorProfileRef.resourceId &&
  payload.resultingState === request.resultingState &&
  payload.correlationRef.length > 0 &&
  payload.evidenceRef.length > 0 &&
  payload.provenanceRef.length > 0;

/** Transaction-bound verifier for reconciliation owners backed by profile-owned tables. */
export const profileReconciliationOwnerVerifierForTransaction = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
): ProfileReconciliationOwnerVerifierService => ({
  verify: (request, context) => {
    if (request.desiredOutcome.owner === 'APPROVAL' || request.desiredOutcome.owner === 'CONNECTOR_CORRELATION') {
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
          const payload = ownerVerificationPayloadFromRow(row);
          if (payload !== undefined && ownerVerificationPayloadMatches(payload, request)) {
            return {
              _tag: 'VERIFIED',
              correlationRef: payload.correlationRef,
              durableOutcome: {
                evidenceRef: payload.evidenceRef,
                owner: payload.owner,
                status: payload.status,
              },
            };
          }
          if (row?.outcome === 'OWNER_CONFLICT') {
            return {
              _tag: 'CONFLICT',
              owner: request.desiredOutcome.owner,
              reason: 'Profile-owned durable state conflicts with the requested reconciliation',
            };
          }
          return {
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
const preserveFailureCause = <Failure extends object>(failure: Failure, cause: unknown): Failure => {
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const readUnavailable = (reason: string) => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });
const readNotFound = (reason: string) => new ReadHandlerNotFound({ code: 'read_handler_not_found', reason });
const readUnavailableFromRoutineFailure = (failure: ScopedRoutineInvocationError) => {
  const reason = routineFailureReason(failure);
  return readUnavailable(reason);
};
const succeedCustomerProfileRead = (result: CustomerProfileReadResponse) => Effect.succeed(result);
const succeedCustomerProfileTradingGate = (result: CustomerProfileTradingGateResponse) => Effect.succeed(result);
const succeedGuestAttributionStatus = (result: GuestAttributionStatusResponse) => Effect.succeed(result);
const succeedProfileReconciliationRead = (result: ProfileReconciliationReadResponse) => Effect.succeed(result);
const succeedRetailPortalBindingRead = (result: RetailPortalProfileBindingReadResponse) => Effect.succeed(result);
const succeedRetailPrincipalResolution = (result: RetailPrincipalResolutionResponse) => Effect.succeed(result);
const succeedPartyMergeObservation = (result: ReconcilePartyMergeObservationResult) => Effect.succeed(result);
const rejectReconciliation = (code: ProfileReconciliationActionRejected['code'], reason: string, retryable: boolean) =>
  new ProfileReconciliationActionRejected({ code, reason, retryable });
const lifecycleRejectionCode = (outcome: string | undefined): ProfileLifecycleActionRejected['code'] => {
  // oxlint-disable-next-line effect-native/prefer-match-over-tag-switch, typescript/switch-exhaustiveness-check -- This persistence boundary accepts open or missing routine outcomes and intentionally maps everything outside the recognized lifecycle vocabulary to indeterminate.
  switch (outcome) {
    case 'PROFILE_NOT_FOUND':
    case 'INVALID_LIFECYCLE_TRANSITION':
    case 'CURRENT_STATE_CONFLICT':
    case 'PROFILE_RECONCILIATION_REQUIRED':
    case 'REACTIVATION_RECONFIRMATION_REQUIRED': {
      return outcome;
    }
    default: {
      return 'OUTCOME_INDETERMINATE';
    }
  }
};
const bindingRejectionCode = (outcome: string | undefined): RetailPortalBindingActionRejected['code'] => {
  // oxlint-disable-next-line effect-native/prefer-match-over-tag-switch, typescript/switch-exhaustiveness-check -- This persistence boundary accepts open or missing routine outcomes and intentionally maps everything outside the recognized binding vocabulary to indeterminate.
  switch (outcome) {
    case 'PROFILE_NOT_FOUND':
    case 'PROFILE_NOT_ACTIVE':
    case 'BINDING_NOT_FOUND':
    case 'BINDING_CONFLICT':
    case 'BINDING_AMBIGUOUS':
    case 'ENROLLMENT_EVIDENCE_INSUFFICIENT':
    case 'CURRENT_STATE_CONFLICT': {
      return outcome;
    }
    default: {
      return 'OUTCOME_INDETERMINATE';
    }
  }
};
const reconciliationRejectionCode = (outcome: string | undefined): ProfileReconciliationActionRejected['code'] => {
  // oxlint-disable-next-line effect-native/prefer-match-over-tag-switch, typescript/switch-exhaustiveness-check -- This persistence boundary accepts open or missing routine outcomes and intentionally maps everything outside the recognized reconciliation vocabulary to indeterminate.
  switch (outcome) {
    case 'RECONCILIATION_NOT_FOUND':
    case 'RECONCILIATION_OUT_OF_ORDER':
    case 'CURRENT_STATE_CONFLICT': {
      return outcome;
    }
    default: {
      return 'OUTCOME_INDETERMINATE';
    }
  }
};
const reconciliationFailureIsRetryable = (row: RoutineRow | undefined): boolean =>
  row === undefined || row.outcome === 'RECONCILIATION_OUT_OF_ORDER';
const guestPayloadFromRow = (row: RoutineRow): GuestPayload | undefined =>
  row.payload !== null && Schema.is(GuestPayloadSchema)(row.payload) ? row.payload : undefined;
const isCompletedGuestPayload = Schema.is(CompletedGuestPayloadSchema);
const incompleteGuestOutcome = (
  outcome: GuestPayload['outcome'],
): 'AMBIGUOUS_MATCH' | 'PROFILE_NOT_ACTIVE' | 'INVALID_OR_INSUFFICIENT_EVIDENCE' => {
  if (outcome === 'PARTY_AMBIGUOUS') {
    return 'AMBIGUOUS_MATCH';
  }
  if (outcome === 'PROFILE_NOT_ACTIVE') {
    return 'PROFILE_NOT_ACTIVE';
  }
  return 'INVALID_OR_INSUFFICIENT_EVIDENCE';
};
const bindingPayloadFromRow = (row: RoutineRow): BindingPayload | undefined =>
  row.payload !== null && Schema.is(BindingPayloadSchema)(row.payload) ? row.payload : undefined;
const availableBindingPayloadFromRow = (row: RoutineRow | undefined): BindingPayload | undefined =>
  row?.outcome === 'BINDING_AVAILABLE' && row.payload !== null && Schema.is(BindingPayloadSchema)(row.payload)
    ? row.payload
    : undefined;
const bindingAuthorizationFromPayload = (payload: BindingPayload) => {
  if (payload.authorizationOperation === undefined || payload.authorizationState === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined preserves this optional payload contract.
    return undefined;
  }
  return {
    operation: payload.authorizationOperation,
    state: payload.authorizationState,
  };
};
const bindingMatchesRetailAccessScope = (
  payload: BindingPayload,
  input: RetailAccessDecisionRequest,
  principalId: string,
): boolean => payload.profileId === input.profileRef.resourceId && payload.principalId === principalId;
const principalPayloadFromRow = (row: RoutineRow): PrincipalPayload | undefined =>
  row.payload !== null && Schema.is(PrincipalPayloadSchema)(row.payload) ? row.payload : undefined;
const retailPrincipalResolutionTag = (
  outcome: string,
): 'RETAIL_PRINCIPAL_BOUND' | 'RETAIL_PRINCIPAL_BINDING_REVOKED' =>
  outcome === 'RETAIL_PRINCIPAL_BOUND' ? 'RETAIL_PRINCIPAL_BOUND' : 'RETAIL_PRINCIPAL_BINDING_REVOKED';
const reconciliationRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'commerce.customer-context' as const,
  resourceId,
  resourceType: 'commerce.customer-context.profile-reconciliation-case' as const,
  tenantId,
});
const optionalReconciliationRef = (tenantId: string, caseId: string | null | undefined) => {
  if (caseId === null || caseId === undefined) {
    return Option.none();
  }
  return Option.some(reconciliationRef(tenantId, caseId));
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

const profileKind = (ref: { readonly kind: 'COUNTERPARTY' | 'RETAIL' }) => ref.kind;
const targetState = (operation: ProfileLifecycleOperation): 'ACTIVE' | 'ARCHIVED' | 'SUSPENDED' => {
  if (operation === 'REACTIVATE') {
    return 'ACTIVE';
  }
  if (operation === 'ARCHIVE') {
    return 'ARCHIVED';
  }
  return 'SUSPENDED';
};

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
function profileRef(tenantId: string, resourceId: string, kind: 'COUNTERPARTY' | 'RETAIL'): CommerceCustomerProfileRef;
function profileRef(tenantId: string, resourceId: string, kind: 'COUNTERPARTY' | 'RETAIL'): CommerceCustomerProfileRef {
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

/**
 * The two owner reads an enrollment reconciliation needs after a committed Commerce Action's
 * response was lost. Both are SELECT-only, and both answer about the exact durable row the Action
 * itself writes, inside the same database and the same transaction the Action commits in — so
 * `none` is that Action not having committed, not merely an unknown.
 *
 * Neither read republishes the Action's own result payload: the owner keeps no copy of it. What
 * they republish is the durable state that result described.
 */
const readRetailProfileByPartyUnavailable = (outcome: string | undefined) =>
  readUnavailable(
    outcome === 'PROFILE_RECONCILIATION_REQUIRED'
      ? 'The Retail Customer Profile for this Party is under reconciliation'
      : 'The Retail Customer Profile read returned no owner row',
  );

/** The Retail Customer Profile this exact Tenant, Legal Entity and Party already hold, or none. */
export const readRetailProfileByParty = (
  transaction: ProfileScopedRoutineInvoker,
  partyResourceId: string,
): Effect.Effect<Option.Option<EnsureRetailCustomerProfileResult>, ReadHandlerUnavailable> =>
  transaction.invoke(readRetailProfileByPartyRoutine, [partyResourceId]).pipe(
    Effect.mapError(readUnavailableFromRoutineFailure),
    Effect.flatMap(([row]): Effect.Effect<Option.Option<EnsureRetailCustomerProfileResult>, ReadHandlerUnavailable> => {
      if (row?.outcome === 'PROFILE_NOT_FOUND') {
        return Effect.succeedNone;
      }
      if (row?.outcome !== 'PROFILE_AVAILABLE') {
        return Effect.fail(readRetailProfileByPartyUnavailable(row?.outcome));
      }
      return Schema.decodeUnknownEffect(EnsureRetailCustomerProfileResultSchema)(row.payload).pipe(
        Effect.mapError((cause) =>
          preserveFailureCause(readUnavailable('The Retail Customer Profile projection is invalid'), cause),
        ),
        Effect.asSome,
      );
    }),
  );

/**
 * The lifecycle and revision of one Retail Customer Profile in the verified company, read through its owned routine.
 * None when the profile does not exist; a profile under owner reconciliation is a definite answer too, never treated
 * as current.
 */
export const readRetailProfileLifecycle = (
  transaction: ProfileScopedRoutineInvoker,
  profileId: string,
): Effect.Effect<
  Option.Option<{ readonly reconciling: boolean; readonly revision: number; readonly state: string }>,
  ReadHandlerUnavailable
> =>
  transaction.invoke(readProfileRoutine, [profileId, 'RETAIL']).pipe(
    Effect.mapError(readUnavailableFromRoutineFailure),
    Effect.flatMap(([row]) => {
      if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND') {
        return Effect.succeedNone;
      }
      const payload = Schema.decodeUnknownOption(ProfilePayloadSchema)(row.payload);
      if (
        (row.outcome !== 'PROFILE_AVAILABLE' && row.outcome !== 'PROFILE_RECONCILIATION_REQUIRED') ||
        Option.isNone(payload) ||
        payload.value.profileKind !== 'RETAIL'
      ) {
        return Effect.fail(readUnavailable('The Retail Customer Profile projection is invalid'));
      }
      return Effect.succeedSome({
        reconciling: row.outcome === 'PROFILE_RECONCILIATION_REQUIRED',
        revision: payload.value.revision,
        state: payload.value.state,
      });
    }),
  );

/**
 * The Retail Portal Profile Binding this exact profile and Principal already hold, or none.
 *
 * The durable authorization operation and state travel with it; the binding transition wrote them.
 * `outcome` is read from the binding's own lifecycle rather than from a transition the row does not
 * record: an Active binding is an activated one.
 */
export const readRetailPortalBindingForPrincipal = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  profileResourceId: string,
): Effect.Effect<Option.Option<RetailPortalBindingResult>, ReadHandlerUnavailable> =>
  transaction.invoke(resolvePrincipalRoutine, [profileResourceId, scope.principalId]).pipe(
    Effect.mapError(readUnavailableFromRoutineFailure),
    Effect.flatMap(
      ([principalRow]): Effect.Effect<Option.Option<RetailPortalBindingResult>, ReadHandlerUnavailable> => {
        if (principalRow?.outcome === 'PROFILE_NOT_FOUND' || principalRow?.outcome === 'RETAIL_PRINCIPAL_NOT_BOUND') {
          return Effect.succeedNone;
        }
        const principalPayload = principalRow === undefined ? undefined : principalPayloadFromRow(principalRow);
        if (principalPayload?.bindingId === undefined) {
          return Effect.fail(readUnavailable('The Retail Principal resolution names no single durable binding'));
        }
        return transaction.invoke(readBindingRoutine, [principalPayload.bindingId, scope.principalId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap((rows) => {
            const raw = availableBindingPayloadFromRow(rows[0]);
            if (raw === undefined) {
              return Effect.fail(readUnavailable('The Retail Portal binding projection is unavailable'));
            }
            const durable = {
              bindingRef: bindingRef(scope.tenantId, raw.bindingId),
              effectiveAt: raw.updatedAt,
              outcome: raw.state === 'ACTIVE' ? ('BINDING_ACTIVATED' as const) : ('BINDING_REVOKED' as const),
              revision: raw.revision,
              state: raw.state,
            };
            const authorization = bindingAuthorizationFromPayload(raw);
            const candidate =
              authorization === undefined
                ? durable
                : {
                    ...durable,
                    authorizationOperation: authorization.operation,
                    authorizationState: authorization.state,
                  };
            return Schema.decodeEffect(RetailPortalBindingResultSchema)(candidate).pipe(
              Effect.mapError((cause) =>
                preserveFailureCause(readUnavailable('The Retail Portal binding projection is invalid'), cause),
              ),
              Effect.asSome,
            );
          }),
        );
      },
    ),
  );

/** Enrollment confirms the original binding and the live baseline; aggregate ACTIVE alone is insufficient. */
export const retailEnrollmentBindingIsCurrentForPrincipal = Effect.fn('ProfilePersistence.enrollmentBindingIsCurrent')(
  function* retailEnrollmentBindingIsCurrentForPrincipalEffect(
    transaction: ProfileScopedRoutineInvoker,
    scope: ProfilePersistenceScope,
    expected: {
      readonly bindingId: string;
      readonly enrollmentEvidenceRef: string;
      readonly profileId: string;
    },
  ): Effect.fn.Return<boolean, ReadHandlerUnavailable> {
    const [principalRow] = yield* transaction
      .invoke(resolvePrincipalRoutine, [expected.profileId, scope.principalId])
      .pipe(Effect.mapError(readUnavailableFromRoutineFailure));
    const principal = principalRow === undefined ? undefined : principalPayloadFromRow(principalRow);
    if (principal?.bindingId !== expected.bindingId) {
      return false;
    }
    const [bindingRow] = yield* transaction
      .invoke(readBindingRoutine, [expected.bindingId, scope.principalId])
      .pipe(Effect.mapError(readUnavailableFromRoutineFailure));
    const binding = availableBindingPayloadFromRow(bindingRow);
    if (
      binding === undefined ||
      binding.bindingId !== expected.bindingId ||
      binding.profileId !== expected.profileId ||
      binding.principalId !== scope.principalId ||
      binding.enrollmentEvidenceRef !== expected.enrollmentEvidenceRef ||
      binding.state !== 'ACTIVE' ||
      binding.authorizationOperation !== 'grant' ||
      binding.authorizationState !== 'ACTIVE'
    ) {
      return false;
    }
    // The owner binding row is the whole authority (O67-Q1): its ACTIVE grant is the baseline.
    return true;
  },
);

export type CounterpartyRoleEligibility =
  | {
      readonly counterpartyResourceRevision?: string;
      readonly managedLegalEntityId: string;
      readonly observedAt?: string;
      readonly organizationProof?: typeof CurrentOrganizationCustomerRecordFactsSchema.Type;
      readonly outcome: 'ELIGIBLE';
      readonly partyResourceId?: string;
      readonly partyResourceRevision?: string;
      readonly roleResourceId: string;
      readonly roleResourceRevision: string;
      readonly validUntil?: string | null;
    }
  | { readonly outcome: 'INELIGIBLE' }
  | { readonly outcome: 'UNAVAILABLE' | 'INDETERMINATE' };

export class ProfilePersistenceDependencyFailure extends Schema.TaggedError<ProfilePersistenceDependencyFailure>()(
  'ProfilePersistenceDependencyFailure',
  { reason: Schema.String },
) {}

export interface ProfilePersistenceDependencies {
  readonly checkOrganizationSourceProfile?: (
    payload: CreateCounterpartyPurchasingProfilePayload,
    result: CreateCounterpartyPurchasingProfileResult,
    proof: typeof CurrentOrganizationCustomerRecordFactsSchema.Type,
  ) => Effect.Effect<void, ProfilePersistenceDependencyFailure>;
  readonly checkSourceProfile?: (
    source: CustomerProfileSourceAssertion,
    target: Readonly<{
      kind: 'PARTY' | 'RETAIL_CUSTOMER_PROFILE' | 'COUNTERPARTY_PURCHASING_PROFILE';
      resourceId: string;
    }>,
    profileKind: 'RETAIL' | 'COUNTERPARTY',
    partySourceReference?: CustomerProfilePartySourceReference,
  ) => Effect.Effect<void, ProfilePersistenceDependencyFailure>;
  readonly evaluateReactivation?: (payload: ProfileLifecyclePayload) => Effect.Effect<
    {
      readonly dependenciesSatisfied: boolean;
      readonly reconfirmationSatisfied: boolean;
    },
    ProfilePersistenceDependencyFailure
  >;
  /** Core's portal access over the binding Action's own transaction; a binding never commits without it. */
  readonly portalAccess?: AccessPortalWrites;
  readonly reconciliationOwnerVerifier?: ProfileReconciliationOwnerVerifierService;
  readonly resolveCounterpartyRole?: (input: {
    readonly counterpartyResourceId: string;
    readonly tenantId: string;
  }) => Effect.Effect<CounterpartyRoleEligibility, ProfilePersistenceDependencyFailure>;
  /** Invocation-bound target evidence rechecked against the native journal and Core identity in this transaction. */
  readonly resolveEnrollmentTargetBinding?: (
    payload: RetailPortalBindingPayload,
    actionInvocationId: string,
  ) => Effect.Effect<
    { readonly authBindingId: string; readonly principalId: string },
    RetailPortalBindingActionRejected
  >;
  readonly resolveGuestParty?: (input: {
    readonly correlationRoot: string;
    readonly guestEvidenceRef: string;
    readonly legalEntityId: string;
    readonly requestedAt: string;
    readonly tenantId: string;
  }) => Effect.Effect<GuestPartyResolutionOutcome, ProfilePersistenceDependencyFailure>;
  readonly resolveRetailParty?: (input: {
    readonly actionInvocationId: string;
    readonly compositionRevision: string;
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
  readonly resolveSourceCounterpartyRole?: (
    input: Readonly<{ counterpartyResourceId: string; tenantId: string }>,
    source: CustomerProfileSourceAssertion,
    partySourceReference: CustomerProfilePartySourceReference,
    payload: CreateCounterpartyPurchasingProfilePayload,
  ) => Effect.Effect<CounterpartyRoleEligibility, ProfilePersistenceDependencyFailure>;
  readonly resolveSourceRetailParty?: (
    input: Readonly<{ partyResourceId: string; tenantId: string }>,
    source: CustomerProfileSourceAssertion,
    partySourceReference: CustomerProfilePartySourceReference,
  ) => ReturnType<NonNullable<ProfilePersistenceDependencies['resolveRetailParty']>>;
}

const retailSourcePrivacyFailure = (cause: unknown) =>
  preserveFailureCause(
    new EnsureRetailCustomerProfileRejected({
      code: 'PRIVACY_DENIED',
      reason: 'Current Privacy does not permit this source Profile effect',
      retryable: false,
    }),
    cause,
  );
const counterpartySourcePrivacyFailure = (cause: unknown) =>
  preserveFailureCause(
    new CreateCounterpartyPurchasingProfileRejected({
      code: 'PRIVACY_DENIED',
      reason: 'Current Privacy does not permit this source Profile effect',
      retryable: false,
    }),
    cause,
  );

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
    const { partySourceReference, source } = payload;
    let resolveParty = dependencies.resolveRetailParty;
    if (source !== undefined) {
      const resolveSource = dependencies.resolveSourceRetailParty;
      resolveParty =
        resolveSource === undefined || partySourceReference === undefined
          ? undefined
          : (input) => resolveSource(input, source, partySourceReference);
    }
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
      actionInvocationId: context.actionInvocationId,
      compositionRevision: context.compositionRevision,
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
        const invocation =
          payload.source === undefined
            ? transaction.invoke(ensureRetailProfileRoutine, [
                payload.subject.partyRef.resourceId,
                partyResolution.partyResourceRevision,
                payload.trigger === 'GUEST_RETAIL_ATTRIBUTION' ? 'GUEST_ACCEPTANCE' : 'AUTHENTICATED',
                payload.effectiveAt,
                payload.trigger,
                context.actionInvocationId,
                scope.principalId,
              ])
            : Effect.gen(function* ensureSourceRetailProfile() {
                if (dependencies.checkSourceProfile === undefined) {
                  return yield* new EnsureRetailCustomerProfileRejected({
                    code: 'DEPENDENCY_UNAVAILABLE',
                    reason: 'Current source processing authority is unavailable',
                    retryable: true,
                  });
                }
                if (source === undefined) {
                  return yield* new EnsureRetailCustomerProfileRejected({
                    code: 'SOURCE_CONFLICT',
                    reason: 'Source assertion is unavailable',
                    retryable: false,
                  });
                }
                yield* dependencies
                  .checkSourceProfile(
                    source,
                    { kind: 'PARTY', resourceId: payload.subject.partyRef.resourceId },
                    'RETAIL',
                    partySourceReference,
                  )
                  .pipe(Effect.mapError(retailSourcePrivacyFailure));
                const rows = yield* transaction.invoke(ensureSourceProfileRoutine, [
                  scope.principalId,
                  context.actionInvocationId,
                  DateTime.formatIso(yield* DateTime.now),
                  {
                    payload,
                    profileKind: 'RETAIL',
                    proof: {
                      partyResourceId: partyResolution.partyResourceId,
                      partyResourceRevision: partyResolution.partyResourceRevision,
                    },
                  },
                ]);
                const result = rows[0]?.payload;
                if (
                  result !== null &&
                  result !== undefined &&
                  Schema.is(EnsureRetailCustomerProfileResultSchema)(result) &&
                  result.outcome !== 'PROFILE_CREATED'
                ) {
                  yield* dependencies
                    .checkSourceProfile(
                      source,
                      { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: result.profileRef.resourceId },
                      'RETAIL',
                    )
                    .pipe(Effect.mapError(retailSourcePrivacyFailure));
                }
                return rows;
              });
        return invocation.pipe(
          Effect.mapError((failure) =>
            Schema.is(EnsureRetailCustomerProfileRejected)(failure)
              ? failure
              : new EnsureRetailCustomerProfileRejected({
                  code: 'PERSISTENCE_UNAVAILABLE',
                  reason: routineFailureReason(failure),
                  retryable: true,
                }),
          ),
          Effect.flatMap(
            ([row]): Effect.Effect<EnsureRetailCustomerProfileResult, EnsureRetailCustomerProfileRejected> => {
              if (row === undefined) {
                return Effect.fail(
                  new EnsureRetailCustomerProfileRejected({
                    code: 'OUTCOME_INDETERMINATE',
                    reason: 'The Retail profile routine returned no durable outcome',
                    retryable: true,
                  }),
                );
              }
              if (row.payload !== null && Schema.is(EnsureRetailCustomerProfileResultSchema)(row.payload)) {
                return Effect.succeed(row.payload);
              }
              const code = row.outcome;
              return Effect.fail(
                new EnsureRetailCustomerProfileRejected({
                  code:
                    code === 'SUBJECT_NOT_RESOLVED_OR_INVALID' ||
                    code === 'PROFILE_KIND_OR_SUBJECT_CONFLICT' ||
                    code === 'PROFILE_RECONCILIATION_REQUIRED' ||
                    code === 'CURRENT_STATE_CONFLICT' ||
                    code === 'SOURCE_AUTHORITY_DENIED' ||
                    code === 'SOURCE_CONFLICT' ||
                    code === 'SOURCE_STALE'
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
    const { partySourceReference, source } = payload;
    let resolveRole = dependencies.resolveCounterpartyRole;
    if (source !== undefined) {
      const resolveSource = dependencies.resolveSourceCounterpartyRole;
      resolveRole =
        resolveSource === undefined || partySourceReference === undefined
          ? undefined
          : (input) => resolveSource(input, source, partySourceReference, payload);
    }
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
        if (eligibility.outcome !== 'ELIGIBLE' || eligibility.managedLegalEntityId !== scope.legalEntityId) {
          return Effect.fail(
            new CreateCounterpartyPurchasingProfileRejected({
              code:
                eligibility.outcome === 'INELIGIBLE' ||
                (eligibility.outcome === 'ELIGIBLE' && eligibility.managedLegalEntityId !== scope.legalEntityId)
                  ? 'COUNTERPARTY_ROLE_NOT_ELIGIBLE'
                  : 'DEPENDENCY_UNAVAILABLE',
              reason: 'A current Party-owned customer role is required',
              retryable: eligibility.outcome !== 'INELIGIBLE' && eligibility.outcome !== 'ELIGIBLE',
            }),
          );
        }
        const invocation =
          payload.source === undefined
            ? transaction.invoke(ensureCounterpartyProfileRoutine, [
                payload.subject.counterpartyRef.resourceId,
                null,
                eligibility.roleResourceId,
                eligibility.roleResourceRevision,
                payload.effectiveAt,
                payload.trigger,
                context.actionInvocationId,
                scope.principalId,
              ])
            : Effect.gen(function* ensureSourceCounterpartyProfile() {
                if (dependencies.checkSourceProfile === undefined || eligibility.partyResourceId === undefined) {
                  return yield* new CreateCounterpartyPurchasingProfileRejected({
                    code: 'DEPENDENCY_UNAVAILABLE',
                    reason: 'Current source Party and Privacy authority is unavailable',
                    retryable: true,
                  });
                }
                if (source === undefined) {
                  return yield* new CreateCounterpartyPurchasingProfileRejected({
                    code: 'SOURCE_CONFLICT',
                    reason: 'Source assertion is unavailable',
                    retryable: false,
                  });
                }
                if (eligibility.organizationProof === undefined) {
                  yield* dependencies
                    .checkSourceProfile(
                      source,
                      { kind: 'PARTY', resourceId: eligibility.partyResourceId },
                      'COUNTERPARTY',
                    )
                    .pipe(Effect.mapError(counterpartySourcePrivacyFailure));
                }
                const rows = yield* transaction.invoke(ensureSourceProfileRoutine, [
                  scope.principalId,
                  context.actionInvocationId,
                  DateTime.formatIso(yield* DateTime.now),
                  {
                    payload,
                    profileKind: 'COUNTERPARTY',
                    proof: {
                      counterpartyResourceRevision: eligibility.counterpartyResourceRevision ?? null,
                      partyResourceId: eligibility.partyResourceId,
                      partyResourceRevision: eligibility.partyResourceRevision ?? null,
                      roleResourceId: eligibility.roleResourceId,
                      roleResourceRevision: eligibility.roleResourceRevision,
                    },
                  },
                ]);
                const result = rows[0]?.payload;
                if (
                  result !== null &&
                  result !== undefined &&
                  Schema.is(CreateCounterpartyPurchasingProfileResultSchema)(result)
                ) {
                  if (eligibility.organizationProof === undefined) {
                    yield* dependencies
                      .checkSourceProfile(
                        source,
                        { kind: 'COUNTERPARTY_PURCHASING_PROFILE', resourceId: result.profileRef.resourceId },
                        'COUNTERPARTY',
                      )
                      .pipe(Effect.mapError(counterpartySourcePrivacyFailure));
                  } else if (result.outcome !== 'PROFILE_CREATED' || result.sourceEffect?.replayed === true) {
                    if (dependencies.checkOrganizationSourceProfile === undefined) {
                      return yield* counterpartySourcePrivacyFailure(
                        new ProfilePersistenceDependencyFailure({
                          reason: 'Current Organization Profile authority is unavailable',
                        }),
                      );
                    }
                    yield* dependencies
                      .checkOrganizationSourceProfile(payload, result, eligibility.organizationProof)
                      .pipe(Effect.mapError(counterpartySourcePrivacyFailure));
                  }
                }
                return rows;
              });
        return invocation.pipe(
          Effect.mapError((failure) =>
            Schema.is(CreateCounterpartyPurchasingProfileRejected)(failure)
              ? failure
              : new CreateCounterpartyPurchasingProfileRejected({
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
                const result: CreateCounterpartyPurchasingProfileResult = {
                  outcome: row.payload.outcome,
                  profileRef: row.payload.profileRef,
                  revision: row.payload.revision,
                  state: row.payload.state,
                };
                return row.payload.sourceEffect === undefined
                  ? Effect.succeed(result)
                  : Effect.succeed({ ...result, sourceEffect: row.payload.sourceEffect });
              }
              const code = row?.outcome;
              return Effect.fail(
                new CreateCounterpartyPurchasingProfileRejected({
                  code:
                    code === 'COUNTERPARTY_ROLE_NOT_ELIGIBLE' ||
                    code === 'PROFILE_RECONCILIATION_REQUIRED' ||
                    code === 'CURRENT_STATE_CONFLICT' ||
                    code === 'SOURCE_AUTHORITY_DENIED' ||
                    code === 'SOURCE_CONFLICT' ||
                    code === 'SOURCE_STALE'
                      ? code
                      : 'OUTCOME_INDETERMINATE',
                  reason: 'The Counterparty profile could not be created from current scoped state',
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
        return Effect.fail(
          new ProfileLifecycleActionRejected({
            code: lifecycleRejectionCode(row?.outcome),
            reason: 'The lifecycle transition was rejected by current scoped state',
            retryable: row === undefined,
          }),
        );
      }),
    );
  },
});

const bindingRejection = (
  code: RetailPortalBindingActionRejected['code'],
  reason: string,
  retryable: boolean,
): RetailPortalBindingActionRejected => new RetailPortalBindingActionRejected({ code, reason, retryable });

/** Core refused or could not write the bound person's portal access, so the binding rolls back with it. */
const portalAccessRejection = (failure: AccessPortalError): RetailPortalBindingActionRejected =>
  bindingRejection(
    failure.code === 'access_portal_unavailable' ? 'PERSISTENCE_UNAVAILABLE' : 'DEPENDENCY_UNAVAILABLE',
    `Core could not write the portal access of this binding (${failure.code})`,
    failure.code === 'access_portal_unavailable',
  );

/**
 * Whether the BIND names the person the continuation resolved for the Attempt. The continuation journals the
 * binding transition with a request digest over its intent — the Party the Attempt's candidate submission
 * established, the Principal it resolved for the Attempt's account subject and the Selling Legal Entity —
 * before it dispatches the call, so the payload names that Principal exactly when it reproduces the digest.
 */
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'BIND',
  portalAccess: AccessPortalWrites | undefined,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
): BindRetailPortalProfileServices;
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'RECOVER',
  portalAccess: AccessPortalWrites | undefined,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
): RecoverRetailPortalProfileBindingServices;
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'REVOKE',
  portalAccess: AccessPortalWrites | undefined,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
): RevokeRetailPortalProfileBindingServices;
function bindingServices(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  operation: 'BIND' | 'RECOVER' | 'REVOKE',
  portalAccess: AccessPortalWrites | undefined,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
):
  | BindRetailPortalProfileServices
  | RecoverRetailPortalProfileBindingServices
  | RevokeRetailPortalProfileBindingServices {
  /**
   * Who may establish this binding: the bound Principal itself through its own authentication binding,
   * or — for a BIND only — this module's own enrollment continuation acting for the subject that started
   * the Attempt the payload names as evidence.
   */
  const admitBinder = (payload: RetailPortalBindingPayload): Effect.Effect<void, RetailPortalBindingActionRejected> => {
    if (
      payload.profileRef.tenantId !== scope.tenantId ||
      payload.principalRef.tenantId !== scope.tenantId ||
      payload.sellingLegalEntityRef.resourceId !== scope.legalEntityId
    ) {
      return Effect.fail(
        bindingRejection(
          'BINDING_CONFLICT',
          'A current verified authentication binding and exact profile scope are required',
          false,
        ),
      );
    }
    if (payload.principalRef.resourceId === scope.principalId) {
      return Effect.void;
    }
    return operation === 'BIND' && scope.enrollmentContinuation === true && resolveEnrollmentTargetBinding !== undefined
      ? Effect.void
      : Effect.fail(bindingRejection('BINDING_CONFLICT', 'Only the bound Principal may change its own binding', false));
  };
  /**
   * The bound person's portal access follows the binding it stands for, in the same transaction: an
   * activation (BIND or RECOVER) is one source, named by the binding and the revision that activated it,
   * and a REVOKE ends exactly the activation it revokes.
   */
  const followBinding = (
    portal: AccessPortalWrites,
    payload: RetailPortalBindingPayload,
    result: RetailPortalBindingResult,
  ): Effect.Effect<void, RetailPortalBindingActionRejected> => {
    const activationRevision = operation === 'REVOKE' ? payload.expectedRevision : result.revision;
    if (activationRevision === null) {
      return Effect.fail(
        bindingRejection('OUTCOME_INDETERMINATE', 'The revoked binding names no activation to end', true),
      );
    }
    const input = {
      legalEntityId: scope.legalEntityId,
      principalId: payload.principalRef.resourceId,
      role: RETAIL_CUSTOMER_PORTAL_ROLE,
      source: retailPortalBindingActivationSource(result.bindingRef.resourceId, activationRevision),
    };
    return (operation === 'REVOKE' ? portal.revoke(input) : portal.grant(input)).pipe(
      Effect.mapError(portalAccessRejection),
      Effect.asVoid,
    );
  };
  const mutate = Effect.fn('ProfilePersistence.mutateRetailPortalBinding')(function* mutateRetailPortalBinding(
    payload: RetailPortalBindingPayload,
    actionInvocationId: string,
  ) {
    if (portalAccess === undefined) {
      return yield* bindingRejection(
        'DEPENDENCY_UNAVAILABLE',
        'Core portal access is not composed for this binding transaction',
        true,
      );
    }
    yield* admitBinder(payload);
    let target: { readonly authBindingId?: string; readonly principalId: string } | undefined;
    if (payload.principalRef.resourceId === scope.principalId) {
      target =
        scope.authBindingId === undefined
          ? { principalId: scope.principalId }
          : { authBindingId: scope.authBindingId, principalId: scope.principalId };
    } else if (resolveEnrollmentTargetBinding !== undefined) {
      target = yield* resolveEnrollmentTargetBinding(payload, actionInvocationId);
    }
    const authBindingId = target?.authBindingId;
    if (authBindingId === undefined || target?.principalId !== payload.principalRef.resourceId) {
      return yield* bindingRejection(
        'DEPENDENCY_UNAVAILABLE',
        'A current verified authentication binding and exact profile scope are required',
        true,
      );
    }
    const [row] = yield* transaction
      .invoke(mutateBindingRoutine, [
        payload.profileRef.resourceId,
        payload.principalRef.resourceId,
        authBindingId,
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
        Effect.mapError((failure) => bindingRejection('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true)),
      );
    if (
      row?.payload === null ||
      row?.payload === undefined ||
      !Schema.is(RetailPortalBindingResultSchema)(row.payload)
    ) {
      return yield* bindingRejection(
        bindingRejectionCode(row?.outcome),
        'The Retail Portal binding mutation was rejected by current scoped state',
        row === undefined,
      );
    }
    yield* followBinding(portalAccess, payload, row.payload);
    return row.payload;
  });
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
  const readProgress = (
    payload: ResolveProfileReconciliationPayload,
    unavailableOwners: Parameters<ResolveProfileReconciliationServices['ownerReconciler']['finalize']>[2],
    conflictingOwners: Parameters<ResolveProfileReconciliationServices['ownerReconciler']['finalize']>[3],
  ): Effect.Effect<ResolveProfileReconciliationResult, ProfileReconciliationActionRejected> =>
    transaction.invoke(readReconciliationRoutine, [payload.caseRef.resourceId]).pipe(
      Effect.mapError((failure) =>
        rejectReconciliation('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
      ),
      Effect.flatMap(
        ([row]): Effect.Effect<ResolveProfileReconciliationResult, ProfileReconciliationActionRejected> => {
          if (row === undefined || row.outcome === 'RECONCILIATION_NOT_FOUND') {
            return Effect.fail(
              rejectReconciliation('RECONCILIATION_NOT_FOUND', 'The reconciliation case does not exist', false),
            );
          }
          if (row.payload === null || !Schema.is(ReconciliationPayloadSchema)(row.payload)) {
            return Effect.fail(
              rejectReconciliation('OUTCOME_INDETERMINATE', 'The durable reconciliation progress is invalid', false),
            );
          }
          if (row.payload.state === 'COMPLETED') {
            return Effect.fail(
              rejectReconciliation(
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

  const ownerVerifier = dependencies.reconciliationOwnerVerifier ?? profileReconciliationOwnerVerifierUnavailable;

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
              ([row]): Effect.Effect<OpenProfileReconciliationResult, ProfileReconciliationActionRejected> => {
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
        finalize: (payload, expectedCaseRevision, unavailableOwners, conflictingOwners, context) => {
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
                rejectReconciliation('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
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
                  rejectReconciliation(
                    reconciliationRejectionCode(code),
                    'The reconciliation case could not be finalized',
                    reconciliationFailureIsRetryable(row),
                  ),
                );
              }),
            );
        },
        load: (caseRef, context) => {
          if (caseRef.tenantId !== scope.tenantId || context.scope.tenantId !== scope.tenantId) {
            return Effect.fail(
              rejectReconciliation('CURRENT_STATE_CONFLICT', 'The reconciliation case is outside scope', false),
            );
          }
          return transaction.invoke(readReconciliationRoutine, [caseRef.resourceId]).pipe(
            Effect.mapError((failure) =>
              rejectReconciliation('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
            ),
            Effect.flatMap(([row]) => {
              if (row?.payload !== null && Schema.is(ReconciliationPayloadSchema)(row?.payload)) {
                if (row.payload.state === 'COMPLETED') {
                  return Effect.fail(
                    rejectReconciliation(
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
                rejectReconciliation(
                  row?.outcome === 'RECONCILIATION_NOT_FOUND' ? 'RECONCILIATION_NOT_FOUND' : 'OUTCOME_INDETERMINATE',
                  'The durable reconciliation progress could not be loaded',
                  row === undefined,
                ),
              );
            }),
          );
        },
        record: (
          request: ProfileReconciliationOwnerOutcomeRecordRequest,
          context,
        ): Effect.Effect<ProfileReconciliationDurableProgress, ProfileReconciliationActionRejected> =>
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
                rejectReconciliation('PERSISTENCE_UNAVAILABLE', routineFailureReason(failure), true),
              ),
              Effect.flatMap(
                ([row]): Effect.Effect<ProfileReconciliationDurableProgress, ProfileReconciliationActionRejected> => {
                  if (
                    row?.payload !== null &&
                    row?.payload !== undefined &&
                    Schema.is(ProfileReconciliationDurableProgressSchema)(row.payload)
                  ) {
                    return Effect.succeed(row.payload);
                  }
                  const code = row?.outcome;
                  return Effect.fail(
                    rejectReconciliation(
                      reconciliationRejectionCode(code),
                      'The trusted owner outcome could not be recorded',
                      reconciliationFailureIsRetryable(row),
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
        let actionResult: AttributeGuestRetailCustomerResult;
        if (partyResolution.outcome === 'AMBIGUOUS_MATCH') {
          actionResult = { outcome: 'PARTY_AMBIGUOUS', reconciliationRef: partyResolution.caseRef };
        } else if (partyResolution.outcome === 'INVALID_OR_INSUFFICIENT_EVIDENCE') {
          actionResult = { outcome: 'PARTY_INVALID' };
        } else {
          actionResult = { outcome: 'PARTY_UNRESOLVED' };
        }
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
                  // oxlint-disable-next-line eslint/no-use-before-define -- The transaction helper is intentionally hoisted below the guest service definition.
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
                return recordGuestResult(transaction, scope, payload, attributed, context.actionInvocationId); // oxlint-disable-line eslint/no-use-before-define -- The transaction helper is intentionally hoisted below the guest service definition.
              }),
            );
        }
        return recordGuestResult(transaction, scope, payload, actionResult, context.actionInvocationId); // oxlint-disable-line eslint/no-use-before-define -- The transaction helper is intentionally hoisted below the guest service definition.
      }),
    );
  },
});

// oxlint-disable-next-line eslint/func-style -- Guest services intentionally use this hoisted helper before its declaration.
function recordGuestResult(
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  payload: Parameters<AttributeGuestRetailCustomerServices['attribute']>[0],
  result: AttributeGuestRetailCustomerResult,
  actionInvocationId: string,
): Effect.Effect<AttributeGuestRetailCustomerResult, AttributeGuestRetailCustomerRejected> {
  return transaction
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
                code: row?.outcome === 'CURRENT_STATE_CONFLICT' ? 'CURRENT_STATE_CONFLICT' : 'OUTCOME_INDETERMINATE',
                reason: 'Guest attribution correlation conflicts with durable current state',
                retryable: row === undefined,
              }),
            ),
      ),
    );
}

/**
 * The Retail Portal baseline is owner-local (O67-Q1): a binding holds the whole
 * `RETAIL_PORTAL_SELF_SERVICE_BASELINE` exactly while its grant is ACTIVE. There is no second
 * permission store left to read (O62).
 */
const readRetailPermissionProjection = (input: {
  readonly observedAt: string;
  readonly operation: RetailPortalBindingAuthorizationOperation;
  readonly state: RetailPortalBindingState;
}): RetailPermissionProjection => ({
  freshness: {
    observedAt: input.observedAt,
    sourceModuleId: 'commerce.customer-context' as const,
    status: 'CURRENT' as const,
  },
  permissions: input.operation === 'grant' && input.state === 'ACTIVE' ? [...RETAIL_PORTAL_SELF_SERVICE_BASELINE] : [],
});

const readServices = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  dependencies: ProfilePersistenceDependencies,
): {
  readonly customerProfileRead: CustomerProfileReadServices;
  readonly customerProfileTradingGate: CustomerProfileTradingGateServices;
  readonly guestAttributionStatus: GuestAttributionStatusServices;
  readonly marketSubjectRestrictionsCurrent: MarketSubjectRestrictionsCurrentServices;
  readonly profileReconciliationRead: ProfileReconciliationReadServices;
  readonly retailAccessDecision: RetailAccessDecisionServices;
  readonly retailPortalProfileBindingRead: RetailPortalProfileBindingReadServices;
  readonly retailPrincipalResolution: RetailPrincipalResolutionServices;
} => {
  const readProfile = (
    input: Parameters<CustomerProfileReadServices['readProfile']>[0],
  ): Effect.Effect<CustomerProfileReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
    transaction.invoke(readProfileRoutine, [input.profileRef.resourceId, profileKind(input.profileRef)]).pipe(
      Effect.mapError(readUnavailableFromRoutineFailure),
      Effect.flatMap(
        ([row]): Effect.Effect<CustomerProfileReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
          if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND') {
            return Effect.fail(readNotFound('The Customer Profile does not exist in the verified scope'));
          }
          if (row.outcome === 'PROFILE_RECONCILIATION_REQUIRED') {
            if (row.payload === null || !Schema.is(ProfileReconciliationRequiredPayloadSchema)(row.payload)) {
              return Effect.fail(readUnavailable('The Customer Profile reconciliation projection is invalid'));
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
            (row.payload.scopeLegalEntityId !== undefined && row.payload.scopeLegalEntityId !== scope.legalEntityId)
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
            unavailableSections: ['PARTY_IDENTITY', 'AUTHORIZATION', 'COMMERCE_SETTINGS'] as const,
          });
        },
      ),
    );

  const readRestrictionProfile = (
    input: MarketSubjectRestrictionsCurrentRequest,
  ): Effect.Effect<MarketSubjectRestrictionProfileResult, ReadHandlerUnavailable> => {
    const requestedProfileKind = input.subject.kind === 'RETAIL_PROFILE' ? 'RETAIL' : 'COUNTERPARTY';
    return transaction.invoke(readProfileRoutine, [input.subject.profileRef.resourceId, requestedProfileKind]).pipe(
      Effect.mapError(readUnavailableFromRoutineFailure),
      Effect.flatMap(([row]): Effect.Effect<MarketSubjectRestrictionProfileResult, ReadHandlerUnavailable> => {
        if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND') {
          return Effect.succeed({
            outcome: 'PROFILE_UNVERIFIABLE' as const,
            reason: 'The Purchasing Subject profile does not exist in the verified owner scope',
          });
        }
        if (row.outcome === 'PROFILE_RECONCILIATION_REQUIRED') {
          return Effect.succeed({
            outcome: 'PROFILE_UNVERIFIABLE' as const,
            reason: 'The Purchasing Subject profile is under owner reconciliation',
          });
        }
        if (row.payload === null || !Schema.is(ProfilePayloadSchema)(row.payload)) {
          return Effect.fail(readUnavailable('The Purchasing Subject restriction projection is invalid'));
        }
        const raw = row.payload;
        const sellerResourceId = raw.scopeLegalEntityId;
        if (
          sellerResourceId === undefined ||
          sellerResourceId !== scope.legalEntityId ||
          raw.profileKind !== requestedProfileKind
        ) {
          return Effect.fail(readUnavailable('The Purchasing Subject restriction projection is invalid'));
        }
        const sellerRef = {
          moduleId: 'core.identity' as const,
          resourceId: sellerResourceId,
          resourceType: 'core.identity.legal-entity' as const,
          tenantId: scope.tenantId,
        };
        if (raw.subject.kind === 'RETAIL') {
          return Effect.succeed({
            observation: {
              profileRef: {
                moduleId: 'commerce.customer-context' as const,
                resourceId: raw.profileId,
                resourceType: 'commerce.customer-context.retail-customer-profile' as const,
                tenantId: scope.tenantId,
              },
              revision: raw.revision,
              sellerRef,
              state: raw.state,
            },
            outcome: 'PROFILE_AVAILABLE' as const,
          });
        }
        return Effect.succeed({
          observation: {
            counterpartyResourceId: raw.subject.counterpartyResourceId,
            profileRef: {
              moduleId: 'commerce.customer-context' as const,
              resourceId: raw.profileId,
              resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
              tenantId: scope.tenantId,
            },
            revision: raw.revision,
            sellerRef,
            state: raw.state,
          },
          outcome: 'PROFILE_AVAILABLE' as const,
        });
      }),
    );
  };

  return {
    customerProfileRead: { readProfile: (input) => readProfile(input) },
    customerProfileTradingGate: {
      evaluateGate: (
        input,
      ): Effect.Effect<CustomerProfileTradingGateResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
        transaction.invoke(readTradingGateRoutine, [input.profileRef.resourceId, profileKind(input.profileRef)]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<
              CustomerProfileTradingGateResponse,
              ReadHandlerNotFound | ReadHandlerUnavailable
            > => {
              if (row === undefined || row.outcome === 'PROFILE_NOT_FOUND') {
                return Effect.fail(readNotFound('The Customer Profile does not exist in the verified scope'));
              }
              if (
                row.payload === null ||
                !Schema.is(ProfilePayloadSchema)(row.payload) ||
                (row.payload.scopeLegalEntityId !== undefined && row.payload.scopeLegalEntityId !== scope.legalEntityId)
              ) {
                return Effect.fail(readUnavailable('The Customer Profile trading projection is invalid'));
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
                return Effect.fail(readUnavailable('Current Counterparty Role evidence is unavailable'));
              }
              return resolveRole({
                counterpartyResourceId: profile.subject.counterpartyRef.resourceId,
                tenantId: scope.tenantId,
              }).pipe(
                Effect.mapError((cause) =>
                  readUnavailable(`Current Counterparty Role evidence is unavailable (${String(cause)})`),
                ),
                Effect.flatMap((eligibility) =>
                  DateTime.now.pipe(
                    // oxlint-disable-next-line sonarjs/no-nested-functions -- The timestamp mapper intentionally captures the resolved eligibility and scoped profile evidence inside this read transaction.
                    Effect.map((now) => {
                      const evaluatedAt = DateTime.formatIso(now);
                      const eligibleForScope =
                        eligibility.outcome === 'ELIGIBLE' && eligibility.managedLegalEntityId === scope.legalEntityId;
                      const roleProvenance =
                        eligibility.outcome === 'ELIGIBLE' && eligibility.roleResourceId !== undefined
                          ? [
                              {
                                freshness: {
                                  observedAt: evaluatedAt,
                                  revision: eligibility.roleResourceRevision,
                                  sourceModuleId: 'party.registry',
                                  status: eligibleForScope ? ('CURRENT' as const) : ('INDETERMINATE' as const),
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
                      let gate: CustomerProfileTradingGateResponse['gate'];
                      if (eligibleForScope) {
                        gate = {
                          canAcceptNewOrder: profile.state === 'ACTIVE',
                          outcome: profile.state,
                        };
                      } else if (
                        eligibility.outcome === 'INELIGIBLE' ||
                        (eligibility.outcome === 'ELIGIBLE' && !eligibleForScope)
                      ) {
                        gate = {
                          canAcceptNewOrder: false,
                          outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
                        };
                      } else {
                        gate = {
                          canAcceptNewOrder: false,
                          outcome: 'DEPENDENCY_UNAVAILABLE',
                        };
                      }
                      return {
                        evaluatedAt,
                        gate,
                        profileRef: profileReference,
                        provenance: [...profileProvenance(raw.updatedAt, raw.revision), ...roleProvenance],
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
      ): Effect.Effect<GuestAttributionStatusResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
        transaction.invoke(readGuestAttributionRoutine, [input.attributionCorrelationId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<GuestAttributionStatusResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
              if (row === undefined) {
                return Effect.fail(readNotFound('The Guest attribution does not exist in the verified scope'));
              }
              if (row.outcome === 'ATTRIBUTION_NOT_FOUND') {
                return Effect.fail(readNotFound('The Guest attribution does not exist in the verified scope'));
              }
              const raw = guestPayloadFromRow(row);
              if (raw === undefined) {
                return Effect.fail(readUnavailable('The Guest attribution projection is invalid'));
              }
              if (isCompletedGuestPayload(raw)) {
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
                      const reconciliationRequired = profileRow?.outcome === 'PROFILE_RECONCILIATION_REQUIRED';
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
                    if (profileRow.payload === null || !Schema.is(ProfilePayloadSchema)(profileRow.payload)) {
                      return Effect.fail(readUnavailable('The Guest attribution trading projection is invalid'));
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
                      profileRef: Option.some({
                        moduleId: retailRef.moduleId,
                        resourceId: retailRef.resourceId,
                        resourceType: retailRef.resourceType,
                        tenantId: retailRef.tenantId,
                      }),
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
                  outcome: incompleteGuestOutcome(raw.outcome),
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
    marketSubjectRestrictionsCurrent: { readRestrictionProfile },
    profileReconciliationRead: {
      readCase: (
        input,
      ): Effect.Effect<ProfileReconciliationReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
        transaction.invoke(readReconciliationRoutine, [input.reconciliationCaseRef.resourceId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<ProfileReconciliationReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
              if (row === undefined || row.outcome === 'RECONCILIATION_NOT_FOUND') {
                return Effect.fail(
                  readNotFound('The Profile Reconciliation Case does not exist in the verified scope'),
                );
              }
              if (row.payload === null || !Schema.is(ReconciliationPayloadSchema)(row.payload)) {
                return Effect.fail(readUnavailable('The Profile Reconciliation projection is invalid'));
              }
              const raw = row.payload;
              const eventVersion = BigInt(raw.lastProcessedEventVersion);
              const { ownerOutcomes } = raw;
              const involvedProfiles = raw.members.map((member) =>
                profileRef(scope.tenantId, member.profileId, member.profileKind),
              );
              const survivorProfile =
                raw.survivorProfileId === null
                  ? undefined
                  : profileRef(scope.tenantId, raw.survivorProfileId, raw.profileKind);
              const reconciliationCase = {
                caseRef: input.reconciliationCaseRef,
                conflictingProfiles: involvedProfiles,
                createdAt: raw.createdAt,
                lastProcessedEventVersion: eventVersion,
                ownerOutcomes,
                reason: raw.reason,
                revision: raw.revision,
                sourceCorrelationRef: raw.sourceCorrelationRef,
                state: raw.state,
                targetSubject: raw.targetSubject,
                trigger: raw.trigger,
                updatedAt: raw.updatedAt,
              };
              if (raw.resultingState !== null) {
                Object.assign(reconciliationCase, { resultingState: raw.resultingState });
              }
              if (survivorProfile !== undefined) {
                Object.assign(reconciliationCase, { survivorProfile });
              }
              return succeedProfileReconciliationRead({
                case: reconciliationCase,
                completion: {
                  complete: raw.state === 'COMPLETED',
                  outcome:
                    raw.state === 'COMPLETED' ? ('ALREADY_COMPLETED' as const) : ('RECONCILIATION_INCOMPLETE' as const),
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
      ): Effect.Effect<RetailAccessDecisionResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
        if (input.profileRef.tenantId !== tenantId || tenantId !== scope.tenantId) {
          return Effect.fail(readNotFound('The Retail Customer Profile does not exist in the trusted Tenant'));
        }
        return transaction.invoke(resolvePrincipalRoutine, [input.profileRef.resourceId, principalId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([principalRow]): Effect.Effect<
              RetailAccessDecisionResponse,
              ReadHandlerNotFound | ReadHandlerUnavailable
            > => {
              if (principalRow === undefined || principalRow.outcome === 'PROFILE_NOT_FOUND') {
                return Effect.fail(readNotFound('The Retail Customer Profile does not exist in the verified scope'));
              }
              if (principalRow.payload === null || !Schema.is(PrincipalPayloadSchema)(principalRow.payload)) {
                return Effect.fail(readUnavailable('The Retail Principal resolution projection is invalid'));
              }
              const principalPayload = principalRow.payload;
              const provenance = profileProvenance(principalPayload.observedAt, principalPayload.revision);
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
                return Effect.fail(readUnavailable('The Retail Principal binding reference is missing'));
              }
              const resolvedBindingRef = bindingRef(scope.tenantId, principalPayload.bindingId);
              return transaction.invoke(readBindingRoutine, [principalPayload.bindingId, principalId]).pipe(
                Effect.mapError(readUnavailableFromRoutineFailure),
                Effect.flatMap(
                  ([bindingRow]): Effect.Effect<
                    RetailAccessDecisionResponse,
                    ReadHandlerNotFound | ReadHandlerUnavailable
                  > => {
                    if (bindingRow === undefined) {
                      return Effect.succeed(
                        deniedRetailAccess(
                          input,
                          { allowed: false, outcome: 'BINDING_NOT_FOUND' },
                          { ...currentOwnerFreshness, status: 'INDETERMINATE' as const },
                          Option.some(resolvedBindingRef),
                          Option.none(),
                          provenance,
                        ),
                      );
                    }
                    if (bindingRow.outcome === 'BINDING_NOT_FOUND') {
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
                        !Schema.is(BindingReconciliationRequiredPayloadSchema)(bindingRow.payload)
                      ) {
                        return Effect.fail(readUnavailable('The Retail Portal reconciliation projection is invalid'));
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
                    const raw = bindingPayloadFromRow(bindingRow);
                    if (raw === undefined) {
                      return Effect.fail(readUnavailable('The Retail Portal binding projection is invalid'));
                    }
                    if (!bindingMatchesRetailAccessScope(raw, input, principalId)) {
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
                    const bindingAuthorization = bindingAuthorizationFromPayload(raw);
                    if (bindingAuthorization === undefined) {
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
                    const { operation: authorizationOperation, state: authorizationState } = bindingAuthorization;
                    // The binding row carries its final authorization, so the owner decides from it alone.
                    const authorizationFreshness = {
                      observedAt: raw.updatedAt,
                      revision: String(raw.revision),
                      sourceModuleId: 'commerce.customer-context' as const,
                      status: 'CURRENT' as const,
                    };
                    const { freshness, permissions } = readRetailPermissionProjection({
                      observedAt: raw.updatedAt,
                      operation: authorizationOperation,
                      state: authorizationState,
                    });
                    const decision = decideRetailPortalAccess({
                      authorizationOperation,
                      authorizationState,
                      authorizationStatus: 'AVAILABLE',
                      bindingState: raw.state,
                      boundProfile: { ...input.profileRef, kind: 'RETAIL' },
                      grantedPermissions: permissions,
                      requestedPermission: input.requiredPermission,
                      requestedProfile: { ...input.profileRef, kind: 'RETAIL' },
                    });
                    return Effect.succeed({
                      authorizationFreshness,
                      bindingRef: Option.some(resolvedBindingRef),
                      bindingState: Option.some(raw.state),
                      decision,
                      evaluatedAt: authorizationFreshness.observedAt,
                      profileRef: input.profileRef,
                      provenance: [
                        ...provenance,
                        { freshness: authorizationFreshness, projection: 'RETAIL_BINDING' as const },
                        { freshness, projection: 'OWNING_CAPABILITY' as const },
                      ],
                      requiredPermission: input.requiredPermission,
                    } satisfies RetailAccessDecisionResponse);
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
      ): Effect.Effect<RetailPortalProfileBindingReadResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
        transaction.invoke(readBindingRoutine, [input.bindingRef.resourceId, principalId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<
              RetailPortalProfileBindingReadResponse,
              ReadHandlerNotFound | ReadHandlerUnavailable
            > => {
              if (row === undefined) {
                return Effect.fail(readNotFound('The Retail Portal binding does not exist in the verified scope'));
              }
              if (row.outcome === 'BINDING_NOT_FOUND') {
                return Effect.fail(readNotFound('The Retail Portal binding does not exist in the verified scope'));
              }
              if (row.outcome === 'BINDING_RECONCILIATION_REQUIRED') {
                if (row.payload === null || !Schema.is(BindingReconciliationRequiredPayloadSchema)(row.payload)) {
                  return Effect.fail(readUnavailable('The Retail Portal reconciliation projection is invalid'));
                }
                const raw = row.payload;
                return succeedRetailPortalBindingRead({
                  _tag: 'BINDING_RECONCILIATION_REQUIRED' as const,
                  bindingRef: input.bindingRef,
                  profileRef: {
                    moduleId: 'commerce.customer-context' as const,
                    resourceId: raw.profileId,
                    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
                    tenantId: scope.tenantId,
                  },
                  provenance: profileProvenance(raw.observedAt, raw.revision),
                  reconciliationCaseRef: Option.some(reconciliationRef(scope.tenantId, raw.caseId)),
                });
              }
              const raw = bindingPayloadFromRow(row);
              if (raw === undefined) {
                return Effect.fail(readUnavailable('The Retail Portal binding projection is invalid'));
              }
              const observedAt = raw.updatedAt;
              const bindingAuthorization = bindingAuthorizationFromPayload(raw);
              if (bindingAuthorization === undefined) {
                return Effect.fail(
                  readUnavailable('The Retail Portal binding authorization projection is unavailable'),
                );
              }
              const { operation: authorizationOperation, state: authorizationState } = bindingAuthorization;
              const authorizationFreshness = {
                observedAt,
                revision: String(raw.revision),
                sourceModuleId: 'commerce.customer-context',
                status: 'CURRENT' as const,
              };
              return Effect.succeed(
                readRetailPermissionProjection({
                  observedAt,
                  operation: authorizationOperation,
                  state: authorizationState,
                }),
              ).pipe(
                Effect.map(({ freshness, permissions }): RetailPortalProfileBindingReadResponse => {
                  const binding = {
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
                    profileRef: {
                      moduleId: 'commerce.customer-context' as const,
                      resourceId: raw.profileId,
                      resourceType: 'commerce.customer-context.retail-customer-profile' as const,
                      tenantId: scope.tenantId,
                    },
                    revision: raw.revision,
                    sellingLegalEntityRef: sellingLegalEntityRef(scope),
                    state: raw.state,
                    updatedAt: raw.updatedAt,
                  };
                  if (raw.revokedAt !== null) {
                    Object.assign(binding, { revokedAt: raw.revokedAt });
                  }
                  return {
                    _tag: 'BINDING_AVAILABLE' as const,
                    authorizationFreshness,
                    binding,
                    completeness:
                      freshness.status === 'CURRENT' && authorizationFreshness.status === 'CURRENT'
                        ? ('FULL' as const)
                        : ('PARTIAL' as const),
                    grantedPermissions: permissions,
                    permissionsFreshness: freshness,
                    provenance: profileProvenance(observedAt, raw.revision),
                  };
                }),
              );
            },
          ),
        ),
    },
    retailPrincipalResolution: {
      resolvePrincipal: (
        input,
        principalId,
      ): Effect.Effect<RetailPrincipalResolutionResponse, ReadHandlerNotFound | ReadHandlerUnavailable> =>
        transaction.invoke(resolvePrincipalRoutine, [input.profileRef.resourceId, principalId]).pipe(
          Effect.mapError(readUnavailableFromRoutineFailure),
          Effect.flatMap(
            ([row]): Effect.Effect<RetailPrincipalResolutionResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
              if (row === undefined) {
                return Effect.fail(readNotFound('The Retail Customer Profile does not exist in the verified scope'));
              }
              if (row.outcome === 'PROFILE_NOT_FOUND') {
                return Effect.fail(readNotFound('The Retail Customer Profile does not exist in the verified scope'));
              }
              const payload = principalPayloadFromRow(row);
              if (payload === undefined) {
                return Effect.fail(readUnavailable('The Retail Principal resolution projection is invalid'));
              }
              const provenance = profileProvenance(payload.observedAt, payload.revision);
              if (row.outcome === 'RETAIL_PRINCIPAL_NOT_BOUND') {
                return succeedRetailPrincipalResolution({
                  _tag: 'RETAIL_PRINCIPAL_NOT_BOUND' as const,
                  profileRef: input.profileRef,
                  provenance,
                });
              }
              if (row.outcome === 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS') {
                return succeedRetailPrincipalResolution({
                  _tag: 'RETAIL_PRINCIPAL_RESOLUTION_AMBIGUOUS' as const,
                  profileRef: input.profileRef,
                  provenance,
                  reconciliationCaseRef: optionalReconciliationRef(scope.tenantId, payload.caseId),
                });
              }
              if (payload.bindingId === undefined) {
                return Effect.fail(readUnavailable('The Retail Principal binding reference is missing'));
              }
              return succeedRetailPrincipalResolution({
                _tag: retailPrincipalResolutionTag(row.outcome),
                bindingRef: bindingRef(scope.tenantId, payload.bindingId),
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
  readonly marketSubjectRestrictionsCurrent: MarketSubjectRestrictionsCurrentServices;
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
    bindRetailPortalProfile: bindingServices(
      transaction,
      scope,
      'BIND',
      dependencies.portalAccess,
      dependencies.resolveEnrollmentTargetBinding,
    ),
    createCounterpartyPurchasingProfile: counterpartyServices(transaction, scope, dependencies),
    customerProfileRead: reads.customerProfileRead,
    customerProfileTradingGate: reads.customerProfileTradingGate,
    ensureRetailCustomerProfile: ensureServices(transaction, scope, dependencies),
    guestAttributionStatus: reads.guestAttributionStatus,
    marketSubjectRestrictionsCurrent: reads.marketSubjectRestrictionsCurrent,
    openProfileReconciliation: reconciliation.open,
    profileReconciliationRead: reads.profileReconciliationRead,
    reactivateCustomerProfile: lifecycleServices(transaction, scope, 'REACTIVATE', dependencies),
    recoverRetailPortalProfileBinding: bindingServices(transaction, scope, 'RECOVER', dependencies.portalAccess),
    resolveProfileReconciliation: reconciliation.resolve,
    retailAccessDecision: reads.retailAccessDecision,
    retailPortalProfileBindingRead: reads.retailPortalProfileBindingRead,
    retailPrincipalResolution: reads.retailPrincipalResolution,
    revokeRetailPortalProfileBinding: bindingServices(transaction, scope, 'REVOKE', dependencies.portalAccess),
    suspendCustomerProfile: lifecycleServices(transaction, scope, 'SUSPEND', dependencies),
  };
};

export const reconcilePartyMergePersistenceForTransaction = (): ReconcilePartyMergePersistenceService => ({
  observe: (verifiedScope, observation: ReconcilePartyMergeObservation) => {
    if (observation.tenantId !== verifiedScope.tenantId || observation.legalEntityId !== verifiedScope.legalEntityId) {
      return Effect.fail(
        new ReconcilePartyMergeWorkerRejected({
          code: 'CROSS_TENANT_EVENT',
          reason: 'Party merge observation does not match the Core-verified Tenant and Selling Legal Entity scope',
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
        Effect.flatMap(([row]): Effect.Effect<ReconcilePartyMergeObservationResult, ReconcilePartyMergeWorkerError> => {
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
        }),
      );
  },
});
