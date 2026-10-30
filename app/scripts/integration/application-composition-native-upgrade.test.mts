import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { applicationCompositionAuthority } from '../../packages/core-runtime/src/db/schema.ts';
import {
  LegacyCompletionPublication,
  LegacyCompletionTransactionIdSchema,
} from '../../packages/core-runtime/src/modules/legacy-completion-publication.ts';
import type {
  LegacyCompletionMessageEvidence,
  LegacyCompletionPublicationObservation,
} from '../../packages/core-runtime/src/modules/legacy-completion-publication.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../packages/core-runtime/src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import { runApplicationCompositionMigration } from '../application-composition-authority-publication.mts';

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const completionMigration = '20261019161320_outbox-composition-completion';
const resolutionMigration = '20261029194254_outbox-delivery-resolution';
const migrationRoot = new URL('../../packages/core-runtime/drizzle/', import.meta.url).pathname;
const isSettledMessage = (message: LegacyCompletionMessageEvidence) =>
  message.deliveries.every((delivery) => delivery.status === 'done');

const fixture = Effect.gen(function* baseCoreFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  const database = yield* makeCoreDatabase(isolated.connections.admin);
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: 'composition-base-schema-' });
  // These are the only Core migrations added by this PR. All remaining folders are the
  // origin/main Core schema, including the later trusted-scope migrations already present there.
  for (const name of yield* filesystem.readDirectory(migrationRoot)) {
    if (
      name === completionMigration ||
      name === resolutionMigration ||
      name === '20261019193926_retained-owner-change-history'
    ) {
      continue;
    }
    yield* filesystem.makeDirectory(path.join(directory, name));
    yield* filesystem.copyFile(
      path.join(migrationRoot, name, 'migration.sql'),
      path.join(directory, name, 'migration.sql'),
    );
  }
  yield* Effect.suspend(() =>
    migrate(database.executor, {
      migrationsFolder: directory,
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations_core',
    }),
  );
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([], 'base-composition-upgrade');
  yield* isolated.publishInitialComposition(snapshot);
  const observations: LegacyCompletionPublicationObservation[] = [];
  const [identity] = yield* database.executor.execute<{
    readonly databaseName: string;
    readonly databaseOid: string;
    readonly databaseUser: string;
    readonly runtimeRoleOid: string;
    readonly systemIdentifier: string;
  }>(
    sql`select current_database() as "databaseName", (select oid::text from pg_database where datname=current_database()) as "databaseOid",
    current_user as "databaseUser", (select oid::text from pg_roles where rolname=${isolated.connections.runtime.user}) as "runtimeRoleOid",
    (pg_control_system()).system_identifier::text as "systemIdentifier"`,
    'objects',
  );
  expect(identity).toBeDefined();
  if (identity === undefined) {
    return yield* Effect.die('Missing native test identity');
  }
  const runtimeTarget = {
    databaseName: isolated.connections.runtime.database,
    host: isolated.connections.runtime.host,
    port: isolated.connections.runtime.port,
    user: isolated.connections.runtime.user,
  };
  const ownerBinding = {
    ...identity,
    observedAt: yield* DateTime.now,
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
    transactionId: yield* Schema.decodeUnknownEffect(LegacyCompletionTransactionIdSchema)('native-test-owner'),
  };
  const owners = Layer.succeed(LegacyCompletionPublication, {
    owners: [
      {
        producerModuleKey: 'fixture.owner',
        topic: 'fixture.completed',
        withLease: (run) =>
          run({
            binding: ownerBinding,
            verify: (observation) =>
              Effect.sync(() => {
                observations.push(observation);
                expect(observation.complete).toBe(true);
                expect(observation.messages.every(isSettledMessage)).toBe(true);
                return {
                  binding: observation.binding,
                  evidenceReference: observation.evidenceReference,
                  status: 'VERIFIED_ABSENT',
                };
              }),
          }),
      },
    ],
    retainEvidence: () => Effect.void,
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
  });
  return { database, isolated, layer: Layer.merge(owners, Layer.succeed(CoreDatabase, database)), observations };
});

it.layer(services, { excludeTestServices: true })('legacy completion publication upgrade', (suite) => {
  suite.effect(
    'expands the exact base Core schema before verifying drain and seal, then runs the deferred full migration',
    () =>
      Effect.gen(function* upgradesBaseSchema() {
        const f = yield* fixture;
        const [before] = yield* f.database.executor.execute<{ readonly installed: boolean }>(
          sql`select exists(select 1 from information_schema.columns where table_schema='core' and table_name='outbox_messages' and column_name='completion_original_revision') as installed`,
          'objects',
        );
        expect(before?.installed).toBe(false);
        yield* runApplicationCompositionMigration(
          Effect.gen(function* deferredMigration() {
            expect((yield* f.database.executor.select().from(applicationCompositionAuthority))[0]?.phase).toBe(
              'sealed',
            );
            // The operator resolution ledger is part of the expansion, so it exists while the old release drains.
            const [ledger] = yield* f.database.executor.execute<{ readonly installed: boolean }>(
              sql`select to_regclass('core.outbox_delivery_resolutions') is not null as installed`,
              'objects',
            );
            expect(ledger?.installed).toBe(true);
            yield* f.isolated.migrateCoreSchema();
          }),
          Effect.void,
        ).pipe(Effect.provide(f.layer));
        expect((yield* f.database.executor.select().from(applicationCompositionAuthority))[0]?.phase).toBe('migrated');
        expect(f.observations).toHaveLength(2);
        const journal = yield* f.database.executor.execute<{ readonly count: number; readonly name: string }>(
          sql`select name, count(*)::int as count from drizzle.__drizzle_migrations_core
            where name in (${completionMigration}, ${resolutionMigration}) group by name order by name`,
          'objects',
        );
        expect(journal).toEqual([
          { count: 1, name: completionMigration },
          { count: 1, name: resolutionMigration },
        ]);
      }),
  );

  suite.effect('verifies every retained message and delivery beyond 10,000 without deleting evidence', () =>
    Effect.gen(function* retainedHistory() {
      const f = yield* fixture;
      yield* f.isolated.migrateCoreSchema();
      // Native infrastructure fixture: one artificial owner attests settled history. The real
      // Privacy owner protocol is separately integration-tested by its owning deployment.
      yield* f.database.executor.execute(
        sql`with tenant as (
        insert into core.tenants(name,slug,status,default_locale) values ('Retained history','retained-history','active','en') returning tenant_id
      ), events as (
        insert into core.domain_events(tenant_id,producer_module_key,subject_module_key,subject_resource_type,subject_resource_id,event_type,payload_json)
        select tenant_id,'fixture.owner','fixture.owner','fixture',tenant_id,'fixture.completed','{}'::jsonb from tenant cross join generate_series(1,10001) returning tenant_id,domain_event_id
      ), messages as (
        insert into core.outbox_messages(tenant_id,domain_event_id,producer_module_key,topic,payload_json,matched_at)
        select tenant_id,domain_event_id,'fixture.owner','fixture.completed','{}'::jsonb,clock_timestamp() from events returning tenant_id,outbox_message_id
      ) insert into core.outbox_deliveries(outbox_message_id,consumer_module_key,worker_key,status)
        select outbox_message_id,'fixture.consumer','fixture.worker','done' from messages`,
        'objects',
      );
      yield* runApplicationCompositionMigration(Effect.void, Effect.void).pipe(Effect.provide(f.layer));
      expect(f.observations).toHaveLength(2);
      for (const observation of f.observations) {
        expect(observation.messages).toHaveLength(10_001);
        expect(observation.messages.flatMap((message) => message.deliveries)).toHaveLength(10_001);
      }
      expect((yield* f.database.executor.select().from(applicationCompositionAuthority))[0]?.phase).toBe('migrated');
    }),
  );
});
