/// <reference types="node" />
import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';

import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Effect, Order, Predicate, Redacted, Schema } from 'effect';
import type { Reactivity } from 'effect/unstable/reactivity';

import type { DatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';

import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identities.ts';
import type {
  DatabaseIdentity,
  DatabaseRoleGrants,
  DatabaseTableGrant,
  DatabaseTablePrivilege,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  RuntimeRoleBootstrapError,
  ensureDatabaseLoginRole,
  quoteIdentifier,
  runtimeRoleQueryFailure,
} from './database-login-roles.mts';
import type { DatabaseLoginCredentials } from './database-login-roles.mts';
import { DATABASE_ROLE_GRANT_MANIFEST, TRUST_ROUTINES } from './database-role-manifest.mts';
import type { DatabaseRoleGrantManifestEntry } from './database-role-manifest.mts';
import { PRICING_RUNTIME_ROUTINE_SIGNATURES, PRICING_RUNTIME_TABLE_GRANTS } from './runtime-role-grants.mts';

const tableExistsQuery = 'select pg_catalog.to_regclass($1) is not null as exists';
const routineExistsQuery = 'select pg_catalog.to_regprocedure($1) is not null as exists';
const schemaExistsQuery = 'select exists(select 1 from pg_catalog.pg_namespace where nspname = $1) as exists';
const TRUST_TABLES = [
  'trust.scope_sealing_keys',
  'trust.gateway_audience_roles',
  'trust.gateway_scope_grants',
] as const;
const RUNTIME_ROLES = DATABASE_IDENTITIES.map(({ role }) => role);
const runtimeRoleList = RUNTIME_ROLES.map(quoteIdentifier).join(', ');
const SHARED_RUNTIME_SCHEMAS = [
  'core',
  'auth',
  'catalog',
  'inventory',
  'tax',
  'privacy',
  'property_portfolio',
  'property_leasing',
  'legal_agreements',
  'work_tasks',
  'demo_workforce',
  'demo_tagging',
  'demo_crm',
  'demo_sales_pipeline',
  'demo_merchandise',
  'demo_email',
  'facility_operations',
  'demo_sales_insights',
  'finance_billing',
  'crm_activities',
] as const;

export interface ExplicitManifestEntry {
  readonly grants: DatabaseRoleGrants;
  readonly identity: DatabaseIdentity;
}

export type LegacySharedManifestEntry = Extract<DatabaseRoleGrantManifestEntry, { readonly kind: 'legacy_shared' }>;

export const explicitEntries: readonly ExplicitManifestEntry[] = DATABASE_ROLE_GRANT_MANIFEST.flatMap((entry) =>
  entry.kind === 'explicit' ? [{ grants: entry.grants, identity: entry.identity }] : [],
);

export const legacySharedEntries: readonly LegacySharedManifestEntry[] = DATABASE_ROLE_GRANT_MANIFEST.flatMap(
  (entry) => (entry.kind === 'legacy_shared' ? [entry] : []),
);

/** Every schema the manifest assigns or withholds; explicit roles lose all access here before their grants apply. */
export const MANIFEST_MANAGED_SCHEMAS: readonly string[] = [
  ...new Set([
    'trust',
    ...explicitEntries.flatMap(({ grants }) => grants.schemas),
    ...legacySharedEntries.flatMap(({ revokedSchemas }) => revokedSchemas),
  ]),
].filter((schema) => schema !== 'public');

/** Schemas the legacy shared role receives blanket privileges on: the baseline list minus its revoked schemas. */
export const sharedRuntimeGrantedSchemas = (entry: LegacySharedManifestEntry): readonly string[] =>
  SHARED_RUNTIME_SCHEMAS.filter((schema) => !entry.revokedSchemas.includes(schema));

/** Removes every current and future privilege the legacy shared role could hold in one withheld schema. */
export const sharedRuntimeSchemaRevokeStatements = (
  entry: LegacySharedManifestEntry,
  schema: string,
): readonly string[] => {
  const quotedSchema = quoteIdentifier(schema);
  const role = quoteIdentifier(entry.identity.role);
  return [
    `revoke all on all tables in schema ${quotedSchema} from ${role}`,
    `revoke all on all sequences in schema ${quotedSchema} from ${role}`,
    `revoke all on all functions in schema ${quotedSchema} from ${role}`,
    `revoke all on schema ${quotedSchema} from ${role}`,
    `alter default privileges in schema ${quotedSchema} revoke all on tables from ${role}`,
    `alter default privileges in schema ${quotedSchema} revoke all on sequences from ${role}`,
    `alter default privileges in schema ${quotedSchema} revoke all on functions from ${role}`,
  ];
};

const query = <Row extends object>(
  client: PgClient.PgClient,
  text: string,
  values?: readonly string[],
): Effect.Effect<readonly Row[], RuntimeRoleBootstrapError> =>
  client.unsafe<Row>(text, values).pipe(Effect.mapError(runtimeRoleQueryFailure));

const exists = (
  client: PgClient.PgClient,
  text: string,
  value: string,
): Effect.Effect<boolean, RuntimeRoleBootstrapError> =>
  query<{ exists: boolean }>(client, text, [value]).pipe(Effect.map((rows) => rows[0]?.exists ?? false));

const runStatements = (
  client: PgClient.PgClient,
  statements: readonly string[],
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.forEach(statements, (text) => query(client, text), { concurrency: 1, discard: true });

const textArrayElement = (value: string): string =>
  ['"', value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`), '"'].join('');

/** Encodes a PostgreSQL text[] literal so a list travels as one bound text parameter. */
const textArrayLiteral = (values: readonly string[]): string => `{${values.map(textArrayElement).join(',')}}`;

const qualifiedRelation = (relation: string): string => relation.split('.').map(quoteIdentifier).join('.');

/** Missing migration columns are skipped without widening a column grant to the whole table. */
export const tableGrantTarget = (
  privilege: DatabaseTablePrivilege,
  columns: DatabaseTableGrant['columns'],
  existingColumns: readonly string[],
): string | undefined => {
  const columnList = privilege === 'delete' ? undefined : columns?.[privilege];
  if (columnList === undefined) {
    return privilege;
  }
  const present = columnList.filter((column) => existingColumns.includes(column));
  return present.length === 0 ? undefined : `${privilege} (${present.map(quoteIdentifier).join(', ')})`;
};

const roleSettingStatement = (role: string, setting: string): string => {
  const separator = setting.indexOf('=');
  return `alter role ${quoteIdentifier(role)} set ${setting.slice(0, separator)} = ${setting.slice(separator + 1)}`;
};

export const bootstrapFailure = (reason: string): RuntimeRoleBootstrapError =>
  new RuntimeRoleBootstrapError({ reason });

export const connectAdmin = (connectionString: Redacted.Redacted) =>
  PgClient.makeClient({ url: connectionString }).pipe(
    Effect.mapError(() => bootstrapFailure('Unable to connect to the administrative PostgreSQL database')),
  );

const resetLoginRole = (
  client: PgClient.PgClient,
  database: string,
  entry: DatabaseRoleGrantManifestEntry,
  credentials: DatabaseLoginCredentials,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* resetLoginRoleEffect() {
    const { role } = entry.identity;
    yield* ensureDatabaseLoginRole(client, { credentials, database, role });
    const memberships = yield* query<{ granted_role: string; grantor: string; member: string }>(
      client,
      `select granted.rolname as granted_role, member_role.rolname as member, grantor.rolname as grantor
         from pg_catalog.pg_auth_members as membership
         join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
         join pg_catalog.pg_roles as member_role on member_role.oid = membership.member
         join pg_catalog.pg_roles as grantor on grantor.oid = membership.grantor
        where granted.rolname = $1 or member_role.rolname = $1`,
      [role],
    );
    yield* Effect.forEach(
      memberships,
      ({ granted_role, grantor, member }) =>
        query(
          client,
          `revoke ${quoteIdentifier(granted_role)} from ${quoteIdentifier(member)} granted by ${quoteIdentifier(grantor)}`,
        ),
      { concurrency: 1, discard: true },
    );
    yield* query(client, `alter role ${quoteIdentifier(role)} reset all`);
    yield* query(client, `alter role ${quoteIdentifier(role)} in database ${quoteIdentifier(database)} reset all`);
    yield* Effect.forEach(entry.roleSettings, (setting) => query(client, roleSettingStatement(role, setting)), {
      concurrency: 1,
      discard: true,
    });
  });

export const grantSharedRuntimeRole = (
  client: PgClient.PgClient,
  entry: LegacySharedManifestEntry,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* grantSharedRuntimeRoleEffect() {
    yield* Effect.forEach(
      sharedRuntimeGrantedSchemas(entry),
      (schema) =>
        Effect.gen(function* grantSchemaPrivilegesEffect() {
          if (yield* exists(client, schemaExistsQuery, schema)) {
            yield* query(client, `grant usage on schema ${schema} to ontos_runtime`);
            yield* query(
              client,
              `grant select, insert, update, delete on all tables in schema ${schema} to ontos_runtime`,
            );
            // Replay receipts allow insertion and expiry pruning, never alteration of a redeemed assertion.
            const redemptions = `${schema}.gateway_assertion_redemptions`;
            if (yield* exists(client, tableExistsQuery, redemptions)) {
              yield* query(
                client,
                `revoke update on table ${qualifiedRelation(redemptions)} from public, ontos_runtime`,
              );
            }
            yield* query(client, `grant usage, select on all sequences in schema ${schema} to ontos_runtime`);
            yield* query(
              client,
              `alter default privileges in schema ${schema} grant select, insert, update, delete on tables to ontos_runtime`,
            );
            yield* query(
              client,
              `alter default privileges in schema ${schema} grant usage, select on sequences to ontos_runtime`,
            );
          }
        }),
      { concurrency: 1, discard: true },
    );
    // Schemas owned by dedicated identities stay closed to the shared runtime role, including future objects.
    yield* Effect.forEach(
      entry.revokedSchemas,
      (schema) =>
        Effect.gen(function* revokeDedicatedSchemaEffect() {
          if (yield* exists(client, schemaExistsQuery, schema)) {
            yield* runStatements(client, sharedRuntimeSchemaRevokeStatements(entry, schema));
          }
        }),
      { concurrency: 1, discard: true },
    );
    // Privacy's immutable ledgers must retain the restrictions installed by their owner migrations.
    const privacyLedgers = yield* query<{ table_name: string }>(
      client,
      `select distinct relation.relname as table_name
         from pg_catalog.pg_trigger as trigger_record
         join pg_catalog.pg_class as relation on relation.oid = trigger_record.tgrelid
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         join pg_catalog.pg_proc as routine on routine.oid = trigger_record.tgfoid
         join pg_catalog.pg_namespace as routine_namespace on routine_namespace.oid = routine.pronamespace
        where namespace.nspname = 'privacy' and routine_namespace.nspname = 'privacy'
          and routine.proname = 'reject_immutable_ledger_mutation' and not trigger_record.tgisinternal`,
    );
    yield* Effect.forEach(
      privacyLedgers,
      ({ table_name }) =>
        query(client, `revoke update, delete on table privacy.${quoteIdentifier(table_name)} from ontos_runtime`),
      { concurrency: 1, discard: true },
    );
    if (yield* exists(client, tableExistsQuery, 'core.application_composition_authority')) {
      yield* query(client, 'revoke all on table core.application_composition_authority from public, ontos_runtime');
      yield* query(client, 'grant select on table core.application_composition_authority to ontos_runtime');
    }
    if (yield* exists(client, tableExistsQuery, 'core.application_composition_durable_work')) {
      yield* query(client, 'revoke all on table core.application_composition_durable_work from public, ontos_runtime');
      yield* query(client, 'grant select on table core.application_composition_durable_work to ontos_runtime');
    }
    if (
      yield* exists(
        client,
        routineExistsQuery,
        'core.track_application_composition_durable_work(text,text,text,boolean)',
      )
    ) {
      yield* query(
        client,
        'revoke all on function core.track_application_composition_durable_work(text,text,text,boolean) from public, ontos_runtime',
      );
    }
    if (yield* exists(client, schemaExistsQuery, 'pricing')) {
      yield* query(client, 'revoke all on schema pricing from public, ontos_runtime');
      yield* query(client, 'grant usage on schema pricing to ontos_runtime');
      yield* Effect.forEach(
        PRICING_RUNTIME_TABLE_GRANTS,
        ({ privileges, table }) =>
          Effect.gen(function* grantPricingTablePrivilegesEffect() {
            const qualifiedTable = `pricing.${quoteIdentifier(table)}`;
            if (yield* exists(client, tableExistsQuery, `pricing.${table}`)) {
              yield* query(client, `revoke all on table ${qualifiedTable} from public, ontos_runtime`);
              yield* query(client, `grant ${privileges.join(', ')} on table ${qualifiedTable} to ontos_runtime`);
            }
          }),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        PRICING_RUNTIME_ROUTINE_SIGNATURES,
        (signature) =>
          Effect.gen(function* grantPricingRoutinePrivilegesEffect() {
            if (yield* exists(client, routineExistsQuery, signature)) {
              yield* query(client, `revoke all on function ${signature} from public, ontos_runtime`);
              yield* query(client, `grant execute on function ${signature} to ontos_runtime`);
            }
          }),
        { concurrency: 1, discard: true },
      );
    }
  });

export const grantExplicitRole = (
  client: PgClient.PgClient,
  { grants, identity }: ExplicitManifestEntry,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* grantExplicitRoleEffect() {
    const role = quoteIdentifier(identity.role);
    yield* Effect.forEach(
      MANIFEST_MANAGED_SCHEMAS,
      (schema) =>
        Effect.gen(function* revokeExplicitSchemaEffect() {
          if (yield* exists(client, schemaExistsQuery, schema)) {
            const quotedSchema = quoteIdentifier(schema);
            yield* query(client, `revoke all on all tables in schema ${quotedSchema} from ${role}`);
            yield* query(client, `revoke all on all sequences in schema ${quotedSchema} from ${role}`);
            yield* query(client, `revoke all on all functions in schema ${quotedSchema} from ${role}`);
            yield* query(client, `revoke all on schema ${quotedSchema} from ${role}`);
          }
        }),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      grants.schemas.filter((schema) => schema !== 'public'),
      (schema) =>
        Effect.gen(function* grantExplicitSchemaEffect() {
          if (yield* exists(client, schemaExistsQuery, schema)) {
            yield* query(client, `grant usage on schema ${quoteIdentifier(schema)} to ${role}`);
          }
        }),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      grants.tables,
      ({ columns, privileges, table }) =>
        Effect.gen(function* grantExplicitTableEffect() {
          if (yield* exists(client, tableExistsQuery, table)) {
            const attributes =
              columns === undefined
                ? []
                : yield* query<{ attname: string }>(
                    client,
                    `select attname from pg_catalog.pg_attribute
                where attrelid = pg_catalog.to_regclass($1) and attnum > 0 and not attisdropped`,
                    [table],
                  );
            const existingColumns: string[] = [];
            for (const { attname } of attributes) {
              existingColumns.push(attname);
            }
            const targets: string[] = [];
            for (const privilege of privileges) {
              const target = tableGrantTarget(privilege, columns, existingColumns);
              if (target !== undefined) {
                targets.push(target);
              }
            }
            // One GRANT accepts the same per-privilege column lists. Keep this inside the
            // existing bootstrap transaction, after revocation and before exact assertions.
            if (targets.length > 0) {
              yield* query(client, `grant ${targets.join(', ')} on table ${qualifiedRelation(table)} to ${role}`);
            }
          }
        }),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      grants.sequences,
      ({ privileges, sequence }) =>
        Effect.gen(function* grantExplicitSequenceEffect() {
          if (yield* exists(client, tableExistsQuery, sequence)) {
            yield* query(
              client,
              `grant ${privileges.join(', ')} on sequence ${qualifiedRelation(sequence)} to ${role}`,
            );
          }
        }),
      { concurrency: 1, discard: true },
    );
    // Trust routines are re-synchronized by grantTrustAuthority; owner routines keep only manifest executors.
    yield* Effect.forEach(
      grants.routines,
      (signature) =>
        Effect.gen(function* grantExplicitRoutineEffect() {
          if (yield* exists(client, routineExistsQuery, signature)) {
            yield* query(client, `grant execute on function ${signature} to ${role}`);
          }
        }),
      { concurrency: 1, discard: true },
    );
  });

export const grantTrustAuthority = (client: PgClient.PgClient): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* grantTrustAuthorityEffect() {
    if (!(yield* exists(client, schemaExistsQuery, 'trust'))) {
      return;
    }
    const executingRoles = new Set<string>();
    yield* Effect.forEach(
      TRUST_ROUTINES,
      ({ executableBy, signature }) =>
        Effect.gen(function* grantTrustRoutineEffect() {
          if (yield* exists(client, routineExistsQuery, signature)) {
            yield* query(client, `revoke all on function ${signature} from public, ${runtimeRoleList}`);
            if (executableBy.length > 0) {
              yield* query(
                client,
                `grant execute on function ${signature} to ${executableBy.map(quoteIdentifier).join(', ')}`,
              );
              for (const role of executableBy) {
                executingRoles.add(role);
              }
            }
          }
        }),
      { concurrency: 1, discard: true },
    );
    yield* query(client, `revoke all on schema trust from ${runtimeRoleList}`);
    if (executingRoles.size > 0) {
      yield* query(client, `grant usage on schema trust to ${[...executingRoles].map(quoteIdentifier).join(', ')}`);
    }
    yield* Effect.forEach(
      TRUST_TABLES,
      (table) =>
        Effect.gen(function* revokeTrustTableEffect() {
          if (yield* exists(client, tableExistsQuery, table)) {
            yield* query(client, `revoke all on table ${table} from public, ${runtimeRoleList}`);
          }
        }),
      { concurrency: 1, discard: true },
    );
    if (yield* exists(client, tableExistsQuery, 'trust.gateway_audience_roles')) {
      const audienceRoles = DATABASE_IDENTITIES.filter(
        ({ scopeAuthority }) => scopeAuthority === 'gateway_grant',
      ).flatMap(({ gatewayScopeAudiences, role }) => gatewayScopeAudiences.map((audience) => ({ audience, role })));
      yield* Effect.forEach(
        audienceRoles,
        ({ audience, role }) =>
          query(
            client,
            `insert into trust.gateway_audience_roles (audience, role_name) values ($1, $2)
             on conflict (audience) do update set role_name = excluded.role_name`,
            [audience, role],
          ),
        { concurrency: 1, discard: true },
      );
      yield* query(client, 'delete from trust.gateway_audience_roles where audience <> all($1::text[])', [
        textArrayLiteral(audienceRoles.map(({ audience }) => audience)),
      ]);
    }
  });

const failWhenRowsExist = <Row extends object>(
  client: PgClient.PgClient,
  text: string,
  values: readonly string[],
  describe: (rows: readonly Row[]) => string,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  query<Row>(client, text, values).pipe(
    Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : Effect.fail(bootstrapFailure(describe(rows))))),
  );

export const assertLoginRole = (
  client: PgClient.PgClient,
  entry: DatabaseRoleGrantManifestEntry,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* assertLoginRoleEffect() {
    const { role } = entry.identity;
    const [attributes] = yield* query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      client,
      `select rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, rolinherit
         from pg_catalog.pg_roles where rolname = $1`,
      [role],
    );
    if (
      attributes === undefined ||
      !attributes.rolcanlogin ||
      attributes.rolsuper ||
      attributes.rolbypassrls ||
      attributes.rolcreatedb ||
      attributes.rolcreaterole ||
      attributes.rolreplication ||
      attributes.rolinherit
    ) {
      yield* bootstrapFailure(
        `Runtime role ${role} must be a non-inheriting login without superuser, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION`,
      );
    }
    yield* failWhenRowsExist<{ granted_role: string; member: string }>(
      client,
      `select membership.roleid::regrole::text as granted_role, membership.member::regrole::text as member
         from pg_catalog.pg_auth_members as membership
         join pg_catalog.pg_roles as runtime_role on runtime_role.oid in (membership.roleid, membership.member)
        where runtime_role.rolname = $1`,
      [role],
      (rows) =>
        `Runtime role ${role} must have no role memberships: ${rows.map((row) => [row.granted_role, row.member].join('->')).join(', ')}`,
    );
    yield* failWhenRowsExist<{ catalog: string; object_count: number }>(
      client,
      `with owner as (select oid from pg_catalog.pg_roles where rolname = $1)
       select catalog, object_count from (
         select 'pg_class' as catalog, count(*)::int as object_count from pg_catalog.pg_class where relowner = (select oid from owner)
         union all select 'pg_proc', count(*)::int from pg_catalog.pg_proc where proowner = (select oid from owner)
         union all select 'pg_namespace', count(*)::int from pg_catalog.pg_namespace where nspowner = (select oid from owner)
         union all select 'pg_type', count(*)::int from pg_catalog.pg_type where typowner = (select oid from owner)
         union all select 'pg_database', count(*)::int from pg_catalog.pg_database where datdba = (select oid from owner)
       ) as owned where object_count > 0`,
      [role],
      (rows) =>
        `Runtime role ${role} must own no objects: ${rows.map((row) => [row.catalog, row.object_count].join('=')).join(', ')}`,
    );
    yield* failWhenRowsExist<{ object_name: string }>(
      client,
      `select 'schema ' || namespace.nspname as object_name
         from pg_catalog.pg_namespace as namespace
        where namespace.nspname not like 'pg\\_temp\\_%' and namespace.nspname not like 'pg\\_toast\\_temp\\_%'
          and pg_catalog.has_schema_privilege($1, namespace.oid, 'CREATE')
       union all
       select 'database ' || current_database() where pg_catalog.has_database_privilege($1, current_database(), 'CREATE')`,
      [role],
      (rows) => `Runtime role ${role} must have no CREATE authority: ${rows.map((row) => row.object_name).join(', ')}`,
    );
    const [temporary] = yield* query<{ allowed: boolean }>(
      client,
      `select pg_catalog.has_database_privilege($1, current_database(), 'TEMPORARY') as allowed`,
      [role],
    );
    if (temporary?.allowed !== entry.databaseTemporary) {
      yield* bootstrapFailure(
        `Runtime role ${role} must ${entry.databaseTemporary ? 'have' : 'not have'} TEMPORARY on the database`,
      );
    }
    const [settings] = yield* query<{ settings: string }>(
      client,
      `select coalesce(pg_catalog.string_agg(setting, ',' order by setting), '') as settings
         from pg_catalog.pg_db_role_setting as role_setting
         cross join lateral pg_catalog.unnest(role_setting.setconfig) as setting
        where role_setting.setrole = (select oid from pg_catalog.pg_roles where rolname = $1)
          and role_setting.setdatabase in (0, (select oid from pg_catalog.pg_database where datname = current_database()))`,
      [role],
    );
    const expectedSettings = EffectArray.sort(entry.roleSettings, Order.String).join(',');
    if ((settings?.settings ?? '') !== expectedSettings) {
      yield* bootstrapFailure(
        `Runtime role ${role} settings must be exactly [${expectedSettings}], found [${settings?.settings ?? ''}]`,
      );
    }
  });

const grantedTablePrivileges = (grants: DatabaseRoleGrants): readonly string[] =>
  grants.tables.flatMap(({ columns, privileges, table }) =>
    privileges.flatMap((privilege) =>
      privilege !== 'delete' && columns?.[privilege] !== undefined ? [] : [`${table}:${privilege.toUpperCase()}`],
    ),
  );

const grantedColumnPrivileges = (grants: DatabaseRoleGrants): readonly string[] =>
  grants.tables.flatMap(({ columns, table }) =>
    Object.entries(columns ?? {}).flatMap(([privilege, columnNames]) =>
      (columnNames ?? []).map((column) => `${table}.${column}:${privilege.toUpperCase()}`),
    ),
  );

const grantedSequencePrivileges = (grants: DatabaseRoleGrants): readonly string[] =>
  grants.sequences.flatMap(({ privileges, sequence }) =>
    privileges.map((privilege) => `${sequence}:${privilege.toUpperCase()}`),
  );

const failWhenManifestPrivilegesMissing = (
  client: PgClient.PgClient,
  role: string,
  kind: string,
  text: string,
  values: readonly string[],
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  failWhenRowsExist<{ grant: string }>(
    client,
    text,
    [role, textArrayLiteral(values)],
    (rows) => `Runtime role ${role} is missing manifest ${kind} privileges: ${rows.map((row) => row.grant).join(', ')}`,
  );

/**
 * Fails when a manifest privilege on an existing object is absent. Objects that do not exist yet are
 * skipped, matching the grant pass: bootstrap runs before and after the owning migrations.
 */
const assertManifestPrivilegesPresent = (
  client: PgClient.PgClient,
  { grants, identity }: ExplicitManifestEntry,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* assertManifestPrivilegesPresentEffect() {
    const { role } = identity;
    const missing = (kind: string, text: string, values: readonly string[]) =>
      failWhenManifestPrivilegesMissing(client, role, kind, text, values);
    yield* missing(
      'table',
      `select expected as grant
         from pg_catalog.unnest($2::text[]) as expected
        cross join lateral (
          select pg_catalog.to_regclass(pg_catalog.split_part(expected, ':', 1)) as relation,
                 pg_catalog.split_part(expected, ':', 2) as privilege
        ) as parts
        where parts.relation is not null
          and not pg_catalog.has_table_privilege($1, parts.relation, parts.privilege)
        order by 1`,
      grantedTablePrivileges(grants),
    );
    yield* missing(
      'column',
      `select expected as grant
         from pg_catalog.unnest($2::text[]) as expected
        cross join lateral (
          select pg_catalog.regexp_match(expected, '^([^.]+[.][^.]+)[.]([^:]+):(.+)$') as part
        ) as parsed
        cross join lateral (select pg_catalog.to_regclass(parsed.part[1]) as relation) as target
         join pg_catalog.pg_attribute as attribute
           on attribute.attrelid = target.relation and attribute.attname = parsed.part[2]
          and attribute.attnum > 0 and not attribute.attisdropped
        where target.relation is not null
          and not coalesce(pg_catalog.has_column_privilege($1, target.relation, attribute.attnum, parsed.part[3]), false)
        order by 1`,
      grantedColumnPrivileges(grants),
    );
    yield* missing(
      'sequence',
      `select expected as grant
         from pg_catalog.unnest($2::text[]) as expected
        cross join lateral (
          select pg_catalog.to_regclass(pg_catalog.split_part(expected, ':', 1)) as relation,
                 pg_catalog.split_part(expected, ':', 2) as privilege
        ) as parts
        where parts.relation is not null
          and not pg_catalog.has_sequence_privilege($1, parts.relation, parts.privilege)
        order by 1`,
      grantedSequencePrivileges(grants),
    );
    yield* missing(
      'routine',
      `select signature as grant
         from pg_catalog.unnest($2::text[]) as signature
        where pg_catalog.to_regprocedure(signature) is not null
          and not pg_catalog.has_function_privilege($1, pg_catalog.to_regprocedure(signature), 'EXECUTE')
        order by 1`,
      grants.routines,
    );
    yield* missing(
      'schema USAGE',
      `select namespace.nspname as grant
         from pg_catalog.pg_namespace as namespace
        where namespace.nspname = any($2::text[])
          and not pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')
        order by 1`,
      grants.schemas,
    );
  });

export const assertExplicitRole = (
  client: PgClient.PgClient,
  { grants, identity }: ExplicitManifestEntry,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* assertExplicitRoleEffect() {
    const { role } = identity;
    yield* failWhenRowsExist<{ grant: string }>(
      client,
      `select namespace.nspname || '.' || relation.relname || ':' || privilege as grant
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         cross join pg_catalog.unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) as privilege
        where relation.relkind in ('r', 'p', 'v', 'm', 'f')
          and namespace.nspname not in ('pg_catalog', 'information_schema')
          and pg_catalog.has_table_privilege($1, relation.oid, privilege)
          and namespace.nspname || '.' || relation.relname || ':' || privilege <> all($2::text[])
        order by 1`,
      [role, textArrayLiteral(grantedTablePrivileges(grants))],
      (rows) =>
        `Runtime role ${role} has table privileges outside its manifest: ${rows.map((row) => row.grant).join(', ')}`,
    );
    yield* failWhenRowsExist<{ grant: string }>(
      client,
      `select namespace.nspname || '.' || relation.relname || '.' || attribute.attname || ':' || acl.privilege_type as grant
         from pg_catalog.pg_attribute as attribute
         join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         cross join lateral pg_catalog.aclexplode(attribute.attacl) as acl
        where attribute.attacl is not null
          and namespace.nspname not in ('pg_catalog', 'information_schema')
          and namespace.nspname not like 'pg\\_%'
          and acl.grantee in (0, (select oid from pg_catalog.pg_roles where rolname = $1))
          and namespace.nspname || '.' || relation.relname || '.' || attribute.attname || ':' || acl.privilege_type <> all($2::text[])
        order by 1`,
      [role, textArrayLiteral(grantedColumnPrivileges(grants))],
      (rows) =>
        `Runtime role ${role} has column privileges outside its manifest: ${rows.map((row) => row.grant).join(', ')}`,
    );
    yield* failWhenRowsExist<{ grant: string }>(
      client,
      `select namespace.nspname || '.' || relation.relname || ':' || privilege as grant
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         cross join pg_catalog.unnest(array['USAGE','SELECT','UPDATE']) as privilege
        where relation.relkind = 'S'
          and namespace.nspname not in ('pg_catalog', 'information_schema')
          and pg_catalog.has_sequence_privilege($1, relation.oid, privilege)
          and namespace.nspname || '.' || relation.relname || ':' || privilege <> all($2::text[])
        order by 1`,
      [role, textArrayLiteral(grantedSequencePrivileges(grants))],
      (rows) =>
        `Runtime role ${role} has sequence privileges outside its manifest: ${rows.map((row) => row.grant).join(', ')}`,
    );
    // A routine is reachable only through a schema the role can use; schema USAGE is asserted below.
    yield* failWhenRowsExist<{ routine: string }>(
      client,
      `select routine.oid::regprocedure::text as routine
         from pg_catalog.pg_proc as routine
         join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
        where routine.prosecdef
          and namespace.nspname not in ('pg_catalog', 'information_schema')
          and pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')
          and pg_catalog.has_function_privilege($1, routine.oid, 'EXECUTE')
          and routine.oid not in (
            select pg_catalog.to_regprocedure(signature)::oid
              from pg_catalog.unnest($2::text[]) as signature
             where pg_catalog.to_regprocedure(signature) is not null
          )
        order by 1`,
      [role, textArrayLiteral(grants.routines)],
      (rows) =>
        `Runtime role ${role} can execute SECURITY DEFINER routines outside its manifest: ${rows.map((row) => row.routine).join(', ')}`,
    );
    yield* failWhenRowsExist<{ schema_name: string }>(
      client,
      `select namespace.nspname as schema_name
         from pg_catalog.pg_namespace as namespace
        where namespace.nspname not in ('pg_catalog', 'information_schema') and namespace.nspname not like 'pg\\_%'
          and pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')
          and namespace.nspname <> all($2::text[])
        order by 1`,
      [role, textArrayLiteral([...grants.schemas, 'public'])],
      (rows) =>
        `Runtime role ${role} has schema USAGE outside its manifest: ${rows.map((row) => row.schema_name).join(', ')}`,
    );
    // Explicit identities declare individual objects, never blanket access to future tables or sequences.
    // Check every creator, global and schema ACL, including PUBLIC and reachable grantees.
    yield* failWhenRowsExist<{ grant: string }>(
      client,
      `select creator.rolname || ':' || coalesce(namespace.nspname, '*') || ':' || defaults.defaclobjtype::text || ':' || acl.privilege_type as grant
         from pg_catalog.pg_default_acl as defaults
         join pg_catalog.pg_roles as creator on creator.oid = defaults.defaclrole
         left join pg_catalog.pg_namespace as namespace on namespace.oid = defaults.defaclnamespace
         cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as acl
        where defaults.defaclobjtype in ('r', 'S')
          and (defaults.defaclnamespace = 0 or (namespace.nspname not in ('pg_catalog', 'information_schema') and namespace.nspname !~ '^pg_'))
          and case when acl.grantee = 0 then true else (acl.grantee = (select oid from pg_catalog.pg_roles where rolname = $1)
               or pg_catalog.pg_has_role($1, acl.grantee, 'USAGE') or pg_catalog.pg_has_role($1, acl.grantee, 'SET')) end
        order by 1`,
      [role],
      (rows) =>
        `Runtime role ${role} has default privileges outside its manifest: ${rows.map((row) => row.grant).join(', ')}`,
    );
    yield* assertManifestPrivilegesPresent(client, { grants, identity });
  });

/** Post-migration readiness must reject missing objects that the pre-migration bootstrap may skip. */
export const assertDatabaseRoleManifestComplete = (
  client: PgClient.PgClient,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* assertDatabaseRoleManifestCompleteEffect() {
    const tables = [
      ...new Set([
        ...TRUST_TABLES,
        ...explicitEntries.flatMap(({ grants }) => grants.tables.map(({ table }) => table)),
      ]),
    ];
    const sequences = [
      ...new Set(explicitEntries.flatMap(({ grants }) => grants.sequences.map(({ sequence }) => sequence))),
    ];
    const routines = [
      ...new Set([
        ...TRUST_ROUTINES.map(({ signature }) => signature),
        ...explicitEntries.flatMap(({ grants }) => grants.routines),
      ]),
    ];
    const columns = [
      ...new Set(
        explicitEntries.flatMap(({ grants }) =>
          grantedColumnPrivileges(grants).map((grant) => grant.slice(0, grant.indexOf(':'))),
        ),
      ),
    ];
    yield* failWhenRowsExist<{ object_name: string }>(
      client,
      `select expected as object_name from pg_catalog.unnest($1::text[]) as expected
        where not exists (select 1 from pg_catalog.pg_class where oid = pg_catalog.to_regclass(expected) and relkind in ('r', 'p'))
       union all
       select expected from pg_catalog.unnest($2::text[]) as expected
        where not exists (select 1 from pg_catalog.pg_class where oid = pg_catalog.to_regclass(expected) and relkind = 'S')
       union all
       select expected from pg_catalog.unnest($3::text[]) as expected
        where pg_catalog.to_regprocedure(expected) is null
       union all
       select expected from pg_catalog.unnest($4::text[]) as expected
        cross join lateral (
          select pg_catalog.regexp_match(expected, '^([^.]+[.][^.]+)[.]([^.]+)$') as part
        ) as parsed
        where not exists (
          select 1 from pg_catalog.pg_attribute as attribute
           where attribute.attrelid = pg_catalog.to_regclass(parsed.part[1])
             and attribute.attname = parsed.part[2] and attribute.attnum > 0 and not attribute.attisdropped
        )
       order by 1`,
      [textArrayLiteral(tables), textArrayLiteral(sequences), textArrayLiteral(routines), textArrayLiteral(columns)],
      (rows) =>
        `Required database role manifest objects are missing: ${rows.map(({ object_name }) => object_name).join(', ')}`,
    );
    const audiences = yield* query<{ audience: string; role_name: string }>(
      client,
      'select audience, role_name::text from trust.gateway_audience_roles order by audience',
    );
    if (
      audiences.length !== 1 ||
      audiences[0]?.audience !== 'party-registry' ||
      audiences[0]?.role_name !== 'party_registry_runtime'
    ) {
      yield* bootstrapFailure(
        'trust.gateway_audience_roles must contain exactly party-registry -> party_registry_runtime',
      );
    }
    for (const entry of DATABASE_ROLE_GRANT_MANIFEST) {
      yield* assertLoginRole(client, entry);
    }
    for (const entry of explicitEntries) {
      yield* assertExplicitRole(client, entry);
    }
  });

/** Extension views can expose assertion-bearing SQL even without a direct role grant. */
export const revokePublicStatementStatistics = (
  client: PgClient.PgClient,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.forEach(
    ['public.pg_stat_statements', 'public.pg_stat_statements_info'],
    (relation) =>
      Effect.gen(function* revokeStatisticsEffect() {
        if (yield* exists(client, tableExistsQuery, relation)) {
          yield* query(client, `revoke select on table ${qualifiedRelation(relation)} from public`);
        }
      }),
    { concurrency: 1, discard: true },
  );

export const RuntimeRoleBootstrapModeSchema = Schema.Literals(['reconcile', 'initialize-local']);
export type RuntimeRoleBootstrapMode = typeof RuntimeRoleBootstrapModeSchema.Type;

/** Check the complete manifest, not just whichever credentials the caller supplied. No writes or transaction here. */
const preflightProtectedLogins = (client: PgClient.PgClient, connections: DatabaseIdentityConnections) =>
  Effect.gen(function* preflightProtectedLoginsEffect() {
    for (const { identity } of explicitEntries) {
      if (
        !(yield* exists(
          client,
          'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
          identity.role,
        ))
      ) {
        return yield* bootstrapFailure(`Protected PostgreSQL role ${identity.role} is missing`);
      }
    }
    for (const { identity } of explicitEntries) {
      const connection = connections.runtime[identity.id];
      if (connection === undefined) {
        return yield* bootstrapFailure(`The protected ${identity.urlKey} connection is unavailable`);
      }
      yield* Effect.gen(function* authenticateProtectedLogin() {
        const login = yield* PgClient.makeClient({
          connectTimeout: '10 seconds',
          url: Redacted.make(connection.connectionString),
        });
        const [session] = yield* login.unsafe<{ database: string; role: string }>(
          'select current_database() as database, session_user as role',
        );
        if (session?.database !== connections.admin.database || session.role !== identity.role) {
          return yield* bootstrapFailure('Unexpected PostgreSQL login identity or database');
        }
        return yield* Effect.void;
      }).pipe(
        Effect.scoped,
        Effect.mapError(() =>
          bootstrapFailure(
            `Unable to authenticate the protected ${identity.urlKey} connection to its intended database`,
          ),
        ),
      );
    }
    return yield* Effect.void;
  });

const applyRuntimeRoleBootstrap = (
  client: PgClient.PgClient,
  database: string,
  credentials: ReadonlyMap<string, DatabaseLoginCredentials>,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* applyRuntimeRoleBootstrapEffect() {
    yield* Effect.forEach(
      DATABASE_ROLE_GRANT_MANIFEST,
      (entry) => {
        const login = credentials.get(entry.identity.role);
        return login === undefined
          ? Effect.fail(bootstrapFailure(`Missing the ${entry.identity.urlKey} credential policy`))
          : resetLoginRole(client, database, entry, login);
      },
      { concurrency: 1, discard: true },
    );
    yield* revokePublicStatementStatistics(client);
    const quotedDatabase = quoteIdentifier(database);
    yield* query(client, `revoke temporary on database ${quotedDatabase} from public`);
    yield* query(client, `revoke temporary, create on database ${quotedDatabase} from ${runtimeRoleList}`);
    yield* query(client, `grant temporary on database ${quotedDatabase} to ${SHARED_RUNTIME_IDENTITY.role}`);
    yield* Effect.forEach(legacySharedEntries, (entry) => grantSharedRuntimeRole(client, entry), {
      concurrency: 1,
      discard: true,
    });
    yield* Effect.forEach(explicitEntries, (entry) => grantExplicitRole(client, entry), {
      concurrency: 1,
      discard: true,
    });
    yield* grantTrustAuthority(client);
    yield* Effect.forEach(DATABASE_ROLE_GRANT_MANIFEST, (entry) => assertLoginRole(client, entry), {
      concurrency: 1,
      discard: true,
    });
    yield* Effect.forEach(explicitEntries, (entry) => assertExplicitRole(client, entry), {
      concurrency: 1,
      discard: true,
    });
  }).pipe(
    client.withTransaction,
    Effect.mapError((failure) => (Predicate.isTagged(failure, 'SqlError') ? runtimeRoleQueryFailure() : failure)),
  );

export const bootstrapRuntimeRoles = (
  client: PgClient.PgClient,
  connections: DatabaseIdentityConnections,
  passwords: ReadonlyMap<string, Redacted.Redacted>,
  mode: RuntimeRoleBootstrapMode,
): Effect.Effect<void, RuntimeRoleBootstrapError, Reactivity.Reactivity> =>
  Effect.gen(function* bootstrapRuntimeRolesEffect() {
    if (mode === 'initialize-local') {
      if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(connections.admin.host)) {
        return yield* bootstrapFailure('PostgreSQL role initialization requires a local database');
      }
    } else {
      yield* preflightProtectedLogins(client, connections);
    }
    const credentials = new Map<string, DatabaseLoginCredentials>();
    for (const entry of DATABASE_ROLE_GRANT_MANIFEST) {
      if (mode === 'reconcile' && entry.kind === 'explicit') {
        credentials.set(entry.identity.role, { kind: 'existing' });
      } else {
        const password = passwords.get(entry.identity.role);
        if (password === undefined) {
          return yield* bootstrapFailure(`Missing the ${entry.identity.urlKey} password for ${entry.identity.role}`);
        }
        credentials.set(entry.identity.role, { kind: 'password', password });
      }
    }
    yield* applyRuntimeRoleBootstrap(client, connections.admin.database, credentials);
    return yield* Effect.void;
  });
