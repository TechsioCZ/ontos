import { verifyPrivacyLegacyRuntimePair } from './legacy-completion-runtime-pair.ts';
import { PrivacyLegacyConnections, PrivacyLegacyConnectionsLive } from './legacy-completion-connections.ts';
import type { PrivacyLegacyConnectionPair } from './legacy-completion-connections.ts';
import { configureDatabasePool } from '@app/core-runtime';
import type {
  LegacyCompletionNativeBinding,
  LegacyCompletionOwnerLease,
  LegacyCompletionOwnerResult,
  LegacyCompletionOwnerVerifier,
  LegacyCompletionPublicationObservation,
} from '@app/core-runtime/legacy-completion-publication';
import {
  LegacyCompletionPublicationError,
  LegacyCompletionTransactionIdSchema,
  sameLegacyCompletionDatabase,
} from '@app/core-runtime/legacy-completion-publication';
import { PgClient } from '@effect/sql-pg';
import { gt, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { isSqlError } from 'effect/sql/SqlError';

import { ownerExecutionOutcomes, privacyMeasureDispatches, privacyRelations } from '../src/database/schema.ts';
import { assessPrivacyLegacyCompletionEvidence } from '../src/admin/privacy-legacy-completion-evidence.ts';

const evidenceBatchSize = 1000;
const pageContinuation = (ids: readonly string[]) =>
  ids.length < evidenceBatchSize ? Option.none<Option.Option<string>>() : Option.some(Option.fromNullishOr(ids.at(-1)));
const Text = Schema.String.check(Schema.isMinLength(1));
const NativeIdentitySchema = Schema.Struct({
  administrative: Schema.Literal(true),
  databaseName: Text,
  databaseOid: Text,
  databaseUser: Text,
  isolation: Schema.Literal('read committed'),
  observedAt: Schema.DateTimeUtcFromString,
  runtimeRoleOid: Text,
  runtimeSafe: Schema.Literal(true),
  runtimeUser: Text,
  systemIdentifier: Text,
  transactionId: LegacyCompletionTransactionIdSchema,
});
const unavailable = (cause?: unknown) =>
  new LegacyCompletionPublicationError({ cause, reason: 'Privacy legacy completion evidence is unavailable' });

const PrivacyLegacyClientLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* makeOperatorClient() {
    const connections = yield* PrivacyLegacyConnections;
    const configuration = yield* configureDatabasePool(Redacted.make(connections.admin.connectionString)).pipe(
      Effect.mapError(unavailable),
    );
    return yield* PgClient.make({ ...configuration, maxConnections: 1 }).pipe(Effect.mapError(unavailable));
  }),
).pipe(Layer.provideMerge(PrivacyLegacyConnectionsLive), Layer.provide(Reactivity.layer));

type PrivacyExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof privacyRelations>>>;
type PrivacyTransaction = Parameters<Parameters<PrivacyExecutor['transaction']>[0]>[0];
class PrivacyLegacyDatabase extends Context.Service<
  PrivacyLegacyDatabase,
  {
    readonly connections: PrivacyLegacyConnectionPair;
    readonly executor: PrivacyExecutor;
    readonly runtimeClient: PgClient.PgClient;
  }
>()('@app/privacy/scripts/legacy-completion-publication/PrivacyLegacyDatabase') {}
const PrivacyLegacyDatabaseLive = Layer.effect(
  PrivacyLegacyDatabase,
  Effect.gen(function* makeOperatorDatabase() {
    const connections = yield* PrivacyLegacyConnections;
    const executor = yield* makeWithDefaults({ relations: privacyRelations });
    const runtimeConfiguration = yield* configureDatabasePool(Redacted.make(connections.runtime.connectionString)).pipe(
      Effect.mapError(unavailable),
    );
    const runtimeClient = yield* PgClient.make({ ...runtimeConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    return { connections, executor, runtimeClient };
  }),
).pipe(Layer.provide(PrivacyLegacyClientLive), Layer.provide(Reactivity.layer));

const observeNativeBinding = Effect.fn('PrivacyLegacyCompletion.observeNativeBinding')(function* observeNativeBinding(
  transaction: PrivacyTransaction,
  connections: PrivacyLegacyConnectionPair,
): Effect.fn.Return<LegacyCompletionNativeBinding, LegacyCompletionPublicationError> {
  // System catalogs establish actual native identity and complete RLS visibility. A configured
  // URL or a table-owner role alone cannot establish a complete whole-environment observation.
  const nativeRows = yield* transaction
    .execute(
      sql`
    select current_database() as "databaseName", d.oid::text as "databaseOid",
      current_user as "databaseUser", current_setting('transaction_isolation') as isolation,
      to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt",
      pg_current_xact_id()::text as "transactionId",
      (select system_identifier::text from pg_control_system()) as "systemIdentifier",
      runtime.rolname as "runtimeUser", runtime.oid::text as "runtimeRoleOid",
      (administrator.rolsuper or administrator.rolbypassrls) as administrative,
      (not runtime.rolsuper and not runtime.rolbypassrls and runtime.rolname <> current_user) as "runtimeSafe"
    from pg_database d
    join pg_roles administrator on administrator.rolname=current_user
    join pg_roles runtime on runtime.rolname=${connections.runtime.user}
    where d.datname=current_database()
  `,
      'objects',
    )
    .pipe(Effect.mapError(unavailable));
  const identity = yield* Schema.decodeUnknownEffect(Schema.Array(NativeIdentitySchema))(nativeRows).pipe(
    Effect.mapError(unavailable),
  );
  const native = identity.at(0);
  if (identity.length !== 1 || native === undefined || native.databaseName !== connections.admin.database) {
    return yield* unavailable();
  }
  return Object.freeze({
    databaseName: native.databaseName,
    databaseOid: native.databaseOid,
    databaseUser: native.databaseUser,
    observedAt: native.observedAt,
    runtimeRoleOid: native.runtimeRoleOid,
    runtimeTarget: Object.freeze({
      databaseName: connections.runtime.database,
      host: connections.runtime.host,
      port: connections.runtime.port,
      user: connections.runtime.user,
    }),
    runtimeUser: native.runtimeUser,
    systemIdentifier: native.systemIdentifier,
    transactionId: native.transactionId,
  });
});

const makeOwnerLease = (
  transaction: PrivacyTransaction,
  binding: LegacyCompletionNativeBinding,
  dispatches: readonly unknown[],
  outcomes: readonly unknown[],
) => {
  const state = { active: true, used: false };
  const lease: LegacyCompletionOwnerLease = Object.freeze({
    binding,
    verify: Effect.fn('PrivacyLegacyCompletion.verify')(function* verify(
      observation: LegacyCompletionPublicationObservation,
    ) {
      if (!state.active || state.used || !sameLegacyCompletionDatabase(binding, observation.binding)) {
        return yield* unavailable();
      }
      state.used = true;
      // A saved lease cannot observe a new transaction after its private lock scope ends.
      const [current] = yield* transaction
        .execute<{ readonly transactionId: string }>(
          sql`select pg_current_xact_id()::text as "transactionId"`,
          'objects',
        )
        .pipe(Effect.mapError(unavailable));
      if (!state.active || current?.transactionId !== binding.transactionId) {
        return yield* unavailable();
      }
      const status = observation.complete
        ? yield* assessPrivacyLegacyCompletionEvidence(observation.messages, dispatches, outcomes)
        : 'UNKNOWN';
      const result: LegacyCompletionOwnerResult = {
        binding: observation.binding,
        evidenceReference: observation.evidenceReference,
        status,
      };
      return Object.freeze(result);
    }),
  });
  return {
    lease,
    release: Effect.sync(() => {
      state.active = false;
    }),
  };
};

const withLockedOwnerEvidence = Effect.fn('PrivacyLegacyCompletion.withLockedOwnerEvidence')(
  function* withLockedOwnerEvidence<Value, Failure, Requirements>(
    transaction: PrivacyTransaction,
    connections: PrivacyLegacyConnectionPair,
    runtimeClient: PgClient.PgClient,
    runWithLease: (lease: LegacyCompletionOwnerLease) => Effect.Effect<Value, Failure, Requirements>,
  ): Effect.fn.Return<Value, Failure | LegacyCompletionPublicationError, Requirements> {
    const binding = yield* observeNativeBinding(transaction, connections);
    yield* verifyPrivacyLegacyRuntimePair(transaction, runtimeClient, binding);
    // SHARE fences old writers too. Privacy retains both locks until the nested Core transition
    // transaction settles. There is no typed query-builder equivalent for table-level SHARE locks.
    yield* transaction
      .execute(sql`lock table ${privacyMeasureDispatches}, ${ownerExecutionOutcomes} in share mode`, 'objects')
      .pipe(Effect.mapError(unavailable));
    // Both scans share one native connection; explicit sequential execution bounds its resources.
    const [dispatches, outcomes] = yield* Effect.all(
      [
        // SHARE locks make the complete population stable across READ COMMITTED pages.
        // Only individual SQL results are bounded, never immutable lifetime history.
        Stream.paginate(Option.none<string>(), (cursor) =>
          transaction
            .select({
              handoffRecord: privacyMeasureDispatches.handoffRecord,
              idempotencyKey: privacyMeasureDispatches.idempotencyKey,
              legalEntityId: privacyMeasureDispatches.legalEntityId,
              measureId: privacyMeasureDispatches.measureId,
              status: privacyMeasureDispatches.status,
              tenantId: privacyMeasureDispatches.tenantId,
            })
            .from(privacyMeasureDispatches)
            .where(Option.isNone(cursor) ? undefined : gt(privacyMeasureDispatches.measureId, cursor.value))
            .orderBy(privacyMeasureDispatches.measureId)
            .limit(evidenceBatchSize)
            .pipe(Effect.map((page) => [page, pageContinuation(page.map((row) => row.measureId))] as const)),
        ).pipe(Stream.runCollect),
        Stream.paginate(Option.none<string>(), (cursor) =>
          transaction
            .select({
              attempt: ownerExecutionOutcomes.attempt,
              legalEntityId: ownerExecutionOutcomes.legalEntityId,
              measureId: ownerExecutionOutcomes.measureId,
              outcomeId: ownerExecutionOutcomes.outcomeId,
              outcomeRecord: ownerExecutionOutcomes.outcomeRecord,
              status: ownerExecutionOutcomes.status,
              tenantId: ownerExecutionOutcomes.tenantId,
            })
            .from(ownerExecutionOutcomes)
            .where(Option.isNone(cursor) ? undefined : gt(ownerExecutionOutcomes.outcomeId, cursor.value))
            .orderBy(ownerExecutionOutcomes.outcomeId)
            .limit(evidenceBatchSize)
            .pipe(Effect.map((page) => [page, pageContinuation(page.map((row) => row.outcomeId))] as const)),
        ).pipe(Stream.runCollect),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    const owner = makeOwnerLease(transaction, binding, dispatches, outcomes);
    return yield* runWithLease(owner.lease).pipe(Effect.ensuring(owner.release));
  },
);

const withOperatorLease = Effect.fn('PrivacyLegacyCompletion.withOperatorLease')(function* withOperatorLease<
  Value,
  Failure,
  Requirements,
>(
  runWithLease: (lease: LegacyCompletionOwnerLease) => Effect.Effect<Value, Failure, Requirements>,
): Effect.fn.Return<Value, Failure | LegacyCompletionPublicationError, Requirements | Scope.Scope> {
  const resources = Context.get(yield* Layer.build(PrivacyLegacyDatabaseLive), PrivacyLegacyDatabase);
  return yield* resources.executor
    .transaction((transaction) =>
      withLockedOwnerEvidence(transaction, resources.connections, resources.runtimeClient, runWithLease),
    )
    .pipe(
      // Native SQL settlement failures alone become this operator's declared unavailable error;
      // unknown defects and interruption keep their original channels.
      Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(unavailable(defect)) : Effect.die(defect))),
      Effect.catchIf(isSqlError, (cause) => Effect.fail(unavailable(cause))),
    );
});

/** Deployment-only operator gateway. Each owner retains its own native pool and transaction. */
export const privacyLegacyCompletionOwner: LegacyCompletionOwnerVerifier = Object.freeze({
  producerModuleKey: 'privacy.core',
  topic: 'privacy.measure.dispatched',
  withLease: <Value, Failure, Requirements>(
    runWithLease: (lease: LegacyCompletionOwnerLease) => Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure | LegacyCompletionPublicationError, Requirements> =>
    Effect.scoped(withOperatorLease(runWithLease)),
});
