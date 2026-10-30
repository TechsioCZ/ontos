import { fileURLToPath } from 'node:url';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pg-core/effect/session';
import { Config, ConfigProvider, Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { CORE_MIGRATION_MANIFEST } from '../../packages/core-runtime/scripts/migration-equivalence.mts';
import { makeTestDatabaseFromClient, makeTestPgSession } from '../../packages/core-runtime/tests/support/database.ts';
import { PARTY_MIGRATION_MANIFESTS } from '../../verticals/party-registry/scripts/migration-equivalence.mts';
import {
  policyMismatches,
  rolePrivilegeMismatches,
  routineMismatches,
} from '../../verticals/party-registry/scripts/database-role-contract.mts';
import { PARTY_REGISTRY_WORKER_PARTY_TABLES } from '../../verticals/party-registry/src/db/database-grants.ts';
import { CONTACTS_TABLES } from '../../verticals/party-registry/src/db/engagement-schema.ts';
import { PARTY_TABLES, partyRelations } from '../../verticals/party-registry/src/db/schema.ts';
import {
  convergeMigrationHistories,
  loadConvergentMigrationSource,
  migrationDatabaseLayer,
} from '../migration-convergence.mts';
import {
  MIGRATION_EQUIVALENCES,
  MIGRATION_MERGES,
  MigrationLedgerRowSchema,
  MigrationEquivalenceError,
  planEquivalentMigrations,
} from '../migration-equivalence.mts';
import {
  explicitEntries,
  grantExplicitRole,
  grantSharedRuntimeRole,
  legacySharedEntries,
} from '../postgres/runtime-role-bootstrap.mts';

const manifests = [CORE_MIGRATION_MANIFEST, ...PARTY_MIGRATION_MANIFESTS];

/** Explicit disposable loopback endpoint only; never consult workspace configuration or dotenv. */
const testUrl = Config.schema(Schema.Redacted(Schema.String), 'MIGRATION_EQUIVALENCE_TEST_DATABASE_URL');
const fixtureMarker = Config.schema(Schema.Literals(['owned-postgres18']), 'MIGRATION_EQUIVALENCE_TEST_SANDBOX');

const journalSnapshot = (client: PgClient.PgClient, table: string) =>
  client.unsafe<{ row: string }>(
    `select to_jsonb(journal)::text as row from drizzle."${table}" as journal order by id`,
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer), { excludeTestServices: true })((suite) => {
  suite.effect(
    'PostgreSQL18 proves fresh/main/demo convergence, real locking, immutable rows, reruns and exact Party security',
    () =>
      Effect.scoped(
        Effect.gen(function* disposablePostgresProof() {
          yield* fixtureMarker;
          const baseUrl = new URL(Redacted.value(yield* testUrl));
          expect(['localhost', '127.0.0.1']).toContain(baseUrl.hostname);
          expect(baseUrl.pathname).toBe('/postgres');
          const admin = yield* makeTestPgSession(baseUrl.href);
          const sources = yield* Effect.forEach(manifests, (manifest) => loadConvergentMigrationSource(manifest), {
            concurrency: 1,
          });
          // Cluster-local fixture roles only. This cluster belongs to the invoking disposable test job.
          for (const role of [
            'ontos_runtime',
            'shell_gateway_issuer',
            'party_registry_runtime',
            'party_registry_worker',
          ]) {
            const existing = yield* admin.unsafe('select 1 from pg_catalog.pg_roles where rolname = $1', [role]);
            if (existing.length === 0) {
              yield* admin.unsafe(`create role "${role}" login noinherit nosuperuser nobypassrls`);
            }
          }
          const securitySnapshots: (readonly { readonly fingerprint: string }[])[] = [];
          for (const lineage of ['fresh', 'main', 'demo'] as const) {
            yield* Effect.scoped(
              Effect.gen(function* lineageProof() {
                const crypto = yield* Crypto.Crypto;
                const database = `ontos_equivalence_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
                yield* Effect.acquireRelease(admin.unsafe(`create database "${database}"`), () =>
                  admin.unsafe(`drop database "${database}" with (force)`).pipe(Effect.orDie),
                );
                const url = new URL(baseUrl);
                url.pathname = `/${database}`;
                const session = yield* makeTestPgSession(url.href);
                const observer = yield* makeTestPgSession(url.href);
                const db = yield* makeWithDefaults().pipe(Effect.provideService(PgClient.PgClient, session));
                const originals = new Map<string, readonly { row: string }[]>();
                if (lineage !== 'fresh') {
                  for (const source of sources) {
                    const plan = yield* planEquivalentMigrations(source.manifest.history, source.migrations, []);
                    const mainAliases = new Set<string>(
                      MIGRATION_EQUIVALENCES.filter((pair) => pair.history === source.manifest.history).map(
                        (pair) => pair.main,
                      ),
                    );
                    const seeded =
                      lineage === 'demo'
                        ? source.migrations.filter(
                            (migration) =>
                              !mainAliases.has(migration.name) &&
                              migration.name !== MIGRATION_MERGES[source.manifest.history],
                          )
                        : plan.migrations.filter(
                            (migration) =>
                              migration.name !== MIGRATION_MERGES[source.manifest.history] &&
                              (source.manifest.history !== 'core' || migration.name < '20261021'),
                          );
                    yield* migrate(seeded, db._.session, {
                      migrationsFolder: source.manifest.folder,
                      migrationsSchema: 'drizzle',
                      migrationsTable: `__drizzle_migrations_${source.manifest.history}`,
                    });
                    const table = `__drizzle_migrations_${source.manifest.history}`;
                    originals.set(table, yield* journalSnapshot(session, table));
                  }
                }
                let lockObserved = false;
                const lockProbe = Effect.gen(function* inspectTransactionLock() {
                  const rows = yield* observer.unsafe<{ acquired: boolean }>(
                    "select pg_try_advisory_lock(hashtext('ontos.exact-migration-equivalence'), 1) as acquired",
                  );
                  expect(rows).toEqual([{ acquired: false }]);
                  lockObserved = true;
                });
                yield* convergeMigrationHistories(
                  sources,
                  lockProbe.pipe(
                    Effect.mapError(
                      () => new MigrationEquivalenceError({ history: 'core', reason: 'Disposable lock probe failed' }),
                    ),
                  ),
                ).pipe(Effect.provideService(PgClient.PgClient, session));
                expect(lockObserved).toBe(true);
                for (const [table, before] of originals) {
                  expect((yield* journalSnapshot(session, table)).slice(0, before.length)).toEqual(before);
                }
                yield* Schema.decodeUnknownEffect(Schema.Array(MigrationLedgerRowSchema))(
                  yield* db.execute(
                    sql`select id, name, hash, created_at from drizzle.__drizzle_migrations_core limit 1`,
                    'objects',
                  ),
                );
                const after = yield* Effect.forEach(
                  sources,
                  (source) => journalSnapshot(session, `__drizzle_migrations_${source.manifest.history}`),
                  { concurrency: 1 },
                );
                yield* convergeMigrationHistories(sources).pipe(Effect.provideService(PgClient.PgClient, session));
                const rerun = yield* Effect.forEach(
                  sources,
                  (source) => journalSnapshot(session, `__drizzle_migrations_${source.manifest.history}`),
                  { concurrency: 1 },
                );
                expect(rerun).toEqual(after);
                // A migration connection must inherit configured budgets, not impose new ceilings.
                yield* admin.unsafe(`alter role postgres in database "${database}" set statement_timeout = '45s'`);
                yield* admin.unsafe(`alter role postgres in database "${database}" set lock_timeout = '15s'`);
                yield* Effect.scoped(
                  Effect.gen(function* inheritedMigrationBudgets() {
                    const migrationClient = yield* PgClient.PgClient;
                    const budgets = yield* migrationClient.unsafe<{ lock_timeout: string; statement_timeout: string }>(
                      "select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout",
                    );
                    expect(budgets).toEqual([{ lock_timeout: '15s', statement_timeout: '45s' }]);
                  }).pipe(
                    Effect.provide(migrationDatabaseLayer('core').pipe(Layer.provide(Reactivity.layer))),
                    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DATABASE_ADMIN_URL: url.href }))),
                  ),
                );
                // Exercise the exact production CLI, including its native snapshot checks.
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                for (const owner of ['core', 'party']) {
                  const code = yield* spawner.exitCode(
                    ChildProcess.make(
                      process.execPath,
                      [fileURLToPath(new URL('../migration-convergence-cli.mts', import.meta.url)), owner],
                      {
                        cwd: fileURLToPath(new URL('../../', import.meta.url)),
                        env: { DATABASE_ADMIN_URL: url.href, DATABASE_URL: url.href },
                        extendEnv: true,
                        stderr: 'inherit',
                        stdout: 'inherit',
                      },
                    ),
                  );
                  expect(code).toBe(0);
                }
                const afterCli = yield* Effect.forEach(
                  sources,
                  (source) => journalSnapshot(session, `__drizzle_migrations_${source.manifest.history}`),
                  { concurrency: 1 },
                );
                expect(afterCli).toEqual(after);

                // Apply the existing production grant compiler, not a test reimplementation.
                for (const entry of legacySharedEntries) {
                  yield* grantSharedRuntimeRole(session, entry);
                }
                for (const entry of explicitEntries.filter((item) =>
                  ['party_registry_request', 'party_registry_worker', 'shell_gateway_issuer'].includes(
                    item.identity.id,
                  ),
                )) {
                  yield* grantExplicitRole(session, entry);
                }
                const partyDb = yield* makeTestDatabaseFromClient(session, partyRelations);
                expect(
                  yield* policyMismatches(partyDb, 'party', PARTY_TABLES, PARTY_REGISTRY_WORKER_PARTY_TABLES),
                ).toEqual([]);
                expect(
                  yield* policyMismatches(partyDb, 'contacts', CONTACTS_TABLES, PARTY_REGISTRY_WORKER_PARTY_TABLES),
                ).toEqual([]);
                expect(yield* rolePrivilegeMismatches(partyDb, 'party')).toEqual([]);
                expect(yield* rolePrivilegeMismatches(partyDb, 'contacts')).toEqual([]);
                expect(yield* routineMismatches(partyDb, 'contacts', baseUrl.username)).toEqual([]);
                const fingerprint = yield* session.unsafe<{ fingerprint: string }>(`
            select md5(string_agg(row_to_json(p)::text, '' order by schemaname, tablename, policyname)) as fingerprint
            from pg_catalog.pg_policies as p where schemaname in ('core', 'party', 'contacts')`);
                securitySnapshots.push(fingerprint);
              }),
            );
          }
          expect(securitySnapshots).toHaveLength(3);
          expect(securitySnapshots[1]).toEqual(securitySnapshots[0]);
          expect(securitySnapshots[2]).toEqual(securitySnapshots[0]);
        }),
      ),
  );
});
