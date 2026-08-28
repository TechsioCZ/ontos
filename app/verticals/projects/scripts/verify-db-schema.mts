// @effect-diagnostics globalConsole:off strictEffectProvide:off
import { DatabaseConfig, loadDatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { ProjectsDatabase, ProjectsDatabaseLive } from '../src/db/client.ts';
import { compareProjectsCatalog } from '../src/db/catalog.ts';
import { PROJECTS_SCHEMA_NAME, PROJECTS_TABLES, contacts, customers } from '../src/db/schema.ts';

class ProjectsDatabaseVerificationError extends Schema.TaggedError<ProjectsDatabaseVerificationError>()(
  'ProjectsDatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

interface TableCatalogRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}
interface ColumnCatalogRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly table_name: string;
}
interface InfrastructureCatalogRow extends Readonly<Record<string, boolean | number | string>> {
  readonly contact_owner: string;
  readonly customer_owner: string;
  readonly foreign_key_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly runtime_create: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly runtime_usage: boolean;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly rls_count: number;
}

const expectedColumns = [
  'contacts.archived_at',
  'contacts.contact_id',
  'contacts.created_at',
  'contacts.customer_id',
  'contacts.email',
  'contacts.name',
  'contacts.phone',
  'contacts.tenant_id',
  'contacts.updated_at',
  'customers.archived_at',
  'customers.created_at',
  'customers.customer_id',
  'customers.dic',
  'customers.dissolved_on',
  'customers.established_on',
  'customers.ico',
  'customers.legal_form_code',
  'customers.name',
  'customers.tenant_id',
  'customers.updated_at',
] as const;

const describeColumnCatalogMismatch = (actualColumns: readonly string[]) =>
  actualColumns.length === expectedColumns.length &&
  actualColumns.every((column, index) => column === expectedColumns[index])
    ? undefined
    : `Projects column catalog mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`;

const verification = Effect.gen(function* verifyProjectsDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* ProjectsDatabase;

  for (const table of PROJECTS_TABLES) {
    yield* Effect.tryPromise({
      catch: () =>
        new ProjectsDatabaseVerificationError({
          reason: `Typed verification failed for one ${PROJECTS_SCHEMA_NAME} table`,
        }),
      try: () => database.executor.select().from(table).limit(0),
    });
  }

  const catalog = yield* Effect.tryPromise({
    catch: () =>
      new ProjectsDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL Projects catalog',
      }),
    try: () =>
      database.executor.execute<TableCatalogRow>(sql`
        select relation.relname as table_name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = ${PROJECTS_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `),
  });
  const difference = compareProjectsCatalog(
    catalog.rows.map((row) => `${PROJECTS_SCHEMA_NAME}.${row.table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new ProjectsDatabaseVerificationError({
      reason: `Projects catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* Effect.tryPromise({
    catch: () =>
      new ProjectsDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL Projects column catalog',
      }),
    try: () =>
      database.executor.execute<ColumnCatalogRow>(sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${PROJECTS_SCHEMA_NAME}
          and table_name in (${'contacts'}, ${'customers'})
        order by table_name, column_name
      `),
  });
  const actualColumns = columns.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const columnCatalogMismatch = describeColumnCatalogMismatch(actualColumns);
  if (columnCatalogMismatch !== undefined) {
    return yield* new ProjectsDatabaseVerificationError({
      reason: columnCatalogMismatch,
    });
  }

  const infrastructure = yield* Effect.tryPromise({
    catch: () =>
      new ProjectsDatabaseVerificationError({
        reason: 'Unable to verify Projects PostgreSQL constraints, RLS, ownership, or grants',
      }),
    try: () =>
      database.executor.execute<InfrastructureCatalogRow>(sql`
        select
          pg_catalog.pg_get_userbyid(customer.relowner) as customer_owner,
          pg_catalog.pg_get_userbyid(contact.relowner) as contact_owner,
          (select count(*)::integer from pg_catalog.pg_constraint
            where conname = ${'projects_contacts_tenant_customer_fk'}) as foreign_key_count,
          (select count(*)::integer from pg_catalog.pg_class as journal
            inner join pg_catalog.pg_namespace as journal_namespace
              on journal_namespace.oid = journal.relnamespace
            where journal_namespace.nspname = ${'drizzle'}
              and journal.relname = ${'__drizzle_migrations_projects'}) as journal_count,
          (select count(*)::integer from pg_catalog.pg_policy as policy
            where policy.polrelid in (customer.oid, contact.oid)) as policy_count,
          has_schema_privilege(${'ontos_runtime'}, ${PROJECTS_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
          has_schema_privilege(${'ontos_runtime'}, ${PROJECTS_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
          has_table_privilege(${'ontos_runtime'}, ${'projects.customers'}, ${'SELECT'}) and
            has_table_privilege(${'ontos_runtime'}, ${'projects.contacts'}, ${'SELECT'}) as runtime_select,
          has_table_privilege(${'ontos_runtime'}, ${'projects.customers'}, ${'INSERT'}) and
            has_table_privilege(${'ontos_runtime'}, ${'projects.contacts'}, ${'INSERT'}) as runtime_insert,
          has_table_privilege(${'ontos_runtime'}, ${'projects.customers'}, ${'UPDATE'}) and
            has_table_privilege(${'ontos_runtime'}, ${'projects.contacts'}, ${'UPDATE'}) as runtime_update,
          has_table_privilege(${'ontos_runtime'}, ${'projects.customers'}, ${'DELETE'}) and
            has_table_privilege(${'ontos_runtime'}, ${'projects.contacts'}, ${'DELETE'}) as runtime_delete,
          runtime_role.rolsuper as role_super,
          runtime_role.rolbypassrls as role_bypass_rls,
          ((customer.relrowsecurity and customer.relforcerowsecurity)::integer +
            (contact.relrowsecurity and contact.relforcerowsecurity)::integer) as rls_count
        from pg_catalog.pg_class as customer
        inner join pg_catalog.pg_namespace as customer_namespace
          on customer_namespace.oid = customer.relnamespace
        cross join pg_catalog.pg_class as contact
        inner join pg_catalog.pg_namespace as contact_namespace
          on contact_namespace.oid = contact.relnamespace
        cross join pg_catalog.pg_roles as runtime_role
        where customer_namespace.nspname = ${PROJECTS_SCHEMA_NAME}
          and customer.relname = ${'customers'}
          and contact_namespace.nspname = ${PROJECTS_SCHEMA_NAME}
          and contact.relname = ${'contacts'}
          and runtime_role.rolname = ${'ontos_runtime'}
      `),
  });
  const [verified] = infrastructure.rows;
  if (
    verified === undefined ||
    verified.customer_owner !== connections.admin.user ||
    verified.contact_owner !== connections.admin.user ||
    verified.foreign_key_count !== 1 ||
    verified.journal_count !== 1 ||
    verified.policy_count !== 8 ||
    verified.rls_count !== 2 ||
    verified.runtime_create ||
    !verified.runtime_usage ||
    !verified.runtime_select ||
    !verified.runtime_insert ||
    !verified.runtime_update ||
    !verified.runtime_delete ||
    verified.role_super ||
    verified.role_bypass_rls
  ) {
    return yield* new ProjectsDatabaseVerificationError({
      reason:
        'Projects database infrastructure does not match its ownership, RLS, journal, constraint, or grant contract',
    });
  }

  const activeCustomers = yield* Effect.tryPromise({
    catch: () =>
      new ProjectsDatabaseVerificationError({
        reason: 'Typed active-Customer verification failed',
      }),
    try: () => database.executor.select().from(customers).limit(0),
  });
  const activeContacts = yield* Effect.tryPromise({
    catch: () =>
      new ProjectsDatabaseVerificationError({
        reason: 'Typed active-Contact verification failed',
      }),
    try: () => database.executor.select().from(contacts).limit(0),
  });

  return {
    typedTableCount: PROJECTS_TABLES.length,
    typedZeroRowQueries: activeCustomers.length + activeContacts.length,
  };
});

const runtime = ProjectsDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));

console.log(
  `Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${PROJECTS_SCHEMA_NAME}`,
);
