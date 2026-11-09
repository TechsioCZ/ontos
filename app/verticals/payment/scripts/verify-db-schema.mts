import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Array as EffectArray, Effect, Layer, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  PAYMENT_SCHEMA_NAME,
  PAYMENT_TABLE_INVENTORY,
  PAYMENT_TABLES,
  paymentRelations,
} from '../src/database/schema.ts';

class PaymentSchemaVerificationFailed extends Schema.TaggedError<PaymentSchemaVerificationFailed>()(
  'PaymentSchemaVerificationFailed',
  { reason: Schema.String },
) {}
const failure = (reason: string, cause?: unknown) => {
  const error = new PaymentSchemaVerificationFailed({ reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};
const sortedTableInventory = EffectArray.sort(PAYMENT_TABLE_INVENTORY, Order.String);
const redemptionTable = 'gateway_assertion_redemptions';
const expectedTriggers = EffectArray.sort(
  [
    'payment_authorizations_append_only',
    'payment_method_enablement_revisions_append_only',
    'payment_method_enablements_no_delete',
    'payment_method_enablements_transition',
    'payment_observations_append_only',
    'payment_operations_lineage',
    'payment_operations_no_delete',
    'payment_operations_transition',
    'payment_outcome_transitions_append_only',
    'payment_outcome_transitions_durable_work',
    'payment_payments_no_delete',
    'payment_payments_transition',
    'payment_reconciliation_cases_no_delete',
    'payment_reconciliation_cases_transition',
    'payment_reconciliation_decisions_append_only',
    'payment_recovery_requests_append_only',
    'payment_refund_item_claims_no_delete',
    'payment_refund_item_claims_transition',
    'payment_source_authorities_no_delete',
    'payment_source_authorities_transition',
    'payment_source_authority_revisions_append_only',
  ],
  Order.String,
);
/** The only runtime-updatable columns; every other business column is insert-once. */
const updatableColumns = EffectArray.sort(
  [
    'method_enablements.action_invocation_id',
    'method_enablements.actor_principal_id',
    'method_enablements.composition_revision',
    'method_enablements.configured_at',
    'method_enablements.enabled',
    'method_enablements.reason',
    'method_enablements.revision',
    'payment_operations.outcome',
    'payment_operations.outcome_revision',
    'payments.aggregate_version',
    'payments.coverage_revision',
    'reconciliation_cases.closed_at',
    'reconciliation_cases.revision',
    'reconciliation_cases.status',
    'refund_item_claims.active',
    'refund_item_claims.released_at',
    'refund_item_claims.released_by_action_invocation_id',
    'source_authorities.action_invocation_id',
    'source_authorities.actor_principal_id',
    'source_authorities.composition_revision',
    'source_authorities.configured_at',
    'source_authorities.reason',
    'source_authorities.refund_route',
    'source_authorities.revision',
    'source_authorities.status',
  ],
  Order.String,
);
const requiredUniqueIndexes = [
  'payment_operations_one_collect_lineage_uk',
  'payment_refund_item_claims_active_item_uk',
] as const;

const sameList = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const verify = Effect.gen(function* verifyPaymentSchema() {
  const client = yield* PgClient.PgClient;
  const database = yield* makeWithDefaults({ relations: paymentRelations });
  // Every owner table is also reached through its typed Drizzle reference.
  yield* Effect.forEach(PAYMENT_TABLES, (table) => database.select().from(table).limit(0), {
    concurrency: 1,
    discard: true,
  }).pipe(Effect.mapError((cause) => failure('A typed Payment table is unreachable', cause)));
  const tables = yield* client
    .unsafe<{ readonly name: string; readonly safe: boolean }>(
      `
    select c.relname as name,
      case when c.relname = $2 then
          not c.relrowsecurity and not c.relforcerowsecurity
          and has_table_privilege('ontos_runtime', c.oid, 'SELECT') and has_table_privilege('ontos_runtime', c.oid, 'INSERT')
          and has_table_privilege('ontos_runtime', c.oid, 'DELETE') and not has_table_privilege('ontos_runtime', c.oid, 'UPDATE')
        else
          c.relrowsecurity and c.relforcerowsecurity
          and has_table_privilege('ontos_runtime', c.oid, 'SELECT') and has_table_privilege('ontos_runtime', c.oid, 'INSERT')
          and not has_table_privilege('ontos_runtime', c.oid, 'DELETE')
          and (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) = 4
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
      [PAYMENT_SCHEMA_NAME, redemptionTable],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read the Payment table catalog', cause)));
  if (
    !sameList(
      tables.map((table) => table.name),
      sortedTableInventory,
    ) ||
    tables.some((table) => !table.safe)
  ) {
    return yield* failure('Payment tables, forced RLS, policies or table privileges differ from the owner contract');
  }
  const columns = yield* client
    .unsafe<{ readonly name: string }>(
      `
    select c.relname || '.' || a.attname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = $1 and c.relkind in ('r', 'p') and c.relname <> $2
      and has_column_privilege('ontos_runtime', c.oid, a.attnum, 'UPDATE')
    order by 1`,
      [PAYMENT_SCHEMA_NAME, redemptionTable],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read Payment column privileges', cause)));
  if (
    !sameList(
      columns.map((column) => column.name),
      updatableColumns,
    )
  ) {
    return yield* failure('Payment runtime column update privileges differ from the owner contract');
  }
  const triggers = yield* client
    .unsafe<{ readonly name: string }>(
      `select t.tgname as name from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and not t.tgisinternal order by t.tgname`,
      [PAYMENT_SCHEMA_NAME],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read Payment triggers', cause)));
  if (
    !sameList(
      triggers.map((trigger) => trigger.name),
      expectedTriggers,
    )
  ) {
    return yield* failure('Payment append-only and transition triggers differ from the owner contract');
  }
  const [infrastructure] = yield* client
    .unsafe<{
      readonly journal: number;
      readonly partial_unique_indexes: number;
      readonly public_routines: number;
      readonly safe_role: boolean;
      readonly safe_schema: boolean;
      readonly unvalidated_constraints: number;
    }>(
      `
    select
      (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations_payment') as journal,
      not r.rolsuper and not r.rolbypassrls as safe_role,
      has_schema_privilege('ontos_runtime', $1, 'USAGE') and not has_schema_privilege('ontos_runtime', $1, 'CREATE') as safe_schema,
      (select count(*)::integer from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and i.indisunique and i.indpred is not null and c.relname = any($2::text[])) as partial_unique_indexes,
      (select count(*)::integer from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and (has_function_privilege('ontos_runtime', p.oid, 'EXECUTE')
          or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl where acl.grantee = 0))) as public_routines,
      (select count(*)::integer from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid = k.connamespace
        where n.nspname = $1 and not k.convalidated) as unvalidated_constraints
    from pg_catalog.pg_roles r where r.rolname = 'ontos_runtime'`,
      [PAYMENT_SCHEMA_NAME, `{${requiredUniqueIndexes.join(',')}}`],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read Payment infrastructure', cause)));
  if (
    infrastructure === undefined ||
    infrastructure.journal !== 1 ||
    !infrastructure.safe_role ||
    !infrastructure.safe_schema ||
    infrastructure.partial_unique_indexes !== requiredUniqueIndexes.length ||
    infrastructure.public_routines !== 0 ||
    infrastructure.unvalidated_constraints !== 0
  ) {
    return yield* failure(
      'Payment journal, role, schema, partial unique, routine privileges or constraint validation are unsafe',
    );
  }
  return PAYMENT_TABLES.length;
});

const databaseLayer = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* connectPaymentVerifier() {
    const connections = yield* loadDatabaseConnectionPair();
    return yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }).pipe(
      Effect.mapError((cause) => failure('Unable to connect the Payment verifier', cause)),
    );
  }),
).pipe(Layer.provide(Reactivity.layer));
const tableCount = await Effect.runPromise(
  verify.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Reactivity.layer, databaseLayer))),
);
process.stdout.write(
  `Verified ${tableCount} payment tables: forced RLS, least privilege, append-only ledgers, collect lineage and validated constraints\n`,
);
