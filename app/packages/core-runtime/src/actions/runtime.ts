import {
  loadModuleOperationAdmission,
  operationCatalogLoader,
  prepareOperationIntrinsicState,
  validateBoundOperationOwner,
  withModuleOperationExecution,
  withoutModuleOperationExecution,
} from '../modules/module-operation-execution.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import {
  Array as EffectArray,
  Cause,
  Context,
  Effect,
  Exit,
  Match,
  Predicate,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { ConnectionError, UnknownError, isSqlError } from 'effect/sql/SqlError';

import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayCompositionRevision,
} from '../auth/system-principal-context-provenance.ts';
import { isDatabaseCommitAcknowledgementAmbiguous } from '../database/driver-failure.ts';
import { findPostgresFailure } from '../database/postgres-failure.ts';
import { CoreDatabase as CoreDatabaseService } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { trustedTransactionTime } from '../operations/transaction-time.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import type { ActiveApplicationCompositionServiceContract } from '../modules/active-application-composition.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import type { OntosDeploymentIdentitySchema } from '../modules/manifest.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { TenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { ModuleStateGate } from '../modules/module-state-gate.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import { ContextAccess, isOwnerPermissionAccessTargetValid } from '../permissions/context-access.ts';
import { ActionAuthorizationPreflight } from '../permissions/action-authorization-preflight.ts';
import type { ActionAuthorizationPreflightService } from '../permissions/action-authorization-preflight.ts';
import {
  OwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
} from '../permissions/owner-authorization-overlay.ts';
import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationTarget,
} from '../permissions/owner-authorization-overlay.ts';
import type { ActionPermissionService } from '../permissions/service.ts';
import { ActionPermission } from '../permissions/service.ts';
import { createActionCollector } from './collector.ts';
import type { ActionTransportMetadata, CommittedActionDomainRejection, TrustedPrincipalContext } from './context.ts';
import {
  ActionTransportMetadataSchema,
  CommittedActionDomainRejectionSchema,
  commitActionThenReject,
  getCommittedActionDomainError,
} from './context.ts';
import type {
  ActionPostAttemptOutcome,
  ActionOwnerPermissionTarget,
  ActionDeniedAuditEvidenceDeclaration,
  ActionLegalEntityPermission,
  ActionRegistration,
  ActionResourcePermissionTarget,
  ActionTenantPermission,
} from './definition.ts';
import {
  decodeActionPostAttemptResult,
  getActionPostAttemptHook,
  decodeActionPayload,
  decodeActionResult,
  getActionDecodedSuccessHook,
  getActionOwnerPermissionTargetResolver,
  getActionHandler,
  getActionResourcePermissionTargetResolver,
  getActionServiceFactory,
} from './definition.ts';
import {
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationPersistenceError,
  createActionInvocationPersistenceErrorWithCause,
  ActionInvocationNotFound,
  ActionInvocationStateError,
  ActionPayloadValidationError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
} from './errors.ts';
import type { ActionCoreError } from './errors.ts';
import { createActionTransactionErrorWithCause } from './transaction-error.ts';
import type { DomainEventContractMap } from './events.ts';
import { ModuleStateCheckUnavailableError, ModuleStateDeniedError } from '../modules/module-state-gate-errors.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../operations/errors.ts';
import type { ActionPolicy, ActionPolicyEvaluatorInput } from './policy.ts';
import { PolicyDenied } from './policy.ts';
import type {
  ActionInvocationRecord,
  ActionInvocationScopeExecutor,
  ActionPolicyEvidence,
  ActionRecordedRejection,
  ActionRepositoryService,
} from './repository.ts';
import {
  ActionRepository,
  computeActionRequestHash,
  computeCanonicalValueHash,
  logActionInvocationPersistenceFailureCause,
  logActionTransactionFailureCause,
  recoverSqlTransactionError,
} from './repository.ts';

const requireIdempotencyKey = (idempotency: string, transport: ActionTransportMetadata) =>
  idempotency === 'required' && transport.idempotencyKey === undefined
    ? Effect.fail(
        new ActionIdempotencyKeyRequired({
          code: 'action_idempotency_key_required',
          reason: 'This Action requires an idempotency key',
        }),
      )
    : Effect.void;

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const attachFailureCause = <Failure extends object, FailureCause>(failure: Failure, cause: FailureCause): Failure => {
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
  });
  return failure;
};

// The descriptor's action-owned Schema is authoritative; this final object check only bounds the
// generic runtime seam before opaque audit JSON is persisted.
// oxlint-disable-next-line effect-native/no-json-schema-as-document-contract
const DeniedAuditEvidenceJsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

const resolveDeniedAuditEvidence = <Payload>(
  declaration: ActionDeniedAuditEvidenceDeclaration<Payload>,
  payload: Payload,
  scope: OperationalScope,
): Effect.Effect<Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>, ActionPayloadValidationError> => {
  const invalidEvidence = (reason: string, cause?: unknown) =>
    attachFailureCause(
      new ActionPayloadValidationError({
        code: 'action_payload_invalid',
        reason,
      }),
      cause,
    );
  return Effect.try({
    catch: (cause) => invalidEvidence('The Action denial evidence could not be resolved safely', cause),
    try: () => declaration.resolve(payload, scope),
  }).pipe(
    Effect.flatMap((resolved) =>
      Schema.decodeEffect(declaration.schema)(resolved).pipe(
        Effect.mapError((cause) =>
          invalidEvidence('The Action denial evidence does not match its declared schema', cause),
        ),
      ),
    ),
    Effect.flatMap((decoded) =>
      Schema.encodeUnknownEffect(Schema.make<Schema.ConstraintEncoder<unknown>>(declaration.schema.ast))(decoded).pipe(
        Effect.mapError((cause) => invalidEvidence('The Action denial evidence cannot be encoded safely', cause)),
      ),
    ),
    Effect.flatMap((encoded) =>
      // oxlint-disable-next-line effect-native/no-json-schema-as-document-contract
      Schema.decodeUnknownEffect(DeniedAuditEvidenceJsonObjectSchema)(encoded).pipe(
        Effect.mapError((cause) => invalidEvidence('The Action denial evidence must be a JSON object', cause)),
      ),
    ),
  );
};

export const ACTION_RUNTIME_STAGES = [
  'payload_decoded',
  'trusted_context_validated',
  'module_state_gate',
  'invocation_prepared',
  'authentication_boundary',
  'permission_checked',
  'policy_boundary',
  'invocation_running',
  'database_scope_installed',
  'composition_authority_locked',
  'invocation_locked',
  'module_state_rechecked',
  'handler_executed',
  'success_evidence_flushed',
] as const;

export type ActionRuntimeStage = (typeof ACTION_RUNTIME_STAGES)[number];

export interface RunActionInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string = string,
  Services = Readonly<Record<string, never>>,
  HandlerRequirements = never,
> {
  /** Trusted receiving deployment audience for per-operation admission. */
  readonly audience?: string;
  readonly payload: unknown;
  readonly principal: unknown;
  readonly registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  >;
  readonly transport: unknown;
}

export interface ResolveActionCommitInput {
  readonly invocationId: unknown;
  readonly principal: unknown;
}

const ActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId'));

const ActionCommitOpenSchema = Schema.TaggedStruct('ActionCommitOpen', {
  invocationId: ActionInvocationIdSchema,
});

export type ActionCommitOpen = typeof ActionCommitOpenSchema.Type;

export interface ActionRuntimeService {
  readonly resolveActionCommit: (
    input: ResolveActionCommitInput,
  ) => Effect.Effect<
    ActionCommitOpen,
    | ActionAlreadyCommitted
    | ActionCommitIndeterminate
    | ActionInvocationNotFound
    | ActionInvocationStateError
    | ActionPayloadValidationError
    | ActionTrustedContextValidationError
  >;
  readonly runAction: <
    PayloadSchema extends Schema.ConstraintDecoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{
      readonly _tag: string;
    }>,
    DomainEvents extends DomainEventContractMap,
    Owner extends string,
    Services,
    HandlerRequirements,
  >(
    input: RunActionInput<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      HandlerRequirements
    >,
  ) => Effect.Effect<ResultSchema['Type'], ActionCoreError | DomainErrorSchema['Type'], HandlerRequirements>;
}

export interface ActionRuntimeOptions {
  readonly applicationComposition?: ActiveApplicationCompositionServiceContract;
  readonly authorizationPreflight?: ActionAuthorizationPreflightService;
  readonly contextAccess?: (typeof ContextAccess)['Service'];
  readonly expectedDeployment?: typeof OntosDeploymentIdentitySchema.Type;
  readonly installScope?: typeof installOperationalScope;
  readonly lockCompositionAuthority?: typeof lockApplicationCompositionAuthority;
  readonly moduleEntrypointGateway: ModuleEntrypointGatewayService;
  readonly moduleStateGate: ModuleStateGateService;
  readonly onStage?: (stage: ActionRuntimeStage) => void;
  readonly ownerAuthorizationOverlay?: (typeof OwnerAuthorizationOverlay)['Service'];
  readonly ownerRegistration?: VerticalRuntimeRegistration;
  readonly resolveCompositionRevision?: (
    principal: TrustedPrincipalContext,
  ) => Effect.Effect<string, ActionTransactionError>;
  readonly resolveHandler?: typeof getActionHandler;
  readonly resolveServiceFactory?: typeof getActionServiceFactory;
}

const logInvocationPersistenceFailure = (
  failure: ActionInvocationPersistenceError,
  annotations: Readonly<Record<string, string>>,
): Effect.Effect<void> => logActionInvocationPersistenceFailureCause(failure, annotations);

const isCommitAcknowledgementFailure = (failure: SqlError): boolean =>
  isDatabaseCommitAcknowledgementAmbiguous(failure) ||
  (Option.isNone(findPostgresFailure(failure)) &&
    (Schema.is(ConnectionError)(failure.reason) || Schema.is(UnknownError)(failure.reason)));

const transactionFailure = () =>
  new ActionTransactionError({
    code: 'action_transaction_failed',
    reason: 'The Action transaction did not complete successfully',
  });

const ActionCoreErrorSchema = Schema.Union([
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPayloadValidationError,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
]);

const alreadyCommitted = (invocationId: string) =>
  new ActionAlreadyCommitted({
    code: 'action_already_committed',
    invocationId,
    reason: 'This idempotency key already committed successfully',
  });

const permissionDeniedFailure = () =>
  new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'The principal is not permitted to execute this Action',
  });

const requestHashConflict = () =>
  new ActionRequestHashConflict({
    code: 'action_request_hash_conflict',
    reason: 'This idempotency key was already used for a different Action request',
  });

const permissionUnavailable = () =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The authorization service could not determine permission safely',
  });

const ownerAuthorizationFailure = (decision: Exclude<OwnerAuthorizationDecision, 'allowed'>) => {
  if (decision === 'denied') {
    return Effect.fail(
      new ActionPermissionDenied({
        code: 'action_permission_denied',
        reason: 'The owner-local authorization state denies this Action',
      }),
    );
  }
  return Effect.fail(permissionUnavailable());
};

const resolveActionTenantPermission = <Payload>(
  payload: Payload,
  resolver: ((payload: Payload) => ActionTenantPermission | undefined) | undefined,
): Effect.Effect<Option.Option<ActionTenantPermission>, ActionPermissionCheckError> =>
  Effect.try({
    catch: (cause) =>
      attachFailureCause(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The declared tenant permission could not be resolved safely',
        }),
        cause,
      ),
    try: () => Option.fromNullishOr(resolver?.(payload)),
  });

const ActionResourcePermissionTargetSchema = Schema.Struct({
  permission: Schema.Literals(['read', 'write']),
  resource: Schema.Struct({
    moduleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
      Schema.brand('ActionTargetModuleId'),
    ),
    resourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
      Schema.brand('ActionTargetResourceId'),
    ),
    resourceType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
      Schema.brand('ActionTargetResourceType'),
    ),
  }),
});

const resolveActionResourcePermissionTarget = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => ActionResourcePermissionTarget) | undefined,
): Effect.Effect<Option.Option<ActionResourcePermissionTarget>, ActionPermissionCheckError> =>
  Effect.suspend(() => {
    if (resolver === undefined) {
      return Effect.succeed(Option.none<ActionResourcePermissionTarget>());
    }
    return Effect.try({
      catch: (cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared Action permission target could not be resolved safely',
          }),
          cause,
        ),
      try: () => resolver(payload, scope),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ActionResourcePermissionTargetSchema)),
      Effect.mapError((cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared Action permission target is invalid',
          }),
          cause,
        ),
      ),
      Effect.map((target) =>
        Option.some(
          Object.freeze({
            permission: target.permission,
            resource: Object.freeze({ ...target.resource }),
          }),
        ),
      ),
    );
  });

const resolveActionOwnerPermissionTargets = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => readonly ActionOwnerPermissionTarget[]) | undefined,
): Effect.Effect<readonly ActionOwnerPermissionTarget[], ActionPermissionCheckError> =>
  Effect.suspend(() => {
    if (resolver === undefined) {
      return Effect.succeed([]);
    }
    return Effect.try({
      catch: (cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared owner permission targets could not be resolved safely',
          }),
          cause,
        ),
      try: () => resolver(payload, scope),
    }).pipe(
      Effect.filterOrFail(
        (targets) =>
          EffectArray.isArray(targets) &&
          targets.length > 0 &&
          targets.length <= 8 &&
          targets.every((target) => isOwnerPermissionAccessTargetValid(target, scope)) &&
          new Set(targets.map((target) => target.key)).size === targets.length &&
          targets.every((target) => target.transportObjectId === targets[0]?.transportObjectId),
        () =>
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared owner permission targets do not match trusted scope',
          }),
      ),
    );
  });

const terminalInvocation = () =>
  new ActionInvocationStateError({
    code: 'action_invocation_state_invalid',
    reason: 'This Action invocation is terminal and cannot execute again',
  });

// A same-key retry of a rejected invocation reports the recorded rejection, so the outcome does
// not depend on whether the retry arrived before or after the first request committed it.
const recordedRejectionFailure = (rejection: Option.Option<ActionRecordedRejection>) => {
  if (Option.isNone(rejection)) {
    return terminalInvocation();
  }
  return rejection.value.stage === 'authz'
    ? permissionDeniedFailure()
    : new ActionPolicyDenied({
        code: 'action_policy_denied',
        policyReasonCode: rejection.value.policyReasonCode,
        reason: 'A required Action Policy rejected this invocation',
      });
};

const recordedRejectionPersistenceFailure = (cause: unknown) =>
  createActionInvocationPersistenceErrorWithCause(
    {
      code: 'action_invocation_persistence_failed',
      reason: 'Unable to load the recorded Action rejection',
    },
    cause,
  );

const verifyInvocation = (
  invocation: ActionInvocationRecord,
  requestHash: string,
  recordedRejection: Effect.Effect<Option.Option<ActionRecordedRejection>, ActionInvocationPersistenceError>,
): Effect.Effect<
  void,
  | ActionAlreadyCommitted
  | ActionCommitIndeterminate
  | ActionInvocationPersistenceError
  | ActionInvocationStateError
  | ActionPermissionDenied
  | ActionPolicyDenied
  | ActionRequestHashConflict
> => {
  if (invocation.requestHash !== requestHash) {
    return Effect.fail(requestHashConflict());
  }
  if (invocation.status === 'succeeded') {
    return Effect.fail(alreadyCommitted(invocation.actionInvocationId));
  }
  if (invocation.status === 'indeterminate') {
    return Effect.fail(
      new ActionCommitIndeterminate({
        code: 'action_commit_indeterminate',
        invocationId: invocation.actionInvocationId,
        reason: 'This invocation requires commit resolution before it can execute',
      }),
    );
  }
  if ((invocation.status === 'received' || invocation.status === 'running') && invocation.completedAt === null) {
    return Effect.void;
  }
  if (invocation.status === 'rejected') {
    return recordedRejection.pipe(Effect.flatMap((rejection) => Effect.fail(recordedRejectionFailure(rejection))));
  }
  return Effect.fail(terminalInvocation());
};

const StoppedCheckpointPayloadSchema = Schema.Struct({
  checkpoint: Schema.Literal('stopped'),
});

const validatePrincipal = <Input, Registration extends object = object, Payload = undefined>(
  input: Input,
  actionRegistration?: Registration,
  payload?: Payload,
): Effect.Effect<TrustedPrincipalContext, ActionTrustedContextValidationError> =>
  decodeTrustedPrincipalContext(input).pipe(
    Effect.filterOrFail(
      (principal) =>
        !isTrustedSupportRecoveryPrincipalContext(principal) ||
        (actionRegistration !== undefined &&
          isTrustedSupportRecoveryPrincipalContext(principal, actionRegistration) &&
          Schema.is(StoppedCheckpointPayloadSchema)(payload)),
      () =>
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The support recovery context does not authorize this Action',
        }),
    ),
    Effect.mapError((cause) =>
      attachFailureCause(
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The trusted principal context is incomplete or invalid',
        }),
        cause,
      ),
    ),
  );

const validateTransport = <Input>(input: Input): Effect.Effect<ActionTransportMetadata, ActionPayloadValidationError> =>
  Schema.decodeUnknownEffect(ActionTransportMetadataSchema)(input).pipe(
    Effect.mapError((cause) =>
      attachFailureCause(
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action transport metadata is structurally invalid',
        }),
        cause,
      ),
    ),
  );

const makeHandlerExecutionError = () =>
  new ActionHandlerExecutionError({
    code: 'action_handler_execution_failed',
    reason: 'The Action handler failed unexpectedly',
  });

const policyEvidence = <Payload, Owner extends string>(policy: ActionPolicy<Payload, Owner>): ActionPolicyEvidence =>
  policy.scope === 'global'
    ? { policyKey: policy.policyKey, scope: policy.scope }
    : {
        owningModuleKey: policy.owningModuleKey,
        policyKey: policy.policyKey,
        scope: policy.scope,
      };

const validateInvocationId = <Input>(
  input: Input,
): Effect.Effect<typeof ActionInvocationIdSchema.Type, ActionPayloadValidationError> =>
  Schema.decodeUnknownEffect(ActionInvocationIdSchema)(input).pipe(
    Effect.mapError((cause) =>
      attachFailureCause(
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action invocation identifier is invalid',
        }),
        cause,
      ),
    ),
  );

type ActionRuntimeConstruction = readonly [
  database: (typeof CoreDatabaseService)['Service'],
  repository: ActionRepositoryService,
  permission: ActionPermissionService,
  operationalScopeResolver: OperationalScopeResolverService,
  options: ActionRuntimeOptions,
];

const unavailableActionComposition = (cause?: unknown) =>
  createActionTransactionErrorWithCause(
    {
      code: 'action_transaction_failed',
      reason: 'The receiving owner release is not approved by the active Application Composition',
    },
    cause,
  );

/** Core-private resolver shared by the live runtime and its release-race regression tests. */
export const makeActionCompositionRevisionResolver = (
  applicationComposition: ActiveApplicationCompositionServiceContract,
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
) => {
  const receivingDeployment = Object.freeze({ ...expectedDeployment });
  return Effect.fn('ActionRuntime.resolveCompositionRevision')(function* resolveCompositionRevision(
    principal: TrustedPrincipalContext,
  ) {
    const snapshot = yield* applicationComposition.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.mapError(unavailableActionComposition),
    );
    const selectedOwner = snapshot.composition.modules.find(
      (module) =>
        module.deployment.appId === receivingDeployment.appId &&
        module.deployment.buildMarker === receivingDeployment.buildMarker,
    );
    const shellDeployment = snapshot.composition.shell.deployment;
    const isSelectedShell =
      receivingDeployment.appId === shellDeployment.appId &&
      receivingDeployment.buildMarker === shellDeployment.buildMarker;
    const gatewayRevision = readVerifiedGatewayCompositionRevision(principal);
    if (
      (selectedOwner === undefined && !isSelectedShell) ||
      (gatewayRevision !== undefined && gatewayRevision !== snapshot.composition.revision)
    ) {
      return yield* unavailableActionComposition();
    }
    return snapshot.composition.revision;
  });
};

/** Freeze only owned record/array data; native schema values retain their own semantics. */
const freezeActionPostAttemptValue = <Value>(value: Value): Value => {
  if (
    value !== null &&
    Predicate.isObjectKeyword(value) &&
    (Object.getPrototypeOf(value) === Array.prototype ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    for (const nested of Object.values(value)) {
      freezeActionPostAttemptValue(nested);
    }
    Object.freeze(value);
  }
  return value;
};

interface ActionAttemptOriginal<Payload> {
  readonly invocationId: string;
  readonly payload: Payload;
  readonly principal: TrustedPrincipalContext;
  readonly requestHash: string;
  readonly scope: OperationalScope;
}
interface ActionAttemptState<Payload, DomainError> {
  committedRejection: DomainError | undefined;
  disposition: 'unstarted' | 'uncommitted' | 'indeterminate' | 'committed';
  original: ActionAttemptOriginal<Payload> | undefined;
  revision: string | undefined;
}

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- Trusted scope and the four resolved optional permission targets are cohesive authorization data for this Action run.
const buildOwnerAuthorizationTargets = (
  scope: OperationalScope,
  tenantPermission: Option.Option<ActionTenantPermission>,
  legalEntityPermission: ActionLegalEntityPermission | undefined,
  ownerPermissionTargets: readonly ActionOwnerPermissionTarget[],
  resourcePermissionTarget: Option.Option<ActionResourcePermissionTarget>,
): readonly OwnerAuthorizationTarget[] => {
  const targets: OwnerAuthorizationTarget[] = [];
  if (Option.isSome(tenantPermission)) {
    targets.push({ kind: 'tenant', permission: tenantPermission.value, tenantId: scope.tenantId });
  }
  if (legalEntityPermission !== undefined && scope.legalEntityId !== undefined) {
    targets.push({
      kind: 'legal_entity',
      legalEntityId: scope.legalEntityId,
      permission: legalEntityPermission,
    });
  }

  for (const target of ownerPermissionTargets) {
    targets.push({
      kind: 'owner_permission',
      target,
    });
  }
  if (Option.isSome(resourcePermissionTarget)) {
    targets.push({
      kind: 'resource',
      permission: resourcePermissionTarget.value.permission,
      resource: resourcePermissionTarget.value.resource,
    });
  }
  return Object.freeze(targets);
};

export const makeActionRuntime = (...construction: ActionRuntimeConstruction): ActionRuntimeService => {
  const [database, repository, permission, operationalScopeResolver, options] = construction;
  const operationAuthority = options.expectedDeployment === undefined ? undefined : options.applicationComposition;
  const {
    authorizationPreflight,
    contextAccess,
    moduleEntrypointGateway,
    moduleStateGate,
    ownerAuthorizationOverlay = failClosedOwnerAuthorizationOverlay,
  } = options;
  const resolveHandler = options.resolveHandler ?? getActionHandler;
  const resolveServiceFactory = options.resolveServiceFactory ?? getActionServiceFactory;
  const installScope = options.installScope ?? installOperationalScope;
  const lockCompositionAuthority = options.lockCompositionAuthority ?? lockApplicationCompositionAuthority;
  /**
   * Invocation evidence is recorded only after the invocation's trusted database scope is
   * installed, so tenant-bound row-level security admits the request role's own tenant alone.
   */
  const invocationScopeExecutor = (scope: OperationalScope): ActionInvocationScopeExecutor => ({
    transaction: (body) =>
      database.executor.transaction((transaction) =>
        installScope(transaction, scope).pipe(Effect.andThen(() => body(transaction))),
      ),
  });
  const loadRecordedRejectionInScope = (scope: OperationalScope, invocationId: string) =>
    invocationScopeExecutor(scope)
      .transaction((transaction) => repository.loadRecordedRejection(transaction, invocationId))
      .pipe(
        recoverSqlTransactionError,
        Effect.catchTags({
          OperationContextUnavailable: (failure) => Effect.fail(recordedRejectionPersistenceFailure(failure)),
          SqlError: (failure) => Effect.fail(recordedRejectionPersistenceFailure(failure)),
        }),
      );
  const resolveCompositionRevision =
    (options.applicationComposition !== undefined && options.expectedDeployment !== undefined
      ? makeActionCompositionRevisionResolver(options.applicationComposition, options.expectedDeployment)
      : options.resolveCompositionRevision) ??
    (() =>
      Effect.fail(
        new ActionTransactionError({
          code: 'action_transaction_failed',
          reason: 'The Action has no approved Application Composition authority',
        }),
      ));
  const notifyStage = (stage: ActionRuntimeStage): void => {
    options.onStage?.(stage);
  };

  const checkTenantActionPermission = (
    principal: TrustedPrincipalContext,
    tenantPermission: Option.Option<ActionTenantPermission>,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (Option.isNone(tenantPermission)) {
      return Effect.succeed('allowed');
    }
    if (contextAccess === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    return contextAccess
      .tenants({
        permission: tenantPermission.value,
        principalId: principal.principalId,
        tenantIds: [principal.tenantId],
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision?.key === principal.tenantId && (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const checkActionLegalEntityPermission = (
    scope: OperationalScope,
    legalEntityPermission: ActionLegalEntityPermission | undefined,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (legalEntityPermission === undefined) {
      return Effect.succeed('allowed');
    }
    if (contextAccess === undefined || scope.legalEntityId === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    return contextAccess
      .legalEntities({
        legalEntityIds: [scope.legalEntityId],
        permission: legalEntityPermission,
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision !== undefined &&
          decision.key === scope.legalEntityId &&
          (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const checkActionResourcePermission = (
    scope: OperationalScope,
    resourceTarget: Option.Option<ActionResourcePermissionTarget>,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (Option.isNone(resourceTarget)) {
      return Effect.succeed('allowed');
    }
    if (contextAccess === undefined || scope.legalEntityId === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    const target = resourceTarget.value;
    return contextAccess
      .resources({
        legalEntityId: scope.legalEntityId,
        permission: target.permission,
        principalId: scope.principalId,
        resources: [target.resource],
        tenantId: scope.tenantId,
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision?.key ===
            `${target.resource.moduleId}:${target.resource.resourceType}:${target.resource.resourceId}` &&
          (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const checkActionOwnerPermissions = (
    scope: OperationalScope,
    ownerTargets: readonly ActionOwnerPermissionTarget[],
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (ownerTargets.length === 0) {
      return Effect.succeed('allowed');
    }
    if (
      contextAccess?.ownerPermissions === undefined ||
      ownerTargets.some((target) => !isOwnerPermissionAccessTargetValid(target, scope))
    ) {
      return Effect.fail(permissionUnavailable());
    }
    const { legalEntityId } = scope;
    const checkInputBase = {
      principal: { principalId: scope.principalId, tenantId: scope.tenantId },
      targets: ownerTargets.map((entry) => ({ target: entry })),
    };
    const checkInputWithStorefront =
      scope.trustedStorefrontId === undefined
        ? checkInputBase
        : { ...checkInputBase, trustedStorefrontId: scope.trustedStorefrontId };
    const checkInput =
      legalEntityId === undefined ? checkInputWithStorefront : { ...checkInputWithStorefront, legalEntityId };
    return contextAccess.ownerPermissions(checkInput).pipe(
      Effect.flatMap((decisions) => {
        if (
          decisions.length !== ownerTargets.length ||
          decisions.some(
            (decision, index) =>
              decision.key !== (ownerTargets[index] === undefined ? undefined : ownerTargets[index]?.key) ||
              decision.decision === 'unavailable',
          )
        ) {
          return Effect.fail(permissionUnavailable());
        }
        return decisions.some(({ decision }) => decision === 'denied')
          ? Effect.succeed('denied' as const)
          : Effect.succeed('allowed' as const);
      }),
    );
  };

  const runActionBoundary: ActionRuntimeService['runAction'] = Effect.fn('ActionRuntime.runAction')(
    function* runActionEffect<
      PayloadSchema extends Schema.ConstraintDecoder<unknown>,
      ResultSchema extends Schema.ConstraintDecoder<unknown>,
      DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
      DomainEvents extends DomainEventContractMap,
      Owner extends string,
      Services,
      HandlerRequirements,
    >(
      input: RunActionInput<
        PayloadSchema,
        ResultSchema,
        DomainErrorSchema,
        DomainEvents,
        Owner,
        Services,
        HandlerRequirements
      >,
    ) {
      const postAttemptHook = getActionPostAttemptHook(input.registration);
      const attempt: ActionAttemptState<PayloadSchema['Type'], DomainErrorSchema['Type']> = {
        committedRejection: undefined,
        disposition: 'unstarted',
        original: undefined,
        revision: undefined,
      };
      const executeAttempt = Effect.fn('ActionRuntime.executeAttempt')(function* executeAttemptEffect() {
        const prepareTrustedInputAndContext = Effect.fn('ActionRuntime.prepareTrustedInputAndContext')(
          function* prepareTrustedInputAndContextEffect() {
            const payload = yield* decodeActionPayload(input.registration.descriptor.payloadSchema, input.payload);
            notifyStage('payload_decoded');

            const principal = yield* validatePrincipal(input.principal, input.registration, payload);
            const transport = yield* validateTransport(input.transport);
            const scope = yield* operationalScopeResolver.resolve(
              withOptionalProperty(
                withOptionalProperty(
                  {
                    correlationId: transport.correlationId,
                    legalEntityScope: input.registration.descriptor.legalEntityScope,
                    principal,
                  },
                  transport.traceId !== undefined,
                  'traceId',
                  transport.traceId,
                  {},
                ),
                input.audience !== undefined,
                'audience',
                input.audience,
                {},
              ),
            );
            notifyStage('trusted_context_validated');
            const deniedAuditEvidenceDeclaration = input.registration.descriptor.deniedAuditEvidence;
            const deniedAuditEvidence =
              deniedAuditEvidenceDeclaration === undefined
                ? undefined
                : yield* resolveDeniedAuditEvidence(deniedAuditEvidenceDeclaration, payload, scope);
            return { deniedAuditEvidence, payload, principal, scope, transport };
          },
        );

        type ActionTransportTarget = Pick<
          ActionTransportMetadata,
          'targetModuleKey' | 'targetResourceId' | 'targetResourceType'
        >;

        const buildGovernedTransport = (
          transport: ActionTransportMetadata,
          target: ActionTransportTarget,
        ): ActionTransportMetadata =>
          withOptionalProperty(
            withOptionalProperty(
              { correlationId: transport.correlationId, ...target },
              transport.idempotencyKey !== undefined,
              'idempotencyKey',
              transport.idempotencyKey,
              {},
            ),
            transport.traceId !== undefined,
            'traceId',
            transport.traceId,
            {},
          );

        /* oxlint-disable anti-slop/no-known-value-widening -- The normalized governed-target result intentionally preserves the existing owner authorization contract across all branches. */
        const prepareGovernedTarget = (
          transport: ActionTransportMetadata,
          _scope: OperationalScope,
          ownerPermissionTargets: readonly ActionOwnerPermissionTarget[],
          resourcePermissionTarget: Option.Option<ActionResourcePermissionTarget>,
          hasCanonicalScopeTarget: boolean,
        ): Readonly<{
          actionTarget: Pick<ActionTransportMetadata, 'targetModuleKey' | 'targetResourceId' | 'targetResourceType'>;
          governedTransport: ActionTransportMetadata;
        }> => {
          if (ownerPermissionTargets.length > 0) {
            const [singleTarget] = ownerPermissionTargets;
            const actionTarget = {
              targetModuleKey: singleTarget?.transportModuleKey ?? input.registration.descriptor.owningModuleKey,
              targetResourceId: singleTarget?.transportObjectId ?? 'owner-permission-unavailable',
              targetResourceType:
                singleTarget?.transportResourceType ??
                singleTarget?.contract.targetResourceType ??
                'owner-permission-unavailable',
            };
            return { actionTarget, governedTransport: buildGovernedTransport(transport, actionTarget) };
          }
          if (Option.isSome(resourcePermissionTarget)) {
            const target = resourcePermissionTarget.value;
            const actionTarget = {
              targetModuleKey: target.resource.moduleId,
              targetResourceId: target.resource.resourceId,
              targetResourceType: target.resource.resourceType,
            };
            return { actionTarget, governedTransport: buildGovernedTransport(transport, actionTarget) };
          }
          if (hasCanonicalScopeTarget) {
            const actionTarget = {};
            return { actionTarget, governedTransport: buildGovernedTransport(transport, actionTarget) };
          }
          const actionTarget = withOptionalProperty(
            withOptionalProperty(
              withOptionalProperty(
                {},
                transport.targetModuleKey !== undefined,
                'targetModuleKey',
                transport.targetModuleKey,
                {},
              ),
              transport.targetResourceId !== undefined,
              'targetResourceId',
              transport.targetResourceId,
              {},
            ),
            transport.targetResourceType !== undefined,
            'targetResourceType',
            transport.targetResourceType,
            {},
          );
          return { actionTarget, governedTransport: transport };
        };
        /* oxlint-enable anti-slop/no-known-value-widening */

        const prepareAuthorizationContext = Effect.fn('ActionRuntime.prepareAuthorizationContext')(
          function* prepareAuthorizationContextEffect(
            payload: PayloadSchema['Type'],
            principal: TrustedPrincipalContext,
            scope: OperationalScope,
            transport: ActionTransportMetadata,
          ) {
            const { earlyCompositionRevision, intrinsicDependencies } = yield* prepareOperationIntrinsicState(
              input.registration,
              principal,
              options,
            ).pipe(Effect.mapError(unavailableActionComposition));
            const moduleStateSnapshot = yield* moduleEntrypointGateway.prepareSnapshot(
              scope,
              [input.registration.descriptor.entrypoint],
              intrinsicDependencies,
            );
            yield* moduleEntrypointGateway.check(moduleStateSnapshot, input.registration.descriptor.entrypoint);
            notifyStage('module_state_gate');

            yield* requireIdempotencyKey(input.registration.descriptor.idempotency, transport);

            const tenantPermission = isTrustedSupportRecoveryPrincipalContext(principal, input.registration)
              ? Option.none<ActionTenantPermission>()
              : yield* resolveActionTenantPermission(payload, input.registration.descriptor.tenantPermission);
            const { legalEntityPermission } = input.registration.descriptor;
            const [ownerPermissionTargets, resourcePermissionTarget] = yield* Effect.all(
              [
                resolveActionOwnerPermissionTargets(
                  payload,
                  scope,
                  getActionOwnerPermissionTargetResolver(input.registration),
                ),
                resolveActionResourcePermissionTarget(
                  payload,
                  scope,
                  getActionResourcePermissionTargetResolver(input.registration),
                ),
              ],
              { concurrency: 1 },
            );
            const hasCanonicalScopeTarget =
              Option.isSome(tenantPermission) ||
              legalEntityPermission !== undefined ||
              ownerPermissionTargets.length > 0;
            const frozenOwnerAuthorizationTargets = buildOwnerAuthorizationTargets(
              scope,
              tenantPermission,
              legalEntityPermission,
              ownerPermissionTargets,
              resourcePermissionTarget,
            );
            const { actionTarget, governedTransport } = prepareGovernedTarget(
              transport,
              scope,
              ownerPermissionTargets,
              resourcePermissionTarget,
              hasCanonicalScopeTarget,
            );
            return {
              actionTarget,
              earlyCompositionRevision,
              frozenOwnerAuthorizationTargets,
              governedTransport,
              intrinsicDependencies,
              legalEntityPermission,
              ownerPermissionTargets,
              resourcePermissionTarget,
              tenantPermission,
            };
          },
        );

        const prepareInvocation = Effect.fn('ActionRuntime.prepareInvocation')(function* prepareInvocationEffect(
          payload: PayloadSchema['Type'],
          principal: TrustedPrincipalContext,
          transport: ActionTransportMetadata,
          actionTarget: Pick<ActionTransportMetadata, 'targetModuleKey' | 'targetResourceId' | 'targetResourceType'>,
          governedTransport: ActionTransportMetadata,
          scope: OperationalScope,
        ) {
          const normalizedPayload = yield* Effect.try({
            catch: (cause) =>
              attachFailureCause(
                new ActionPayloadValidationError({
                  code: 'action_payload_invalid',
                  reason: 'The decoded Action payload cannot be encoded safely',
                }),
                cause,
              ),
            try: () =>
              Result.getOrThrow(
                Schema.encodeUnknownResult(
                  Schema.make<Schema.ConstraintEncoder<unknown>>(input.registration.descriptor.payloadSchema.ast),
                )(payload),
              ),
          });
          const requestHash = yield* Effect.try({
            catch: (cause) =>
              attachFailureCause(
                new ActionPayloadValidationError({
                  code: 'action_payload_invalid',
                  reason: 'The decoded Action payload cannot be normalized safely',
                }),
                cause,
              ),
            try: () =>
              computeActionRequestHash({
                actionKey: input.registration.descriptor.actionKey,
                normalizedPayload,
                owningModuleKey: input.registration.descriptor.owningModuleKey,
                principal,
                schemaVersion: input.registration.descriptor.schemaVersion,
                target: actionTarget,
              }),
          });
          const invocation = yield* repository
            .createOrResolveInvocation(invocationScopeExecutor(scope), {
              actionKey: input.registration.descriptor.actionKey,
              idempotencyKey: transport.idempotencyKey,
              principal,
              requestHash,
              transport: governedTransport,
            })
            .pipe(
              Effect.tapError((error) =>
                logInvocationPersistenceFailure(error, {
                  actionKey: input.registration.descriptor.actionKey,
                  correlationId: transport.correlationId,
                }),
              ),
            );
          notifyStage('invocation_prepared');
          if (postAttemptHook !== undefined && invocation.requestHash === requestHash) {
            const ownedPayload = freezeActionPostAttemptValue(
              yield* decodeActionPayload(input.registration.descriptor.payloadSchema, normalizedPayload),
            );
            attempt.original = Object.freeze({
              invocationId: invocation.actionInvocationId,
              payload: ownedPayload,
              principal,
              requestHash,
              scope,
            });
          }
          yield* verifyInvocation(
            invocation,
            requestHash,
            loadRecordedRejectionInScope(scope, invocation.actionInvocationId),
          );
          return { invocation, requestHash };
        });

        const prepareInputAndContext = Effect.fn('ActionRuntime.prepareInputAndContext')(
          function* prepareInputAndContextEffect() {
            const { deniedAuditEvidence, payload, principal, scope, transport } =
              yield* prepareTrustedInputAndContext();
            const authorizationContext = yield* prepareAuthorizationContext(payload, principal, scope, transport);
            const { invocation, requestHash } = yield* prepareInvocation(
              payload,
              principal,
              transport,
              authorizationContext.actionTarget,
              authorizationContext.governedTransport,
              scope,
            );

            return {
              ...authorizationContext,
              deniedAuditEvidence,
              invocation,
              payload,
              principal,
              requestHash,
              scope,
              transport,
            };
          },
        );
        const {
          actionTarget,
          deniedAuditEvidence,
          earlyCompositionRevision,
          frozenOwnerAuthorizationTargets,
          governedTransport,
          intrinsicDependencies,
          invocation,
          legalEntityPermission,
          ownerPermissionTargets,
          payload,
          principal,
          requestHash,
          resourcePermissionTarget,
          scope,
          tenantPermission,
          transport,
        } = yield* prepareInputAndContext();

        const logPermissionInvocationFailure = Effect.fn('ActionRuntime.logPermissionInvocationFailure')(
          function* logPermissionInvocationFailureEffect(failure: ActionInvocationPersistenceError) {
            yield* logInvocationPersistenceFailure(failure, {
              actionKey: input.registration.descriptor.actionKey,
              correlationId: transport.correlationId,
              invocationId: invocation.actionInvocationId,
            });
          },
        );
        const logPermissionTransactionFailure = Effect.fn('ActionRuntime.logPermissionTransactionFailure')(
          function* logPermissionTransactionFailureEffect(failure: ActionTransactionError) {
            yield* logActionTransactionFailureCause(failure, 'Unexpected permission denial persistence failure', {
              actionKey: input.registration.descriptor.actionKey,
              correlationId: transport.correlationId,
              invocationId: invocation.actionInvocationId,
            });
          },
        );
        const rejectPermission = () =>
          repository
            .rejectPermissionDenied(
              invocationScopeExecutor(scope),
              withOptionalProperty(
                {
                  actionInvocationId: invocation.actionInvocationId,
                  actionKey: input.registration.descriptor.actionKey,
                  auditProfile: input.registration.descriptor.auditProfile,
                  principal,
                  transport: governedTransport,
                },
                deniedAuditEvidence !== undefined,
                'deniedAuditEvidence',
                deniedAuditEvidence,
                {},
              ),
            )
            .pipe(
              Effect.tapErrorTag('ActionInvocationPersistenceError', logPermissionInvocationFailure),
              Effect.tapErrorTag('ActionTransactionError', logPermissionTransactionFailure),
              Effect.flatMap((earlierRejection) =>
                Effect.fail(
                  Option.isSome(earlierRejection)
                    ? recordedRejectionFailure(earlierRejection)
                    : permissionDeniedFailure(),
                ),
              ),
            );

        const prepareAuthorizationPreflight = Effect.fn('ActionRuntime.prepareAuthorizationPreflight')(
          function* prepareAuthorizationPreflightEffect() {
            const decision =
              authorizationPreflight === undefined
                ? ({ outcome: 'not_applicable' } as const)
                : yield* authorizationPreflight
                    .prepare({
                      actionInvocationId: invocation.actionInvocationId,
                      actionKey: input.registration.descriptor.actionKey,
                      correlationId: transport.correlationId,
                      payload,
                      principal,
                      scope,
                    })
                    .pipe(Effect.tapError((error) => Effect.logError(error.reason)));
            const permit = decision.outcome === 'allowed' ? decision.permit : undefined;
            if (
              permit !== undefined &&
              (permit.actionInvocationId !== invocation.actionInvocationId ||
                permit.actionKey !== input.registration.descriptor.actionKey ||
                permit.principalId !== principal.principalId)
            ) {
              return yield* permissionUnavailable();
            }
            return { denied: decision.outcome === 'denied', permit };
          },
        );

        const hasPermissionDenial = Effect.fn('ActionRuntime.hasPermissionDenial')(function* hasPermissionDenialEffect(
          preflightDenied: boolean,
        ) {
          const permissionDecision = yield* permission
            .checkActionPermission({
              actionKey: input.registration.descriptor.actionKey,
              correlationId: transport.correlationId,
              principalId: principal.principalId,
            })
            .pipe(Effect.tapError((error) => Effect.logError(error.reason)));
          const tenantPermissionDecision = yield* checkTenantActionPermission(principal, tenantPermission);
          const legalEntityPermissionDecision = yield* checkActionLegalEntityPermission(scope, legalEntityPermission);
          const resourcePermissionDecision = yield* checkActionResourcePermission(scope, resourcePermissionTarget);
          const ownerPermissionDecision = yield* checkActionOwnerPermissions(scope, ownerPermissionTargets);
          return (
            preflightDenied ||
            permissionDecision === 'denied' ||
            tenantPermissionDecision === 'denied' ||
            legalEntityPermissionDecision === 'denied' ||
            resourcePermissionDecision === 'denied' ||
            ownerPermissionDecision === 'denied'
          );
        });

        const authorizePermissions = Effect.fn('ActionRuntime.authorizePermissions')(
          function* authorizePermissionsEffect() {
            // The trusted context already represents authentication. Authorization
            // uses only the immutable Action key and trusted principal identity.
            notifyStage('authentication_boundary');
            const { denied: preflightDenied, permit: preflightPermit } = yield* prepareAuthorizationPreflight();
            const permissionDenied = yield* hasPermissionDenial(preflightDenied);
            notifyStage('permission_checked');
            if (permissionDenied) {
              return yield* rejectPermission();
            }
            const admission =
              options.applicationComposition !== undefined && options.expectedDeployment !== undefined
                ? yield* loadModuleOperationAdmission(
                    options.applicationComposition,
                    options.expectedDeployment,
                    input.registration,
                    principal,
                  ).pipe(Effect.mapError(unavailableActionComposition))
                : undefined;
            const revision =
              admission === undefined ? yield* resolveCompositionRevision(principal) : admission.revision;
            if (earlyCompositionRevision !== undefined && earlyCompositionRevision !== revision) {
              return yield* unavailableActionComposition();
            }
            if (admission?.catalog !== undefined) {
              const { catalog } = admission;
              yield* validateBoundOperationOwner(input.registration, catalog, options.ownerRegistration).pipe(
                Effect.mapError(unavailableActionComposition),
              );
            }
            attempt.revision = revision;
            if (preflightPermit !== undefined) {
              yield* withModuleOperationExecution(
                {
                  loadCatalog: operationCatalogLoader(operationAuthority, revision),
                  ownerRegistration: options.ownerRegistration,
                  phase: 'execution',
                  registration: input.registration,
                  revision,
                  scope,
                },
                preflightPermit.consume,
              );
            }
            return revision;
          },
        );

        const evaluatePolicies = Effect.fn('ActionRuntime.evaluatePolicies')(function* evaluatePoliciesEffect() {
          notifyStage('policy_boundary');

          const policyInput: ActionPolicyEvaluatorInput<typeof payload> = Object.freeze({
            action: Object.freeze({
              actionKey: input.registration.descriptor.actionKey,
              owningModuleKey: input.registration.descriptor.owningModuleKey,
              schemaVersion: input.registration.descriptor.schemaVersion,
            }),
            payload,
            principal: Object.freeze({ ...principal }),
            target: Object.freeze({ ...actionTarget }),
            transport: Object.freeze(
              withOptionalProperty(
                {
                  correlationId: transport.correlationId,
                },
                transport.traceId !== undefined,
                'traceId',
                transport.traceId,
                {},
              ),
            ),
          });
          const evaluateActionPolicy = Effect.fn('ActionRuntime.evaluatePolicy')(function* evaluatePolicy(
            policy: ActionPolicy<typeof payload, Owner>,
          ) {
            const policyExit = yield* Effect.exit(Effect.suspend(() => policy.evaluate(policyInput)));
            if (Exit.isSuccess(policyExit)) {
              return policyEvidence(policy);
            }

            const failureReasons = policyExit.cause.reasons.filter(Cause.isFailReason);
            const [failureReason] = failureReasons;
            if (
              failureReasons.length === policyExit.cause.reasons.length &&
              failureReason !== undefined &&
              Schema.is(PolicyDenied)(failureReason.error)
            ) {
              const denial = failureReason.error;
              const earlierRejection = yield* repository
                .finalizePolicyDenial(
                  invocationScopeExecutor(scope),
                  withOptionalProperty(
                    {
                      actionInvocationId: invocation.actionInvocationId,
                      actionKey: input.registration.descriptor.actionKey,
                      auditProfile: input.registration.descriptor.auditProfile,
                      policy: policyEvidence(policy),
                      principal,
                      reasonCode: denial.reasonCode,
                      transport: governedTransport,
                    },
                    deniedAuditEvidence !== undefined,
                    'deniedAuditEvidence',
                    deniedAuditEvidence,
                    {},
                  ),
                )
                .pipe(
                  Effect.tapError((error) =>
                    logInvocationPersistenceFailure(error, {
                      actionKey: input.registration.descriptor.actionKey,
                      correlationId: transport.correlationId,
                      invocationId: invocation.actionInvocationId,
                      policyKey: policy.policyKey,
                    }),
                  ),
                );
              if (
                Option.isSome(earlierRejection) &&
                !(
                  earlierRejection.value.stage === 'policy' &&
                  earlierRejection.value.policyReasonCode === denial.reasonCode
                )
              ) {
                return yield* recordedRejectionFailure(earlierRejection);
              }
              return yield* new ActionPolicyDenied({
                code: 'action_policy_denied',
                policyReasonCode: denial.reasonCode,
                reason: denial.reason,
              });
            }

            yield* Effect.logError('Unexpected Action Policy evaluation failure', policyExit.cause);
            return yield* new ActionPolicyEvaluationError({
              code: 'action_policy_evaluation_failed',
              reason: 'A required Action Policy could not be evaluated',
            });
          });
          const allowedPolicies = yield* Effect.forEach(input.registration.descriptor.policies, evaluateActionPolicy, {
            concurrency: 1,
          });
          return allowedPolicies;
        });

        const authorizeAndEvaluatePolicies = Effect.fn('ActionRuntime.authorizeAndEvaluatePolicies')(
          function* authorizeAndEvaluatePoliciesEffect() {
            const admittedCompositionRevision = yield* authorizePermissions();
            const allowedPolicies = yield* withModuleOperationExecution(
              {
                loadCatalog: operationCatalogLoader(operationAuthority, admittedCompositionRevision),
                ownerRegistration: options.ownerRegistration,
                phase: 'execution',
                registration: input.registration,
                revision: admittedCompositionRevision,
                scope,
              },
              evaluatePolicies(),
            );
            // Keep the public stage contract stable. The durable status transition happens inside the
            // owner-authorized transaction below, after the transaction-local fence has passed.
            notifyStage('invocation_running');
            return { admittedCompositionRevision, allowedPolicies };
          },
        );
        const { admittedCompositionRevision, allowedPolicies } = yield* authorizeAndEvaluatePolicies();

        const executeTransactionAndHandleExit = Effect.fn('ActionRuntime.executeTransactionAndHandleExit')(
          function* executeTransactionAndHandleExitEffect() {
            const transactionBodyCompleted = yield* Ref.make(false);
            const transactionBodyExit = yield* Ref.make<Exit.Exit<unknown, unknown> | null>(null);
            const transactionProgram: (
              drizzleTransaction: CoreTransaction,
            ) => Effect.Effect<
              ResultSchema['Type'] | CommittedActionDomainRejection<DomainErrorSchema['Type']>,
              ActionCoreError | DomainErrorSchema['Type'],
              HandlerRequirements
            > = Effect.fn('ActionRuntime.transaction')(function* executeTransaction(
              drizzleTransaction: CoreTransaction,
            ) {
              const scopedTransaction = yield* installScope(drizzleTransaction, scope);
              notifyStage('database_scope_installed');
              yield* lockCompositionAuthority(drizzleTransaction, admittedCompositionRevision, 'write').pipe(
                Effect.mapError((cause) =>
                  createActionTransactionErrorWithCause(
                    {
                      code: 'action_transaction_failed',
                      reason: 'The approved Application Composition no longer admits owner writes',
                    },
                    cause,
                  ),
                ),
              );
              notifyStage('composition_authority_locked');
              const lockedInvocation = yield* repository
                .lockInvocation(drizzleTransaction, invocation.actionInvocationId)
                .pipe(
                  Effect.tapError((error) =>
                    logInvocationPersistenceFailure(error, {
                      actionKey: input.registration.descriptor.actionKey,
                      correlationId: transport.correlationId,
                      invocationId: invocation.actionInvocationId,
                    }),
                  ),
                );
              notifyStage('invocation_locked');
              yield* verifyInvocation(
                lockedInvocation,
                requestHash,
                repository.loadRecordedRejection(drizzleTransaction, lockedInvocation.actionInvocationId),
              );

              const actionEntrypoint = input.registration.descriptor.entrypoint;
              if (actionEntrypoint.scope === 'tenant') {
                const tenantEntrypoint = Object.freeze({
                  ...actionEntrypoint,
                  scope: 'tenant' as const,
                }) satisfies TenantModuleEntrypoint<'action', 'write', Owner>;
                yield* moduleStateGate.recheckWrite(
                  drizzleTransaction,
                  scope.tenantId,
                  tenantEntrypoint,
                  intrinsicDependencies.get(actionEntrypoint.moduleKey),
                );
              }
              notifyStage('module_state_rechecked');
              const operationAt = yield* trustedTransactionTime(drizzleTransaction);
              const ownerAuthorizationDecision = yield* ownerAuthorizationOverlay.authorize(
                scopedTransaction,
                Object.freeze({
                  operation: 'action' as const,
                  operationAt,
                  operationKey: input.registration.descriptor.actionKey,
                  owningModuleKey: input.registration.descriptor.owningModuleKey,
                  scope,
                  targets: frozenOwnerAuthorizationTargets,
                }),
              );
              if (ownerAuthorizationDecision !== 'allowed') {
                return yield* ownerAuthorizationFailure(ownerAuthorizationDecision);
              }
              const runningInvocation = yield* repository
                .transitionInvocationToRunning(scopedTransaction, invocation.actionInvocationId)
                .pipe(
                  Effect.tapError((error) =>
                    logInvocationPersistenceFailure(error, {
                      actionKey: input.registration.descriptor.actionKey,
                      correlationId: transport.correlationId,
                      invocationId: invocation.actionInvocationId,
                    }),
                  ),
                );
              yield* verifyInvocation(
                runningInvocation,
                requestHash,
                repository.loadRecordedRejection(scopedTransaction, runningInvocation.actionInvocationId),
              );
              const serviceFactory = resolveServiceFactory(input.registration);
              const services = yield* serviceFactory(scopedTransaction, scope, admittedCompositionRevision);
              const handler = resolveHandler(input.registration);

              const collector = createActionCollector(
                input.registration.descriptor.domainEvents,
                input.registration.descriptor.owningModuleKey,
                input.registration.descriptor.accessEvidencePolicy,
                input.registration.descriptor.auditEvidenceSchema,
                admittedCompositionRevision,
              );
              const handlerContext = Object.freeze({
                actionInvocationId: lockedInvocation.actionInvocationId,
                addDomainEvent: collector.addDomainEvent,
                addOutboxMessage: collector.addOutboxMessage,
                compositionRevision: admittedCompositionRevision,
                recordAuditEvidence: collector.recordAuditEvidence,
                recordDataAccess: collector.recordDataAccess,
                scope,
                services,
              });

              const handlerExit = yield* Effect.exit(Effect.suspend(() => handler(payload, handlerContext)));

              if (Exit.isFailure(handlerExit)) {
                const failureReasons = handlerExit.cause.reasons.filter(Cause.isFailReason);
                const [failureReason] = failureReasons;
                if (failureReasons.length === handlerExit.cause.reasons.length && failureReason !== undefined) {
                  if (Schema.is(ActionCollectorError)(failureReason.error)) {
                    return yield* failureReason.error;
                  }
                  const decodedDomainError = yield* Effect.option(
                    Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failureReason.error),
                  );
                  if (Option.isSome(decodedDomainError)) {
                    return yield* Effect.fail(decodedDomainError.value);
                  }
                }
                yield* Effect.logError('Unexpected Action execution defect', handlerExit.cause);
                return yield* makeHandlerExecutionError();
              }
              notifyStage('handler_executed');

              const handlerValue = handlerExit.value;
              let transactionValue: ResultSchema['Type'] | CommittedActionDomainRejection<DomainErrorSchema['Type']>;
              let resultHash: string;
              if (Schema.is(CommittedActionDomainRejectionSchema)(handlerValue)) {
                const committedDomainError = yield* Schema.encodeUnknownEffect(
                  Schema.make<Schema.ConstraintEncoder<unknown>>(input.registration.descriptor.domainErrorSchema.ast),
                )(getCommittedActionDomainError(handlerValue)).pipe(
                  Effect.flatMap((encodedDomainError) =>
                    Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(
                      encodedDomainError,
                    ).pipe(Effect.map((domainError) => ({ domainError, encodedDomainError }))),
                  ),
                  Effect.tapError((cause) =>
                    Effect.logError('Invalid committed Action domain rejection returned by handler', cause),
                  ),
                  Effect.mapError((cause) => attachFailureCause(makeHandlerExecutionError(), cause)),
                );
                transactionValue = commitActionThenReject(committedDomainError.domainError);
                resultHash = yield* Effect.try({
                  catch: (cause) => attachFailureCause(makeHandlerExecutionError(), cause),
                  try: () => computeCanonicalValueHash(committedDomainError.encodedDomainError),
                });
              } else {
                const result = yield* decodeActionResult(input.registration.descriptor.resultSchema, handlerValue);
                transactionValue = result;
                resultHash = yield* Effect.try({
                  catch: (cause) =>
                    attachFailureCause(
                      new ActionResultValidationError({
                        code: 'action_result_invalid',
                        reason: 'The decoded Action result cannot be normalized safely',
                      }),
                      cause,
                    ),
                  try: () =>
                    computeCanonicalValueHash(
                      Result.getOrThrow(
                        Schema.encodeUnknownResult(
                          Schema.make<Schema.ConstraintEncoder<unknown>>(
                            input.registration.descriptor.resultSchema.ast,
                          ),
                        )(result),
                      ),
                    ),
                });
                const onDecodedSuccess = getActionDecodedSuccessHook(input.registration);
                if (onDecodedSuccess !== undefined) {
                  const hookExit = yield* Effect.exit(
                    Effect.suspend(() =>
                      onDecodedSuccess(
                        Object.freeze({
                          actionInvocationId: lockedInvocation.actionInvocationId,
                          result,
                          scope,
                          services,
                        }),
                      ),
                    ),
                  );
                  if (Exit.isFailure(hookExit)) {
                    const failureReasons = hookExit.cause.reasons.filter(Cause.isFailReason);
                    const [failureReason] = failureReasons;
                    if (failureReasons.length === hookExit.cause.reasons.length && failureReason !== undefined) {
                      const decodedDomainError = yield* Effect.option(
                        Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(
                          failureReason.error,
                        ),
                      );
                      if (Option.isSome(decodedDomainError)) {
                        return yield* Effect.fail(decodedDomainError.value);
                      }
                      if (Schema.is(ActionCoreErrorSchema)(failureReason.error)) {
                        return yield* Effect.failCause(Cause.fail(failureReason.error));
                      }
                    }
                    yield* Effect.logError('Unexpected Action decoded-success hook defect', hookExit.cause);
                    return yield* makeHandlerExecutionError();
                  }
                }
              }
              yield* repository
                .flushSuccess(drizzleTransaction, {
                  actionInvocationId: invocation.actionInvocationId,
                  actionKey: input.registration.descriptor.actionKey,
                  allowedPolicies,
                  auditProfile: input.registration.descriptor.auditProfile,
                  evidence: collector.snapshot(),
                  principal,
                  resultHash,
                  transport: governedTransport,
                })
                .pipe(
                  Effect.tapError((error) =>
                    logActionTransactionFailureCause(error, 'Unexpected Action success evidence persistence failure', {
                      actionKey: input.registration.descriptor.actionKey,
                      correlationId: transport.correlationId,
                      invocationId: invocation.actionInvocationId,
                    }),
                  ),
                );
              notifyStage('success_evidence_flushed');
              yield* Ref.set(transactionBodyCompleted, true);
              return transactionValue;
            });
            // The driver/body stay interruptible; classify the settled Cause before interruption resumes.
            const transactionOutcomeExit = yield* Effect.exit(
              Effect.uninterruptibleMask(
                Effect.fn('ActionRuntime.classifyTransactionOutcome')(function* classifyTransactionOutcome(
                  restore: <Value, Failure, Requirements>(
                    effect: Effect.Effect<Value, Failure, Requirements>,
                  ) => Effect.Effect<Value, Failure, Requirements>,
                ) {
                  const transactionExit = yield* Effect.exit(
                    restore(
                      database.executor.transaction((transaction) =>
                        withModuleOperationExecution(
                          {
                            loadCatalog: operationCatalogLoader(operationAuthority, admittedCompositionRevision),
                            ownerRegistration: options.ownerRegistration,
                            phase: 'execution',
                            registration: input.registration,
                            revision: admittedCompositionRevision,
                            scope,
                          },
                          transactionProgram(transaction),
                        ).pipe(Effect.onExit((exit) => Ref.set(transactionBodyExit, exit))),
                      ),
                    ),
                  );
                  if (Exit.isSuccess(transactionExit)) {
                    attempt.disposition = 'committed';
                    return transactionExit.value;
                  }

                  const bodyExit = yield* Ref.get(transactionBodyExit);
                  const bodyCompleted =
                    (yield* Ref.get(transactionBodyCompleted)) && bodyExit !== null && Exit.isSuccess(bodyExit);
                  const driverSqlFailure = transactionExit.cause.reasons.some((reason) =>
                    Cause.isFailReason(reason)
                      ? isSqlError(reason.error)
                      : Cause.isDieReason(reason) && isSqlError(reason.defect),
                  );
                  attempt.disposition =
                    bodyExit !== null && Exit.isFailure(bodyExit) && !driverSqlFailure
                      ? 'uncommitted'
                      : 'indeterminate';
                  if (
                    bodyExit !== null &&
                    Exit.isFailure(bodyExit) &&
                    transactionExit.cause.reasons.some(
                      (reason) => Cause.isDieReason(reason) && isSqlError(reason.defect),
                    )
                  ) {
                    yield* Effect.logError('Action body failed before transaction rollback failed', bodyExit.cause);
                  }
                  return yield* Effect.failCause(
                    Cause.fromReasons(
                      transactionExit.cause.reasons.map((reason) => {
                        if (Cause.isInterruptReason(reason)) {
                          return reason;
                        }
                        const failure = Cause.isFailReason(reason) ? reason.error : reason.defect;
                        if (!isSqlError(failure)) {
                          return reason;
                        }
                        return Cause.makeFailReason(
                          bodyCompleted && isCommitAcknowledgementFailure(failure)
                            ? new ActionCommitIndeterminate({
                                code: 'action_commit_indeterminate',
                                invocationId: invocation.actionInvocationId,
                                reason: 'The database did not confirm whether the Action commit completed',
                              })
                            : transactionFailure(),
                        );
                      }),
                    ),
                  );
                }),
              ),
            );
            if (Exit.isFailure(transactionOutcomeExit)) {
              const ownerDenied = transactionOutcomeExit.cause.reasons.some(
                (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionDenied)(reason.error),
              );
              if (ownerDenied) {
                return yield* rejectPermission();
              }
              return yield* Effect.failCause(transactionOutcomeExit.cause);
            }
            const transactionResult = transactionOutcomeExit.value;
            if (Schema.is(CommittedActionDomainRejectionSchema)(transactionResult)) {
              attempt.committedRejection = getCommittedActionDomainError<DomainErrorSchema['Type']>(transactionResult);
              return yield* Effect.fail(attempt.committedRejection);
            }
            return transactionResult;
          },
        );
        return yield* executeTransactionAndHandleExit();
      });
      const classifyAttemptOutcome = Effect.fn('ActionRuntime.classifyPostAttemptOutcome')(
        function* classifyPostAttemptOutcome(
          executionExit: Exit.Exit<
            Effect.Success<ReturnType<typeof executeAttempt>>,
            Effect.Error<ReturnType<typeof executeAttempt>>
          >,
        ) {
          let outcome: ActionPostAttemptOutcome<ResultSchema['Type'], DomainErrorSchema['Type']>;
          if (Exit.isSuccess(executionExit)) {
            const result = freezeActionPostAttemptValue(
              yield* decodeActionResult(input.registration.descriptor.resultSchema, executionExit.value),
            );
            outcome = Object.freeze({ _tag: 'Committed', result });
          } else if (attempt.committedRejection !== undefined) {
            outcome = Object.freeze({ _tag: 'CommittedRejection', rejection: attempt.committedRejection });
          } else if (executionExit.cause.reasons.some(Cause.isInterruptReason)) {
            outcome = Object.freeze({ _tag: 'Interrupted' });
          } else if (
            executionExit.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && Schema.is(ActionAlreadyCommitted)(reason.error),
            )
          ) {
            outcome = Object.freeze({ _tag: 'AlreadyCommitted' });
          } else if (
            attempt.disposition === 'indeterminate' ||
            attempt.disposition === 'committed' ||
            executionExit.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && Schema.is(ActionCommitIndeterminate)(reason.error),
            )
          ) {
            outcome = Object.freeze({ _tag: 'Indeterminate' });
          } else {
            const [failure] = executionExit.cause.reasons;
            const rejection =
              executionExit.cause.reasons.length === 1 && failure !== undefined && Cause.isFailReason(failure)
                ? yield* Effect.option(
                    Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failure.error),
                  )
                : Option.none();
            outcome = Option.isSome(rejection)
              ? Object.freeze({ _tag: 'DefinitelyUncommitted', rejection: rejection.value })
              : Object.freeze({ _tag: 'DefinitelyUncommitted' });
          }

          return outcome;
        },
      );
      const failSettlement = Effect.fn('ActionRuntime.failPostAttemptSettlement')(function* failPostAttemptSettlement(
        cause: Cause.Cause<ActionCoreError | DomainErrorSchema['Type']>,
      ) {
        if (cause.reasons.some(Cause.isInterruptReason)) {
          return yield* Effect.failCause(cause);
        }
        const [failure] = cause.reasons;
        if (cause.reasons.length === 1 && failure !== undefined && Cause.isFailReason(failure)) {
          const domainFailure = yield* Effect.option(
            Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failure.error),
          );
          if (Option.isSome(domainFailure)) {
            return yield* Effect.fail(domainFailure.value);
          }
          if (Schema.is(ActionCoreErrorSchema)(failure.error)) {
            return yield* failure.error;
          }
        }
        yield* Effect.logError('Unexpected Action post-attempt hook failure', cause);
        return yield* makeHandlerExecutionError();
      });
      const confirmOriginalRecovery = Effect.fn('ActionRuntime.confirmOriginalRecovery')(
        function* confirmOriginalRecovery(
          result: ResultSchema['Type'],
          original: ActionAttemptOriginal<PayloadSchema['Type']>,
          recoverable: boolean,
        ) {
          if (!recoverable) {
            return yield* makeHandlerExecutionError();
          }
          const resolved = yield* Effect.option(
            repository.resolveInvocation(invocationScopeExecutor(original.scope), {
              invocationId: original.invocationId,
              principal: original.principal,
            }),
          );
          if (
            Option.isNone(resolved) ||
            resolved.value.actionInvocationId !== original.invocationId ||
            resolved.value.requestHash !== original.requestHash ||
            resolved.value.status !== 'succeeded'
          ) {
            return yield* new ActionCommitIndeterminate({
              code: 'action_commit_indeterminate',
              invocationId: original.invocationId,
              reason: 'The original Action commit could not be confirmed',
            });
          }
          return result;
        },
      );
      if (postAttemptHook === undefined) {
        return yield* executeAttempt();
      }
      return yield* Effect.uninterruptibleMask(
        Effect.fn('ActionRuntime.settleActionAttempt')(function* settleActionAttempt(
          restore: <Value, Failure, Requirements>(
            effect: Effect.Effect<Value, Failure, Requirements>,
          ) => Effect.Effect<Value, Failure, Requirements>,
        ) {
          const executionExit = yield* Effect.exit(restore(executeAttempt()));
          const { original } = attempt;
          if (original === undefined) {
            return yield* executionExit;
          }
          const outcome = yield* classifyAttemptOutcome(executionExit);
          const mode = Match.value(outcome).pipe(
            Match.tags({
              AlreadyCommitted: () => ({ interrupted: false, phase: 'recovery' as const, recoverable: true }),
              Committed: () => ({ interrupted: false, phase: 'settlement' as const, recoverable: false }),
              CommittedRejection: () => ({ interrupted: false, phase: 'settlement' as const, recoverable: false }),
              DefinitelyUncommitted: () => ({ interrupted: false, phase: 'settlement' as const, recoverable: false }),
              Indeterminate: () => ({ interrupted: false, phase: 'recovery' as const, recoverable: true }),
              Interrupted: () => ({ interrupted: true, phase: 'settlement' as const, recoverable: false }),
            }),
            Match.exhaustive,
          );
          let { revision } = attempt;
          if (revision === undefined) {
            if (options.applicationComposition !== undefined && options.expectedDeployment !== undefined) {
              const admission = yield* loadModuleOperationAdmission(
                options.applicationComposition,
                options.expectedDeployment,
                input.registration,
                original.principal,
              ).pipe(Effect.mapError(unavailableActionComposition));
              if (admission.catalog !== undefined) {
                yield* validateBoundOperationOwner(
                  input.registration,
                  admission.catalog,
                  options.ownerRegistration,
                ).pipe(Effect.mapError(unavailableActionComposition));
              }
              ({ revision } = admission);
            } else {
              revision = yield* resolveCompositionRevision(original.principal);
            }
          }
          const settlementExit = yield* Effect.exit(
            withModuleOperationExecution(
              {
                loadCatalog: operationCatalogLoader(operationAuthority, revision),
                ownerRegistration: options.ownerRegistration,
                phase: mode.phase,
                registration: input.registration,
                revision,
                scope: original.scope,
              },
              Effect.suspend(() =>
                postAttemptHook(
                  Object.freeze({
                    actionInvocationId: original.invocationId,
                    compositionRevision: revision,
                    outcome,
                    payload: original.payload,
                    scope: original.scope,
                  }),
                ),
              ),
            ),
          );
          if (mode.interrupted) {
            return yield* executionExit;
          }
          if (Exit.isFailure(settlementExit)) {
            return yield* failSettlement(settlementExit.cause);
          }
          const settlement = yield* decodeActionPostAttemptResult(
            input.registration.descriptor.resultSchema,
            settlementExit.value,
          ).pipe(Effect.mapError((cause) => attachFailureCause(makeHandlerExecutionError(), cause)));
          return yield* Match.value(settlement).pipe(
            Match.tags({
              Recovered: ({ result }) => confirmOriginalRecovery(result, original, mode.recoverable),
              Settled: () => executionExit,
            }),
            Match.exhaustive,
          );
        }),
      );
    },
  );

  const runAction: ActionRuntimeService['runAction'] = (input) =>
    withoutModuleOperationExecution(runActionBoundary(input));

  const resolveActionCommit: ActionRuntimeService['resolveActionCommit'] = Effect.fn(
    'ActionRuntime.resolveActionCommit',
  )(function* resolveActionCommitEffect(input: ResolveActionCommitInput) {
    const principal = yield* validatePrincipal(input.principal);
    const invocationId = yield* validateInvocationId(input.invocationId);
    const invocation = yield* repository
      .resolveInvocation(
        invocationScopeExecutor(preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: '' })),
        {
          invocationId,
          principal,
        },
      )
      .pipe(
        Effect.tapError((error) =>
          Schema.is(ActionInvocationPersistenceError)(error)
            ? logInvocationPersistenceFailure(error, {
                invocationId,
                principalId: principal.principalId,
                tenantId: principal.tenantId,
              })
            : Effect.void,
        ),
        Effect.mapError((error) =>
          Schema.is(ActionInvocationPersistenceError)(error)
            ? new ActionCommitIndeterminate({
                code: 'action_commit_indeterminate',
                invocationId,
                reason: 'The database cannot confirm the Action commit state yet',
              })
            : error,
        ),
      );

    if (invocation.status === 'succeeded') {
      return yield* alreadyCommitted(invocation.actionInvocationId);
    }
    if (
      (invocation.status === 'received' || invocation.status === 'running' || invocation.status === 'indeterminate') &&
      invocation.completedAt === null
    ) {
      return Object.freeze({
        _tag: 'ActionCommitOpen',
        invocationId,
      }) satisfies ActionCommitOpen;
    }
    return yield* new ActionInvocationStateError({
      code: 'action_invocation_state_invalid',
      reason: 'This Action invocation has a terminal non-committed state',
    });
  });

  return Object.freeze({ resolveActionCommit, runAction });
};

export class ActionRuntime extends Context.Service<ActionRuntime, ActionRuntimeService>()(
  '@app/core-runtime/actions/runtime/ActionRuntime',
) {}

export const makeActionRuntimeLive = (
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
  ownerRegistration?: VerticalRuntimeRegistration,
) =>
  Layer.effect(
    ActionRuntime,
    Effect.gen(function* makeActionRuntimeService() {
      const applicationComposition = yield* ActiveApplicationCompositionService;
      const ownerAuthorizationOverlay = yield* Effect.serviceOption(OwnerAuthorizationOverlay);
      const authorizationPreflight = yield* Effect.serviceOption(ActionAuthorizationPreflight);
      const [database, repository, permission, moduleEntrypointGateway, moduleStateGate, scopeResolver, contextAccess] =
        yield* Effect.all(
          [
            CoreDatabaseService,
            ActionRepository,
            ActionPermission,
            ModuleEntrypointGateway,
            ModuleStateGate,
            OperationalScopeResolver,
            ContextAccess,
          ] as const,
          { concurrency: 7 },
        );
      let runtimeOptions: ActionRuntimeOptions = {
        applicationComposition,
        contextAccess,
        expectedDeployment,
        moduleEntrypointGateway,
        moduleStateGate,
        ownerAuthorizationOverlay: Option.isSome(ownerAuthorizationOverlay)
          ? ownerAuthorizationOverlay.value
          : failClosedOwnerAuthorizationOverlay,
        resolveCompositionRevision: makeActionCompositionRevisionResolver(applicationComposition, expectedDeployment),
      };
      if (ownerRegistration !== undefined) {
        runtimeOptions = { ...runtimeOptions, ownerRegistration };
      }
      if (Option.isSome(authorizationPreflight)) {
        runtimeOptions = { ...runtimeOptions, authorizationPreflight: authorizationPreflight.value };
      }
      return makeActionRuntime(database, repository, permission, scopeResolver, runtimeOptions);
    }),
  );

export const runAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
>(
  input: RunActionInput<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  >,
): Effect.Effect<
  ResultSchema['Type'],
  ActionCoreError | DomainErrorSchema['Type'],
  ActionRuntime | HandlerRequirements
> => ActionRuntime.pipe(Effect.flatMap((runtime) => runtime.runAction(input)));

export const resolveActionCommit = (
  input: ResolveActionCommitInput,
): Effect.Effect<
  ActionCommitOpen,
  | ActionAlreadyCommitted
  | ActionCommitIndeterminate
  | ActionInvocationNotFound
  | ActionInvocationStateError
  | ActionPayloadValidationError
  | ActionTrustedContextValidationError,
  ActionRuntime
> => ActionRuntime.pipe(Effect.flatMap((runtime) => runtime.resolveActionCommit(input)));
