import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, FileSystem, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { testDatabaseClients } from '../support/database.ts';

const migrationFolders = [
  '20261002161528_application-composition-authority',
  '20261002172150_application-composition-durable-work',
  '20261002172202_track-application-composition-durable-work',
  '20261002181111_application-composition-final-seal',
  '20261002181122_seal-application-composition-durable-work',
  '20261002182730_application-composition-migration-complete',
  '20261002182937_application-composition-durable-work-admission',
  '20261002182953_fence-closed-application-composition-durable-work',
] as const;

it.layer(NodeServices.layer, { excludeTestServices: true })(
  'Application Composition durable work migration',
  (suite) => {
    suite.effect(
      'tracks exact owner work atomically and rejects runtime forgery, stale revisions, and unsafe isolation',
      () =>
        Effect.gen(function* durableWorkMigrationEffect() {
          const { admin, runtime } = yield* testDatabaseClients;
          const fileSystem = yield* FileSystem.FileSystem;
          const crypto = yield* Crypto.Crypto;
          const name = `composition_durable_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
          const schema = `"${name}"`;
          const authority = `${schema}.application_composition_authority`;
          const ledger = `${schema}.application_composition_durable_work`;
          const routine = `${schema}.track_application_composition_durable_work`;
          const revision = 'a'.repeat(64);
          yield* admin.unsafe(`create schema ${schema}`);
          yield* Effect.addFinalizer(() => admin.unsafe(`drop schema ${schema} cascade`).pipe(Effect.orDie));
          for (const folder of migrationFolders) {
            const migration = yield* fileSystem.readFileString(
              new URL(`../../drizzle/${folder}/migration.sql`, import.meta.url).pathname,
            );
            for (const statement of migration
              .replaceAll('"core"', schema)
              .replaceAll('core.', `${schema}.`)
              .replaceAll('pg_catalog, core', `pg_catalog, ${schema}`)
              .split('--> statement-breakpoint')) {
              if (statement.trim().length > 0) {
                yield* admin.unsafe(statement);
              }
            }
          }
          yield* admin.unsafe(`grant usage on schema ${schema} to ontos_runtime`);
          yield* admin.unsafe(
            `insert into ${authority} (revision, phase, valid_until, subscriptions_json)
         values ($1, 'active', now() + interval '1 hour', '[]'::jsonb)`,
            [revision],
          );
          const call = (pending: boolean, selectedRevision = revision, selectedWorkId = 'work-1') =>
            admin.unsafe(`select ${routine}($1, $2, $3, $4)`, [
              'commerce-customer-context',
              selectedRevision,
              selectedWorkId,
              pending,
            ]);
          yield* call(true);
          yield* call(true);
          expect(yield* runtime.unsafe<{ work_id: string }>(`select work_id from ${ledger}`)).toEqual([
            { work_id: 'work-1' },
          ]);
          const forged = yield* Effect.flip(
            runtime.unsafe(`select ${routine}($1, $2, $3, true)`, ['commerce-customer-context', revision, 'forged']),
          );
          expect(Option.getOrUndefined(findPostgresFailure(forged))?.code).toBe('42501');
          const triggerForgery = yield* Effect.flip(
            Effect.gen(function* runtimeOwnedTriggerForgery() {
              yield* runtime.unsafe('create temporary table durable_work_forgery (id text)');
              yield* runtime.unsafe(`create function pg_temp.forge_durable_work() returns trigger
            language plpgsql security invoker as $trigger$
            begin
              perform ${routine}('commerce-customer-context', '${revision}', 'forged', true);
              return new;
            end;
            $trigger$`);
              yield* runtime.unsafe(`create trigger forge_durable_work before insert on durable_work_forgery
            for each row execute function pg_temp.forge_durable_work()`);
              yield* runtime.unsafe("insert into durable_work_forgery values ('forged')");
            }).pipe(runtime.withTransaction),
          );
          expect(Option.getOrUndefined(findPostgresFailure(triggerForgery))?.code).toBe('42501');
          const truncate = yield* Effect.flip(runtime.unsafe(`truncate ${ledger}`));
          expect(Option.getOrUndefined(findPostgresFailure(truncate))?.code).toBe('42501');
          const stale = yield* Effect.flip(call(false, 'b'.repeat(64)));
          expect(Option.getOrUndefined(findPostgresFailure(stale))?.code).toBe('55000');
          yield* admin.unsafe(`update ${authority} set durable_work_admission = 'closed'`);
          yield* call(true);
          const closedInsert = yield* Effect.flip(call(true, revision, 'new-after-close'));
          expect(Option.getOrUndefined(findPostgresFailure(closedInsert))?.code).toBe('55000');
          yield* call(false);
          expect(yield* runtime.unsafe(`select work_id from ${ledger}`)).toEqual([]);
          yield* admin.unsafe(`update ${authority} set durable_work_admission = 'open'`);
          yield* call(true);
          yield* admin.unsafe(`update ${authority} set phase = 'draining'`);
          yield* call(true);
          const drainingInsert = yield* Effect.flip(call(true, revision, 'new-after-draining'));
          expect(Option.getOrUndefined(findPostgresFailure(drainingInsert))?.code).toBe('55000');
          yield* call(false);
          expect(yield* runtime.unsafe(`select work_id from ${ledger}`)).toEqual([]);
          for (const phase of ['sealed', 'migrated']) {
            yield* admin.unsafe(`update ${authority} set phase = 'active'`);
            yield* call(true);
            yield* admin.unsafe(`update ${authority} set phase = $1`, [phase]);
            for (const pending of [true, false]) {
              const blocked = yield* Effect.flip(call(pending));
              expect(Option.getOrUndefined(findPostgresFailure(blocked))?.code).toBe('55000');
            }
            expect(yield* runtime.unsafe<{ work_id: string }>(`select work_id from ${ledger}`)).toEqual([
              { work_id: 'work-1' },
            ]);
            yield* admin.unsafe(`update ${authority} set phase = 'active'`);
            yield* call(false);
            expect(yield* runtime.unsafe(`select work_id from ${ledger}`)).toEqual([]);
          }
          yield* admin.unsafe(`update ${authority} set phase = 'active', valid_until = now() - interval '1 second'`);
          const expired = yield* Effect.flip(call(true));
          expect(Option.getOrUndefined(findPostgresFailure(expired))?.code).toBe('55000');
          const unsafeIsolation = yield* Effect.flip(
            Effect.gen(function* repeatableReadAdmission() {
              yield* admin.unsafe('set transaction isolation level repeatable read');
              yield* call(true);
            }).pipe(admin.withTransaction),
          );
          expect(Option.getOrUndefined(findPostgresFailure(unsafeIsolation))?.code).toBe('55000');
        }).pipe(Effect.scoped),
    );
  },
);
