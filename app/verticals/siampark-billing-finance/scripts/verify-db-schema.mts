/// <reference types="node" />
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Console, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { FinanceStateSchema } from '../shared/apis/records.ts';
import { financeRelations, financeStates } from '../src/database/schema.ts';

const OWNER_SCHEMA = 'siampark_billing_finance';
const DEMO_TENANT = '70000000-0000-4000-8000-000000000020';
const DEMO_LEGAL_ENTITY = '71000000-0000-4000-8000-000000000020';
const OTHER_TENANT = '70000000-0000-4000-8000-000000000021';
const OTHER_LEGAL_ENTITY = '71000000-0000-4000-8000-000000000021';
const ColumnNameSchema = Schema.String.pipe(Schema.brand('PostgreSQLColumnName'));
const CatalogSchema = Schema.Struct({
  checks: Schema.Array(Schema.String),
  forceRls: Schema.Boolean,
  owner: Schema.String,
  policies: Schema.Array(Schema.String),
  primaryKey: Schema.Array(ColumnNameSchema),
  rowSecurity: Schema.Boolean,
  runtimeDelete: Schema.Boolean,
  runtimeInsert: Schema.Boolean,
  runtimeSelect: Schema.Boolean,
  runtimeUpdate: Schema.Boolean,
  tableName: Schema.String,
});
const InfrastructureSchema = Schema.Struct({
  expiryIndex: Schema.Boolean,
  externalForeignKeys: Schema.Int,
  migrationJournal: Schema.Boolean,
  runtimeBypass: Schema.Boolean,
  runtimeCreate: Schema.Boolean,
  runtimeRole: Schema.String,
  runtimeSuper: Schema.Boolean,
  runtimeUsage: Schema.Boolean,
});
class FinanceDatabaseVerificationError extends Schema.TaggedError<FinanceDatabaseVerificationError>()(
  'FinanceDatabaseVerificationError',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new FinanceDatabaseVerificationError({ reason });
const verifyTables = Effect.fn('Finance.verifyTableCatalog')(function* verifyTableCatalog(
  tables: readonly (typeof CatalogSchema.Type)[],
  adminOwner: string,
) {
  const [stateTable, redemptionTable] = tables;
  if (
    tables.length !== 2 ||
    stateTable?.tableName !== 'finance_states' ||
    redemptionTable?.tableName !== 'gateway_assertion_redemptions' ||
    tables.some(
      (table) =>
        table.owner !== adminOwner ||
        !table.runtimeSelect ||
        !table.runtimeInsert ||
        !table.runtimeUpdate ||
        !table.runtimeDelete,
    )
  ) {
    return yield* failure('Finance owner tables, ownership or runtime CRUD grants do not match');
  }
  if (
    !stateTable.rowSecurity ||
    !stateTable.forceRls ||
    stateTable.policies.join(',') !== 'a,d,r,w' ||
    stateTable.primaryKey.join(',') !== 'tenant_id,legal_entity_id' ||
    !stateTable.checks.some((check) => check.includes('revision >= 0')) ||
    !stateTable.checks.some((check) => check.includes('jsonb_typeof(state)')) ||
    redemptionTable.primaryKey.join(',') !== 'issuer,audience,jti' ||
    redemptionTable.rowSecurity ||
    redemptionTable.forceRls
  ) {
    return yield* failure('Finance forced scope RLS, optimistic revision or replay nonce constraints do not match');
  }
  return yield* Effect.void;
});
const runtimePgLive = PgClient.layerFrom(
  Effect.gen(function* runtimeConnection() {
    const pair = yield* loadDatabaseConnectionPair();
    return yield* PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) });
  }),
).pipe(Layer.provide(Reactivity.layer));

const main = Effect.gen(function* verifyFinanceDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.PgClient;
  const db = yield* makeWithDefaults({ relations: financeRelations });
  // PostgreSQL catalogs have no owner Drizzle table. These queries only inspect
  // the actual deployment schema, migration journal, constraints and grants.
  const rawTables = yield* client.unsafe<typeof CatalogSchema.Encoded>(`
    select c.relname as "tableName", pg_get_userbyid(c.relowner) as owner,
      c.relrowsecurity as "rowSecurity", c.relforcerowsecurity as "forceRls",
      array(select p.polcmd::text from pg_catalog.pg_policy p where p.polrelid=c.oid order by p.polcmd) as policies,
      array(select a.attname::text from pg_catalog.pg_constraint k
        cross join lateral unnest(k.conkey) with ordinality as key(attnum, position)
        join pg_catalog.pg_attribute a on a.attrelid=k.conrelid and a.attnum=key.attnum
        where k.conrelid=c.oid and k.contype='p' order by key.position) as "primaryKey",
      array(select pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k
        where k.conrelid=c.oid and k.contype='c' order by k.conname) as checks,
      has_table_privilege(current_user,c.oid,'SELECT') as "runtimeSelect",
      has_table_privilege(current_user,c.oid,'INSERT') as "runtimeInsert",
      has_table_privilege(current_user,c.oid,'UPDATE') as "runtimeUpdate",
      has_table_privilege(current_user,c.oid,'DELETE') as "runtimeDelete"
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='siampark_billing_finance' and c.relkind='r' order by c.relname
  `);
  const tables = yield* Schema.decodeEffect(Schema.Array(CatalogSchema))(rawTables);
  yield* verifyTables(tables, connections.admin.user);
  const rawInfrastructure = yield* client.unsafe<typeof InfrastructureSchema.Encoded>(`
    select current_user as "runtimeRole", r.rolsuper as "runtimeSuper", r.rolbypassrls as "runtimeBypass",
      has_schema_privilege(current_user,'siampark_billing_finance','USAGE') as "runtimeUsage",
      has_schema_privilege(current_user,'siampark_billing_finance','CREATE') as "runtimeCreate",
      exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='drizzle' and c.relname='__drizzle_migrations_siampark_billing_finance' and c.relkind='r') as "migrationJournal",
      exists(select 1 from pg_catalog.pg_indexes where schemaname='siampark_billing_finance'
        and tablename='gateway_assertion_redemptions' and indexname='siampark_finance_redemption_expiry') as "expiryIndex",
      (select count(*)::int from pg_catalog.pg_constraint k
        join pg_catalog.pg_class c on c.oid=k.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        join pg_catalog.pg_class target on target.oid=k.confrelid join pg_catalog.pg_namespace target_n on target_n.oid=target.relnamespace
        where n.nspname='siampark_billing_finance' and k.contype='f' and target_n.nspname<>'siampark_billing_finance') as "externalForeignKeys"
    from pg_catalog.pg_roles r where r.rolname=current_user
  `);
  const [infrastructure] = yield* Schema.decodeEffect(Schema.Array(InfrastructureSchema))(rawInfrastructure);
  if (
    infrastructure === undefined ||
    infrastructure.runtimeRole !== connections.runtime.user ||
    infrastructure.runtimeSuper ||
    infrastructure.runtimeBypass ||
    infrastructure.runtimeCreate ||
    !infrastructure.runtimeUsage ||
    !infrastructure.migrationJournal ||
    !infrastructure.expiryIndex ||
    infrastructure.externalForeignKeys !== 0
  ) {
    return yield* failure('Finance runtime role, owner schema privileges or migration catalog do not match');
  }
  const unscoped = yield* db.select().from(financeStates).limit(1);
  if (unscoped.length !== 0) {
    return yield* failure('Unscoped runtime read bypassed Finance RLS');
  }
  const readDemoWithScope = Effect.fn('Finance.verifyScopedRead')(function* readDemoWithScope(
    tenantId: string,
    legalEntityId: string,
  ) {
    return yield* client.withTransaction(
      Effect.gen(function* readInTransaction() {
        // Only transaction-local context changes; no business rows or privileges are mutated.
        yield* client`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;
        return yield* db
          .select()
          .from(financeStates)
          .where(and(eq(financeStates.tenantId, DEMO_TENANT), eq(financeStates.legalEntityId, DEMO_LEGAL_ENTITY)))
          .limit(2);
      }),
    );
  });
  for (const [tenantId, legalEntityId] of [
    [OTHER_TENANT, DEMO_LEGAL_ENTITY],
    [DEMO_TENANT, OTHER_LEGAL_ENTITY],
    [DEMO_TENANT, ''],
  ] as const) {
    const denied = yield* readDemoWithScope(tenantId, legalEntityId);
    if (denied.length !== 0) {
      return yield* failure('Wrong tenant, wrong legal entity or missing legal entity exposed the Finance demo row');
    }
  }
  const [baseline] = yield* readDemoWithScope(DEMO_TENANT, DEMO_LEGAL_ENTITY);
  if (baseline === undefined || baseline.revision < 0) {
    return yield* failure('Finance demo seed is absent in its correct tenant and legal entity scope');
  }
  const state = yield* Schema.decodeEffect(FinanceStateSchema)(baseline.state);
  const references = [
    ...state.invoices.flatMap((invoice) => [
      invoice.ref,
      invoice.counterpartyRef,
      invoice.propertyRef,
      invoice.unitRef,
      invoice.contractRef,
      invoice.occupancyRef,
      invoice.taskRef,
    ]),
    ...state.financialPlanEntries.flatMap((entry) => [entry.ref, entry.propertyRef]),
    ...state.accountingObservations.map((observation) => observation.invoiceRef),
    ...state.paymentObservations.map((observation) => observation.invoiceRef),
  ];
  if (references.some((ref) => ref !== undefined && ref.tenantId !== DEMO_TENANT)) {
    return yield* failure('Finance persisted state contains a reference outside its tenant scope');
  }
  return yield* Console.log(
    `${OWNER_SCHEMA} database verification passed (catalog, grants, RLS, scope isolation, seed)`,
  );
});
const mainLive = Layer.effectDiscard(main).pipe(Layer.provide(runtimePgLive));
const result = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(mainLive)).pipe(
    Effect.tapCause((cause) =>
      Console.error(
        'Finance database verification failed',
        cause.reasons.map((reason) => reason._tag),
      ),
    ),
  ),
);
if (Exit.isFailure(result)) {
  process.exitCode = 1;
}
