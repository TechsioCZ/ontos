/* oxlint-disable sonarjs/no-built-in-override -- Existing compatibility boundary; expires: 2026-12-31. */
import { and, eq, sql } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Option, Schema } from 'effect';
import { SqlError, isSqlError } from 'effect/unstable/sql/SqlError';

import type { DatabaseDriverFailure } from '../database/driver-failure.ts';
import { DatabaseTransactionFailure, decodeDatabaseDriverFailure } from '../database/driver-failure.ts';
import { CoreDatabase } from '../db/client.ts';
import { domainEvents, legalEntities, searchProjectionGenerations } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { isVerifiedOutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { CORE_SEARCH_INGESTION_REGISTRATIONS } from './ingestion.ts';
import type { CoreSearchProjectionUnavailableError } from './projection.ts';
import { CoreSearchProjectionInvalid, CoreSearchProjectionUnavailable } from './projection.ts';

export interface CoreSearchSnapshotReadExecutor {
  readonly select: CoreTransaction['select'];
}

type SnapshotError = CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableError;

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

const unavailable = (cause?: unknown) =>
  cause === undefined
    ? new CoreSearchProjectionUnavailable({
        code: 'core_search_projection_unavailable',
        reason: 'Core Search worker snapshot is temporarily unavailable',
      })
    : new CoreSearchProjectionUnavailable({
        cause,
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
  readonly run: <Value, Error>(
    context: OutboxWorkerHandlerContext,
    use: (
      scope: SnapshotScope,
      executor: CoreSearchSnapshotReadExecutor,
      install: (legalEntityId?: string) => Effect.Effect<void, CoreSearchProjectionUnavailableError>,
    ) => Effect.Effect<Value, Error>,
  ) => Effect.Effect<Value, Error | CoreSearchProjectionUnavailableError>;
}

const viewForSnapshot = (
  scope: SnapshotScope,
  executor: CoreSearchSnapshotReadExecutor,
  install: (legalEntityId?: string) => Effect.Effect<void, CoreSearchProjectionUnavailableError>,
): OwnedSnapshotView => {
  let active = true;
  let inUse = false;
  const scoped = <Value, Error>(
    legalEntityId: string | undefined,
    read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error | SnapshotError> =>
    Effect.suspend((): Effect.Effect<Value, Error | SnapshotError> => {
      if (!active || inUse || (legalEntityId !== undefined && !scope.legalEntityIds.includes(legalEntityId))) {
        return Effect.fail(invalid());
      }
      inUse = true;
      return Effect.gen(function* readOwnedScope() {
        const exit = yield* Effect.exit(install(legalEntityId).pipe(Effect.andThen(read(executor))));
        yield* install();
        return yield* Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
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
    tenant: <Value, Error>(read: (executor: CoreSearchSnapshotReadExecutor) => Effect.Effect<Value, Error>) =>
      scoped(undefined, read),
  });
  return {
    close: () => {
      active = false;
    },
    view,
  };
};

export const makeCoreSearchWorkerSnapshot = (backend: CoreSearchSnapshotBackend): CoreSearchWorkerSnapshotService => ({
  read: <Value, Error>(
    context: OutboxWorkerHandlerContext,
    read: (snapshot: CoreSearchWorkerSnapshotView) => Effect.Effect<Value, Error>,
  ) => {
    if (
      !isVerifiedOutboxWorkerHandlerContext(context) ||
      !/^[a-f0-9]{64}$/u.test(context.compositionRevision) ||
      !CORE_SEARCH_INGESTION_REGISTRATIONS.some(
        (registration) =>
          registration.producerModuleKey === context.producerModuleKey &&
          registration.topic === context.topic &&
          registration.workerKey === context.workerKey,
      )
    ) {
      return Effect.fail(invalid());
    }
    return backend
      .run(context, (scope, executor, install) => {
        const snapshot = viewForSnapshot(scope, executor, install);
        return read(snapshot.view).pipe(Effect.ensuring(Effect.sync(snapshot.close)));
      })
      .pipe(Effect.withSpan('CoreSearch.workerSnapshot'));
  },
});

type CoreSearchSnapshotDriverError = DatabaseDriverFailure | CoreSearchProjectionUnavailableError;

const snapshotDriverError = (cause: unknown): CoreSearchSnapshotDriverError =>
  Option.getOrElse(decodeDatabaseDriverFailure(cause), () => unavailable(cause));

const CoreSearchSnapshotGenerationConflictSchema = Schema.TaggedStruct('CoreSearchSnapshotGenerationConflict', {});
type CoreSearchGenerationClaimConflict = typeof CoreSearchSnapshotGenerationConflictSchema.Type;
export const CoreSearchSnapshotGenerationConflict = Schema.TaggedError<CoreSearchGenerationClaimConflict>()(
  'CoreSearchSnapshotGenerationConflict',
  {},
);

const serializationFailure = (cause: unknown): boolean =>
  Schema.is(CoreSearchSnapshotGenerationConflict)(cause) ||
  Option.exists(
    decodeDatabaseDriverFailure(cause),
    (failure) =>
      Schema.is(DatabaseTransactionFailure)(failure) && failure.kind === 'sqlstate' && failure.code.slice(2) === '001',
  );

/** Retry the complete coherent read only when PostgreSQL or the generation CAS reports contention. */
export const retryCoreSearchSnapshot = <Value, Error, Requirements>(
  run: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> =>
  run.pipe(
    Effect.retry({
      times: 3,
      while: serializationFailure,
    }),
  );

type CoreSearchSnapshotDatabase = Readonly<{ executor: CoreDatabaseExecutor }>;

export const makePostgresCoreSearchSnapshotBackend = (
  database: CoreSearchSnapshotDatabase,
): CoreSearchSnapshotBackend => {
  const run: CoreSearchSnapshotBackend['run'] = Effect.fn('CoreSearchSnapshotBackend.runPostgres')(
    function* runPostgresCoreSearchSnapshot<Value, Error>(
      context: OutboxWorkerHandlerContext,
      readSnapshot: (
        scope: SnapshotScope,
        executor: CoreSearchSnapshotReadExecutor,
        install: (legalEntityId?: string) => Effect.Effect<void, CoreSearchProjectionUnavailableError>,
      ) => Effect.Effect<Value, Error>,
    ) {
      const transactionProgram = Effect.fn('CoreSearchSnapshotBackend.transaction')(
        function* runCoreSearchSnapshotTransaction(transaction: CoreTransaction) {
          const installScope = Effect.fn('CoreSearchSnapshotBackend.installScope')(
            function* installCoreSearchSnapshotScope(legalEntityId?: string) {
              const result = yield* transaction
                .execute<{
                  legal_entity_id: string;
                  tenant_id: string;
                }>(
                  sql`
                select
                  set_config('ontos.tenant_id', ${context.tenantId}, true) as tenant_id,
                  set_config('ontos.legal_entity_id', ${legalEntityId ?? ''}, true) as legal_entity_id
              `,
                  'objects',
                )
                .pipe(Effect.mapError(snapshotDriverError));
              const [setting] = result;
              if (setting?.tenant_id !== context.tenantId || setting.legal_entity_id !== (legalEntityId ?? '')) {
                return yield* unavailable();
              }
              return yield* Effect.void;
            },
          );
          const install = (legalEntityId?: string) => installScope(legalEntityId).pipe(Effect.mapError(unavailable));

          yield* installScope();
          // This transaction only reads one coherent owner snapshot. Its proposed generation is
          // claimed afterwards under READ COMMITTED, where the release fence sees current authority.
          const [generation] = yield* transaction
            .select({ version: searchProjectionGenerations.generation })
            .from(searchProjectionGenerations)
            .where(
              and(
                eq(searchProjectionGenerations.tenantId, context.tenantId),
                eq(searchProjectionGenerations.sourceModuleKey, context.producerModuleKey),
              ),
            )
            .pipe(Effect.mapError(snapshotDriverError));
          const observedGeneration = generation?.version ?? 0n;
          const [watermark] = yield* transaction
            .select({
              version: sql<string>`max(${domainEvents.tenantSequenceNo})::text`,
            })
            .from(domainEvents)
            .where(eq(domainEvents.tenantId, context.tenantId))
            .pipe(Effect.mapError(snapshotDriverError));
          if (
            watermark?.version === null ||
            watermark?.version === undefined ||
            BigInt(watermark.version) < context.tenantSequenceNo
          ) {
            return yield* unavailable();
          }
          const entities = yield* transaction
            .select({ legalEntityId: legalEntities.legalEntityId })
            .from(legalEntities)
            .where(eq(legalEntities.tenantId, context.tenantId))
            .pipe(Effect.mapError(snapshotDriverError));
          const exit = yield* Effect.exit(
            readSnapshot(
              {
                eventWatermark: watermark.version,
                legalEntityIds: Object.freeze(entities.map(({ legalEntityId }) => legalEntityId)),
                projectionVersion: (observedGeneration + 1n).toString(),
                tenantId: context.tenantId,
              },
              Object.freeze({ select: transaction.select.bind(transaction) }),
              install,
            ),
          );
          return { exit, observedGeneration, watermark: BigInt(watermark.version) };
        },
      );
      const attempt = Effect.gen(function* readAndClaimSnapshot() {
        const observed = yield* database.executor.transaction(
          Effect.fn('CoreSearchSnapshotBackend.readOnlyTransaction')(function* readOnlySnapshotTransaction(
            transaction: CoreTransaction,
          ) {
            yield* transaction.setTransaction({
              accessMode: 'read only',
              isolationLevel: 'repeatable read',
            });
            return yield* transactionProgram(transaction);
          }),
        );
        if (Exit.isFailure(observed.exit)) {
          return observed.exit;
        }
        yield* database.executor.transaction(
          Effect.fn('CoreSearchSnapshotBackend.claimGeneration')(function* claimSnapshotGenerationTransaction(
            transaction: CoreTransaction,
          ) {
            yield* lockApplicationCompositionAuthority(transaction, context.compositionRevision, 'worker').pipe(
              Effect.mapError(snapshotDriverError),
            );
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${context.tenantId}, true)`, 'objects');
            // The advisory lock also serializes the first generation, before a row exists.
            const key = `ontos.search-generation:${context.tenantId}:${context.producerModuleKey}`;
            yield* transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`, 'objects');
            const [current] = yield* transaction
              .select({ version: searchProjectionGenerations.generation })
              .from(searchProjectionGenerations)
              .where(
                and(
                  eq(searchProjectionGenerations.tenantId, context.tenantId),
                  eq(searchProjectionGenerations.sourceModuleKey, context.producerModuleKey),
                ),
              )
              .for('update');
            if ((current?.version ?? 0n) !== observed.observedGeneration) {
              return yield* new CoreSearchSnapshotGenerationConflict();
            }
            yield* transaction
              .insert(searchProjectionGenerations)
              .values({
                eventWatermark: observed.watermark,
                generation: observed.observedGeneration + 1n,
                sourceModuleKey: context.producerModuleKey,
                tenantId: context.tenantId,
              })
              .onConflictDoUpdate({
                set: {
                  eventWatermark: observed.watermark,
                  generation: observed.observedGeneration + 1n,
                  updatedAt: sql`now()`,
                },
                target: [searchProjectionGenerations.tenantId, searchProjectionGenerations.sourceModuleKey],
              });
            return yield* Effect.void;
          }),
        );
        return observed.exit;
      }).pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.mapError((failure) => (Schema.is(SqlError)(failure) ? snapshotDriverError(failure) : failure)),
      );
      const snapshotExit = yield* retryCoreSearchSnapshot(attempt).pipe(Effect.mapError(unavailable));
      return yield* Exit.isSuccess(snapshotExit)
        ? Effect.succeed(snapshotExit.value)
        : Effect.failCause(snapshotExit.cause);
    },
  );

  return Object.freeze({ run });
};

export const CoreSearchWorkerSnapshotLive = Layer.effect(
  CoreSearchWorkerSnapshot,
  Effect.gen(function* makeCoreSearchWorkerSnapshotLive() {
    const database = yield* CoreDatabase;
    return makeCoreSearchWorkerSnapshot(makePostgresCoreSearchSnapshotBackend(database));
  }),
);
