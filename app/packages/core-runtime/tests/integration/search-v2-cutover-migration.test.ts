import { NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, FileSystem, Layer, Option } from 'effect';
import { expect, it } from 'effect-rstest';
import type { SqlError } from 'effect/sql/SqlError';

import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { testDatabaseClients } from '../support/database.ts';
import { coreSearchDocumentConstraintMatches } from '../../src/db/search-document-constraint.ts';

const migrationPath = new URL(
  '../../drizzle/20261102133620_search-projection-v2-cutover/migration.sql',
  import.meta.url,
).pathname;
const documentCheck = 'core_search_index_entries_document_ck';
const legacyExpression =
  'deleted or (length(btrim(title)) > 0 and length(title) <= 300 and length(body_text) <= 40000)';
const tenant = '10000000-0000-4000-8000-000000000001';
const company = '20000000-0000-4000-8000-000000000001';

interface Fixture {
  readonly client: PgClient.PgClient;
  readonly index: string;
  readonly migration: string;
  readonly runtime: PgClient.PgClient;
  readonly schema: string;
}
const withFixture = <Value, Failure, Requirements>(
  consume: (fixture: Fixture) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* fixture() {
      const { admin: client, runtime } = yield* testDatabaseClients;
      const crypto = yield* Crypto.Crypto;
      const fs = yield* FileSystem.FileSystem;
      const schema = `"search_cutover_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}"`;
      yield* client.unsafe(`create schema ${schema}`);
      yield* Effect.addFinalizer(() => client.unsafe(`drop schema ${schema} cascade`).pipe(Effect.orDie));
      const index = `${schema}.search_index_entries`;
      yield* client.unsafe(`create table ${index} (
        search_index_entry_id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null, legal_entity_id uuid,
        source_module_key text not null, source_resource_type text not null, source_resource_id text not null,
        title text not null, body_text text not null, deleted boolean not null default false,
        facets_json jsonb not null, projection_version bigint not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint ${documentCheck} check (${legacyExpression})
      )`);
      yield* client.unsafe(`create table ${schema}.search_projection_generations (
        tenant_id uuid, source_module_key text, generation bigint, event_watermark bigint, updated_at timestamptz
      )`);
      yield* client.unsafe(`create table ${schema}.search_projection_rebuilds (
        tenant_id uuid, source_module_key text, source_resource_type text,
        rebuild_version bigint, fingerprint text, updated_at timestamptz
      )`);
      yield* client.unsafe(`create table ${schema}.owner_source (id text, title text)`);
      yield* client.unsafe(`insert into ${schema}.owner_source values ('source', 'Owner data must remain unchanged')`);
      yield* client.unsafe(
        `insert into ${index}
        (tenant_id, legal_entity_id, source_module_key, source_resource_type, source_resource_id,
         title, body_text, deleted, facets_json, projection_version)
        values
        ($1,$2,'finance.billing','finance.billing.invoice','legacy','Legacy','legacy terms',false,'{"schemaVersion":"1"}',7),
        ($1,$2,'finance.billing','finance.billing.invoice','old-tombstone','','',true,'{"schemaVersion":"1"}',9),
        ($1,$2,'finance.billing','finance.billing.invoice','current','Current','current',false,'{"schemaVersion":"2","searchableText":["current"]}',11)`,
        [tenant, company],
      );
      yield* client.unsafe(
        `insert into ${schema}.search_projection_generations
        values ($1,'finance.billing',19,41,now())`,
        [tenant],
      );
      yield* client.unsafe(
        `insert into ${schema}.search_projection_rebuilds
        values ($1,'finance.billing','finance.billing.invoice',13,$2,now())`,
        [tenant, 'a'.repeat(64)],
      );
      const migration = (yield* fs.readFileString(migrationPath)).replaceAll('"core"', schema);
      return yield* consume({ client, index, migration, runtime, schema });
    }),
  );

const metadata = ({ client, index, schema }: Fixture) =>
  Effect.all(
    [
      client.unsafe(`select to_jsonb(t) - 'title' - 'body_text' - 'deleted' - 'facets_json' - 'legal_entity_id' - 'updated_at' as row
      from ${index} t order by source_resource_id`),
      client.unsafe(`select * from ${schema}.search_projection_generations`),
      client.unsafe(`select * from ${schema}.search_projection_rebuilds`),
      client.unsafe(`select * from ${schema}.owner_source`),
    ],
    { concurrency: 1 },
  );
const apply = (fixture: Fixture) => fixture.client.unsafe(fixture.migration);
const code = (failure: SqlError) => Option.getOrUndefined(findPostgresFailure(failure))?.code;

it.layer(Layer.merge(NodeCrypto.layer, NodeServices.layer), { excludeTestServices: true })(
  'Core search v2 cutover',
  (suite) => {
    suite.effect('retires only legacy projections, preserves versions/floors/source rows and is idempotent', () =>
      withFixture((fixture) =>
        Effect.gen(function* retireLegacy() {
          const before = yield* metadata(fixture);
          const [current] = yield* fixture.client.unsafe(
            `select * from ${fixture.index} where source_resource_id='current'`,
          );
          yield* apply(fixture);
          const [constraint] = yield* fixture.client.unsafe<{ definition: string }>(
            `select pg_get_constraintdef(oid) as definition
          from pg_constraint where conrelid=$1::regclass and conname=$2`,
            [fixture.index, documentCheck],
          );
          expect(coreSearchDocumentConstraintMatches(constraint?.definition ?? '')).toBe(true);
          expect(yield* metadata(fixture)).toEqual(before);
          expect(
            yield* fixture.client.unsafe(`select * from ${fixture.index} where source_resource_id='current'`),
          ).toEqual([current]);
          const retired = yield* fixture.client
            .unsafe(`select source_resource_id, title, body_text, deleted, facets_json,
          legal_entity_id, projection_version::text as version from ${fixture.index}
          where source_resource_id <> 'current' order by source_resource_id`);
          expect(retired).toEqual([
            {
              body_text: '',
              deleted: true,
              facets_json: { schemaVersion: '2' },
              legal_entity_id: null,
              source_resource_id: 'legacy',
              title: '',
              version: '7',
            },
            {
              body_text: '',
              deleted: true,
              facets_json: { schemaVersion: '2' },
              legal_entity_id: null,
              source_resource_id: 'old-tombstone',
              title: '',
              version: '9',
            },
          ]);
          const once = yield* fixture.client.unsafe(`select * from ${fixture.index} order by source_resource_id`);
          yield* apply(fixture);
          expect(yield* fixture.client.unsafe(`select * from ${fixture.index} order by source_resource_id`)).toEqual(
            once,
          );
        }),
      ),
    );
    suite.effect('fences old writers and admits the exact v2 aggregate boundary, not missing/numeric versions', () =>
      withFixture((fixture) =>
        Effect.gen(function* writerFence() {
          yield* apply(fixture);
          for (const payload of ['{"schemaVersion":"1"}', '{}', '{"schemaVersion":2}']) {
            const failure = yield* fixture.client
              .unsafe(
                `update ${fixture.index}
            set deleted=false, title='Old writer', body_text='text', facets_json=$1::jsonb
            where source_resource_id='legacy'`,
                [payload],
              )
              .pipe(Effect.flip);
            expect(code(failure)).toBe('23514');
          }
          yield* fixture.client.unsafe(`update ${fixture.index} set body_text=repeat('x',10818202)
          where source_resource_id='current'`);
          expect(
            yield* fixture.client.unsafe(`select length(body_text) as size from ${fixture.index}
          where source_resource_id='current'`),
          ).toEqual([{ size: 10_818_202 }]);
          expect(
            code(
              yield* fixture.client
                .unsafe(`update ${fixture.index} set body_text=repeat('x',10818203)
          where source_resource_id='current'`)
                .pipe(Effect.flip),
            ),
          ).toBe('23514');
        }),
      ),
    );
    suite.effect('refuses a role whose forced RLS would hide projection rows from the migration', () =>
      withFixture((fixture) =>
        Effect.gen(function* filteredMigrationRole() {
          yield* fixture.client.unsafe(`grant usage on schema ${fixture.schema} to ontos_runtime`);
          yield* fixture.client.unsafe(
            `grant select,insert,update,delete on all tables in schema ${fixture.schema} to ontos_runtime`,
          );
          yield* fixture.client.unsafe(`alter table ${fixture.index} enable row level security`);
          yield* fixture.client.unsafe(`alter table ${fixture.index} force row level security`);
          expect(code(yield* fixture.runtime.unsafe(fixture.migration).pipe(Effect.flip))).toBe('55000');
          expect(
            yield* fixture.client.unsafe(`select deleted from ${fixture.index} where source_resource_id='legacy'`),
          ).toEqual([{ deleted: false }]);
        }),
      ),
    );
    for (const invalid of ['constraint', 'unknown-payload', 'ordering', 'shape', 'missing-table', 'trigger']) {
      suite.effect(`refuses ${invalid} drift atomically without retiring any rows`, () =>
        withFixture((fixture) =>
          Effect.gen(function* refusal() {
            const { client, index, schema } = fixture;
            if (invalid === 'constraint') {
              yield* client.unsafe(`alter table ${index} drop constraint ${documentCheck},
              add constraint ${documentCheck} check (deleted or length(body_text)<=39999)`);
            } else if (invalid === 'unknown-payload') {
              yield* client.unsafe(`update ${index} set facets_json='{"schemaVersion":"unknown"}'
              where source_resource_id='legacy'`);
            } else if (invalid === 'ordering') {
              yield* client.unsafe(`update ${schema}.search_projection_rebuilds set rebuild_version=0`);
            } else if (invalid === 'shape') {
              yield* client.unsafe(`alter table ${index} alter column source_resource_id type varchar`);
            } else if (invalid === 'missing-table') {
              yield* client.unsafe(`drop table ${schema}.search_projection_rebuilds`);
            } else {
              yield* client.unsafe(`create function ${schema}.unexpected_trigger() returns trigger language plpgsql
              as $$ begin return new; end $$`);
              yield* client.unsafe(`create trigger unexpected before update on ${index}
              for each row execute function ${schema}.unexpected_trigger()`);
            }
            const before = yield* client.unsafe(`select * from ${index} order by source_resource_id`);
            expect(code(yield* apply(fixture).pipe(Effect.flip))).toBe('55000');
            expect(yield* client.unsafe(`select * from ${index} order by source_resource_id`)).toEqual(before);
          }),
        ),
      );
    }
  },
);
