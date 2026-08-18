// @effect-diagnostics globalConsole:off strictEffectProvide:off
import { DatabaseConfig, loadDatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { CrmDatabase, CrmDatabaseLive } from '../src/db/client.ts';
import { compareCrmCatalog } from '../src/db/catalog.ts';
import { CRM_SCHEMA_NAME, CRM_TABLES, contacts, customers } from '../src/db/schema.ts';

class CrmDatabaseVerificationError extends Schema.TaggedErrorClass<CrmDatabaseVerificationError>()(
  'CrmDatabaseVerificationError',
  {
    reason: Schema.String,
  },
) {}

type TableCatalogRow = Record<string, unknown> & {
  readonly table_name: string;
};
type ColumnCatalogRow = Record<string, unknown> & {
  readonly column_name: string;
  readonly table_name: string;
};

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
    : `CRM column catalog mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`;

const verification = Effect.gen(function* verifyCrmDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* CrmDatabase;

  for (const table of CRM_TABLES) {
    yield* Effect.tryPromise({
      catch: () =>
        new CrmDatabaseVerificationError({
          reason: `Typed verification failed for one ${CRM_SCHEMA_NAME} table`,
        }),
      try: () => database.executor.select().from(table).limit(0),
    });
  }

  const catalog = yield* Effect.tryPromise({
    catch: () =>
      new CrmDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL CRM catalog',
      }),
    try: () =>
      database.executor.execute<TableCatalogRow>(sql`
        select relation.relname as table_name
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = ${CRM_SCHEMA_NAME}
          and relation.relkind in (${'r'}, ${'p'})
        order by relation.relname
      `),
  });
  const difference = compareCrmCatalog(
    catalog.rows.map((row) => `${CRM_SCHEMA_NAME}.${row.table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new CrmDatabaseVerificationError({
      reason: `CRM catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* Effect.tryPromise({
    catch: () =>
      new CrmDatabaseVerificationError({
        reason: 'Unable to compare the PostgreSQL CRM column catalog',
      }),
    try: () =>
      database.executor.execute<ColumnCatalogRow>(sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${CRM_SCHEMA_NAME}
          and table_name in (${'contacts'}, ${'customers'})
        order by table_name, column_name
      `),
  });
  const actualColumns = columns.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const columnCatalogMismatch = describeColumnCatalogMismatch(actualColumns);
  if (columnCatalogMismatch !== undefined) {
    return yield* new CrmDatabaseVerificationError({
      reason: columnCatalogMismatch,
    });
  }

  const infrastructure = yield* Effect.tryPromise({
    catch: () =>
      new CrmDatabaseVerificationError({
        reason: 'Unable to verify CRM PostgreSQL constraints, RLS, ownership, or grants',
      }),
    try: () =>
      database.executor.execute<
        Record<string, unknown> & {
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
      >(sql`
        select
          pg_catalog.pg_get_userbyid(customer.relowner) as customer_owner,
          pg_catalog.pg_get_userbyid(contact.relowner) as contact_owner,
          (select count(*)::integer from pg_catalog.pg_constraint
            where conname = ${'crm_contacts_tenant_customer_fk'}) as foreign_key_count,
          (select count(*)::integer from pg_catalog.pg_class as journal
            inner join pg_catalog.pg_namespace as journal_namespace
              on journal_namespace.oid = journal.relnamespace
            where journal_namespace.nspname = ${'drizzle'}
              and journal.relname = ${'__drizzle_migrations_crm'}) as journal_count,
          (select count(*)::integer from pg_catalog.pg_policy as policy
            where policy.polrelid in (customer.oid, contact.oid)) as policy_count,
          has_schema_privilege(${'ontos_runtime'}, ${CRM_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
          has_schema_privilege(${'ontos_runtime'}, ${CRM_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
          has_table_privilege(${'ontos_runtime'}, ${'crm.customers'}, ${'SELECT'}) and
            has_table_privilege(${'ontos_runtime'}, ${'crm.contacts'}, ${'SELECT'}) as runtime_select,
          has_table_privilege(${'ontos_runtime'}, ${'crm.customers'}, ${'INSERT'}) and
            has_table_privilege(${'ontos_runtime'}, ${'crm.contacts'}, ${'INSERT'}) as runtime_insert,
          has_table_privilege(${'ontos_runtime'}, ${'crm.customers'}, ${'UPDATE'}) and
            has_table_privilege(${'ontos_runtime'}, ${'crm.contacts'}, ${'UPDATE'}) as runtime_update,
          has_table_privilege(${'ontos_runtime'}, ${'crm.customers'}, ${'DELETE'}) and
            has_table_privilege(${'ontos_runtime'}, ${'crm.contacts'}, ${'DELETE'}) as runtime_delete,
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
        where customer_namespace.nspname = ${CRM_SCHEMA_NAME}
          and customer.relname = ${'customers'}
          and contact_namespace.nspname = ${CRM_SCHEMA_NAME}
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
    return yield* new CrmDatabaseVerificationError({
      reason:
        'CRM database infrastructure does not match its ownership, RLS, journal, constraint, or grant contract',
    });
  }

  const activeCustomers = yield* Effect.tryPromise({
    catch: () =>
      new CrmDatabaseVerificationError({
        reason: 'Typed active-Customer verification failed',
      }),
    try: () => database.executor.select().from(customers).limit(0),
  });
  const activeContacts = yield* Effect.tryPromise({
    catch: () =>
      new CrmDatabaseVerificationError({
        reason: 'Typed active-Contact verification failed',
      }),
    try: () => database.executor.select().from(contacts).limit(0),
  });

  return {
    typedTableCount: CRM_TABLES.length,
    typedZeroRowQueries: activeCustomers.length + activeContacts.length,
  };
});

const runtime = CrmDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));

console.log(
  `Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${CRM_SCHEMA_NAME}`,
);
