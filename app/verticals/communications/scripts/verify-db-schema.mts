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
];
const closableTable = 'template_activations';
// The only columns the runtime role may update: closing an open activation, once. Every other column is immutable.
const closingColumns = ['end_invocation_id', 'end_reason', 'ended_at', 'ended_by_principal_id', 'ended_kind'];
const closedHistoryTrigger = 'communications_template_activations_closed_append_only';

const sameList = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

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
      [COMMUNICATIONS_SCHEMA_NAME, redemptionTable, appendOnlyTables, closableTable],
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
        table.insertable !== table.total ||
        table.referenceable !== 0 ||
        !sameList(table.updatable, table.name === closableTable ? closingColumns : []),
    )
  ) {
    return yield* failure('Communications column privileges differ from the owner contract');
  }
  const [infrastructure] = yield* client
    .unsafe<{
      readonly closed_history_triggers: number;
      readonly journal: number;
      readonly public_routines: number;
      readonly safe_role: boolean;
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
      (select count(*)::integer from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid = k.connamespace
        where n.nspname = $1 and not k.convalidated) as unvalidated_constraints
    from pg_catalog.pg_roles r where r.rolname = 'ontos_runtime'`,
      [COMMUNICATIONS_SCHEMA_NAME, closableTable, closedHistoryTrigger],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read Communications infrastructure', cause)));
  if (
    infrastructure === undefined ||
    infrastructure.journal !== 1 ||
    !infrastructure.safe_role ||
    !infrastructure.safe_schema ||
    infrastructure.public_routines !== 0 ||
    infrastructure.closed_history_triggers !== 1 ||
    infrastructure.unvalidated_constraints !== 0
  ) {
    return yield* failure('Communications journal, role, schema, routine privileges or constraints are unsafe');
  }
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
  `Verified ${tableCount} communications tables: replay ledger and append-only template facts least privilege down to every column, the closed-activation history trigger, forced RLS on every governed table and validated constraints\n`,
);
