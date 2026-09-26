import { NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Deferred, Effect, Fiber, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations, domainEvents } from '../../src/db/schema.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotService,
} from '../../src/search/worker-snapshot.ts';
import {
  makeCoreSearchWorkerSnapshot,
  makePostgresCoreSearchSnapshotBackend,
} from '../../src/search/worker-snapshot.ts';
import { makeTestDatabaseFromClient, makeTestPgClient, makeTestPgSession } from '../support/database.ts';

const readLegalEntitySettings = (executor: CoreSearchSnapshotReadExecutor, eventId: string) =>
  executor
    .select({
      isolation: sql<string>`current_setting('transaction_isolation')`,
      legalEntity: sql<string>`current_setting('ontos.legal_entity_id')`,
      readOnly: sql<string>`current_setting('transaction_read_only')`,
      tenant: sql<string>`current_setting('ontos.tenant_id')`,
    })
    .from(domainEvents)
    .where(eq(domainEvents.domainEventId, eventId));

const readTenantMaxVersion = (executor: CoreSearchSnapshotReadExecutor, tenantId: string) =>
  executor
    .select({
      version: sql<string>`max(${domainEvents.tenantSequenceNo})::text`,
    })
    .from(domainEvents)
    .where(eq(domainEvents.tenantId, tenantId));

const readSnapshotPosition = (source: CoreSearchWorkerSnapshotService, context: OutboxWorkerHandlerContext) =>
  source.read(context, (snapshot) =>
    Effect.succeed({
      eventWatermark: snapshot.eventWatermark,
      generation: snapshot.projectionVersion,
    }),
  );

const insertPendingEvent = (
  client: PgClient.PgClient,
  pendingEventId: string,
  tenantId: string,
  pendingSubjectId: string,
) =>
  client.unsafe(
    `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id) values ($1, $2, 'party.registry', 'party.registry.party-updated.v1', 'party.registry', 'party.registry.party', $3)`,
    [pendingEventId, tenantId, pendingSubjectId],
  );

const workerSnapshotProgram = Effect.gen(function* workerSnapshotIntegration() {
  const crypto = yield* Crypto.Crypto;
  const connections = yield* loadDatabaseConnectionPair();
  const [tenantId, legalEntityId, eventId] = yield* Effect.all(
    [crypto.randomUUIDv4, crypto.randomUUIDv4, crypto.randomUUIDv4],
    { concurrency: 'unbounded' },
  );
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const applicationName = `core-search-snapshot-${tenantId}`;
  const runtime = yield* makeTestPgClient(connections.runtime.connectionString, { applicationName });
  const source = makeCoreSearchWorkerSnapshot(
    makePostgresCoreSearchSnapshotBackend({
      executor: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    }),
  );
  const insertEvent = (id: string) =>
    Effect.gen(function* insertDomainEvent() {
      const subjectId = yield* crypto.randomUUIDv4;
      const rows = yield* admin.unsafe<{ tenant_sequence_no: string }>(
        `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id) values ($1, $2, 'party.registry', 'party.registry.party-updated.v1', 'party.registry', 'party.registry.party', $3) returning tenant_sequence_no::text`,
        [id, tenantId, subjectId],
      );
      const row = Option.getOrThrow(Option.fromNullishOr(rows[0]));
      expect(row).toBeDefined();
      return row.tenant_sequence_no;
    });
  const cleanup = Effect.gen(function* cleanupWorkerSnapshot() {
    yield* admin.unsafe('delete from core.search_projection_generations where tenant_id = $1', [tenantId]);
    yield* admin.unsafe('delete from core.domain_events where tenant_id = $1', [tenantId]);
    yield* admin.unsafe('delete from core.legal_entities where tenant_id = $1', [tenantId]);
    yield* admin.unsafe('delete from core.tenants where tenant_id = $1', [tenantId]);
  }).pipe(Effect.orDie);

  yield* Effect.addFinalizer(() => cleanup);
  const exercise = Effect.gen(function* exerciseWorkerSnapshots() {
    yield* admin.unsafe(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Snapshot tenant', 'active', 'en')`,
      [tenantId, `snapshot-${tenantId}`],
    );
    yield* admin.unsafe(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1::uuid, $2, 'Snapshot LE', 'CZ', $1::uuid::text, 'active')`,
      [legalEntityId, tenantId],
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
    const readEventSettings = (executor: CoreSearchSnapshotReadExecutor) => readLegalEntitySettings(executor, eventId);
    const readMaxTenantVersion = (executor: CoreSearchSnapshotReadExecutor) => readTenantMaxVersion(executor, tenantId);
    let newerVersion = '';
    const result = yield* source.read(context, (snapshot) =>
      Effect.gen(function* inspectSnapshot() {
        expect(snapshot.projectionVersion).toBe('1');
        expect(snapshot.eventWatermark).toBe(originalVersion);
        const settings = yield* snapshot.forLegalEntity(legalEntityId, readEventSettings);
        const newerEventId = yield* crypto.randomUUIDv4;
        newerVersion = yield* insertEvent(newerEventId);
        const rows = yield* snapshot.tenant(readMaxTenantVersion);
        return { settings, version: rows[0]?.version };
      }),
    );
    expect(result.settings).toEqual([
      {
        isolation: 'repeatable read',
        legalEntity: legalEntityId,
        readOnly: 'off',
        tenant: tenantId,
      },
    ]);
    expect(result.version).toBe(originalVersion);
    expect(yield* source.read(context, (snapshot) => Effect.succeed(snapshot.projectionVersion))).toBe('2');
    const nextSnapshot = yield* readSnapshotPosition(source, context);
    expect(nextSnapshot).toEqual({
      eventWatermark: newerVersion,
      generation: '3',
    });

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
          : admin.unsafe('select pg_sleep(0.01)').pipe(
              Effect.andThen(
                admin.unsafe<{ count: number }>(
                  `select count(*)::int as count from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`,
                  [applicationName],
                ),
              ),
              Effect.map((activity) => activity[0]?.count === 1),
            ),
    );
    expect(waiting, 'second snapshot must wait on first generation before retrying').toBe(true);
    const latestEventId = yield* crypto.randomUUIDv4;
    const latestEvent = yield* insertEvent(latestEventId);
    yield* Deferred.succeed(release, null);
    const [firstResult, secondResult] = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
      concurrency: 'unbounded',
    });
    expect(firstResult).toEqual({
      eventWatermark: newerVersion,
      generation: '4',
    });
    expect(secondResult).toEqual({
      eventWatermark: latestEvent,
      generation: '5',
    });

    // Business transactions may commit event allocation sequences out of order.
    // Both snapshots below have the same event max but must get new generations.
    const [pendingEventId, pendingSubjectId, higherEventId] = yield* Effect.all(
      [crypto.randomUUIDv4, crypto.randomUUIDv4, crypto.randomUUIDv4],
      { concurrency: 'unbounded' },
    );
    const lateCommitSnapshot = (pending: PgClient.PgClient) =>
      Effect.gen(function* lateCommitSnapshotEffect() {
        yield* pending.unsafe('begin');
        yield* insertPendingEvent(pending, pendingEventId, tenantId, pendingSubjectId);
        const higherEvent = yield* insertEvent(higherEventId);
        const beforeLateCommit = yield* readSnapshotPosition(source, context);
        yield* pending.unsafe('commit');
        const afterLateCommit = yield* readSnapshotPosition(source, context);
        expect(beforeLateCommit).toEqual({
          eventWatermark: higherEvent,
          generation: '6',
        });
        expect(afterLateCommit).toEqual({
          eventWatermark: higherEvent,
          generation: '7',
        });
      });
    yield* Effect.scoped(
      Effect.acquireUseRelease(makeTestPgSession(connections.admin.connectionString), lateCommitSnapshot, (pending) =>
        pending.unsafe('rollback').pipe(Effect.orDie),
      ),
    );
  });
  yield* exercise;
});

it.layer(NodeServices.layer, { excludeTestServices: true })('worker snapshots', (suite) => {
  suite.effect(
    'worker projection uses independent generations and one repeatable snapshot across tenant and Legal Entity scopes',
    () => workerSnapshotProgram,
  );
});
