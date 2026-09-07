import { NodeServices } from '@effect/platform-node';
import assert from 'node:assert/strict';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, ManagedRuntime } from 'effect';
import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations, domainEvents } from '../../src/db/schema.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeCoreSearchWorkerSnapshot,
  makePostgresCoreSearchSnapshotBackend,
} from '../../src/search/worker-snapshot.ts';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotService,
} from '../../src/search/worker-snapshot.ts';

const databaseEffect = <Value>(operation: () => PromiseLike<Value>) => Effect.tryPromise(operation);
const workerSnapshotRuntime = ManagedRuntime.make(NodeServices.layer);
const queryPromise = <Row extends QueryResultRow = QueryResultRow>(
  client: Pool | PoolClient,
  statement: string,
  values?: unknown[],
): PromiseLike<QueryResult<Row>> => client.query<Row>(statement, values);
const connectPromise = (pool: Pool): PromiseLike<PoolClient> => pool.connect();
const endPromise = (pool: Pool): PromiseLike<void> => pool.end();

const readLegalEntitySettings = (executor: CoreSearchSnapshotReadExecutor, eventId: string) =>
  databaseEffect(() =>
    executor
      .select({
        isolation: sql<string>`current_setting('transaction_isolation')`,
        legalEntity: sql<string>`current_setting('ontos.legal_entity_id')`,
        readOnly: sql<string>`current_setting('transaction_read_only')`,
        tenant: sql<string>`current_setting('ontos.tenant_id')`,
      })
      .from(domainEvents)
      .where(eq(domainEvents.domainEventId, eventId)),
  );

const readTenantMaxVersion = (executor: CoreSearchSnapshotReadExecutor, tenantId: string) =>
  databaseEffect(() =>
    executor
      .select({ version: sql<string>`max(${domainEvents.tenantSequenceNo})::text` })
      .from(domainEvents)
      .where(eq(domainEvents.tenantId, tenantId)),
  );

const readSnapshotPosition = (
  source: CoreSearchWorkerSnapshotService,
  context: OutboxWorkerHandlerContext,
) =>
  source.read(context, (snapshot) =>
    Effect.succeed({
      eventWatermark: snapshot.eventWatermark,
      generation: snapshot.projectionVersion,
    }),
  );

const beginTransaction = (client: PoolClient) =>
  databaseEffect(() => queryPromise(client, 'begin'));

const commitTransaction = (client: PoolClient) =>
  databaseEffect(() => queryPromise(client, 'commit'));

const insertPendingEvent = (
  client: PoolClient,
  pendingEventId: string,
  tenantId: string,
  pendingSubjectId: string,
) =>
  databaseEffect(() =>
    queryPromise(
      client,
      `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id) values ($1, $2, 'party.registry', 'party.registry.party-updated.v1', 'party.registry', 'party.registry.party', $3)`,
      [pendingEventId, tenantId, pendingSubjectId],
    ),
  );

const workerSnapshotProgram = Effect.gen(function* workerSnapshotIntegration() {
  const crypto = yield* Crypto.Crypto;
  const connections = yield* loadDatabaseConnectionPair();
  const [tenantId, legalEntityId, eventId] = yield* Effect.all(
    [crypto.randomUUIDv4, crypto.randomUUIDv4, crypto.randomUUIDv4],
    { concurrency: 'unbounded' },
  );
  const admin = new Pool({ connectionString: connections.admin.connectionString });
  const applicationName = `core-search-snapshot-${tenantId}`;
  const runtimePool = new Pool({
    application_name: applicationName,
    connectionString: connections.runtime.connectionString,
  });
  const source = makeCoreSearchWorkerSnapshot(
    makePostgresCoreSearchSnapshotBackend({
      executor: drizzle({ client: runtimePool, relations: coreRelations }),
    }),
  );
  const insertEvent = (id: string) =>
    Effect.gen(function* insertDomainEvent() {
      const subjectId = yield* crypto.randomUUIDv4;
      const result = yield* databaseEffect(() =>
        queryPromise<{ tenant_sequence_no: string }>(
          admin,
          `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id) values ($1, $2, 'party.registry', 'party.registry.party-updated.v1', 'party.registry', 'party.registry.party', $3) returning tenant_sequence_no::text`,
          [id, tenantId, subjectId],
        ),
      );
      const [row] = result.rows;
      assert.ok(row);
      return row.tenant_sequence_no;
    });
  const cleanup = Effect.gen(function* cleanupWorkerSnapshot() {
    yield* databaseEffect(() =>
      queryPromise(admin, 'delete from core.search_projection_generations where tenant_id = $1', [
        tenantId,
      ]),
    );
    yield* databaseEffect(() =>
      queryPromise(admin, 'delete from core.domain_events where tenant_id = $1', [tenantId]),
    );
    yield* databaseEffect(() =>
      queryPromise(admin, 'delete from core.legal_entities where tenant_id = $1', [tenantId]),
    );
    yield* databaseEffect(() =>
      queryPromise(admin, 'delete from core.tenants where tenant_id = $1', [tenantId]),
    );
    yield* Effect.all(
      [databaseEffect(() => endPromise(admin)), databaseEffect(() => endPromise(runtimePool))],
      { concurrency: 'unbounded' },
    );
  }).pipe(Effect.orDie);

  yield* Effect.gen(function* exerciseWorkerSnapshots() {
    yield* databaseEffect(() =>
      queryPromise(
        admin,
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Snapshot tenant', 'active', 'en')`,
        [tenantId, `snapshot-${tenantId}`],
      ),
    );
    yield* databaseEffect(() =>
      queryPromise(
        admin,
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1::uuid, $2, 'Snapshot LE', 'CZ', $1::uuid::text, 'active')`,
        [legalEntityId, tenantId],
      ),
    );
    const originalVersion = yield* insertEvent(eventId);
    const [claimId, deliveryId, messageId] = yield* Effect.all(
      [crypto.randomUUIDv4, crypto.randomUUIDv4, crypto.randomUUIDv4],
      { concurrency: 'unbounded' },
    );
    const context = attestOutboxWorkerHandlerContext({
      attemptNumber: 1,
      claimId,
      deliveryId,
      domainEventId: eventId,
      messageId,
      producerModuleKey: 'party.registry',
      tenantId,
      tenantSequenceNo: BigInt(originalVersion),
      topic: 'party.registry.party-updated.v1',
      workerKey: 'party.registry.project-party-updated-to-search',
    });
    const readEventSettings = (executor: CoreSearchSnapshotReadExecutor) =>
      readLegalEntitySettings(executor, eventId);
    const readMaxTenantVersion = (executor: CoreSearchSnapshotReadExecutor) =>
      readTenantMaxVersion(executor, tenantId);
    let newerVersion = '';
    const result = yield* source.read(context, (snapshot) =>
      Effect.gen(function* inspectSnapshot() {
        assert.equal(snapshot.projectionVersion, '1');
        assert.equal(snapshot.eventWatermark, originalVersion);
        const settings = yield* snapshot.forLegalEntity(legalEntityId, readEventSettings);
        const newerEventId = yield* crypto.randomUUIDv4;
        newerVersion = yield* insertEvent(newerEventId);
        const rows = yield* snapshot.tenant(readMaxTenantVersion);
        return { settings, version: rows[0]?.version };
      }),
    );
    assert.deepEqual(result.settings, [
      {
        isolation: 'repeatable read',
        legalEntity: legalEntityId,
        readOnly: 'off',
        tenant: tenantId,
      },
    ]);
    assert.equal(result.version, originalVersion);
    assert.equal(
      yield* source.read(context, (snapshot) => Effect.succeed(snapshot.projectionVersion)),
      '2',
    );
    const nextSnapshot = yield* readSnapshotPosition(source, context);
    assert.deepEqual(nextSnapshot, { eventWatermark: newerVersion, generation: '3' });

    // A second snapshot starts while the first owns the generation row. It must
    // retry its old RR snapshot after the first commits, never publish stale data
    // with a greater generation. No Party business transaction shares this lock.
    const [started, release] = yield* Effect.all([Deferred.make<null>(), Deferred.make<null>()], {
      concurrency: 'unbounded',
    });
    const first = yield* source
      .read(context, (snapshot) =>
        Effect.gen(function* firstSnapshot() {
          yield* Deferred.succeed(started, null);
          yield* Deferred.await(release);
          return {
            eventWatermark: snapshot.eventWatermark,
            generation: snapshot.projectionVersion,
          };
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* readSnapshotPosition(source, context).pipe(Effect.forkChild);

    const waiting = yield* Effect.reduce(
      Array.from({ length: 100 }),
      () => false,
      (blocked) =>
        blocked
          ? Effect.succeed(true)
          : databaseEffect(() => queryPromise(admin, 'select pg_sleep(0.01)')).pipe(
              Effect.andThen(
                databaseEffect(() =>
                  queryPromise<{ count: number }>(
                    admin,
                    `select count(*)::int as count from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`,
                    [applicationName],
                  ),
                ),
              ),
              Effect.map((activity) => activity.rows[0]?.count === 1),
            ),
    );
    assert.equal(waiting, true, 'second snapshot must wait on first generation before retrying');
    const latestEventId = yield* crypto.randomUUIDv4;
    const latestEvent = yield* insertEvent(latestEventId);
    yield* Deferred.succeed(release, null);
    const [firstResult, secondResult] = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
      concurrency: 'unbounded',
    });
    assert.deepEqual(firstResult, { eventWatermark: newerVersion, generation: '4' });
    assert.deepEqual(secondResult, { eventWatermark: latestEvent, generation: '5' });

    // Business transactions may commit event allocation sequences out of order.
    // Both snapshots below have the same event max but must get new generations.
    const [pendingEventId, pendingSubjectId, higherEventId] = yield* Effect.all(
      [crypto.randomUUIDv4, crypto.randomUUIDv4, crypto.randomUUIDv4],
      { concurrency: 'unbounded' },
    );
    const lateCommitSnapshot = (pending: PoolClient) =>
      Effect.gen(function* lateCommitSnapshotEffect() {
        yield* beginTransaction(pending);
        yield* insertPendingEvent(pending, pendingEventId, tenantId, pendingSubjectId);
        const higherEvent = yield* insertEvent(higherEventId);
        const beforeLateCommit = yield* readSnapshotPosition(source, context);
        yield* commitTransaction(pending);
        const afterLateCommit = yield* readSnapshotPosition(source, context);
        assert.deepEqual(beforeLateCommit, {
          eventWatermark: higherEvent,
          generation: '6',
        });
        assert.deepEqual(afterLateCommit, {
          eventWatermark: higherEvent,
          generation: '7',
        });
      });
    yield* Effect.acquireUseRelease(
      databaseEffect(() => connectPromise(admin)),
      lateCommitSnapshot,
      (pending) =>
        databaseEffect(() => queryPromise(pending, 'rollback')).pipe(
          Effect.orDie,
          Effect.ensuring(Effect.sync(() => pending.release())),
        ),
    );
  }).pipe(Effect.ensuring(cleanup));
});

test('worker projection uses independent generations and one repeatable snapshot across tenant and Legal Entity scopes', (_context, done) => {
  workerSnapshotRuntime.runCallback(workerSnapshotProgram, {
    onExit: Exit.match({
      onFailure: (cause) => done(Cause.squash(cause)),
      onSuccess: () => done(),
    }),
  });
});

test.after(workerSnapshotRuntime.dispose.bind(workerSnapshotRuntime));
