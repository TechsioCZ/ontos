// regroup-codemod: keep (this file lists the legacy siampark names on purpose)
// One-shot, idempotent data migration of the live demo database for the domain regroup: the customer-named
// verticals (siampark-*) became functional-domain verticals. Renames the owner schemas and drizzle journals,
// renames the index/constraint/policy names that carried the old prefix, recreates the finance worker routines
// (ALTER SCHEMA does not rewrite routine bodies), rewrites stored module ids, permission keys, app ids, resource types
// and deep links, and migrates the e-mail ledger sources. Everything runs in ONE transaction with assertions;
// any failed assertion rolls the whole migration back.
//
// Usage (from app/, demo stopped, containers up):
//   docker --context orbstack exec ontos-demo-db pg_dump -U ontos_admin -Fc siampark_demo \
//     > /Volumes/DevWork/agent-scratch/backup-pre-regroup.dump
//   node --env-file=.env scripts/demo/migrate-domain-regroup.mts --dry-run
//   node --env-file=.env scripts/demo/migrate-domain-regroup.mts --backup /Volumes/DevWork/agent-scratch/backup-pre-regroup.dump
//
//   --dry-run          run every step inside the transaction, print the counts, then roll back.
//   --backup <file>    required for a real run: an existing, non-empty pg_dump of the database.
//   --skip <s.t>       leave one table out of the generic text rewrite (repeatable), e.g. a table with update triggers.
//   --allow-sessions   do not refuse when other database sessions are open.
//
// Connects with DATABASE_ADMIN_URL (superuser or BYPASSRLS role; FORCE ROW LEVEL SECURITY tables are rewritten too).
// Deliberately left as history: core.application_composition_* (the composition publisher republishes on start),
// idempotency/correlation/hash columns, and finance accounting export files (their content is hash-verified; the
// finance UI and the shell redirects accept the legacy links).
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Console, Data, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';

const facilityModuleId = 'facility.operations';
const legacyFinanceSchema = 'siampark_billing_finance';
const appRoot = new URL('../../', import.meta.url);
class MigrationFailure extends Schema.TaggedError<MigrationFailure>()('MigrationFailure', { reason: Schema.String }) {}
const DryRunRollback = Data.TaggedError('DryRunRollback')<{ readonly reason: 'Requested dry run rollback' }>;

interface MigrationOptions {
  readonly allowSessions: boolean;
  readonly backup: Option.Option<string>;
  readonly dryRun: boolean;
  readonly skip: readonly string[];
}

/** Old owner schema -> new owner schema (and drizzle journal suffix). */
const schemaRenames = [
  ['siampark_property', 'property_portfolio'],
  ['siampark_occupancy', 'property_leasing'],
  ['siampark_agreements', 'legal_agreements'],
  [legacyFinanceSchema, 'finance_billing'],
  ['siampark_work', 'work_tasks'],
  ['siampark_relationships', 'crm_activities'],
  ['demo_siampark_ops', 'facility_operations'],
] as const;
const newSchemas = schemaRenames.map(([, next]) => next);

/** Prefix map of index, constraint and policy names, most specific first (same as the codemod's snake tokens). */
const objectNameRenames = [
  ['demo_siampark_ops', 'facility_operations'],
  [legacyFinanceSchema, 'finance_billing'],
  ['siampark_finance_', 'finance_billing_'],
  ['siampark_relationships', 'crm_activities'],
  ['siampark_agreements', 'legal_agreements'],
  ['siampark_occupancy', 'property_leasing'],
  ['siampark_property', 'property_portfolio'],
  ['siampark_work', 'work_tasks'],
  ['siampark_ops', 'facility_operations'],
] as const;

/** Token rewrite of stored values, applied in this order. Never touches tenant data (e-mails, slug, DB name, seed ids). */
const valueRenames = [
  ['demo.siampark-ops', facilityModuleId],
  ['demo.siampark_ops', facilityModuleId],
  ['demo_siampark_ops', 'facility_operations'],
  ['siampark.billing-finance', 'finance.billing'],
  ['siampark.property', 'property.portfolio'],
  ['siampark.occupancy', 'property.leasing'],
  ['siampark.agreements', 'legal.agreements'],
  ['siampark.work', 'work.tasks'],
  ['siampark.relationships', 'crm.activities'],
  ['siampark-billing-finance', 'finance-billing'],
  ['siampark-property', 'property-portfolio'],
  ['siampark-occupancy', 'property-leasing'],
  ['siampark-agreements', 'legal-agreements'],
  ['siampark-work', 'work-tasks'],
  ['siampark-relationships', 'crm-activities'],
  ['siampark-ops', 'facility-operations'],
  [legacyFinanceSchema, 'finance_billing'],
  ['siampark_property', 'property_portfolio'],
  ['siampark_occupancy', 'property_leasing'],
  ['siampark_agreements', 'legal_agreements'],
  ['siampark_work', 'work_tasks'],
  ['siampark_relationships', 'crm_activities'],
  ['/siampark/provoz/', '/provoz/'],
  ['/siampark/overview', '/nemovitosti/prehled'],
  ['/siampark/integrations', '/nemovitosti/integrace'],
  ['/siampark/properties', '/nemovitosti'],
  ['/siampark/occupancy', '/najmy'],
  ['/siampark/agreements', '/smlouvy'],
  ['/siampark/finance', '/finance'],
  ['/siampark/work', '/ukoly'],
  ['/siampark/relationships', '/aktivity'],
] as const;

/** Any old module id, permission key, app id, schema name or route left in a rewritten value. */
const leftoverPattern = String.raw`demo[._]siampark[-_]ops|siampark\.(property|occupancy|agreements|billing-finance|work|relationships)|siampark-(property|occupancy|agreements|billing-finance|work|relationships|ops)|siampark_(property|occupancy|agreements|billing_finance|work|relationships)|/siampark/(overview|integrations|properties|occupancy|agreements|finance|work|relationships|provoz)`;

const oldModuleKeys = [
  'siampark.property',
  'siampark.occupancy',
  'siampark.agreements',
  'siampark.billing-finance',
  'siampark.work',
  'siampark.relationships',
  'demo.siampark-ops',
];
const newModuleKeys = [
  'property.portfolio',
  'property.leasing',
  'legal.agreements',
  'finance.billing',
  'work.tasks',
  'crm.activities',
  facilityModuleId,
];

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const drizzleName = (value: string) => `drizzle.${ident(value)}`;
const tableName = (schema: string, table: string) => `${ident(schema)}.${ident(table)}`;
const regroupMapBody = (() => {
  let expression = 't';
  for (const [from, to] of valueRenames) {
    expression = `replace(${expression}, ${literal(from)}, ${literal(to)})`;
  }
  return expression;
})();

/** Columns the generic rewrite never touches: replay keys, hashes and fingerprints are history. */
const historyColumn = /(?:idempotency|correlation|query_hash|request_hash|fingerprint|dedupe)/u;
const historyTable = (schema: string, table: string) =>
  (schema === 'core' && table.startsWith('application_composition')) ||
  (schema === 'finance_billing' && table === 'finance_states');

const program = ({ allowSessions, backup, dryRun, skip }: MigrationOptions) =>
  Effect.gen(function* migrateDomainRegroup() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skipped = new Set(skip);
    const sql = yield* PgClient.PgClient;
    const query = <Row extends object>(text: string) => sql.unsafe<Row>(text);
    const count = (text: string) =>
      query<{ readonly n: string }>(text).pipe(Effect.map((rows) => Number(rows[0]?.n ?? 0)));

    // -- Preconditions --------------------------------------------------------------------------------------------
    const [role] = yield* query<{ readonly bypass: boolean; readonly db: string; readonly super: boolean }>(
      'select rolsuper as super, rolbypassrls as bypass, current_database() as db from pg_roles where rolname = current_user',
    );
    if (role === undefined || (!role.super && !role.bypass)) {
      return yield* new MigrationFailure({
        reason: 'DATABASE_ADMIN_URL must connect as a superuser or BYPASSRLS role',
      });
    }
    const sessions = yield* count(
      'select count(*) as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
    );
    if (sessions > 0 && !allowSessions) {
      return yield* new MigrationFailure({
        reason: `${sessions} other session(s) are connected to ${role.db}; stop the demo (scripts/demo/down.sh) or pass --allow-sessions`,
      });
    }
    const backupIsNonempty =
      !dryRun && Option.isSome(backup) && (yield* fs.exists(backup.value)) && (yield* fs.stat(backup.value)).size > 0;
    if (!dryRun && !backupIsNonempty) {
      return yield* new MigrationFailure({
        reason: 'a real run needs --backup <file> pointing at a non-empty pg_dump of the database (see the header)',
      });
    }
    const existing = new Set(
      (yield* query<{ readonly nspname: string }>('select nspname from pg_namespace')).map((row) => row.nspname),
    );
    const pendingSchemas = schemaRenames.filter(([old]) => existing.has(old));
    const collisions = pendingSchemas.filter(([, next]) => existing.has(next));
    const collisionNames = collisions.map(([old, next]) => `${old}/${next}`).join(', ');
    if (collisions.length > 0) {
      return yield* new MigrationFailure({
        reason: `both old and new schemas exist (${collisionNames}); new code ran db:migrate before this migration. Drop the new, empty schemas and their drizzle journals, then rerun`,
      });
    }
    const leftoverCore = yield* count(
      `select count(*) as n from core.tenant_module_states where module_key in (${oldModuleKeys.map(literal).join(', ')})`,
    );
    if (pendingSchemas.length === 0 && leftoverCore === 0) {
      yield* Console.log('domain regroup: nothing to do (no siampark schema and no old module key remain)');
      return yield* Effect.void;
    }
    const newKeyCollisions = yield* count(
      `select count(*) as n from core.tenant_module_states as next
       join core.tenant_module_states as old on old.tenant_id = next.tenant_id
         and old.legal_entity_id is not distinct from next.legal_entity_id
         and replace(replace(replace(replace(replace(replace(replace(old.module_key,
           'demo.siampark-ops', 'facility.operations'), 'siampark.billing-finance', 'finance.billing'),
           'siampark.property', 'property.portfolio'), 'siampark.occupancy', 'property.leasing'),
           'siampark.agreements', 'legal.agreements'), 'siampark.work', 'work.tasks'),
           'siampark.relationships', 'crm.activities') = next.module_key
     where old.module_key in (${oldModuleKeys.map(literal).join(', ')})`,
    ).pipe(Effect.catch(() => Effect.succeed(-1)));
    if (newKeyCollisions > 0) {
      return yield* new MigrationFailure({
        reason: `${newKeyCollisions} tenant module state(s) exist under both the old and the new key; new code already installed modules`,
      });
    }
    const moduleRowsBefore = yield* count(
      `select count(*) as n from core.tenant_module_states where module_key in (${oldModuleKeys.map(literal).join(', ')})`,
    );

    // -- Transaction ----------------------------------------------------------------------------------------------
    const schemaList = newSchemas.map(literal).join(', ');
    const renameOwnerSchemas = Effect.gen(function* renameOwnerSchemasStage() {
      // 1. Owner schemas. Grants, RLS policies, sequences and constraints follow the schema OID.
      for (const [old, next] of pendingSchemas) {
        yield* query(`alter schema ${ident(old)} rename to ${ident(next)}`);
        yield* Console.log(`schema ${old} -> ${next}`);
      }
    });
    const renameDrizzleJournals = Effect.gen(function* renameDrizzleJournalsStage() {
      // 2. Drizzle journals: migrations match by folder name, so the rewritten migration.sql files are not rerun.
      for (const [old, next] of schemaRenames) {
        const oldJournal = `__drizzle_migrations_${old}`;
        const newJournal = `__drizzle_migrations_${next}`;
        const [journal] = yield* query<{ readonly next: string | null; readonly old: string | null }>(
          `select to_regclass(${literal(drizzleName(oldJournal))})::text as old,
                to_regclass(${literal(drizzleName(newJournal))})::text as next`,
        );
        const oldSequence = `${oldJournal}_id_seq`;
        const newSequence = `${newJournal}_id_seq`;
        if (journal?.old !== null && journal?.old !== undefined) {
          if (journal.next !== null) {
            return yield* new MigrationFailure({
              reason: `both drizzle journals ${oldJournal} and ${newJournal} exist`,
            });
          }
          yield* query(`alter table drizzle.${ident(oldJournal)} rename to ${ident(newJournal)}`);
          // The journal's serial sequence and its pkey/not-null constraints carry the old table name too.
          const journalConstraints = yield* query<{ readonly name: string }>(
            `select con.conname as name from pg_constraint con
            where con.conrelid = ${literal(drizzleName(newJournal))}::regclass
              and starts_with(con.conname, ${literal(oldJournal)})`,
          );
          for (const { name } of journalConstraints) {
            yield* query(
              `alter table drizzle.${ident(newJournal)} rename constraint ${ident(name)} to ${ident([newJournal, name.slice(oldJournal.length)].join(''))}`,
            );
          }
          const [sequence] = yield* query<{ readonly name: string | null }>(
            `select to_regclass(${literal(drizzleName(oldSequence))})::text as name`,
          );
          if (sequence?.name !== null && sequence?.name !== undefined) {
            yield* query(`alter sequence drizzle.${ident(oldSequence)} rename to ${ident(newSequence)}`);
          }
          yield* Console.log(`journal ${oldJournal} -> ${newJournal}`);
        }
      }
      return yield* Effect.void;
    });
    const renameSchemaObjects = Effect.gen(function* renameSchemaObjectsStage() {
      // 3. Index, constraint and policy names carrying the old prefix (must equal the rewritten schema.ts/snapshots).
      const renameName = (name: string) => {
        let value = name;
        for (const [from, to] of objectNameRenames) {
          value = value.replaceAll(from, to);
        }
        return value;
      };
      const constraints = yield* query<{ readonly name: string; readonly schema: string; readonly table: string }>(
        `select n.nspname as schema, c.relname as "table", con.conname as name
         from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in (${schemaList}) and con.conname ~ 'siampark'`,
      );
      for (const row of constraints) {
        yield* query(
          `alter table ${ident(row.schema)}.${ident(row.table)} rename constraint ${ident(row.name)} to ${ident(renameName(row.name))}`,
        );
      }
      // Indexes backing a unique/primary constraint were renamed with their constraint above.
      const indexes = yield* query<{ readonly name: string; readonly schema: string }>(
        `select n.nspname as schema, c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('i', 'I') and n.nspname in (${schemaList}) and c.relname ~ 'siampark'`,
      );
      for (const row of indexes) {
        yield* query(`alter index ${ident(row.schema)}.${ident(row.name)} rename to ${ident(renameName(row.name))}`);
      }
      const policies = yield* query<{ readonly name: string; readonly schema: string; readonly table: string }>(
        `select schemaname as schema, tablename as "table", policyname as name
         from pg_policies where schemaname in (${schemaList}) and policyname ~ 'siampark'`,
      );
      for (const row of policies) {
        yield* query(
          `alter policy ${ident(row.name)} on ${ident(row.schema)}.${ident(row.table)} rename to ${ident(renameName(row.name))}`,
        );
      }
      const sequences = yield* query<{ readonly name: string; readonly schema: string }>(
        `select n.nspname as schema, c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'S' and n.nspname in (${schemaList}) and c.relname ~ 'siampark'`,
      );
      for (const row of sequences) {
        yield* query(`alter sequence ${ident(row.schema)}.${ident(row.name)} rename to ${ident(renameName(row.name))}`);
      }
      yield* Console.log(
        `renamed ${constraints.length} constraint(s), ${indexes.length} index(es), ${policies.length} policy(ies), ${sequences.length} sequence(s)`,
      );
    });
    const recreateFinanceRoutines = Effect.gen(function* recreateFinanceRoutinesStage() {
      // 4. Finance worker routines: RENAME does not rewrite SQL bodies, so recreate them from the rewritten migration.
      if (existing.has(legacyFinanceSchema) || existing.has('finance_billing')) {
        const routinesPath = yield* path.fromFileUrl(
          new URL('verticals/finance-billing/drizzle/20261012235456_finance-worker-routines/migration.sql', appRoot),
        );
        const routines = (yield* fs.readFileString(routinesPath))
          .replaceAll('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
          .split('--> statement-breakpoint')
          .map((statement) => statement.trim())
          .filter((statement) => statement !== '');
        for (const statement of routines) {
          yield* query(statement);
        }
        yield* Console.log(`recreated finance worker routines (${routines.length} statements)`);
      }
    });
    const rewriteStoredValues = Effect.gen(function* rewriteStoredValuesStage() {
      // 5. Stored values: one temporary rewrite function, dropped with the session.
      yield* query(
        `create function pg_temp.regroup_map(t text) returns text language sql immutable as $$ select ${regroupMapBody} $$`,
      );
      const financeState = yield* query<{ readonly n: string }>(
        `with changed as (
         update finance_billing.finance_states
            set state = case when state ? 'accountingExports'
                             then pg_temp.regroup_map((state - 'accountingExports')::text)::jsonb
                                  || jsonb_build_object('accountingExports', state -> 'accountingExports')
                             else pg_temp.regroup_map(state::text)::jsonb end
          where (state - 'accountingExports')::text ~ 'siampark'
            and (state - 'accountingExports')::text <> pg_temp.regroup_map((state - 'accountingExports')::text)
          returning 1)
       select count(*)::text as n from changed`,
      ).pipe(Effect.catch(() => Effect.succeed([{ n: '0' }])));
      yield* Console.log(
        `finance_billing.finance_states.state: ${financeState[0]?.n ?? 0} row(s) (accounting export files kept)`,
      );

      const columns = yield* query<{
        readonly column: string;
        readonly schema: string;
        readonly table: string;
        readonly type: string;
      }>(
        `select c.table_schema as schema, c.table_name as "table", c.column_name as "column", c.data_type as type
         from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where t.table_type = 'BASE TABLE'
          and c.data_type in ('text', 'character varying', 'jsonb', 'json')
          and c.is_generated = 'NEVER'
          and c.table_schema not in ('pg_catalog', 'information_schema', 'drizzle', 'demo_email')
          and c.table_schema not like 'pg\\_%'
        order by 1, 2, 3`,
      );
      const rewritten: string[] = [];
      for (const column of columns) {
        const qualified = `${column.schema}.${column.table}`;
        if (historyTable(column.schema, column.table) || historyColumn.test(column.column) || skipped.has(qualified)) {
          continue;
        }
        const cast = column.type === 'character varying' ? 'text' : column.type;
        const target = ident(column.column);
        const changed = yield* count(
          `with changed as (
           update ${ident(column.schema)}.${ident(column.table)}
              set ${target} = pg_temp.regroup_map(${target}::text)::${cast}
            where ${target}::text ~ 'siampark' and ${target}::text <> pg_temp.regroup_map(${target}::text)
            returning 1)
         select count(*) as n from changed`,
        );
        if (changed > 0) {
          rewritten.push(`${qualified}.${column.column}: ${changed}`);
        }
      }
      yield* Console.log(`rewritten values:\n  ${rewritten.join('\n  ') || '(none)'}`);

      // Gateway assertion replay caches are keyed by the old audiences; they are ephemeral.
      for (const schema of newSchemas) {
        const [table] = yield* query<{ readonly name: string | null }>(
          `select to_regclass(${literal(tableName(schema, 'gateway_assertion_redemptions'))})::text as name`,
        );
        if (table?.name !== null && table?.name !== undefined) {
          yield* query(`delete from ${ident(schema)}.gateway_assertion_redemptions`);
        }
      }
      return columns;
    });
    const migrateEmailLedger = Effect.gen(function* migrateEmailLedgerStage() {
      // 6. E-mail ledger: renamed dispatcher sources, so already delivered e-mails are never sent again.
      const [ledger] = yield* query<{ readonly name: string | null }>(
        `select to_regclass('demo_email.deliveries')::text as name`,
      );
      if (ledger?.name !== null && ledger?.name !== undefined) {
        yield* query('alter table demo_email.deliveries drop constraint if exists deliveries_source_check');
        const moved = yield* count(
          `with changed as (
           update demo_email.deliveries
              set source = case source when 'siampark-reminder' then 'rent-reminder' else 'facility-agenda' end,
                  dedupe_key = case
                    when dedupe_key like 'siampark-reminder:%' then 'rent-reminder:' || substring(dedupe_key from 19)
                    when dedupe_key like 'siampark-agenda:%' then 'facility-agenda:' || substring(dedupe_key from 17)
                    else dedupe_key end
            where source in ('siampark-reminder', 'siampark-agenda')
            returning 1)
         select count(*) as n from changed`,
        );
        yield* query(
          `alter table demo_email.deliveries add constraint deliveries_source_check
           check (source in ('akros-order', 'facility-agenda', 'rent-reminder'))`,
        );
        yield* Console.log(`demo_email.deliveries: ${moved} row(s) moved to the new sources`);
      }
    });
    const assertRegroupMigration = Effect.fn(function* verifyRegroupMigration(
      columns: Effect.Success<typeof rewriteStoredValues>,
    ) {
      // 7. Assertions (a failure rolls everything back).
      const remainingSchemas = yield* count(
        `select count(*) as n from pg_namespace where nspname ~ 'siampark' and nspname <> 'siampark_demo'`,
      );
      const remainingJournals = yield* count(
        `select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'drizzle' and c.relname ~ 'siampark'`,
      );
      const remainingObjects = yield* count(
        `select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname in (${schemaList}) and c.relname ~ 'siampark')
            + (select count(*) from pg_policies where schemaname in (${schemaList}) and policyname ~ 'siampark')
            + (select count(*) from pg_constraint con join pg_namespace n on n.oid = con.connamespace
                where n.nspname in (${schemaList}) and con.conname ~ 'siampark') as n`,
      );
      const routineLeftovers = yield* count(
        `select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in (${schemaList}) and p.prosrc ~ 'siampark'`,
      );
      const moduleRowsAfter = yield* count(
        `select count(*) as n from core.tenant_module_states where module_key in (${newModuleKeys.map(literal).join(', ')})`,
      );
      const oldModuleRows = yield* count(
        `select count(*) as n from core.tenant_module_states where module_key in (${oldModuleKeys.map(literal).join(', ')})`,
      );
      let valueLeftovers = 0;
      const leftoverColumns: string[] = [];
      for (const column of columns) {
        const qualified = `${column.schema}.${column.table}`;
        if (historyTable(column.schema, column.table) || historyColumn.test(column.column) || skipped.has(qualified)) {
          continue;
        }
        const target = ident(column.column);
        const leftovers = yield* count(
          `select count(*) as n from ${ident(column.schema)}.${ident(column.table)} where ${target}::text ~ ${literal(leftoverPattern)}`,
        );
        if (leftovers > 0) {
          valueLeftovers += leftovers;
          leftoverColumns.push(`${qualified}.${column.column}: ${leftovers}`);
        }
      }
      const financeLeftovers = yield* count(
        `select count(*) as n from finance_billing.finance_states where (state - 'accountingExports')::text ~ ${literal(leftoverPattern)}`,
      ).pipe(Effect.catch(() => Effect.succeed(0)));
      const failures = [
        remainingSchemas > 0 ? `${remainingSchemas} siampark schema(s) remain` : undefined,
        remainingJournals > 0 ? `${remainingJournals} siampark drizzle journal(s) remain` : undefined,
        remainingObjects > 0 ? `${remainingObjects} siampark index/constraint/policy name(s) remain` : undefined,
        routineLeftovers > 0 ? `${routineLeftovers} routine body(ies) still reference siampark` : undefined,
        oldModuleRows > 0 ? `${oldModuleRows} tenant module state(s) keep an old key` : undefined,
        moduleRowsAfter < moduleRowsBefore
          ? `tenant module states lost rows (${moduleRowsBefore} -> ${moduleRowsAfter})`
          : undefined,
        valueLeftovers > 0 ? `old identifiers remain in ${leftoverColumns.join(', ')}` : undefined,
        financeLeftovers > 0 ? `old identifiers remain in ${financeLeftovers} finance state(s)` : undefined,
      ].filter((failure) => failure !== undefined);
      if (failures.length > 0) {
        return yield* new MigrationFailure({ reason: `assertions failed: ${failures.join('; ')}` });
      }
      yield* Console.log(`assertions passed (tenant module states: ${moduleRowsBefore} old -> ${moduleRowsAfter} new)`);
      if (dryRun) {
        return yield* new DryRunRollback({ reason: 'Requested dry run rollback' });
      }
      return yield* Effect.void;
    });
    const migrate = Effect.gen(function* migrateTransaction() {
      yield* renameOwnerSchemas;
      yield* renameDrizzleJournals;
      yield* renameSchemaObjects;
      yield* recreateFinanceRoutines;
      const columns = yield* rewriteStoredValues;
      yield* migrateEmailLedger;
      yield* assertRegroupMigration(columns);
    });

    yield* sql
      .withTransaction(migrate)
      .pipe(Effect.catchTag('DryRunRollback', () => Console.log('dry run: rolled back, nothing changed')));
    if (!dryRun) {
      yield* Console.log(
        'domain regroup migration committed. Next: node scripts/demo/migrate-domain-regroup-authorization.mts (SpiceDB grants), fast-forward the runtime, pnpm install, build the changed apps, DEMO_RESET=0 DEMO_SKIP_BUILD=1 scripts/demo/up.sh, restart the agent MCP server.',
      );
    }
    return yield* Effect.void;
  });

const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* admin() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

const migrationConfigurationLive = ConfigProvider.layer(
  Effect.gen(function* migrationConfiguration() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const envPath = yield* path.fromFileUrl(new URL('.env', appRoot));
    const ambientAdmin = yield* Config.option(Config.Redacted('DATABASE_ADMIN_URL'));
    const ambient = ConfigProvider.fromEnv();
    return Option.isNone(ambientAdmin) && (yield* fs.exists(envPath))
      ? ConfigProvider.orElse(ambient, yield* ConfigProvider.fromDotEnv({ path: envPath }))
      : ambient;
  }),
);
const command = Command.make(
  'migrate-domain-regroup',
  {
    allowSessions: Flag.Boolean('allow-sessions'),
    backup: Flag.optional(Flag.String('backup')),
    dryRun: Flag.Boolean('dry-run'),
    skip: Flag.atLeast(Flag.String('skip'), 0),
  },
  (options) =>
    Layer.build(
      Layer.effectDiscard(program(options)).pipe(Layer.provide(admin), Layer.provide(migrationConfigurationLive)),
    ).pipe(Effect.scoped, Effect.asVoid),
);

NodeRuntime.runMain(
  Command.run(command, { version: '1.0.0' }).pipe(
    Effect.tapError((failure) =>
      Console.error(
        `domain regroup migration failed: ${'reason' in failure ? String(failure.reason) : String(failure)}`,
      ),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
