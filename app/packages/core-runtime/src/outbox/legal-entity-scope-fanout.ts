import { and, asc, eq, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlError } from 'effect/unstable/sql/SqlError';
import { CoreDatabase } from '../db/client.ts';
import { legalEntities } from '../db/schema.ts';
import { ScopedRoutineInvocationError } from '../db/scoped-routine-error.ts';
import { scopedRoutineInvokerFromTransaction } from '../db/scoped-routine.ts';
import type { ScopedRoutineInvoker } from '../db/scoped-routine.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import type { OutboxWorkerHandlerContext } from './definition.ts';
import { isVerifiedOutboxWorkerHandlerContext } from './definition.ts';
import { OutboxWorkerLegalEntityScopeError } from './legal-entity-scope-error.ts';
import { outboxWorkerCompletionPublisherFor, persistOutboxWorkerCompletion } from './completion-publication.ts';
import type { OutboxWorkerCompletionPublisher } from './completion-publication.ts';

export { OutboxWorkerLegalEntityScopeError } from './legal-entity-scope-error.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface OutboxWorkerLegalEntityScope {
  readonly completionPublisher: OutboxWorkerCompletionPublisher;
  readonly legalEntityId: string;
  readonly routineInvoker: ScopedRoutineInvoker;
  readonly tenantId: string;
}

export interface OutboxWorkerLegalEntityScopeRecord {
  readonly legalEntityId: string;
  readonly status: string;
  readonly tenantId: string;
}

export interface OutboxWorkerLegalEntityScopeBackend {
  readonly list: (
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<readonly OutboxWorkerLegalEntityScopeRecord[], OutboxWorkerLegalEntityScopeError>;
  readonly run: <OwnerError, OwnerRequirements>(
    context: OutboxWorkerHandlerContext,
    legalEntityId: string,
    observe: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<void, OwnerError, OwnerRequirements>,
  ) => Effect.Effect<void, OwnerError | OutboxWorkerLegalEntityScopeError, OwnerRequirements>;
}

export interface OutboxWorkerLegalEntityScopeFanoutService {
  readonly forEachScope: <OwnerError, OwnerRequirements>(
    context: OutboxWorkerHandlerContext,
    observe: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<void, OwnerError, OwnerRequirements>,
  ) => Effect.Effect<void, OwnerError | OutboxWorkerLegalEntityScopeError, OwnerRequirements>;
}

export class OutboxWorkerLegalEntityScopeFanout extends Context.Service<
  OutboxWorkerLegalEntityScopeFanout,
  OutboxWorkerLegalEntityScopeFanoutService
>()('@app/core-runtime/outbox/legal-entity-scope-fanout/OutboxWorkerLegalEntityScopeFanout') {}

const invalid = () =>
  new OutboxWorkerLegalEntityScopeError({
    code: 'outbox_worker_scope_context_invalid',
    reason: 'Legal-entity fan-out requires a verified Outbox Worker claim',
    retryable: false,
  });

const empty = () =>
  new OutboxWorkerLegalEntityScopeError({
    code: 'outbox_worker_scope_empty',
    reason: 'No legal-entity scope can be verified for this Tenant',
    retryable: true,
  });

const unavailable = (cause?: unknown) => {
  const failure = new OutboxWorkerLegalEntityScopeError({
    code: 'outbox_worker_scope_unavailable',
    reason: 'Legal-entity worker scope is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: false,
      enumerable: false,
      value: cause,
      writable: false,
    });
  }
  return failure;
};

const legalEntityStatuses = ['active', 'archived', 'suspended'] as const;

const classifyScopeIds = (
  records: readonly OutboxWorkerLegalEntityScopeRecord[],
  tenantId: string,
): Effect.Effect<readonly string[], OutboxWorkerLegalEntityScopeError> => {
  if (
    !uuidPattern.test(tenantId) ||
    records.some(
      (record) =>
        !uuidPattern.test(record.tenantId) ||
        !uuidPattern.test(record.legalEntityId) ||
        record.tenantId !== tenantId ||
        !legalEntityStatuses.some((status) => status === record.status),
    ) ||
    new Set(records.map(({ legalEntityId }) => legalEntityId)).size !== records.length
  ) {
    return Effect.fail(unavailable());
  }
  const legalEntityIds = records.map(({ legalEntityId }) => legalEntityId).toSorted();
  return legalEntityIds.length === 0 ? Effect.fail(empty()) : Effect.succeed(Object.freeze(legalEntityIds));
};

export const makeOutboxWorkerLegalEntityScopeFanout = (
  backend: OutboxWorkerLegalEntityScopeBackend,
): OutboxWorkerLegalEntityScopeFanoutService => ({
  forEachScope: (context, observe) => {
    if (!isVerifiedOutboxWorkerHandlerContext(context) || !uuidPattern.test(context.tenantId)) {
      return Effect.fail(invalid());
    }
    return backend.list(context).pipe(
      Effect.flatMap((records) => classifyScopeIds(records, context.tenantId)),
      Effect.flatMap((legalEntityIds) =>
        Effect.forEach(legalEntityIds, (legalEntityId) => backend.run(context, legalEntityId, observe), {
          concurrency: 1,
          discard: true,
        }),
      ),
      Effect.withSpan('OutboxWorker.legalEntityScopeFanout'),
    );
  },
});

interface ScopeSettingRow extends Record<string, unknown> {
  readonly legal_entity_id: string;
  readonly tenant_id: string;
}

const inactiveInvokerError = (routine: Parameters<ScopedRoutineInvoker['invoke']>[0]): ScopedRoutineInvocationError =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_scope_missing',
    constraint: Option.none(),
    ownerModuleKey: routine.ownerModuleKey,
    postgresCode: Option.none(),
    reason: 'The verified worker legal-entity scope lifetime has ended',
    routineKey: routine.routineKey,
  });

const ownerScope = (
  transaction: CoreTransaction,
  context: OutboxWorkerHandlerContext,
  tenantId: string,
  legalEntityId: string,
): Readonly<{
  close: () => void;
  scope: OutboxWorkerLegalEntityScope;
}> => {
  let active = true;
  const delegate = scopedRoutineInvokerFromTransaction(
    (statement) => transaction.execute<Record<string, never>>(statement, 'objects'),
    { legalEntityId, tenantId },
  );
  const invoke: ScopedRoutineInvoker['invoke'] = (routine, values) =>
    active ? delegate.invoke(routine, values) : Effect.fail(inactiveInvokerError(routine));
  return Object.freeze({
    close: () => {
      active = false;
    },
    scope: Object.freeze({
      completionPublisher: outboxWorkerCompletionPublisherFor({
        context,
        legalEntityId,
        persist: persistOutboxWorkerCompletion(transaction),
      }),
      legalEntityId,
      routineInvoker: Object.freeze({ invoke }),
      tenantId,
    }),
  });
};

export const makePostgresOutboxWorkerLegalEntityScopeBackend = (database: {
  readonly executor: CoreDatabaseExecutor;
}): OutboxWorkerLegalEntityScopeBackend => ({
  list: (context) =>
    database.executor
      .select({
        legalEntityId: legalEntities.legalEntityId,
        status: legalEntities.status,
        tenantId: legalEntities.tenantId,
      })
      .from(legalEntities)
      .where(eq(legalEntities.tenantId, context.tenantId))
      .orderBy(asc(legalEntities.legalEntityId))
      .pipe(Effect.mapError(unavailable)),
  run: <OwnerError, OwnerRequirements>(
    context: OutboxWorkerHandlerContext,
    legalEntityId: string,
    observe: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<void, OwnerError, OwnerRequirements>,
  ): Effect.Effect<void, OwnerError | OutboxWorkerLegalEntityScopeError, OwnerRequirements> => {
    const transaction = database.executor.transaction(
      Effect.fn('OutboxWorkerLegalEntityScopeFanout.transaction')(function* runLegalEntityScopeTransaction(
        scopedTransaction: CoreTransaction,
      ) {
        const settings = yield* scopedTransaction
          .execute<ScopeSettingRow>(
            sql`
                select
                  set_config('ontos.tenant_id', ${context.tenantId}, true) as tenant_id,
                  set_config('ontos.legal_entity_id', ${legalEntityId}, true) as legal_entity_id
              `,
            'objects',
          )
          .pipe(Effect.mapError(unavailable));
        const [setting] = settings;
        const [current] = yield* scopedTransaction
          .select({
            legalEntityId: legalEntities.legalEntityId,
            status: legalEntities.status,
          })
          .from(legalEntities)
          .where(and(eq(legalEntities.tenantId, context.tenantId), eq(legalEntities.legalEntityId, legalEntityId)))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (
          setting?.tenant_id !== context.tenantId ||
          setting.legal_entity_id !== legalEntityId ||
          current?.legalEntityId !== legalEntityId ||
          !legalEntityStatuses.some((status) => status === current.status)
        ) {
          return yield* unavailable();
        }
        const owned = ownerScope(scopedTransaction, context, context.tenantId, legalEntityId);
        return yield* observe(owned.scope).pipe(Effect.ensuring(Effect.sync(owned.close)));
      }),
    );
    return transaction.pipe(
      Effect.mapError((failure) => (Schema.is(SqlError)(failure) ? unavailable(failure) : failure)),
    );
  },
});

export const OutboxWorkerLegalEntityScopeFanoutLive = Layer.effect(
  OutboxWorkerLegalEntityScopeFanout,
  CoreDatabase.pipe(
    Effect.map((database) =>
      makeOutboxWorkerLegalEntityScopeFanout(makePostgresOutboxWorkerLegalEntityScopeBackend(database)),
    ),
  ),
);
