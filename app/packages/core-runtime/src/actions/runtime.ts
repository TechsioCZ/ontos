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
import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';
import { ActionTransportMetadataSchema } from './context.ts';
import type {
  ActionLegalEntityPermission,
  ActionRegistration,
  ActionResourcePermissionTarget,
  ActionTenantPermission,
} from './definition.ts';
import {
  decodeActionPayload,
  decodeActionResult,
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
  readonly contextAccess?: (typeof ContextAccess)['Service'];
  readonly installScope?: typeof installOperationalScope;
  readonly moduleEntrypointGateway: ModuleEntrypointGatewayService;
  readonly moduleStateGate: ModuleStateGateService;
  readonly onStage?: (stage: ActionRuntimeStage) => void;
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
  const { contextAccess, moduleEntrypointGateway, moduleStateGate } = options;
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

  const runAction: ActionRuntimeService['runAction'] = Effect.fn('ActionRuntime.runAction')(function* runActionEffect<
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
    } else if (hasCanonicalScopeTarget) {
      actionTarget = {};
      governedTransport = withOptionalProperty(
        withOptionalProperty(
          { correlationId: transport.correlationId },
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
    } else {
      actionTarget = withOptionalProperty(
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
    notifyStage('permission_checked');
    if (
      permissionDecision === 'denied' ||
      tenantPermissionDecision === 'denied' ||
      legalEntityPermissionDecision === 'denied' ||
      resourcePermissionDecision === 'denied'
    ) {
      return yield* rejectPermission();
    }

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
        yield* repository
          .finalizePolicyDenial(database.executor, {
            actionInvocationId: invocation.actionInvocationId,
            actionKey: input.registration.descriptor.actionKey,
            auditProfile: input.registration.descriptor.auditProfile,
            policy: policyEvidence(policy),
            principal,
            reasonCode: denial.reasonCode,
            transport: governedTransport,
          })
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
    });
    const allowedPolicies = yield* Effect.forEach(input.registration.descriptor.policies, evaluateActionPolicy, {
      concurrency: 1,
    });

    const runningInvocation = yield* repository
      .transitionInvocationToRunning(database.executor, invocation.actionInvocationId)
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
    notifyStage('invocation_running');

    const transactionBodyCompleted = yield* Ref.make(false);
    const transactionBodyExit = yield* Ref.make<Exit.Exit<unknown, unknown> | null>(null);
    const transactionProgram = Effect.fn('ActionRuntime.transaction')(function* executeTransaction(
      drizzleTransaction: CoreTransaction,
    ) {
      const lockedInvocation = yield* repository.lockInvocation(drizzleTransaction, invocation.actionInvocationId).pipe(
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

      const result = yield* decodeActionResult(input.registration.descriptor.resultSchema, handlerExit.value);

      const resultHash = yield* Effect.try({
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
                Schema.make<Schema.ConstraintEncoder<unknown>>(input.registration.descriptor.resultSchema.ast),
              )(result),
            ),
          ),
      });
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
      return result;
    });
    // The driver/body stay interruptible; classify the settled Cause before interruption resumes.
    return yield* Effect.uninterruptibleMask(
      Effect.fn('ActionRuntime.classifyTransactionOutcome')(function* classifyTransactionOutcome(
        restore: <Value, Failure, Requirements>(
          effect: Effect.Effect<Value, Failure, Requirements>,
        ) => Effect.Effect<Value, Failure, Requirements>,
      ) {
        const transactionExit = yield* Effect.exit(
          restore(
            database.executor.transaction((transaction) =>
              transactionProgram(transaction).pipe(Effect.onExit((exit) => Ref.set(transactionBodyExit, exit))),
            ),
          ),
        );
        if (Exit.isSuccess(transactionExit)) {
          return transactionExit.value;
        }

        const bodyExit = yield* Ref.get(transactionBodyExit);
        const bodyCompleted =
          (yield* Ref.get(transactionBodyCompleted)) && bodyExit !== null && Exit.isSuccess(bodyExit);
        if (
          bodyExit !== null &&
          Exit.isFailure(bodyExit) &&
          transactionExit.cause.reasons.some((reason) => Cause.isDieReason(reason) && isSqlError(reason.defect))
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
    );
  });

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
    return makeActionRuntime(database, repository, permission, scopeResolver, {
      contextAccess,
      moduleEntrypointGateway,
      moduleStateGate,
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
