import { Data, Effect, Schema, SchemaIssue } from 'effect';
import type { Redacted } from 'effect';

import { decodedStringBrand } from '../actions/string-schemas.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import {
  readPrincipalContextProvenanceSeal,
  sealPrincipalContextProvenance,
} from './principal-context-provenance-seal.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';

const SystemPrincipalContextSchema = Schema.Struct({
  authMethod: Schema.Literal('system'),
});
const SessionPrincipalContextSchema = Schema.Struct({
  authMethod: Schema.Literal('session'),
});
const CompositionRevisionSchema = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const systemProvenance = Object.freeze({ kind: 'system' });
const supportRecoveryProvenance = Object.freeze({ kind: 'support_recovery' });
const redeemedGatewayProvenance = Object.freeze({ kind: 'redeemed_gateway' });

/**
 * The redeemed gateway assertion a trusted database scope can be established from. It lives only in
 * the module-private provenance store, so it is never a property of, or serialized with, the context.
 */
export interface GatewayScopeAssertion {
  readonly assertion: Redacted.Redacted;
  readonly audience: string;
}

/**
 * The calling module of a delegated (version 3) gateway assertion. Only the Shell signs it, so a receiver can
 * trust it as the module that made the call, separately from the subject the call is done for.
 */
export interface VerifiedGatewayActor {
  readonly appId: string;
  readonly buildMarker: string;
  readonly principalId: string;
}

const uuid = Schema.String.check(Schema.isUUID());
const AdmissionInvocationIdSchema = decodedStringBrand(uuid, 'AdmissionInvocationId');
const ClaimIdSchema = decodedStringBrand(Schema.NonEmptyString, 'OutboxClaimId');
const DeclarationKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadDeclarationKey');
const EntrypointKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadEntrypointKey');
const JobKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadJobKey');
const LegalEntityIdSchema = decodedStringBrand(uuid, 'LegalEntityId');
const PrincipalIdSchema = decodedStringBrand(uuid, 'PrincipalId');
const SourceAppIdSchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadSourceAppId');
const TenantIdSchema = decodedStringBrand(uuid, 'TenantId');
const WorkerKeySchema = decodedStringBrand(Schema.NonEmptyString, 'OutboxWorkerKey');
const WorkerModuleKeySchema = decodedStringBrand(Schema.NonEmptyString, 'OutboxWorkerModuleKey');
const WorkloadKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadKey');
const PrincipalContextProvenanceCarrierSchema = Schema.Struct({
  authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
const OperationalLegalEntityCarrierSchema = Schema.Struct({ legalEntityId: LegalEntityIdSchema });

const ActionIdempotencyKeySchema = decodedStringBrand(Schema.NonEmptyString, 'ActionIdempotencyKey');
const ActionKeySchema = decodedStringBrand(Schema.NonEmptyString, 'ActionKey');
const RequestHashSchema = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));

/** Historical owner evidence authorizes only the exact independently authorized receipt Read. */
export const RegisteredGatewayRecoverySchema = Schema.Struct({
  originalActionInvocationId: AdmissionInvocationIdSchema,
  originalActionKey: ActionKeySchema,
  originalAuthContextRef: Schema.NonEmptyString,
  originalIdempotencyKey: ActionIdempotencyKeySchema,
  originalPrincipalId: PrincipalIdSchema,
  originalRequestHash: RequestHashSchema,
  requestHash: RequestHashSchema,
});
export type RegisteredGatewayRecovery = typeof RegisteredGatewayRecoverySchema.Type;

export const RegisteredGatewayOrganizationProcessingReadSchema = Schema.Struct({ requestHash: RequestHashSchema });
export type RegisteredGatewayOrganizationProcessingRead = typeof RegisteredGatewayOrganizationProcessingReadSchema.Type;

/** Signed by Shell only after native delivery and registered binding admission. */
export const RegisteredGatewayWorkloadSchema = Schema.Struct({
  admissionInvocationId: AdmissionInvocationIdSchema,
  bindingIncarnation: Schema.String.check(Schema.isUUID()),
  claimId: Schema.optionalKey(ClaimIdSchema),
  declarationKey: DeclarationKeySchema,
  entrypointKey: EntrypointKeySchema,
  jobKey: JobKeySchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  legalEntityScope: Schema.Literals(['forbidden', 'optional', 'required']),
  organizationProcessingRead: Schema.optionalKey(RegisteredGatewayOrganizationProcessingReadSchema),
  originalOwnerBindingIncarnation: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  originalPrincipalId: PrincipalIdSchema,
  originalWorkloadBindingIncarnation: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  originalWorkloadKey: Schema.optionalKey(WorkloadKeySchema),
  recovery: Schema.optionalKey(RegisteredGatewayRecoverySchema),
  runReference: Schema.String.check(Schema.isUUID()),
  schemaVersion: Schema.NonEmptyString,
  sourceAppId: SourceAppIdSchema,
  sourceBuildMarker: Schema.NonEmptyString,
  sourceMode: Schema.Literals(['worker', 'admission', 'historical_delivery']),
  workerKey: Schema.optionalKey(WorkerKeySchema),
  workerModuleKey: Schema.optionalKey(WorkerModuleKeySchema),
  workloadKey: WorkloadKeySchema,
}).check(
  Schema.makeFilter((workload) =>
    workload.organizationProcessingRead === undefined ||
    (workload.recovery === undefined &&
      workload.legalEntityScope === 'required' &&
      workload.legalEntityId !== undefined)
      ? undefined
      : 'Organization processing authority permits only its exact scoped Read without recovery',
  ),
  Schema.makeFilter((workload) =>
    workload.sourceMode !== 'historical_delivery' ||
    (workload.recovery !== undefined &&
      workload.claimId === undefined &&
      workload.workerKey !== undefined &&
      workload.workerModuleKey !== undefined)
      ? undefined
      : 'Historical deliveries authorize only exact recovery reads without a current claim',
  ),
  Schema.makeFilter((workload) =>
    workload.recovery !== undefined ||
    (workload.originalWorkloadKey !== undefined &&
      workload.originalWorkloadBindingIncarnation !== undefined &&
      workload.originalOwnerBindingIncarnation !== undefined)
      ? undefined
      : 'Fresh workload authority requires the current original admission and owner bindings',
  ),
);
export type RegisteredGatewayWorkload = typeof RegisteredGatewayWorkloadSchema.Type;

const routeIdentity = Schema.NonEmptyString.check(Schema.isMaxLength(200), Schema.isTrimmed());
const routeOperation = Schema.Struct({
  entrypointKey: decodedStringBrand(routeIdentity, 'GatewayRouteEntrypointKey'),
  schemaVersion: Schema.NonEmptyString.check(Schema.isMaxLength(40), Schema.isTrimmed()),
});

/** Shell-attested finite operations for one admitted private route and exact company context. */
export const RegisteredGatewayRouteScopeSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  mappingVersion: Schema.optionalKey(routeIdentity),
  operations: Schema.Array(routeOperation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.makeFilter((operations) =>
      new Set(operations.map((operation) => operation.entrypointKey)).size === operations.length
        ? undefined
        : 'A registered route scope must name distinct operation entrypoints',
    ),
  ),
  principalId: PrincipalIdSchema,
  replayIdempotencyDigest: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(Schema.brand('GatewayRouteReplayDigest')),
  ),
  routeId: decodedStringBrand(uuid, 'GatewayRouteId'),
  routeKey: decodedStringBrand(routeIdentity, 'GatewayRouteKey'),
  routeRevision: decodedStringBrand(routeIdentity, 'GatewayRouteRevision'),
  sourceMappingVersion: Schema.optionalKey(routeIdentity),
  sourceRouteId: decodedStringBrand(uuid, 'GatewaySourceRouteId'),
  sourceRouteRevision: decodedStringBrand(routeIdentity, 'GatewaySourceRouteRevision'),
  tenantId: TenantIdSchema,
});
export type RegisteredGatewayRouteScope = typeof RegisteredGatewayRouteScopeSchema.Type;

export const PrivacyDispatchOperationSchema = Schema.Literals([
  'SymmyRetention',
  'SymmyReceipt',
  'PrivacyEligibility',
  'PrivacyOutcome',
]);
export type PrivacyDispatchOperation = typeof PrivacyDispatchOperationSchema.Type;
const FiniteGatewayOperationTargetSchema = Schema.Struct({
  access: Schema.Literals(['read', 'write']),
  appId: decodedStringBrand(routeIdentity, 'FiniteGatewayTargetAppId'),
  declarationKey: DeclarationKeySchema,
  entrypointKey: EntrypointKeySchema,
  legalEntityScope: Schema.Literals(['optional', 'required']),
  moduleId: decodedStringBrand(routeIdentity, 'FiniteGatewayTargetModuleId'),
  schemaVersion: Schema.NonEmptyString.check(Schema.isMaxLength(40), Schema.isTrimmed()),
});
export type FiniteGatewayOperationTarget = typeof FiniteGatewayOperationTargetSchema.Type;
const FiniteDispatchAuthoritySchema = Schema.Struct({
  consumerModuleKey: WorkerModuleKeySchema,
  originActionKey: ActionKeySchema,
  originCapabilityKey: DeclarationKeySchema,
  producerModuleKey: WorkerModuleKeySchema,
  subjectResourceType: routeIdentity,
  targetAccess: Schema.Literals(['tenant-scope', 'tenant-unrestricted-list', 'delegated-actor']),
  topic: routeIdentity,
  workerKey: WorkerKeySchema,
});
type FiniteDispatchAuthority = typeof FiniteDispatchAuthoritySchema.Type;
const SealedFiniteGatewayTargetSchema = Schema.Struct({ target: FiniteGatewayOperationTargetSchema });
const SealedFiniteDispatchAuthoritySchema = Schema.Struct({
  authority: FiniteDispatchAuthoritySchema,
  target: FiniteGatewayOperationTargetSchema,
});
export const RegisteredGatewayPrivacyDispatchSchema = Schema.Struct({
  authority: Schema.optionalKey(FiniteDispatchAuthoritySchema),
  claimId: Schema.optionalKey(ClaimIdSchema),
  deliveryId: decodedStringBrand(uuid, 'PrivacyDispatchDeliveryId'),
  dispatchInvocationId: AdmissionInvocationIdSchema,
  domainEventId: decodedStringBrand(uuid, 'PrivacyDispatchDomainEventId'),
  governanceLegalEntityId: LegalEntityIdSchema,
  handoffHash: RequestHashSchema,
  measureId: decodedStringBrand(Schema.NonEmptyString, 'PrivacyMeasureId'),
  messageId: decodedStringBrand(uuid, 'PrivacyDispatchMessageId'),
  operation: PrivacyDispatchOperationSchema,
  principalId: PrincipalIdSchema,
  requestHash: RequestHashSchema,
  sourceMode: Schema.Literals(['worker', 'dispatch']),
  target: Schema.optionalKey(FiniteGatewayOperationTargetSchema),
  taskId: decodedStringBrand(Schema.NonEmptyString, 'PrivacyTaskId'),
  tenantId: TenantIdSchema,
  workerKey: Schema.optionalKey(WorkerKeySchema),
  workerModuleKey: Schema.optionalKey(WorkerModuleKeySchema),
}).check(
  Schema.makeFilter((value) => {
    if (value.sourceMode === 'worker') {
      return value.claimId !== undefined && value.workerKey !== undefined && value.workerModuleKey !== undefined
        ? undefined
        : 'A worker Privacy dispatch requires its current native claim';
    }
    return value.claimId === undefined && value.workerKey === undefined && value.workerModuleKey === undefined
      ? undefined
      : 'Durable dispatch authority permits only its exact receipt read';
  }),
);
export type RegisteredGatewayPrivacyDispatch = typeof RegisteredGatewayPrivacyDispatchSchema.Type;
export const RegisteredGatewayOrganizationGovernanceReadSchema = Schema.Struct({
  governanceLegalEntityId: LegalEntityIdSchema,
  principalId: PrincipalIdSchema,
  requestHash: RequestHashSchema,
  target: Schema.optionalKey(FiniteGatewayOperationTargetSchema),
  tenantId: TenantIdSchema,
});
export type RegisteredGatewayOrganizationGovernanceRead = typeof RegisteredGatewayOrganizationGovernanceReadSchema.Type;
interface RedeemedGatewayProvenance {
  readonly actor?: VerifiedGatewayActor | undefined;
  readonly compositionRevision: string;
  readonly organizationGovernanceRead?: RegisteredGatewayOrganizationGovernanceRead | undefined;
  readonly privacyDispatch?: RegisteredGatewayPrivacyDispatch | undefined;
  readonly routeScope?: RegisteredGatewayRouteScope | undefined;
  readonly scopeAssertion?: GatewayScopeAssertion | undefined;
  readonly workload?: RegisteredGatewayWorkload | undefined;
}

const GatewayScopeAssertionSchema = Schema.Struct({
  assertion: Schema.Redacted(Schema.String),
  audience: Schema.String.check(Schema.isMinLength(1)),
});
const VerifiedGatewayActorSchema = Schema.Struct({
  appId: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('GatewayActorAppId')),
  buildMarker: Schema.String.check(Schema.isMinLength(1)),
  principalId: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('GatewayActorPrincipalId')),
});

const PrincipalContextProvenanceInvariant = Schema.TaggedError<Error>()('PrincipalContextProvenanceInvariant', {
  reason: Schema.String,
});

export class TrustedPrincipalContextDecodeError extends Data.TaggedError('TrustedPrincipalContextDecodeError')<{
  readonly cause?: unknown;
}> {}

type PrincipalContextProvenanceToken =
  | typeof supportRecoveryProvenance
  | typeof systemProvenance
  | typeof redeemedGatewayProvenance;

export interface PrincipalContextProvenance {
  readonly actionRegistration?: object;
  readonly redeemedGateway?: RedeemedGatewayProvenance;
  readonly token: PrincipalContextProvenanceToken;
}

const attachPrincipalContextProvenance = <Context extends TrustedPrincipalContext>(
  context: Context,
  provenance: PrincipalContextProvenance,
): Context => {
  const carrier = { ...context };
  sealPrincipalContextProvenance(carrier, provenance);
  return Object.freeze(carrier);
};

const readPrincipalContextProvenance = <Context>(
  context: Context,
  token: PrincipalContextProvenanceToken,
): PrincipalContextProvenance | undefined => {
  if (!Schema.is(PrincipalContextProvenanceCarrierSchema)(context)) {
    return undefined;
  }
  const provenance = readPrincipalContextProvenanceSeal(context);
  if (!Schema.is(TrustedPrincipalContextSchema)(context)) {
    // A derived operational scope carries the signed company separately from the tenant-local system Principal.
    const workload = provenance?.redeemedGateway?.workload;
    if (
      workload?.legalEntityId === undefined ||
      !Schema.is(OperationalLegalEntityCarrierSchema)(context) ||
      context.legalEntityId !== workload.legalEntityId ||
      !Schema.is(TrustedPrincipalContextSchema)(
        Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'legalEntityId')),
      )
    ) {
      return undefined;
    }
  }
  return provenance?.token === token ? provenance : undefined;
};

const hasSystemProvenance = <Context>(context: Context): boolean =>
  readPrincipalContextProvenance(context, systemProvenance) !== undefined;

const readSupportRecoveryAction = <Context>(context: Context): object | null =>
  readPrincipalContextProvenance(context, supportRecoveryProvenance)?.actionRegistration ?? null;

const readRedeemedGatewayProvenance = <Context>(context: Context): RedeemedGatewayProvenance | undefined =>
  readPrincipalContextProvenance(context, redeemedGatewayProvenance)?.redeemedGateway;

const hasRedeemedGatewayProvenance = <Context>(context: Context): boolean =>
  readRedeemedGatewayProvenance(context) !== undefined;

const failProvenanceInvariant = (reason: string): never => {
  throw new PrincipalContextProvenanceInvariant({ reason });
};

export const trustResolvedSystemPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
): Context => {
  if (!Schema.is(SystemPrincipalContextSchema)(context)) {
    return failProvenanceInvariant('Only resolved system contexts can carry system provenance');
  }
  return attachPrincipalContextProvenance(context, { token: systemProvenance });
};

export const isTrustedSystemPrincipalContext = <Context>(context: Context): boolean =>
  (hasSystemProvenance(context) || readRedeemedGatewayProvenance(context)?.workload !== undefined) &&
  Schema.is(SystemPrincipalContextSchema)(context);

const routeScopeMatchesPrincipal = (
  routeScope: RegisteredGatewayRouteScope,
  context: TrustedPrincipalContext,
  actor: VerifiedGatewayActor | undefined,
  workload: RegisteredGatewayWorkload | undefined,
): boolean =>
  Schema.is(RegisteredGatewayRouteScopeSchema)(routeScope) &&
  actor === undefined &&
  workload === undefined &&
  context.authMethod === 'api_key' &&
  context.authenticationNamespaceId !== undefined &&
  context.principalId === routeScope.principalId &&
  context.tenantId === routeScope.tenantId &&
  context.legalEntityId === routeScope.legalEntityId;

const freezeRegisteredGatewayWorkload = (workload: RegisteredGatewayWorkload): RegisteredGatewayWorkload => {
  if (workload.organizationProcessingRead !== undefined) {
    return Object.freeze({
      ...workload,
      organizationProcessingRead: Object.freeze({ ...workload.organizationProcessingRead }),
    });
  }
  if (workload.recovery !== undefined) {
    return Object.freeze({ ...workload, recovery: Object.freeze({ ...workload.recovery }) });
  }
  return Object.freeze({ ...workload });
};

const privacyDispatchMatchesPrincipal = (
  dispatch: RegisteredGatewayPrivacyDispatch,
  context: TrustedPrincipalContext,
  actor: VerifiedGatewayActor | undefined,
  workload: RegisteredGatewayWorkload | undefined,
  route: RegisteredGatewayRouteScope | undefined,
): boolean =>
  Schema.is(RegisteredGatewayPrivacyDispatchSchema)(dispatch) &&
  dispatch.target !== undefined &&
  dispatch.authority !== undefined &&
  (dispatch.sourceMode === 'dispatch' ||
    (dispatch.workerKey === dispatch.authority.workerKey &&
      dispatch.workerModuleKey === dispatch.authority.consumerModuleKey)) &&
  actor !== undefined &&
  workload === undefined &&
  route === undefined &&
  (context.authMethod === 'session' || context.authMethod === 'api_key') &&
  context.impersonatedByPrincipalId === undefined &&
  context.principalId === dispatch.principalId &&
  context.tenantId === dispatch.tenantId &&
  context.legalEntityId === dispatch.governanceLegalEntityId;

const organizationGovernanceReadMatchesPrincipal = (
  read: RegisteredGatewayOrganizationGovernanceRead,
  context: TrustedPrincipalContext,
  actor: VerifiedGatewayActor | undefined,
  workload: RegisteredGatewayWorkload | undefined,
  route: RegisteredGatewayRouteScope | undefined,
  dispatch: RegisteredGatewayPrivacyDispatch | undefined,
): boolean =>
  workload === undefined &&
  route === undefined &&
  dispatch === undefined &&
  Schema.is(RegisteredGatewayOrganizationGovernanceReadSchema)(read) &&
  read.target?.access === 'read' &&
  read.target.legalEntityScope === 'required' &&
  actor !== undefined &&
  (context.authMethod === 'session' || context.authMethod === 'api_key') &&
  context.authenticationNamespaceId !== undefined &&
  context.impersonatedByPrincipalId === undefined &&
  context.principalId === read.principalId &&
  context.tenantId === read.tenantId &&
  context.legalEntityId === read.governanceLegalEntityId;

const freezeFiniteGatewayMetadata = <
  Metadata extends { readonly authority?: FiniteDispatchAuthority; readonly target?: FiniteGatewayOperationTarget },
>(
  metadata: Metadata | undefined,
) => {
  if (metadata === undefined) {
    return metadata;
  }
  const snapshot = { ...metadata };
  if (metadata.target !== undefined) {
    Object.assign(snapshot, { target: Object.freeze({ ...metadata.target }) });
  }
  if (metadata.authority !== undefined) {
    Object.assign(snapshot, { authority: Object.freeze({ ...metadata.authority }) });
  }
  return Object.freeze(snapshot);
};

/**
 * Marks a context only after an audience-bound gateway assertion has been verified and redeemed. The
 * optional scope assertion is the redeemed token a trusted database scope is established from.
 */
export const trustVerifiedGatewayPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
  compositionRevision: string,
  scopeAssertion?: GatewayScopeAssertion,
  actor?: VerifiedGatewayActor,
  workload?: RegisteredGatewayWorkload,
  routeScope?: RegisteredGatewayRouteScope,
  privacyDispatch?: RegisteredGatewayPrivacyDispatch,
  organizationGovernanceRead?: RegisteredGatewayOrganizationGovernanceRead,
): Context => {
  if (!Schema.is(CompositionRevisionSchema)(compositionRevision)) {
    return failProvenanceInvariant('Verified gateway provenance requires its signed composition revision');
  }
  if (scopeAssertion !== undefined && !Schema.is(GatewayScopeAssertionSchema)(scopeAssertion)) {
    return failProvenanceInvariant('A gateway scope assertion requires its audience and redacted assertion');
  }
  if (actor !== undefined && !Schema.is(VerifiedGatewayActorSchema)(actor)) {
    return failProvenanceInvariant('A gateway actor requires its app identifier, build marker and principal');
  }
  if (
    workload !== undefined &&
    (!Schema.is(RegisteredGatewayWorkloadSchema)(workload) ||
      actor !== undefined ||
      !Schema.is(SystemPrincipalContextSchema)(context))
  ) {
    return failProvenanceInvariant('A workload gateway context requires a registered system workload');
  }
  if (routeScope !== undefined && !routeScopeMatchesPrincipal(routeScope, context, actor, workload)) {
    return failProvenanceInvariant('A registered route scope requires its exact API-key principal and company');
  }
  if (
    privacyDispatch !== undefined &&
    !privacyDispatchMatchesPrincipal(privacyDispatch, context, actor, workload, routeScope)
  ) {
    return failProvenanceInvariant('A Privacy dispatch requires its exact human and governance context');
  }
  if (
    organizationGovernanceRead !== undefined &&
    !organizationGovernanceReadMatchesPrincipal(
      organizationGovernanceRead,
      context,
      actor,
      workload,
      routeScope,
      privacyDispatch,
    )
  ) {
    return failProvenanceInvariant(
      'An Organization governance read requires its exact original human and governance scope',
    );
  }
  const redeemedGateway: RedeemedGatewayProvenance = Object.freeze({
    actor:
      actor === undefined
        ? undefined
        : Object.freeze({ appId: actor.appId, buildMarker: actor.buildMarker, principalId: actor.principalId }),
    compositionRevision,
    organizationGovernanceRead: freezeFiniteGatewayMetadata(organizationGovernanceRead),
    privacyDispatch: freezeFiniteGatewayMetadata(privacyDispatch),
    routeScope:
      routeScope === undefined
        ? undefined
        : Object.freeze({
            ...routeScope,
            operations: Object.freeze(routeScope.operations.map((operation) => Object.freeze({ ...operation }))),
          }),
    scopeAssertion:
      scopeAssertion === undefined
        ? undefined
        : Object.freeze({ assertion: scopeAssertion.assertion, audience: scopeAssertion.audience }),
    workload: workload === undefined ? undefined : freezeRegisteredGatewayWorkload(workload),
  });
  return Object.freeze(
    attachPrincipalContextProvenance(context, { redeemedGateway, token: redeemedGatewayProvenance }),
  );
};

/** Returns only the revision carried by this exact verified and redeemed context. */
export const readVerifiedGatewayCompositionRevision = <Context>(context: Context): string | undefined =>
  readRedeemedGatewayProvenance(context)?.compositionRevision;

/** Returns the finite read marker only for this exact verified and redeemed human context. */
export const readVerifiedGatewayOrganizationGovernanceRead = <Context>(
  context: Context,
): (RegisteredGatewayOrganizationGovernanceRead & typeof SealedFiniteGatewayTargetSchema.Type) | undefined => {
  const read = readRedeemedGatewayProvenance(context)?.organizationGovernanceRead;
  return Schema.is(SealedFiniteGatewayTargetSchema)(read) ? read : undefined;
};

/** Returns the redeemed gateway assertion carried by this exact verified context, if any. */
export const readVerifiedGatewayScopeAssertion = <Context>(context: Context): GatewayScopeAssertion | undefined =>
  readRedeemedGatewayProvenance(context)?.scopeAssertion;

/** Returns the calling module that a delegated gateway assertion names, if this context carries one. */
export const readVerifiedGatewayActor = <Context>(context: Context): VerifiedGatewayActor | undefined =>
  readRedeemedGatewayProvenance(context)?.actor;

export const readVerifiedGatewayWorkload = <Context>(context: Context): RegisteredGatewayWorkload | undefined =>
  readRedeemedGatewayProvenance(context)?.workload;

/** Returns only the signed finite native Privacy dispatch bound to this exact redeemed carrier. */
export const readVerifiedGatewayPrivacyDispatch = <Context>(
  context: Context,
): (RegisteredGatewayPrivacyDispatch & typeof SealedFiniteDispatchAuthoritySchema.Type) | undefined => {
  const dispatch = readRedeemedGatewayProvenance(context)?.privacyDispatch;
  return Schema.is(SealedFiniteDispatchAuthoritySchema)(dispatch) ? dispatch : undefined;
};

/** Returns only the Shell-attested private route scope sealed on this exact redeemed carrier. */
export const readVerifiedGatewayRouteScope = <Context>(context: Context): RegisteredGatewayRouteScope | undefined =>
  readRedeemedGatewayProvenance(context)?.routeScope;

export const readVerifiedGatewayRecovery = <Context>(context: Context): RegisteredGatewayRecovery | undefined =>
  readRedeemedGatewayProvenance(context)?.workload?.recovery;

export const isVerifiedGatewayPrincipalContext = <Context>(context: Context): boolean =>
  hasRedeemedGatewayProvenance(context);

const GatewayPrincipalContextFieldsSchema = Schema.Struct(TrustedPrincipalContextSchema.fields);

/** Returns only the finite processing Read restriction sealed into this exact workload scope. */
export const readVerifiedGatewayOrganizationProcessingRead = <Context>(
  context: Context,
): RegisteredGatewayOrganizationProcessingRead | undefined =>
  readRedeemedGatewayProvenance(context)?.workload?.organizationProcessingRead;

/** Exact Core-sealed gateway context, including its signed derived operational company. */
export const VerifiedGatewayPrincipalContextSchema = Schema.declareConstructor<TrustedPrincipalContext>()(
  [],
  () => (input, ast, options) =>
    hasRedeemedGatewayProvenance(input) && Schema.is(GatewayPrincipalContextFieldsSchema)(input)
      ? Effect.succeed(input)
      : Effect.fail(new SchemaIssue.InvalidType(ast, input, options)),
);

export const trustSupportRecoveryPrincipalContext = <
  Context extends TrustedPrincipalContext,
  Registration extends object,
>(
  context: Context,
  actionRegistration: Registration,
): Context => {
  if (!Schema.is(SessionPrincipalContextSchema)(context)) {
    return failProvenanceInvariant('Only resolved session contexts can carry support recovery provenance');
  }
  return attachPrincipalContextProvenance(context, { actionRegistration, token: supportRecoveryProvenance });
};

export const isTrustedSupportRecoveryPrincipalContext = <Context, Registration extends object = object>(
  context: Context,
  actionRegistration?: Registration,
): boolean => {
  const trustedActionRegistration = readSupportRecoveryAction(context);
  return (
    trustedActionRegistration !== null &&
    (actionRegistration === undefined || trustedActionRegistration === actionRegistration) &&
    Schema.is(SessionPrincipalContextSchema)(context)
  );
};

export const preserveSystemPrincipalContextTrust = <Source, Context extends TrustedPrincipalContext>(
  source: Source,
  context: Context,
): Context => {
  if (hasSystemProvenance(source)) {
    return trustResolvedSystemPrincipalContext(context);
  }
  const redeemedGateway = readRedeemedGatewayProvenance(source);
  if (redeemedGateway !== undefined) {
    return trustVerifiedGatewayPrincipalContext(
      context,
      redeemedGateway.compositionRevision,
      redeemedGateway.scopeAssertion,
      redeemedGateway.actor,
      redeemedGateway.workload,
      redeemedGateway.routeScope,
      redeemedGateway.privacyDispatch,
      redeemedGateway.organizationGovernanceRead,
    );
  }
  const recoveryActionRegistration = readSupportRecoveryAction(source);
  if (recoveryActionRegistration !== null) {
    return trustSupportRecoveryPrincipalContext(context, recoveryActionRegistration);
  }
  return context;
};

export const decodeTrustedPrincipalContext = <Input>(
  input: Input,
): Effect.Effect<TrustedPrincipalContext, TrustedPrincipalContextDecodeError> => {
  if (Schema.is(SystemPrincipalContextSchema)(input) && !isTrustedSystemPrincipalContext(input)) {
    return Effect.fail(new TrustedPrincipalContextDecodeError({}));
  }
  if (
    Schema.is(TrustedPrincipalContextSchema)(input) &&
    input.trustedStorefrontId !== undefined &&
    !isVerifiedGatewayPrincipalContext(input)
  ) {
    return Effect.fail(new TrustedPrincipalContextDecodeError({}));
  }
  if (Schema.is(VerifiedGatewayPrincipalContextSchema)(input)) {
    return Effect.succeed(input);
  }
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(input).pipe(
    Effect.mapError((cause) => new TrustedPrincipalContextDecodeError({ cause })),
    Effect.map((context) => preserveSystemPrincipalContextTrust(input, context)),
  );
};
