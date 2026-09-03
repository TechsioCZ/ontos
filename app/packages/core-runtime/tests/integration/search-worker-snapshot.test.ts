// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
/* eslint-disable no-await-in-loop -- The bounded lock-observation loop intentionally proves sequential blocking before releasing the competing snapshot. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreDatabaseSchema, domainEvents } from '../../src/db/schema.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeCoreSearchWorkerSnapshot,
  makePostgresCoreSearchSnapshotBackend,
} from '../../src/search/worker-snapshot.ts';

test('worker projection uses independent generations and one repeatable snapshot across tenant and Legal Entity scopes', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const admin = new Pool({ connectionString: connections.admin.connectionString });
  const applicationName = `core-search-snapshot-${randomUUID()}`;
  const runtimePool = new Pool({
    application_name: applicationName,
    connectionString: connections.runtime.connectionString,
  });
  const tenantId = randomUUID();
  const legalEntityId = randomUUID();
  const eventId = randomUUID();
  const source = makeCoreSearchWorkerSnapshot(
    makePostgresCoreSearchSnapshotBackend({
      executor: drizzle({ client: runtimePool, schema: coreDatabaseSchema }),
    }),
  );
  const insertEvent = async (id: string) => {
    const result = await admin.query<{ tenant_sequence_no: string }>(
      `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id) values ($1, $2, 'party.registry', 'party.registry.party-updated.v1', 'party.registry', 'party.registry.party', $3) returning tenant_sequence_no::text`,
      [id, tenantId, randomUUID()],
    );
    const [row] = result.rows;
    assert.ok(row);
    return row.tenant_sequence_no;
  };
  try {
    await admin.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Snapshot tenant', 'active', 'en')`,
      [tenantId, `snapshot-${tenantId}`],
    );
    await admin.query(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Snapshot LE', 'CZ', $1, 'active')`,
      [legalEntityId, tenantId],
    );
    const originalVersion = await insertEvent(eventId);
    const context = attestOutboxWorkerHandlerContext({
      attemptNumber: 1,
      claimId: randomUUID(),
      deliveryId: randomUUID(),
      domainEventId: eventId,
      messageId: randomUUID(),
      producerModuleKey: 'party.registry',
      tenantId,
      tenantSequenceNo: BigInt(originalVersion),
      topic: 'party.registry.party-updated.v1',
      workerKey: 'party.registry.project-party-updated-to-search',
    });
    let newerVersion = '';
    const result = await Effect.runPromise(
      source.read(context, (snapshot) =>
        Effect.gen(function* inspectSnapshot() {
          assert.equal(snapshot.projectionVersion, '1');
          assert.equal(snapshot.eventWatermark, originalVersion);
          const settings = yield* snapshot.forLegalEntity(legalEntityId, (executor) =>
            Effect.tryPromise(() =>
              executor
                .select({
                  isolation: sql<string>`current_setting('transaction_isolation')`,
                  legalEntity: sql<string>`current_setting('ontos.legal_entity_id')`,
                  readOnly: sql<string>`current_setting('transaction_read_only')`,
                  tenant: sql<string>`current_setting('ontos.tenant_id')`,
                })
                .from(domainEvents)
                .where(eq(domainEvents.domainEventId, eventId)),
            ),
          );
          newerVersion = yield* Effect.tryPromise(() => insertEvent(randomUUID()));
          const rows = yield* snapshot.tenant((executor) =>
            Effect.tryPromise(() =>
              executor
                .select({ version: sql<string>`max(${domainEvents.tenantSequenceNo})::text` })
                .from(domainEvents)
                .where(eq(domainEvents.tenantId, tenantId)),
            ),
          );
          return { settings, version: rows[0]?.version };
        }),
      ),
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
      await Effect.runPromise(
        source.read(context, (snapshot) => Effect.succeed(snapshot.projectionVersion)),
      ),
      '2',
    );
    const nextSnapshot = await Effect.runPromise(
      source.read(context, (snapshot) =>
        Effect.succeed({
          eventWatermark: snapshot.eventWatermark,
          generation: snapshot.projectionVersion,
        }),
      ),
    );
    assert.deepEqual(nextSnapshot, { eventWatermark: newerVersion, generation: '3' });

    // A second snapshot starts while the first owns the generation row. It must
    // retry its old RR snapshot after the first commits, never publish stale data
    // with a greater generation. No Party business transaction shares this lock.
    const started = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    const first = Effect.runPromise(
      source.read(context, (snapshot) =>
        Effect.gen(function* firstSnapshot() {
          started.resolve(null);
          yield* Effect.promise(() => release.promise);
          return {
            eventWatermark: snapshot.eventWatermark,
            generation: snapshot.projectionVersion,
          };
        }),
      ),
    );
    await started.promise;
    const second = Effect.runPromise(
      source.read(context, (snapshot) =>
        Effect.succeed({
          eventWatermark: snapshot.eventWatermark,
          generation: snapshot.projectionVersion,
        }),
      ),
    );
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await admin.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`,
          [applicationName],
        );
        if (blocked.rows[0]?.count === 1) {
          waiting = true;
          break;
        }
        await setTimeout(10);
      }
      assert.equal(waiting, true, 'second snapshot must wait on first generation before retrying');
    } catch (error) {
      release.resolve(null);
      await Promise.allSettled([first, second]);
      throw error;
    }
    const latestEvent = await insertEvent(randomUUID());
    release.resolve(null);
    assert.deepEqual(await first, { eventWatermark: newerVersion, generation: '4' });
    assert.deepEqual(await second, { eventWatermark: latestEvent, generation: '5' });

    // Business transactions may commit event allocation sequences out of order.
    // Both snapshots below have the same event max but must get new generations.
    const pending = await admin.connect();
    try {
      await pending.query('begin');
      await pending.query(
        `insert into core.domain_events (domain_event_id, tenant_id, producer_module_key, event_type, subject_module_key, subject_resource_type, subject_resource_id) values ($1, $2, 'party.registry', 'party.registry.party-updated.v1', 'party.registry', 'party.registry.party', $3)`,
        [randomUUID(), tenantId, randomUUID()],
      );
      const higherEvent = await insertEvent(randomUUID());
      const beforeLateCommit = await Effect.runPromise(
        source.read(context, (snapshot) =>
          Effect.succeed({
            eventWatermark: snapshot.eventWatermark,
            generation: snapshot.projectionVersion,
          }),
        ),
      );
      await pending.query('commit');
      const afterLateCommit = await Effect.runPromise(
        source.read(context, (snapshot) =>
          Effect.succeed({
            eventWatermark: snapshot.eventWatermark,
            generation: snapshot.projectionVersion,
          }),
        ),
      );
      assert.deepEqual(beforeLateCommit, { eventWatermark: higherEvent, generation: '6' });
      assert.deepEqual(afterLateCommit, { eventWatermark: higherEvent, generation: '7' });
    } finally {
      await pending.query('rollback');
      pending.release();
    }
  } finally {
    await admin.query('delete from core.search_projection_generations where tenant_id = $1', [
      tenantId,
    ]);
    await admin.query('delete from core.domain_events where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.legal_entities where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.tenants where tenant_id = $1', [tenantId]);
    await Promise.all([admin.end(), runtimePool.end()]);
  }
});
