import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Array as EffectArray, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../../../packages/core-runtime/src/db/client.ts';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  PRICE_GROUP_CATALOG_SCHEMA_NAME,
  PRICE_GROUP_CATALOG_TABLE_INVENTORY,
  priceGroupCatalogRelations,
} from '../../src/database/schema.ts';

const expectedTriggers = [
  'price_group_catalog_ledger:price_group_catalog_ledger_append_only',
  'price_group_catalog_ledger:price_group_catalog_ledger_fence',
  'price_group_compatibility_support:price_group_catalog_compatibility_append_only',
  'price_group_definition_effective_intervals:price_group_catalog_intervals_append_only',
  'price_group_definition_effective_intervals:price_group_catalog_intervals_guard_insert',
  'price_group_definition_revisions:price_group_catalog_definitions_append_only',
  'price_group_definition_revisions:price_group_catalog_definitions_guard_insert',
  'price_group_retirements:price_group_catalog_retirements_append_only',
  'price_group_retirements:price_group_catalog_retirements_guard_insert',
  'price_group_retirements:price_group_retirements_consistency',
  'price_groups:price_groups_guard_update',
  'price_groups:price_groups_no_delete',
  'price_groups:price_groups_retirement_consistency',
] as const;

const expectedRuntimeFunctions = [
  'complete_price_group_containment_projection(uuid, uuid, timestamp with time zone)',
  'create_definition_revision(uuid, jsonb)',
  'create_price_group_with_containment_projection(uuid, jsonb)',
  'read_current_definition(uuid, uuid, timestamp with time zone)',
  'read_definition_revision(uuid, uuid, uuid, timestamp with time zone)',
  'read_price_group_containment_projection_intent(uuid, uuid)',
  'retire_price_group(uuid, jsonb)',
  'validate_compatibility(uuid, uuid, text, bigint, timestamp with time zone, jsonb)',
] as const;

const expectedFunctions = [
  'assert_operation_scope(uuid)',
  'complete_price_group_containment_projection(uuid, uuid, timestamp with time zone)',
  'create_definition_revision(uuid, jsonb)',
  'create_price_group(uuid, jsonb)',
  'create_price_group_with_containment_projection(uuid, jsonb)',
  'definition_json(uuid, uuid, uuid, bigint)',
  'enforce_catalog_fence()',
  'guard_definition_insert()',
  'guard_interval_insert()',
  'guard_price_group_update()',
  'guard_retirement_insert()',
  'read_current_definition(uuid, uuid, timestamp with time zone)',
  'read_definition_revision(uuid, uuid, uuid, timestamp with time zone)',
  'read_price_group_containment_projection_intent(uuid, uuid)',
  'reject_append_only_mutation()',
  'retire_price_group(uuid, jsonb)',
  'validate_compatibility(uuid, uuid, text, bigint, timestamp with time zone, jsonb)',
  'verify_retirement_consistency()',
] as const;

const expectedSecurityDefinerFunctions = new Set([
  'assert_operation_scope(uuid)',
  'complete_price_group_containment_projection(uuid, uuid, timestamp with time zone)',
  'create_definition_revision(uuid, jsonb)',
  'create_price_group(uuid, jsonb)',
  'create_price_group_with_containment_projection(uuid, jsonb)',
  'definition_json(uuid, uuid, uuid, bigint)',
  'read_current_definition(uuid, uuid, timestamp with time zone)',
  'read_definition_revision(uuid, uuid, uuid, timestamp with time zone)',
  'read_price_group_containment_projection_intent(uuid, uuid)',
  'retire_price_group(uuid, jsonb)',
  'validate_compatibility(uuid, uuid, text, bigint, timestamp with time zone, jsonb)',
]);

const tenantPolicyPredicate = "(tenant_id = (NULLIF(current_setting('ontos.tenant_id'::text, true), ''::text))::uuid)";
const expectedPolicyPrefixes = {
  price_group_catalog_ledger: 'price_group_catalog_ledger_scope',
  price_group_compatibility_support: 'price_group_catalog_compatibility_scope',
  price_group_containment_projection_intents: 'price_group_catalog_containment_intents_scope',
  price_group_definition_effective_intervals: 'price_group_catalog_intervals_scope',
  price_group_definition_revisions: 'price_group_catalog_definitions_scope',
  price_group_retirements: 'price_group_catalog_retirements_scope',
  price_groups: 'price_group_catalog_groups_scope',
} as const;
const expectedPolicies = EffectArray.sort(
  Object.entries(expectedPolicyPrefixes).flatMap(([table, prefix]) => [
    `${table}|${prefix}_delete|d|t|{ontos_runtime}|${tenantPolicyPredicate}|`,
    `${table}|${prefix}_insert|a|t|{ontos_runtime}||${tenantPolicyPredicate}`,
    `${table}|${prefix}_select|r|t|{ontos_runtime}|${tenantPolicyPredicate}|`,
    `${table}|${prefix}_update|w|t|{ontos_runtime}|${tenantPolicyPredicate}|${tenantPolicyPredicate}`,
  ]),
  Order.String,
);

it.live('governs the Price Group Catalog with forced RLS and no direct runtime table access', () =>
  Effect.scoped(
    Effect.gen(function* databaseSecurityCatalog() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquirePoolResource(
        () => new Pool({ connectionString: connections.admin.connectionString, max: 1 }),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, priceGroupCatalogRelations);
      const schema = PRICE_GROUP_CATALOG_SCHEMA_NAME;

      const tables = yield* admin.execute<{ enabled: boolean; forced: boolean; name: string }>(
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
      ).toEqual(PRICE_GROUP_CATALOG_TABLE_INVENTORY);
      expect(tables.filter(({ enabled, forced }) => !enabled || !forced)).toEqual([]);

      const grants = yield* admin.execute<{ name: string }>(
        sql`select format('%s:%s', table_name, privilege_type) as name
              from information_schema.role_table_grants
             where grantee = 'ontos_runtime' and table_schema = ${schema}`,
        'objects',
      );
      expect(grants).toEqual([]);

      const executableFunctions = yield* admin.execute<{ definer: boolean; name: string; searchPath: string[] | null }>(
        sql`select format('%s(%s)', proname, pg_catalog.oidvectortypes(pg_proc.proargtypes)) as name,
                   prosecdef as definer,
                   proconfig as "searchPath"
              from pg_proc
              join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
             where nspname = ${schema}
               and has_function_privilege('ontos_runtime', pg_proc.oid, 'EXECUTE')
             order by name`,
        'objects',
      );
      expect(executableFunctions.map(({ name }) => name)).toEqual(expectedRuntimeFunctions);
      expect(executableFunctions.filter(({ definer }) => !definer)).toEqual([]);
      expect(
        executableFunctions.filter(
          ({ searchPath }) => searchPath?.includes('search_path=pg_catalog, pg_temp') !== true,
        ),
      ).toEqual([]);

      const allFunctions = yield* admin.execute<{
        definer: boolean;
        name: string;
        ownerName: string;
        publicExecute: boolean;
        safeSearchPath: boolean;
      }>(
        sql`select format('%s(%s)', routine.proname, pg_catalog.oidvectortypes(routine.proargtypes)) as name,
                   pg_catalog.pg_get_userbyid(routine.proowner) as "ownerName",
                   routine.prosecdef as definer,
                   routine.proconfig = array['search_path=pg_catalog, pg_temp']::text[] as "safeSearchPath",
                   exists (
                     select 1
                     from pg_catalog.aclexplode(
                       coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
                     ) as acl
                     where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
                   ) as "publicExecute"
              from pg_proc as routine
              join pg_namespace as namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = ${schema}
             order by name`,
        'objects',
      );
      expect(allFunctions.map(({ name }) => name)).toEqual(expectedFunctions);
      expect(
        allFunctions.filter(({ definer, name, ownerName, publicExecute, safeSearchPath }) => {
          const expectedDefiner = expectedSecurityDefinerFunctions.has(name);
          return (
            ownerName !== connections.admin.user ||
            publicExecute ||
            definer !== expectedDefiner ||
            (expectedDefiner && !safeSearchPath)
          );
        }),
      ).toEqual([]);

      const policies = yield* admin.execute<{ policy: string }>(
        sql`select concat_ws('|', governed.relname, policy.polname, policy.polcmd, policy.polpermissive,
                     policy.polroles::regrole[]::text,
                     coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
                     coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '')) as policy
              from pg_catalog.pg_policy as policy
              join pg_catalog.pg_class as governed on governed.oid = policy.polrelid
              join pg_catalog.pg_namespace as namespace on namespace.oid = governed.relnamespace
             where namespace.nspname = ${schema}
             order by governed.relname, policy.polname`,
        'objects',
      );
      expect(
        EffectArray.sort(
          policies.map(({ policy }) => policy),
          Order.String,
        ),
      ).toEqual(expectedPolicies);

      const executableHelpers = yield* admin.execute<{ name: string }>(
        sql`select proname as name
              from pg_proc
              join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
             where nspname = ${schema}
               and proname in (
                 'assert_operation_scope', 'definition_json', 'enforce_catalog_fence',
                 'guard_definition_insert', 'guard_interval_insert', 'guard_price_group_update',
                 'guard_retirement_insert', 'reject_append_only_mutation', 'verify_retirement_consistency'
               )
               and has_function_privilege('ontos_runtime', pg_proc.oid, 'EXECUTE')`,
        'objects',
      );
      expect(executableHelpers).toEqual([]);

      const triggers = yield* admin.execute<{ name: string }>(
        sql`select format('%s:%s', relname, tgname) as name
              from pg_trigger
              join pg_class on pg_class.oid = pg_trigger.tgrelid
              join pg_namespace on pg_namespace.oid = pg_class.relnamespace
             where nspname = ${schema} and not tgisinternal
             order by relname, tgname`,
        'objects',
      );
      expect(triggers.map(({ name }) => name)).toEqual(expectedTriggers);

      const exclusions = yield* admin.execute<{ name: string }>(
        sql`select conname as name
              from pg_constraint
              join pg_class on pg_class.oid = pg_constraint.conrelid
              join pg_namespace on pg_namespace.oid = pg_class.relnamespace
             where nspname = ${schema} and contype = 'x'`,
        'objects',
      );
      expect(exclusions).toEqual([{ name: 'price_group_catalog_intervals_no_overlap_excl' }]);
    }),
  ),
);
