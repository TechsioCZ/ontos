/* eslint-disable max-classes-per-file -- Private rollback signals preserve typed failures across Drizzle's Promise callback boundary. */
// @effect-diagnostics asyncFunction:off globalDate:off globalDateInEffect:off
// Drizzle's transaction/query contract is Promise-based; these narrow bridges
// keep the exported repository operations in typed Effect error channels.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Cause, Context, Effect, Layer, Predicate } from 'effect';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  tenants,
} from '../db/schema.ts';
import type { ActionInvocationStatus } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import type { ActionAuditProfile } from './definition.ts';
import type { ActionEvidenceSnapshot } from './events.ts';
import {
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionTransactionError,
} from './errors.ts';
import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';

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

export interface ActionRequestHashInput {
  readonly actionKey: string;
  readonly normalizedPayload: unknown;
  readonly owningModuleKey: string;
  readonly principal: TrustedPrincipalContext;
  readonly schemaVersion: string;
  readonly target: Pick<
    ActionTransportMetadata,
    'targetModuleKey' | 'targetResourceId' | 'targetResourceType'
  >;
}

type CanonicalValue =
  | readonly ['array', readonly CanonicalValue[]]
  | readonly ['bigint', string]
  | readonly ['boolean', boolean]
  | readonly ['date', string]
  | readonly ['null']
  | readonly ['number', string]
  | readonly ['object', readonly (readonly [string, CanonicalValue])[]]
  | readonly ['string', string]
  | readonly ['undefined'];

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const normalizeForHash = <Value>(value: Value, seen: WeakSet<object>): CanonicalValue => {
  if (value === undefined) {
    return ['undefined'];
  }
  if (value === null) {
    return ['null'];
  }
  if (Predicate.isBoolean(value)) {
    return ['boolean', value];
  }
  if (Predicate.isString(value)) {
    return ['string', value];
  }
  if (Predicate.isNumber(value)) {
    return ['number', Object.is(value, -0) ? '-0' : String(value)];
  }
  if (Predicate.isBigInt(value)) {
    return ['bigint', value.toString(10)];
  }
  if (value instanceof Date) {
    return ['date', value.toISOString()];
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('Action payloads must not contain cyclic values');
    }
    seen.add(value);
    const normalized = value.map((item) => normalizeForHash(item, seen));
    seen.delete(value);
    return ['array', normalized];
  }
  if (Predicate.isObjectKeyword(value)) {
    if (seen.has(value)) {
      throw new TypeError('Action payloads must not contain cyclic values');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Action payloads must contain only canonical data values');
    }
    seen.add(value);
    const entries = Object.entries(value)
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, normalizeForHash(item, seen)] as const);
    seen.delete(value);
    return ['object', entries];
  }
  const unsupportedKind = Predicate.isFunction(value) ? 'function' : 'symbol';
  throw new TypeError(`Action payloads cannot contain ${unsupportedKind} values`);
};

export const computeActionRequestHash = (input: ActionRequestHashInput): string => {
  const canonicalEnvelope = normalizeForHash(
    {
      actionKey: input.actionKey,
      normalizedPayload: input.normalizedPayload,
      owningModuleKey: input.owningModuleKey,
      principal: {
        legalEntityId: input.principal.legalEntityId,
        principalId: input.principal.principalId,
        tenantId: input.principal.tenantId,
      },
      schemaVersion: input.schemaVersion,
      target: input.target,
    },
    new WeakSet(),
  );

  return createHash('sha256').update(JSON.stringify(canonicalEnvelope)).digest('hex');
};

export const computeCanonicalValueHash = <Value>(value?: Value): string =>
  createHash('sha256')
    .update(JSON.stringify(normalizeForHash(value, new WeakSet())))
    .digest('hex');

export interface PrepareActionInvocationInput {
  readonly actionKey: string;
  readonly idempotencyKey: string | undefined;
  readonly principal: TrustedPrincipalContext;
  readonly requestHash: string;
  readonly transport: ActionTransportMetadata;
}

export interface ResolveActionInvocationInput {
  readonly invocationId: string;
  readonly principal: TrustedPrincipalContext;
}

export interface ActionInvocationRecord {
  readonly actionInvocationId: string;
  readonly completedAt: Date | null;
  readonly requestHash: string;
  readonly status: ActionInvocationStatus;
}

export interface ActionPolicyEvidence {
  readonly owningModuleKey?: string;
  readonly policyKey: string;
  readonly scope: 'global' | 'microvertical';
}

export interface FinalizeActionPolicyDenialInput {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly auditProfile: ActionAuditProfile;
  readonly policy: ActionPolicyEvidence;
  readonly principal: TrustedPrincipalContext;
  readonly reasonCode: string;
  readonly transport: ActionTransportMetadata;
}

export interface FlushActionSuccessInput {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly allowedPolicies: readonly ActionPolicyEvidence[];
  readonly auditProfile: ActionAuditProfile;
  readonly evidence: ActionEvidenceSnapshot;
  readonly principal: TrustedPrincipalContext;
  readonly resultHash: string;
  readonly transport: ActionTransportMetadata;
}

export interface RejectPermissionDeniedInput {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly auditProfile: ActionAuditProfile;
  readonly principal: TrustedPrincipalContext;
  readonly transport: ActionTransportMetadata;
}

export interface ActionRepositoryService {
  readonly createOrResolveInvocation: (
    executor: CoreDatabaseExecutor,
    input: PrepareActionInvocationInput,
  ) => Effect.Effect<ActionInvocationRecord, ActionInvocationPersistenceError>;
  readonly finalizePolicyDenial: (
    executor: CoreDatabaseExecutor,
    input: FinalizeActionPolicyDenialInput,
  ) => Effect.Effect<void, ActionInvocationPersistenceError>;
  readonly flushSuccess: (
    transaction: CoreTransaction,
    input: FlushActionSuccessInput,
  ) => Effect.Effect<void, ActionTransactionError>;
  readonly lockInvocation: (
    transaction: CoreTransaction,
    invocationId: string,
  ) => Effect.Effect<ActionInvocationRecord, ActionInvocationPersistenceError>;
  readonly rejectPermissionDenied: (
    executor: CoreDatabaseExecutor,
    input: RejectPermissionDeniedInput,
  ) => Effect.Effect<
    void,
    ActionInvocationPersistenceError | ActionInvocationStateError | ActionTransactionError
  >;
  readonly resolveInvocation: (
    executor: CoreDatabaseExecutor,
    input: ResolveActionInvocationInput,
  ) => Effect.Effect<
    ActionInvocationRecord,
    ActionInvocationNotFound | ActionInvocationPersistenceError
  >;
  readonly transitionInvocationToRunning: (
    executor: CoreDatabaseExecutor,
    invocationId: string,
  ) => Effect.Effect<ActionInvocationRecord, ActionInvocationPersistenceError>;
}

const invocationSelection = {
  actionInvocationId: actionInvocations.actionInvocationId,
  completedAt: actionInvocations.completedAt,
  requestHash: actionInvocations.requestHash,
  status: actionInvocations.status,
} as const;

const invocationPersistenceFailureCauses = new WeakMap<ActionInvocationPersistenceError, unknown>();

const persistenceFailure = <FailureCause>(reason: string, cause?: FailureCause) => {
  const failure = new ActionInvocationPersistenceError({
    code: 'action_invocation_persistence_failed',
    reason,
  });
  if (cause !== undefined) {
    invocationPersistenceFailureCauses.set(failure, cause);
  }
  return failure;
};

/** Internal bridge used by the transaction boundary to preserve the original defect. */
export const getActionInvocationPersistenceFailureCause = (
  failure: ActionInvocationPersistenceError,
): Cause.Cause<never> | undefined => {
  const cause = invocationPersistenceFailureCauses.get(failure);
  return cause === undefined ? undefined : Cause.die(cause);
};

export const logActionInvocationPersistenceFailureCause = (
  failure: ActionInvocationPersistenceError,
  annotations: Readonly<Record<string, string>>,
): Effect.Effect<void> => {
  const cause = invocationPersistenceFailureCauses.get(failure);
  return cause === undefined
    ? Effect.void
    : Effect.annotateLogs(
        Effect.logError('Unexpected Action invocation persistence failure', cause),
        annotations,
      );
};

const transactionFailureCauses = new WeakMap<ActionTransactionError, unknown>();

const transactionFailure = <FailureCause>(reason: string, cause?: FailureCause) => {
  const failure = new ActionTransactionError({
    code: 'action_transaction_failed',
    reason,
  });
  if (cause !== undefined) {
    transactionFailureCauses.set(failure, cause);
  }
  return failure;
};

class DenialRollbackSignal {
  readonly error:
    | ActionInvocationPersistenceError
    | ActionInvocationStateError
    | ActionTransactionError;

  constructor(
    error: ActionInvocationPersistenceError | ActionInvocationStateError | ActionTransactionError,
  ) {
    this.error = error;
  }
}

/** Internal bridge used by the transaction boundary to preserve the original defect. */
export const getActionTransactionFailureCause = (
  failure: ActionTransactionError,
): Cause.Cause<never> | undefined => {
  const cause = transactionFailureCauses.get(failure);
  return cause === undefined ? undefined : Cause.die(cause);
};

export const logActionTransactionFailureCause = (
  failure: ActionTransactionError,
  message: string,
  annotations: Readonly<Record<string, string>>,
): Effect.Effect<void> => {
  const cause = transactionFailureCauses.get(failure);
  return cause === undefined
    ? Effect.void
    : Effect.annotateLogs(Effect.logError(message, cause), annotations);
};

const queryEffect = <Value, Failure>(
  query: () => PromiseLike<Value>,
  onFailure: (cause: unknown) => Failure,
): Effect.Effect<Value, Failure> =>
  Effect.tryPromise({ catch: onFailure, try: async () => await query() });

// Drizzle must see a rejected Promise to roll back. Run only inside its foreign
// transaction callback; this bridge does not claim to cancel in-flight queries.
const runDenialTransaction = async (
  program: Effect.Effect<
    void,
    ActionInvocationPersistenceError | ActionInvocationStateError | ActionTransactionError
  >,
  context: Context.Context<never>,
): Promise<void> => {
  const failure = await Effect.runPromiseWith(context)(
    Effect.match(program, { onFailure: (error) => error, onSuccess: () => undefined }),
  );
  if (failure !== undefined) {
    throw new DenialRollbackSignal(failure);
  }
};

export const makeActionRepository = (): ActionRepositoryService => {
  const createOrResolveInvocation: ActionRepositoryService['createOrResolveInvocation'] = (
    executor,
    input,
  ) =>
    Effect.gen(function* () {
      const onFailure = (cause: unknown) =>
        persistenceFailure('Unable to create or resolve the Action invocation', cause);
      const inserted = yield* queryEffect(
        () =>
          executor
            .insert(actionInvocations)
            .values({
              actionKey: input.actionKey,
              authBindingId: input.principal.authBindingId,
              authContextRef: input.principal.authContextRef,
              authMethod: input.principal.authMethod,
              correlationId: input.transport.correlationId,
              idempotencyKey: input.idempotencyKey,
              impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
              legalEntityId: input.principal.legalEntityId,
              principalId: input.principal.principalId,
              requestHash: input.requestHash,
              status: 'received',
              targetModuleKey: input.transport.targetModuleKey,
              targetResourceId: input.transport.targetResourceId,
              targetResourceType: input.transport.targetResourceType,
              tenantId: input.principal.tenantId,
              traceId: input.transport.traceId,
            })
            .onConflictDoNothing()
            .returning(invocationSelection),
        onFailure,
      );

      const [created] = inserted;
      if (created !== undefined) {
        return created;
      }

      const { idempotencyKey } = input;
      if (idempotencyKey === undefined) {
        return yield* onFailure(
          new Error('A non-idempotent invocation insert unexpectedly conflicted'),
        );
      }

      const existing = yield* queryEffect(
        () =>
          executor
            .select(invocationSelection)
            .from(actionInvocations)
            .where(
              and(
                eq(actionInvocations.tenantId, input.principal.tenantId),
                eq(actionInvocations.actionKey, input.actionKey),
                eq(actionInvocations.principalId, input.principal.principalId),
                eq(actionInvocations.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1),
        onFailure,
      );

      const [resolved] = existing;
      if (resolved === undefined) {
        return yield* onFailure(
          new Error('The conflicting Action invocation could not be resolved'),
        );
      }
      return resolved;
    });

  const lockInvocation: ActionRepositoryService['lockInvocation'] = (transaction, invocationId) =>
    Effect.gen(function* () {
      const onFailure = (cause: unknown) =>
        persistenceFailure('Unable to lock the Action invocation', cause);
      const rows = yield* queryEffect(
        () =>
          transaction
            .select(invocationSelection)
            .from(actionInvocations)
            .where(eq(actionInvocations.actionInvocationId, invocationId))
            .for('update')
            .limit(1),
        onFailure,
      );
      const [invocation] = rows;
      if (invocation === undefined) {
        return yield* onFailure(new Error('The Action invocation no longer exists'));
      }
      return invocation;
    });

  const resolveInvocation: ActionRepositoryService['resolveInvocation'] = (executor, input) =>
    Effect.tryPromise({
      catch: (cause) =>
        persistenceFailure('Unable to resolve the Action invocation commit state', cause),
      try: () =>
        executor
          .select(invocationSelection)
          .from(actionInvocations)
          .where(
            and(
              eq(actionInvocations.actionInvocationId, input.invocationId),
              eq(actionInvocations.tenantId, input.principal.tenantId),
              eq(actionInvocations.principalId, input.principal.principalId),
            ),
          )
          .for('update')
          .limit(1),
    }).pipe(
      Effect.flatMap(([invocation]) =>
        invocation === undefined
          ? Effect.fail(
              new ActionInvocationNotFound({
                code: 'action_invocation_not_found',
                reason: 'The Action invocation does not exist in this principal scope',
              }),
            )
          : Effect.succeed(invocation),
      ),
    );

  const transitionInvocationToRunning: ActionRepositoryService['transitionInvocationToRunning'] = (
    executor,
    invocationId,
  ) =>
    Effect.gen(function* () {
      const onFailure = (cause: unknown) =>
        persistenceFailure('Unable to transition the Action invocation to running', cause);
      const transitioned = yield* queryEffect(
        () =>
          executor
            .update(actionInvocations)
            .set({ status: 'running' })
            .where(
              and(
                eq(actionInvocations.actionInvocationId, invocationId),
                inArray(actionInvocations.status, ['received', 'running']),
                isNull(actionInvocations.completedAt),
              ),
            )
            .returning(invocationSelection),
        onFailure,
      );
      const [invocation] = transitioned;
      if (invocation !== undefined) {
        return invocation;
      }
      const current = yield* queryEffect(
        () =>
          executor
            .select(invocationSelection)
            .from(actionInvocations)
            .where(eq(actionInvocations.actionInvocationId, invocationId))
            .limit(1),
        onFailure,
      );
      const [resolved] = current;
      if (resolved === undefined) {
        return yield* onFailure(new Error('The Action invocation no longer exists'));
      }
      return resolved;
    });

  const rejectPermissionDenied: ActionRepositoryService['rejectPermissionDenied'] = (
    executor,
    input,
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const onFailure = (cause: unknown) =>
        transactionFailure('Unable to persist Action permission denial evidence', cause);
      return yield* Effect.tryPromise({
        catch: (cause) => (cause instanceof DenialRollbackSignal ? cause.error : onFailure(cause)),
        try: () =>
          executor.transaction((transaction) =>
            runDenialTransaction(
              Effect.gen(function* () {
                const rows = yield* queryEffect(
                  () =>
                    transaction
                      .select(invocationSelection)
                      .from(actionInvocations)
                      .where(
                        and(
                          eq(actionInvocations.actionInvocationId, input.actionInvocationId),
                          eq(actionInvocations.actionKey, input.actionKey),
                          eq(actionInvocations.principalId, input.principal.principalId),
                          eq(actionInvocations.tenantId, input.principal.tenantId),
                        ),
                      )
                      .for('update')
                      .limit(1),
                  onFailure,
                );
                const [invocation] = rows;
                if (invocation === undefined) {
                  return yield* persistenceFailure('The denied Action invocation no longer exists');
                }

                if (invocation.status === 'rejected' && invocation.completedAt !== null) {
                  return;
                }
                if (invocation.status !== 'received' || invocation.completedAt !== null) {
                  return yield* new ActionInvocationStateError({
                    code: 'action_invocation_state_invalid',
                    reason: 'The Action invocation cannot be rejected from its current state',
                  });
                }

                yield* queryEffect(
                  () =>
                    transaction.insert(auditEvents).values({
                      actionInvocationId: input.actionInvocationId,
                      auditProfile: input.auditProfile,
                      authBindingId: input.principal.authBindingId,
                      authContextRef: input.principal.authContextRef,
                      authMethod: input.principal.authMethod,
                      eventType: 'action.rejected',
                      evidenceJson: { actionKey: input.actionKey },
                      impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
                      legalEntityId: input.principal.legalEntityId,
                      outcome: 'denied',
                      outcomeCode: 'spicedb_permission_denied',
                      outcomeStage: 'authz',
                      principalId: input.principal.principalId,
                      targetModuleKey: input.transport.targetModuleKey,
                      targetResourceId: input.transport.targetResourceId,
                      targetResourceType: input.transport.targetResourceType,
                      tenantId: input.principal.tenantId,
                    }),
                  onFailure,
                );

                const rejected = yield* queryEffect(
                  () =>
                    transaction
                      .update(actionInvocations)
                      .set({ completedAt: new Date(), status: 'rejected' })
                      .where(
                        and(
                          eq(actionInvocations.actionInvocationId, input.actionInvocationId),
                          eq(actionInvocations.status, 'received'),
                          isNull(actionInvocations.completedAt),
                        ),
                      )
                      .returning({ actionInvocationId: actionInvocations.actionInvocationId }),
                  onFailure,
                );
                if (rejected.length !== 1) {
                  return yield* onFailure(
                    new Error('The Action invocation could not be marked rejected'),
                  );
                }
              }),
              context,
            ),
          ),
      });
    });

  const finalizePolicyDenial: ActionRepositoryService['finalizePolicyDenial'] = (executor, input) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const onFailure = (cause: unknown) =>
        persistenceFailure('Unable to persist the rejected Action invocation', cause);
      return yield* Effect.tryPromise({
        catch: (cause) =>
          cause instanceof DenialRollbackSignal &&
          cause.error._tag === 'ActionInvocationPersistenceError'
            ? cause.error
            : onFailure(cause),
        try: () =>
          executor.transaction((transaction) =>
            runDenialTransaction(
              Effect.gen(function* () {
                const rows = yield* queryEffect(
                  () =>
                    transaction
                      .select(invocationSelection)
                      .from(actionInvocations)
                      .where(eq(actionInvocations.actionInvocationId, input.actionInvocationId))
                      .for('update')
                      .limit(1),
                  onFailure,
                );
                const [invocation] = rows;
                if (invocation === undefined) {
                  return yield* onFailure(new Error('The Action invocation no longer exists'));
                }
                if (invocation.status === 'rejected' && invocation.completedAt !== null) {
                  return;
                }
                if (invocation.status !== 'received' || invocation.completedAt !== null) {
                  return yield* onFailure(
                    new Error('The Action invocation is no longer open for Policy rejection'),
                  );
                }

                const policyEvidence = withOptionalProperty(
                  {
                    actionKey: input.actionKey,
                  },
                  input.policy.owningModuleKey !== undefined,
                  'owningModuleKey',
                  input.policy.owningModuleKey,
                  {
                    policyKey: input.policy.policyKey,
                    policyScope: input.policy.scope,
                  },
                );
                yield* queryEffect(
                  () =>
                    transaction.insert(auditEvents).values([
                      {
                        actionInvocationId: input.actionInvocationId,
                        auditProfile: input.auditProfile,
                        authBindingId: input.principal.authBindingId,
                        authContextRef: input.principal.authContextRef,
                        authMethod: input.principal.authMethod,
                        eventType: 'action.policy_checked',
                        evidenceJson: policyEvidence,
                        impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
                        legalEntityId: input.principal.legalEntityId,
                        outcome: 'denied',
                        outcomeCode: input.reasonCode,
                        outcomeStage: 'policy',
                        principalId: input.principal.principalId,
                        targetModuleKey: input.transport.targetModuleKey,
                        targetResourceId: input.transport.targetResourceId,
                        targetResourceType: input.transport.targetResourceType,
                        tenantId: input.principal.tenantId,
                      },
                      {
                        actionInvocationId: input.actionInvocationId,
                        auditProfile: input.auditProfile,
                        authBindingId: input.principal.authBindingId,
                        authContextRef: input.principal.authContextRef,
                        authMethod: input.principal.authMethod,
                        eventType: 'action.rejected',
                        evidenceJson: policyEvidence,
                        impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
                        legalEntityId: input.principal.legalEntityId,
                        outcome: 'denied',
                        outcomeCode: input.reasonCode,
                        outcomeStage: 'policy',
                        principalId: input.principal.principalId,
                        targetModuleKey: input.transport.targetModuleKey,
                        targetResourceId: input.transport.targetResourceId,
                        targetResourceType: input.transport.targetResourceType,
                        tenantId: input.principal.tenantId,
                      },
                    ]),
                  onFailure,
                );

                const rejected = yield* queryEffect(
                  () =>
                    transaction
                      .update(actionInvocations)
                      .set({ completedAt: new Date(), status: 'rejected' })
                      .where(
                        and(
                          eq(actionInvocations.actionInvocationId, input.actionInvocationId),
                          eq(actionInvocations.status, 'received'),
                          isNull(actionInvocations.completedAt),
                        ),
                      )
                      .returning({ actionInvocationId: actionInvocations.actionInvocationId }),
                  onFailure,
                );
                if (rejected.length !== 1) {
                  return yield* onFailure(
                    new Error('The Action invocation could not be marked rejected'),
                  );
                }
              }),
              context,
            ),
          ),
      });
    });

  const flushSuccess: ActionRepositoryService['flushSuccess'] = (transaction, input) =>
    Effect.gen(function* () {
      const onFailure = (cause: unknown) =>
        transactionFailure('Unable to persist successful Action evidence', cause);
      if (input.allowedPolicies.length > 0) {
        yield* queryEffect(
          () =>
            transaction.insert(auditEvents).values(
              input.allowedPolicies.map((policy) => ({
                actionInvocationId: input.actionInvocationId,
                auditProfile: input.auditProfile,
                authBindingId: input.principal.authBindingId,
                authContextRef: input.principal.authContextRef,
                authMethod: input.principal.authMethod,
                eventType: 'action.policy_checked',
                evidenceJson: withOptionalProperty(
                  {
                    actionKey: input.actionKey,
                  },
                  policy.owningModuleKey !== undefined,
                  'owningModuleKey',
                  policy.owningModuleKey,
                  {
                    policyKey: policy.policyKey,
                    policyScope: policy.scope,
                  },
                ),
                impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
                legalEntityId: input.principal.legalEntityId,
                outcome: 'allowed',
                outcomeCode: 'policy_allowed',
                outcomeStage: 'policy',
                principalId: input.principal.principalId,
                targetModuleKey: input.transport.targetModuleKey,
                targetResourceId: input.transport.targetResourceId,
                targetResourceType: input.transport.targetResourceType,
                tenantId: input.principal.tenantId,
              })),
            ),
          onFailure,
        );
      }

      yield* queryEffect(
        () =>
          transaction.insert(auditEvents).values({
            actionInvocationId: input.actionInvocationId,
            auditProfile: input.auditProfile,
            authBindingId: input.principal.authBindingId,
            authContextRef: input.principal.authContextRef,
            authMethod: input.principal.authMethod,
            eventType: 'action.executed',
            evidenceJson: {
              ...input.evidence.auditEvidence,
              actionKey: input.actionKey,
              resultHash: input.resultHash,
            },
            impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
            legalEntityId: input.principal.legalEntityId,
            outcome: 'succeeded',
            outcomeCode: 'action_executed',
            outcomeStage: 'execution',
            principalId: input.principal.principalId,
            targetModuleKey: input.transport.targetModuleKey,
            targetResourceId: input.transport.targetResourceId,
            targetResourceType: input.transport.targetResourceType,
            tenantId: input.principal.tenantId,
          }),
        onFailure,
      );

      if (input.evidence.dataAccessEvents.length > 0) {
        yield* queryEffect(
          () =>
            transaction.insert(dataAccessEvents).values(
              input.evidence.dataAccessEvents.map((event) => ({
                accessKind: event.accessKind,
                actionInvocationId: input.actionInvocationId,
                authBindingId: input.principal.authBindingId,
                authContextRef: input.principal.authContextRef,
                authMethod: input.principal.authMethod,
                evidenceCaptureMode: event.evidenceCaptureMode,
                evidencePayloadJson: event.evidencePayloadJson,
                evidencePolicyKey: event.evidencePolicyKey,
                impersonatedByPrincipalId: input.principal.impersonatedByPrincipalId,
                legalEntityId: input.principal.legalEntityId,
                occurredAt: event.occurredAt,
                outcome: 'allowed',
                outcomeCode: 'action_read_allowed',
                outcomeStage: 'execution',
                principalId: input.principal.principalId,
                queryHash: event.queryHash,
                redactionProfile: event.redactionProfile,
                resultCount: event.resultCount,
                resultFingerprintHash: event.resultFingerprintHash,
                resultFingerprintSchema: event.resultFingerprintSchema,
                servingModuleKey: event.servingModuleKey,
                targetModuleKey: event.targetModuleKey,
                targetResourceId: event.targetResourceId,
                targetResourceType: event.targetResourceType,
                tenantId: input.principal.tenantId,
              })),
            ),
          onFailure,
        );
      }

      if (input.evidence.domainEvents.length > 0) {
        // The tenant row is the existing, typed per-tenant serialization
        // anchor. Holding this lock until commit ensures sequence allocation
        // order cannot overtake commit order for one tenant's event stream.
        const lockedTenant = yield* queryEffect(
          () =>
            transaction
              .select({ tenantId: tenants.tenantId })
              .from(tenants)
              .where(eq(tenants.tenantId, input.principal.tenantId))
              .for('update')
              .limit(1),
          onFailure,
        );
        if (lockedTenant.length !== 1) {
          return yield* onFailure(new Error('The Domain Event tenant does not exist'));
        }
      }

      const persistedDomainEvents = input.evidence.domainEvents.map((event) => ({
        actionInvocationId: input.actionInvocationId,
        domainEventId: randomUUID(),
        eventType: event.eventType,
        legalEntityId: input.principal.legalEntityId,
        occurredAt: event.occurredAt,
        payloadJson: event.payloadJson,
        producerModuleKey: event.producerModuleKey,
        subjectModuleKey: event.subjectModuleKey,
        subjectResourceId: event.subjectResourceId,
        subjectResourceType: event.subjectResourceType,
        tenantId: input.principal.tenantId,
      }));

      if (persistedDomainEvents.length > 0) {
        yield* queryEffect(
          () => transaction.insert(domainEvents).values(persistedDomainEvents),
          onFailure,
        );
      }

      if (input.evidence.outboxMessages.length > 0) {
        const messages: (typeof outboxMessages.$inferInsert)[] = [];
        for (const collected of input.evidence.outboxMessages) {
          const persistedDomainEvent = persistedDomainEvents[collected.domainEventIndex];
          if (persistedDomainEvent === undefined) {
            return yield* onFailure(new Error('An Outbox Message has no persisted Domain Event'));
          }
          messages.push({
            domainEventId: persistedDomainEvent.domainEventId,
            payloadJson: collected.message.payloadJson,
            producerModuleKey: collected.message.producerModuleKey,
            tenantId: input.principal.tenantId,
            topic: collected.message.topic,
          });
        }
        yield* queryEffect(() => transaction.insert(outboxMessages).values(messages), onFailure);
      }

      const succeeded = yield* queryEffect(
        () =>
          transaction
            .update(actionInvocations)
            .set({
              completedAt: new Date(),
              status: 'succeeded',
            })
            .where(
              and(
                eq(actionInvocations.actionInvocationId, input.actionInvocationId),
                eq(actionInvocations.status, 'running'),
              ),
            )
            .returning({ actionInvocationId: actionInvocations.actionInvocationId }),
        onFailure,
      );

      if (succeeded.length !== 1) {
        return yield* onFailure(new Error('The Action invocation could not be marked succeeded'));
      }
    });

  return Object.freeze({
    createOrResolveInvocation,
    finalizePolicyDenial,
    flushSuccess,
    lockInvocation,
    rejectPermissionDenied,
    resolveInvocation,
    transitionInvocationToRunning,
  });
};

export class ActionRepository extends Context.Service<ActionRepository, ActionRepositoryService>()(
  '@app/core-runtime/actions/repository/ActionRepository',
) {}

export const ActionRepositoryLive = Layer.succeed(ActionRepository, makeActionRepository());
