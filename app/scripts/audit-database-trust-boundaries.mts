#!/usr/bin/env node
/* eslint-disable node/no-process-env -- The audit loads the canonical workspace environment. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import type { ClientBase } from 'pg';
import { Effect, Schema } from 'effect';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import type { DatabaseConfigValue } from '../packages/core-runtime/src/db/config.ts';

interface DatabasePrivileges {
  readonly connect: boolean;
  readonly create: boolean;
  readonly temporary: boolean;
}

interface DefaultPrivilege {
  readonly grantee: string;
  readonly grantable: boolean;
  readonly objectType: string;
  readonly owner: string;
  readonly privilege: string;
  readonly schema: string | null;
  readonly source: 'assumable' | 'direct' | 'inherited' | 'public';
}

interface RoleMembership {
  readonly attributes: RoleAttributes;
  readonly canSetRole: boolean;
  readonly createSchemas: readonly string[];
  readonly databaseCreate: boolean;
  readonly ownedRelations: readonly string[];
  readonly ownedRoutines: readonly string[];
  readonly ownedSchemas: readonly string[];
  readonly relationPrivilegeSchemas: readonly string[];
  readonly role: string;
  readonly securityDefinerRoutines: readonly string[];
}

interface RoleAttributes {
  readonly bypassRls: boolean;
  readonly canCreateDatabases: boolean;
  readonly canCreateRoles: boolean;
  readonly canLogin: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly superuser: boolean;
}

interface SchemaPrivilege {
  readonly create: boolean;
  readonly owner: string;
  readonly schema: string;
  readonly usage: boolean;
}

interface RoutinePrivilege {
  readonly executable: boolean;
  readonly identityArguments: string;
  readonly kind: 'aggregate' | 'function' | 'procedure' | 'window';
  readonly owner: string;
  readonly routine: string;
  readonly schema: string;
  readonly securityDefiner: boolean;
}

interface SequencePrivilege {
  readonly owner: string;
  readonly privileges: {
    readonly select: boolean;
    readonly update: boolean;
    readonly usage: boolean;
  };
  readonly schema: string;
  readonly sequence: string;
}

interface TablePrivilege {
  readonly kind: 'foreign-table' | 'materialized-view' | 'partitioned-table' | 'table' | 'view';
  readonly owner: string;
  readonly privileges: {
    readonly delete: boolean;
    readonly insert: boolean;
    readonly references: boolean;
    readonly select: boolean;
    readonly trigger: boolean;
    readonly truncate: boolean;
    readonly update: boolean;
  };
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly schema: string;
  readonly table: string;
}

interface TrustedContextEvidence {
  readonly legalEntitySettingRetainedAfterRollback: boolean;
  readonly legalEntitySettingSettable: boolean;
  readonly tenantSettingRetainedAfterRollback: boolean;
  readonly tenantSettingSettable: boolean;
  readonly transactionLocal: true;
}

export interface DatabaseTargetIdentity {
  readonly configuredHost: string;
  readonly configuredPort: number;
  readonly database: string;
  readonly serverAddress: string | null;
  readonly serverPort: number | null;
}

export interface DatabaseTrustBoundarySnapshot {
  readonly administrativeRole: string;
  readonly database: string;
  readonly databasePrivileges: DatabasePrivileges;
  readonly defaultPrivileges: readonly DefaultPrivilege[];
  readonly memberships: readonly RoleMembership[];
  readonly role: RoleAttributes;
  readonly routines: readonly RoutinePrivilege[];
  readonly runtimeRole: string;
  readonly schemas: readonly SchemaPrivilege[];
  readonly sequences: readonly SequencePrivilege[];
  readonly tables: readonly TablePrivilege[];
  readonly trustedContext: TrustedContextEvidence;
}

interface DatabaseTrustBoundaryFinding {
  readonly code:
    | 'runtime_role_can_assume_administrative_role'
    | 'runtime_role_can_assume_other_role'
    | 'runtime_role_can_assume_privileged_role'
    | 'runtime_role_can_forge_trusted_context'
    | 'runtime_role_can_execute_security_definer'
    | 'runtime_role_has_ddl_authority'
    | 'runtime_role_has_cross_owner_dml'
    | 'runtime_role_has_relation_control_authority'
    | 'runtime_role_has_sequence_mutation_authority'
    | 'runtime_role_is_privileged'
    | 'trusted_context_survives_transaction';
  readonly evidence: string;
  readonly severity: 'critical' | 'high';
}

export interface DatabaseTrustBoundaryReport extends DatabaseTrustBoundarySnapshot {
  readonly findings: readonly DatabaseTrustBoundaryFinding[];
  readonly schemaVersion: 1;
  readonly summary: {
    readonly auditedSchemaCount: number;
    readonly defaultPrivilegeCount: number;
    readonly dmlSchemaCount: number;
    readonly dmlTableCount: number;
    readonly findingCount: number;
    readonly routineCount: number;
    readonly securityDefinerExecutableCount: number;
    readonly sequenceCount: number;
    readonly tableCount: number;
  };
}

export class DatabaseTrustBoundaryAuditError extends Schema.TaggedError<DatabaseTrustBoundaryAuditError>()(
  'DatabaseTrustBoundaryAuditError',
  { reason: Schema.String },
) {}

class DatabaseTargetMismatchError extends Error {}

const hasDml = (table: TablePrivilege): boolean =>
  table.privileges.delete ||
  table.privileges.insert ||
  table.privileges.select ||
  table.privileges.update;

const hasClusterPrivilege = (role: RoleAttributes): boolean =>
  role.superuser ||
  role.bypassRls ||
  role.canCreateDatabases ||
  role.canCreateRoles ||
  role.replication;

export const assertSameDatabaseTarget = (
  administrative: DatabaseTargetIdentity,
  runtime: DatabaseTargetIdentity,
): void => {
  if (
    administrative.database !== runtime.database ||
    administrative.serverAddress !== runtime.serverAddress ||
    administrative.serverPort !== runtime.serverPort ||
    (administrative.serverAddress === null &&
      (administrative.configuredHost !== runtime.configuredHost ||
        administrative.configuredPort !== runtime.configuredPort))
  ) {
    throw new DatabaseTargetMismatchError(
      'DATABASE_ADMIN_URL and DATABASE_URL must target the same PostgreSQL server and database',
    );
  }
};

export const buildDatabaseTrustBoundaryReport = (
  snapshot: DatabaseTrustBoundarySnapshot,
): DatabaseTrustBoundaryReport => {
  const schemas = [...snapshot.schemas].toSorted((left, right) =>
    left.schema.localeCompare(right.schema),
  );
  const tables = [...snapshot.tables].toSorted(
    (left, right) =>
      left.schema.localeCompare(right.schema) || left.table.localeCompare(right.table),
  );
  const sequences = [...snapshot.sequences].toSorted(
    (left, right) =>
      left.schema.localeCompare(right.schema) || left.sequence.localeCompare(right.sequence),
  );
  const routines = [...snapshot.routines].toSorted(
    (left, right) =>
      left.schema.localeCompare(right.schema) ||
      left.routine.localeCompare(right.routine) ||
      left.identityArguments.localeCompare(right.identityArguments),
  );
  const defaultPrivileges = [...snapshot.defaultPrivileges].toSorted(
    (left, right) =>
      (left.schema ?? '').localeCompare(right.schema ?? '') ||
      left.objectType.localeCompare(right.objectType) ||
      left.grantee.localeCompare(right.grantee) ||
      left.privilege.localeCompare(right.privilege),
  );
  const memberships = [...snapshot.memberships].toSorted((left, right) =>
    left.role.localeCompare(right.role),
  );
  const findings: DatabaseTrustBoundaryFinding[] = [];
  const dmlTables = tables.filter(hasDml);

  if (hasClusterPrivilege(snapshot.role)) {
    findings.push({
      code: 'runtime_role_is_privileged',
      evidence: 'The runtime role has a PostgreSQL cluster-level privilege.',
      severity: 'critical',
    });
  }
  const administrativeMembership = memberships.some(
    ({ canSetRole, role }) => canSetRole && role === snapshot.administrativeRole,
  );
  if (administrativeMembership) {
    findings.push({
      code: 'runtime_role_can_assume_administrative_role',
      evidence: 'The runtime role can SET ROLE to the configured administrative identity.',
      severity: 'critical',
    });
  }
  const nonAdministrativeMemberships = memberships.filter(
    ({ canSetRole, role }) => canSetRole && role !== snapshot.administrativeRole,
  );
  const privilegedMemberships = nonAdministrativeMemberships.filter(
    ({
      attributes,
      createSchemas,
      databaseCreate,
      ownedRelations,
      ownedRoutines,
      ownedSchemas,
      relationPrivilegeSchemas,
      securityDefinerRoutines,
    }) =>
      hasClusterPrivilege(attributes) ||
      databaseCreate ||
      createSchemas.length > 0 ||
      ownedRelations.length > 0 ||
      ownedRoutines.length > 0 ||
      ownedSchemas.length > 0 ||
      relationPrivilegeSchemas.length > 0 ||
      securityDefinerRoutines.length > 0,
  );
  if (privilegedMemberships.length > 0) {
    findings.push({
      code: 'runtime_role_can_assume_privileged_role',
      evidence:
        'The runtime role can SET ROLE to a non-administrative identity with cluster, database, schema, or relation authority.',
      severity: 'critical',
    });
  }
  if (nonAdministrativeMemberships.length > privilegedMemberships.length) {
    findings.push({
      code: 'runtime_role_can_assume_other_role',
      evidence: 'The runtime role can SET ROLE to at least one additional identity.',
      severity: 'high',
    });
  }
  const ownsRelation =
    tables.some(({ owner }) => owner === snapshot.runtimeRole) ||
    sequences.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsRoutine = routines.some(({ owner }) => owner === snapshot.runtimeRole);
  if (
    snapshot.databasePrivileges.create ||
    schemas.some(({ create }) => create) ||
    ownsRelation ||
    ownsRoutine
  ) {
    findings.push({
      code: 'runtime_role_has_ddl_authority',
      evidence: 'The runtime role has database/schema CREATE or owns an audited relation/routine.',
      severity: 'high',
    });
  }
  const relationControlTables = tables.filter(
    ({ privileges }) => privileges.references || privileges.trigger || privileges.truncate,
  );
  if (relationControlTables.length > 0) {
    findings.push({
      code: 'runtime_role_has_relation_control_authority',
      evidence:
        'The runtime role has TRUNCATE, REFERENCES, or TRIGGER on an audited table-like relation.',
      severity: 'high',
    });
  }
  const executableSecurityDefiners = routines.filter(
    ({ executable, owner, securityDefiner }) =>
      executable && securityDefiner && owner !== snapshot.runtimeRole,
  );
  if (executableSecurityDefiners.length > 0) {
    findings.push({
      code: 'runtime_role_can_execute_security_definer',
      evidence:
        'The runtime role can execute a SECURITY DEFINER routine owned by another role in an audited schema.',
      severity: 'high',
    });
  }
  if (sequences.some(({ privileges }) => privileges.update)) {
    findings.push({
      code: 'runtime_role_has_sequence_mutation_authority',
      evidence: 'The runtime role has UPDATE on an audited sequence.',
      severity: 'high',
    });
  }
  if (
    snapshot.trustedContext.tenantSettingSettable ||
    snapshot.trustedContext.legalEntitySettingSettable
  ) {
    findings.push({
      code: 'runtime_role_can_forge_trusted_context',
      evidence:
        'The ordinary runtime role can set and read at least one custom GUC used by tenant RLS.',
      severity: 'high',
    });
  }
  if (
    snapshot.trustedContext.tenantSettingRetainedAfterRollback ||
    snapshot.trustedContext.legalEntitySettingRetainedAfterRollback
  ) {
    findings.push({
      code: 'trusted_context_survives_transaction',
      evidence: 'A probed transaction-local trusted context value remained visible after rollback.',
      severity: 'critical',
    });
  }
  if (new Set(dmlTables.map(({ schema }) => schema)).size > 1) {
    findings.push({
      code: 'runtime_role_has_cross_owner_dml',
      evidence: 'One runtime role has DML privileges in more than one application-owner schema.',
      severity: 'high',
    });
  }

  return {
    ...snapshot,
    defaultPrivileges,
    findings,
    memberships,
    routines,
    schemaVersion: 1,
    schemas,
    sequences,
    summary: {
      auditedSchemaCount: schemas.length,
      defaultPrivilegeCount: defaultPrivileges.length,
      dmlSchemaCount: new Set(dmlTables.map(({ schema }) => schema)).size,
      dmlTableCount: dmlTables.length,
      findingCount: findings.length,
      routineCount: routines.length,
      securityDefinerExecutableCount: executableSecurityDefiners.length,
      sequenceCount: sequences.length,
      tableCount: tables.length,
    },
    tables,
  };
};

interface RoleRow {
  readonly bypass_rls: boolean;
  readonly can_create_databases: boolean;
  readonly can_create_roles: boolean;
  readonly can_login: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly superuser: boolean;
}

interface MembershipRow {
  readonly bypass_rls: boolean;
  readonly can_set_role: boolean;
  readonly can_create_databases: boolean;
  readonly can_create_roles: boolean;
  readonly can_login: boolean;
  readonly create_schemas: string[];
  readonly database_create: boolean;
  readonly inherit: boolean;
  readonly owned_relations: string[];
  readonly owned_routines: string[];
  readonly owned_schemas: string[];
  readonly relation_privilege_schemas: string[];
  readonly replication: boolean;
  readonly role: string;
  readonly security_definer_routines: string[];
  readonly superuser: boolean;
}

interface DatabaseTargetRow {
  readonly database: string;
  readonly server_address: string | null;
  readonly server_port: number | null;
}

interface DatabasePrivilegeRow {
  readonly connect: boolean;
  readonly create: boolean;
  readonly database: string;
  readonly temporary: boolean;
}

interface SchemaPrivilegeRow {
  readonly create: boolean;
  readonly owner: string;
  readonly schema: string;
  readonly usage: boolean;
}

interface RoutinePrivilegeRow {
  readonly executable: boolean;
  readonly identity_arguments: string;
  readonly kind: 'aggregate' | 'function' | 'procedure' | 'window';
  readonly owner: string;
  readonly routine: string;
  readonly schema: string;
  readonly security_definer: boolean;
}

interface TablePrivilegeRow {
  readonly delete: boolean;
  readonly insert: boolean;
  readonly kind: 'foreign-table' | 'materialized-view' | 'partitioned-table' | 'table' | 'view';
  readonly owner: string;
  readonly references: boolean;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly schema: string;
  readonly select: boolean;
  readonly table: string;
  readonly trigger: boolean;
  readonly truncate: boolean;
  readonly update: boolean;
}

interface SequencePrivilegeRow {
  readonly owner: string;
  readonly schema: string;
  readonly select: boolean;
  readonly sequence: string;
  readonly update: boolean;
  readonly usage: boolean;
}

interface DefaultPrivilegeRow {
  readonly grantee: string;
  readonly grantable: boolean;
  readonly object_type: string;
  readonly owner: string;
  readonly privilege: string;
  readonly schema: string | null;
  readonly source: 'assumable' | 'direct' | 'inherited' | 'public';
}

interface SettingRow {
  readonly value: string | null;
}

const probeSetting = async (
  client: ClientBase,
  setting: 'ontos.legal_entity_id' | 'ontos.tenant_id',
  value: string,
): Promise<{ readonly retainedAfterRollback: boolean; readonly settable: boolean }> => {
  await client.query('begin');
  let settable = false;
  try {
    await client.query('select set_config($1, $2, true)', [setting, value]);
    const current = await client.query<SettingRow>('select current_setting($1, true) as value', [
      setting,
    ]);
    settable = current.rows[0]?.value === value;
  } catch {
    settable = false;
  } finally {
    await client.query('rollback');
  }
  const after = await client.query<SettingRow>('select current_setting($1, true) as value', [
    setting,
  ]);
  return { retainedAfterRollback: after.rows[0]?.value === value, settable };
};

const collectSnapshot = async (
  admin: Client,
  runtime: Client,
  administrativeConfig: DatabaseConfigValue,
  runtimeConfig: DatabaseConfigValue,
): Promise<DatabaseTrustBoundarySnapshot> => {
  const administrativeRole = administrativeConfig.user;
  const runtimeRole = runtimeConfig.user;
  const targetQuery = `select
    current_database() as database,
    inet_server_addr()::text as server_address,
    inet_server_port() as server_port`;
  const [administrativeTarget, runtimeTarget] = await Promise.all([
    admin.query<DatabaseTargetRow>(targetQuery),
    runtime.query<DatabaseTargetRow>(targetQuery),
  ]);
  const administrativeTargetRow = administrativeTarget.rows[0];
  const runtimeTargetRow = runtimeTarget.rows[0];
  if (administrativeTargetRow === undefined || runtimeTargetRow === undefined) {
    throw new Error('database target identity is unavailable');
  }
  assertSameDatabaseTarget(
    {
      configuredHost: administrativeConfig.host,
      configuredPort: administrativeConfig.port,
      database: administrativeTargetRow.database,
      serverAddress: administrativeTargetRow.server_address,
      serverPort: administrativeTargetRow.server_port,
    },
    {
      configuredHost: runtimeConfig.host,
      configuredPort: runtimeConfig.port,
      database: runtimeTargetRow.database,
      serverAddress: runtimeTargetRow.server_address,
      serverPort: runtimeTargetRow.server_port,
    },
  );

  const role = await admin.query<RoleRow>(
    `select
       rolbypassrls as bypass_rls,
       rolcreatedb as can_create_databases,
       rolcreaterole as can_create_roles,
       rolcanlogin as can_login,
       rolinherit as inherit,
       rolreplication as replication,
       rolsuper as superuser
     from pg_catalog.pg_roles
     where rolname = $1`,
    [runtimeRole],
  );
  const roleRow = role.rows[0];
  if (roleRow === undefined) throw new Error('runtime role is absent');

  const memberships = await admin.query<MembershipRow>(
    `select
       candidate.rolname as role,
       pg_has_role($1, candidate.oid, 'SET') as can_set_role,
       candidate.rolbypassrls as bypass_rls,
       candidate.rolcreatedb as can_create_databases,
       candidate.rolcreaterole as can_create_roles,
       candidate.rolcanlogin as can_login,
       has_database_privilege(candidate.oid, current_database(), 'CREATE') as database_create,
       candidate.rolinherit as inherit,
       candidate.rolreplication as replication,
       candidate.rolsuper as superuser,
       array(
         select namespace.nspname
         from pg_catalog.pg_namespace as namespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and namespace.nspowner = candidate.oid
         order by namespace.nspname
       ) as owned_schemas,
       array(
         select namespace.nspname
         from pg_catalog.pg_namespace as namespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and has_schema_privilege(candidate.oid, namespace.oid, 'CREATE')
         order by namespace.nspname
       ) as create_schemas,
       array(
         select format('%I.%I', namespace.nspname, relation.relname)
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
           and relation.relowner = candidate.oid
         order by namespace.nspname, relation.relname
       ) as owned_relations,
       array(
         select format(
           '%I.%I(%s)',
           namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from pg_catalog.pg_proc as routine
         join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and routine.proowner = candidate.oid
         order by namespace.nspname, routine.proname, routine.oid
       ) as owned_routines,
       array(
         select distinct namespace.nspname
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
           and case
             when relation.relkind = 'S' then
               has_sequence_privilege(candidate.oid, relation.oid, 'USAGE')
               or has_sequence_privilege(candidate.oid, relation.oid, 'SELECT')
               or has_sequence_privilege(candidate.oid, relation.oid, 'UPDATE')
             else
               has_table_privilege(candidate.oid, relation.oid, 'SELECT')
               or has_any_column_privilege(candidate.oid, relation.oid, 'SELECT')
               or has_table_privilege(candidate.oid, relation.oid, 'INSERT')
               or has_any_column_privilege(candidate.oid, relation.oid, 'INSERT')
               or has_table_privilege(candidate.oid, relation.oid, 'UPDATE')
               or has_any_column_privilege(candidate.oid, relation.oid, 'UPDATE')
               or has_table_privilege(candidate.oid, relation.oid, 'DELETE')
               or has_table_privilege(candidate.oid, relation.oid, 'TRUNCATE')
               or has_table_privilege(candidate.oid, relation.oid, 'REFERENCES')
               or has_any_column_privilege(candidate.oid, relation.oid, 'REFERENCES')
               or has_table_privilege(candidate.oid, relation.oid, 'TRIGGER')
           end
         order by namespace.nspname
       ) as relation_privilege_schemas,
       array(
         select format(
           '%I.%I(%s)',
           namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from pg_catalog.pg_proc as routine
         join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and routine.prosecdef
           and routine.proowner <> candidate.oid
           and has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
         order by namespace.nspname, routine.proname, routine.oid
       ) as security_definer_routines
     from pg_catalog.pg_roles as candidate
     where candidate.rolname <> $1 and pg_has_role($1, candidate.oid, 'MEMBER')
     order by candidate.rolname`,
    [runtimeRole],
  );
  const database = await admin.query<DatabasePrivilegeRow>(
    `select
       current_database() as database,
       has_database_privilege($1, current_database(), 'CONNECT') as connect,
       has_database_privilege($1, current_database(), 'CREATE') as create,
       has_database_privilege($1, current_database(), 'TEMPORARY') as temporary`,
    [runtimeRole],
  );
  const databaseRow = database.rows[0];
  if (databaseRow === undefined) throw new Error('database privilege row is absent');

  const schemas = await admin.query<SchemaPrivilegeRow>(
    `select
       namespace.nspname as schema,
       owner.rolname as owner,
       has_schema_privilege($1, namespace.oid, 'USAGE') as usage,
       has_schema_privilege($1, namespace.oid, 'CREATE') as create
     from pg_catalog.pg_namespace as namespace
     join pg_catalog.pg_roles as owner on owner.oid = namespace.nspowner
     where namespace.nspname !~ '^pg_'
       and namespace.nspname <> 'information_schema'
     order by namespace.nspname`,
    [runtimeRole],
  );
  const schemaNames = schemas.rows.map(({ schema }) => schema);
  const routines = await admin.query<RoutinePrivilegeRow>(
    `select
       namespace.nspname as schema,
       routine.proname as routine,
       pg_get_function_identity_arguments(routine.oid) as identity_arguments,
       case routine.prokind
         when 'a' then 'aggregate'
         when 'f' then 'function'
         when 'p' then 'procedure'
         when 'w' then 'window'
       end as kind,
       owner.rolname as owner,
       routine.prosecdef as security_definer,
       has_function_privilege($1, routine.oid, 'EXECUTE') as executable
     from pg_catalog.pg_proc as routine
     join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
     join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
     where namespace.nspname = any($2::text[])
     order by namespace.nspname, routine.proname, routine.oid`,
    [runtimeRole, schemaNames],
  );
  const tables = await admin.query<TablePrivilegeRow>(
    `select
       namespace.nspname as schema,
       relation.relname as table,
       case relation.relkind
         when 'r' then 'table'
         when 'p' then 'partitioned-table'
         when 'v' then 'view'
         when 'm' then 'materialized-view'
         when 'f' then 'foreign-table'
       end as kind,
       owner.rolname as owner,
       relation.relrowsecurity as rls_enabled,
       relation.relforcerowsecurity as rls_forced,
       (
         has_table_privilege($1, relation.oid, 'SELECT')
         or has_any_column_privilege($1, relation.oid, 'SELECT')
       ) as select,
       (
         has_table_privilege($1, relation.oid, 'INSERT')
         or has_any_column_privilege($1, relation.oid, 'INSERT')
       ) as insert,
       (
         has_table_privilege($1, relation.oid, 'UPDATE')
         or has_any_column_privilege($1, relation.oid, 'UPDATE')
       ) as update,
       has_table_privilege($1, relation.oid, 'DELETE') as delete,
       has_table_privilege($1, relation.oid, 'TRUNCATE') as truncate,
       (
         has_table_privilege($1, relation.oid, 'REFERENCES')
         or has_any_column_privilege($1, relation.oid, 'REFERENCES')
       ) as references,
       has_table_privilege($1, relation.oid, 'TRIGGER') as trigger
     from pg_catalog.pg_class as relation
     join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
     join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
     where relation.relkind in ('r', 'p', 'v', 'm', 'f')
       and namespace.nspname = any($2::text[])
     order by namespace.nspname, relation.relname`,
    [runtimeRole, schemaNames],
  );
  const sequences = await admin.query<SequencePrivilegeRow>(
    `select
       namespace.nspname as schema,
       relation.relname as sequence,
       owner.rolname as owner,
       has_sequence_privilege($1, relation.oid, 'USAGE') as usage,
       has_sequence_privilege($1, relation.oid, 'SELECT') as select,
       has_sequence_privilege($1, relation.oid, 'UPDATE') as update
     from pg_catalog.pg_class as relation
     join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
     join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
     where relation.relkind = 'S' and namespace.nspname = any($2::text[])
     order by namespace.nspname, relation.relname`,
    [runtimeRole, schemaNames],
  );
  const defaultPrivileges = await admin.query<DefaultPrivilegeRow>(
    `with audit_owners as (
       select candidate.oid, candidate.rolname
       from pg_catalog.pg_roles as candidate
       where candidate.rolname = $3
          or exists (
            select 1
            from pg_catalog.pg_namespace as namespace
            where namespace.nspname = any($2::text[])
              and (
                namespace.nspowner = candidate.oid
                or has_schema_privilege(candidate.oid, namespace.oid, 'CREATE')
              )
          )
          or exists (
            select 1
            from pg_catalog.pg_default_acl as defaults
            left join pg_catalog.pg_namespace as namespace
              on namespace.oid = defaults.defaclnamespace
            where defaults.defaclrole = candidate.oid
              and (
                defaults.defaclnamespace = 0
                or namespace.nspname = any($2::text[])
              )
          )
     ),
     object_types(code, object_type) as (
       values
         ('r'::"char", 'table'::text),
         ('S'::"char", 'sequence'::text),
         ('f'::"char", 'function'::text),
         ('T'::"char", 'type'::text),
         ('n'::"char", 'schema'::text)
     ),
     global_acl as (
       select
         null::text as schema,
         owner.rolname as owner,
         object_types.object_type,
         coalesce(defaults.defaclacl, acldefault(object_types.code, owner.oid)) as acl
       from audit_owners as owner
       cross join object_types
       left join pg_catalog.pg_default_acl as defaults
         on defaults.defaclrole = owner.oid
        and defaults.defaclnamespace = 0
        and defaults.defaclobjtype = object_types.code
     ),
     schema_acl as (
       select
         namespace.nspname as schema,
         owner.rolname as owner,
         case defaults.defaclobjtype
           when 'r' then 'table'
           when 'S' then 'sequence'
           when 'f' then 'function'
           when 'T' then 'type'
           when 'n' then 'schema'
           else defaults.defaclobjtype::text
         end as object_type,
         defaults.defaclacl as acl
       from pg_catalog.pg_default_acl as defaults
       join pg_catalog.pg_namespace as namespace on namespace.oid = defaults.defaclnamespace
       join pg_catalog.pg_roles as owner on owner.oid = defaults.defaclrole
       where namespace.nspname = any($2::text[])
     ),
     expanded as (
       select
         scopes.schema,
         scopes.owner,
         scopes.object_type,
         acl.grantee,
         acl.privilege_type,
         acl.is_grantable
       from (
         select * from global_acl
         union all
         select * from schema_acl
       ) as scopes
       cross join lateral aclexplode(scopes.acl) as acl
     )
     select
       expanded.schema,
       expanded.owner,
       expanded.object_type,
       coalesce(grantee.rolname, 'PUBLIC') as grantee,
       case
         when expanded.grantee = 0 then 'public'
         when grantee.rolname = $1 then 'direct'
         when pg_has_role($1, grantee.oid, 'USAGE') then 'inherited'
         else 'assumable'
       end as source,
       expanded.privilege_type as privilege,
       expanded.is_grantable as grantable
     from expanded
     left join pg_catalog.pg_roles as grantee on grantee.oid = expanded.grantee
     where expanded.grantee = 0
         or grantee.rolname = $1
         or pg_has_role($1, grantee.oid, 'USAGE')
         or pg_has_role($1, grantee.oid, 'SET')
     order by expanded.schema nulls first, object_type, grantee, privilege`,
    [runtimeRole, schemaNames, administrativeRole],
  );
  const tenant = await probeSetting(
    runtime,
    'ontos.tenant_id',
    '00000000-0000-4000-8000-000000000001',
  );
  const legalEntity = await probeSetting(
    runtime,
    'ontos.legal_entity_id',
    '00000000-0000-4000-8000-000000000002',
  );

  return {
    administrativeRole,
    database: databaseRow.database,
    databasePrivileges: {
      connect: databaseRow.connect,
      create: databaseRow.create,
      temporary: databaseRow.temporary,
    },
    defaultPrivileges: defaultPrivileges.rows.map((privilege) => ({
      grantee: privilege.grantee,
      grantable: privilege.grantable,
      objectType: privilege.object_type,
      owner: privilege.owner,
      privilege: privilege.privilege,
      schema: privilege.schema,
      source: privilege.source,
    })),
    memberships: memberships.rows.map((membership) => ({
      attributes: {
        bypassRls: membership.bypass_rls,
        canCreateDatabases: membership.can_create_databases,
        canCreateRoles: membership.can_create_roles,
        canLogin: membership.can_login,
        inherit: membership.inherit,
        replication: membership.replication,
        superuser: membership.superuser,
      },
      canSetRole: membership.can_set_role,
      createSchemas: membership.create_schemas,
      databaseCreate: membership.database_create,
      ownedRelations: membership.owned_relations,
      ownedRoutines: membership.owned_routines,
      ownedSchemas: membership.owned_schemas,
      relationPrivilegeSchemas: membership.relation_privilege_schemas,
      role: membership.role,
      securityDefinerRoutines: membership.security_definer_routines,
    })),
    role: {
      bypassRls: roleRow.bypass_rls,
      canCreateDatabases: roleRow.can_create_databases,
      canCreateRoles: roleRow.can_create_roles,
      canLogin: roleRow.can_login,
      inherit: roleRow.inherit,
      replication: roleRow.replication,
      superuser: roleRow.superuser,
    },
    routines: routines.rows.map((routine) => ({
      executable: routine.executable,
      identityArguments: routine.identity_arguments,
      kind: routine.kind,
      owner: routine.owner,
      routine: routine.routine,
      schema: routine.schema,
      securityDefiner: routine.security_definer,
    })),
    runtimeRole,
    schemas: schemas.rows,
    sequences: sequences.rows.map((sequence) => ({
      owner: sequence.owner,
      privileges: {
        select: sequence.select,
        update: sequence.update,
        usage: sequence.usage,
      },
      schema: sequence.schema,
      sequence: sequence.sequence,
    })),
    tables: tables.rows.map((table) => ({
      kind: table.kind,
      owner: table.owner,
      privileges: {
        delete: table.delete,
        insert: table.insert,
        references: table.references,
        select: table.select,
        trigger: table.trigger,
        truncate: table.truncate,
        update: table.update,
      },
      rlsEnabled: table.rls_enabled,
      rlsForced: table.rls_forced,
      schema: table.schema,
      table: table.table,
    })),
    trustedContext: {
      legalEntitySettingRetainedAfterRollback: legalEntity.retainedAfterRollback,
      legalEntitySettingSettable: legalEntity.settable,
      tenantSettingRetainedAfterRollback: tenant.retainedAfterRollback,
      tenantSettingSettable: tenant.settable,
      transactionLocal: true,
    },
  };
};

export const auditDatabaseTrustBoundaries = (): Effect.Effect<
  DatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError
> =>
  Effect.gen(function* auditDatabaseTrustBoundariesEffect() {
    const connections = yield* loadDatabaseConnectionPair().pipe(
      Effect.mapError(
        () =>
          new DatabaseTrustBoundaryAuditError({
            reason: 'Administrative and runtime database configuration is unavailable',
          }),
      ),
    );
    const admin = new Client({ connectionString: connections.admin.connectionString });
    const runtime = new Client({ connectionString: connections.runtime.connectionString });
    return yield* Effect.tryPromise({
      catch: (error) =>
        new DatabaseTrustBoundaryAuditError({
          reason:
            error instanceof DatabaseTargetMismatchError
              ? error.message
              : 'Database trust-boundary evidence could not be collected',
        }),
      try: async () => {
        let adminConnected = false;
        let runtimeConnected = false;
        try {
          await admin.connect();
          adminConnected = true;
          await runtime.connect();
          runtimeConnected = true;
          return buildDatabaseTrustBoundaryReport(
            await collectSnapshot(admin, runtime, connections.admin, connections.runtime),
          );
        } finally {
          await Promise.allSettled([
            ...(runtimeConnected ? [runtime.end()] : []),
            ...(adminConnected ? [admin.end()] : []),
          ]);
        }
      },
    });
  });

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const workspaceRoot =
    process.env['ULTRAMODERN_WORKSPACE_ROOT'] ?? path.resolve(import.meta.dirname, '..');
  const output = path.join(workspaceRoot, '.codex/reports/database/database-trust-boundary.json');
  try {
    const report = await Effect.runPromise(auditDatabaseTrustBoundaries());
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    console.log(
      `Database trust-boundary evidence written with ${report.findings.length} finding(s).`,
    );
  } catch (error) {
    console.error(
      error instanceof DatabaseTrustBoundaryAuditError
        ? error.reason
        : 'Database trust-boundary audit failed',
    );
    process.exitCode = 1;
  }
}
