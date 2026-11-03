import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, FileSystem, Layer, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import type { SqlError } from 'effect/sql/SqlError';

import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '../../src/testing/gateway-scope-grant.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeTestPgClient, makeTestPgSession } from '../support/database.ts';
import {
  FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  FIXTURE_REQUEST_IDENTITY,
  FIXTURE_WORKER_IDENTITY,
} from '../support/database-identities.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const migrationPath = new URL('../../drizzle/20261103011231_search-evidence-shortlist/migration.sql', import.meta.url)
  .pathname;
const evidenceColumns = ['search_format_version', 'search_source_version', 'search_text_v1'] as const;
const code = (failure: SqlError) => Option.getOrUndefined(findPostgresFailure(failure))?.code;
const quoted = (identifier: string) => `"${identifier}"`;
const randomIdentifier = Effect.fn('SearchEvidenceSchema.randomIdentifier')(function* randomIdentifier(prefix: string) {
  const crypto = yield* Crypto.Crypto;
  return `${prefix}_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
});
const migrationSql = Effect.gen(function* readMigration() {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(migrationPath);
});
/** Drizzle's breakpoint is a plain SQL comment; execute each statement separately. */
const applyMigration = (client: PgClient.PgClient, sql: string) =>
  Effect.forEach(sql.split('--> statement-breakpoint'), (statement) => client.unsafe(statement), {
    concurrency: 1,
    discard: true,
  });

interface Fixture {
  readonly admin: PgClient.PgClient;
  readonly connectionString: string;
}

const withFixture = <Value, Failure, Requirements>(
  consume: (fixture: Fixture) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* fixture() {
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        // The empty-mode purpose gates unrelated composition controls; this suite only uses the
        // helper's owned database creation, migration bootstrap and cleanup.
        purpose: 'stabilization-1258-privacy-drain',
      });
      yield* isolated.migrateCoreSchema();
      const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString);
      return yield* consume({ admin, connectionString: isolated.connections.admin.connectionString });
    }),
  );

const withScratchDatabase = <Value, Failure, Requirements>(
  fixture: Fixture,
  prefix: string,
  consume: (client: PgClient.PgClient) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* scratchDatabase() {
      const name = yield* randomIdentifier(prefix);
      yield* Effect.acquireRelease(fixture.admin.unsafe(`create database ${quoted(name)}`), () =>
        fixture.admin.unsafe(`drop database if exists ${quoted(name)}`).pipe(Effect.orDie),
      );
      const url = new URL(fixture.connectionString);
      url.pathname = `/${name}`;
      // Close every scratch client before the outer database finalizer drops its database.
      return yield* Effect.scoped(
        Effect.gen(function* scratchClient() {
          const client = yield* makeTestPgClient(url.href);
          return yield* consume(client);
        }),
      );
    }),
  );

const oldSearchTable = (schema: string) =>
  `create table ${quoted(schema)}.search_index_entries (
    search_index_entry_id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    legal_entity_id uuid,
    source_module_key text not null,
    source_resource_type text not null,
    source_resource_id text not null,
    title text not null,
    body_text text not null,
    deleted boolean not null default false,
    facets_json jsonb not null default '{}'::jsonb,
    projection_version bigint not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;

/** Existing cohort roles run on one transaction connection; this adds no login or global reader. */
const requestRows = (session: PgClient.PgClient, assertion: string) =>
  session.withTransaction(
    Effect.gen(function* requestTransaction() {
      yield* session.unsafe(`set local session authorization ${FIXTURE_REQUEST_IDENTITY.role}`);
      yield* session.unsafe(
        `select established_tenant_id::text as tenant_id,
           coalesce(established_legal_entity_id::text, '') as legal_entity_id
         from trust.establish_gateway_scope($1::text)`,
        [assertion],
      );
      return yield* session.unsafe<{ readonly source_resource_id: string }>(
        `select source_resource_id from core.search_index_entries order by source_resource_id`,
      );
    }),
  );

const workerRows = (session: PgClient.PgClient, tenantId: string) =>
  session.withTransaction(
    Effect.gen(function* workerTransaction() {
      yield* session.unsafe(`set local session authorization ${FIXTURE_WORKER_IDENTITY.role}`);
      yield* session.unsafe(
        `select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', '', true)`,
        [tenantId],
      );
      return yield* session.unsafe<{ readonly source_resource_id: string }>(
        `select source_resource_id from core.search_index_entries order by source_resource_id`,
      );
    }),
  );

const wrongExtensionNamespace = (fixture: Fixture) =>
  Effect.gen(function* wrongExtensionNamespaceFixture() {
    const migration = yield* migrationSql;
    yield* withScratchDatabase(fixture, 'search_evidence_ext', (client) =>
      Effect.gen(function* wrongNamespaceDatabase() {
        yield* client.unsafe(`create schema other_ext`);
        yield* client.unsafe(`create extension pg_trgm with schema other_ext`);
        yield* client.unsafe(`create schema core`);
        yield* client.unsafe(oldSearchTable('core'));
        expect(code(yield* applyMigration(client, migration).pipe(Effect.flip))).toBe('55000');
        expect(
          yield* client.unsafe<{ readonly namespace: string }>(
            `select n.nspname as namespace from pg_extension e
             join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm'`,
          ),
        ).toEqual([{ namespace: 'other_ext' }]);
        expect(
          yield* client.unsafe(
            `select column_name from information_schema.columns
             where table_schema = 'core' and table_name = 'search_index_entries'
               and column_name = any($1::text[])`,
            [[...evidenceColumns]],
          ),
        ).toEqual([]);
        expect(
          yield* client.unsafe(
            `select indexname from pg_indexes where schemaname = 'core'
               and tablename = 'search_index_entries'
               and indexname = 'core_search_index_entries_text_v1_idx'`,
          ),
        ).toEqual([]);
      }),
    );
  });

const wrongOperatorClass = (fixture: Fixture) =>
  Effect.gen(function* wrongOperatorClassFixture() {
    const migration = yield* migrationSql;
    yield* withScratchDatabase(fixture, 'search_evidence_opc', (client) =>
      Effect.gen(function* wrongOpclassDatabase() {
        yield* client.unsafe(`create extension pg_trgm with schema public`);
        yield* client.unsafe(`alter operator class public.gin_trgm_ops using gin rename to gin_trgm_ops_moved`);
        yield* client.unsafe(`create schema core`);
        yield* client.unsafe(oldSearchTable('core'));
        expect(code(yield* applyMigration(client, migration).pipe(Effect.flip))).toBe('55000');
        expect(
          yield* client.unsafe<{ readonly namespace: string }>(
            `select n.nspname as namespace from pg_extension e
             join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm'`,
          ),
        ).toEqual([{ namespace: 'public' }]);
        expect(
          yield* client.unsafe(
            `select opcname from pg_opclass where opcname in ('gin_trgm_ops', 'gin_trgm_ops_moved')
             order by opcname`,
          ),
        ).toEqual([{ opcname: 'gin_trgm_ops_moved' }]);
        expect(
          yield* client.unsafe(
            `select column_name from information_schema.columns
             where table_schema = 'core' and table_name = 'search_index_entries'
               and column_name = any($1::text[])`,
            [[...evidenceColumns]],
          ),
        ).toEqual([]);
      }),
    );
  });

it.layer(Layer.merge(nativeServices, NodeCrypto.layer), { excludeTestServices: true })(
  'Core search evidence schema',
  (suite) => {
    suite.effect(
      'runs on PostgreSQL 18 with an operable public pg_trgm GIN text operator class and partial index',
      () =>
        withFixture(({ admin }) =>
          Effect.gen(function* pg18Extension() {
            const [server] = yield* admin.unsafe<{ readonly version: string; readonly version_num: number }>(
              `select version() as version, current_setting('server_version_num')::integer as version_num`,
            );
            expect(server?.version_num).toBeGreaterThanOrEqual(180_000);

            const [extension] = yield* admin.unsafe<{
              readonly extname: string;
              readonly namespace: string;
            }>(`select e.extname, n.nspname as namespace
              from pg_extension e join pg_namespace n on n.oid = e.extnamespace
              where e.extname = 'pg_trgm'`);
            expect(extension).toEqual({ extname: 'pg_trgm', namespace: 'public' });

            const [operation] = yield* admin.unsafe<{
              readonly similarity: boolean;
              readonly trigrams: string;
            }>(`select similarity('searchable', 'search') > 0.3 as similarity,
              array_to_string(show_trgm('searchable'), ',') as trigrams`);
            expect(operation?.similarity).toBe(true);
            expect(operation?.trigrams).toContain('sea');

            const [index] = yield* admin.unsafe<{
              readonly amname: string;
              readonly extension_owned: boolean;
              readonly indisready: boolean;
              readonly indisvalid: boolean;
              readonly opcintype: string;
              readonly opcname: string;
              readonly opcnamespace: string;
              readonly partial: boolean;
              readonly predicate: string;
            }>(`select i.indisvalid, i.indisready, i.indpred is not null as partial,
                pg_get_expr(i.indpred, i.indrelid) as predicate,
                a.amname, c.opcname, n.nspname as opcnamespace, c.opcintype::regtype::text as opcintype,
                exists (
                  select 1 from pg_depend d
                  join pg_extension e on e.oid = d.refobjid
                  where d.classid = 'pg_catalog.pg_opclass'::regclass and d.objid = c.oid
                    and d.refclassid = 'pg_catalog.pg_extension'::regclass and e.extname = 'pg_trgm'
                ) as extension_owned
              from pg_index i
              join pg_class t on t.oid = i.indrelid
              join pg_namespace s on s.oid = t.relnamespace
              join pg_am a on a.oid = (select relam from pg_class where oid = i.indexrelid)
              join pg_opclass c on c.oid = i.indclass[0]
              join pg_namespace n on n.oid = c.opcnamespace
              where s.nspname = 'core' and t.relname = 'search_index_entries' and a.amname = 'gin'`);
            expect(index).toMatchObject({
              amname: 'gin',
              extension_owned: true,
              indisready: true,
              indisvalid: true,
              opcintype: 'text',
              opcname: 'gin_trgm_ops',
              opcnamespace: 'public',
              partial: true,
            });
            expect(index?.predicate).toContain('deleted');
            expect(index?.predicate).toContain('search_format_version');

            const columns = yield* admin.unsafe<{
              readonly column_default: string | null;
              readonly column_name: string;
              readonly data_type: string;
              readonly is_nullable: string;
            }>(
              `select column_name, is_nullable, data_type, column_default
              from information_schema.columns
              where table_schema = 'core' and table_name = 'search_index_entries'
                and column_name = any($1::text[])
              order by column_name`,
              [[...evidenceColumns]],
            );
            expect(columns).toEqual([
              { column_default: null, column_name: 'search_format_version', data_type: 'integer', is_nullable: 'YES' },
              { column_default: null, column_name: 'search_source_version', data_type: 'bigint', is_nullable: 'YES' },
              { column_default: null, column_name: 'search_text_v1', data_type: 'text', is_nullable: 'YES' },
            ]);
          }),
        ),
      60_000,
    );

    suite.effect(
      'adds nullable derived evidence without rewriting prior rows, old-writer NULLs, versions, generations or floors',
      () =>
        withFixture(({ admin }) =>
          Effect.gen(function* additiveMigration() {
            const schema = yield* randomIdentifier('search_evidence');
            const table = `${quoted(schema)}.search_index_entries`;
            const tenant = '10000000-0000-4000-8000-000000000001';
            const company = '20000000-0000-4000-8000-000000000001';
            const migration = yield* migrationSql;
            yield* admin.unsafe(`create schema ${quoted(schema)}`);
            yield* Effect.addFinalizer(() => admin.unsafe(`drop schema ${quoted(schema)} cascade`).pipe(Effect.orDie));
            yield* admin.unsafe(oldSearchTable(schema));
            yield* admin.unsafe(`create table ${quoted(schema)}.search_projection_generations (
              tenant_id uuid, source_module_key text, generation bigint, event_watermark bigint, updated_at timestamptz
            )`);
            yield* admin.unsafe(`create table ${quoted(schema)}.search_projection_rebuilds (
              tenant_id uuid, source_module_key text, source_resource_type text,
              rebuild_version bigint, fingerprint text, updated_at timestamptz
            )`);
            yield* admin.unsafe(`create table ${quoted(schema)}.owner_source (id text, title text)`);
            yield* admin.unsafe(
              `insert into ${quoted(schema)}.owner_source values ('source', 'Owner data must remain unchanged')`,
            );
            yield* admin.unsafe(
              `insert into ${table}
              (tenant_id, legal_entity_id, source_module_key, source_resource_type, source_resource_id,
               title, body_text, deleted, facets_json, projection_version)
              values
              ($1, $2, 'party.registry', 'party.registry.party', 'prior-active',
               'Prior active', 'prior active body', false, '{"schemaVersion":"2"}'::jsonb, 7),
              ($1, $2, 'party.registry', 'party.registry.party', 'prior-tombstone',
               '', '', true, '{"schemaVersion":"2"}'::jsonb, 9)`,
              [tenant, company],
            );
            yield* admin.unsafe(
              `insert into ${quoted(schema)}.search_projection_generations values ($1, 'party.registry', 19, 41, now())`,
              [tenant],
            );
            yield* admin.unsafe(
              `insert into ${quoted(schema)}.search_projection_rebuilds
              values ($1, 'party.registry', 'party.registry.party', 13, $2, now())`,
              [tenant, 'a'.repeat(64)],
            );
            const priorRows = yield* admin.unsafe(
              `select to_jsonb(t) as row from ${table} t order by source_resource_id`,
            );
            const priorGenerations = yield* admin.unsafe(
              `select to_jsonb(t) as row from ${quoted(schema)}.search_projection_generations t`,
            );
            const priorRebuilds = yield* admin.unsafe(
              `select to_jsonb(t) as row from ${quoted(schema)}.search_projection_rebuilds t`,
            );
            const priorOwnerSource = yield* admin.unsafe(
              `select to_jsonb(t) as row from ${quoted(schema)}.owner_source t`,
            );

            yield* applyMigration(admin, migration.replaceAll('"core"', quoted(schema)));

            expect(
              yield* admin.unsafe(
                `select to_jsonb(t) - 'search_text_v1' - 'search_format_version' - 'search_source_version' as row
                 from ${table} t order by source_resource_id`,
              ),
            ).toEqual(priorRows);
            expect(
              yield* admin.unsafe(`select to_jsonb(t) as row from ${quoted(schema)}.search_projection_generations t`),
            ).toEqual(priorGenerations);
            expect(
              yield* admin.unsafe(`select to_jsonb(t) as row from ${quoted(schema)}.search_projection_rebuilds t`),
            ).toEqual(priorRebuilds);
            expect(yield* admin.unsafe(`select to_jsonb(t) as row from ${quoted(schema)}.owner_source t`)).toEqual(
              priorOwnerSource,
            );
            expect(
              yield* admin.unsafe(
                `select source_resource_id, search_text_v1, search_format_version, search_source_version
                 from ${table} order by source_resource_id`,
              ),
            ).toEqual([
              {
                search_format_version: null,
                search_source_version: null,
                search_text_v1: null,
                source_resource_id: 'prior-active',
              },
              {
                search_format_version: null,
                search_source_version: null,
                search_text_v1: null,
                source_resource_id: 'prior-tombstone',
              },
            ]);
            expect(
              yield* admin.unsafe(
                `select projection_version::text as version from ${table} where source_resource_id = 'prior-active'`,
              ),
            ).toEqual([{ version: '7' }]);

            // The old writer never names the new columns; the migration must leave those rows eligible
            // for exact fallback rather than synthesizing evidence or rejecting the write.
            yield* admin.unsafe(
              `insert into ${table}
              (tenant_id, legal_entity_id, source_module_key, source_resource_type, source_resource_id,
               title, body_text, deleted, facets_json, projection_version)
              values ($1, $2, 'party.registry', 'party.registry.party', 'old-writer',
                'Old writer', 'old writer body', false, '{"schemaVersion":"2"}'::jsonb, 12)`,
              [tenant, company],
            );
            expect(
              yield* admin.unsafe(
                `select search_text_v1, search_format_version, search_source_version, projection_version::text as version
                 from ${table} where source_resource_id = 'old-writer'`,
              ),
            ).toEqual([
              {
                search_format_version: null,
                search_source_version: null,
                search_text_v1: null,
                version: '12',
              },
            ]);
          }),
        ),
      60_000,
    );

    suite.effect(
      'refuses a pg_trgm extension that already lives outside public without moving it',
      () => withFixture(wrongExtensionNamespace),
      60_000,
    );

    suite.effect(
      'refuses a public pg_trgm extension without the exact GIN text operator class and does not rename or replace it',
      () => withFixture(wrongOperatorClass),
      60_000,
    );

    suite.effect(
      'keeps request and worker cohorts scoped to their own tenant, company and owner with no global reader',
      () =>
        withFixture(({ admin, connectionString }) =>
          Effect.gen(function* roleCohorts() {
            const crypto = yield* Crypto.Crypto;
            const tenant = yield* crypto.randomUUIDv4();
            const otherTenant = yield* crypto.randomUUIDv4();
            const company = yield* crypto.randomUUIDv4();
            const otherCompany = yield* crypto.randomUUIDv4();
            const foreignCompany = yield* crypto.randomUUIDv4();
            const principal = yield* crypto.randomUUIDv4();
            yield* addTestGatewayScopeGrantCleanup(admin, [tenant, otherTenant]);
            yield* admin.unsafe(
              `insert into core.tenants (tenant_id, slug, name, status, default_locale)
               values ($1, $2, 'Search tenant', 'active', 'en')`,
              [tenant, `search-${tenant.slice(0, 8)}`],
            );
            yield* admin.unsafe(
              `insert into core.tenants (tenant_id, slug, name, status, default_locale)
               values ($1, $2, 'Other search tenant', 'active', 'en')`,
              [otherTenant, `search-${otherTenant.slice(0, 8)}`],
            );
            yield* admin.unsafe(
              `insert into core.legal_entities
               (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
               values ($1, $2, 'Search company', 'DE', 'HRB-1', 'active'),
                      ($3, $2, 'Other search company', 'DE', 'HRB-2', 'active'),
                      ($4, $5, 'Foreign search company', 'DE', 'HRB-3', 'active')`,
              [company, tenant, otherCompany, foreignCompany, otherTenant],
            );
            yield* admin.unsafe(
              `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
               values ($1, $2, 'human', 'Search principal', 'active')`,
              [principal, tenant],
            );
            yield* admin.unsafe(
              `insert into trust.gateway_audience_roles (audience, role_name)
               values ('party-registry', '${FIXTURE_REQUEST_IDENTITY.role}')
               on conflict (audience) do update set role_name = excluded.role_name`,
            );
            yield* admin.unsafe(
              `insert into core.search_index_entries
               (tenant_id, legal_entity_id, source_module_key, source_resource_type, source_resource_id,
                title, body_text, deleted, facets_json, projection_version)
               values
               ($1, $2, 'party.registry', 'party.registry.party', 'valid', 'Valid', 'valid', false, '{"schemaVersion":"2"}'::jsonb, 1),
               ($3, $4, 'party.registry', 'party.registry.party', 'wrong-tenant', 'Wrong tenant', 'wrong', false, '{"schemaVersion":"2"}'::jsonb, 1),
               ($1, $5, 'party.registry', 'party.registry.party', 'wrong-company', 'Wrong company', 'wrong', false, '{"schemaVersion":"2"}'::jsonb, 1),
               ($1, $2, 'finance.billing', 'finance.billing.invoice', 'wrong-owner', 'Wrong owner', 'wrong', false, '{"schemaVersion":"2"}'::jsonb, 1)`,
              [tenant, company, otherTenant, foreignCompany, otherCompany],
            );
            yield* admin.unsafe(
              `grant usage on schema core, trust to ${FIXTURE_REQUEST_IDENTITY.role}, ${FIXTURE_WORKER_IDENTITY.role}`,
            );
            yield* admin.unsafe(`grant select on core.search_index_entries to ${FIXTURE_REQUEST_IDENTITY.role}`);
            yield* admin.unsafe(`grant select on core.search_index_entries to ${FIXTURE_WORKER_IDENTITY.role}`);
            yield* admin.unsafe(
              `grant execute on function trust.establish_gateway_scope(text) to ${FIXTURE_REQUEST_IDENTITY.role}`,
            );
            yield* admin.unsafe(
              `grant execute on function trust.current_tenant_id(), trust.current_legal_entity_id()
               to ${FIXTURE_REQUEST_IDENTITY.role}`,
            );

            const companyGrant = yield* registerTestGatewayScopeGrant(
              admin,
              { audience: 'party-registry', legalEntityId: company, principalId: principal, tenantId: tenant },
              FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
            );
            const tenantGrant = yield* registerTestGatewayScopeGrant(
              admin,
              { audience: 'party-registry', principalId: principal, tenantId: tenant },
              FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
            );
            const session = yield* makeTestPgSession(connectionString);

            expect(
              (yield* requestRows(session, Redacted.value(companyGrant.assertion))).map(
                ({ source_resource_id }) => source_resource_id,
              ),
            ).toEqual(['valid']);
            expect(
              (yield* requestRows(session, Redacted.value(tenantGrant.assertion))).map(
                ({ source_resource_id }) => source_resource_id,
              ),
            ).toEqual(['valid', 'wrong-company']);
            expect((yield* workerRows(session, tenant)).map(({ source_resource_id }) => source_resource_id)).toEqual([
              'valid',
              'wrong-company',
            ]);
            expect(
              (yield* workerRows(session, otherTenant)).map(({ source_resource_id }) => source_resource_id),
            ).toEqual(['wrong-tenant']);
          }),
        ),
      60_000,
    );
  },
);
