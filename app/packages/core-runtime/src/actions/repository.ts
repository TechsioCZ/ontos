// @effect-diagnostics asyncFunction:off globalDateInEffect:off
// Drizzle's transaction/query contract is Promise-based; these narrow bridges
// keep the exported repository operations in typed Effect error channels.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
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
  ActionTransactionError,
} from './errors.ts';
import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';

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

const normalizeForHash = (value: unknown, seen: WeakSet<object>): CanonicalValue => {
  if (value === undefined) {
    return ['undefined'];
  }
  if (value === null) {
    return ['null'];
  }
  if (typeof value === 'boolean') {
    return ['boolean', value];
  }
  if (typeof value === 'string') {
    return ['string', value];
  }
  if (typeof value === 'number') {
    return ['number', Object.is(value, -0) ? '-0' : String(value)];
  }
  if (typeof value === 'bigint') {
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
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError('Action payloads must not contain cyclic values');
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
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
  throw new TypeError(`Action payloads cannot contain ${typeof value} values`);
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

export const computeCanonicalValueHash = (value?: unknown): string =>
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

export interface FlushActionSuccessInput {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly auditProfile: ActionAuditProfile;
  readonly evidence: ActionEvidenceSnapshot;
  readonly principal: TrustedPrincipalContext;
  readonly resultHash: string;
  readonly transport: ActionTransportMetadata;
}

export interface ActionRepositoryService {
  readonly createOrResolveInvocation: (
    executor: CoreDatabaseExecutor,
    input: PrepareActionInvocationInput,
  ) => Effect.Effect<ActionInvocationRecord, ActionInvocationPersistenceError>;
  readonly flushSuccess: (
    transaction: CoreTransaction,
    input: FlushActionSuccessInput,
  ) => Effect.Effect<void, ActionTransactionError>;
  readonly lockInvocation: (
    transaction: CoreTransaction,
    invocationId: string,
  ) => Effect.Effect<ActionInvocationRecord, ActionInvocationPersistenceError>;
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

const persistenceFailure = (reason: string, cause?: unknown) => {
  const failure = new ActionInvocationPersistenceError({
    code: 'action_invocation_persistence_failed',
    reason,
  });
  if (cause !== undefined) {
    invocationPersistenceFailureCauses.set(failure, cause);
  }
  return failure;
};

/** Internal bridge used by the runtime to log a sanitized invocation failure's full cause. */
export const getActionInvocationPersistenceFailureCause = (
  failure: ActionInvocationPersistenceError,
): unknown | undefined => invocationPersistenceFailureCauses.get(failure);

const transactionFailureCauses = new WeakMap<ActionTransactionError, unknown>();

const transactionFailure = (reason: string, cause?: unknown) => {
  const failure = new ActionTransactionError({
    code: 'action_transaction_failed',
    reason,
  });
  if (cause !== undefined) {
    transactionFailureCauses.set(failure, cause);
  }
  return failure;
};

/** Internal bridge used by the runtime to log a sanitized persistence failure's full cause. */
export const getActionTransactionFailureCause = (
  failure: ActionTransactionError,
): unknown | undefined => transactionFailureCauses.get(failure);

export const makeActionRepository = (): ActionRepositoryService => {
  const createOrResolveInvocation: ActionRepositoryService['createOrResolveInvocation'] = (
    executor,
    input,
  ) =>
    Effect.tryPromise({
      catch: (cause) =>
        persistenceFailure('Unable to create or resolve the Action invocation', cause),
      try: async () => {
        const inserted = await executor
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
          .returning(invocationSelection);

        const [created] = inserted;
        if (created !== undefined) {
          return created;
        }

        if (input.idempotencyKey === undefined) {
          throw new Error('A non-idempotent invocation insert unexpectedly conflicted');
        }

        const existing = await executor
          .select(invocationSelection)
          .from(actionInvocations)
          .where(
            and(
              eq(actionInvocations.tenantId, input.principal.tenantId),
              eq(actionInvocations.actionKey, input.actionKey),
              eq(actionInvocations.principalId, input.principal.principalId),
              eq(actionInvocations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);

        const [resolved] = existing;
        if (resolved === undefined) {
          throw new Error('The conflicting Action invocation could not be resolved');
        }
        return resolved;
      },
    });

  const lockInvocation: ActionRepositoryService['lockInvocation'] = (transaction, invocationId) =>
    Effect.tryPromise({
      catch: (cause) => persistenceFailure('Unable to lock the Action invocation', cause),
      try: async () => {
        const rows = await transaction
          .select(invocationSelection)
          .from(actionInvocations)
          .where(eq(actionInvocations.actionInvocationId, invocationId))
          .for('update')
          .limit(1);
        const [invocation] = rows;
        if (invocation === undefined) {
          throw new Error('The Action invocation no longer exists');
        }
        return invocation;
      },
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
    Effect.tryPromise({
      catch: (cause) =>
        persistenceFailure('Unable to transition the Action invocation to running', cause),
      try: async () => {
        const transitioned = await executor
          .update(actionInvocations)
          .set({ status: 'running' })
          .where(
            and(
              eq(actionInvocations.actionInvocationId, invocationId),
              inArray(actionInvocations.status, ['received', 'running']),
              isNull(actionInvocations.completedAt),
            ),
          )
          .returning(invocationSelection);
        const [invocation] = transitioned;
        if (invocation !== undefined) {
          return invocation;
        }
        const current = await executor
          .select(invocationSelection)
          .from(actionInvocations)
          .where(eq(actionInvocations.actionInvocationId, invocationId))
          .limit(1);
        const [resolved] = current;
        if (resolved === undefined) {
          throw new Error('The Action invocation no longer exists');
        }
        return resolved;
      },
    });

  const flushSuccess: ActionRepositoryService['flushSuccess'] = (transaction, input) =>
    Effect.tryPromise({
      catch: (cause) => transactionFailure('Unable to persist successful Action evidence', cause),
      try: async () => {
        await transaction.insert(auditEvents).values({
          actionInvocationId: input.actionInvocationId,
          auditProfile: input.auditProfile,
          authBindingId: input.principal.authBindingId,
          authContextRef: input.principal.authContextRef,
          authMethod: input.principal.authMethod,
          eventType: 'action.executed',
          evidenceJson: {
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
        });

        if (input.evidence.dataAccessEvents.length > 0) {
          await transaction.insert(dataAccessEvents).values(
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
          );
        }

        if (input.evidence.domainEvents.length > 0) {
          // The tenant row is the existing, typed per-tenant serialization
          // anchor. Holding this lock until commit ensures sequence allocation
          // order cannot overtake commit order for one tenant's event stream.
          const lockedTenant = await transaction
            .select({ tenantId: tenants.tenantId })
            .from(tenants)
            .where(eq(tenants.tenantId, input.principal.tenantId))
            .for('update')
            .limit(1);
          if (lockedTenant.length !== 1) {
            throw new Error('The Domain Event tenant does not exist');
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
          await transaction.insert(domainEvents).values(persistedDomainEvents);
        }

        if (input.evidence.outboxMessages.length > 0) {
          await transaction.insert(outboxMessages).values(
            input.evidence.outboxMessages.map((collected) => {
              const persistedDomainEvent = persistedDomainEvents[collected.domainEventIndex];
              if (persistedDomainEvent === undefined) {
                throw new Error('An Outbox Message has no persisted Domain Event');
              }
              return {
                domainEventId: persistedDomainEvent.domainEventId,
                payloadJson: collected.message.payloadJson,
                producerModuleKey: collected.message.producerModuleKey,
                tenantId: input.principal.tenantId,
                topic: collected.message.topic,
              };
            }),
          );
        }

        const succeeded = await transaction
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
          .returning({ actionInvocationId: actionInvocations.actionInvocationId });

        if (succeeded.length !== 1) {
          throw new Error('The Action invocation could not be marked succeeded');
        }
      },
    });

  return Object.freeze({
    createOrResolveInvocation,
    flushSuccess,
    lockInvocation,
    resolveInvocation,
    transitionInvocationToRunning,
  });
};

export class ActionRepository extends Context.Service<ActionRepository, ActionRepositoryService>()(
  '@app/core-runtime/actions/repository/ActionRepository',
) {}

export const ActionRepositoryLive = Layer.succeed(ActionRepository, makeActionRepository());
