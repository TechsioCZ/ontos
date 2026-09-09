import { Cause, Context, Effect, Exit, Layer, Option, Ref, Result, Schema } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { ConnectionError, UnknownError, isSqlError } from 'effect/unstable/sql/SqlError';

import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../auth/system-principal-context-provenance.ts';
import { isDatabaseCommitAcknowledgementAmbiguous } from '../database/driver-failure.ts';
import { findPostgresFailure } from '../database/postgres-failure.ts';
import { CoreDatabase as CoreDatabaseService } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { TenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { ModuleStateGate } from '../modules/module-state-gate.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import type { ActionPermissionService } from '../permissions/service.ts';
import { ActionPermission } from '../permissions/service.ts';
import { createActionCollector } from './collector.ts';
import type {
  ActionTransportMetadata,
  CommittedActionDomainRejection,
  TrustedPrincipalContext,
} from './context.ts';
import {
  ActionTransportMetadataSchema,
  CommittedActionDomainRejectionSchema,
  commitActionThenReject,
  getCommittedActionDomainError,
} from './context.ts';
import type {
  ActionBusinessPermissionTarget,
  ActionDeniedAuditEvidenceDeclaration,
  ActionLegalEntityPermission,
  ActionRegistration,
  ActionResourcePermissionTarget,
  ActionTenantPermission,
} from './definition.ts';
import {
  decodeActionPayload,
  decodeActionResult,
  getActionBusinessPermissionTargetResolver,
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

import { isDatabaseCommitAcknowledgementAmbiguous } from '../database/driver-failure.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { TenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { ModuleStateGate } from '../modules/module-state-gate.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import { ContextAccess, toBusinessPermissionAccessKey } from '../permissions/context-access.ts';
import { BusinessPermissionCodeSchema } from '../permissions/business-permission.ts';
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
import type { ActionCoreError, ActionInvocationNotFound } from './errors.ts';
import type { DomainEventContractMap } from './events.ts';
import type { ActionPolicy, ActionPolicyEvaluatorInput } from './policy.ts';
import { PolicyDenied } from './policy.ts';
import type { ActionInvocationRecord, ActionPolicyEvidence, ActionRepositoryService } from './repository.ts';
import {
  ActionRepository,
  computeActionRequestHash,
  computeCanonicalValueHash,
  logActionInvocationPersistenceFailureCause,
  logActionTransactionFailureCause,
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
): Effect.Effect<
  Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>,
  ActionPayloadValidationError
> => {
  const invalidEvidence = (reason: string, cause?: unknown) =>
    attachFailureCause(
      new ActionPayloadValidationError({
        code: 'action_payload_invalid',
        reason,
      }),
      cause,
    );
  return Effect.try({
    catch: (cause) =>
      invalidEvidence('The Action denial evidence could not be resolved safely', cause),
    try: () => declaration.resolve(payload, scope),
  }).pipe(
    Effect.flatMap((resolved) =>
      Schema.decodeUnknownEffect(declaration.schema)(resolved).pipe(
        Effect.mapError((cause) =>
          invalidEvidence('The Action denial evidence does not match its declared schema', cause),
        ),
      ),
    ),
    Effect.flatMap((decoded) =>
      Schema.encodeUnknownEffect(
        Schema.make<Schema.ConstraintEncoder<unknown>>(declaration.schema.ast),
      )(decoded).pipe(
        Effect.mapError((cause) =>
          invalidEvidence('The Action denial evidence cannot be encoded safely', cause),
        ),
      ),
    ),
    Effect.flatMap((encoded) =>
      // oxlint-disable-next-line effect-native/no-json-schema-as-document-contract
      Schema.decodeUnknownEffect(DeniedAuditEvidenceJsonObjectSchema)(encoded).pipe(
        Effect.mapError((cause) =>
          invalidEvidence('The Action denial evidence must be a JSON object', cause),
        ),
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
  'invocation_locked',
  'database_scope_installed',
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
  readonly authorizationPreflight?: ActionAuthorizationPreflightService;
  readonly contextAccess?: (typeof ContextAccess)['Service'];
  readonly installScope?: typeof installOperationalScope;
  readonly moduleEntrypointGateway: ModuleEntrypointGatewayService;
  readonly moduleStateGate: ModuleStateGateService;
  readonly onStage?: (stage: ActionRuntimeStage) => void;
  readonly ownerAuthorizationOverlay?: (typeof OwnerAuthorizationOverlay)['Service'];
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

const alreadyCommitted = (invocationId: string) =>
  new ActionAlreadyCommitted({
    code: 'action_already_committed',
    invocationId,
    reason: 'This idempotency key already committed successfully',
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

const BusinessTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('BusinessTenantId'),
  Schema.decodeTo(Schema.String),
);
const BusinessLegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('BusinessLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const BusinessProfileIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('BusinessProfileId'), Schema.decodeTo(Schema.String));
const BusinessCounterpartyIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('BusinessCounterpartyId'), Schema.decodeTo(Schema.String));
const BusinessStorefrontIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('BusinessStorefrontId'), Schema.decodeTo(Schema.String));

const BusinessAccessTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('retail_profile'),
    legalEntityId: BusinessLegalEntityIdSchema,
    profileId: BusinessProfileIdSchema,
    tenantId: BusinessTenantIdSchema,
  }),
  Schema.Struct({
    counterpartyId: BusinessCounterpartyIdSchema,
    kind: Schema.Literal('counterparty'),
    legalEntityId: BusinessLegalEntityIdSchema,
    tenantId: BusinessTenantIdSchema,
  }),
  Schema.Struct({
    counterpartyId: BusinessCounterpartyIdSchema,
    kind: Schema.Literal('counterparty_storefront'),
    legalEntityId: BusinessLegalEntityIdSchema,
    storefrontId: BusinessStorefrontIdSchema,
    tenantId: BusinessTenantIdSchema,
  }),
]);
const ActionBusinessPermissionTargetSchema = Schema.Struct({
  permission: BusinessPermissionCodeSchema,
  target: BusinessAccessTargetSchema,
  trustedStorefrontId: Schema.optionalKey(BusinessStorefrontIdSchema),
});

const businessTargetResourceId = (target: ActionBusinessPermissionTarget['target']): string => {
  if (target.kind === 'retail_profile') {
    return target.profileId;
  }
  return target.kind === 'counterparty'
    ? target.counterpartyId
    : `${target.counterpartyId}:${target.storefrontId}`;
};

const resolveActionBusinessPermissionTarget = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver:
    | ((payload: Payload, scope: OperationalScope) => ActionBusinessPermissionTarget)
    | undefined,
): Effect.Effect<Option.Option<ActionBusinessPermissionTarget>, ActionPermissionCheckError> =>
  Effect.suspend(() => {
    if (resolver === undefined) {
      return Effect.succeed(Option.none<ActionBusinessPermissionTarget>());
    }
    return Effect.try({
      catch: (cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared business permission target could not be resolved safely',
          }),
          cause,
        ),
      try: () => resolver(payload, scope),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ActionBusinessPermissionTargetSchema)),
      Effect.filterOrFail(
        (resolved) =>
          resolved.target.tenantId === scope.tenantId &&
          resolved.target.legalEntityId === scope.legalEntityId &&
          (resolved.target.kind === 'counterparty_storefront'
            ? scope.trustedStorefrontId === resolved.target.storefrontId &&
              resolved.trustedStorefrontId === scope.trustedStorefrontId
            : resolved.trustedStorefrontId === undefined),
        () =>
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared business permission target does not match trusted scope',
          }),
      ),
      Effect.mapError((cause) =>
        Schema.is(ActionPermissionCheckError)(cause)
          ? cause
          : attachFailureCause(
              new ActionPermissionCheckError({
                code: 'action_permission_check_failed',
                reason: 'The declared business permission target is invalid',
              }),
              cause,
            ),
      ),
      Effect.map((target) => Option.some(target)),
    );
  });

const verifyInvocation = (
  invocation: ActionInvocationRecord,
  requestHash: string,
): Effect.Effect<
  void,
  ActionAlreadyCommitted | ActionCommitIndeterminate | ActionInvocationStateError | ActionRequestHashConflict
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
  return Effect.fail(
    new ActionInvocationStateError({
      code: 'action_invocation_state_invalid',
      reason: 'This Action invocation is terminal and cannot execute again',
    }),
  );
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

export const makeActionRuntime = (...construction: ActionRuntimeConstruction): ActionRuntimeService => {
  const [database, repository, permission, operationalScopeResolver, options] = construction;
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

  const checkActionBusinessPermission = (
    scope: OperationalScope,
    businessTarget: Option.Option<ActionBusinessPermissionTarget>,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (Option.isNone(businessTarget)) {
      return Effect.succeed('allowed');
    }
    if (contextAccess?.businessPermissions === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    const resolved = businessTarget.value;
    const checkInput = withOptionalProperty(
      {
        principal: { principalId: scope.principalId, tenantId: scope.tenantId },
        targets: [{ permission: resolved.permission, target: resolved.target }],
      },
      scope.trustedStorefrontId !== undefined,
      'trustedStorefrontId',
      scope.trustedStorefrontId,
      {},
    );
    return contextAccess
      .businessPermissions(checkInput)
      .pipe(
        Effect.flatMap(([decision]) =>
          decision?.key === toBusinessPermissionAccessKey(resolved) &&
          (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const runAction: ActionRuntimeService['runAction'] = Effect.fn('ActionRuntime.runAction')(
    function* runActionEffect<
      PayloadSchema extends Schema.ConstraintDecoder<unknown>,
      ResultSchema extends Schema.ConstraintDecoder<unknown>,
      DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
      DomainEvents extends DomainEventContractMap,
      Owner extends string,
      Services,
      HandlerRequirements
    >,
  ) {
    const payload = yield* decodeActionPayload(input.registration.descriptor.payloadSchema, input.payload);
    notifyStage('payload_decoded');

    const principal = yield* validatePrincipal(input.principal, input.registration, payload);
    const transport = yield* validateTransport(input.transport);
    const scope = yield* operationalScopeResolver.resolve(
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
    );
    notifyStage('trusted_context_validated');

    const moduleStateSnapshot = yield* moduleEntrypointGateway.prepareSnapshot(scope, [
      input.registration.descriptor.entrypoint,
    ]);
    yield* moduleEntrypointGateway.check(moduleStateSnapshot, input.registration.descriptor.entrypoint);
    notifyStage('module_state_gate');

    yield* requireIdempotencyKey(input.registration.descriptor.idempotency, transport);

    const tenantPermission = isTrustedSupportRecoveryPrincipalContext(principal, input.registration)
      ? Option.none<ActionTenantPermission>()
      : yield* resolveActionTenantPermission(payload, input.registration.descriptor.tenantPermission);
    const { legalEntityPermission } = input.registration.descriptor;
    const hasCanonicalScopeTarget = Option.isSome(tenantPermission) || legalEntityPermission !== undefined;

    const resourcePermissionTarget = yield* resolveActionResourcePermissionTarget(
      payload,
      scope,
      getActionResourcePermissionTargetResolver(input.registration),
    );
    let actionTarget: Pick<ActionTransportMetadata, 'targetModuleKey' | 'targetResourceId' | 'targetResourceType'>;
    let governedTransport: ActionTransportMetadata;
    if (Option.isSome(resourcePermissionTarget)) {
      const target = resourcePermissionTarget.value;
      actionTarget = {
        targetModuleKey: target.resource.moduleId,
        targetResourceId: target.resource.resourceId,
        targetResourceType: target.resource.resourceType,
      };
      governedTransport = withOptionalProperty(
        withOptionalProperty(
          {
            correlationId: transport.correlationId,
            targetModuleKey: target.resource.moduleId,
            targetResourceId: target.resource.resourceId,
            targetResourceType: target.resource.resourceType,
          },
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
      notifyStage('trusted_context_validated');
      const deniedAuditEvidenceDeclaration = input.registration.descriptor.deniedAuditEvidence;
      const deniedAuditEvidence =
        deniedAuditEvidenceDeclaration === undefined
          ? undefined
          : yield* resolveDeniedAuditEvidence(deniedAuditEvidenceDeclaration, payload, scope);

      const moduleStateSnapshot = yield* moduleEntrypointGateway.prepareSnapshot(scope, [
        input.registration.descriptor.entrypoint,
      ]);
      yield* moduleEntrypointGateway.check(
        moduleStateSnapshot,
        input.registration.descriptor.entrypoint,
      );
      notifyStage('module_state_gate');

      yield* requireIdempotencyKey(input.registration.descriptor.idempotency, transport);

      const tenantPermission = isTrustedSupportRecoveryPrincipalContext(
        principal,
        input.registration,
      )
        ? Option.none<ActionTenantPermission>()
        : yield* resolveActionTenantPermission(
            payload,
            input.registration.descriptor.tenantPermission,
          );
      const { legalEntityPermission } = input.registration.descriptor;
      const businessPermissionTarget = yield* resolveActionBusinessPermissionTarget(
        payload,
        scope,
        getActionBusinessPermissionTargetResolver(input.registration),
      );
      const hasCanonicalScopeTarget =
        Option.isSome(tenantPermission) ||
        legalEntityPermission !== undefined ||
        Option.isSome(businessPermissionTarget);

      const resourcePermissionTarget = yield* resolveActionResourcePermissionTarget(
        payload,
        scope,
        getActionResourcePermissionTargetResolver(input.registration),
      );
      const ownerAuthorizationTargets: OwnerAuthorizationTarget[] = [];
      if (Option.isSome(tenantPermission)) {
        ownerAuthorizationTargets.push({
          kind: 'tenant',
          permission: tenantPermission.value,
          tenantId: scope.tenantId,
        });
      }
      if (legalEntityPermission !== undefined && scope.legalEntityId !== undefined) {
        ownerAuthorizationTargets.push({
          kind: 'legal_entity',
          legalEntityId: scope.legalEntityId,
          permission: legalEntityPermission,
        });
      }
      if (Option.isSome(businessPermissionTarget)) {
        const businessTarget = businessPermissionTarget.value;
        ownerAuthorizationTargets.push(
          withOptionalProperty(
            {
              kind: 'business_permission' as const,
              permission: businessTarget.permission,
              target: businessTarget.target,
            },
            businessTarget.trustedStorefrontId !== undefined,
            'trustedStorefrontId',
            businessTarget.trustedStorefrontId,
            {},
          ),
        );
      }
      if (Option.isSome(resourcePermissionTarget)) {
        ownerAuthorizationTargets.push({
          kind: 'resource',
          permission: resourcePermissionTarget.value.permission,
          resource: resourcePermissionTarget.value.resource,
        });
      }
      const frozenOwnerAuthorizationTargets: readonly OwnerAuthorizationTarget[] =
        Object.freeze(ownerAuthorizationTargets);
      let actionTarget: Pick<
        ActionTransportMetadata,
        'targetModuleKey' | 'targetResourceId' | 'targetResourceType'
      >;
      let governedTransport: ActionTransportMetadata;
      if (Option.isSome(businessPermissionTarget)) {
        const { permission: targetPermission, target } = businessPermissionTarget.value;
        const targetResourceId = businessTargetResourceId(target);
        actionTarget = {
          targetModuleKey: input.registration.descriptor.owningModuleKey,
          targetResourceId,
          targetResourceType: `${target.kind}:${targetPermission}`,
        };
        governedTransport = withOptionalProperty(
          withOptionalProperty(
            {
              correlationId: transport.correlationId,
              targetModuleKey: input.registration.descriptor.owningModuleKey,
              targetResourceId,
              targetResourceType: `${target.kind}:${targetPermission}`,
            },
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
      } else if (Option.isSome(resourcePermissionTarget)) {
        const target = resourcePermissionTarget.value;
        actionTarget = {
          targetModuleKey: target.resource.moduleId,
          targetResourceId: target.resource.resourceId,
          targetResourceType: target.resource.resourceType,
        };
        governedTransport = withOptionalProperty(
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
      governedTransport = transport;
    }

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
      .createOrResolveInvocation(database.executor, {
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
    yield* verifyInvocation(invocation, requestHash);

    // The trusted context already represents authentication. Authorization
    // uses only the immutable Action key and trusted principal identity.
    notifyStage('authentication_boundary');
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
        .rejectPermissionDenied(database.executor, {
          actionInvocationId: invocation.actionInvocationId,
          actionKey: input.registration.descriptor.actionKey,
          auditProfile: input.registration.descriptor.auditProfile,
          principal,
          transport: governedTransport,
        })
        .pipe(
          Effect.tapErrorTag('ActionInvocationPersistenceError', logPermissionInvocationFailure),
          Effect.tapErrorTag('ActionTransactionError', logPermissionTransactionFailure),
          Effect.flatMap(() =>
            Effect.fail(
              new ActionPermissionDenied({
                code: 'action_permission_denied',
                reason: 'The principal is not permitted to execute this Action',
              }),
            ),
          ),
        );
      });
      const rejectPermission = () =>
        repository
          .rejectPermissionDenied(
            database.executor,
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
            Effect.tapError((error) =>
              logInvocationPersistenceFailure(error, {
                actionKey: input.registration.descriptor.actionKey,
                correlationId: transport.correlationId,
                invocationId: invocation.actionInvocationId,
                policyKey: policy.policyKey,
              }),
            ),
          );
      const preflightDecision =
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
      const preflightPermit =
        preflightDecision.outcome === 'allowed' ? preflightDecision.permit : undefined;
      const preflightDenied = preflightDecision.outcome === 'denied';
      if (
        preflightPermit !== undefined &&
        (preflightPermit.actionInvocationId !== invocation.actionInvocationId ||
          preflightPermit.actionKey !== input.registration.descriptor.actionKey ||
          preflightPermit.principalId !== principal.principalId)
      ) {
        return yield* permissionUnavailable();
      }
      const permissionDecision = yield* permission
        .checkActionPermission({
          actionKey: input.registration.descriptor.actionKey,
          correlationId: transport.correlationId,
          principalId: principal.principalId,
        })
        .pipe(Effect.tapError((error) => Effect.logError(error.reason)));
      const tenantPermissionDecision = yield* checkTenantActionPermission(
        principal,
        tenantPermission,
      );

      const legalEntityPermissionDecision = yield* checkActionLegalEntityPermission(
        scope,
        legalEntityPermission,
      );

      const resourcePermissionDecision = yield* checkActionResourcePermission(
        scope,
        resourcePermissionTarget,
      );
      const businessPermissionDecision = yield* checkActionBusinessPermission(
        scope,
        businessPermissionTarget,
      );
      notifyStage('permission_checked');
      if (
        preflightDenied ||
        (permissionDecision === 'denied' && preflightPermit === undefined) ||
        tenantPermissionDecision === 'denied' ||
        legalEntityPermissionDecision === 'denied' ||
        resourcePermissionDecision === 'denied' ||
        businessPermissionDecision === 'denied'
      ) {
        return yield* rejectPermission();
      }
      if (preflightPermit !== undefined) {
        yield* preflightPermit.consume;
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

          const failureReasons = policyExit.cause.reasons.filter(Cause.isFailReason);
          const [failureReason] = failureReasons;
          if (
            failureReasons.length === policyExit.cause.reasons.length &&
            failureReason !== undefined &&
            Schema.is(PolicyDenied)(failureReason.error)
          ) {
            const denial = failureReason.error;
            yield* repository
              .finalizePolicyDenial(
                database.executor,
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
        },
      );
      const allowedPolicies = yield* Effect.forEach(
        input.registration.descriptor.policies,
        evaluateActionPolicy,
        { concurrency: 1 },
      );
      // Keep the public stage contract stable. The durable status transition happens inside the
      // owner-authorized transaction below, after the transaction-local fence has passed.
      notifyStage('invocation_running');

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
        yield* verifyInvocation(lockedInvocation, requestHash);

        const scopedTransaction = yield* installScope(drizzleTransaction, scope);
        notifyStage('database_scope_installed');

        const actionEntrypoint = input.registration.descriptor.entrypoint;
        if (actionEntrypoint.scope === 'tenant') {
          const tenantEntrypoint = Object.freeze({
            ...actionEntrypoint,
            scope: 'tenant' as const,
          }) satisfies TenantModuleEntrypoint<'action', 'write', Owner>;
          yield* moduleStateGate.recheckWrite(drizzleTransaction, scope.tenantId, tenantEntrypoint);
        }
        notifyStage('module_state_rechecked');
        const ownerAuthorizationDecision = yield* ownerAuthorizationOverlay.authorize(
          scopedTransaction,
          Object.freeze({
            operation: 'action' as const,
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
        yield* verifyInvocation(runningInvocation, requestHash);
        const serviceFactory = resolveServiceFactory(input.registration);
        const services = yield* serviceFactory(scopedTransaction, scope);
        const handler = resolveHandler(input.registration);

        const collector = createActionCollector(
          input.registration.descriptor.domainEvents,
          input.registration.descriptor.owningModuleKey,
          input.registration.descriptor.accessEvidencePolicy,
          input.registration.descriptor.auditEvidenceSchema,
        );
        const handlerContext = Object.freeze({
          actionInvocationId: lockedInvocation.actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services,
        });

        const handlerExit = yield* Effect.exit(
          Effect.suspend(() => handler(payload, handlerContext)),
        );

        if (Exit.isFailure(handlerExit)) {
          const failureReasons = handlerExit.cause.reasons.filter(Cause.isFailReason);
          const [failureReason] = failureReasons;
          if (
            failureReasons.length === handlerExit.cause.reasons.length &&
            failureReason !== undefined
          ) {
            if (Schema.is(ActionCollectorError)(failureReason.error)) {
              return yield* failureReason.error;
            }
            const decodedDomainError = yield* Effect.option(
              Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(
                failureReason.error,
              ),
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
        let transactionValue:
          | ResultSchema['Type']
          | CommittedActionDomainRejection<DomainErrorSchema['Type']>;
        let resultHash: string;
        if (Schema.is(CommittedActionDomainRejectionSchema)(handlerValue)) {
          const committedDomainError = yield* Schema.encodeUnknownEffect(
            Schema.make<Schema.ConstraintEncoder<unknown>>(
              input.registration.descriptor.domainErrorSchema.ast,
            ),
          )(getCommittedActionDomainError(handlerValue)).pipe(
            Effect.flatMap((encodedDomainError) =>
              Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(
                encodedDomainError,
              ).pipe(Effect.map((domainError) => ({ domainError, encodedDomainError }))),
            ),
            Effect.tapError((cause) =>
              Effect.logError(
                'Invalid committed Action domain rejection returned by handler',
                cause,
              ),
            ),
            Effect.mapError((cause) => attachFailureCause(makeHandlerExecutionError(), cause)),
          );
          transactionValue = commitActionThenReject(committedDomainError.domainError);
          resultHash = yield* Effect.try({
            catch: (cause) => attachFailureCause(makeHandlerExecutionError(), cause),
            try: () => computeCanonicalValueHash(committedDomainError.encodedDomainError),
          });
        } else {
          const result = yield* decodeActionResult(
            input.registration.descriptor.resultSchema,
            handlerValue,
          );
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
              logActionTransactionFailureCause(
                error,
                'Unexpected Action success evidence persistence failure',
                {
                  actionKey: input.registration.descriptor.actionKey,
                  correlationId: transport.correlationId,
                  invocationId: invocation.actionInvocationId,
                },
              ),
            ),
          );
        notifyStage('success_evidence_flushed');
        yield* Ref.set(transactionBodyCompleted, true);
        return transactionValue;
      });
      // The driver/body stay interruptible; classify the settled Cause before interruption resumes.
      const transactionOutcomeExit = yield* Effect.exit(
        Effect.uninterruptibleMask(
          Effect.fn('ActionRuntime.classifyTransactionOutcome')(
            function* classifyTransactionOutcome(
              restore: <Value, Failure, Requirements>(
                effect: Effect.Effect<Value, Failure, Requirements>,
              ) => Effect.Effect<Value, Failure, Requirements>,
            ) {
              const transactionExit = yield* Effect.exit(
                restore(
                  database.executor.transaction((transaction) =>
                    transactionProgram(transaction).pipe(
                      Effect.onExit((exit) => Ref.set(transactionBodyExit, exit)),
                    ),
                  ),
                ),
              );
              if (Exit.isSuccess(transactionExit)) {
                return transactionExit.value;
              }

              const bodyExit = yield* Ref.get(transactionBodyExit);
              const bodyCompleted =
                (yield* Ref.get(transactionBodyCompleted)) &&
                bodyExit !== null &&
                Exit.isSuccess(bodyExit);
              if (
                bodyExit !== null &&
                Exit.isFailure(bodyExit) &&
                transactionExit.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && isSqlError(reason.defect),
                )
              ) {
                yield* Effect.logError(
                  'Action body failed before transaction rollback failed',
                  bodyExit.cause,
                );
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
                            reason:
                              'The database did not confirm whether the Action commit completed',
                          })
                        : transactionFailure(),
                    );
                  }),
                ),
              );
            },
          ),
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
        return yield* Effect.fail(
          getCommittedActionDomainError<DomainErrorSchema['Type']>(transactionResult),
        );
      }
      return transactionResult;
    },
  );

  const resolveActionCommit: ActionRuntimeService['resolveActionCommit'] = Effect.fn(
    'ActionRuntime.resolveActionCommit',
  )(function* resolveActionCommitEffect(input: ResolveActionCommitInput) {
    const principal = yield* validatePrincipal(input.principal);
    const invocationId = yield* validateInvocationId(input.invocationId);
    const invocation = yield* repository
      .resolveInvocation(database.executor, {
        invocationId,
        principal,
      })
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

export const ActionRuntimeLive = Layer.effect(
  ActionRuntime,
  Effect.gen(function* makeActionRuntimeService() {
    const ownerAuthorizationOverlay = yield* Effect.serviceOption(OwnerAuthorizationOverlay);
    const authorizationPreflight = yield* Effect.serviceOption(ActionAuthorizationPreflight);
    const [
      database,
      repository,
      permission,
      moduleEntrypointGateway,
      moduleStateGate,
      scopeResolver,
      contextAccess,
    ] = yield* Effect.all(
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
    return makeActionRuntime(database, repository, permission, scopeResolver, {
      contextAccess,
      moduleEntrypointGateway,
      moduleStateGate,
      ownerAuthorizationOverlay: Option.isSome(ownerAuthorizationOverlay)
        ? ownerAuthorizationOverlay.value
        : failClosedOwnerAuthorizationOverlay,
      ...(Option.isSome(authorizationPreflight)
        ? { authorizationPreflight: authorizationPreflight.value }
        : {}),
    });
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
