import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  SYMMY_INTEGRATION_TABLES,
  gatewayAssertionRedemptions,
  symmyImportJobs,
  symmyIntegrationRelations,
  symmyJobEffects,
  symmyJobRoutes,
  symmySyncAdmissionAttempts,
  symmyJobPrivacyExecutions,
  symmyJobNotifications,
  symmyJobRetentionTombstones,
  symmySyncAdmissions,
} from '../src/db/schema.ts';

class SymmySchemaVerificationError extends Schema.TaggedError<SymmySchemaVerificationError>()(
  'SymmySchemaVerificationError',
  { reason: Schema.String },
) {}

const verification = Effect.gen(function* verifySymmySchema() {
  const client = yield* PgClient.PgClient;
  const database = yield* makeWithDefaults({ relations: symmyIntegrationRelations });
  yield* database.select().from(gatewayAssertionRedemptions).limit(0);
  yield* database.select().from(symmyImportJobs).limit(0);
  yield* database.select().from(symmyJobRoutes).limit(0);
  yield* database.select().from(symmyJobEffects).limit(0);
  yield* database.select().from(symmyJobNotifications).limit(0);
  yield* database.select().from(symmyJobRetentionTombstones).limit(0);
  yield* database.select().from(symmySyncAdmissions).limit(0);
  yield* database.select().from(symmySyncAdmissionAttempts).limit(0);
  yield* database.select().from(symmyJobPrivacyExecutions).limit(0);
  // The catalog is used only by this operator-side verifier.
  const tables = yield* client<{
    readonly enabled: boolean;
    readonly forced: boolean;
    readonly insert_allowed: boolean;
    readonly name: string;
    readonly read_allowed: boolean;
    readonly unsafe_mutation: boolean;
  }>`
    select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
      has_table_privilege('ontos_runtime', c.oid, 'SELECT') as read_allowed,
      has_table_privilege('ontos_runtime', c.oid, 'INSERT') as insert_allowed,
      (
        has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
        or has_table_privilege('ontos_runtime', c.oid, 'DELETE')
        or has_table_privilege('ontos_runtime', c.oid, 'TRUNCATE')
        or has_table_privilege('ontos_runtime', c.oid, 'REFERENCES')
        or has_table_privilege('ontos_runtime', c.oid, 'TRIGGER')
      ) as unsafe_mutation
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'symmy_integration' and c.relkind in ('r', 'p')
    order by c.relname
  `;
  if (
    tables.length !== SYMMY_INTEGRATION_TABLES.length ||
    tables.some(
      ({ enabled, forced, insert_allowed, name, read_allowed, unsafe_mutation }, position) =>
        name !== SYMMY_INTEGRATION_TABLES[position] ||
        enabled !== (name !== 'gateway_assertion_redemptions') ||
        forced !== (name !== 'gateway_assertion_redemptions') ||
        insert_allowed !==
          [
            'gateway_assertion_redemptions',
            'import_jobs',
            'job_effects',
            'sync_admissions',
            'sync_admission_attempts',
          ].includes(name) ||
        read_allowed !==
          !['job_notifications', 'job_retention_tombstones', 'privacy_measure_executions'].includes(name) ||
        unsafe_mutation,
    )
  ) {
    yield* new SymmySchemaVerificationError({
      reason: 'Symmy table inventory, scope or runtime grants mismatch',
    });
  }
  const [runtime] = yield* client<{
    readonly journal_exists: boolean;
    readonly schema_create: boolean;
    readonly schema_usage: boolean;
  }>`
    select to_regclass('drizzle.__drizzle_migrations_symmy_integration') is not null as journal_exists,
      has_schema_privilege('ontos_runtime', 'symmy_integration', 'CREATE') as schema_create,
      has_schema_privilege('ontos_runtime', 'symmy_integration', 'USAGE') as schema_usage
  `;
  if (!runtime?.journal_exists || !runtime.schema_usage || runtime.schema_create) {
    yield* new SymmySchemaVerificationError({
      reason: 'Symmy migration journal or runtime schema privileges mismatch',
    });
  }
  const routines = yield* client<{
    readonly definer: boolean;
    readonly name: string;
    readonly public_execute: boolean;
    readonly runtime_execute: boolean;
    readonly safe_settings: boolean;
  }>`
    select p.proname as name, p.prosecdef as definer,
      exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
      has_function_privilege('ontos_runtime', p.oid, 'EXECUTE') as runtime_execute,
      p.proconfig @> array['search_path=pg_catalog, symmy_integration, pg_temp']
        and (not p.prosecdef or p.proconfig @> array['row_security=on']) as safe_settings
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'symmy_integration' order by p.proname
  `;
  const routineNames = [
    'can_execute_symmy_job_effect',
    'claim_symmy_job_effect',
    'claim_symmy_job_notification',
    'erase_symmy_effect_payload',
    'erase_symmy_plan_payload',
    'lock_symmy_enrollment_snapshot',
    'lock_symmy_privacy_execution',
    'mark_symmy_job_effect_blocked',
    'mark_symmy_job_effect_indeterminate',
    'pin_symmy_fixture_plan',
    'purge_symmy_job_intents',
    'purge_symmy_sync_intents',
    'read_symmy_job_execution',
    'read_symmy_job_lifecycle',
    'read_symmy_privacy_execution',
    'read_symmy_sync_lifecycle',
    'record_symmy_owner_executor',
    'record_symmy_owner_invocation',
    'record_symmy_owner_receipt',
    'record_symmy_owner_request',
    'record_symmy_privacy_execution',
    'record_symmy_resolved_effect',
    'settle_symmy_job_effect',
    'settle_symmy_job_notification',
    'symmy_original_route_active',
    'symmy_source_selector_code',
  ];
  if (
    routines.length !== routineNames.length ||
    routines.some(
      (routine, index) =>
        routine.name !== routineNames[index] ||
        routine.public_execute ||
        !routine.safe_settings ||
        routine.runtime_execute !==
          !['symmy_original_route_active', 'erase_symmy_effect_payload', 'erase_symmy_plan_payload'].includes(
            routine.name,
          ) ||
        routine.definer !==
          ![
            'symmy_source_selector_code',
            'pin_symmy_fixture_plan',
            'symmy_original_route_active',
            'erase_symmy_effect_payload',
            'erase_symmy_plan_payload',
          ].includes(routine.name),
    )
  ) {
    yield* new SymmySchemaVerificationError({ reason: 'Symmy execution routine inventory or runtime grants mismatch' });
  }
});

const adminClientLive = Layer.unwrap(
  loadDatabaseConnectionPair().pipe(
    Effect.map((connections) => PgClient.layer({ url: Redacted.make(connections.admin.connectionString) })),
  ),
);
await Effect.runPromise(
  verification.pipe(
    Effect.provide(adminClientLive),
    Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer)),
  ),
);
