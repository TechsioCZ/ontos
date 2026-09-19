import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Array as EffectArray, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  PAYMENT_TERM_CATALOG_SCHEMA_NAME,
  PAYMENT_TERM_CATALOG_TABLE_INVENTORY,
  paymentTermCatalogRelations,
} from '../../src/database/schema.ts';

const runtimeRole = 'ontos_runtime';

/** The audited catalog surface: every runtime call enters the schema through one of these. */
const grantedRoutines = [
  'correct_term',
  'create_term',
  'get_current',
  'get_history',
  'list_current',
  'reconcile_term',
  'resolve_reference',
  'retire_term',
] as const;

/** Scope assertion and revision projection stay definer-private; granting either would bypass the scope gate. */
const privateRoutines = ['assert_operation_scope', 'definition_json'] as const;

const guardTriggers = [
  ['payment_term_aliases', 'payment_term_aliases_append_only'],
  ['payment_term_lifecycle_events', 'payment_term_lifecycle_events_append_only'],
  ['payment_term_revisions', 'payment_term_revisions_append_only'],
  ['payment_terms', 'payment_terms_identity_immutable'],
] as const;

const requiredIndexes = [
  'payment_term_catalog_revisions_number_uk',
  'payment_term_catalog_revisions_semantics_idx',
  'payment_term_catalog_terms_scope_code_uk',
] as const;

/** Replaced by a non-unique semantics index; reintroducing it would reject legitimate corrections. */
const retiredIndexes = ['payment_term_catalog_revisions_semantics_uk'] as const;

const acquireCatalogPool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString, max: 1 })),
    (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie),
  );

it.live('governs the Payment Term Catalog schema through forced RLS and routine-only runtime access', () =>
  Effect.scoped(
    Effect.gen(function* databaseSecurityCatalog() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquireCatalogPool(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromPool(adminPool, paymentTermCatalogRelations);
      const schema = PAYMENT_TERM_CATALOG_SCHEMA_NAME;

      const tables = yield* admin.execute<{
        readonly name: string;
        readonly enabled: boolean;
        readonly forced: boolean;
      }>(
        sql`select relname as name, relrowsecurity as enabled, relforcerowsecurity as forced
            from pg_class
            join pg_namespace on pg_namespace.oid = pg_class.relnamespace
            where nspname = ${schema} and relkind = 'r'`,
        'objects',
      );
      expect(
        EffectArray.sort(
          tables.map(({ name }) => name),
          Order.String,
        ),
      ).toEqual(EffectArray.sort([...PAYMENT_TERM_CATALOG_TABLE_INVENTORY], Order.String));
      expect(tables.filter(({ enabled, forced }) => !enabled || !forced)).toEqual([]);

      const tableGrants = yield* admin.execute<{ readonly name: string }>(
        sql`select format('%s:%s', table_name, privilege_type) as name
            from information_schema.role_table_grants
            where grantee = ${runtimeRole} and table_schema = ${schema}`,
        'objects',
      );
      expect(tableGrants).toEqual([]);

      const sequenceGrants = yield* admin.execute<{ readonly name: string }>(
        sql`select sequence_name as name
            from information_schema.sequences
            where sequence_schema = ${schema}
              and has_sequence_privilege(${runtimeRole}, format('%I.%I', sequence_schema, sequence_name), 'USAGE, SELECT, UPDATE')`,
        'objects',
      );
      expect(sequenceGrants).toEqual([]);

      const routines = yield* admin.execute<{
        readonly name: string;
        readonly definer: boolean;
        readonly executable: boolean;
        readonly returnsTrigger: boolean;
        readonly searchPath: string | null;
      }>(
        sql`select proname as name,
                   prosecdef as definer,
                   prorettype = 'pg_catalog.trigger'::regtype as "returnsTrigger",
                   has_function_privilege(${runtimeRole}, pg_proc.oid, 'EXECUTE') as executable,
                   (select config from unnest(coalesce(proconfig, '{}'::text[])) as config where config like 'search_path=%') as "searchPath"
            from pg_proc
            join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
            where nspname = ${schema}`,
        'objects',
      );
      const callable = routines.filter(({ returnsTrigger }) => !returnsTrigger);
      expect(callable.filter(({ definer }) => !definer)).toEqual([]);
      expect(callable.filter(({ searchPath }) => searchPath?.startsWith('search_path=pg_catalog') !== true)).toEqual(
        [],
      );
      expect(routines.filter(({ executable, returnsTrigger }) => returnsTrigger && executable)).toEqual([]);
      expect(
        EffectArray.sort(
          routines.filter(({ executable }) => executable).map(({ name }) => name),
          Order.String,
        ),
      ).toEqual(EffectArray.sort([...grantedRoutines], Order.String));
      const declared = new Set(routines.map(({ name }) => name));
      for (const routine of privateRoutines) {
        expect(declared.has(routine), routine).toBe(true);
      }

      const triggers = yield* admin.execute<{ readonly name: string }>(
        sql`select format('%s:%s', relname, tgname) as name
            from pg_trigger
            join pg_class on pg_class.oid = pg_trigger.tgrelid
            join pg_namespace on pg_namespace.oid = pg_class.relnamespace
            where nspname = ${schema} and not tgisinternal`,
        'objects',
      );
      const triggerNames = new Set(triggers.map(({ name }) => name));
      for (const [table, trigger] of guardTriggers) {
        expect(triggerNames.has(`${table}:${trigger}`), `${table}.${trigger}`).toBe(true);
      }

      const indexes = yield* admin.execute<{ readonly name: string }>(
        sql`select indexname as name from pg_indexes where schemaname = ${schema}`,
        'objects',
      );
      const indexNames = new Set(indexes.map(({ name }) => name));
      for (const index of requiredIndexes) {
        expect(indexNames.has(index), index).toBe(true);
      }
      for (const index of retiredIndexes) {
        expect(indexNames.has(index), index).toBe(false);
      }

      const aliasForeignKeys = yield* admin.execute<{ readonly name: string }>(
        sql`select conname as name
            from pg_constraint
            join pg_class on pg_class.oid = pg_constraint.conrelid
            join pg_namespace on pg_namespace.oid = pg_class.relnamespace
            where nspname = ${schema} and relname = 'payment_term_aliases' and contype = 'f'`,
        'objects',
      );
      expect(
        EffectArray.sort(
          aliasForeignKeys.map(({ name }) => name),
          Order.String,
        ),
      ).toEqual(['payment_term_catalog_aliases_alias_fk', 'payment_term_catalog_aliases_canonical_fk']);
    }),
  ),
);
