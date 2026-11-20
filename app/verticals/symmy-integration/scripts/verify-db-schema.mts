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
  symmyRouteEnrollmentRecords,
  symmySyncAdmissionAttempts,
  symmyJobPrivacyExecutions,
  symmyJobNotifications,
  symmyJobRetentionTombstones,
  symmySyncAdmissions,
} from '../src/db/schema.ts';
import { ROUTE_ENROLLMENT_RECORD_CHECKS, normalizeConstraintDefinition } from './route-enrollment-record-checks.mts';

class SymmySchemaVerificationError extends Schema.TaggedError<SymmySchemaVerificationError>()(
  'SymmySchemaVerificationError',
  { reason: Schema.String },
) {}

/**
 * The enrollment records keep their key, route index and check definitions, and the change tokens come from a sequence
 * no other role may use, which gives every route row its token by default.
 */
const verifyRouteEnrollmentRecords = Effect.fn('SymmySchema.verifyRouteEnrollmentRecords')(function* verifyRecords(
  client: PgClient.PgClient,
) {
  const [records] = yield* client<{
    readonly change_token_default: boolean;
    readonly change_token_sequence: boolean;
    readonly change_token_sequence_private: boolean;
    readonly constraints: readonly string[] | null;
    readonly primary_key: boolean;
    readonly route_index: boolean;
  }>`
    select
      (select array_agg(c.conname::text || ':' || c.contype::text || ':' || c.convalidated::text order by c.conname)
        from pg_catalog.pg_constraint c
        where c.conrelid = 'symmy_integration.route_enrollment_records'::regclass and c.contype <> 'n') as constraints,
      exists(select 1 from pg_catalog.pg_constraint c join pg_catalog.pg_attribute a
          on a.attrelid = c.conrelid and a.attname = 'record_id'
        where c.conrelid = 'symmy_integration.route_enrollment_records'::regclass and c.contype = 'p'
          and c.conkey = array[a.attnum]) as primary_key,
      exists(select 1 from pg_catalog.pg_index i join pg_catalog.pg_class x on x.oid = i.indexrelid
        where i.indrelid = 'symmy_integration.route_enrollment_records'::regclass
          and x.relname = 'symmy_route_enrollment_records_route_idx' and not i.indisunique and i.indisvalid
          and i.indpred is null and i.indexprs is null
          and (select array_agg(a.attname::text order by k.ord)
            from unnest(i.indkey) with ordinality k(attnum, ord)
            join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
            = array['tenant_id', 'route_id', 'recorded_at']) as route_index,
      exists(select 1 from pg_catalog.pg_sequences s
        where s.schemaname = 'symmy_integration' and s.sequencename = 'job_route_change_tokens' and not s.cycle
          and s.increment_by = 1 and s.min_value = 1 and s.max_value = 2147483647 and s.cache_size = 1
          and s.sequenceowner = (select pg_catalog.pg_get_userbyid(t.relowner) from pg_catalog.pg_class t
            where t.oid = 'symmy_integration.job_routes'::regclass)) as change_token_sequence,
      not exists(select 1 from pg_catalog.pg_class c
        cross join lateral aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
        where c.oid = 'symmy_integration.job_route_change_tokens'::regclass and a.grantee <> c.relowner)
        as change_token_sequence_private,
      exists(select 1 from pg_catalog.pg_attrdef d
        join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        join pg_catalog.pg_depend dep on dep.classid = 'pg_catalog.pg_attrdef'::regclass and dep.objid = d.oid
        where d.adrelid = 'symmy_integration.job_routes'::regclass and a.attname = 'change_token'
          and dep.refobjid = 'symmy_integration.job_route_change_tokens'::regclass) as change_token_default
  `;
  if (
    !records?.primary_key ||
    !records.route_index ||
    !records.change_token_sequence ||
    !records.change_token_sequence_private ||
    !records.change_token_default ||
    records.constraints?.join(',') !==
      [
        'route_enrollment_records_pkey:p:true',
        'symmy_route_enrollment_records_change_ck:c:true',
        'symmy_route_enrollment_records_text_ck:c:true',
      ].join(',')
  ) {
    yield* new SymmySchemaVerificationError({
      reason: 'Symmy route enrollment record key, index or constraints, or the change token sequence, mismatch',
    });
  }
  const checks = yield* client<{ readonly definition: string; readonly name: string }>`
    select c.conname as name, pg_catalog.pg_get_constraintdef(c.oid) as definition
    from pg_catalog.pg_constraint c
    where c.conrelid = 'symmy_integration.route_enrollment_records'::regclass and c.contype = 'c'
  `;
  // Each mismatch prints PostgreSQL's own text, so one failed run shows the exact definition to compare with.
  const mismatches = ROUTE_ENROLLMENT_RECORD_CHECKS.flatMap(([name, expected]) => {
    const actual = checks.find((check) => check.name === name)?.definition;
    return actual !== undefined && normalizeConstraintDefinition(actual) === normalizeConstraintDefinition(expected)
      ? []
      : [`constraint: ${name}`, `expected: ${expected}`, `actual: ${actual ?? '(none)'}`];
  });
  if (mismatches.length > 0) {
    yield* new SymmySchemaVerificationError({
      reason: ['Symmy route enrollment record check definitions mismatch', ...mismatches].join('\n'),
    });
  }
});

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
  yield* database.select().from(symmyRouteEnrollmentRecords).limit(0);
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
          ![
            'job_notifications',
            'job_retention_tombstones',
            'privacy_measure_executions',
            'route_enrollment_records',
          ].includes(name) ||
        unsafe_mutation,
    )
  ) {
    yield* new SymmySchemaVerificationError({
      reason: 'Symmy table inventory, scope or runtime grants mismatch',
    });
  }
  const [runtime] = yield* client<{
    readonly journal_exists: boolean;
    readonly record_guard_trigger_enabled: boolean;
    readonly record_truncate_trigger_enabled: boolean;
    readonly route_change_token_trigger_enabled: boolean;
    readonly route_gate_trigger_enabled: boolean;
    readonly schema_create: boolean;
    readonly schema_usage: boolean;
  }>`
    select to_regclass('drizzle.__drizzle_migrations_symmy_integration') is not null as journal_exists,
      exists(select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = 'symmy_integration.job_routes'::regclass
          and t.tgname = 'symmy_job_route_publish_execution_gate' and t.tgenabled = 'O'
          and t.tgtype = 29 -- row-level AFTER INSERT, UPDATE and DELETE
          and t.tgfoid = to_regprocedure('symmy_integration.publish_route_execution_gate()'))
        as route_gate_trigger_enabled,
      exists(select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = 'symmy_integration.job_routes'::regclass
          and t.tgname = 'symmy_job_routes_change_token' and t.tgenabled = 'O'
          and t.tgtype = 23 -- row-level BEFORE INSERT and UPDATE
          and t.tgfoid = to_regprocedure('symmy_integration.advance_route_change_token()'))
        as route_change_token_trigger_enabled,
      exists(select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = 'symmy_integration.route_enrollment_records'::regclass
          and t.tgname = 'symmy_route_enrollment_records_guard' and t.tgenabled = 'O'
          and t.tgtype = 31 -- row-level BEFORE INSERT, UPDATE and DELETE
          and t.tgfoid = to_regprocedure('symmy_integration.guard_route_enrollment_record()'))
        as record_guard_trigger_enabled,
      exists(select 1 from pg_catalog.pg_trigger t
        where t.tgrelid = 'symmy_integration.route_enrollment_records'::regclass
          and t.tgname = 'symmy_route_enrollment_records_no_truncate' and t.tgenabled = 'O'
          and t.tgtype = 34 -- statement-level BEFORE TRUNCATE
          and t.tgfoid = to_regprocedure('symmy_integration.guard_route_enrollment_record()'))
        as record_truncate_trigger_enabled,
      has_schema_privilege('ontos_runtime', 'symmy_integration', 'CREATE') as schema_create,
      has_schema_privilege('ontos_runtime', 'symmy_integration', 'USAGE') as schema_usage
  `;
  if (
    !runtime?.journal_exists ||
    !runtime.route_gate_trigger_enabled ||
    !runtime.route_change_token_trigger_enabled ||
    !runtime.record_guard_trigger_enabled ||
    !runtime.record_truncate_trigger_enabled ||
    !runtime.schema_usage ||
    runtime.schema_create
  ) {
    yield* new SymmySchemaVerificationError({
      reason:
        'Symmy migration journal, route gate, change token or record triggers, or runtime schema privileges mismatch',
    });
  }
  yield* verifyRouteEnrollmentRecords(client);
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
    'advance_route_change_token',
    'can_execute_symmy_job_effect',
    'claim_symmy_job_effect',
    'claim_symmy_job_notification',
    'erase_symmy_effect_payload',
    'erase_symmy_plan_payload',
    'guard_route_enrollment_record',
    'lock_symmy_enrollment_snapshot',
    'lock_symmy_privacy_execution',
    'mark_symmy_job_effect_blocked',
    'mark_symmy_job_effect_indeterminate',
    'mark_symmy_job_effect_unavailable',
    'pin_symmy_fixture_plan',
    'publish_route_execution_gate',
    'purge_symmy_job_intents',
    'purge_symmy_sync_intents',
    'read_symmy_job_execution',
    'read_symmy_job_lifecycle',
    'read_symmy_job_notification_wake',
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
          ![
            'publish_route_execution_gate',
            'symmy_original_route_active',
            'erase_symmy_effect_payload',
            'erase_symmy_plan_payload',
            'guard_route_enrollment_record',
            'advance_route_change_token',
          ].includes(routine.name) ||
        routine.definer !==
          ![
            'symmy_source_selector_code',
            'pin_symmy_fixture_plan',
            'publish_route_execution_gate',
            'symmy_original_route_active',
            'erase_symmy_effect_payload',
            'erase_symmy_plan_payload',
            'guard_route_enrollment_record',
            'advance_route_change_token',
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
