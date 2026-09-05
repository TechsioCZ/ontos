/* oxlint-disable sonarjs/no-built-in-override, sonarjs/no-nested-functions, typescript/return-await */
// @effect-diagnostics asyncFunction:off
import { and, eq, sql } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import type { CoreTransaction } from '../db/types.ts';
import { CoreDatabase } from '../db/client.ts';
import { domainEvents, legalEntities, searchProjectionGenerations } from '../db/schema.ts';
import { CorePersistenceLive } from '../runtime-infrastructure.ts';
import { isVerifiedOutboxWorkerHandlerContext } from '../outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { CORE_SEARCH_INGESTION_REGISTRATIONS } from './ingestion.ts';
import { CoreSearchProjectionInvalid, CoreSearchProjectionUnavailable } from './projection.ts';

export interface CoreSearchSnapshotReadExecutor {
  readonly select: CoreTransaction['select'];
}

type SnapshotError = CoreSearchProjectionInvalid | CoreSearchProjectionUnavailable;

export interface CoreSearchWorkerSnapshotView {
  /** Diagnostic committed-event watermark, not a document version. */
  readonly eventWatermark: string;
  readonly forLegalEntity: <Value, Error>(
    legalEntityId: string,
    read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>,
  ) => Effect.Effect<Value, Error | SnapshotError>;
  readonly legalEntityIds: readonly string[];
  readonly projectionVersion: string;
  readonly tenant: <Value, Error>(
    read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>,
  ) => Effect.Effect<Value, Error | SnapshotError>;
  readonly tenantId: string;
}

export interface CoreSearchWorkerSnapshotService {
  readonly read: <Value, Error>(
    context: OutboxWorkerHandlerContext,
    read: (snapshot: CoreSearchWorkerSnapshotView) => Effect.Effect<Value, Error>,
  ) => Effect.Effect<Value, Error | SnapshotError>;
}

export class CoreSearchWorkerSnapshot extends Context.Service<
  CoreSearchWorkerSnapshot,
  CoreSearchWorkerSnapshotService
>()('@app/core-runtime/search/worker-snapshot/CoreSearchWorkerSnapshot') {}

const unavailable = () =>
  new CoreSearchProjectionUnavailable({
    code: 'core_search_projection_unavailable',
    reason: 'Core Search worker snapshot is temporarily unavailable',
  });
const invalid = () =>
  new CoreSearchProjectionInvalid({
    code: 'core_search_projection_invalid',
    reason: 'Core Search snapshot requires a registered verified worker claim',
  });

interface SnapshotScope {
  readonly eventWatermark: string;
  readonly legalEntityIds: readonly string[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}

interface OwnedSnapshotView {
  readonly close: () => void;
  readonly view: CoreSearchWorkerSnapshotView;
}

export interface CoreSearchSnapshotBackend {
  readonly run: <Value>(
    context: OutboxWorkerHandlerContext,
    use: (
      scope: SnapshotScope,
      executor: CoreSearchSnapshotReadExecutor,
      install: (legalEntityId?: string) => Promise<void>,
    ) => Promise<Value>,
  ) => Promise<Value>;
}

const viewForSnapshot = (
  scope: SnapshotScope,
  executor: CoreSearchSnapshotReadExecutor,
  install: (legalEntityId?: string) => Promise<void>,
): OwnedSnapshotView => {
  let active = true;
  let inUse = false;
  const scoped = <Value, Error>(
    legalEntityId: string | undefined,
    read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error | SnapshotError> =>
    Effect.suspend((): Effect.Effect<Value, Error | SnapshotError> => {
      if (
        !active ||
        inUse ||
        (legalEntityId !== undefined && !scope.legalEntityIds.includes(legalEntityId))
      ) {
        return Effect.fail(invalid());
      }
      inUse = true;
      return Effect.gen(function* readOwnedScope() {
        const exit = yield* Effect.exit(
          Effect.tryPromise({ catch: unavailable, try: async () => install(legalEntityId) }).pipe(
            Effect.flatMap(() => read(executor)),
          ),
        );
        yield* Effect.tryPromise({ catch: unavailable, try: async () => install() });
        return yield* Exit.isSuccess(exit)
          ? Effect.succeed(exit.value)
          : Effect.failCause(exit.cause);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inUse = false;
          }),
        ),
      );
    });
  const view = Object.freeze({
    ...scope,
    forLegalEntity: <Value, Error>(
      legalEntityId: string,
      read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>,
    ) => scoped(legalEntityId, read),
    tenant: <Value, Error>(
      read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>,
    ) => scoped(undefined, read),
  });
  return {
    close: () => {
      active = false;
    },
    view,
  };
};

export const makeCoreSearchWorkerSnapshot = (
  backend: CoreSearchSnapshotBackend,
): CoreSearchWorkerSnapshotService => ({
  read: <Value, Error>(
    context: OutboxWorkerHandlerContext,
    read: (snapshot: CoreSearchWorkerSnapshotView) => Effect.Effect<Value, Error>,
  ) => {
    if (
      !isVerifiedOutboxWorkerHandlerContext(context) ||
      !CORE_SEARCH_INGESTION_REGISTRATIONS.some(
        (registration) =>
          registration.producerModuleKey === context.producerModuleKey &&
          registration.topic === context.topic &&
          registration.workerKey === context.workerKey,
      )
    ) {
      return Effect.fail(invalid());
    }
    return Effect.tryPromise({
      catch: unavailable,
      try: async () =>
        backend.run(context, async (scope, executor, install) => {
          const snapshot = viewForSnapshot(scope, executor, install);
          return Effect.runPromiseExit(
            read(snapshot.view).pipe(Effect.ensuring(Effect.sync(snapshot.close))),
          );
        }),
    }).pipe(
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
      ),
      Effect.withSpan('CoreSearch.workerSnapshot', {
        attributes: {
          deliveryId: context.deliveryId,
          producerModuleKey: context.producerModuleKey,
          tenantId: context.tenantId,
          topic: context.topic,
          workerKey: context.workerKey,
        },
      }),
    );
  },
});

const serializationCode = Schema.Struct({ code: Schema.Literal('40001') });
const serializationFailure = Schema.is(
  Schema.Union([serializationCode, Schema.Struct({ cause: serializationCode })]),
);

/** Bounded retry is restricted to PostgreSQL snapshot serialization failures. */
export const retryCoreSearchSnapshot = async <Value>(run: () => Promise<Value>): Promise<Value> => {
  const attempt = async (count: number): Promise<Value> => {
    try {
      return await run();
    } catch (error) {
      if (count >= 3 || !serializationFailure(error)) {
        throw error;
      }
      return await attempt(count + 1);
    }
  };
  return attempt(0);
};

export const makePostgresCoreSearchSnapshotBackend = (
  database: (typeof CoreDatabase)['Service'],
): CoreSearchSnapshotBackend => ({
  run: async (context, use) =>
    retryCoreSearchSnapshot(async () =>
      database.executor.transaction(
        async (transaction) => {
          const install = async (legalEntityId?: string): Promise<void> => {
            const result = await transaction.execute<{
              legal_entity_id: string;
              tenant_id: string;
            }>(sql`
            select
              set_config('ontos.tenant_id', ${context.tenantId}, true) as tenant_id,
              set_config('ontos.legal_entity_id', ${legalEntityId ?? ''}, true) as legal_entity_id
          `);
            const [setting] = result.rows;
            if (
              setting?.tenant_id !== context.tenantId ||
              setting.legal_entity_id !== (legalEntityId ?? '')
            ) {
              throw unavailable();
            }
          };
          await install();
          // RR rejects a waiter whose snapshot predates the preceding generation commit.
          // Retrying the whole transaction makes increasing generations imply fresh snapshots,
          // even when business event sequences commit out of their allocation order.
          const [generation] = await transaction
            .insert(searchProjectionGenerations)
            .values({
              generation: 1n,
              sourceModuleKey: context.producerModuleKey,
              tenantId: context.tenantId,
            })
            .onConflictDoUpdate({
              set: {
                generation: sql`${searchProjectionGenerations.generation} + 1`,
                updatedAt: sql`now()`,
              },
              target: [
                searchProjectionGenerations.tenantId,
                searchProjectionGenerations.sourceModuleKey,
              ],
            })
            .returning({ version: searchProjectionGenerations.generation });
          if (generation === undefined) {
            throw unavailable();
          }
          const [watermark] = await transaction
            .select({ version: sql<string>`max(${domainEvents.tenantSequenceNo})::text` })
            .from(domainEvents)
            .where(eq(domainEvents.tenantId, context.tenantId));
          if (
            watermark?.version === null ||
            watermark?.version === undefined ||
            BigInt(watermark.version) < context.tenantSequenceNo
          ) {
            throw unavailable();
          }
          await transaction
            .update(searchProjectionGenerations)
            .set({
              eventWatermark: BigInt(watermark.version),
            })
            .where(
              and(
                eq(searchProjectionGenerations.tenantId, context.tenantId),
                eq(searchProjectionGenerations.sourceModuleKey, context.producerModuleKey),
              ),
            );
          const entities = await transaction
            .select({ legalEntityId: legalEntities.legalEntityId })
            .from(legalEntities)
            .where(eq(legalEntities.tenantId, context.tenantId));
          return await use(
            {
              eventWatermark: watermark.version,
              legalEntityIds: Object.freeze(entities.map(({ legalEntityId }) => legalEntityId)),
              projectionVersion: generation.version.toString(),
              tenantId: context.tenantId,
            },
            Object.freeze({ select: transaction.select.bind(transaction) }),
            install,
          );
        },
        { isolationLevel: 'repeatable read' },
      ),
    ),
});

export const CoreSearchWorkerSnapshotLive = Layer.effect(
  CoreSearchWorkerSnapshot,
  Effect.gen(function* makeCoreSearchWorkerSnapshotLive() {
    const database = yield* CoreDatabase;
    return makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
  }),
).pipe(Layer.provide(CorePersistenceLive));
