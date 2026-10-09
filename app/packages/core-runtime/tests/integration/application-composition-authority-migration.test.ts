import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, FileSystem, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { testDatabaseClients } from '../support/database.ts';

const migrationPath = new URL(
  '../../drizzle/20261002161528_application-composition-authority/migration.sql',
  import.meta.url,
).pathname;

const authorityMigrationProgram = Effect.gen(function* authorityMigrationEffect() {
  const { admin, runtime } = yield* testDatabaseClients;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const schemaName = `composition_authority_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
  const quotedSchema = `"${schemaName}"`;
  const table = `${quotedSchema}."application_composition_authority"`;
  yield* admin.unsafe(`create schema ${quotedSchema}`);
  yield* Effect.addFinalizer(() => admin.unsafe(`drop schema ${quotedSchema} cascade`).pipe(Effect.orDie));
  const migration = yield* fileSystem.readFileString(migrationPath);
  for (const statement of migration.replaceAll('"core"', quotedSchema).split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) {
      yield* admin.unsafe(statement);
    }
  }
  yield* admin.unsafe(`grant usage on schema ${quotedSchema} to ontos_runtime`);
  const originalRevision = 'a'.repeat(64);
  yield* admin.unsafe(
    `insert into ${table} (revision, phase, valid_until, subscriptions_json)
     values ($1, 'active', now() + interval '1 hour', '[]'::jsonb)`,
    [originalRevision],
  );
  expect(yield* runtime.unsafe<{ revision: string }>(`select revision from ${table}`)).toEqual([
    { revision: originalRevision },
  ]);
  for (const statement of [
    `insert into ${table} (revision, phase, valid_until, subscriptions_json)
     values ('${'b'.repeat(64)}', 'active', now() + interval '1 hour', '[]'::jsonb)`,
    `update ${table} set revision = '${'b'.repeat(64)}'`,
    `delete from ${table}`,
    `truncate table ${table}`,
  ]) {
    const failure = yield* Effect.flip(runtime.unsafe(statement));
    expect(Option.getOrUndefined(findPostgresFailure(failure))?.code).toBe('42501');
  }
  const privileges = yield* runtime.unsafe<{ operation: string; permitted: boolean }>(
    `select operation, has_table_privilege(current_user, $1, operation) as permitted
     from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])
       as operation`,
    [`${schemaName}.application_composition_authority`],
  );
  expect(privileges).toEqual([
    { operation: 'SELECT', permitted: true },
    { operation: 'INSERT', permitted: false },
    { operation: 'UPDATE', permitted: false },
    { operation: 'DELETE', permitted: false },
    { operation: 'TRUNCATE', permitted: false },
    { operation: 'REFERENCES', permitted: false },
    { operation: 'TRIGGER', permitted: false },
    { operation: 'MAINTAIN', permitted: false },
  ]);
  // Native transaction advisory locks need no mutation privilege on the authority table.
  yield* runtime
    .unsafe('select pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [schemaName])
    .pipe(runtime.withTransaction);
  yield* admin
    .unsafe('select pg_advisory_xact_lock(hashtextextended($1, 0))', [schemaName])
    .pipe(admin.withTransaction);

  // Read-only RLS remains a second boundary if the broad Core bootstrap grant is accidentally restored.
  yield* admin.unsafe(`grant insert, update, delete on table ${table} to ontos_runtime`);
  expect(yield* runtime.unsafe(`update ${table} set phase = 'draining' returning authority_key`)).toEqual([]);
  expect(yield* runtime.unsafe(`delete from ${table} returning authority_key`)).toEqual([]);
  const insertFailure = yield* Effect.flip(
    runtime.unsafe(
      `insert into ${table} (revision, phase, valid_until, subscriptions_json)
       values ($1, 'active', now() + interval '1 hour', '[]'::jsonb)`,
      ['b'.repeat(64)],
    ),
  );
  expect(Option.getOrUndefined(findPostgresFailure(insertFailure))?.code).toBe('42501');
  expect(yield* admin.unsafe<{ phase: string; revision: string }>(`select phase, revision from ${table}`)).toEqual([
    { phase: 'active', revision: originalRevision },
  ]);
  yield* admin.unsafe(`update ${table} set phase = 'draining', revision = $1`, ['b'.repeat(64)]);
  expect(yield* runtime.unsafe<{ phase: string }>(`select phase from ${table}`)).toEqual([{ phase: 'draining' }]);
}).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })('Application Composition authority migration', (suite) => {
  suite.effect(
    'allows administrator promotion while preventing runtime forgery and truncation',
    () => authorityMigrationProgram,
  );
});
