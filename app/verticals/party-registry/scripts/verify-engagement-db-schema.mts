import { PARTY_REGISTRY_REQUEST_IDENTITY } from '../shared/database-identities.ts';
// @effect-diagnostics globalConsole:off strictEffectProvide:off -- Existing compatibility boundary; expires: 2026-12-31.
import { DatabaseConfig, loadDatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';

import { PartyDatabase, PartyDatabaseLive } from '../src/db/client.ts';
import { PARTY_REGISTRY_WORKER_PARTY_TABLES } from '../src/db/database-grants.ts';
import { compareContactsCatalog } from '../src/db/engagement-catalog.ts';
import { CONTACTS_SCHEMA_NAME, CONTACTS_TABLES } from '../src/db/engagement-schema.ts';
import { policyMismatches, rolePrivilegeMismatches, routineMismatches } from './database-role-contract.mts';

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

const runtimeRoleAttributesMatch = (verified: InfrastructureCatalogRow): boolean =>
  !verified.role_super && !verified.role_bypass_rls;

const infrastructureMatches = (verified: InfrastructureCatalogRow, adminUser: string): boolean =>
  verified.organization_owner === adminUser &&
  verified.person_owner === adminUser &&
  verified.foreign_key_count === 0 &&
  verified.journal_count === 1 &&
  verified.policy_count === 8 &&
  verified.rls_count === 2 &&
  runtimeRoleAttributesMatch(verified);

const verification = Effect.gen(function* verifyContactsDatabase() {
  const connections = yield* loadDatabaseConnectionPair({ identity: PARTY_REGISTRY_REQUEST_IDENTITY });
  const database = yield* PartyDatabase;

  for (const table of CONTACTS_TABLES) {
    yield* database.executor
      .select()
      .from(table)
      .limit(0)
      .pipe(
        Effect.mapError(
          () =>
            new ContactsDatabaseVerificationError({
              reason: 'Typed Contacts table verification failed',
            }),
        ),
      );
  }

  const catalog = yield* database.executor
    .execute<TableCatalogRow>(
      sql`
      select relation.relname as table_name
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${CONTACTS_SCHEMA_NAME} and relation.relkind in (${'r'}, ${'p'})
      order by relation.relname
    `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new ContactsDatabaseVerificationError({
            reason: 'Unable to compare the Contacts catalog',
          }),
      ),
    );
  const difference = compareContactsCatalog(catalog.map((row) => `${CONTACTS_SCHEMA_NAME}.${row.table_name}`));
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new ContactsDatabaseVerificationError({
      reason: `Contacts catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }

  const columns = yield* database.executor
    .execute<ColumnCatalogRow>(
      sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = ${CONTACTS_SCHEMA_NAME}
        and table_name in (${'organization_engagement_profiles'}, ${'person_engagement_profiles'})
      order by table_name, column_name
    `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new ContactsDatabaseVerificationError({
            reason: 'Unable to compare Contacts columns',
          }),
      ),
    );
  const actualColumns = columns.map((row) => `${row.table_name}.${row.column_name}`);
  if (
    actualColumns.length !== expectedColumns.length ||
    !actualColumns.every((column, index) => column === expectedColumns[index])
  ) {
    return yield* new ContactsDatabaseVerificationError({
      reason: `Contacts column catalog mismatch; expected=[${expectedColumns.join(', ')}], actual=[${actualColumns.join(', ')}]`,
    });
  }

  const infrastructure = yield* database.executor
    .execute<InfrastructureCatalogRow>(
      sql`
      select
        pg_catalog.pg_get_userbyid(organization_profile.relowner) as organization_owner,
        pg_catalog.pg_get_userbyid(person_profile.relowner) as person_owner,
        (select count(*)::integer from pg_catalog.pg_constraint where contype = ${'f'} and connamespace = organization_namespace.oid) as foreign_key_count,
        (select count(*)::integer from pg_catalog.pg_class as journal inner join pg_catalog.pg_namespace as journal_namespace on journal_namespace.oid = journal.relnamespace where journal_namespace.nspname = ${'drizzle'} and journal.relname = ${'__drizzle_migrations_contacts'}) as journal_count,
        (select count(*)::integer from pg_catalog.pg_policy as policy where policy.polrelid in (organization_profile.oid, person_profile.oid)) as policy_count,
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
        and runtime_role.rolname = ${PARTY_REGISTRY_REQUEST_IDENTITY.role}
    `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new ContactsDatabaseVerificationError({
            reason: 'Unable to verify Contacts infrastructure',
          }),
      ),
    );
  const [verified] = infrastructure;
  if (verified === undefined || !infrastructureMatches(verified, connections.admin.user)) {
    return yield* new ContactsDatabaseVerificationError({
      reason: 'Contacts infrastructure does not match the engagement profile contract',
    });
  }

  const accessMismatches = yield* Effect.all([
    rolePrivilegeMismatches(database.executor, CONTACTS_SCHEMA_NAME),
    policyMismatches(database.executor, CONTACTS_SCHEMA_NAME, CONTACTS_TABLES, PARTY_REGISTRY_WORKER_PARTY_TABLES),
    routineMismatches(database.executor, CONTACTS_SCHEMA_NAME, connections.admin.user),
  ]).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.mapError(
      () =>
        new ContactsDatabaseVerificationError({
          reason: 'Unable to verify Contacts grants, routines and row-level security policies',
        }),
    ),
  );
  if (accessMismatches.length > 0) {
    return yield* new ContactsDatabaseVerificationError({
      reason: `Contacts grants or policies do not match the database role manifest: ${accessMismatches.join('; ')}`,
    });
  }

  return { typedTableCount: CONTACTS_TABLES.length };
});

const runtime = PartyDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig({ identity: PARTY_REGISTRY_REQUEST_IDENTITY }))),
);
const result = await Effect.runPromise(Effect.provide(verification, runtime));
console.log(`Verified ${result.typedTableCount} typed tables in PostgreSQL schema ${CONTACTS_SCHEMA_NAME}`);
