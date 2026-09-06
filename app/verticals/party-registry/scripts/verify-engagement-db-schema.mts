// @effect-diagnostics globalConsole:off strictEffectProvide:off
import { DatabaseConfig, loadDatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { PartyDatabase, PartyDatabaseLive } from '../src/db/client.ts';
import { compareContactsCatalog } from '../src/db/engagement-catalog.ts';
import { CONTACTS_SCHEMA_NAME, CONTACTS_TABLES } from '../src/db/engagement-schema.ts';

class ContactsDatabaseVerificationError extends Schema.TaggedError<ContactsDatabaseVerificationError>()(
  'ContactsDatabaseVerificationError',
  { reason: Schema.String },
) {}

interface TableCatalogRow extends Readonly<Record<string, string>> {
  readonly table_name: string;
}
interface ColumnCatalogRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly table_name: string;
}
interface InfrastructureCatalogRow extends Readonly<Record<string, boolean | number | string>> {
  readonly foreign_key_count: number;
  readonly journal_count: number;
  readonly organization_owner: string;
  readonly person_owner: string;
  readonly policy_count: number;
  readonly rls_count: number;
  readonly role_bypass_rls: boolean;
  readonly role_super: boolean;
  readonly runtime_create: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly runtime_usage: boolean;
}

const expectedColumns = [
  'organization_engagement_profiles.archived_at',
  'organization_engagement_profiles.counterparty_resource_id',
  'organization_engagement_profiles.created_at',
  'organization_engagement_profiles.engagement_profile_id',
  'organization_engagement_profiles.party_resource_id',
  'organization_engagement_profiles.tenant_id',
  'organization_engagement_profiles.updated_at',
  'person_engagement_profiles.archived_at',
  'person_engagement_profiles.counterparty_resource_id',
  'person_engagement_profiles.created_at',
  'person_engagement_profiles.engagement_profile_id',
  'person_engagement_profiles.party_resource_id',
  'person_engagement_profiles.tenant_id',
  'person_engagement_profiles.updated_at',
] as const;

const infrastructureMatches = (verified: InfrastructureCatalogRow, adminUser: string): boolean =>
  verified.organization_owner === adminUser &&
  verified.person_owner === adminUser &&
  verified.foreign_key_count === 0 &&
  verified.journal_count === 1 &&
  verified.policy_count === 8 &&
  verified.rls_count === 2 &&
  !verified.runtime_create &&
  verified.runtime_usage &&
  verified.runtime_select &&
  verified.runtime_insert &&
  verified.runtime_update &&
  verified.runtime_delete &&
  !verified.role_super &&
  !verified.role_bypass_rls;

const verification = Effect.gen(function* verifyContactsDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = yield* PartyDatabase;

  for (const table of CONTACTS_TABLES) {
    yield* Effect.tryPromise({
      catch: () =>
        new ContactsDatabaseVerificationError({
          reason: 'Typed Contacts table verification failed',
        }),
      try: () => database.executor.select().from(table).limit(0),
    });
  }

  const catalog = yield* Effect.tryPromise({
    catch: () =>
      new ContactsDatabaseVerificationError({ reason: 'Unable to compare the Contacts catalog' }),
    try: () =>
      database.executor.execute<TableCatalogRow>(sql`
      select relation.relname as table_name
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${CONTACTS_SCHEMA_NAME} and relation.relkind in (${'r'}, ${'p'})
      order by relation.relname
    `),
  });
  const difference = compareContactsCatalog(
    catalog.rows.map((row) => `${CONTACTS_SCHEMA_NAME}.${row.table_name}`),
  );
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new ContactsDatabaseVerificationError({
      reason: `Contacts catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* Effect.tryPromise({
    catch: () =>
      new ContactsDatabaseVerificationError({ reason: 'Unable to compare Contacts columns' }),
    try: () =>
      database.executor.execute<ColumnCatalogRow>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = ${CONTACTS_SCHEMA_NAME}
        and table_name in (${'organization_engagement_profiles'}, ${'person_engagement_profiles'})
      order by table_name, column_name
    `),
  });
  const actualColumns = columns.rows.map((row) => `${row.table_name}.${row.column_name}`);
  if (
    actualColumns.length !== expectedColumns.length ||
    !actualColumns.every((column, index) => column === expectedColumns[index])
  ) {
    return yield* new ContactsDatabaseVerificationError({
      reason: `Contacts column catalog mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`,
    });
  }

  const infrastructure = yield* Effect.tryPromise({
    catch: () =>
      new ContactsDatabaseVerificationError({ reason: 'Unable to verify Contacts infrastructure' }),
    try: () =>
      database.executor.execute<InfrastructureCatalogRow>(sql`
      select
        pg_catalog.pg_get_userbyid(organization_profile.relowner) as organization_owner,
        pg_catalog.pg_get_userbyid(person_profile.relowner) as person_owner,
        (select count(*)::integer from pg_catalog.pg_constraint where contype = ${'f'} and connamespace = organization_namespace.oid) as foreign_key_count,
        (select count(*)::integer from pg_catalog.pg_class as journal inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace where journal_namespace.nspname = ${'drizzle'} and journal.relname = ${'__drizzle_migrations_contacts'}) as journal_count,
        (select count(*)::integer from pg_catalog.pg_policy as policy where policy.polrelid in (organization_profile.oid, person_profile.oid)) as policy_count,
        has_schema_privilege(${'ontos_runtime'}, ${CONTACTS_SCHEMA_NAME}, ${'CREATE'}) as runtime_create,
        has_schema_privilege(${'ontos_runtime'}, ${CONTACTS_SCHEMA_NAME}, ${'USAGE'}) as runtime_usage,
        has_table_privilege(${'ontos_runtime'}, ${'contacts.organization_engagement_profiles'}, ${'SELECT'}) and has_table_privilege(${'ontos_runtime'}, ${'contacts.person_engagement_profiles'}, ${'SELECT'}) as runtime_select,
        has_table_privilege(${'ontos_runtime'}, ${'contacts.organization_engagement_profiles'}, ${'INSERT'}) and has_table_privilege(${'ontos_runtime'}, ${'contacts.person_engagement_profiles'}, ${'INSERT'}) as runtime_insert,
        has_table_privilege(${'ontos_runtime'}, ${'contacts.organization_engagement_profiles'}, ${'UPDATE'}) and has_table_privilege(${'ontos_runtime'}, ${'contacts.person_engagement_profiles'}, ${'UPDATE'}) as runtime_update,
        has_table_privilege(${'ontos_runtime'}, ${'contacts.organization_engagement_profiles'}, ${'DELETE'}) and has_table_privilege(${'ontos_runtime'}, ${'contacts.person_engagement_profiles'}, ${'DELETE'}) as runtime_delete,
        runtime_role.rolsuper as role_super,
        runtime_role.rolbypassrls as role_bypass_rls,
        ((organization_profile.relrowsecurity and organization_profile.relforcerowsecurity)::integer + (person_profile.relrowsecurity and person_profile.relforcerowsecurity)::integer) as rls_count
      from pg_catalog.pg_class as organization_profile
      inner join pg_catalog.pg_namespace as organization_namespace on organization_namespace.oid = organization_profile.relnamespace
      cross join pg_catalog.pg_class as person_profile
      inner join pg_catalog.pg_namespace as person_namespace on person_namespace.oid = person_profile.relnamespace
      cross join pg_catalog.pg_roles as runtime_role
      where organization_namespace.nspname = ${CONTACTS_SCHEMA_NAME}
        and organization_profile.relname = ${'organization_engagement_profiles'}
        and person_namespace.nspname = ${CONTACTS_SCHEMA_NAME}
        and person_profile.relname = ${'person_engagement_profiles'}
        and runtime_role.rolname = ${'ontos_runtime'}
    `),
  });
  const [verified] = infrastructure.rows;
  if (verified === undefined || !infrastructureMatches(verified, connections.admin.user)) {
    return yield* new ContactsDatabaseVerificationError({
      reason: 'Contacts infrastructure does not match the engagement profile contract',
    });
  }

  return { typedTableCount: CONTACTS_TABLES.length };
});

const runtime = PartyDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));
console.log(
  `Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${CONTACTS_SCHEMA_NAME}`,
);
