import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  canonicalDatabaseValue,
  DATABASE_CATALOG_QUERIES,
  hashDatabaseState,
  readDatabaseStateLines,
} from '../postgres/database-state-fingerprint.mts';
import { quoteIdentifier } from '../postgres/database-login-roles.mts';

/** Independent reference: the previous sequential catalog and journal discovery algorithm. */
const readSequentialEvidence = (client: PgClient.PgClient) =>
  client.withTransaction(
    Effect.gen(function* readSequentialEvidenceEffect() {
      yield* client.unsafe('set transaction isolation level repeatable read read only');
      yield* client.unsafe('set local search_path = pg_catalog');
      const lines: string[] = [];
      for (const [name, sql] of Object.entries(DATABASE_CATALOG_QUERIES)) {
        const rows = yield* client
          .unsafe(`select to_jsonb(evidence) as row from (${sql}) evidence`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ row: Schema.Json })))));
        lines.push(...rows.map(({ row }) => `${name} ${canonicalDatabaseValue(row)}`));
      }
      const journals = yield* client.unsafe<{ name: string }>(`select c.relname as name from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='drizzle' and c.relkind in ('r','p') order by c.relname`);
      for (const { name } of journals) {
        const rows = yield* client
          .unsafe(`select to_jsonb(j) as row from drizzle.${quoteIdentifier(name)} j`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ row: Schema.Json })))));
        lines.push(...rows.map(({ row }) => `journal ${name} ${canonicalDatabaseValue(row)}`));
      }
      return lines;
    }),
  );

it.layer(Layer.mergeAll(NodeServices.layer, Reactivity.layer), { excludeTestServices: true })((suite) => {
  suite.effect(
    'batched evidence is byte-identical across journal, PUBLIC ACL, default and column mutations',
    (context) =>
      Effect.gen(function* batchingProof() {
        const sandbox = yield* Config.option(
          Config.schema(Schema.Literals(['owned-postgres18']), 'DATABASE_FINGERPRINT_TEST_SANDBOX'),
        );
        if (Option.isNone(sandbox)) {
          return yield* Effect.sync(() => context.skip());
        }
        const url = new URL(Redacted.value(yield* Config.Redacted('DATABASE_FINGERPRINT_TEST_DATABASE_URL')));
        expect(['localhost', '127.0.0.1']).toContain(url.hostname);
        expect(url.pathname).toBe('/postgres');
        const root = yield* PgClient.makeClient({ url: Redacted.make(url.href) });
        const database = `catalog_batch_${process.pid}`;
        yield* root.unsafe(`create database ${quoteIdentifier(database)}`);
        yield* Effect.addFinalizer(() =>
          root.unsafe(`drop database ${quoteIdentifier(database)} with (force)`).pipe(Effect.orDie),
        );
        url.pathname = `/${database}`;
        const client = yield* PgClient.makeClient({ url: Redacted.make(url.href) });
        for (const statement of [
          'create schema drizzle',
          'create table drizzle."quoted journal" (id integer, hash text)',
          `insert into drizzle."quoted journal" values (1, 'migration-one')`,
          'create view drizzle.not_a_journal as select 1 as value',
          'create schema catalog_proof',
          'create table catalog_proof.items (id integer, label text)',
          "create function catalog_proof.ordinary() returns integer language sql as 'select 1'",
        ]) {
          yield* client.unsafe(statement);
        }
        let previous: string | undefined;
        for (const mutation of [
          'select 1',
          'grant select on catalog_proof.items to public',
          'grant update (label) on catalog_proof.items to public',
          'revoke execute on function catalog_proof.ordinary() from public',
          'alter default privileges in schema catalog_proof grant select on tables to public',
          'alter table catalog_proof.items add column enabled boolean',
          `insert into drizzle."quoted journal" values (2, 'migration-two')`,
        ]) {
          yield* client.unsafe(mutation);
          const sequential = yield* readSequentialEvidence(client);
          const batched = yield* readDatabaseStateLines(client);
          expect(new Set(batched)).toEqual(new Set(sequential));
          const hash = hashDatabaseState(batched);
          expect(hash).toBe(hashDatabaseState(sequential));
          if (previous !== undefined) {
            expect(hash).not.toBe(previous);
          }
          previous = hash;
        }
        return yield* Effect.void;
      }).pipe(Effect.scoped),
  );
});
