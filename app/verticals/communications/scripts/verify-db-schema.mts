import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Array as EffectArray, Effect, Layer, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  COMMUNICATIONS_SCHEMA_NAME,
  COMMUNICATIONS_TABLE_INVENTORY,
  COMMUNICATIONS_TABLES,
  communicationsRelations,
} from '../src/database/schema.ts';

class CommunicationsSchemaVerificationFailed extends Schema.TaggedError<CommunicationsSchemaVerificationFailed>()(
  'CommunicationsSchemaVerificationFailed',
  { reason: Schema.String },
) {}
const failure = (reason: string, cause?: unknown) => {
  const error = new CommunicationsSchemaVerificationFailed({ reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};
const sortedTableInventory = EffectArray.sort(COMMUNICATIONS_TABLE_INVENTORY, Order.String);
const redemptionTable = 'gateway_assertion_redemptions';
// Immutable facts: the runtime role may only read and insert them. An activation may only have its closing columns updated.
const appendOnlyTables = [
  'template_types',
  'template_revisions',
  'template_revision_invalidations',
  'tenant_language_mode_versions',
  'communication_requests',
  'communication_request_conflicts',
  'communication_decisions',
  'message_intents',
  'intent_resend_links',
];
// Written ONLY by scoped routines (the pre-handoff worker's and the history's): the runtime role may read them and nothing else.
const routineWrittenTables = [
  'delivery_attempts',
  'intent_handoff_stops',
  'provider_observations',
  'provider_observation_conflicts',
  'attempt_retry_links',
];
const closableTable = 'template_activations';
// The only columns the runtime role may update: closing an open activation, once. Every other column is immutable.
const closingColumns = ['end_invocation_id', 'end_reason', 'ended_at', 'ended_by_principal_id', 'ended_kind'];
const closedHistoryTrigger = 'communications_template_activations_closed_append_only';
// The scoped routines of the pre-handoff worker and the language mode snapshot: SECURITY DEFINER, pinned search_path,
// static SQL, executable by the runtime role and by nobody else.
const scopedRoutines = [
  'ingest_provider_observation',
  'read_language_policy_snapshot',
  'worker_begin_attempt',
  'worker_finish_attempt',
  'worker_link_retry_attempt',
  'worker_read_intent',
  'worker_read_template_snapshot',
  'worker_record_stop',
];
// Every intake fact rejects an update or delete by trigger, whatever the role; a finished attempt does too.
const intakeAppendOnlyTriggers = [
  'communications_decisions_append_only',
  'communications_handoff_stops_append_only',
  'communications_intents_append_only',
  'communications_request_conflicts_append_only',
  'communications_requests_append_only',
  'communications_attempts_finished_append_only',
  'communications_observations_append_only',
  'communications_observation_conflicts_append_only',
  'communications_resend_links_append_only',
  'communications_retry_links_append_only',
];

const sameList = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const verifyHandoffContract = Effect.fn('Communications.verifyHandoffContract')(function* verifyHandoff() {
  const client = yield* PgClient.PgClient;
  // The contract the review hardening relies on (#1401): a stop is keyed per EVALUATION (never per intent alone, so a later
  // Current evaluation is representable), `proven` is derived from the reasons, NOT_ATTEMPTED is its own attempt state and
  // the begin routine carries the attempt number. An intent key is one unique key per Tenant; its composition (request
  // identity first, so one occurrence under two scopes cannot collide) is code, proved by the integration suite.
  const [contract] = yield* client
    .unsafe<{
      readonly begin_signature: string | null;
      readonly intent_key_unique: string | null;
      readonly legacy_stop_unique: number;
      readonly proven_generated: boolean;
      readonly state_check: string | null;
      readonly stop_unique: string | null;
    }>(
      `
    select
      (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k
        where k.conrelid = 'communications.intent_handoff_stops'::regclass and k.conname = 'communications_handoff_stops_evaluation_uk') as stop_unique,
      (select count(*)::integer from pg_catalog.pg_constraint k
        where k.conrelid = 'communications.intent_handoff_stops'::regclass and k.conname = 'communications_handoff_stops_intent_uk') as legacy_stop_unique,
      (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k
        where k.conrelid = 'communications.message_intents'::regclass and k.conname = 'communications_intents_key_uk') as intent_key_unique,
      (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k
        where k.conrelid = 'communications.delivery_attempts'::regclass and k.conname = 'communications_attempts_state_ck') as state_check,
      exists (select 1 from pg_catalog.pg_attribute a
        where a.attrelid = 'communications.intent_handoff_stops'::regclass and a.attname = 'proven' and a.attgenerated = 's') as proven_generated,
      (select pg_catalog.pg_get_function_identity_arguments(p.oid) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname = 'worker_begin_attempt') as begin_signature`,
      [COMMUNICATIONS_SCHEMA_NAME],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read the Communications handoff contract', cause)));
  if (
    contract === undefined ||
    contract.stop_unique !== 'UNIQUE (tenant_id, intent_id, evaluation_seq)' ||
    contract.legacy_stop_unique !== 0 ||
    contract.intent_key_unique !== 'UNIQUE (tenant_id, intent_key)' ||
    !contract.proven_generated ||
    !(contract.state_check ?? '').includes("'NOT_ATTEMPTED'") ||
    contract.begin_signature !== 'p_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid, p_attempt_number integer'
  ) {
    yield* failure(
      'Communications stop evaluations, attempt states or the begin routine differ from the owner contract',
    );
  }
});

/** Every constraint the history contract depends on, with the fragments its definition must contain (and the exact text of a unique key). */
const OBSERVATIONS = 'provider_observations';
const KIND_LITERALS = ["'ACCEPTANCE_PROVEN'", "'DELIVERY_FAILED'", "'DELIVERY_PROVEN'", "'NON_ACCEPTANCE_PROVEN'"];
const ATTEMPT_FOREIGN_KEY = 'FOREIGN KEY (tenant_id, intent_id, attempt_id)';
const historyConstraints: readonly {
  readonly contains?: readonly string[];
  readonly exact?: string;
  readonly name: string;
  readonly table: string;
}[] = [
  {
    exact: 'UNIQUE (tenant_id, attempt_id, provider_key, observation_key, kind)',
    name: 'communications_observations_provider_identity_uk',
    table: OBSERVATIONS,
  },
  {
    contains: [ATTEMPT_FOREIGN_KEY],
    name: 'communications_observations_attempt_fk',
    table: OBSERVATIONS,
  },
  {
    contains: KIND_LITERALS,
    name: 'communications_observations_kind_ck',
    table: OBSERVATIONS,
  },
  {
    contains: ["'{}'::jsonb", "'BOUNCED_TRANSIENT'", "'PROVIDER_EVENT'", "'RECONCILIATION'"],
    name: 'communications_observations_evidence_ck',
    table: OBSERVATIONS,
  },
  {
    contains: ['observation_key', 'provider_key', 'provider_ref'],
    name: 'communications_observations_keys_ck',
    table: OBSERVATIONS,
  },
  {
    // a delivery or a failure after acceptance rests on a provider event; a proven non-acceptance on a reconciliation
    contains: [
      ...KIND_LITERALS.filter((kind) => kind !== "'ACCEPTANCE_PROVEN'"),
      "'PROVIDER_EVENT'",
      "'RECONCILIATION'",
    ],
    name: 'communications_observations_basis_ck',
    table: OBSERVATIONS,
  },
  {
    exact: 'UNIQUE (tenant_id, observation_id, content_fingerprint)',
    name: 'communications_observation_conflicts_content_uk',
    table: 'provider_observation_conflicts',
  },
  {
    contains: ['FOREIGN KEY (tenant_id, observation_id)'],
    name: 'communications_observation_conflicts_observation_fk',
    table: 'provider_observation_conflicts',
  },
  {
    contains: [ATTEMPT_FOREIGN_KEY],
    name: 'communications_observation_conflicts_attempt_fk',
    table: 'provider_observation_conflicts',
  },
  {
    contains: ['[0-9a-f]{64}'],
    name: 'communications_observation_conflicts_fingerprint_ck',
    table: 'provider_observation_conflicts',
  },
  {
    contains: KIND_LITERALS,
    name: 'communications_observation_conflicts_kind_ck',
    table: 'provider_observation_conflicts',
  },
  {
    contains: [ATTEMPT_FOREIGN_KEY],
    name: 'communications_retry_links_attempt_fk',
    table: 'attempt_retry_links',
  },
  {
    contains: ['FOREIGN KEY (tenant_id, intent_id, previous_attempt_id)'],
    name: 'communications_retry_links_previous_fk',
    table: 'attempt_retry_links',
  },
  {
    contains: ['FOREIGN KEY (tenant_id, basis_observation_id)'],
    name: 'communications_retry_links_basis_fk',
    table: 'attempt_retry_links',
  },
  {
    contains: ['attempt_id <> previous_attempt_id'],
    name: 'communications_retry_links_distinct_ck',
    table: 'attempt_retry_links',
  },
  { contains: ['reason_code'], name: 'communications_retry_links_reason_ck', table: 'attempt_retry_links' },
  {
    // nothing submitted and a provider refusal carry no observation; a reconciled non-acceptance names the one that proved it
    contains: ["'PRIOR_NOT_ATTEMPTED'", "'PRIOR_REJECTED'", "'RECONCILED_NON_ACCEPTANCE'", 'basis_observation_id'],
    name: 'communications_retry_links_basis_ck',
    table: 'attempt_retry_links',
  },
  {
    exact: 'UNIQUE (tenant_id, resend_intent_id)',
    name: 'communications_resend_links_resend_uk',
    table: 'intent_resend_links',
  },
  {
    contains: ['FOREIGN KEY (tenant_id, original_intent_id)'],
    name: 'communications_resend_links_original_fk',
    table: 'intent_resend_links',
  },
  {
    contains: ['FOREIGN KEY (tenant_id, resend_intent_id)'],
    name: 'communications_resend_links_resend_fk',
    table: 'intent_resend_links',
  },
  {
    contains: ['original_intent_id <> resend_intent_id'],
    name: 'communications_resend_links_distinct_ck',
    table: 'intent_resend_links',
  },
  {
    contains: ["'SOURCE_APPROVED_RESEND'"],
    name: 'communications_resend_links_reason_ck',
    table: 'intent_resend_links',
  },
];

/** The history routines and guards: the definer or invoker nature each one must have, and the pinned search path of all. */
const historyRoutines: readonly { readonly definer: boolean; readonly name: string }[] = [
  { definer: true, name: 'ingest_provider_observation' },
  { definer: true, name: 'worker_link_retry_attempt' },
  // the guard runs as the caller, under the Tenant's own row-level security: it must never be a definer
  { definer: false, name: 'enforce_resend_link' },
];

const verifyHistoryContract = Effect.fn('Communications.verifyHistoryContract')(function* verifyHistory() {
  const client = yield* PgClient.PgClient;
  // The contract of the truthful message history (#1402): an observation is identified by (Tenant, attempt, provider,
  // provider observation key, evidence kind) so a repeated callback is one row; it is bound to its attempt AND intent by one
  // composite key; its evidence, keys, kind and basis are CLOSED by checks; a conflicting re-delivery leaves an append-only
  // trace; the retry and resend links keep their keys and checks; the resend link is guarded by its shape trigger; every
  // history routine pins its search_path; and nothing outside the routines can advance a sequence.
  const constraints = yield* client
    .unsafe<{ readonly definition: string; readonly name: string; readonly table_name: string }>(
      `
    select k.conname::text as name, k.conrelid::regclass::text as table_name, pg_catalog.pg_get_constraintdef(k.oid) as definition
    from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid = k.connamespace
    where n.nspname = $1 and k.conname = any($2::text[])`,
      [COMMUNICATIONS_SCHEMA_NAME, historyConstraints.map(({ name }) => name)],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read the Communications history constraints', cause)));
  const definitionOf = new Map(
    constraints.map(({ definition, name, table_name: table }) => [name, { definition, table }]),
  );
  const constraintsDiffer = historyConstraints.some(({ contains, exact, name, table }) => {
    const found = definitionOf.get(name);
    return (
      found === undefined ||
      found.table !== `${COMMUNICATIONS_SCHEMA_NAME}.${table}` ||
      (exact !== undefined && found.definition !== exact) ||
      (contains ?? []).some((fragment) => !found.definition.includes(fragment))
    );
  });
  const [contract] = yield* client
    .unsafe<{
      readonly pinned_routines: number;
      readonly resend_guard_triggers: number;
      readonly sequences_exposed: number;
    }>(
      `
    select
      (select count(*)::integer from pg_catalog.pg_trigger g
        where g.tgrelid = 'communications.intent_resend_links'::regclass and g.tgname = 'communications_resend_links_shape'
          and g.tgenabled = 'O' and not g.tgisinternal and (g.tgtype & 2) = 2 and (g.tgtype & 4) = 4
          and g.tgfoid = 'communications.enforce_resend_link()'::regprocedure) as resend_guard_triggers,
      (select count(*)::integer from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join unnest($2::text[], $3::boolean[]) as expected(name, definer) on expected.name = p.proname
        where n.nspname = $1 and p.prosecdef = expected.definer
          and coalesce(p.proconfig, '{}') @> array['search_path=pg_catalog, pg_temp']) as pinned_routines,
      (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind = 'S' and c.relname = any($4::text[])
          and (has_sequence_privilege('ontos_runtime', c.oid, 'USAGE') or has_sequence_privilege('ontos_runtime', c.oid, 'UPDATE')
            or has_sequence_privilege('ontos_runtime', c.oid, 'SELECT'))) as sequences_exposed`,
      [
        COMMUNICATIONS_SCHEMA_NAME,
        historyRoutines.map(({ name }) => name),
        historyRoutines.map(({ definer }) => definer),
        ['provider_observations_recorded_seq_seq', 'provider_observation_conflicts_recorded_seq_seq'],
      ],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read the Communications history contract', cause)));
  if (
    constraintsDiffer ||
    contract === undefined ||
    contract.resend_guard_triggers !== 1 ||
    contract.pinned_routines !== historyRoutines.length ||
    contract.sequences_exposed !== 0
  ) {
    yield* failure(
      'Communications observation identity, evidence checks, link constraints, routine search paths or resend guard differ from the owner contract',
    );
  }
});

const verify = Effect.gen(function* verifyCommunicationsSchema() {
  const client = yield* PgClient.PgClient;
  const database = yield* makeWithDefaults({ relations: communicationsRelations });
  // Every owner table is also reached through its typed Drizzle reference.
  yield* Effect.forEach(COMMUNICATIONS_TABLES, (table) => database.select().from(table).limit(0), {
    concurrency: 1,
    discard: true,
  }).pipe(Effect.mapError((cause) => failure('A typed Communications table is unreachable', cause)));
  const tables = yield* client
    .unsafe<{ readonly name: string; readonly safe: boolean }>(
      `
    select c.relname as name,
      case when c.relname = $2 then
          not c.relrowsecurity and not c.relforcerowsecurity
          and has_table_privilege('ontos_runtime', c.oid, 'SELECT') and has_table_privilege('ontos_runtime', c.oid, 'INSERT')
          and has_table_privilege('ontos_runtime', c.oid, 'DELETE') and not has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
        when c.relname = any($5::text[]) then
          c.relrowsecurity and c.relforcerowsecurity
          and (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) = 4
          and has_table_privilege('ontos_runtime', c.oid, 'SELECT') and not has_table_privilege('ontos_runtime', c.oid, 'INSERT')
          and not has_table_privilege('ontos_runtime', c.oid, 'DELETE') and not has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
        else
          c.relrowsecurity and c.relforcerowsecurity
          and (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) = 4
          and has_table_privilege('ontos_runtime', c.oid, 'SELECT') and has_table_privilege('ontos_runtime', c.oid, 'INSERT')
          and not has_table_privilege('ontos_runtime', c.oid, 'DELETE') and not has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
          and (c.relname = any($3::text[]) or (
            c.relname = $4
            and has_any_column_privilege('ontos_runtime', c.oid, 'UPDATE')))
        end
      and not has_table_privilege('ontos_runtime', c.oid, 'TRUNCATE')
      and not has_table_privilege('ontos_runtime', c.oid, 'TRIGGER')
      and not has_table_privilege('ontos_runtime', c.oid, 'REFERENCES')
      and not exists (
        select 1 from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
        where acl.grantee = 0
      ) as safe
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind in ('r', 'p') order by c.relname`,
      [COMMUNICATIONS_SCHEMA_NAME, redemptionTable, appendOnlyTables, closableTable, routineWrittenTables],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read the Communications table catalog', cause)));
  if (
    !sameList(
      tables.map((table) => table.name),
      sortedTableInventory,
    ) ||
    tables.some((table) => !table.safe)
  ) {
    return yield* failure(
      'Communications tables, forced RLS, policies or table privileges differ from the owner contract',
    );
  }
  // Column privileges are checked for EVERY column, not a sample: an immutable fact must have no updatable column, and an
  // activation may update exactly its closing columns. Nothing may be referenceable by a column grant either.
  const columns = yield* client
    .unsafe<{
      readonly insertable: number;
      readonly name: string;
      readonly referenceable: number;
      readonly total: number;
      readonly updatable: readonly string[];
    }>(
      `
    select c.relname as name,
      count(*)::integer as total,
      count(*) filter (where has_column_privilege('ontos_runtime', c.oid, a.attnum, 'INSERT'))::integer as insertable,
      count(*) filter (where has_column_privilege('ontos_runtime', c.oid, a.attnum, 'REFERENCES'))::integer as referenceable,
      coalesce(array_agg(a.attname::text order by a.attname)
        filter (where has_column_privilege('ontos_runtime', c.oid, a.attnum, 'UPDATE')), '{}') as updatable
    from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = $1 and c.relkind in ('r', 'p')
    group by c.relname order by c.relname`,
      [COMMUNICATIONS_SCHEMA_NAME],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read the Communications column privileges', cause)));
  if (
    columns.some(
      (table) =>
        table.insertable !== (routineWrittenTables.includes(table.name) ? 0 : table.total) ||
        table.referenceable !== 0 ||
        !sameList(table.updatable, table.name === closableTable ? closingColumns : []),
    )
  ) {
    return yield* failure('Communications column privileges differ from the owner contract');
  }
  const [infrastructure] = yield* client
    .unsafe<{
      readonly closed_history_triggers: number;
      readonly intake_triggers: number;
      readonly journal: number;
      readonly public_routines: number;
      readonly safe_role: boolean;
      readonly safe_routines: number;
      readonly safe_schema: boolean;
      readonly unvalidated_constraints: number;
    }>(
      `
    select
      (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations_communications') as journal,
      not r.rolsuper and not r.rolbypassrls as safe_role,
      has_schema_privilege('ontos_runtime', $1, 'USAGE') and not has_schema_privilege('ontos_runtime', $1, 'CREATE') as safe_schema,
      (select count(*)::integer from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1
          and exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl where acl.grantee = 0)) as public_routines,
      (select count(*)::integer from pg_catalog.pg_trigger g
        join pg_catalog.pg_class gc on gc.oid = g.tgrelid join pg_catalog.pg_namespace gn on gn.oid = gc.relnamespace
        where gn.nspname = $1 and gc.relname = $2 and g.tgname = $3 and g.tgenabled = 'O' and not g.tgisinternal
          and (g.tgtype & 2) = 2 and (g.tgtype & 16) = 16 and (g.tgtype & 8) = 8) as closed_history_triggers,
      (select count(*)::integer from pg_catalog.pg_trigger g
        join pg_catalog.pg_class gc on gc.oid = g.tgrelid join pg_catalog.pg_namespace gn on gn.oid = gc.relnamespace
        where gn.nspname = $1 and g.tgname = any($4::text[]) and g.tgenabled = 'O' and not g.tgisinternal
          and (g.tgtype & 2) = 2 and (g.tgtype & 16) = 16 and (g.tgtype & 8) = 8) as intake_triggers,
      (select count(*)::integer from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname = any($5::text[]) and p.prosecdef
          and coalesce(p.proconfig, '{}') @> array['search_path=pg_catalog, pg_temp']
          and has_function_privilege('ontos_runtime', p.oid, 'EXECUTE')
          and not exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl where acl.grantee = 0)) as safe_routines,
      (select count(*)::integer from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid = k.connamespace
        where n.nspname = $1 and not k.convalidated) as unvalidated_constraints
    from pg_catalog.pg_roles r where r.rolname = 'ontos_runtime'`,
      [COMMUNICATIONS_SCHEMA_NAME, closableTable, closedHistoryTrigger, intakeAppendOnlyTriggers, scopedRoutines],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read Communications infrastructure', cause)));
  if (
    infrastructure === undefined ||
    infrastructure.journal !== 1 ||
    !infrastructure.safe_role ||
    !infrastructure.safe_schema ||
    infrastructure.public_routines !== 0 ||
    infrastructure.closed_history_triggers !== 1 ||
    infrastructure.intake_triggers !== intakeAppendOnlyTriggers.length ||
    infrastructure.safe_routines !== scopedRoutines.length ||
    infrastructure.unvalidated_constraints !== 0
  ) {
    return yield* failure('Communications journal, role, schema, routine privileges or constraints are unsafe');
  }
  yield* verifyHandoffContract();
  yield* verifyHistoryContract();
  return COMMUNICATIONS_TABLES.length;
});

const databaseLayer = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* connectCommunicationsVerifier() {
    const connections = yield* loadDatabaseConnectionPair();
    return yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }).pipe(
      Effect.mapError((cause) => failure('Unable to connect the Communications verifier', cause)),
    );
  }),
).pipe(Layer.provide(Reactivity.layer));
const tableCount = await Effect.runPromise(
  verify.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Reactivity.layer, databaseLayer))),
);
process.stdout.write(
  `Verified ${tableCount} communications tables: replay ledger, append-only template, intake and history facts least privilege down to every column, the closed-activation and finished-attempt history triggers, the hardened scoped worker routines, forced RLS on every governed table and validated constraints\n`,
);
