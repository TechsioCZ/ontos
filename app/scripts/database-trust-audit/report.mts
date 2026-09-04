import type { Client, ClientBase } from 'pg';
import { Cause, Option, Schema } from 'effect';

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
  readonly canAdministerRole: boolean;
  readonly canInheritRole: boolean;
  readonly canSetRole: boolean;
  readonly createSchemas: readonly string[];
  readonly databaseCreate: boolean;
  readonly ownedRelations: readonly string[];
  readonly ownedRoutines: readonly string[];
  readonly ownedSchemas: readonly string[];
  readonly ownedTypes: readonly string[];
  readonly parameterPrivileges?: readonly string[];
  readonly predefinedRole?: boolean;
  readonly relationPrivilegeSchemas: readonly string[];
  readonly role: string;
  readonly securityDefinerRoutines: readonly string[];
}

interface ParameterPrivilege {
  readonly alterSystem: boolean;
  readonly parameter: string;
  readonly set: boolean;
}

interface RoleAttributes {
  readonly bypassRls: boolean;
  readonly canCreateDatabases: boolean;
  readonly canCreateRoles: boolean;
  readonly canLogin: boolean;
  readonly inherit: boolean;
  readonly predefinedRole?: boolean;
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
  readonly deletable?: boolean;
  readonly insertable?: boolean;
  readonly kind: 'foreign-table' | 'materialized-view' | 'partitioned-table' | 'table' | 'view';
  readonly owner: string;
  readonly ownerBypassRls?: boolean;
  readonly ownerContextPrivileged?: boolean;
  readonly ownerContextRlsBypass?: boolean;
  readonly ownerSuperuser?: boolean;
  readonly privileges: {
    readonly delete: boolean;
    readonly insert: boolean;
    readonly maintain: boolean;
    readonly references: boolean;
    readonly select: boolean;
    readonly trigger: boolean;
    readonly truncate: boolean;
    readonly update: boolean;
  };
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly schema: string;
  readonly securityInvoker?: boolean;
  readonly table: string;
  readonly updatable?: boolean;
}

interface TypePrivilege {
  readonly kind: 'base' | 'composite' | 'domain' | 'enum' | 'multirange' | 'range';
  readonly owner: string;
  readonly schema: string;
  readonly type: string;
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

export interface DatabaseSessionIdentity {
  readonly currentRole: string;
  readonly sessionRole: string;
}

export interface DatabaseTrustBoundarySnapshot {
  readonly administrativeRole: string;
  readonly database: string;
  readonly databasePrivileges: DatabasePrivileges;
  readonly defaultPrivileges: readonly DefaultPrivilege[];
  readonly grantOptions: readonly string[];
  readonly memberships: readonly RoleMembership[];
  readonly parameterPrivileges: readonly ParameterPrivilege[];
  readonly role: RoleAttributes;
  readonly routines: readonly RoutinePrivilege[];
  readonly runtimeRole: string;
  readonly schemas: readonly SchemaPrivilege[];
  readonly sequences: readonly SequencePrivilege[];
  readonly tables: readonly TablePrivilege[];
  readonly trustedContext: TrustedContextEvidence;
  readonly types: readonly TypePrivilege[];
}

interface DatabaseTrustBoundaryFinding {
  readonly code:
    | 'runtime_role_can_assume_administrative_role'
    | 'runtime_role_can_assume_other_role'
    | 'runtime_role_can_assume_privileged_role'
    | 'runtime_role_can_forge_trusted_context'
    | 'runtime_role_can_execute_security_definer'
    | 'runtime_role_can_use_privileged_owner_view'
    | 'runtime_role_has_ddl_authority'
    | 'runtime_role_has_grant_authority'
    | 'runtime_role_has_cross_schema_dml'
    | 'runtime_role_has_parameter_authority'
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
    readonly grantOptionCount: number;
    readonly parameterPrivilegeCount: number;
    readonly privilegedOwnerViewCount: number;
    readonly routineCount: number;
    readonly securityDefinerExecutableCount: number;
    readonly sequenceCount: number;
    readonly tableCount: number;
    readonly typeCount: number;
  };
}

export class DatabaseTrustBoundaryAuditError extends Schema.TaggedError<DatabaseTrustBoundaryAuditError>()(
  'DatabaseTrustBoundaryAuditError',
  { reason: Schema.String },
) {}

export const genericAuditFailureMessage = 'Database trust-boundary audit failed';

export const getDatabaseTrustBoundaryFailureMessage = (
  cause: Cause.Cause<DatabaseTrustBoundaryAuditError>,
): string => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && failure.value instanceof DatabaseTrustBoundaryAuditError
    ? failure.value.reason
    : genericAuditFailureMessage;
};

export class DatabaseTargetMismatchError extends Error {}

export class DatabaseSessionIdentityError extends Error {}

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

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

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

export const getEffectiveDatabaseEndpoint = (
  client: Client,
): Pick<DatabaseTargetIdentity, 'configuredHost' | 'configuredPort'> => ({
  configuredHost: client.host,
  configuredPort: client.port,
});

export const assertDatabaseSessionIdentities = (
  administrative: DatabaseSessionIdentity,
  runtime: DatabaseSessionIdentity,
): void => {
  if (
    administrative.currentRole !== administrative.sessionRole ||
    runtime.currentRole !== runtime.sessionRole
  ) {
    throw new DatabaseSessionIdentityError(
      'current_user must equal session_user for both database audit connections',
    );
  }
  if (administrative.sessionRole === runtime.sessionRole) {
    throw new DatabaseSessionIdentityError(
      'DATABASE_ADMIN_URL and DATABASE_URL must authenticate as distinct authenticated PostgreSQL roles',
    );
  }
};

export const buildDatabaseTrustBoundaryReport = (
  snapshot: DatabaseTrustBoundarySnapshot,
): DatabaseTrustBoundaryReport => {
  const schemas = [...snapshot.schemas].toSorted((left, right) =>
    compareText(left.schema, right.schema),
  );
  const tables = [...snapshot.tables].toSorted(
    (left, right) => compareText(left.schema, right.schema) || compareText(left.table, right.table),
  );
  const sequences = [...snapshot.sequences].toSorted(
    (left, right) =>
      compareText(left.schema, right.schema) || compareText(left.sequence, right.sequence),
  );
  const routines = [...snapshot.routines].toSorted(
    (left, right) =>
      compareText(left.schema, right.schema) ||
      compareText(left.routine, right.routine) ||
      compareText(left.identityArguments, right.identityArguments),
  );
  const types = [...snapshot.types].toSorted(
    (left, right) => compareText(left.schema, right.schema) || compareText(left.type, right.type),
  );
  const defaultPrivileges = [...snapshot.defaultPrivileges].toSorted(
    (left, right) =>
      compareText(left.schema ?? '', right.schema ?? '') ||
      compareText(left.owner, right.owner) ||
      compareText(left.objectType, right.objectType) ||
      compareText(left.grantee, right.grantee) ||
      compareText(left.privilege, right.privilege) ||
      compareText(left.source, right.source) ||
      Number(left.grantable) - Number(right.grantable),
  );
  const memberships = [...snapshot.memberships].toSorted((left, right) =>
    compareText(left.role, right.role),
  );
  const grantOptions = [...snapshot.grantOptions].toSorted(compareText);
  const grantableDefaultPrivileges = defaultPrivileges.filter(({ grantable }) => grantable);
  const parameterPrivileges = [...snapshot.parameterPrivileges].toSorted((left, right) =>
    compareText(left.parameter, right.parameter),
  );
  const findings: DatabaseTrustBoundaryFinding[] = [];
  const dmlTables = tables.filter(hasDml);

  if (hasClusterPrivilege(snapshot.role) || snapshot.role.predefinedRole === true) {
    findings.push({
      code: 'runtime_role_is_privileged',
      evidence:
        'The runtime role has a PostgreSQL cluster-level privilege or is a predefined PostgreSQL role.',
      severity: 'critical',
    });
  }
  const administrativeMembership = memberships.some(
    ({ canAdministerRole, canInheritRole, canSetRole, role }) =>
      (canSetRole || canAdministerRole || canInheritRole) && role === snapshot.administrativeRole,
  );
  if (administrativeMembership) {
    findings.push({
      code: 'runtime_role_can_assume_administrative_role',
      evidence:
        'The runtime role can inherit, SET ROLE to, or has ADMIN OPTION on the authenticated administrative identity.',
      severity: 'critical',
    });
  }
  const nonAdministrativeMemberships = memberships.filter(
    ({ canAdministerRole, canInheritRole, canSetRole, role }) =>
      (canSetRole || canAdministerRole || canInheritRole) && role !== snapshot.administrativeRole,
  );
  const privilegedMemberships = nonAdministrativeMemberships.filter(
    ({
      attributes,
      canAdministerRole,
      canSetRole,
      createSchemas,
      databaseCreate,
      ownedRelations,
      ownedRoutines,
      ownedSchemas,
      ownedTypes,
      parameterPrivileges = [],
      predefinedRole,
      relationPrivilegeSchemas,
      securityDefinerRoutines,
    }) =>
      ((canSetRole || canAdministerRole) && hasClusterPrivilege(attributes)) ||
      predefinedRole === true ||
      databaseCreate ||
      createSchemas.length > 0 ||
      ownedRelations.length > 0 ||
      ownedRoutines.length > 0 ||
      ownedSchemas.length > 0 ||
      ownedTypes.length > 0 ||
      parameterPrivileges.length > 0 ||
      relationPrivilegeSchemas.length > 0 ||
      securityDefinerRoutines.length > 0,
  );
  if (privilegedMemberships.length > 0) {
    findings.push({
      code: 'runtime_role_can_assume_privileged_role',
      evidence:
        'The runtime role can reach a non-administrative identity with predefined-role, cluster, database, schema, relation, routine, type, or parameter authority through inheritance, SET ROLE, or ADMIN OPTION.',
      severity: 'critical',
    });
  }
  if (nonAdministrativeMemberships.length > privilegedMemberships.length) {
    findings.push({
      code: 'runtime_role_can_assume_other_role',
      evidence:
        'The runtime role can inherit, SET ROLE to, or administer at least one additional identity.',
      severity: 'high',
    });
  }
  const ownsRelation =
    tables.some(({ owner }) => owner === snapshot.runtimeRole) ||
    sequences.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsRoutine = routines.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsType = types.some(({ owner }) => owner === snapshot.runtimeRole);
  const inheritsOwnership = memberships.some(
    ({ canInheritRole, ownedRelations, ownedRoutines, ownedSchemas, ownedTypes }) =>
      canInheritRole &&
      (ownedRelations.length > 0 ||
        ownedRoutines.length > 0 ||
        ownedSchemas.length > 0 ||
        ownedTypes.length > 0),
  );
  if (
    snapshot.databasePrivileges.create ||
    schemas.some(({ create }) => create) ||
    ownsRelation ||
    ownsRoutine ||
    ownsType ||
    inheritsOwnership
  ) {
    findings.push({
      code: 'runtime_role_has_ddl_authority',
      evidence:
        'The runtime role has database/schema CREATE or direct/inherited ownership of an audited schema, relation, routine, or application type.',
      severity: 'high',
    });
  }
  const relationControlTables = tables.filter(
    ({ privileges }) =>
      privileges.maintain || privileges.references || privileges.trigger || privileges.truncate,
  );
  if (relationControlTables.length > 0) {
    findings.push({
      code: 'runtime_role_has_relation_control_authority',
      evidence:
        'The runtime role has MAINTAIN, TRUNCATE, REFERENCES, or TRIGGER on an audited table-like relation.',
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
  const privilegedOwnerViews = tables.filter(
    ({
      deletable,
      insertable,
      kind,
      owner,
      ownerBypassRls,
      ownerContextPrivileged,
      ownerContextRlsBypass,
      ownerSuperuser,
      privileges,
      securityInvoker,
      updatable,
    }) =>
      kind === 'view' &&
      (privileges.select ||
        (privileges.insert && insertable !== false) ||
        (privileges.update && updatable !== false) ||
        (privileges.delete && deletable !== false)) &&
      ((securityInvoker !== true &&
        (owner === snapshot.administrativeRole ||
          ownerBypassRls === true ||
          ownerSuperuser === true)) ||
        ownerContextPrivileged === true ||
        ownerContextRlsBypass === true),
  );
  if (privilegedOwnerViews.length > 0) {
    findings.push({
      code: 'runtime_role_can_use_privileged_owner_view',
      evidence:
        'The runtime role can read or write through an owner-context view with an administrative, BYPASSRLS, superuser, or RLS-bypassing owner in its dependency chain.',
      severity: 'high',
    });
  }
  if (parameterPrivileges.length > 0) {
    findings.push({
      code: 'runtime_role_has_parameter_authority',
      evidence:
        'The runtime role has an explicit effective SET or ALTER SYSTEM privilege on a PostgreSQL configuration parameter.',
      severity: 'critical',
    });
  }
  if (grantOptions.length > 0 || grantableDefaultPrivileges.length > 0) {
    findings.push({
      code: 'runtime_role_has_grant_authority',
      evidence:
        'The runtime role has a grant option on at least one existing or creator-default database object privilege.',
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
  const dmlSchemas = new Set(dmlTables.map(({ schema }) => schema));
  if (dmlSchemas.size > 1) {
    findings.push({
      code: 'runtime_role_has_cross_schema_dml',
      evidence: 'One runtime role has DML privileges in more than one audited application schema.',
      severity: 'high',
    });
  }

  return {
    ...snapshot,
    defaultPrivileges,
    findings,
    grantOptions,
    memberships,
    parameterPrivileges,
    routines,
    schemaVersion: 1,
    schemas,
    sequences,
    summary: {
      auditedSchemaCount: schemas.length,
      defaultPrivilegeCount: defaultPrivileges.length,
      dmlSchemaCount: dmlSchemas.size,
      dmlTableCount: dmlTables.length,
      findingCount: findings.length,
      grantOptionCount: grantOptions.length + grantableDefaultPrivileges.length,
      parameterPrivilegeCount: parameterPrivileges.length,
      privilegedOwnerViewCount: privilegedOwnerViews.length,
      routineCount: routines.length,
      securityDefinerExecutableCount: executableSecurityDefiners.length,
      sequenceCount: sequences.length,
      tableCount: tables.length,
      typeCount: types.length,
    },
    tables,
    types,
  };
};
