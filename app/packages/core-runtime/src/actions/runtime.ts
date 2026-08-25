/* eslint-disable max-classes-per-file, promise/prefer-await-to-callbacks, unicorn/no-array-method-this-argument -- The public Effect service, private sentinels, Effect callbacks, and Effect dual flatMap API are deliberate. */
// @effect-diagnostics asyncFunction:off
// Drizzle owns the Promise transaction callback; Effect exits are carried
// through a private rollback signal so typed handler failures remain typed.
import { Cause, Context, Effect, Exit, Layer, Schema, Predicate } from 'effect';
import { CoreDatabase as CoreDatabaseService } from '../db/client.ts';
import type { CoreTransaction } from '../db/types.ts';
import { createActionCollector } from './collector.ts';
import { ActionTransportMetadataSchema } from './context.ts';
import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../auth/system-principal-context-provenance.ts';
import {
  decodeActionPayload,
  decodeActionResult,
  getActionHandler,
  getActionServiceFactory,
} from './definition.ts';
import type { ActionRegistration } from './definition.ts';
import {
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPayloadValidationError,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionTransactionError,
  ActionTrustedContextValidationError,
} from './errors.ts';
import type { ActionCoreError, ActionInvocationNotFound } from './errors.ts';
import type { DomainEventContractMap } from './events.ts';
import { ActionPermission, ActionPermissionLive } from '../permissions/service.ts';
import type { ActionPermissionService } from '../permissions/service.ts';
import { PolicyDenied } from './policy.ts';
import type { ActionPolicy, ActionPolicyEvaluatorInput } from './policy.ts';
import {
  ActionRepository,
  ActionRepositoryLive,
  computeActionRequestHash,
  computeCanonicalValueHash,
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
  logActionInvocationPersistenceFailureCause,
  logActionTransactionFailureCause,
} from './repository.ts';
import type {
  ActionInvocationRecord,
  ActionPolicyEvidence,
  ActionRepositoryService,
} from './repository.ts';
import {
  ModuleEntrypointGateway,
  ModuleEntrypointGatewayLive,
} from '../modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import type {
  ModuleEntrypointDescriptor,
  TenantModuleEntrypoint,
} from '../modules/module-entrypoint.ts';
import { ModuleStateGate, ModuleStateGateLive } from '../modules/module-state-gate.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { OperationalScopeResolver, OperationalScopeResolverLive } from '../operations/context.ts';
import type { OperationalScopeResolverService } from '../operations/context.ts';
import { ContextAccess, ContextAccessLive } from '../permissions/context-access.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

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
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
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

export interface ActionCommitOpen {
  readonly _tag: 'ActionCommitOpen';
  readonly invocationId: string;
}

export interface ActionRuntimeService {
  readonly runAction: <
    PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
    ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
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
  ) => Effect.Effect<
    ResultSchema['Type'],
    ActionCoreError | DomainErrorSchema['Type'],
    HandlerRequirements
  >;
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
}

export interface ActionRuntimeOptions {
  readonly contextAccess?: (typeof ContextAccess)['Service'];
  readonly moduleEntrypointGateway: ModuleEntrypointGatewayService;
  readonly moduleStateGate: ModuleStateGateService;
  readonly onStage?: (stage: ActionRuntimeStage) => void;
  readonly resolveHandler?: typeof getActionHandler;
  readonly resolveServiceFactory?: typeof getActionServiceFactory;
  readonly installScope?: typeof installOperationalScope;
}

type ActionRollbackToken = symbol;

class ActionRollbackSignal<Error, DefectError = never> {
  readonly cause: Cause.Cause<Error>;
  readonly defectCause: Cause.Cause<DefectError> | undefined;
  readonly #token: ActionRollbackToken;

  constructor(
    token: ActionRollbackToken,
    cause: Cause.Cause<Error>,
    defectCause?: Cause.Cause<DefectError>,
  ) {
    this.#token = token;
    this.cause = cause;
    this.defectCause = defectCause;
  }

  matches(token: ActionRollbackToken): boolean {
    return this.#token === token;
  }
}

class TransactionBridgeFailure<Original> {
  readonly _tag = 'TransactionBridgeFailure';
  readonly original: Original;

  constructor(original: Original) {
    this.original = original;
  }
}

const exitValueOrRollback = <Value, Error>(
  exit: Exit.Exit<Value, Error>,
  token: ActionRollbackToken,
): Value => {
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    let defectCause: Cause.Cause<never> | undefined = undefined;
    if (failure._tag === 'Some' && Schema.is(ActionTransactionError)(failure.value)) {
      defectCause = getActionTransactionFailureCause(failure.value);
    } else if (
      failure._tag === 'Some' &&
      Schema.is(ActionInvocationPersistenceError)(failure.value)
    ) {
      defectCause = getActionInvocationPersistenceFailureCause(failure.value);
    }
    throw new ActionRollbackSignal(token, exit.cause, defectCause);
  }
  return exit.value;
};

const logInvocationPersistenceFailure = (
  failure: ActionInvocationPersistenceError,
  annotations: Readonly<Record<string, string>>,
): Effect.Effect<void> => logActionInvocationPersistenceFailureCause(failure, annotations);

const isCommitAcknowledgementFailure = <Failure>(error: Failure): boolean => {
  if (!Predicate.isObjectKeyword(error) || error === null) {
    return false;
  }
  if ('commitIndeterminate' in error && error.commitIndeterminate === true) {
    return true;
  }
  if ('code' in error && Predicate.isString(error.code)) {
    const networkCodes = new Set([
      'ECONNABORTED',
      'ECONNRESET',
      'EHOSTDOWN',
      'EHOSTUNREACH',
      'ENETDOWN',
      'ENETRESET',
      'ENETUNREACH',
      'EPIPE',
      'ETIMEDOUT',
    ]);
    if (error.code.startsWith('08') || error.code === '57P01' || networkCodes.has(error.code)) {
      return true;
    }
  }
  return 'cause' in error && error.cause !== error
    ? isCommitAcknowledgementFailure(error.cause)
    : false;
};

const transactionFailure = () =>
  new ActionTransactionError({
    code: 'action_transaction_failed',
    reason: 'The Action transaction failed and was rolled back',
  });

const alreadyCommitted = () =>
  new ActionAlreadyCommitted({
    code: 'action_already_committed',
    reason: 'This idempotency key already committed successfully',
  });

const requestHashConflict = () =>
  new ActionRequestHashConflict({
    code: 'action_request_hash_conflict',
    reason: 'This idempotency key was already used for a different Action request',
  });

const checkTenantActionPermission = (
  contextAccess: (typeof ContextAccess)['Service'] | undefined,
  principal: TrustedPrincipalContext,
  requiredPermission: (() => 'impersonate' | 'manage_identity' | undefined) | undefined,
): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> =>
  Effect.suspend(() => {
    const permission = requiredPermission?.();
    if (permission === undefined) {
      return Effect.succeed('allowed' as const);
    }
    if (contextAccess === undefined) {
      return Effect.fail(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The authorization service could not determine permission safely',
        }),
      );
    }
    return contextAccess
      .tenants({
        permission,
        principalId: principal.principalId,
        tenantIds: [principal.tenantId],
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision?.decision === 'allowed' || decision?.decision === 'denied'
            ? Effect.succeed(decision.decision)
            : Effect.fail(
                new ActionPermissionCheckError({
                  code: 'action_permission_check_failed',
                  reason: 'The authorization service could not determine permission safely',
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
  | ActionAlreadyCommitted
  | ActionCommitIndeterminate
  | ActionInvocationStateError
  | ActionRequestHashConflict
> => {
  if (invocation.requestHash !== requestHash) {
    return Effect.fail(requestHashConflict());
  }
  if (invocation.status === 'succeeded') {
    return Effect.fail(alreadyCommitted());
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
  if (
    (invocation.status === 'received' || invocation.status === 'running') &&
    invocation.completedAt === null
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new ActionInvocationStateError({
      code: 'action_invocation_state_invalid',
      reason: 'This Action invocation is terminal and cannot execute again',
    }),
  );
};

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
          Predicate.isObjectKeyword(payload) &&
          payload !== null &&
          'checkpoint' in payload &&
          payload.checkpoint === 'stopped'),
      () =>
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The support recovery context does not authorize this Action',
        }),
    ),
    Effect.mapError(
      () =>
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The trusted principal context is incomplete or invalid',
        }),
    ),
  );

const validateTransport = <Input>(
  input: Input,
): Effect.Effect<ActionTransportMetadata, ActionPayloadValidationError> =>
  Schema.decodeUnknownEffect(ActionTransportMetadataSchema)(input).pipe(
    Effect.mapError(
      () =>
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action transport metadata is structurally invalid',
        }),
    ),
  );

const makeHandlerExecutionError = () =>
  new ActionHandlerExecutionError({
    code: 'action_handler_execution_failed',
    reason: 'The Action handler failed unexpectedly',
  });

const isTenantActionEntrypoint = <Owner extends string>(
  entrypoint: ModuleEntrypointDescriptor<'action', 'write', Owner>,
): entrypoint is TenantModuleEntrypoint<'action', 'write', Owner> => entrypoint.scope === 'tenant';

const policyEvidence = <Payload, Owner extends string>(
  policy: ActionPolicy<Payload, Owner>,
): ActionPolicyEvidence =>
  policy.scope === 'global'
    ? { policyKey: policy.policyKey, scope: policy.scope }
    : {
        owningModuleKey: policy.owningModuleKey,
        policyKey: policy.policyKey,
        scope: policy.scope,
      };

const validateInvocationId = <Input>(
  input: Input,
): Effect.Effect<string, ActionPayloadValidationError> =>
  Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(input).pipe(
    Effect.mapError(
      () =>
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action invocation identifier is invalid',
        }),
    ),
  );

export const makeActionRuntime = (
  database: (typeof CoreDatabaseService)['Service'],
  repository: ActionRepositoryService,
  permission: ActionPermissionService,
  operationalScopeResolver: OperationalScopeResolverService,
  options: ActionRuntimeOptions,
): ActionRuntimeService => {
  const { moduleEntrypointGateway, moduleStateGate } = options;
  const resolveHandler = options.resolveHandler ?? getActionHandler;
  const resolveServiceFactory = options.resolveServiceFactory ?? getActionServiceFactory;
  const installScope = options.installScope ?? installOperationalScope;
  const notifyStage = (stage: ActionRuntimeStage): void => {
    options.onStage?.(stage);
  };

  const runAction = <
    PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
    ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
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
    HandlerRequirements
  > =>
    Effect.gen(function* runActionEffect() {
      const handlerRequirements = yield* Effect.context<HandlerRequirements>();
      const payload = yield* decodeActionPayload(
        input.registration.descriptor.payloadSchema,
        input.payload,
      );
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
          !(transport.traceId === undefined),
          'traceId',
          transport.traceId,
          {},
        ),
      );
      notifyStage('trusted_context_validated');

      const moduleStateSnapshot = yield* moduleEntrypointGateway.prepareSnapshot(scope, [
        input.registration.descriptor.entrypoint,
      ]);
      yield* moduleEntrypointGateway.check(
        moduleStateSnapshot,
        input.registration.descriptor.entrypoint,
      );
      notifyStage('module_state_gate');

      if (
        input.registration.descriptor.idempotency === 'required' &&
        transport.idempotencyKey === undefined
      ) {
        return yield* new ActionIdempotencyKeyRequired({
          code: 'action_idempotency_key_required',
          reason: 'This Action requires an idempotency key',
        });
      }

      const requestHash = yield* Effect.try({
        catch: () =>
          new ActionPayloadValidationError({
            code: 'action_payload_invalid',
            reason: 'The decoded Action payload cannot be normalized safely',
          }),
        try: () =>
          computeActionRequestHash({
            actionKey: input.registration.descriptor.actionKey,
            normalizedPayload: payload,
            owningModuleKey: input.registration.descriptor.owningModuleKey,
            principal,
            schemaVersion: input.registration.descriptor.schemaVersion,
            target: withOptionalProperty(
              withOptionalProperty(
                withOptionalProperty(
                  {},
                  !(transport.targetModuleKey === undefined),
                  'targetModuleKey',
                  transport.targetModuleKey,
                  {},
                ),
                !(transport.targetResourceId === undefined),
                'targetResourceId',
                transport.targetResourceId,
                {},
              ),
              !(transport.targetResourceType === undefined),
              'targetResourceType',
              transport.targetResourceType,
              {},
            ),
          }),
      });

      const invocation = yield* repository
        .createOrResolveInvocation(database.executor, {
          actionKey: input.registration.descriptor.actionKey,
          idempotencyKey: transport.idempotencyKey,
          principal,
          requestHash,
          transport,
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
      const rejectPermission = () =>
        repository
          .rejectPermissionDenied(database.executor, {
            actionInvocationId: invocation.actionInvocationId,
            actionKey: input.registration.descriptor.actionKey,
            auditProfile: input.registration.descriptor.auditProfile,
            principal,
            transport,
          })
          .pipe(
            Effect.tapError((error) => {
              if (error._tag === 'ActionInvocationPersistenceError') {
                return logInvocationPersistenceFailure(error, {
                  actionKey: input.registration.descriptor.actionKey,
                  correlationId: transport.correlationId,
                  invocationId: invocation.actionInvocationId,
                });
              }
              if (error._tag === 'ActionTransactionError') {
                return logActionTransactionFailureCause(
                  error,
                  'Unexpected permission denial persistence failure',
                  {
                    actionKey: input.registration.descriptor.actionKey,
                    correlationId: transport.correlationId,
                    invocationId: invocation.actionInvocationId,
                  },
                );
              }
              return Effect.void;
            }),
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
        .pipe(
          Effect.tapError((error) =>
            Effect.annotateLogs(Effect.logError(error.reason), {
              actionKey: input.registration.descriptor.actionKey,
              correlationId: transport.correlationId,
              invocationId: invocation.actionInvocationId,
            }),
          ),
        );
      notifyStage('permission_checked');

      if (permissionDecision === 'denied') {
        return yield* rejectPermission();
      }

      const tenantPermissionDecision = yield* checkTenantActionPermission(
        options.contextAccess,
        principal,
        input.registration.descriptor.tenantPermission === undefined
          ? undefined
          : () => input.registration.descriptor.tenantPermission?.(payload),
      );
      if (tenantPermissionDecision === 'denied') {
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
        target: Object.freeze(
          withOptionalProperty(
            withOptionalProperty(
              withOptionalProperty(
                {},
                !(transport.targetModuleKey === undefined),
                'targetModuleKey',
                transport.targetModuleKey,
                {},
              ),
              !(transport.targetResourceId === undefined),
              'targetResourceId',
              transport.targetResourceId,
              {},
            ),
            !(transport.targetResourceType === undefined),
            'targetResourceType',
            transport.targetResourceType,
            {},
          ),
        ),
        transport: Object.freeze(
          withOptionalProperty(
            {
              correlationId: transport.correlationId,
            },
            !(transport.traceId === undefined),
            'traceId',
            transport.traceId,
            {},
          ),
        ),
      });
      const allowedPolicies: ActionPolicyEvidence[] = [];
      for (const policy of input.registration.descriptor.policies) {
        const policyExit = yield* Effect.exit(Effect.suspend(() => policy.evaluate(policyInput)));
        if (Exit.isSuccess(policyExit)) {
          allowedPolicies.push(policyEvidence(policy));
          continue;
        }

        const failure = Cause.findErrorOption(policyExit.cause);
        if (
          !Cause.hasDies(policyExit.cause) &&
          !Cause.hasInterrupts(policyExit.cause) &&
          failure._tag === 'Some' &&
          Schema.is(PolicyDenied)(failure.value)
        ) {
          const denial = failure.value;
          yield* repository
            .finalizePolicyDenial(database.executor, {
              actionInvocationId: invocation.actionInvocationId,
              actionKey: input.registration.descriptor.actionKey,
              auditProfile: input.registration.descriptor.auditProfile,
              policy: policyEvidence(policy),
              principal,
              reasonCode: denial.reasonCode,
              transport,
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

        yield* Effect.annotateLogs(
          Effect.logError('Unexpected Action Policy evaluation failure', policyExit.cause),
          {
            actionKey: input.registration.descriptor.actionKey,
            correlationId: transport.correlationId,
            invocationId: invocation.actionInvocationId,
            policyKey: policy.policyKey,
          },
        );
        return yield* new ActionPolicyEvaluationError({
          code: 'action_policy_evaluation_failed',
          reason: 'A required Action Policy could not be evaluated',
        });
      }

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

      let transactionBodyCompleted = false;
      const rollbackToken = Symbol('@app/core-runtime/actions/rollback');
      const transaction = Effect.tryPromise({
        catch: (error) => new TransactionBridgeFailure(error),
        try: () =>
          database.executor.transaction(async (drizzleTransaction: CoreTransaction) => {
            const lockedInvocation = exitValueOrRollback(
              await Effect.runPromiseExit(
                repository.lockInvocation(drizzleTransaction, invocation.actionInvocationId),
              ),
              rollbackToken,
            );
            notifyStage('invocation_locked');
            exitValueOrRollback(
              await Effect.runPromiseExit(verifyInvocation(lockedInvocation, requestHash)),
              rollbackToken,
            );

            const scopedTransaction = exitValueOrRollback(
              await Effect.runPromiseExit(installScope(drizzleTransaction, scope)),
              rollbackToken,
            );
            notifyStage('database_scope_installed');

            if (isTenantActionEntrypoint(input.registration.descriptor.entrypoint)) {
              exitValueOrRollback(
                await Effect.runPromiseExit(
                  moduleStateGate.recheckWrite(
                    drizzleTransaction,
                    scope.tenantId,
                    input.registration.descriptor.entrypoint,
                  ),
                ),
                rollbackToken,
              );
            }
            notifyStage('module_state_rechecked');
            const serviceFactory = resolveServiceFactory(input.registration);
            const services = exitValueOrRollback(
              await Effect.runPromiseExit(
                serviceFactory(scopedTransaction, scope).pipe(Effect.provide(handlerRequirements)),
              ),
              rollbackToken,
            );
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

            const handlerExit = await Effect.runPromiseExit(
              Effect.suspend(() => handler(payload, handlerContext)).pipe(
                Effect.provide(handlerRequirements),
              ),
            );

            if (Exit.isFailure(handlerExit)) {
              if (Cause.hasDies(handlerExit.cause) || Cause.hasInterrupts(handlerExit.cause)) {
                throw new ActionRollbackSignal(
                  rollbackToken,
                  Cause.fail(makeHandlerExecutionError()),
                  handlerExit.cause,
                );
              }
              const domainError = Cause.findErrorOption(handlerExit.cause);
              if (domainError._tag === 'None') {
                throw new ActionRollbackSignal(
                  rollbackToken,
                  Cause.fail(makeHandlerExecutionError()),
                  handlerExit.cause,
                );
              }
              if (Schema.is(ActionCollectorError)(domainError.value)) {
                throw new ActionRollbackSignal(rollbackToken, Cause.fail(domainError.value));
              }
              const decodedDomainError = await Effect.runPromiseExit(
                Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(
                  domainError.value,
                ),
              );
              if (Exit.isFailure(decodedDomainError)) {
                throw new ActionRollbackSignal(
                  rollbackToken,
                  Cause.fail(makeHandlerExecutionError()),
                  handlerExit.cause,
                );
              }
              throw new ActionRollbackSignal(rollbackToken, Cause.fail(decodedDomainError.value));
            }
            notifyStage('handler_executed');

            const result = exitValueOrRollback(
              await Effect.runPromiseExit(
                decodeActionResult(input.registration.descriptor.resultSchema, handlerExit.value),
              ),
              rollbackToken,
            );

            const resultHash = computeCanonicalValueHash(result);
            const persistenceExit = await Effect.runPromiseExit(
              repository.flushSuccess(drizzleTransaction, {
                actionInvocationId: invocation.actionInvocationId,
                actionKey: input.registration.descriptor.actionKey,
                allowedPolicies,
                auditProfile: input.registration.descriptor.auditProfile,
                evidence: collector.snapshot(),
                principal,
                resultHash,
                transport,
              }),
            );
            exitValueOrRollback(persistenceExit, rollbackToken);
            notifyStage('success_evidence_flushed');
            transactionBodyCompleted = true;
            return result;
          }),
      });
      const isCurrentRollback = <Value>(
        value: Value,
      ): value is Value &
        ActionRollbackSignal<ActionCoreError | DomainErrorSchema['Type'], unknown> =>
        value instanceof ActionRollbackSignal && value.matches(rollbackToken);

      return yield* transaction.pipe(
        Effect.catch((bridgeError) => {
          const transactionError = bridgeError.original;
          if (isCurrentRollback(transactionError)) {
            return Effect.gen(function* reportRollback() {
              if (transactionError.defectCause !== undefined) {
                yield* Effect.annotateLogs(
                  Effect.logError(
                    'Unexpected Action execution defect',
                    transactionError.defectCause,
                  ),
                  {
                    actionKey: input.registration.descriptor.actionKey,
                    correlationId: transport.correlationId,
                    invocationId: invocation.actionInvocationId,
                  },
                );
              }
              return yield* Effect.failCause(transactionError.cause);
            });
          }
          if (transactionBodyCompleted && isCommitAcknowledgementFailure(transactionError)) {
            return Effect.fail(
              new ActionCommitIndeterminate({
                code: 'action_commit_indeterminate',
                invocationId: invocation.actionInvocationId,
                reason: 'The database did not confirm whether the Action commit completed',
              }),
            );
          }
          return Effect.gen(function* reportTransactionFailure() {
            yield* Effect.annotateLogs(
              Effect.logError('Unexpected Action transaction failure', transactionError),
              {
                actionKey: input.registration.descriptor.actionKey,
                correlationId: transport.correlationId,
                invocationId: invocation.actionInvocationId,
              },
            );
            return yield* transactionFailure();
          });
        }),
      );
    });

  const resolveActionCommit: ActionRuntimeService['resolveActionCommit'] = (input) =>
    Effect.gen(function* resolveActionCommitEffect() {
      const principal = yield* validatePrincipal(input.principal);
      const invocationId = yield* validateInvocationId(input.invocationId);
      const invocation = yield* repository
        .resolveInvocation(database.executor, {
          invocationId,
          principal,
        })
        .pipe(
          Effect.tapError((error) =>
            error._tag === 'ActionInvocationPersistenceError'
              ? logInvocationPersistenceFailure(error, {
                  invocationId,
                  principalId: principal.principalId,
                  tenantId: principal.tenantId,
                })
              : Effect.void,
          ),
          Effect.mapError((error) =>
            error._tag === 'ActionInvocationPersistenceError'
              ? new ActionCommitIndeterminate({
                  code: 'action_commit_indeterminate',
                  invocationId,
                  reason: 'The database cannot confirm the Action commit state yet',
                })
              : error,
          ),
        );

      if (invocation.status === 'succeeded') {
        return yield* alreadyCommitted();
      }
      if (
        (invocation.status === 'received' ||
          invocation.status === 'running' ||
          invocation.status === 'indeterminate') &&
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
    const database = yield* CoreDatabaseService;
    const repository = yield* ActionRepository;
    const permission = yield* ActionPermission;
    const moduleEntrypointGateway = yield* ModuleEntrypointGateway;
    const moduleStateGate = yield* ModuleStateGate;
    const scopeResolver = yield* OperationalScopeResolver;
    const contextAccess = yield* ContextAccess;
    return makeActionRuntime(database, repository, permission, scopeResolver, {
      contextAccess,
      moduleEntrypointGateway,
      moduleStateGate,
    });
  }),
).pipe(
  Layer.provide(ActionRepositoryLive),
  Layer.provide(ActionPermissionLive),
  Layer.provide(ModuleEntrypointGatewayLive),
  Layer.provide(ModuleStateGateLive),
  Layer.provide(OperationalScopeResolverLive),
  Layer.provide(ContextAccessLive),
);

export const runAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
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
> => Effect.flatMap(ActionRuntime, (runtime) => runtime.runAction(input));

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
> => Effect.flatMap(ActionRuntime, (runtime) => runtime.resolveActionCommit(input));
