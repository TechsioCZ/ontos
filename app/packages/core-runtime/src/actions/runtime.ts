/* eslint-disable max-classes-per-file, unicorn/no-array-method-this-argument -- The public Effect service, private sentinels, and Effect dual flatMap API are deliberate. */
// @effect-diagnostics asyncFunction:off
// Drizzle owns the Promise transaction callback; Effect exits are carried
// through a private rollback signal so typed handler failures remain typed.
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
import { CoreDatabase as CoreDatabaseService } from '../db/client.ts';
import type { CoreTransaction } from '../db/types.ts';
import { makeActionCollector } from './collector.ts';
import {
  ActionTransportMetadataSchema,
  TrustedPrincipalContextSchema,
  restrictTransactionExecutor,
} from './context.ts';
import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';
import { decodeActionPayload, decodeActionResult } from './definition.ts';
import type { ActionRegistration } from './definition.ts';
import {
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPayloadValidationError,
  ActionRequestHashConflict,
  ActionTransactionError,
  ActionTrustedContextValidationError,
} from './errors.ts';
import type { ActionCoreError, ActionInvocationNotFound } from './errors.ts';
import type { DomainEventContractMap } from './events.ts';
import {
  ActionRepository,
  ActionRepositoryLive,
  computeActionRequestHash,
  computeCanonicalValueHash,
  getActionInvocationPersistenceFailureCause,
  getActionTransactionFailureCause,
} from './repository.ts';
import type { ActionRepositoryService, ActionInvocationRecord } from './repository.ts';

export const ACTION_RUNTIME_STAGES = [
  'payload_decoded',
  'trusted_context_validated',
  'invocation_prepared',
  'authentication_boundary',
  'permission_boundary_deferred',
  'policy_boundary_deferred',
  'invocation_running',
  'invocation_locked',
  'handler_executed',
  'success_evidence_flushed',
] as const;

export type ActionRuntimeStage = (typeof ACTION_RUNTIME_STAGES)[number];

export interface RunActionInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
> {
  readonly payload: unknown;
  readonly principal: unknown;
  readonly registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents
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
  >(
    input: RunActionInput<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>,
  ) => Effect.Effect<ResultSchema['Type'], ActionCoreError | DomainErrorSchema['Type']>;
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
  readonly onStage?: (stage: ActionRuntimeStage) => void;
}

class ActionRollbackSignal<Error> {
  readonly cause: Cause.Cause<Error>;
  readonly defectCause: Cause.Cause<unknown> | undefined;

  constructor(cause: Cause.Cause<Error>, defectCause?: Cause.Cause<unknown>) {
    this.cause = cause;
    this.defectCause = defectCause;
  }
}

class TransactionBridgeFailure {
  readonly _tag = 'TransactionBridgeFailure';
  readonly original: unknown;

  constructor(original: unknown) {
    this.original = original;
  }
}

const exitValueOrRollback = <Value, Error>(exit: Exit.Exit<Value, Error>): Value => {
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    let originalCause: unknown;
    if (failure._tag === 'Some' && Schema.is(ActionTransactionError)(failure.value)) {
      originalCause = getActionTransactionFailureCause(failure.value);
    } else if (
      failure._tag === 'Some' &&
      Schema.is(ActionInvocationPersistenceError)(failure.value)
    ) {
      originalCause = getActionInvocationPersistenceFailureCause(failure.value);
    }
    throw new ActionRollbackSignal(
      exit.cause,
      originalCause === undefined ? undefined : Cause.die(originalCause),
    );
  }
  return exit.value;
};

const logInvocationPersistenceFailure = (
  failure: ActionInvocationPersistenceError,
  annotations: Readonly<Record<string, string>>,
): Effect.Effect<void> => {
  const cause = getActionInvocationPersistenceFailureCause(failure);
  return cause === undefined
    ? Effect.void
    : Effect.annotateLogs(
        Effect.logError('Unexpected Action invocation persistence failure', cause),
        annotations,
      );
};

const isCommitAcknowledgementFailure = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('commitIndeterminate' in error && error.commitIndeterminate === true) {
    return true;
  }
  if ('code' in error && typeof error.code === 'string') {
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

const validatePrincipal = (
  input: unknown,
): Effect.Effect<TrustedPrincipalContext, ActionTrustedContextValidationError> =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(input).pipe(
    Effect.mapError(
      () =>
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The trusted principal context is incomplete or invalid',
        }),
    ),
  );

const validateTransport = (
  input: unknown,
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

const validateInvocationId = (
  input: unknown,
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
  database: Context.Service.Shape<typeof CoreDatabaseService>,
  repository: ActionRepositoryService,
  options: ActionRuntimeOptions = {},
): ActionRuntimeService => {
  const notifyStage = (stage: ActionRuntimeStage): void => {
    options.onStage?.(stage);
  };

  const runAction = <
    PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
    ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
    DomainEvents extends DomainEventContractMap,
  >(
    input: RunActionInput<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>,
  ): Effect.Effect<ResultSchema['Type'], ActionCoreError | DomainErrorSchema['Type']> =>
    Effect.gen(function* runActionEffect() {
      const payload = yield* decodeActionPayload(
        input.registration.descriptor.payloadSchema,
        input.payload,
      );
      notifyStage('payload_decoded');

      const principal = yield* validatePrincipal(input.principal);
      const transport = yield* validateTransport(input.transport);
      notifyStage('trusted_context_validated');

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
            target: {
              ...(transport.targetModuleKey === undefined
                ? {}
                : { targetModuleKey: transport.targetModuleKey }),
              ...(transport.targetResourceId === undefined
                ? {}
                : { targetResourceId: transport.targetResourceId }),
              ...(transport.targetResourceType === undefined
                ? {}
                : { targetResourceType: transport.targetResourceType }),
            },
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

      // The trusted context already represents authentication for this first
      // runtime increment. Permission and policy boundaries are explicit but
      // deliberately perform no decision until their dedicated features land.
      notifyStage('authentication_boundary');
      notifyStage('permission_boundary_deferred');
      notifyStage('policy_boundary_deferred');

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
      const transaction = Effect.tryPromise({
        catch: (error) => new TransactionBridgeFailure(error),
        try: () =>
          database.executor.transaction(async (drizzleTransaction) => {
            const lockedInvocation = exitValueOrRollback(
              await Effect.runPromiseExit(
                repository.lockInvocation(
                  drizzleTransaction as CoreTransaction,
                  invocation.actionInvocationId,
                ),
              ),
            );
            notifyStage('invocation_locked');
            exitValueOrRollback(
              await Effect.runPromiseExit(verifyInvocation(lockedInvocation, requestHash)),
            );

            const collector = makeActionCollector(
              input.registration.descriptor.domainEvents,
              input.registration.descriptor.owningModuleKey,
              input.registration.descriptor.accessEvidencePolicy,
            );
            const handlerContext = Object.freeze({
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              principal,
              recordDataAccess: collector.recordDataAccess,
              transaction: restrictTransactionExecutor(drizzleTransaction as CoreTransaction),
            });

            const handlerExit = await Effect.runPromiseExit(
              Effect.suspend(() => input.registration.handler(payload, handlerContext)),
            );

            if (Exit.isFailure(handlerExit)) {
              if (Cause.hasDies(handlerExit.cause) || Cause.hasInterrupts(handlerExit.cause)) {
                throw new ActionRollbackSignal(
                  Cause.fail(makeHandlerExecutionError()),
                  handlerExit.cause,
                );
              }
              const domainError = Cause.findErrorOption(handlerExit.cause);
              if (domainError._tag === 'None') {
                throw new ActionRollbackSignal(
                  Cause.fail(makeHandlerExecutionError()),
                  handlerExit.cause,
                );
              }
              if (Schema.is(ActionCollectorError)(domainError.value)) {
                throw new ActionRollbackSignal(Cause.fail(domainError.value));
              }
              const decodedDomainError = await Effect.runPromiseExit(
                Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(
                  domainError.value,
                ),
              );
              if (Exit.isFailure(decodedDomainError)) {
                throw new ActionRollbackSignal(
                  Cause.fail(makeHandlerExecutionError()),
                  handlerExit.cause,
                );
              }
              throw new ActionRollbackSignal(Cause.fail(decodedDomainError.value));
            }
            notifyStage('handler_executed');

            const result = exitValueOrRollback(
              await Effect.runPromiseExit(
                decodeActionResult(input.registration.descriptor.resultSchema, handlerExit.value),
              ),
            );

            const resultHash = computeCanonicalValueHash(result);
            const persistenceExit = await Effect.runPromiseExit(
              repository.flushSuccess(drizzleTransaction as CoreTransaction, {
                actionInvocationId: invocation.actionInvocationId,
                actionKey: input.registration.descriptor.actionKey,
                auditProfile: input.registration.descriptor.auditProfile,
                evidence: collector.snapshot(),
                principal,
                resultHash,
                transport,
              }),
            );
            exitValueOrRollback(persistenceExit);
            notifyStage('success_evidence_flushed');
            transactionBodyCompleted = true;
            return result;
          }),
      });

      return yield* transaction.pipe(
        Effect.catch((bridgeError) => {
          const transactionError = bridgeError.original;
          if (transactionError instanceof ActionRollbackSignal) {
            const rollback = transactionError as ActionRollbackSignal<
              ActionCoreError | DomainErrorSchema['Type']
            >;
            return Effect.gen(function* reportRollback() {
              if (rollback.defectCause !== undefined) {
                yield* Effect.annotateLogs(
                  Effect.logError('Unexpected Action execution defect', rollback.defectCause),
                  {
                    actionKey: input.registration.descriptor.actionKey,
                    correlationId: transport.correlationId,
                    invocationId: invocation.actionInvocationId,
                  },
                );
              }
              return yield* Effect.failCause(rollback.cause);
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
    return makeActionRuntime(database, repository);
  }),
).pipe(Layer.provide(ActionRepositoryLive));

export const runAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
>(
  input: RunActionInput<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>,
): Effect.Effect<
  ResultSchema['Type'],
  ActionCoreError | DomainErrorSchema['Type'],
  ActionRuntime
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
