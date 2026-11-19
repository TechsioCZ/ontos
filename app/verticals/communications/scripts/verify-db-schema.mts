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
      [COMMUNICATIONS_SCHEMA_NAME, redemptionTable],
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
  const [infrastructure] = yield* client
    .unsafe<{
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
      (select count(*)::integer from pg_catalog.pg_constraint k join pg_catalog.pg_namespace n on n.oid = k.connamespace
        where n.nspname = $1 and not k.convalidated) as unvalidated_constraints
    from pg_catalog.pg_roles r where r.rolname = 'ontos_runtime'`,
      [COMMUNICATIONS_SCHEMA_NAME],
    )
    .pipe(Effect.mapError((cause) => failure('Unable to read Communications infrastructure', cause)));
  if (
    infrastructure === undefined ||
    infrastructure.journal !== 1 ||
    !infrastructure.safe_role ||
    !infrastructure.safe_schema ||
    infrastructure.public_routines !== 0 ||
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
  `Verified ${tableCount} communications tables: replay ledger least privilege, forced RLS on every governed table and validated constraints\n`,
);
