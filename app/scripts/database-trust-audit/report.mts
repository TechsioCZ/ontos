// oxlint-disable-next-line max-classes-per-file -- This report owns the three related tagged audit failures.
import { Cause, Option, Redacted, Result, Schema } from 'effect';

import type {
  DatabaseAcceptedFinding,
  DatabaseIdentity,
  DatabaseRoleGrants,
  DatabaseScopeAuthority,
} from '../../packages/core-runtime/src/db/database-identities.ts';

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
  /** Canonical `schema.routine(argtypes)` signature; see {@link canonicalRoutineSignature}. */
  readonly signature: string;
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
  /** Table-level privileges only; column grants are listed in `columnPrivileges`. */
  readonly tableGrants: {
    readonly delete: boolean;
    readonly insert: boolean;
    readonly select: boolean;
    readonly update: boolean;
  };
  readonly updatable?: boolean;
}

interface ColumnPrivilege {
  readonly column: string;
  readonly privilege: string;
  readonly schema: string;
  readonly table: string;
}

interface PolicyEvidence {
  readonly command: 'all' | 'delete' | 'insert' | 'select' | 'update';
  readonly policy: string;
  readonly readsSessionSetting: boolean;
  readonly readsTrustedScope: boolean;
  readonly schema: string;
  readonly table: string;
}

interface RoleSetting {
  readonly scope: 'all_databases' | 'current_database';
  readonly setting: string;
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
  /** An `ontos_trust.scope` probe value stayed visible after COMMIT. */
  readonly scopeRetainedAfterCommit: boolean;
  /** An `ontos_trust.scope` probe value stayed visible after ROLLBACK. */
  readonly scopeRetainedAfterRollback: boolean;
  /** An `ontos.tenant_id` probe value stayed visible after COMMIT. */
  readonly sessionSettingRetainedAfterCommit: boolean;
  readonly tenantSetLocalSettable: boolean;
  readonly tenantSettingRetainedAfterRollback: boolean;
  readonly tenantSettingSettable: boolean;
  readonly transactionLocal: true;
  readonly trustedScope: {
    /** The role can execute `trust.current_tenant_id()`. */
    readonly executable: boolean;
    /** The accessor returned a tenant for a well-formed seal carrying a forged MAC. */
    readonly forgedSealAccepted: boolean;
    /** The accessor returned a tenant from a plain `ontos.tenant_id` setting. */
    readonly sessionSettingAccepted: boolean;
  };
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
  readonly columnPrivileges: readonly ColumnPrivilege[];
  readonly database: string;
  readonly databasePrivileges: DatabasePrivileges;
  readonly defaultPrivileges: readonly DefaultPrivilege[];
  readonly grantOptions: readonly string[];
  readonly memberships: readonly RoleMembership[];
  readonly parameterPrivileges: readonly ParameterPrivilege[];
  readonly policies: readonly PolicyEvidence[];
  readonly role: RoleAttributes;
  readonly roleSettings: readonly RoleSetting[];
  readonly routines: readonly RoutinePrivilege[];
  readonly runtimeRole: string;
  readonly schemas: readonly SchemaPrivilege[];
  readonly sequences: readonly SequencePrivilege[];
  readonly tables: readonly TablePrivilege[];
  readonly trustedContext: TrustedContextEvidence;
  readonly types: readonly TypePrivilege[];
}

/** Global trust-catalog evidence for one `trust.*` routine. */
interface TrustRoutineEvidence {
  readonly config: readonly string[];
  /** EXECUTE grantees other than the owner and PUBLIC. */
  readonly grantees: readonly string[];
  readonly owner: string;
  readonly publicExecute: boolean;
  readonly securityDefiner: boolean;
  readonly signature: string;
}

interface TrustTableGrantee {
  readonly grantee: string;
  readonly privilege: string;
  readonly table: string;
}

interface IdentityMembership {
  readonly member: string;
  readonly role: string;
}

export interface GlobalTrustSnapshot {
  readonly identityMemberships: readonly IdentityMembership[];
  readonly trustRoutines: readonly TrustRoutineEvidence[];
  readonly trustTableGrantees: readonly TrustTableGrantee[];
}

export interface DatabaseIdentitySnapshot {
  readonly identityId: string;
  readonly scopeAuthority: DatabaseScopeAuthority;
  readonly snapshot: DatabaseTrustBoundarySnapshot;
}

export interface DatabaseTrustBoundaryInput {
  readonly administrativeRole: string;
  readonly database: string;
  readonly global: GlobalTrustSnapshot;
  readonly identities: readonly DatabaseIdentitySnapshot[];
}

type ManifestIdentity = Pick<DatabaseIdentity, 'id' | 'role'>;

/** The fields of a `DatabaseRoleGrantManifestEntry` the audit reads. */
export type DatabaseTrustManifestEntry =
  | {
      readonly acceptedFindings: readonly DatabaseAcceptedFinding[];
      readonly identity: ManifestIdentity;
      readonly kind: 'legacy_shared';
      readonly revokedSchemas: readonly string[];
      readonly roleSettings: readonly string[];
    }
  | {
      readonly grants: DatabaseRoleGrants;
      readonly identity: ManifestIdentity;
      readonly kind: 'explicit';
      readonly roleSettings: readonly string[];
    };

/** The fields of a `TRUST_ROUTINES` entry the audit reads. */
export interface DatabaseTrustRoutineExpectation {
  readonly executableBy: readonly string[];
  readonly securityDefiner: boolean;
  readonly signature: string;
}

export const IDENTITY_FINDING_CODES = [
  'runtime_role_is_privileged',
  'runtime_role_can_assume_administrative_role',
  'runtime_role_can_assume_privileged_role',
  'runtime_role_can_assume_other_role',
  'runtime_role_has_ddl_authority',
  'runtime_role_has_relation_control_authority',
  'runtime_role_can_execute_security_definer',
  'runtime_role_can_use_privileged_owner_view',
  'runtime_role_has_parameter_authority',
  'runtime_role_has_grant_authority',
  'runtime_role_has_sequence_mutation_authority',
  'runtime_role_can_forge_trusted_context',
  'trusted_context_survives_transaction',
  'runtime_role_has_cross_schema_dml',
  'runtime_role_has_temporary_authority',
  'runtime_role_privilege_outside_manifest',
  'runtime_role_missing_manifest_privilege',
  'runtime_role_has_role_settings',
] as const;

export const GLOBAL_FINDING_CODES = [
  'trusted_scope_entry_point_unhardened',
  'runtime_identities_share_role',
  'runtime_identity_can_assume_other_identity',
] as const;

type IdentityFindingCode = (typeof IDENTITY_FINDING_CODES)[number];
type GlobalFindingCode = (typeof GLOBAL_FINDING_CODES)[number];

interface DatabaseTrustBoundaryFinding<Code extends string = IdentityFindingCode> {
  readonly code: Code;
  readonly evidence: string;
  readonly objects: readonly string[];
  readonly severity: 'critical' | 'high';
}

interface AcceptedDatabaseTrustBoundaryFinding extends DatabaseTrustBoundaryFinding {
  readonly reason: string;
}

export interface DatabaseIdentityTrustReport {
  readonly acceptedFindings: readonly AcceptedDatabaseTrustBoundaryFinding[];
  readonly findings: readonly DatabaseTrustBoundaryFinding[];
  readonly identityId: string;
  readonly role: string;
  readonly scopeAuthority: DatabaseScopeAuthority;
  readonly snapshot: DatabaseTrustBoundarySnapshot;
  readonly summary: {
    readonly acceptedFindingCount: number;
    readonly auditedSchemaCount: number;
    readonly columnPrivilegeCount: number;
    readonly defaultPrivilegeCount: number;
    readonly dmlSchemaCount: number;
    readonly dmlTableCount: number;
    readonly findingCount: number;
    readonly grantOptionCount: number;
    readonly parameterPrivilegeCount: number;
    readonly policyCount: number;
    readonly privilegedOwnerViewCount: number;
    readonly routineCount: number;
    readonly securityDefinerExecutableCount: number;
    readonly sequenceCount: number;
    readonly tableCount: number;
    readonly typeCount: number;
    readonly unacceptedFindingCount: number;
  };
  readonly unacceptedFindings: readonly DatabaseTrustBoundaryFinding[];
}

export interface DatabaseTrustBoundaryReport {
  readonly administrativeRole: string;
  readonly database: string;
  readonly globalFindings: readonly DatabaseTrustBoundaryFinding<GlobalFindingCode>[];
  readonly identities: readonly DatabaseIdentityTrustReport[];
  readonly schemaVersion: 2;
  readonly unacceptedFindingCount: number;
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

export const getDatabaseTrustBoundaryFailureMessage = (cause: Cause.Cause<DatabaseTrustBoundaryAuditError>): string => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && Schema.is(DatabaseTrustBoundaryAuditError)(failure.value)
    ? failure.value.reason
    : genericAuditFailureMessage;
};

const hasDml = (table: TablePrivilege): boolean =>
  table.privileges.delete || table.privileges.insert || table.privileges.select || table.privileges.update;

const hasClusterPrivilege = (role: RoleAttributes): boolean =>
  role.superuser || role.bypassRls || role.canCreateDatabases || role.canCreateRoles || role.replication;

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const sorted = <Value,>(values: Iterable<Value>, compare: (left: Value, right: Value) => number): Value[] => {
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

const uniqueSorted = (values: Iterable<string>): string[] => sorted(new Set(values), compareText);

const addFinding = <Code extends string>(
  findings: DatabaseTrustBoundaryFinding<Code>[],
  included: boolean,
  finding: DatabaseTrustBoundaryFinding<Code>,
): void => {
  if (included) {
    findings.push({ ...finding, objects: uniqueSorted(finding.objects) });
  }
};

/** Fails unless the runtime connection reached the same server and database as the administrative one. */
export const assertSameDatabaseTarget = (
  administrative: DatabaseTargetIdentity,
  runtime: DatabaseTargetIdentity,
  runtimeUrlKey: string,
): Result.Result<void, DatabaseTargetMismatchError> =>
  administrative.database !== runtime.database ||
  administrative.serverAddress !== runtime.serverAddress ||
  administrative.serverPort !== runtime.serverPort ||
  (administrative.serverAddress === null &&
    (administrative.configuredHost !== runtime.configuredHost ||
      administrative.configuredPort !== runtime.configuredPort))
    ? Result.fail(
        new DatabaseTargetMismatchError({
          message: `DATABASE_ADMIN_URL and ${runtimeUrlKey} must target the same PostgreSQL server and database`,
        }),
      )
    : Result.void;

const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = 5432;

/**
 * Resolves the endpoint the `@effect/sql-pg` driver dials for a connection URL: the last `host` /
 * `port` query parameter wins over the URL authority, a bracketed IPv6 authority is unwrapped, and
 * absent values fall back to the driver defaults.
 */
export const getEffectiveDatabaseEndpoint = (
  connectionString: Redacted.Redacted,
): Result.Result<Pick<DatabaseTargetIdentity, 'configuredHost' | 'configuredPort'>, DatabaseTrustBoundaryAuditError> =>
  Result.try({
    catch: () => new DatabaseTrustBoundaryAuditError({ reason: 'Database connection URL is invalid' }),
    try: () => {
      const url = new URL(Redacted.value(connectionString));
      const authorityHost =
        url.hostname.startsWith('[') && url.hostname.endsWith(']')
          ? url.hostname.slice(1, -1)
          : decodeURIComponent(url.hostname);
      const host = url.searchParams.getAll('host').at(-1) ?? (authorityHost === '' ? undefined : authorityHost);
      const port = url.searchParams.getAll('port').at(-1) ?? (url.port === '' ? undefined : url.port);
      return {
        configuredHost: host ?? DEFAULT_POSTGRES_HOST,
        configuredPort: port === undefined ? DEFAULT_POSTGRES_PORT : Number(port),
      };
    },
  });

/** Every audit connection must authenticate directly, and no two connections may share a role. */
export const assertDatabaseSessionIdentities = (
  identities: readonly DatabaseSessionIdentity[],
): Result.Result<void, DatabaseSessionIdentityError> => {
  if (identities.some(({ currentRole, sessionRole }) => currentRole !== sessionRole)) {
    return Result.fail(
      new DatabaseSessionIdentityError({
        message: 'current_user must equal session_user for every database audit connection',
      }),
    );
  }
  if (new Set(identities.map(({ sessionRole }) => sessionRole)).size !== identities.length) {
    return Result.fail(
      new DatabaseSessionIdentityError({
        message: 'Every database audit connection must authenticate as distinct authenticated PostgreSQL roles',
      }),
    );
  }
  return Result.void;
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
  ((membership.canSetRole || membership.canAdministerRole) && hasClusterPrivilege(membership.attributes)) ||
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
    (table.owner === administrativeRole || table.ownerBypassRls === true || table.ownerSuperuser === true)) ||
  table.ownerContextPrivileged === true ||
  table.ownerContextRlsBypass === true;

const isPrivilegedOwnerView = (table: TablePrivilege, administrativeRole: string): boolean =>
  table.kind === 'view' && hasUsableViewPrivileges(table) && hasPrivilegedViewOwner(table, administrativeRole);

const ddlObjects = (snapshot: DatabaseTrustBoundarySnapshot): string[] => {
  const { memberships, routines, runtimeRole, schemas, sequences, tables, types } = snapshot;
  return [
    ...(snapshot.databasePrivileges.create ? [snapshot.database] : []),
    ...schemas.filter(({ create }) => create).map(({ schema }) => schema),
    ...tables.filter(({ owner }) => owner === runtimeRole).map(({ schema, table }) => `${schema}.${table}`),
    ...sequences.filter(({ owner }) => owner === runtimeRole).map(({ schema, sequence }) => `${schema}.${sequence}`),
    ...routines.filter(({ owner }) => owner === runtimeRole).map(({ signature }) => signature),
    ...types.filter(({ owner }) => owner === runtimeRole).map(({ schema, type }) => `${schema}.${type}`),
    ...memberships
      .filter(({ canInheritRole }) => canInheritRole)
      .flatMap(({ ownedRelations, ownedRoutines, ownedSchemas, ownedTypes }) => [
        ...ownedRelations,
        ...ownedRoutines,
        ...ownedSchemas,
        ...ownedTypes,
      ]),
  ];
};

const SIGNATURE_TYPE_ALIASES = new Map([
  ['bigint', 'int8'],
  ['boolean', 'bool'],
  ['character', 'bpchar'],
  ['character varying', 'varchar'],
  ['double precision', 'float8'],
  ['integer', 'int4'],
  ['real', 'float4'],
  ['smallint', 'int2'],
  ['time with time zone', 'timetz'],
  ['time without time zone', 'time'],
  ['timestamp with time zone', 'timestamptz'],
  ['timestamp without time zone', 'timestamp'],
]);

const canonicalArgumentType = (argument: string): string => {
  const normalized = argument.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
  const arraySuffix = /(?:\[\])+$/u.exec(normalized)?.[0] ?? '';
  const base = normalized.slice(0, normalized.length - arraySuffix.length).trim();
  return `${SIGNATURE_TYPE_ALIASES.get(base) ?? base.replaceAll(' ', '')}${arraySuffix}`;
};

/**
 * Normalizes a `schema.routine(argtypes)` signature so catalog output (`oidvectortypes`) and manifest
 * declarations compare equal: whitespace is dropped and SQL type spellings map to their catalog names.
 */
export const canonicalRoutineSignature = (signature: string): string => {
  const open = signature.indexOf('(');
  if (open === -1 || !signature.endsWith(')')) {
    return signature.replaceAll(/\s+/gu, '');
  }
  const argumentTypes = signature
    .slice(open + 1, -1)
    .split(',')
    .filter((argument) => argument.trim().length > 0)
    .map(canonicalArgumentType);
  return `${signature.slice(0, open).trim()}(${argumentTypes.join(',')})`;
};

/** The only `proconfig` a trusted-scope routine may carry. */
export const TRUSTED_ROUTINE_CONFIG: readonly string[] = Object.freeze(['search_path=pg_catalog, pg_temp']);

const TRUSTED_TENANT_ACCESSOR = 'trust.current_tenant_id()';

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

const sortSnapshot = (snapshot: DatabaseTrustBoundarySnapshot): DatabaseTrustBoundarySnapshot => ({
  ...snapshot,
  columnPrivileges: sorted(
    snapshot.columnPrivileges,
    (left, right) =>
      compareText(left.schema, right.schema) ||
      compareText(left.table, right.table) ||
      compareText(left.column, right.column) ||
      compareText(left.privilege, right.privilege),
  ),
  defaultPrivileges: sorted(
    snapshot.defaultPrivileges,
    (left, right) =>
      compareText(left.schema ?? '', right.schema ?? '') ||
      compareText(left.owner, right.owner) ||
      compareText(left.objectType, right.objectType) ||
      compareText(left.grantee, right.grantee) ||
      compareText(left.privilege, right.privilege) ||
      compareText(left.source, right.source) ||
      Number(left.grantable) - Number(right.grantable),
  ),
  grantOptions: sorted(snapshot.grantOptions, compareText),
  memberships: sorted(snapshot.memberships, (left, right) => compareText(left.role, right.role)),
  parameterPrivileges: sorted(snapshot.parameterPrivileges, (left, right) =>
    compareText(left.parameter, right.parameter),
  ),
  policies: sorted(
    snapshot.policies,
    (left, right) =>
      compareText(left.schema, right.schema) ||
      compareText(left.table, right.table) ||
      compareText(left.policy, right.policy),
  ),
  roleSettings: sorted(
    snapshot.roleSettings,
    (left, right) => compareText(left.scope, right.scope) || compareText(left.setting, right.setting),
  ),
  routines: sorted(
    snapshot.routines.map((routine) => ({ ...routine, signature: canonicalRoutineSignature(routine.signature) })),
    (left, right) =>
      compareText(left.schema, right.schema) ||
      compareText(left.routine, right.routine) ||
      compareText(left.identityArguments, right.identityArguments),
  ),
  schemas: sorted(snapshot.schemas, (left, right) => compareText(left.schema, right.schema)),
  sequences: sorted(
    snapshot.sequences,
    (left, right) => compareText(left.schema, right.schema) || compareText(left.sequence, right.sequence),
  ),
  tables: sorted(
    snapshot.tables,
    (left, right) => compareText(left.schema, right.schema) || compareText(left.table, right.table),
  ),
  types: sorted(
    snapshot.types,
    (left, right) => compareText(left.schema, right.schema) || compareText(left.type, right.type),
  ),
});

const TABLE_GRANT_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;

const columnGrantFor = (
  grant: DatabaseRoleGrants['tables'][number] | undefined,
  privilege: (typeof TABLE_GRANT_PRIVILEGES)[number],
): readonly string[] | undefined => (privilege === 'delete' ? undefined : grant?.columns?.[privilege]);

interface ManifestDifferences {
  readonly extra: readonly string[];
  readonly missing: readonly string[];
}

/** Compares a role's effective privileges with an explicit grant declaration in both directions. */
const manifestDifferences = (
  snapshot: DatabaseTrustBoundarySnapshot,
  grants: DatabaseRoleGrants,
): ManifestDifferences => {
  const declaredTables = new Map(grants.tables.map((grant) => [grant.table, grant]));
  const declaredSequences = new Map(grants.sequences.map((grant) => [grant.sequence, grant]));
  const declaredRoutines = new Set(grants.routines.map(canonicalRoutineSignature));
  const hasColumnPrivilege = (table: string, column: string, privilege: string): boolean =>
    snapshot.columnPrivileges.some(
      (candidate) =>
        `${candidate.schema}.${candidate.table}` === table &&
        candidate.column === column &&
        candidate.privilege === privilege,
    );

  const extraSchemas = snapshot.schemas
    .filter(({ schema, usage }) => usage && schema !== 'public' && !grants.schemas.includes(schema))
    .map(({ schema }) => schema);
  const extraTables = snapshot.tables
    .filter((table) => {
      const grant = declaredTables.get(`${table.schema}.${table.table}`);
      const { maintain, references, trigger, truncate } = table.privileges;
      return (
        maintain ||
        references ||
        trigger ||
        truncate ||
        TABLE_GRANT_PRIVILEGES.some(
          (privilege) =>
            table.tableGrants[privilege] &&
            (grant?.privileges.includes(privilege) !== true || columnGrantFor(grant, privilege) !== undefined),
        )
      );
    })
    .map(({ schema, table }) => `${schema}.${table}`);
  const extraColumns = snapshot.columnPrivileges
    .filter(({ column, privilege, schema, table }) => {
      const grant = declaredTables.get(`${schema}.${table}`);
      const declared = TABLE_GRANT_PRIVILEGES.find((candidate) => candidate === privilege);
      return (
        declared === undefined ||
        grant?.privileges.includes(declared) !== true ||
        columnGrantFor(grant, declared)?.includes(column) !== true
      );
    })
    .map(({ column, schema, table }) => `${schema}.${table}(${column})`);
  const extraSequences = snapshot.sequences
    .filter(({ privileges, schema, sequence }) => {
      const declared = declaredSequences.get(`${schema}.${sequence}`)?.privileges ?? [];
      return (
        privileges.update ||
        (privileges.usage && !declared.includes('usage')) ||
        (privileges.select && !declared.includes('select'))
      );
    })
    .map(({ schema, sequence }) => `${schema}.${sequence}`);
  const extraRoutines = snapshot.routines
    .filter(
      ({ executable, owner, securityDefiner, signature }) =>
        executable && securityDefiner && owner !== snapshot.runtimeRole && !declaredRoutines.has(signature),
    )
    .map(({ signature }) => signature);

  const missingSchemas = grants.schemas.filter(
    (schema) => !snapshot.schemas.some((candidate) => candidate.schema === schema && candidate.usage),
  );
  const missingTables = grants.tables.flatMap((grant) => {
    const table = snapshot.tables.find(({ schema, table: name }) => `${schema}.${name}` === grant.table);
    if (table === undefined) {
      return [grant.table];
    }
    return grant.privileges.flatMap((privilege) => {
      const columns = columnGrantFor(grant, privilege);
      if (columns === undefined) {
        return table.tableGrants[privilege] ? [] : [grant.table];
      }
      return columns
        .filter((column) => !hasColumnPrivilege(grant.table, column, privilege))
        .map((column) => `${grant.table}(${column})`);
    });
  });
  const missingSequences = grants.sequences
    .filter((grant) => {
      const sequence = snapshot.sequences.find(({ schema, sequence: name }) => `${schema}.${name}` === grant.sequence);
      return sequence === undefined || grant.privileges.some((privilege) => !sequence.privileges[privilege]);
    })
    .map(({ sequence }) => sequence);
  const missingRoutines = [...declaredRoutines].filter(
    (signature) => !snapshot.routines.some((routine) => routine.signature === signature && routine.executable),
  );

  return {
    extra: [...extraSchemas, ...extraTables, ...extraColumns, ...extraSequences, ...extraRoutines],
    missing: [...missingSchemas, ...missingTables, ...missingSequences, ...missingRoutines],
  };
};

const EMPTY_GRANTS: DatabaseRoleGrants = Object.freeze({
  acceptedFindings: [],
  routines: [],
  schemas: [],
  sequences: [],
  tables: [],
});

const roleSettingObjects = (snapshot: DatabaseTrustBoundarySnapshot, expected: readonly string[]): string[] => {
  const expectedSettings = new Set(expected);
  const allDatabases = new Set(
    snapshot.roleSettings.filter(({ scope }) => scope === 'all_databases').map(({ setting }) => setting),
  );
  return [
    ...snapshot.roleSettings
      .filter(({ scope, setting }) => scope === 'current_database' || !expectedSettings.has(setting))
      .map(({ scope, setting }) => `${scope}:${setting}`),
    ...expected.filter((setting) => !allDatabases.has(setting)).map((setting) => `all_databases:${setting}`),
  ];
};

const tableName = ({ schema, table }: { readonly schema: string; readonly table: string }): string =>
  `${schema}.${table}`;

/** Legacy entries carry no grant manifest; a missing entry is compared against an empty manifest. */
const manifestGrants = (entry: DatabaseTrustManifestEntry | undefined): DatabaseRoleGrants | undefined => {
  if (entry === undefined) {
    return EMPTY_GRANTS;
  }
  return entry.kind === 'explicit' ? entry.grants : undefined;
};

/** Withheld schemas are never part of the legacy non-pilot baseline, even without USAGE. */
const revokedSchemaObjects = (snapshot: DatabaseTrustBoundarySnapshot, schemas: readonly string[]): string[] => {
  const revoked = new Set(schemas);
  return [
    ...snapshot.schemas
      .filter(({ create, schema, usage }) => revoked.has(schema) && (usage || create))
      .map(({ schema }) => schema),
    ...snapshot.tables
      .filter((table) => revoked.has(table.schema) && Object.values(table.privileges).some(Boolean))
      .map(tableName),
    ...snapshot.columnPrivileges
      .filter(({ schema }) => revoked.has(schema))
      .map(({ column, schema, table }) => `${schema}.${table}(${column})`),
    ...snapshot.sequences
      .filter(({ privileges, schema }) => revoked.has(schema) && Object.values(privileges).some(Boolean))
      .map(({ schema, sequence }) => `${schema}.${sequence}`),
    ...snapshot.routines
      .filter(({ executable, schema }) => revoked.has(schema) && executable)
      .map(({ signature }) => signature),
    ...snapshot.defaultPrivileges
      .filter(
        ({ objectType, schema }) =>
          (schema === null || revoked.has(schema)) && ['table', 'sequence'].includes(objectType),
      )
      .map(
        ({ objectType, owner, privilege, schema }) => `default:${owner}:${objectType}:${schema ?? '*'}:${privilege}`,
      ),
  ];
};

const forgeObjectsFor = (snapshot: DatabaseTrustBoundarySnapshot, scopeAuthority: DatabaseScopeAuthority): string[] => {
  const { trustedContext } = snapshot;
  const sessionPolicyTables = snapshot.policies.filter(({ readsSessionSetting }) => readsSessionSetting).map(tableName);
  if (scopeAuthority === 'gateway_grant') {
    const accessorForgeable =
      trustedContext.trustedScope.forgedSealAccepted || trustedContext.trustedScope.sessionSettingAccepted;
    return [...(accessorForgeable ? [TRUSTED_TENANT_ACCESSOR] : []), ...sessionPolicyTables];
  }
  const sessionSettable =
    trustedContext.tenantSettingSettable ||
    trustedContext.legalEntitySettingSettable ||
    trustedContext.tenantSetLocalSettable;
  return sessionSettable ? sessionPolicyTables : [];
};

const retainedSettingsFor = ({ trustedContext }: DatabaseTrustBoundarySnapshot): string[] => [
  ...(trustedContext.tenantSettingRetainedAfterRollback || trustedContext.sessionSettingRetainedAfterCommit
    ? ['ontos.tenant_id']
    : []),
  ...(trustedContext.legalEntitySettingRetainedAfterRollback ? ['ontos.legal_entity_id'] : []),
  ...(trustedContext.scopeRetainedAfterRollback || trustedContext.scopeRetainedAfterCommit
    ? ['ontos_trust.scope']
    : []),
];

interface IdentityFindingResult {
  readonly dmlSchemaCount: number;
  readonly dmlTableCount: number;
  readonly findings: DatabaseTrustBoundaryFinding[];
  readonly grantOptionCount: number;
  readonly privilegedOwnerViewCount: number;
  readonly securityDefinerExecutableCount: number;
}

const buildIdentityFindings = (
  snapshot: DatabaseTrustBoundarySnapshot,
  scopeAuthority: DatabaseScopeAuthority,
  entry: DatabaseTrustManifestEntry | undefined,
): IdentityFindingResult => {
  const { memberships, runtimeRole, tables } = snapshot;
  const grants = manifestGrants(entry);
  const manifestRoutines = new Set((grants?.routines ?? []).map(canonicalRoutineSignature));
  const findings: DatabaseTrustBoundaryFinding[] = [];
  const dmlTables = tables.filter(hasDml);

  addFinding(findings, hasClusterPrivilege(snapshot.role) || snapshot.role.predefinedRole === true, {
    code: 'runtime_role_is_privileged',
    evidence: 'The runtime role has a PostgreSQL cluster-level privilege or is a predefined PostgreSQL role.',
    objects: [runtimeRole],
    severity: 'critical',
  });
  const administrativeMembership = memberships.some(
    ({ canAdministerRole, canInheritRole, canSetRole, role }) =>
      (canSetRole || canAdministerRole || canInheritRole) && role === snapshot.administrativeRole,
  );
  addFinding(findings, administrativeMembership, {
    code: 'runtime_role_can_assume_administrative_role',
    evidence:
      'The runtime role can inherit, SET ROLE to, or has ADMIN OPTION on the authenticated administrative identity.',
    objects: [snapshot.administrativeRole],
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
    objects: privilegedMemberships.map(({ role }) => role),
    severity: 'critical',
  });
  const otherMemberships = nonAdministrativeMemberships.filter((membership) => !hasPrivilegedMembership(membership));
  addFinding(findings, otherMemberships.length > 0, {
    code: 'runtime_role_can_assume_other_role',
    evidence: 'The runtime role can inherit, SET ROLE to, or administer at least one additional identity.',
    objects: otherMemberships.map(({ role }) => role),
    severity: 'high',
  });
  const ddl = ddlObjects(snapshot);
  addFinding(findings, ddl.length > 0, {
    code: 'runtime_role_has_ddl_authority',
    evidence:
      'The runtime role has database/schema CREATE or direct/inherited ownership of an audited schema, relation, routine, or application type.',
    objects: ddl,
    severity: 'high',
  });
  const relationControlTables = tables.filter(
    ({ privileges }) => privileges.maintain || privileges.references || privileges.trigger || privileges.truncate,
  );
  addFinding(findings, relationControlTables.length > 0, {
    code: 'runtime_role_has_relation_control_authority',
    evidence: 'The runtime role has MAINTAIN, TRUNCATE, REFERENCES, or TRIGGER on an audited table-like relation.',
    objects: relationControlTables.map(tableName),
    severity: 'high',
  });
  const executableSecurityDefiners = snapshot.routines.filter(
    ({ executable, owner, securityDefiner, signature }) =>
      executable && securityDefiner && owner !== runtimeRole && !manifestRoutines.has(signature),
  );
  addFinding(findings, executableSecurityDefiners.length > 0, {
    code: 'runtime_role_can_execute_security_definer',
    evidence:
      'The runtime role can execute a SECURITY DEFINER routine owned by another role in an audited schema that its grant manifest does not declare.',
    objects: executableSecurityDefiners.map(({ signature }) => signature),
    severity: 'high',
  });
  const privilegedOwnerViews = tables.filter((table) => isPrivilegedOwnerView(table, snapshot.administrativeRole));
  addFinding(findings, privilegedOwnerViews.length > 0, {
    code: 'runtime_role_can_use_privileged_owner_view',
    evidence:
      'The runtime role can read or write through an owner-context view with an administrative, BYPASSRLS, superuser, or RLS-bypassing owner in its dependency chain.',
    objects: privilegedOwnerViews.map(tableName),
    severity: 'high',
  });
  addFinding(findings, snapshot.parameterPrivileges.length > 0, {
    code: 'runtime_role_has_parameter_authority',
    evidence:
      'The runtime role has an explicit effective SET or ALTER SYSTEM privilege on a PostgreSQL configuration parameter.',
    objects: snapshot.parameterPrivileges.map(({ parameter }) => parameter),
    severity: 'critical',
  });
  const grantableDefaultPrivileges = snapshot.defaultPrivileges.filter(({ grantable }) => grantable);
  addFinding(findings, snapshot.grantOptions.length > 0 || grantableDefaultPrivileges.length > 0, {
    code: 'runtime_role_has_grant_authority',
    evidence:
      'The runtime role has a grant option on at least one existing or creator-default database object privilege.',
    objects: [
      ...snapshot.grantOptions,
      ...grantableDefaultPrivileges.map(
        ({ objectType, privilege, schema }) => `default:${objectType}:${schema ?? '*'}:${privilege}`,
      ),
    ],
    severity: 'high',
  });
  const mutableSequences = snapshot.sequences.filter(({ privileges }) => privileges.update);
  addFinding(findings, mutableSequences.length > 0, {
    code: 'runtime_role_has_sequence_mutation_authority',
    evidence: 'The runtime role has UPDATE on an audited sequence.',
    objects: mutableSequences.map(({ schema, sequence }) => `${schema}.${sequence}`),
    severity: 'high',
  });
  const forgeObjects = forgeObjectsFor(snapshot, scopeAuthority);
  addFinding(findings, forgeObjects.length > 0, {
    code: 'runtime_role_can_forge_trusted_context',
    evidence:
      scopeAuthority === 'gateway_grant'
        ? 'A gateway-scoped role reaches tenant RLS through a value it can set itself: a forged scope seal, a plain session setting, or a policy that reads ontos.* settings.'
        : 'The runtime role can set an ontos.* setting that one of its tenant RLS policies reads.',
    objects: forgeObjects,
    severity: 'high',
  });
  const retainedSettings = retainedSettingsFor(snapshot);
  addFinding(findings, retainedSettings.length > 0, {
    code: 'trusted_context_survives_transaction',
    evidence: 'A probed transaction-local trusted context value remained visible after rollback or commit.',
    objects: retainedSettings,
    severity: 'critical',
  });
  const dmlSchemas = new Set(dmlTables.map(({ schema }) => schema));
  addFinding(findings, entry?.kind === 'legacy_shared' && dmlSchemas.size > 1, {
    code: 'runtime_role_has_cross_schema_dml',
    evidence: 'One runtime role has DML privileges in more than one audited application schema.',
    objects: dmlTables
      .filter(({ schema }) => entry?.kind !== 'legacy_shared' || !entry.revokedSchemas.includes(schema))
      .map(tableName),
    severity: 'high',
  });
  addFinding(findings, snapshot.databasePrivileges.temporary, {
    code: 'runtime_role_has_temporary_authority',
    evidence: 'The runtime role can create temporary objects in the audited database.',
    objects: [snapshot.database],
    severity: 'high',
  });
  const differences =
    grants === undefined
      ? {
          extra: revokedSchemaObjects(snapshot, entry?.kind === 'legacy_shared' ? entry.revokedSchemas : []),
          missing: [],
        }
      : manifestDifferences(snapshot, grants);
  const extraPrivileges = [
    ...differences.extra,
    ...(entry?.kind === 'explicit'
      ? snapshot.defaultPrivileges
          .filter(({ objectType }) => objectType === 'table' || objectType === 'sequence')
          .map(
            ({ objectType, owner, privilege, schema }) =>
              `default:${owner}:${objectType}:${schema ?? '*'}:${privilege}`,
          )
      : []),
  ];
  addFinding(findings, extraPrivileges.length > 0, {
    code: 'runtime_role_privilege_outside_manifest',
    evidence:
      'The runtime role holds a schema, table, column, sequence, or SECURITY DEFINER routine privilege that its grant manifest does not declare.',
    objects: extraPrivileges,
    severity: 'high',
  });
  addFinding(findings, differences.missing.length > 0, {
    code: 'runtime_role_missing_manifest_privilege',
    evidence: 'The runtime role lacks a privilege that its grant manifest declares, or a declared object is absent.',
    objects: differences.missing,
    severity: 'high',
  });
  const settingObjects = roleSettingObjects(snapshot, entry?.roleSettings ?? []);
  addFinding(findings, settingObjects.length > 0, {
    code: 'runtime_role_has_role_settings',
    evidence: 'The role-level PostgreSQL settings differ from the settings its grant manifest declares.',
    objects: settingObjects,
    severity: 'high',
  });

  return {
    dmlSchemaCount: dmlSchemas.size,
    dmlTableCount: dmlTables.length,
    findings,
    grantOptionCount: snapshot.grantOptions.length + grantableDefaultPrivileges.length,
    privilegedOwnerViewCount: privilegedOwnerViews.length,
    securityDefinerExecutableCount: executableSecurityDefiners.length,
  };
};

const acceptedFindingsFor = (entry: DatabaseTrustManifestEntry | undefined): readonly DatabaseAcceptedFinding[] => {
  if (entry === undefined) {
    return [];
  }
  return entry.kind === 'legacy_shared' ? entry.acceptedFindings : entry.grants.acceptedFindings;
};

/** A finding is accepted only by an entry with the same code whose objects cover every finding object. */
export const findAcceptance = (
  finding: Pick<DatabaseTrustBoundaryFinding, 'code' | 'objects'>,
  accepted: readonly DatabaseAcceptedFinding[],
): Option.Option<DatabaseAcceptedFinding> =>
  Option.fromNullishOr(
    accepted.find(
      ({ code, objects }) =>
        code === finding.code &&
        (objects === 'all' || finding.objects.every((findingObject) => objects.includes(findingObject))),
    ),
  );

const buildGlobalFindings = (
  input: DatabaseTrustBoundaryInput,
  trustRoutines: readonly DatabaseTrustRoutineExpectation[],
): DatabaseTrustBoundaryFinding<GlobalFindingCode>[] => {
  const findings: DatabaseTrustBoundaryFinding<GlobalFindingCode>[] = [];
  const actualRoutines = new Map(
    input.global.trustRoutines.map((routine) => [canonicalRoutineSignature(routine.signature), routine]),
  );
  const expectedSignatures = new Set(trustRoutines.map(({ signature }) => canonicalRoutineSignature(signature)));
  const unhardenedRoutines = trustRoutines
    .filter((expected) => {
      const actual = actualRoutines.get(canonicalRoutineSignature(expected.signature));
      return (
        actual === undefined ||
        actual.securityDefiner !== expected.securityDefiner ||
        actual.config.length !== TRUSTED_ROUTINE_CONFIG.length ||
        actual.config.some((setting, index) => setting !== TRUSTED_ROUTINE_CONFIG[index]) ||
        actual.owner !== input.administrativeRole ||
        actual.publicExecute ||
        !sameSet(actual.grantees, expected.executableBy)
      );
    })
    .map(({ signature }) => canonicalRoutineSignature(signature));
  const undeclaredRoutines = [...actualRoutines.keys()].filter((signature) => !expectedSignatures.has(signature));
  const exposedTrustTables = input.global.trustTableGrantees
    .filter(({ grantee }) => grantee !== input.administrativeRole)
    .map(({ table }) => table);
  const unhardened = [...unhardenedRoutines, ...undeclaredRoutines, ...exposedTrustTables];
  addFinding(findings, unhardened.length > 0, {
    code: 'trusted_scope_entry_point_unhardened',
    evidence:
      'A trust.* routine is missing, undeclared, owned by a non-administrative role, executable by PUBLIC or an undeclared role, has the wrong SECURITY DEFINER flag or search_path, or a trust table has a runtime grantee.',
    objects: unhardened,
    severity: 'critical',
  });
  const roles = input.identities.map(({ snapshot }) => snapshot.runtimeRole);
  const sharedRoles = roles.filter((role, index) => roles.indexOf(role) !== index);
  addFinding(findings, sharedRoles.length > 0, {
    code: 'runtime_identities_share_role',
    evidence: 'Two checked-in database identities authenticate as the same PostgreSQL role.',
    objects: sharedRoles,
    severity: 'critical',
  });
  const identityRoles = new Set(roles);
  const crossIdentityMemberships = [
    ...input.global.identityMemberships.map(({ member, role }) => `${member}>${role}`),
    ...input.identities.flatMap(({ snapshot }) =>
      snapshot.memberships
        .filter(
          ({ canAdministerRole, canInheritRole, canSetRole, role }) =>
            (canSetRole || canAdministerRole || canInheritRole) &&
            role !== snapshot.runtimeRole &&
            identityRoles.has(role),
        )
        .map(({ role }) => `${snapshot.runtimeRole}>${role}`),
    ),
  ];
  addFinding(findings, crossIdentityMemberships.length > 0, {
    code: 'runtime_identity_can_assume_other_identity',
    evidence: 'A database identity is a member of, or can assume, another checked-in database identity.',
    objects: crossIdentityMemberships,
    severity: 'critical',
  });
  return findings;
};

export const buildDatabaseTrustBoundaryReport = (
  input: DatabaseTrustBoundaryInput,
  manifest: readonly DatabaseTrustManifestEntry[],
  trustRoutines: readonly DatabaseTrustRoutineExpectation[],
): DatabaseTrustBoundaryReport => {
  const identities = input.identities.map(({ identityId, scopeAuthority, snapshot: rawSnapshot }) => {
    const snapshot = sortSnapshot(rawSnapshot);
    const entry = manifest.find(({ identity }) => identity.id === identityId);
    const result = buildIdentityFindings(snapshot, scopeAuthority, entry);
    const accepted = acceptedFindingsFor(entry);
    const acceptedFindings: AcceptedDatabaseTrustBoundaryFinding[] = [];
    const unacceptedFindings: DatabaseTrustBoundaryFinding[] = [];
    for (const finding of result.findings) {
      const acceptance =
        entry?.kind === 'legacy_shared' && finding.code === 'runtime_role_privilege_outside_manifest'
          ? Option.none<DatabaseAcceptedFinding>()
          : findAcceptance(finding, accepted);
      if (Option.isSome(acceptance)) {
        acceptedFindings.push({ ...finding, reason: acceptance.value.reason });
      } else {
        unacceptedFindings.push(finding);
      }
    }
    return {
      acceptedFindings,
      findings: result.findings,
      identityId,
      role: snapshot.runtimeRole,
      scopeAuthority,
      snapshot,
      summary: {
        acceptedFindingCount: acceptedFindings.length,
        auditedSchemaCount: snapshot.schemas.length,
        columnPrivilegeCount: snapshot.columnPrivileges.length,
        defaultPrivilegeCount: snapshot.defaultPrivileges.length,
        dmlSchemaCount: result.dmlSchemaCount,
        dmlTableCount: result.dmlTableCount,
        findingCount: result.findings.length,
        grantOptionCount: result.grantOptionCount,
        parameterPrivilegeCount: snapshot.parameterPrivileges.length,
        policyCount: snapshot.policies.length,
        privilegedOwnerViewCount: result.privilegedOwnerViewCount,
        routineCount: snapshot.routines.length,
        securityDefinerExecutableCount: result.securityDefinerExecutableCount,
        sequenceCount: snapshot.sequences.length,
        tableCount: snapshot.tables.length,
        typeCount: snapshot.types.length,
        unacceptedFindingCount: unacceptedFindings.length,
      },
      unacceptedFindings,
    };
  });
  return {
    administrativeRole: input.administrativeRole,
    database: input.database,
    globalFindings: buildGlobalFindings(input, trustRoutines),
    identities,
    schemaVersion: 2,
    unacceptedFindingCount: identities.reduce((total, { unacceptedFindings }) => total + unacceptedFindings.length, 0),
  };
};

/** The audit fails when any identity has an unaccepted finding or any global finding exists. */
export const databaseTrustBoundaryExitCode = (
  report: Pick<DatabaseTrustBoundaryReport, 'globalFindings' | 'unacceptedFindingCount'>,
): 0 | 1 => (report.unacceptedFindingCount + report.globalFindings.length > 0 ? 1 : 0);
