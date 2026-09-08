// oxlint-disable-next-line max-classes-per-file -- This report owns the three related tagged audit failures.
import type { Client } from 'pg';
import { Cause, Option, Schema } from 'effect';

interface DatabasePrivileges {
  readonly connect: boolean;
  readonly create: boolean;
  readonly temporary: boolean;
}

interface DefaultPrivilege {
  readonly grantable: boolean;
  readonly grantee: string;
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

export class DatabaseTargetMismatchError extends Schema.TaggedError<DatabaseTargetMismatchError>()(
  'DatabaseTargetMismatchError',
  { message: Schema.String },
) {}

export class DatabaseSessionIdentityError extends Schema.TaggedError<DatabaseSessionIdentityError>()(
  'DatabaseSessionIdentityError',
  { message: Schema.String },
) {}

export const genericAuditFailureMessage = 'Database trust-boundary audit failed';

export const getDatabaseTrustBoundaryFailureMessage = (
  cause: Cause.Cause<DatabaseTrustBoundaryAuditError>,
): string => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && Schema.is(DatabaseTrustBoundaryAuditError)(failure.value)
    ? failure.value.reason
    : genericAuditFailureMessage;
};

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

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const sorted = <Value,>(
  values: Iterable<Value>,
  compare: (left: Value, right: Value) => number,
): Value[] => {
  const result: Value[] = [];
  for (const value of values) {
    const insertionIndex = result.findIndex((candidate) => compare(value, candidate) < 0);
    if (insertionIndex === -1) {
      result.push(value);
    } else {
      result.splice(insertionIndex, 0, value);
    }
  }
  return result;
};

const addFinding = (
  findings: DatabaseTrustBoundaryFinding[],
  included: boolean,
  finding: DatabaseTrustBoundaryFinding,
): void => {
  if (included) {
    findings.push(finding);
  }
};

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
    Option.getOrThrowWith(
      Option.none(),
      () =>
        new DatabaseTargetMismatchError({
          message:
            'DATABASE_ADMIN_URL and DATABASE_URL must target the same PostgreSQL server and database',
        }),
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
    Option.getOrThrowWith(
      Option.none(),
      () =>
        new DatabaseSessionIdentityError({
          message: 'current_user must equal session_user for both database audit connections',
        }),
    );
  }
  if (administrative.sessionRole === runtime.sessionRole) {
    Option.getOrThrowWith(
      Option.none(),
      () =>
        new DatabaseSessionIdentityError({
          message:
            'DATABASE_ADMIN_URL and DATABASE_URL must authenticate as distinct authenticated PostgreSQL roles',
        }),
    );
  }
};

const hasMembershipObjectAuthority = (membership: RoleMembership): boolean =>
  [
    membership.createSchemas,
    membership.ownedRelations,
    membership.ownedRoutines,
    membership.ownedSchemas,
    membership.ownedTypes,
    membership.parameterPrivileges ?? [],
    membership.relationPrivilegeSchemas,
    membership.securityDefinerRoutines,
  ].some((objects) => objects.length > 0);

const hasPrivilegedMembership = (membership: RoleMembership): boolean =>
  ((membership.canSetRole || membership.canAdministerRole) &&
    hasClusterPrivilege(membership.attributes)) ||
  membership.predefinedRole === true ||
  membership.databaseCreate ||
  hasMembershipObjectAuthority(membership);

const hasUsableViewPrivileges = (table: TablePrivilege): boolean =>
  table.privileges.select ||
  (table.privileges.insert && table.insertable !== false) ||
  (table.privileges.update && table.updatable !== false) ||
  (table.privileges.delete && table.deletable !== false);

const hasPrivilegedViewOwner = (table: TablePrivilege, administrativeRole: string): boolean =>
  (table.securityInvoker !== true &&
    (table.owner === administrativeRole ||
      table.ownerBypassRls === true ||
      table.ownerSuperuser === true)) ||
  table.ownerContextPrivileged === true ||
  table.ownerContextRlsBypass === true;

const isPrivilegedOwnerView = (table: TablePrivilege, administrativeRole: string): boolean =>
  table.kind === 'view' &&
  hasUsableViewPrivileges(table) &&
  hasPrivilegedViewOwner(table, administrativeRole);

const hasDdlAuthority = (snapshot: DatabaseTrustBoundarySnapshot): boolean => {
  const { memberships, routines, schemas, sequences, tables, types } = snapshot;
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
  return (
    snapshot.databasePrivileges.create ||
    schemas.some(({ create }) => create) ||
    ownsRelation ||
    ownsRoutine ||
    ownsType ||
    inheritsOwnership
  );
};

export const buildDatabaseTrustBoundaryReport = (
  snapshot: DatabaseTrustBoundarySnapshot,
): DatabaseTrustBoundaryReport => {
  const schemas = sorted(snapshot.schemas, (left, right) => compareText(left.schema, right.schema));
  const tables = sorted(
    snapshot.tables,
    (left, right) => compareText(left.schema, right.schema) || compareText(left.table, right.table),
  );
  const sequences = sorted(
    snapshot.sequences,
    (left, right) =>
      compareText(left.schema, right.schema) || compareText(left.sequence, right.sequence),
  );
  const routines = sorted(
    snapshot.routines,
    (left, right) =>
      compareText(left.schema, right.schema) ||
      compareText(left.routine, right.routine) ||
      compareText(left.identityArguments, right.identityArguments),
  );
  const types = sorted(
    snapshot.types,
    (left, right) => compareText(left.schema, right.schema) || compareText(left.type, right.type),
  );
  const defaultPrivileges = sorted(
    snapshot.defaultPrivileges,
    (left, right) =>
      compareText(left.schema ?? '', right.schema ?? '') ||
      compareText(left.owner, right.owner) ||
      compareText(left.objectType, right.objectType) ||
      compareText(left.grantee, right.grantee) ||
      compareText(left.privilege, right.privilege) ||
      compareText(left.source, right.source) ||
      Number(left.grantable) - Number(right.grantable),
  );
  const memberships = sorted(snapshot.memberships, (left, right) =>
    compareText(left.role, right.role),
  );
  const grantOptions = sorted(snapshot.grantOptions, compareText);
  const grantableDefaultPrivileges = defaultPrivileges.filter(({ grantable }) => grantable);
  const parameterPrivileges = sorted(snapshot.parameterPrivileges, (left, right) =>
    compareText(left.parameter, right.parameter),
  );
  const findings: DatabaseTrustBoundaryFinding[] = [];
  const dmlTables = tables.filter(hasDml);

  addFinding(
    findings,
    hasClusterPrivilege(snapshot.role) || snapshot.role.predefinedRole === true,
    {
      code: 'runtime_role_is_privileged',
      evidence:
        'The runtime role has a PostgreSQL cluster-level privilege or is a predefined PostgreSQL role.',
      severity: 'critical',
    },
  );
  const administrativeMembership = memberships.some(
    ({ canAdministerRole, canInheritRole, canSetRole, role }) =>
      (canSetRole || canAdministerRole || canInheritRole) && role === snapshot.administrativeRole,
  );
  addFinding(findings, administrativeMembership, {
    code: 'runtime_role_can_assume_administrative_role',
    evidence:
      'The runtime role can inherit, SET ROLE to, or has ADMIN OPTION on the authenticated administrative identity.',
    severity: 'critical',
  });
  const nonAdministrativeMemberships = memberships.filter(
    ({ canAdministerRole, canInheritRole, canSetRole, role }) =>
      (canSetRole || canAdministerRole || canInheritRole) && role !== snapshot.administrativeRole,
  );
  const privilegedMemberships = nonAdministrativeMemberships.filter(hasPrivilegedMembership);
  addFinding(findings, privilegedMemberships.length > 0, {
    code: 'runtime_role_can_assume_privileged_role',
    evidence:
      'The runtime role can reach a non-administrative identity with predefined-role, cluster, database, schema, relation, routine, type, or parameter authority through inheritance, SET ROLE, or ADMIN OPTION.',
    severity: 'critical',
  });
  addFinding(findings, nonAdministrativeMemberships.length > privilegedMemberships.length, {
    code: 'runtime_role_can_assume_other_role',
    evidence:
      'The runtime role can inherit, SET ROLE to, or administer at least one additional identity.',
    severity: 'high',
  });
  addFinding(findings, hasDdlAuthority(snapshot), {
    code: 'runtime_role_has_ddl_authority',
    evidence:
      'The runtime role has database/schema CREATE or direct/inherited ownership of an audited schema, relation, routine, or application type.',
    severity: 'high',
  });
  const relationControlTables = tables.filter(
    ({ privileges }) =>
      privileges.maintain || privileges.references || privileges.trigger || privileges.truncate,
  );
  addFinding(findings, relationControlTables.length > 0, {
    code: 'runtime_role_has_relation_control_authority',
    evidence:
      'The runtime role has MAINTAIN, TRUNCATE, REFERENCES, or TRIGGER on an audited table-like relation.',
    severity: 'high',
  });
  const executableSecurityDefiners = routines.filter(
    ({ executable, owner, securityDefiner }) =>
      executable && securityDefiner && owner !== snapshot.runtimeRole,
  );
  addFinding(findings, executableSecurityDefiners.length > 0, {
    code: 'runtime_role_can_execute_security_definer',
    evidence:
      'The runtime role can execute a SECURITY DEFINER routine owned by another role in an audited schema.',
    severity: 'high',
  });
  const privilegedOwnerViews = tables.filter((table) =>
    isPrivilegedOwnerView(table, snapshot.administrativeRole),
  );
  addFinding(findings, privilegedOwnerViews.length > 0, {
    code: 'runtime_role_can_use_privileged_owner_view',
    evidence:
      'The runtime role can read or write through an owner-context view with an administrative, BYPASSRLS, superuser, or RLS-bypassing owner in its dependency chain.',
    severity: 'high',
  });
  addFinding(findings, parameterPrivileges.length > 0, {
    code: 'runtime_role_has_parameter_authority',
    evidence:
      'The runtime role has an explicit effective SET or ALTER SYSTEM privilege on a PostgreSQL configuration parameter.',
    severity: 'critical',
  });
  addFinding(findings, grantOptions.length > 0 || grantableDefaultPrivileges.length > 0, {
    code: 'runtime_role_has_grant_authority',
    evidence:
      'The runtime role has a grant option on at least one existing or creator-default database object privilege.',
    severity: 'high',
  });
  addFinding(
    findings,
    sequences.some(({ privileges }) => privileges.update),
    {
      code: 'runtime_role_has_sequence_mutation_authority',
      evidence: 'The runtime role has UPDATE on an audited sequence.',
      severity: 'high',
    },
  );
  addFinding(
    findings,
    snapshot.trustedContext.tenantSettingSettable ||
      snapshot.trustedContext.legalEntitySettingSettable,
    {
      code: 'runtime_role_can_forge_trusted_context',
      evidence:
        'The ordinary runtime role can set and read at least one custom GUC used by tenant RLS.',
      severity: 'high',
    },
  );
  addFinding(
    findings,
    snapshot.trustedContext.tenantSettingRetainedAfterRollback ||
      snapshot.trustedContext.legalEntitySettingRetainedAfterRollback,
    {
      code: 'trusted_context_survives_transaction',
      evidence: 'A probed transaction-local trusted context value remained visible after rollback.',
      severity: 'critical',
    },
  );
  const dmlSchemas = new Set(dmlTables.map(({ schema }) => schema));
  addFinding(findings, dmlSchemas.size > 1, {
    code: 'runtime_role_has_cross_schema_dml',
    evidence: 'One runtime role has DML privileges in more than one audited application schema.',
    severity: 'high',
  });

  return {
    ...snapshot,
    defaultPrivileges,
    findings,
    grantOptions,
    memberships,
    parameterPrivileges,
    routines,
    schemas,
    schemaVersion: 1,
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
