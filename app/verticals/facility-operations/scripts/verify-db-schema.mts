/// <reference types="node" />
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Console, Effect, Exit, Layer, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import {
  agendaStates,
  facilityOperationsRelations,
  files,
  gatewayAssertionRedemptions,
} from '../src/database/schema.ts';

class FacilitySchemaVerificationError extends Schema.TaggedError<FacilitySchemaVerificationError>()(
  'FacilitySchemaVerificationError',
  { reason: Schema.String },
) {}

const ownerSchema = 'facility_operations';
const journalName = '__drizzle_migrations_facility_operations';
const tables = [agendaStates, files, gatewayAssertionRedemptions];
const businessTables = [agendaStates, files];
const normalizeExpression = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[\s()"]/gu, '')
    .replaceAll('::text', '');

const requireCondition = (condition: boolean, reason: string) =>
  condition ? Effect.void : Effect.fail(new FacilitySchemaVerificationError({ reason }));

const requireInventory = (actual: readonly string[], expected: readonly string[], reason: string) => {
  const sortedActual = EffectArray.sort(actual, Order.String);
  const sortedExpected = EffectArray.sort(expected, Order.String);
  return requireCondition(
    sortedActual.length === sortedExpected.length &&
      sortedActual.every((value, index) => value === sortedExpected[index]),
    reason,
  );
};

interface TableRow {
  readonly business_rls: boolean;
  readonly grants_safe: boolean;
  readonly owner: string;
  readonly table_name: string;
}

interface PolicyRow {
  readonly check_expression: string | null;
  readonly command: string;
  readonly permissive: boolean;
  readonly policy_name: string;
  readonly roles: string[];
  readonly table_name: string;
  readonly using_expression: string | null;
}

// Catalog SQL is infrastructure metadata; all owner-table reads below use typed Drizzle references.
const verifyCatalog = (adminUser: string, runtimeUser: string) =>
  Effect.gen(function* verifyFacilityCatalog() {
    const client = yield* PgClient.PgClient;
    const catalog = yield* client.unsafe<TableRow>(
      `select c.relname as table_name, pg_get_userbyid(c.relowner) as owner,
        case when c.relname = 'gateway_assertion_redemptions'
          then not c.relrowsecurity and not c.relforcerowsecurity
          else c.relrowsecurity and c.relforcerowsecurity end as business_rls,
        (has_table_privilege($2, c.oid, 'SELECT')
          and has_table_privilege($2, c.oid, 'INSERT')
          and has_table_privilege($2, c.oid, 'DELETE')
          and has_table_privilege($2, c.oid, 'UPDATE') = (c.relname <> 'gateway_assertion_redemptions')
          and has_any_column_privilege($2, c.oid, 'UPDATE') = (c.relname <> 'gateway_assertion_redemptions')
          and not has_table_privilege($2, c.oid, 'TRUNCATE')
          and not has_table_privilege($2, c.oid, 'REFERENCES')
          and not has_table_privilege($2, c.oid, 'TRIGGER')) as grants_safe
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')`,
      [ownerSchema, runtimeUser],
    );
    yield* requireInventory(
      catalog.map((row) => row.table_name),
      tables.map((table) => getTableConfig(table).name),
      'Owner table inventory mismatch',
    );
    for (const row of catalog) {
      yield* requireCondition(row.owner === adminUser, `Admin ownership mismatch: ${row.table_name}`);
      yield* requireCondition(row.business_rls, `RLS posture mismatch: ${row.table_name}`);
      yield* requireCondition(row.grants_safe, `Runtime grants mismatch: ${row.table_name}`);
    }

    const columns = yield* client.unsafe<{ column_name: string; required: boolean; table_name: string }>(
      `select c.relname as table_name, a.attname as column_name, a.attnotnull as required
       from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`,
      [ownerSchema],
    );
    yield* requireInventory(
      columns.map((row) => `${row.table_name}.${row.column_name}.${row.required}`),
      tables.flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns.map((column) => `${config.name}.${column.name}.${column.notNull}`);
      }),
      'Owner column inventory or nullability mismatch',
    );

    const journals = yield* client.unsafe<{ journal_name: string; owner: string }>(
      `select c.relname as journal_name, pg_get_userbyid(c.relowner) as owner
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'drizzle' and starts_with(c.relname, $1) and c.relkind in ('r', 'p')`,
      [journalName],
    );
    yield* requireInventory(
      journals.map((row) => `${row.journal_name}.${row.owner}`),
      [`${journalName}.${adminUser}`],
      'Owner migration journal inventory or ownership mismatch',
    );

    const [role] = yield* client.unsafe<{ safe: boolean }>(
      `select (r.rolname = 'ontos_runtime' and not r.rolsuper and not r.rolbypassrls
         and not r.rolcreaterole and not r.rolcreatedb and not r.rolreplication
         and not exists (select 1 from pg_catalog.pg_auth_members where member = r.oid)
         and has_schema_privilege(r.oid, n.oid, 'USAGE')
         and not has_schema_privilege(r.oid, n.oid, 'CREATE')
         and pg_get_userbyid(n.nspowner) = $2) as safe
       from pg_catalog.pg_roles r cross join pg_catalog.pg_namespace n
       where r.rolname = $1 and n.nspname = $3`,
      [runtimeUser, adminUser, ownerSchema],
    );
    yield* requireCondition(role?.safe ?? false, 'Runtime role or schema ownership/grants mismatch');

    const constraints = yield* client.unsafe<{ definition: string; table_name: string; valid: boolean }>(
      `select c.relname as table_name, pg_get_constraintdef(k.oid) as definition, k.convalidated as valid
       from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and k.contype in ('p', 'c', 'f', 'u', 'x')`,
      [ownerSchema],
    );
    yield* requireInventory(
      constraints.map((row) => `${row.table_name}:${normalizeExpression(row.definition)}:${row.valid}`),
      [
        'agenda_states:PRIMARY KEY (tenant_id, legal_entity_id, agenda)',
        'agenda_states:CHECK (revision >= 0)',
        "agenda_states:CHECK (jsonb_typeof(state) = 'object'::text)",
        'files:PRIMARY KEY (tenant_id, legal_entity_id, id)',
        'files:CHECK (size >= 0 AND size <= 5242880)',
        'gateway_assertion_redemptions:PRIMARY KEY (issuer, audience, jti)',
      ].map((definition) => `${normalizeExpression(definition)}:true`),
      'Owner primary keys/check constraints mismatch or unexpected foreign key',
    );

    const [expiryIndex] = yield* client.unsafe<{ safe: boolean }>(
      `select (i.indisvalid and i.indisready and not i.indisunique and i.indnatts = 1
         and i.indpred is null and i.indexprs is null and am.amname = 'btree'
         and pg_get_indexdef(i.indexrelid, 1, true) = 'expires_at'
         and t.relname = 'gateway_assertion_redemptions'
         and pg_get_userbyid(c.relowner) = $2) as safe
       from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
       join pg_catalog.pg_class t on t.oid = i.indrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_am am on am.oid = c.relam
       where n.nspname = $1 and c.relname = 'facility_operations_redemption_expiry'`,
      [ownerSchema, adminUser],
    );
    yield* requireCondition(expiryIndex?.safe ?? false, 'Replay receipt expiry index mismatch');

    const policies = yield* client.unsafe<PolicyRow>(
      `select c.relname as table_name, p.polname as policy_name, p.polcmd as command,
         p.polpermissive as permissive,
         array(select coalesce(r.rolname, 'PUBLIC') from unnest(p.polroles) granted(role_id)
           left join pg_catalog.pg_roles r on r.oid = granted.role_id) as roles,
         pg_get_expr(p.polqual, p.polrelid) as using_expression,
         pg_get_expr(p.polwithcheck, p.polrelid) as check_expression
       from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1`,
      [ownerSchema],
    );
    const scopeExpression = normalizeExpression(
      "tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid",
    );
    const expectedPolicies = businessTables.flatMap((table) => {
      const config = getTableConfig(table);
      return config.policies.map((policy) => `${config.name}.${policy.name}`);
    });
    yield* requireInventory(
      policies.map((policy) => `${policy.table_name}.${policy.policy_name}`),
      expectedPolicies,
      'Owner policy inventory mismatch',
    );
    const commands = [
      { code: 'r', name: 'select' },
      { code: 'a', name: 'insert' },
      { code: 'w', name: 'update' },
      { code: 'd', name: 'delete' },
    ];
    for (const policy of policies) {
      const command = commands.find((entry) => policy.policy_name.endsWith(`_${entry.name}`));
      yield* requireCondition(
        command !== undefined && policy.command === command.code && policy.permissive,
        'Owner policy command or permissiveness mismatch',
      );
      yield* requireInventory(policy.roles, [runtimeUser], 'Owner policy roles mismatch');
      const expectedUsing = policy.command === 'a' ? null : scopeExpression;
      const expectedCheck = policy.command === 'a' || policy.command === 'w' ? scopeExpression : null;
      yield* requireCondition(
        (policy.using_expression === null ? null : normalizeExpression(policy.using_expression)) === expectedUsing &&
          (policy.check_expression === null ? null : normalizeExpression(policy.check_expression)) === expectedCheck,
        'Owner policy does not enforce exact tenant and legal entity scope',
      );
    }
  });

const verifyReads = Effect.gen(function* verifyFacilityReads() {
  const client = yield* PgClient.PgClient;
  const [identity] = yield* client<{ expected: boolean }>`select
    current_user = 'ontos_runtime' and session_user = 'ontos_runtime' as expected`;
  yield* requireCondition(identity?.expected ?? false, 'Runtime session identity mismatch');
  const database = yield* makeWithDefaults({ relations: facilityOperationsRelations });
  // LIMIT 0 validates every typed column without retrieving state documents or binary content.
  for (const table of tables) {
    yield* database.select().from(table).limit(0);
  }
  // Transaction-local empty and partial scopes must reveal no row, regardless of seed state.
  for (const scope of [
    { entity: '', tenant: '' },
    { entity: '', tenant: '00000000-0000-4000-8000-000000000001' },
    { entity: '00000000-0000-4000-8000-000000000002', tenant: '' },
  ]) {
    yield* client.withTransaction(
      Effect.gen(function* probeMissingScope() {
        yield* client`set transaction read only`;
        yield* client`select set_config('ontos.tenant_id', ${scope.tenant}, true),
          set_config('ontos.legal_entity_id', ${scope.entity}, true)`;
        for (const table of businessTables) {
          const rows = yield* database
            .select({ present: sql<number>`1` })
            .from(table)
            .limit(1);
          yield* requireCondition(rows.length === 0, 'Runtime read exposed a row without complete scope');
        }
      }),
    );
  }
});

const catalogVerification = Effect.gen(function* verifyFacilityDatabase() {
  const pair = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.PgClient;
  yield* client.withTransaction(
    Effect.gen(function* inspectReadOnlyCatalog() {
      yield* client`set transaction read only`;
      yield* verifyCatalog(pair.admin.user, pair.runtime.user);
    }),
  );
});

const adminLive = PgClient.layerFrom(
  loadDatabaseConnectionPair().pipe(
    Effect.flatMap((pair) => PgClient.makeClient({ url: Redacted.make(pair.admin.connectionString) })),
  ),
);
const runtimeLive = PgClient.layerFrom(
  loadDatabaseConnectionPair().pipe(
    Effect.flatMap((pair) => PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) })),
  ),
);
const verificationLive = Layer.mergeAll(
  Layer.effectDiscard(catalogVerification).pipe(Layer.provide(adminLive)),
  Layer.effectDiscard(verifyReads).pipe(Layer.provide(runtimeLive)),
).pipe(Layer.provide(Reactivity.layer));
const result = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(verificationLive)).pipe(
    Effect.tap(() => Console.log('Verified Facility Operations schema, grants, policies, and typed read probes')),
    // Driver causes can contain connection details or SQL; report only a fixed diagnostic.
    Effect.tapCause(() => Console.error('Facility Operations schema verification failed')),
  ),
);
if (Exit.isFailure(result)) {
  process.exitCode = 1;
}
