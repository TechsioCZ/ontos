#!/usr/bin/env node
/* eslint-disable node/no-process-env -- The audit loads the canonical workspace environment. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import type { ClientBase } from 'pg';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';

interface DatabasePrivileges {
  readonly connect: boolean;
  readonly create: boolean;
  readonly owner: boolean;
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

interface ExtensionOwnership {
  readonly extension: string;
  readonly owner: string;
  readonly schema: string;
}

interface ForeignDataWrapperOwnership {
  readonly owner: string;
  readonly wrapper: string;
}

interface ForeignServerOwnership {
  readonly owner: string;
  readonly server: string;
}

interface PublicationOwnership {
  readonly owner: string;
  readonly publication: string;
}

interface SubscriptionOwnership {
  readonly owner: string;
  readonly subscription: string;
}

interface GrantOption {
  readonly authority: string;
  readonly role: string;
  readonly source: 'assumable' | 'direct';
}

interface RoleMembership {
  readonly attributes: RoleAttributes;
  readonly canAdministerRole: boolean;
  readonly canInheritRole: boolean;
  readonly canSetRole: boolean;
  readonly createSchemas: readonly string[];
  readonly databaseCreate: boolean;
  readonly databaseOwner?: boolean;
  readonly ownedExtensions?: readonly string[];
  readonly ownedForeignDataWrappers?: readonly string[];
  readonly ownedForeignServers?: readonly string[];
  readonly ownedPublications?: readonly string[];
  readonly ownedSubscriptions?: readonly string[];
  readonly ownedRelations: readonly string[];
  readonly ownedRoutines: readonly string[];
  readonly ownedSchemas: readonly string[];
  readonly ownedTypes: readonly string[];
  readonly parameterPrivileges?: readonly string[];
  readonly predefinedRole?: boolean;
  readonly relationPrivilegeSchemas: readonly string[];
  readonly role: string;
  readonly securityDefinerPolicyBindings?: readonly string[];
  readonly securityDefinerRoutines: readonly string[];
  readonly securityDefinerAggregateBindings?: readonly string[];
  readonly securityDefinerEventTriggerBindings?: readonly string[];
  readonly securityDefinerOperatorBindings?: readonly string[];
  readonly securityDefinerStoredExpressionBindings?: readonly string[];
  readonly securityDefinerTriggerBindings?: readonly string[];
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
  readonly aggregateBindings?: readonly string[];
  readonly eventTriggerBindings: readonly string[];
  readonly executable: boolean;
  readonly identityArguments: string;
  readonly kind: 'aggregate' | 'function' | 'procedure' | 'window';
  readonly owner: string;
  readonly operatorBindings?: readonly string[];
  readonly policyBindings: readonly string[];
  readonly routine: string;
  readonly schema: string;
  readonly securityDefiner: boolean;
  readonly storedExpressionBindings: readonly string[];
  readonly triggerBindings: readonly string[];
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
  readonly ownerBypassRls?: boolean;
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
  readonly extensions: readonly ExtensionOwnership[];
  readonly foreignDataWrappers: readonly ForeignDataWrapperOwnership[];
  readonly foreignServers: readonly ForeignServerOwnership[];
  readonly grantOptions: readonly GrantOption[];
  readonly memberships: readonly RoleMembership[];
  readonly parameterPrivileges: readonly ParameterPrivilege[];
  readonly publications: readonly PublicationOwnership[];
  readonly role: RoleAttributes;
  readonly routines: readonly RoutinePrivilege[];
  readonly runtimeRole: string;
  readonly schemas: readonly SchemaPrivilege[];
  readonly sequences: readonly SequencePrivilege[];
  readonly subscriptions: readonly SubscriptionOwnership[];
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
    | 'runtime_role_can_select_privileged_owner_view'
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
    readonly extensionCount: number;
    readonly findingCount: number;
    readonly foreignDataWrapperCount: number;
    readonly foreignServerCount: number;
    readonly grantOptionCount: number;
    readonly parameterPrivilegeCount: number;
    readonly publicationCount: number;
    readonly privilegedOwnerViewCount: number;
    readonly routineCount: number;
    readonly securityDefinerExecutableCount: number;
    readonly sequenceCount: number;
    readonly subscriptionCount: number;
    readonly tableCount: number;
    readonly typeCount: number;
  };
}

export class DatabaseTrustBoundaryAuditError extends Schema.TaggedError<DatabaseTrustBoundaryAuditError>()(
  'DatabaseTrustBoundaryAuditError',
  { reason: Schema.String },
) {}

const genericAuditFailureMessage = 'Database trust-boundary audit failed';

export const getDatabaseTrustBoundaryFailureMessage = (
  cause: Cause.Cause<DatabaseTrustBoundaryAuditError>,
): string => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && failure.value instanceof DatabaseTrustBoundaryAuditError
    ? failure.value.reason
    : genericAuditFailureMessage;
};

class DatabaseTargetMismatchError extends Error {}

class DatabaseSessionIdentityError extends Error {}

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
  const extensions = [...snapshot.extensions].toSorted((left, right) =>
    compareText(left.extension, right.extension),
  );
  const foreignDataWrappers = [...snapshot.foreignDataWrappers].toSorted((left, right) =>
    compareText(left.wrapper, right.wrapper),
  );
  const foreignServers = [...snapshot.foreignServers].toSorted((left, right) =>
    compareText(left.server, right.server),
  );
  const publications = [...snapshot.publications].toSorted((left, right) =>
    compareText(left.publication, right.publication),
  );
  const subscriptions = [...snapshot.subscriptions].toSorted((left, right) =>
    compareText(left.subscription, right.subscription),
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
  const grantOptions = [...snapshot.grantOptions].toSorted(
    (left, right) =>
      compareText(left.role, right.role) ||
      compareText(left.source, right.source) ||
      compareText(left.authority, right.authority),
  );
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
  const assumableRoleNames = new Set(
    memberships
      .filter(({ canAdministerRole, canSetRole }) => canAdministerRole || canSetRole)
      .map(({ role }) => role),
  );
  const usableGrantableDefaultPrivileges = defaultPrivileges.filter(
    ({ grantee, grantable, source }) =>
      grantable &&
      (source === 'direct' || source === 'assumable' || assumableRoleNames.has(grantee)),
  );
  const grantAuthorityRoles = new Set([
    ...grantOptions.filter(({ source }) => source === 'assumable').map(({ role }) => role),
    ...usableGrantableDefaultPrivileges
      .filter(({ source }) => source !== 'direct')
      .map(({ grantee }) => grantee),
  ]);
  const privilegedMemberships = nonAdministrativeMemberships.filter(
    ({
      attributes,
      canAdministerRole,
      canSetRole,
      createSchemas,
      databaseCreate,
      databaseOwner = false,
      ownedExtensions = [],
      ownedForeignDataWrappers = [],
      ownedForeignServers = [],
      ownedPublications = [],
      ownedSubscriptions = [],
      ownedRelations,
      ownedRoutines,
      ownedSchemas,
      ownedTypes,
      parameterPrivileges = [],
      predefinedRole,
      relationPrivilegeSchemas,
      role,
      securityDefinerPolicyBindings = [],
      securityDefinerRoutines,
      securityDefinerAggregateBindings = [],
      securityDefinerEventTriggerBindings = [],
      securityDefinerOperatorBindings = [],
      securityDefinerStoredExpressionBindings = [],
      securityDefinerTriggerBindings = [],
    }) =>
      ((canSetRole || canAdministerRole) && hasClusterPrivilege(attributes)) ||
      predefinedRole === true ||
      databaseCreate ||
      databaseOwner ||
      createSchemas.length > 0 ||
      ownedExtensions.length > 0 ||
      ownedForeignDataWrappers.length > 0 ||
      ownedForeignServers.length > 0 ||
      ownedPublications.length > 0 ||
      ownedSubscriptions.length > 0 ||
      ownedRelations.length > 0 ||
      ownedRoutines.length > 0 ||
      ownedSchemas.length > 0 ||
      ownedTypes.length > 0 ||
      parameterPrivileges.length > 0 ||
      grantAuthorityRoles.has(role) ||
      relationPrivilegeSchemas.length > 0 ||
      securityDefinerPolicyBindings.length > 0 ||
      securityDefinerRoutines.length > 0 ||
      securityDefinerAggregateBindings.length > 0 ||
      securityDefinerEventTriggerBindings.length > 0 ||
      securityDefinerOperatorBindings.length > 0 ||
      securityDefinerStoredExpressionBindings.length > 0 ||
      securityDefinerTriggerBindings.length > 0,
  );
  if (privilegedMemberships.length > 0) {
    findings.push({
      code: 'runtime_role_can_assume_privileged_role',
      evidence:
        'The runtime role can reach a non-administrative identity with predefined-role, cluster, database, schema, extension, foreign-data, publication, relation, routine, type, parameter, or grant authority through inheritance, SET ROLE, or ADMIN OPTION.',
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
  const ownsSchema = schemas.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsRoutine = routines.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsExtension = extensions.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsForeignDataWrapper = foreignDataWrappers.some(
    ({ owner }) => owner === snapshot.runtimeRole,
  );
  const ownsForeignServer = foreignServers.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsPublication = publications.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsSubscription = subscriptions.some(({ owner }) => owner === snapshot.runtimeRole);
  const ownsType = types.some(({ owner }) => owner === snapshot.runtimeRole);
  const inheritsOwnership = memberships.some(
    ({
      canInheritRole,
      databaseOwner = false,
      ownedExtensions = [],
      ownedForeignDataWrappers = [],
      ownedForeignServers = [],
      ownedPublications = [],
      ownedSubscriptions = [],
      ownedRelations,
      ownedRoutines,
      ownedSchemas,
      ownedTypes,
    }) =>
      canInheritRole &&
      (databaseOwner ||
        ownedExtensions.length > 0 ||
        ownedForeignDataWrappers.length > 0 ||
        ownedForeignServers.length > 0 ||
        ownedPublications.length > 0 ||
        ownedSubscriptions.length > 0 ||
        ownedRelations.length > 0 ||
        ownedRoutines.length > 0 ||
        ownedSchemas.length > 0 ||
        ownedTypes.length > 0),
  );
  const hasReachableDatabaseOwnership = memberships.some(
    ({ canAdministerRole, canInheritRole, canSetRole, databaseOwner = false }) =>
      databaseOwner && (canAdministerRole || canInheritRole || canSetRole),
  );
  if (
    snapshot.databasePrivileges.create ||
    snapshot.databasePrivileges.owner ||
    schemas.some(({ create }) => create) ||
    ownsRelation ||
    ownsRoutine ||
    ownsExtension ||
    ownsForeignDataWrapper ||
    ownsForeignServer ||
    ownsPublication ||
    ownsSubscription ||
    ownsSchema ||
    ownsType ||
    inheritsOwnership ||
    hasReachableDatabaseOwnership
  ) {
    findings.push({
      code: 'runtime_role_has_ddl_authority',
      evidence:
        'The runtime role has database/schema CREATE, direct/reachable ownership of the current database, or direct/inherited ownership of an audited extension, foreign-data wrapper or server, publication, subscription, schema, relation, routine, or application type.',
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
    ({
      executable,
      aggregateBindings = [],
      eventTriggerBindings,
      owner,
      operatorBindings = [],
      policyBindings,
      securityDefiner,
      storedExpressionBindings,
      triggerBindings,
    }) =>
      (executable ||
        aggregateBindings.length > 0 ||
        eventTriggerBindings.length > 0 ||
        operatorBindings.length > 0 ||
        policyBindings.length > 0 ||
        storedExpressionBindings.length > 0 ||
        triggerBindings.length > 0) &&
      securityDefiner &&
      owner !== snapshot.runtimeRole,
  );
  if (executableSecurityDefiners.length > 0) {
    findings.push({
      code: 'runtime_role_can_execute_security_definer',
      evidence:
        'The runtime role can directly execute, or invoke through an accessible operator, aggregate support path, applicable RLS policy, stored relation expression, DML rewrite rule, table DML trigger, or database event trigger, a SECURITY DEFINER routine owned by another role in an audited schema.',
      severity: 'high',
    });
  }
  const privilegedOwnerViews = tables.filter(
    ({
      kind,
      owner,
      ownerBypassRls,
      ownerContextRlsBypass,
      ownerSuperuser,
      privileges,
      securityInvoker,
    }) =>
      kind === 'view' &&
      (privileges.delete || privileges.insert || privileges.select || privileges.update) &&
      (ownerContextRlsBypass === true ||
        (securityInvoker !== true &&
          (owner === snapshot.administrativeRole ||
            ownerBypassRls === true ||
            ownerSuperuser === true))),
  );
  if (privilegedOwnerViews.length > 0) {
    findings.push({
      code: 'runtime_role_can_select_privileged_owner_view',
      evidence:
        'The runtime role can read or write a view whose outer or nested owner context is administrative, superuser, BYPASSRLS, or otherwise bypasses an unforced RLS relation.',
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
  if (
    grantOptions.some(({ source }) => source === 'direct') ||
    usableGrantableDefaultPrivileges.some(({ source }) => source === 'direct')
  ) {
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
    extensions,
    findings,
    foreignDataWrappers,
    foreignServers,
    grantOptions,
    memberships,
    parameterPrivileges,
    publications,
    routines,
    schemaVersion: 1,
    schemas,
    sequences,
    summary: {
      auditedSchemaCount: schemas.length,
      defaultPrivilegeCount: defaultPrivileges.length,
      dmlSchemaCount: dmlSchemas.size,
      dmlTableCount: dmlTables.length,
      extensionCount: extensions.length,
      findingCount: findings.length,
      foreignDataWrapperCount: foreignDataWrappers.length,
      foreignServerCount: foreignServers.length,
      grantOptionCount: grantOptions.length + usableGrantableDefaultPrivileges.length,
      parameterPrivilegeCount: parameterPrivileges.length,
      publicationCount: publications.length,
      privilegedOwnerViewCount: privilegedOwnerViews.length,
      routineCount: routines.length,
      securityDefinerExecutableCount: executableSecurityDefiners.length,
      sequenceCount: sequences.length,
      subscriptionCount: subscriptions.length,
      tableCount: tables.length,
      typeCount: types.length,
    },
    tables,
    subscriptions,
    types,
  };
};

interface RoleRow {
  readonly bypass_rls: boolean;
  readonly can_create_databases: boolean;
  readonly can_create_roles: boolean;
  readonly can_login: boolean;
  readonly inherit: boolean;
  readonly predefined_role: boolean;
  readonly replication: boolean;
  readonly superuser: boolean;
}

interface MembershipRow {
  readonly bypass_rls: boolean;
  readonly can_administer_role: boolean;
  readonly can_inherit_role: boolean;
  readonly can_set_role: boolean;
  readonly can_create_databases: boolean;
  readonly can_create_roles: boolean;
  readonly can_login: boolean;
  readonly create_schemas: string[];
  readonly database_create: boolean;
  readonly database_owner: boolean;
  readonly inherit: boolean;
  readonly owned_extensions: string[];
  readonly owned_foreign_data_wrappers: string[];
  readonly owned_foreign_servers: string[];
  readonly owned_publications: string[];
  readonly owned_subscriptions: string[];
  readonly owned_relations: string[];
  readonly owned_routines: string[];
  readonly owned_schemas: string[];
  readonly owned_types: string[];
  readonly parameter_privileges: string[];
  readonly predefined_role: boolean;
  readonly relation_privilege_schemas: string[];
  readonly replication: boolean;
  readonly role: string;
  readonly security_definer_policy_bindings: string[];
  readonly security_definer_routines: string[];
  readonly security_definer_aggregate_bindings: string[];
  readonly security_definer_event_trigger_bindings: string[];
  readonly security_definer_operator_bindings: string[];
  readonly security_definer_stored_expression_bindings: string[];
  readonly security_definer_trigger_bindings: string[];
  readonly superuser: boolean;
}

interface DatabaseTargetRow {
  readonly current_role: string;
  readonly database: string;
  readonly session_role: string;
  readonly server_address: string | null;
  readonly server_port: number | null;
}

interface DatabasePrivilegeRow {
  readonly connect: boolean;
  readonly create: boolean;
  readonly database: string;
  readonly owner: boolean;
  readonly temporary: boolean;
}

interface ExtensionOwnershipRow {
  readonly extension: string;
  readonly owner: string;
  readonly schema: string;
}

interface ForeignDataWrapperOwnershipRow {
  readonly owner: string;
  readonly wrapper: string;
}

interface ForeignServerOwnershipRow {
  readonly owner: string;
  readonly server: string;
}

interface PublicationOwnershipRow {
  readonly owner: string;
  readonly publication: string;
}

interface SubscriptionOwnershipRow {
  readonly owner: string;
  readonly subscription: string;
}

interface SchemaPrivilegeRow {
  readonly create: boolean;
  readonly owner: string;
  readonly schema: string;
  readonly usage: boolean;
}

interface RoutinePrivilegeRow {
  readonly aggregate_bindings: string[];
  readonly event_trigger_bindings: string[];
  readonly executable: boolean;
  readonly identity_arguments: string;
  readonly kind: 'aggregate' | 'function' | 'procedure' | 'window';
  readonly owner: string;
  readonly operator_bindings: string[];
  readonly policy_bindings: string[];
  readonly routine: string;
  readonly schema: string;
  readonly security_definer: boolean;
  readonly stored_expression_bindings: string[];
  readonly trigger_bindings: string[];
}

interface TablePrivilegeRow {
  readonly delete: boolean;
  readonly insert: boolean;
  readonly kind: 'foreign-table' | 'materialized-view' | 'partitioned-table' | 'table' | 'view';
  readonly owner: string;
  readonly owner_bypass_rls: boolean;
  readonly owner_context_rls_bypass: boolean;
  readonly owner_superuser: boolean;
  readonly maintain: boolean;
  readonly references: boolean;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly schema: string;
  readonly security_invoker: boolean;
  readonly select: boolean;
  readonly table: string;
  readonly trigger: boolean;
  readonly truncate: boolean;
  readonly update: boolean;
}

interface ParameterPrivilegeRow {
  readonly alter_system: boolean;
  readonly parameter: string;
  readonly set: boolean;
}

interface TypePrivilegeRow {
  readonly kind: 'base' | 'composite' | 'domain' | 'enum' | 'multirange' | 'range';
  readonly owner: string;
  readonly schema: string;
  readonly type: string;
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

interface GrantOptionRow {
  readonly grant_option: string;
  readonly role: string;
  readonly source: 'assumable' | 'direct';
}

interface SettingRow {
  readonly value: string | null;
}

export const hasTrustedContextValue = (value: string | null): boolean =>
  value !== null && value.length > 0;

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
  return {
    retainedAfterRollback: hasTrustedContextValue(after.rows[0]?.value ?? null),
    settable,
  };
};

export const reachableRolesCte = `reachable_roles(role_oid) as (
  select candidate.oid
  from pg_catalog.pg_roles as candidate
  where candidate.rolname = $1
     or pg_has_role($1, candidate.oid, 'SET')
  union
  select membership.roleid
  from pg_catalog.pg_auth_members as membership
  join reachable_roles as reachable on reachable.role_oid = membership.member
  where membership.admin_option or membership.set_option
)`;

export const storedExpressionDependenciesCte = `trigger_routine_dependencies(
  trigger_oid,
  routine_oid
) as (
  select distinct
    audited_trigger.oid,
    dependency.refobjid
  from pg_catalog.pg_trigger as audited_trigger
  join pg_catalog.pg_depend as dependency
    on dependency.classid = 'pg_catalog.pg_trigger'::regclass
   and dependency.objid = audited_trigger.oid
   and dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and dependency.deptype = 'n'
  where dependency.refobjid = audited_trigger.tgfoid
     or position(
       format(':funcid %s ', dependency.refobjid)
       in coalesce(audited_trigger.tgqual::text, '')
     ) > 0
),
aggregate_routine_dependencies(
  aggregate_oid,
  routine_oid,
  binding
) as (
  select
    aggregate.aggfnoid,
    support.routine_oid,
    support.binding
  from pg_catalog.pg_aggregate as aggregate
  cross join lateral (
    values
      (aggregate.aggtransfn, 'transition'::text),
      (aggregate.aggfinalfn, 'final'::text),
      (aggregate.aggcombinefn, 'combine'::text),
      (aggregate.aggserialfn, 'serialize'::text),
      (aggregate.aggdeserialfn, 'deserialize'::text),
      (aggregate.aggmtransfn, 'moving-transition'::text),
      (aggregate.aggminvtransfn, 'moving-inverse'::text),
      (aggregate.aggmfinalfn, 'moving-final'::text)
  ) as support(routine_oid, binding)
  where support.routine_oid <> 0
),
policy_routine_dependencies(
  policy_oid,
  routine_oid,
  used_by_using,
  used_by_with_check
) as (
  select
    policy.oid,
    dependency.refobjid,
    position(
      format(':funcid %s ', dependency.refobjid)
      in coalesce(policy.polqual::text, '')
    ) > 0,
    position(
      format(':funcid %s ', dependency.refobjid)
      in coalesce(policy.polwithcheck::text, '')
    ) > 0
    or (
      policy.polwithcheck is null
      and position(
        format(':funcid %s ', dependency.refobjid)
        in coalesce(policy.polqual::text, '')
      ) > 0
    )
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_depend as dependency
    on dependency.classid = 'pg_catalog.pg_policy'::regclass
   and dependency.objid = policy.oid
   and dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and dependency.deptype = 'n'
),
relation_invocation_paths(invocation_oid, dependency_oid) as (
  select relation.oid, relation.oid
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where relation.relkind in ('r', 'p', 'f')
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select ancestor.oid, relation.oid
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
  where relation.relkind in ('r', 'p', 'f')
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
),
view_invocation_paths(invocation_oid, dependency_oid) as (
  select relation.oid, relation.oid
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where relation.relkind = 'v'
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select invocation.invocation_oid, nested_view.oid
  from view_invocation_paths as invocation
  join pg_catalog.pg_rewrite as expression
    on expression.ev_class = invocation.dependency_oid
   and expression.rulename = '_RETURN'
  join pg_catalog.pg_depend as relation_dependency
    on relation_dependency.classid = 'pg_catalog.pg_rewrite'::regclass
   and relation_dependency.objid = expression.oid
   and relation_dependency.refclassid = 'pg_catalog.pg_class'::regclass
   and relation_dependency.deptype = 'n'
  join pg_catalog.pg_class as nested_view on nested_view.oid = relation_dependency.refobjid
  where nested_view.relkind = 'v'
    and nested_view.oid <> expression.ev_class
),
view_access_paths(invocation_oid, affected_oid, effective_owner_oid) as (
  select
    view_relation.oid,
    dependency.refobjid,
    case
      when coalesce(
        (
          select option.option_value::boolean
          from pg_catalog.pg_options_to_table(view_relation.reloptions) as option
          where option.option_name = 'security_invoker'
        ),
        false
      ) then null::oid
      else view_relation.relowner
    end
  from pg_catalog.pg_class as view_relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = view_relation.relnamespace
  join pg_catalog.pg_rewrite as rewrite
    on rewrite.ev_class = view_relation.oid
   and rewrite.rulename = '_RETURN'
  join pg_catalog.pg_depend as dependency
    on dependency.classid = 'pg_catalog.pg_rewrite'::regclass
   and dependency.objid = rewrite.oid
   and dependency.refclassid = 'pg_catalog.pg_class'::regclass
   and dependency.deptype = 'n'
  where view_relation.relkind = 'v'
    and dependency.refobjid <> view_relation.oid
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select
    path.invocation_oid,
    dependency.refobjid,
    case
      when coalesce(
        (
          select option.option_value::boolean
          from pg_catalog.pg_options_to_table(nested_view.reloptions) as option
          where option.option_name = 'security_invoker'
        ),
        false
      ) then path.effective_owner_oid
      else nested_view.relowner
    end
  from view_access_paths as path
  join pg_catalog.pg_class as nested_view
    on nested_view.oid = path.affected_oid
   and nested_view.relkind = 'v'
  join pg_catalog.pg_rewrite as rewrite
    on rewrite.ev_class = nested_view.oid
   and rewrite.rulename = '_RETURN'
  join pg_catalog.pg_depend as dependency
    on dependency.classid = 'pg_catalog.pg_rewrite'::regclass
   and dependency.objid = rewrite.oid
   and dependency.refclassid = 'pg_catalog.pg_class'::regclass
   and dependency.deptype = 'n'
  where dependency.refobjid <> nested_view.oid
),
direct_view_access_columns(
  invocation_oid,
  affected_oid,
  invocation_attnum,
  affected_attnum
) as (
  select distinct
    view_relation.oid,
    target.fields[2]::oid,
    target.fields[1]::smallint,
    target.fields[3]::smallint
  from pg_catalog.pg_class as view_relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = view_relation.relnamespace
  join pg_catalog.pg_rewrite as rewrite
    on rewrite.ev_class = view_relation.oid
   and rewrite.rulename = '_RETURN'
  cross join lateral unnest(
    string_to_array(
      split_part(
        (string_to_array(rewrite.ev_action::text, ':targetList ('))[
          cardinality(string_to_array(rewrite.ev_action::text, ':targetList ('))
        ],
        ':override',
        1
      ),
      '{TARGETENTRY'
    )
  ) as entry(value)
  cross join lateral regexp_match(
    entry.value,
    ':resno ([1-9][0-9]*).*:resorigtbl ([1-9][0-9]*) :resorigcol ([1-9][0-9]*).*:resjunk false'
  ) as target(fields)
  join pg_catalog.pg_class as affected_view
    on affected_view.oid = target.fields[2]::oid
   and affected_view.relkind = 'v'
  where view_relation.relkind = 'v'
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
),
view_access_columns(invocation_oid, affected_oid, invocation_attnum, affected_attnum) as (
  select *
  from direct_view_access_columns
  union
  select
    path.invocation_oid,
    nested.affected_oid,
    path.invocation_attnum,
    nested.affected_attnum
  from view_access_columns as path
  join direct_view_access_columns as nested
    on nested.invocation_oid = path.affected_oid
   and nested.invocation_attnum = path.affected_attnum
),
writable_view_rewrites(view_oid, affected_oid, actions, target_list, effective_owner_oid) as (
  select
    view_relation.oid,
    affected_relation.oid,
    pg_catalog.pg_relation_is_updatable(view_relation.oid::regclass, false) & 28,
    (string_to_array(rewrite.ev_action::text, ':targetList ('))[
      cardinality(string_to_array(rewrite.ev_action::text, ':targetList ('))
    ],
    case
      when coalesce(
        (
          select option.option_value::boolean
          from pg_catalog.pg_options_to_table(view_relation.reloptions) as option
          where option.option_name = 'security_invoker'
        ),
        false
      ) then null::oid
      else view_relation.relowner
    end
  from pg_catalog.pg_class as view_relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = view_relation.relnamespace
  join pg_catalog.pg_rewrite as rewrite
    on rewrite.ev_class = view_relation.oid
   and rewrite.rulename = '_RETURN'
  cross join lateral regexp_matches(
    split_part(rewrite.ev_action::text, ':rteperminfos', 1),
    ':relid ([1-9][0-9]*)',
    'g'
  ) as target(fields)
  join pg_catalog.pg_class as affected_relation on affected_relation.oid = target.fields[1]::oid
  where view_relation.relkind = 'v'
    and affected_relation.relkind in ('r', 'p', 'f', 'v')
    and affected_relation.oid <> view_relation.oid
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
    and pg_catalog.pg_relation_is_updatable(view_relation.oid::regclass, false) & 28 <> 0
),
direct_writable_view_paths(invocation_oid, affected_oid, actions, effective_owner_oid) as (
  select view_oid, affected_oid, actions, effective_owner_oid
  from writable_view_rewrites
),
direct_writable_view_columns(
  invocation_oid,
  affected_oid,
  invocation_attnum,
  affected_attnum,
  actions,
  effective_owner_oid
) as (
  select distinct
    rewrite.view_oid,
    rewrite.affected_oid,
    target.fields[1]::smallint,
    target.fields[3]::smallint,
    rewrite.actions,
    rewrite.effective_owner_oid
  from writable_view_rewrites as rewrite
  cross join lateral unnest(string_to_array(rewrite.target_list, '{TARGETENTRY')) as entry(value)
  cross join lateral (
    select regexp_match(
      entry.value,
      ':resno ([0-9]+).*:resorigtbl ([1-9][0-9]*) :resorigcol ([1-9][0-9]*).*:resjunk false'
    ) as fields
  ) as target
  where target.fields is not null
    and target.fields[2]::oid = rewrite.affected_oid
),
writable_view_paths(invocation_oid, affected_oid, actions, effective_owner_oid) as (
  select *
  from direct_writable_view_paths
  union
  select
    path.invocation_oid,
    nested.affected_oid,
    path.actions
      & nested.actions,
    coalesce(nested.effective_owner_oid, path.effective_owner_oid)
  from writable_view_paths as path
  join direct_writable_view_paths as nested on nested.invocation_oid = path.affected_oid
  where path.actions & nested.actions <> 0
),
writable_view_columns(
  invocation_oid,
  affected_oid,
  invocation_attnum,
  affected_attnum,
  actions,
  effective_owner_oid
) as (
  select *
  from direct_writable_view_columns
  union
  select
    path.invocation_oid,
    nested.affected_oid,
    path.invocation_attnum,
    nested.affected_attnum,
    path.actions
      & nested.actions,
    coalesce(nested.effective_owner_oid, path.effective_owner_oid)
  from writable_view_columns as path
  join direct_writable_view_columns as nested
    on nested.invocation_oid = path.affected_oid
   and nested.invocation_attnum = path.affected_attnum
  where path.actions & nested.actions <> 0
),
direct_dml_rule_write_paths(
  invocation_oid,
  invocation_action,
  affected_oid,
  affected_action,
  allowed_modes,
  effective_owner_oid
) as (
  select
    source_relation.oid,
    case rewrite.ev_type
      when '2' then 'UPDATE'::text
      when '3' then 'INSERT'::text
      when '4' then 'DELETE'::text
    end,
    target_relation.oid,
    case action.fields[1]
      when '2' then 'UPDATE'::text
      when '3' then 'INSERT'::text
      when '4' then 'DELETE'::text
    end,
    case rewrite.ev_enabled
      when 'O' then 1
      when 'R' then 2
      when 'A' then 3
    end,
    source_relation.relowner
  from pg_catalog.pg_rewrite as rewrite
  join pg_catalog.pg_class as source_relation on source_relation.oid = rewrite.ev_class
  join pg_catalog.pg_namespace as source_namespace
    on source_namespace.oid = source_relation.relnamespace
  cross join lateral regexp_matches(
    rewrite.ev_action::text,
    ':commandType ([234]).*?:resultRelation ([1-9][0-9]*).*?:rtable \\((.*?)\\) :rteperminfos',
    'g'
  ) as action(fields)
  cross join lateral regexp_match(
    (string_to_array(action.fields[3], '{RANGETBLENTRY'))[
      action.fields[2]::integer + 1
    ],
    ':rtekind 0 :relid ([1-9][0-9]*)'
  ) as target(fields)
  join pg_catalog.pg_class as target_relation on target_relation.oid = target.fields[1]::oid
  join pg_catalog.pg_namespace as target_namespace
    on target_namespace.oid = target_relation.relnamespace
  join pg_catalog.pg_roles as effective_owner on effective_owner.oid = source_relation.relowner
  where rewrite.rulename <> '_RETURN'
    and rewrite.ev_type in ('2', '3', '4')
    and rewrite.ev_enabled in ('O', 'A', 'R')
    and source_namespace.nspname !~ '^pg_'
    and source_namespace.nspname <> 'information_schema'
    and target_namespace.nspname !~ '^pg_'
    and target_namespace.nspname <> 'information_schema'
    and case action.fields[1]
      when '2' then
        has_table_privilege(effective_owner.oid, target_relation.oid, 'UPDATE')
        or has_any_column_privilege(effective_owner.oid, target_relation.oid, 'UPDATE')
      when '3' then
        has_table_privilege(effective_owner.oid, target_relation.oid, 'INSERT')
        or has_any_column_privilege(effective_owner.oid, target_relation.oid, 'INSERT')
      when '4' then has_table_privilege(effective_owner.oid, target_relation.oid, 'DELETE')
      else false
    end
),
dml_rule_write_paths(
  invocation_oid,
  invocation_action,
  affected_oid,
  affected_action,
  allowed_modes,
  effective_owner_oid,
  visited
) as (
  select
    path.invocation_oid,
    path.invocation_action,
    path.affected_oid,
    path.affected_action,
    path.allowed_modes,
    path.effective_owner_oid,
    array[format('%s:%s', path.invocation_oid, path.invocation_action),
      format('%s:%s', path.affected_oid, path.affected_action)]
  from direct_dml_rule_write_paths as path
  union all
  select
    path.invocation_oid,
    path.invocation_action,
    nested.affected_oid,
    nested.affected_action,
    path.allowed_modes & nested.allowed_modes,
    nested.effective_owner_oid,
    path.visited || format('%s:%s', nested.affected_oid, nested.affected_action)
  from dml_rule_write_paths as path
  join direct_dml_rule_write_paths as nested
    on nested.invocation_oid = path.affected_oid
   and nested.invocation_action = path.affected_action
  where path.allowed_modes & nested.allowed_modes <> 0
    and format('%s:%s', nested.affected_oid, nested.affected_action) <> all(path.visited)
),
stored_expression_dependencies(
  invocation_oid,
  relation_oid,
  routine_oid,
  binding,
  selectable,
  update_columns,
  select_columns
) as (
  select
    invocation.invocation_oid,
    expression.adrelid,
    routine_dependency.refobjid,
    case
      when attribute.attgenerated <> '' then format('generated-column:%I', attribute.attname)
      else format('column-default:%I', attribute.attname)
    end,
    false,
    case
      when attribute.attgenerated = '' then array[attribute.attnum]
      when exists (
        select 1
        from pg_catalog.pg_trigger as before_update_trigger
        where before_update_trigger.tgrelid = expression.adrelid
          and before_update_trigger.tgtype & 1 <> 0
          and before_update_trigger.tgtype & 2 <> 0
          and before_update_trigger.tgtype & 16 <> 0
      ) then array[]::smallint[]
      else array(
        select distinct column_dependency.refobjsubid::smallint
        from pg_catalog.pg_depend as column_dependency
        where column_dependency.classid = 'pg_catalog.pg_attrdef'::regclass
          and column_dependency.objid = expression.oid
          and column_dependency.refclassid = 'pg_catalog.pg_class'::regclass
          and column_dependency.refobjid = expression.adrelid
          and column_dependency.refobjsubid > 0
        order by column_dependency.refobjsubid::smallint
      )
    end,
    array[]::smallint[]
  from pg_catalog.pg_attrdef as expression
  join relation_invocation_paths as invocation on invocation.dependency_oid = expression.adrelid
  join pg_catalog.pg_attribute as attribute
    on attribute.attrelid = expression.adrelid
   and attribute.attnum = expression.adnum
  join pg_catalog.pg_class as relation on relation.oid = expression.adrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_depend as routine_dependency
    on routine_dependency.classid = 'pg_catalog.pg_attrdef'::regclass
   and routine_dependency.objid = expression.oid
   and routine_dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and routine_dependency.deptype = 'n'
  where namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
    and relation.relkind in ('r', 'p', 'f')
    and (attribute.attgenerated <> '' or invocation.invocation_oid = invocation.dependency_oid)
  union all
  select
    invocation.invocation_oid,
    expression.conrelid,
    routine_dependency.refobjid,
    format('check-constraint:%I', expression.conname),
    false,
    array[]::smallint[],
    array[]::smallint[]
  from pg_catalog.pg_constraint as expression
  join relation_invocation_paths as invocation on invocation.dependency_oid = expression.conrelid
  join pg_catalog.pg_class as relation on relation.oid = expression.conrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_depend as routine_dependency
    on routine_dependency.classid = 'pg_catalog.pg_constraint'::regclass
   and routine_dependency.objid = expression.oid
   and routine_dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and routine_dependency.deptype = 'n'
  where expression.contype = 'c'
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
    and relation.relkind in ('r', 'p', 'f')
  union all
  select
    invocation.invocation_oid,
    attribute.attrelid,
    routine_dependency.refobjid,
    format(
      'domain-constraint:%I.%I:%I',
      domain_namespace.nspname,
      domain_type.typname,
      expression.conname
    ),
    false,
    array[attribute.attnum],
    array[]::smallint[]
  from pg_catalog.pg_constraint as expression
  join pg_catalog.pg_type as domain_type on domain_type.oid = expression.contypid
  join pg_catalog.pg_namespace as domain_namespace
    on domain_namespace.oid = domain_type.typnamespace
  join pg_catalog.pg_attribute as attribute on attribute.atttypid = domain_type.oid
  join relation_invocation_paths as invocation on invocation.dependency_oid = attribute.attrelid
  join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_depend as routine_dependency
    on routine_dependency.classid = 'pg_catalog.pg_constraint'::regclass
   and routine_dependency.objid = expression.oid
   and routine_dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and routine_dependency.deptype = 'n'
  where expression.contype = 'c'
    and expression.contypid <> 0
    and attribute.attnum > 0
    and not attribute.attisdropped
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
    and relation.relkind in ('r', 'p', 'f')
  union all
  select
    invocation.invocation_oid,
    stored_index.indrelid,
    routine_dependency.refobjid,
    format('expression-index:%I', index_relation.relname),
    false,
    case
      when exists (
        select 1
        from pg_catalog.pg_trigger as before_update_trigger
        where before_update_trigger.tgrelid = stored_index.indrelid
          and before_update_trigger.tgtype & 1 <> 0
          and before_update_trigger.tgtype & 2 <> 0
          and before_update_trigger.tgtype & 16 <> 0
      ) then array[]::smallint[]
      else array(
        select distinct column_dependency.refobjsubid::smallint
        from pg_catalog.pg_depend as column_dependency
        where column_dependency.classid = 'pg_catalog.pg_class'::regclass
          and column_dependency.objid = stored_index.indexrelid
          and column_dependency.refclassid = 'pg_catalog.pg_class'::regclass
          and column_dependency.refobjid = stored_index.indrelid
          and column_dependency.refobjsubid > 0
        order by column_dependency.refobjsubid::smallint
      )
    end,
    array[]::smallint[]
  from pg_catalog.pg_index as stored_index
  join relation_invocation_paths as invocation on invocation.dependency_oid = stored_index.indrelid
  join pg_catalog.pg_class as index_relation on index_relation.oid = stored_index.indexrelid
  join pg_catalog.pg_class as relation on relation.oid = stored_index.indrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_depend as routine_dependency
    on routine_dependency.classid = 'pg_catalog.pg_class'::regclass
   and routine_dependency.objid = stored_index.indexrelid
   and routine_dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and routine_dependency.deptype = 'n'
  where (stored_index.indexprs is not null or stored_index.indpred is not null)
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union all
  select
    relation.oid,
    relation.oid,
    routine_dependency.refobjid,
    format(
      'dml-rule:%s:%s:%I',
      case expression.ev_type
        when '2' then 'UPDATE'
        when '3' then 'INSERT'
        when '4' then 'DELETE'
      end,
      expression.ev_enabled,
      expression.rulename
    ),
    false,
    array[]::smallint[],
    array[]::smallint[]
  from pg_catalog.pg_rewrite as expression
  join pg_catalog.pg_class as relation on relation.oid = expression.ev_class
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_depend as routine_dependency
    on routine_dependency.classid = 'pg_catalog.pg_rewrite'::regclass
   and routine_dependency.objid = expression.oid
   and routine_dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and routine_dependency.deptype = 'n'
  where expression.rulename <> '_RETURN'
    and expression.ev_type in ('2', '3', '4')
    and expression.ev_enabled in ('O', 'A', 'R')
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union all
  select
    invocation.invocation_oid,
    invocation.invocation_oid,
    routine_dependency.refobjid,
    case
      when invocation.invocation_oid = invocation.dependency_oid then 'view-expression'
      else format(
        'nested-view-expression:%I.%I',
        dependency_namespace.nspname,
        dependency_view.relname
      )
    end,
    true,
    array[]::smallint[],
    case
      when expression_routine.provolatile = 'v'
        or position(
          format(':funcid %s ', routine_dependency.refobjid)
          in split_part(expression.ev_action::text, ':targetList (', 1)
        ) > 0 then array[]::smallint[]
      else array(
        select distinct accessible.invocation_attnum
        from unnest(string_to_array(target_list.value, '{TARGETENTRY')) as entry(value)
        cross join lateral regexp_match(
          entry.value,
          ':resno ([1-9][0-9]*).*:resjunk false'
        ) as target(fields)
        cross join lateral (
          select target.fields[1]::smallint as invocation_attnum
          where invocation.invocation_oid = invocation.dependency_oid
          union
          select access.invocation_attnum
          from view_access_columns as access
          where invocation.invocation_oid <> invocation.dependency_oid
            and access.invocation_oid = invocation.invocation_oid
            and access.affected_oid = invocation.dependency_oid
            and access.affected_attnum = target.fields[1]::smallint
        ) as accessible
        where position(
          format(':funcid %s ', routine_dependency.refobjid)
          in entry.value
        ) > 0
        order by accessible.invocation_attnum
      )
    end
  from view_invocation_paths as invocation
  join pg_catalog.pg_class as dependency_view on dependency_view.oid = invocation.dependency_oid
  join pg_catalog.pg_namespace as dependency_namespace
    on dependency_namespace.oid = dependency_view.relnamespace
  join pg_catalog.pg_rewrite as expression
    on expression.ev_class = dependency_view.oid
   and expression.rulename = '_RETURN'
  cross join lateral (
    select split_part(
      (string_to_array(expression.ev_action::text, ':targetList ('))[
        cardinality(string_to_array(expression.ev_action::text, ':targetList ('))
      ],
      ':override',
      1
    ) as value
  ) as target_list
  join pg_catalog.pg_depend as routine_dependency
    on routine_dependency.classid = 'pg_catalog.pg_rewrite'::regclass
   and routine_dependency.objid = expression.oid
   and routine_dependency.refclassid = 'pg_catalog.pg_proc'::regclass
   and routine_dependency.deptype = 'n'
  join pg_catalog.pg_proc as expression_routine
    on expression_routine.oid = routine_dependency.refobjid
)`;

export const referentialWritePathsCte = `referential_write_paths(
  invocation_oid,
  invocation_relation_oid,
  invocation_action,
  invocation_columns,
  affected_oid,
  affected_action,
  affected_columns,
  affected_uses_default
) as (
  select
    invocation.invocation_oid,
    foreign_key.confrelid,
    action.invocation_action,
    case
      when action.invocation_action = 'UPDATE' then coalesce(foreign_key.confkey, array[]::smallint[])
      else array[]::smallint[]
    end,
    foreign_key.conrelid,
    action.affected_action,
    action.affected_columns,
    action.affected_uses_default
  from pg_catalog.pg_constraint as foreign_key
  join relation_invocation_paths as invocation
    on invocation.dependency_oid = foreign_key.confrelid
  cross join lateral (
    select
      'DELETE'::text as invocation_action,
      foreign_key.confdeltype as action_type,
      case when foreign_key.confdeltype = 'c' then 'DELETE'::text else 'UPDATE'::text end
        as affected_action,
      case
        when foreign_key.confdeltype = 'c' then array[]::smallint[]
        else coalesce(
          foreign_key.confdelsetcols,
          foreign_key.conkey,
          array[]::smallint[]
        )
      end as affected_columns,
      foreign_key.confdeltype = 'd' as affected_uses_default
    union all
    select
      'UPDATE'::text,
      foreign_key.confupdtype,
      'UPDATE'::text,
      coalesce(foreign_key.conkey, array[]::smallint[]),
      foreign_key.confupdtype = 'd'
  ) as action
  where foreign_key.contype = 'f'
    and action.action_type in ('c', 'n', 'd')
  union
  select
    path.invocation_oid,
    path.invocation_relation_oid,
    path.invocation_action,
    path.invocation_columns,
    foreign_key.conrelid,
    action.affected_action,
    action.affected_columns,
    action.affected_uses_default
  from referential_write_paths as path
  join pg_catalog.pg_constraint as foreign_key on foreign_key.confrelid = path.affected_oid
  cross join lateral (
    select
      foreign_key.confdeltype as action_type,
      case when foreign_key.confdeltype = 'c' then 'DELETE'::text else 'UPDATE'::text end
        as affected_action,
      case
        when foreign_key.confdeltype = 'c' then array[]::smallint[]
        else coalesce(
          foreign_key.confdelsetcols,
          foreign_key.conkey,
          array[]::smallint[]
        )
      end as affected_columns,
      foreign_key.confdeltype = 'd' as affected_uses_default
    where path.affected_action = 'DELETE'
    union all
    select
      foreign_key.confupdtype,
      'UPDATE'::text,
      coalesce(foreign_key.conkey, array[]::smallint[]),
      foreign_key.confupdtype = 'd'
    where path.affected_action = 'UPDATE'
  ) as action
  where foreign_key.contype = 'f'
    and action.action_type in ('c', 'n', 'd')
    and (
      path.affected_action = 'DELETE'
      or exists (
        select 1
        from unnest(path.affected_columns) as changed(attnum)
        where changed.attnum = any(coalesce(foreign_key.confkey, array[]::smallint[]))
      )
    )
)`;

export const roleDdlCommandTagsCte = `role_ddl_command_tags(role_oid, event, tag) as (
  select distinct
    role.oid,
    'ddl_command_start'::text,
    coalesce(configured_tag.name, 'ALTER DEFAULT PRIVILEGES'::text)
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_event_trigger as event_trigger
    on event_trigger.evtevent = 'ddl_command_start'
  left join lateral unnest(event_trigger.evttags) as configured_tag(name) on true
  union
  select role.oid, event.name, 'ALTER DEFAULT PRIVILEGES'::text
  from pg_catalog.pg_roles as role
  cross join (values ('ddl_command_start'::text), ('ddl_command_end'::text)) as event(name)
  union
  select role.oid, event.name, 'CREATE SCHEMA'::text
  from pg_catalog.pg_roles as role
  cross join (values ('ddl_command_start'::text), ('ddl_command_end'::text)) as event(name)
  where has_database_privilege(role.oid, current_database(), 'CREATE')
  union
  select role.oid, event.name, 'CREATE PUBLICATION'::text
  from pg_catalog.pg_roles as role
  cross join (values ('ddl_command_start'::text), ('ddl_command_end'::text)) as event(name)
  where has_database_privilege(role.oid, current_database(), 'CREATE')
  union
  select role.oid, event.name, command.tag
  from pg_catalog.pg_roles as role
  cross join (values ('ddl_command_start'::text), ('ddl_command_end'::text)) as event(name)
  cross join (
    values
      ('CREATE SEQUENCE'::text),
      ('CREATE TABLE'::text),
      ('CREATE VIEW'::text)
  ) as command(tag)
  where has_database_privilege(role.oid, current_database(), 'TEMPORARY')
  union
  select role.oid, event.name, command.tag
  from pg_catalog.pg_roles as role
  cross join (values ('ddl_command_start'::text), ('ddl_command_end'::text)) as event(name)
  cross join (
    values
      ('CREATE AGGREGATE'::text),
      ('CREATE COLLATION'::text),
      ('CREATE DOMAIN'::text),
      ('CREATE FUNCTION'::text),
      ('CREATE MATERIALIZED VIEW'::text),
      ('CREATE PROCEDURE'::text),
      ('CREATE SEQUENCE'::text),
      ('CREATE TABLE'::text),
      ('CREATE TYPE'::text),
      ('CREATE VIEW'::text)
  ) as command(tag)
  where exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    where namespace.nspname !~ '^pg_'
      and namespace.nspname <> 'information_schema'
      and has_schema_privilege(role.oid, namespace.oid, 'CREATE')
  )
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_class as relation
    on pg_has_role(role.oid, relation.relowner, 'USAGE')
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  cross join lateral (
    values
      ('r'::"char", 'ddl_command_start'::text, 'ALTER TABLE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'ALTER TABLE'::text),
      ('r'::"char", 'table_rewrite'::text, 'ALTER TABLE'::text),
      ('r'::"char", 'ddl_command_start'::text, 'DROP TABLE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'DROP TABLE'::text),
      ('r'::"char", 'sql_drop'::text, 'DROP TABLE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'CREATE INDEX'::text),
      ('r'::"char", 'ddl_command_end'::text, 'CREATE POLICY'::text),
      ('r'::"char", 'ddl_command_end'::text, 'ALTER POLICY'::text),
      ('r'::"char", 'ddl_command_end'::text, 'DROP POLICY'::text),
      ('r'::"char", 'sql_drop'::text, 'DROP POLICY'::text),
      ('r'::"char", 'ddl_command_end'::text, 'CREATE RULE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'DROP RULE'::text),
      ('r'::"char", 'sql_drop'::text, 'DROP RULE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'CREATE TRIGGER'::text),
      ('r'::"char", 'ddl_command_end'::text, 'ALTER TRIGGER'::text),
      ('r'::"char", 'ddl_command_end'::text, 'DROP TRIGGER'::text),
      ('r'::"char", 'sql_drop'::text, 'DROP TRIGGER'::text),
      ('r'::"char", 'ddl_command_end'::text, 'COMMENT'::text),
      ('r'::"char", 'ddl_command_end'::text, 'SECURITY LABEL'::text),
      ('r'::"char", 'ddl_command_end'::text, 'REINDEX'::text),
      ('p'::"char", 'ddl_command_start'::text, 'ALTER TABLE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'ALTER TABLE'::text),
      ('p'::"char", 'table_rewrite'::text, 'ALTER TABLE'::text),
      ('p'::"char", 'ddl_command_start'::text, 'DROP TABLE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'DROP TABLE'::text),
      ('p'::"char", 'sql_drop'::text, 'DROP TABLE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'CREATE INDEX'::text),
      ('p'::"char", 'ddl_command_end'::text, 'CREATE POLICY'::text),
      ('p'::"char", 'ddl_command_end'::text, 'ALTER POLICY'::text),
      ('p'::"char", 'ddl_command_end'::text, 'DROP POLICY'::text),
      ('p'::"char", 'sql_drop'::text, 'DROP POLICY'::text),
      ('p'::"char", 'ddl_command_end'::text, 'CREATE RULE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'DROP RULE'::text),
      ('p'::"char", 'sql_drop'::text, 'DROP RULE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'CREATE TRIGGER'::text),
      ('p'::"char", 'ddl_command_end'::text, 'ALTER TRIGGER'::text),
      ('p'::"char", 'ddl_command_end'::text, 'DROP TRIGGER'::text),
      ('p'::"char", 'sql_drop'::text, 'DROP TRIGGER'::text),
      ('p'::"char", 'ddl_command_end'::text, 'COMMENT'::text),
      ('p'::"char", 'ddl_command_end'::text, 'SECURITY LABEL'::text),
      ('p'::"char", 'ddl_command_end'::text, 'REINDEX'::text),
      ('f'::"char", 'ddl_command_start'::text, 'ALTER FOREIGN TABLE'::text),
      ('f'::"char", 'ddl_command_end'::text, 'ALTER FOREIGN TABLE'::text),
      ('f'::"char", 'ddl_command_start'::text, 'DROP FOREIGN TABLE'::text),
      ('f'::"char", 'ddl_command_end'::text, 'DROP FOREIGN TABLE'::text),
      ('f'::"char", 'sql_drop'::text, 'DROP FOREIGN TABLE'::text),
      ('f'::"char", 'ddl_command_end'::text, 'CREATE TRIGGER'::text),
      ('f'::"char", 'ddl_command_end'::text, 'ALTER TRIGGER'::text),
      ('f'::"char", 'ddl_command_end'::text, 'DROP TRIGGER'::text),
      ('f'::"char", 'sql_drop'::text, 'DROP TRIGGER'::text),
      ('f'::"char", 'ddl_command_end'::text, 'COMMENT'::text),
      ('f'::"char", 'ddl_command_end'::text, 'SECURITY LABEL'::text),
      ('v'::"char", 'ddl_command_start'::text, 'ALTER VIEW'::text),
      ('v'::"char", 'ddl_command_end'::text, 'ALTER VIEW'::text),
      ('v'::"char", 'ddl_command_start'::text, 'DROP VIEW'::text),
      ('v'::"char", 'ddl_command_end'::text, 'DROP VIEW'::text),
      ('v'::"char", 'sql_drop'::text, 'DROP VIEW'::text),
      ('v'::"char", 'ddl_command_end'::text, 'CREATE RULE'::text),
      ('v'::"char", 'ddl_command_end'::text, 'DROP RULE'::text),
      ('v'::"char", 'sql_drop'::text, 'DROP RULE'::text),
      ('v'::"char", 'ddl_command_end'::text, 'CREATE TRIGGER'::text),
      ('v'::"char", 'ddl_command_end'::text, 'ALTER TRIGGER'::text),
      ('v'::"char", 'ddl_command_end'::text, 'DROP TRIGGER'::text),
      ('v'::"char", 'sql_drop'::text, 'DROP TRIGGER'::text),
      ('v'::"char", 'ddl_command_end'::text, 'COMMENT'::text),
      ('v'::"char", 'ddl_command_end'::text, 'SECURITY LABEL'::text),
      ('m'::"char", 'ddl_command_start'::text, 'ALTER MATERIALIZED VIEW'::text),
      ('m'::"char", 'ddl_command_end'::text, 'ALTER MATERIALIZED VIEW'::text),
      ('m'::"char", 'table_rewrite'::text, 'ALTER MATERIALIZED VIEW'::text),
      ('m'::"char", 'ddl_command_start'::text, 'DROP MATERIALIZED VIEW'::text),
      ('m'::"char", 'ddl_command_end'::text, 'DROP MATERIALIZED VIEW'::text),
      ('m'::"char", 'sql_drop'::text, 'DROP MATERIALIZED VIEW'::text),
      ('m'::"char", 'ddl_command_end'::text, 'CREATE INDEX'::text),
      ('m'::"char", 'ddl_command_end'::text, 'REFRESH MATERIALIZED VIEW'::text),
      ('m'::"char", 'ddl_command_end'::text, 'COMMENT'::text),
      ('m'::"char", 'ddl_command_end'::text, 'SECURITY LABEL'::text),
      ('m'::"char", 'ddl_command_end'::text, 'REINDEX'::text),
      ('S'::"char", 'ddl_command_start'::text, 'ALTER SEQUENCE'::text),
      ('S'::"char", 'ddl_command_end'::text, 'ALTER SEQUENCE'::text),
      ('S'::"char", 'ddl_command_start'::text, 'DROP SEQUENCE'::text),
      ('S'::"char", 'ddl_command_end'::text, 'DROP SEQUENCE'::text),
      ('S'::"char", 'sql_drop'::text, 'DROP SEQUENCE'::text),
      ('S'::"char", 'ddl_command_end'::text, 'COMMENT'::text),
      ('S'::"char", 'ddl_command_end'::text, 'SECURITY LABEL'::text)
  ) as command(relkind, event, tag)
  where relation.relkind = command.relkind
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select role.oid, 'ddl_command_end'::text, 'CREATE TRIGGER'::text
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_class as relation
    on relation.relkind in ('r', 'p', 'f', 'v')
   and has_table_privilege(role.oid, relation.oid, 'TRIGGER')
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
    and has_schema_privilege(role.oid, namespace.oid, 'USAGE')
    and exists (
      select 1
      from pg_catalog.pg_proc as trigger_routine
      join pg_catalog.pg_namespace as routine_namespace
        on routine_namespace.oid = trigger_routine.pronamespace
      where trigger_routine.prorettype = 'pg_catalog.trigger'::regtype
        and has_function_privilege(role.oid, trigger_routine.oid, 'EXECUTE')
        and has_schema_privilege(role.oid, routine_namespace.oid, 'USAGE')
    )
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_proc as routine
    on pg_has_role(role.oid, routine.proowner, 'USAGE')
  join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
  cross join lateral (
    values
      ('a'::"char", 'ddl_command_start'::text, 'ALTER AGGREGATE'::text),
      ('a'::"char", 'ddl_command_end'::text, 'ALTER AGGREGATE'::text),
      ('a'::"char", 'ddl_command_start'::text, 'DROP AGGREGATE'::text),
      ('a'::"char", 'ddl_command_end'::text, 'DROP AGGREGATE'::text),
      ('a'::"char", 'sql_drop'::text, 'DROP AGGREGATE'::text),
      ('f'::"char", 'ddl_command_start'::text, 'ALTER FUNCTION'::text),
      ('f'::"char", 'ddl_command_end'::text, 'ALTER FUNCTION'::text),
      ('f'::"char", 'ddl_command_start'::text, 'DROP FUNCTION'::text),
      ('f'::"char", 'ddl_command_end'::text, 'DROP FUNCTION'::text),
      ('f'::"char", 'sql_drop'::text, 'DROP FUNCTION'::text),
      ('p'::"char", 'ddl_command_start'::text, 'ALTER PROCEDURE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'ALTER PROCEDURE'::text),
      ('p'::"char", 'ddl_command_start'::text, 'DROP PROCEDURE'::text),
      ('p'::"char", 'ddl_command_end'::text, 'DROP PROCEDURE'::text),
      ('p'::"char", 'sql_drop'::text, 'DROP PROCEDURE'::text),
      ('w'::"char", 'ddl_command_start'::text, 'ALTER FUNCTION'::text),
      ('w'::"char", 'ddl_command_end'::text, 'ALTER FUNCTION'::text),
      ('w'::"char", 'ddl_command_start'::text, 'DROP FUNCTION'::text),
      ('w'::"char", 'ddl_command_end'::text, 'DROP FUNCTION'::text),
      ('w'::"char", 'sql_drop'::text, 'DROP FUNCTION'::text)
  ) as command(prokind, event, tag)
  where routine.prokind = command.prokind
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_type as type on pg_has_role(role.oid, type.typowner, 'USAGE')
  join pg_catalog.pg_namespace as namespace on namespace.oid = type.typnamespace
  cross join lateral (
    values
      ('d'::"char", 'ddl_command_start'::text, 'ALTER DOMAIN'::text),
      ('d'::"char", 'ddl_command_end'::text, 'ALTER DOMAIN'::text),
      ('d'::"char", 'table_rewrite'::text, 'ALTER DOMAIN'::text),
      ('d'::"char", 'ddl_command_start'::text, 'DROP DOMAIN'::text),
      ('d'::"char", 'ddl_command_end'::text, 'DROP DOMAIN'::text),
      ('d'::"char", 'sql_drop'::text, 'DROP DOMAIN'::text),
      ('e'::"char", 'ddl_command_start'::text, 'ALTER TYPE'::text),
      ('e'::"char", 'ddl_command_end'::text, 'ALTER TYPE'::text),
      ('e'::"char", 'table_rewrite'::text, 'ALTER TYPE'::text),
      ('e'::"char", 'ddl_command_start'::text, 'DROP TYPE'::text),
      ('e'::"char", 'ddl_command_end'::text, 'DROP TYPE'::text),
      ('e'::"char", 'sql_drop'::text, 'DROP TYPE'::text),
      ('r'::"char", 'ddl_command_start'::text, 'ALTER TYPE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'ALTER TYPE'::text),
      ('r'::"char", 'table_rewrite'::text, 'ALTER TYPE'::text),
      ('r'::"char", 'ddl_command_start'::text, 'DROP TYPE'::text),
      ('r'::"char", 'ddl_command_end'::text, 'DROP TYPE'::text),
      ('r'::"char", 'sql_drop'::text, 'DROP TYPE'::text),
      ('m'::"char", 'ddl_command_start'::text, 'ALTER TYPE'::text),
      ('m'::"char", 'ddl_command_end'::text, 'ALTER TYPE'::text),
      ('m'::"char", 'table_rewrite'::text, 'ALTER TYPE'::text),
      ('m'::"char", 'ddl_command_start'::text, 'DROP TYPE'::text),
      ('m'::"char", 'ddl_command_end'::text, 'DROP TYPE'::text),
      ('m'::"char", 'sql_drop'::text, 'DROP TYPE'::text)
  ) as command(typtype, event, tag)
  where type.typtype = command.typtype
    and type.typrelid = 0
    and namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_namespace as namespace
    on pg_has_role(role.oid, namespace.nspowner, 'USAGE')
  cross join lateral (
    values
      ('ddl_command_start'::text, 'ALTER SCHEMA'::text),
      ('ddl_command_end'::text, 'ALTER SCHEMA'::text),
      ('ddl_command_start'::text, 'DROP SCHEMA'::text),
      ('ddl_command_end'::text, 'DROP SCHEMA'::text),
      ('sql_drop'::text, 'DROP SCHEMA'::text)
  ) as command(event, tag)
  where namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_publication as publication
    on pg_has_role(role.oid, publication.pubowner, 'USAGE')
  cross join lateral (
    values
      ('ddl_command_start'::text, 'ALTER PUBLICATION'::text),
      ('ddl_command_end'::text, 'ALTER PUBLICATION'::text),
      ('ddl_command_start'::text, 'DROP PUBLICATION'::text),
      ('ddl_command_end'::text, 'DROP PUBLICATION'::text),
      ('sql_drop'::text, 'DROP PUBLICATION'::text)
  ) as command(event, tag)
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_subscription as subscription
    on pg_has_role(role.oid, subscription.subowner, 'USAGE')
  cross join lateral (
    values
      ('ddl_command_start'::text, 'ALTER SUBSCRIPTION'::text),
      ('ddl_command_end'::text, 'ALTER SUBSCRIPTION'::text),
      ('ddl_command_start'::text, 'DROP SUBSCRIPTION'::text),
      ('ddl_command_end'::text, 'DROP SUBSCRIPTION'::text),
      ('sql_drop'::text, 'DROP SUBSCRIPTION'::text)
  ) as command(event, tag)
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_extension as extension
    on pg_has_role(role.oid, extension.extowner, 'USAGE')
  cross join lateral (
    values
      ('ddl_command_start'::text, 'ALTER EXTENSION'::text),
      ('ddl_command_end'::text, 'ALTER EXTENSION'::text),
      ('ddl_command_start'::text, 'DROP EXTENSION'::text),
      ('ddl_command_end'::text, 'DROP EXTENSION'::text),
      ('sql_drop'::text, 'DROP EXTENSION'::text)
  ) as command(event, tag)
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_foreign_data_wrapper as foreign_data_wrapper
    on pg_has_role(role.oid, foreign_data_wrapper.fdwowner, 'USAGE')
  cross join lateral (
    values
      ('ddl_command_start'::text, 'ALTER FOREIGN DATA WRAPPER'::text),
      ('ddl_command_end'::text, 'ALTER FOREIGN DATA WRAPPER'::text),
      ('ddl_command_start'::text, 'DROP FOREIGN DATA WRAPPER'::text),
      ('ddl_command_end'::text, 'DROP FOREIGN DATA WRAPPER'::text),
      ('sql_drop'::text, 'DROP FOREIGN DATA WRAPPER'::text)
  ) as command(event, tag)
  union
  select role.oid, command.event, command.tag
  from pg_catalog.pg_roles as role
  join pg_catalog.pg_foreign_server as foreign_server
    on pg_has_role(role.oid, foreign_server.srvowner, 'USAGE')
  cross join lateral (
    values
      ('ddl_command_start'::text, 'ALTER SERVER'::text),
      ('ddl_command_end'::text, 'ALTER SERVER'::text),
      ('ddl_command_start'::text, 'DROP SERVER'::text),
      ('ddl_command_end'::text, 'DROP SERVER'::text),
      ('sql_drop'::text, 'DROP SERVER'::text)
  ) as command(event, tag)
  union
  select role.oid, event.name, command.tag
  from pg_catalog.pg_roles as role
  cross join (values ('ddl_command_start'::text), ('ddl_command_end'::text)) as event(name)
  cross join (values ('GRANT'::text), ('REVOKE'::text)) as command(tag)
  where exists (
      select 1
      from pg_catalog.pg_database as database
      where database.datname = current_database()
        and (
          pg_has_role(role.oid, database.datdba, 'USAGE')
          or has_database_privilege(role.oid, database.oid, 'CONNECT WITH GRANT OPTION')
          or has_database_privilege(role.oid, database.oid, 'CREATE WITH GRANT OPTION')
          or has_database_privilege(role.oid, database.oid, 'TEMPORARY WITH GRANT OPTION')
        )
    )
    or exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      where pg_has_role(role.oid, namespace.nspowner, 'USAGE')
         or has_schema_privilege(role.oid, namespace.oid, 'CREATE WITH GRANT OPTION')
         or has_schema_privilege(role.oid, namespace.oid, 'USAGE WITH GRANT OPTION')
    )
    or exists (
      select 1
      from pg_catalog.pg_class as relation
      where pg_has_role(role.oid, relation.relowner, 'USAGE')
         or has_table_privilege(role.oid, relation.oid, 'SELECT WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'INSERT WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'UPDATE WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'DELETE WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'TRUNCATE WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'REFERENCES WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'TRIGGER WITH GRANT OPTION')
         or has_table_privilege(role.oid, relation.oid, 'MAINTAIN WITH GRANT OPTION')
         or (
           relation.relkind = 'S'
           and (
             has_sequence_privilege(role.oid, relation.oid, 'USAGE WITH GRANT OPTION')
             or has_sequence_privilege(role.oid, relation.oid, 'SELECT WITH GRANT OPTION')
             or has_sequence_privilege(role.oid, relation.oid, 'UPDATE WITH GRANT OPTION')
           )
         )
    )
    or exists (
      select 1
      from pg_catalog.pg_attribute as attribute
      where attribute.attnum > 0
        and not attribute.attisdropped
        and (
          has_column_privilege(role.oid, attribute.attrelid, attribute.attnum, 'SELECT WITH GRANT OPTION')
          or has_column_privilege(role.oid, attribute.attrelid, attribute.attnum, 'INSERT WITH GRANT OPTION')
          or has_column_privilege(role.oid, attribute.attrelid, attribute.attnum, 'UPDATE WITH GRANT OPTION')
          or has_column_privilege(role.oid, attribute.attrelid, attribute.attnum, 'REFERENCES WITH GRANT OPTION')
        )
    )
    or exists (
      select 1
      from pg_catalog.pg_proc as routine
      where pg_has_role(role.oid, routine.proowner, 'USAGE')
         or has_function_privilege(role.oid, routine.oid, 'EXECUTE WITH GRANT OPTION')
    )
    or exists (
      select 1
      from pg_catalog.pg_type as type
      where pg_has_role(role.oid, type.typowner, 'USAGE')
         or has_type_privilege(role.oid, type.oid, 'USAGE WITH GRANT OPTION')
    )
    or exists (
      select 1
      from pg_catalog.pg_parameter_acl as parameter
      where has_parameter_privilege(role.oid, parameter.parname, 'SET WITH GRANT OPTION')
         or has_parameter_privilege(
           role.oid,
           parameter.parname,
           'ALTER SYSTEM WITH GRANT OPTION'
         )
    )
    or exists (
      select 1
      from pg_catalog.pg_language as language
      where pg_has_role(role.oid, language.lanowner, 'USAGE')
         or has_language_privilege(role.oid, language.oid, 'USAGE WITH GRANT OPTION')
    )
    or exists (
      select 1
      from pg_catalog.pg_foreign_data_wrapper as wrapper
      where pg_has_role(role.oid, wrapper.fdwowner, 'USAGE')
         or has_foreign_data_wrapper_privilege(
           role.oid,
           wrapper.oid,
           'USAGE WITH GRANT OPTION'
         )
    )
    or exists (
      select 1
      from pg_catalog.pg_foreign_server as server
      where pg_has_role(role.oid, server.srvowner, 'USAGE')
         or has_server_privilege(role.oid, server.oid, 'USAGE WITH GRANT OPTION')
    )
    or exists (
      select 1
      from pg_catalog.pg_tablespace as tablespace
      where pg_has_role(role.oid, tablespace.spcowner, 'USAGE')
         or has_tablespace_privilege(role.oid, tablespace.oid, 'CREATE WITH GRANT OPTION')
    )
)`;

const collectSnapshot = async (
  admin: Client,
  runtime: Client,
): Promise<DatabaseTrustBoundarySnapshot> => {
  const targetQuery = `select
    current_user::text as current_role,
    current_database() as database,
    session_user::text as session_role,
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
  const administrativeEndpoint = getEffectiveDatabaseEndpoint(admin);
  const runtimeEndpoint = getEffectiveDatabaseEndpoint(runtime);
  assertSameDatabaseTarget(
    {
      ...administrativeEndpoint,
      database: administrativeTargetRow.database,
      serverAddress: administrativeTargetRow.server_address,
      serverPort: administrativeTargetRow.server_port,
    },
    {
      ...runtimeEndpoint,
      database: runtimeTargetRow.database,
      serverAddress: runtimeTargetRow.server_address,
      serverPort: runtimeTargetRow.server_port,
    },
  );
  assertDatabaseSessionIdentities(
    {
      currentRole: administrativeTargetRow.current_role,
      sessionRole: administrativeTargetRow.session_role,
    },
    {
      currentRole: runtimeTargetRow.current_role,
      sessionRole: runtimeTargetRow.session_role,
    },
  );
  const administrativeRole = administrativeTargetRow.session_role;
  const runtimeRole = runtimeTargetRow.session_role;

  const role = await admin.query<RoleRow>(
    `select
       rolbypassrls as bypass_rls,
       rolcreatedb as can_create_databases,
       rolcreaterole as can_create_roles,
       rolcanlogin as can_login,
       rolinherit as inherit,
       rolname ~ '^pg_' as predefined_role,
       rolreplication as replication,
       rolsuper as superuser
     from pg_catalog.pg_roles
     where rolname = $1`,
    [runtimeRole],
  );
  const roleRow = role.rows[0];
  if (roleRow === undefined) throw new Error('runtime role is absent');

  const memberships = await admin.query<MembershipRow>(
    `with recursive ${reachableRolesCte},
     ${storedExpressionDependenciesCte},
     ${referentialWritePathsCte},
     ${roleDdlCommandTagsCte},
     administrable_roles(role_oid) as (
       select distinct membership.roleid
       from pg_catalog.pg_auth_members as membership
       join reachable_roles as reachable on reachable.role_oid = membership.member
       where membership.admin_option
     )
     select
       candidate.rolname as role,
       candidate.oid in (select role_oid from reachable_roles) as can_set_role,
       pg_has_role($1, candidate.oid, 'USAGE') as can_inherit_role,
       candidate.oid in (select role_oid from administrable_roles) as can_administer_role,
       candidate.oid = (
         select database.datdba
         from pg_catalog.pg_database as database
         where database.datname = current_database()
       ) as database_owner,
       candidate.rolbypassrls as bypass_rls,
       candidate.rolcreatedb as can_create_databases,
       candidate.rolcreaterole as can_create_roles,
       candidate.rolcanlogin as can_login,
       has_database_privilege(candidate.oid, current_database(), 'CREATE') as database_create,
       candidate.rolinherit as inherit,
       candidate.rolreplication as replication,
       candidate.rolsuper as superuser,
       candidate.rolname ~ '^pg_' as predefined_role,
       array(
         select format('%s:%s', parameter.parname, privilege.name)
         from pg_catalog.pg_parameter_acl as parameter
         cross join (
           values ('ALTER SYSTEM'::text), ('SET'::text)
         ) as privilege(name)
         where has_parameter_privilege(candidate.oid, parameter.parname, privilege.name)
         order by parameter.parname, privilege.name
       ) as parameter_privileges,
       array(
         select extension.extname
         from pg_catalog.pg_extension as extension
         where extension.extowner = candidate.oid
         order by extension.extname
       ) as owned_extensions,
       array(
         select foreign_data_wrapper.fdwname
         from pg_catalog.pg_foreign_data_wrapper as foreign_data_wrapper
         where foreign_data_wrapper.fdwowner = candidate.oid
         order by foreign_data_wrapper.fdwname
       ) as owned_foreign_data_wrappers,
       array(
         select foreign_server.srvname
         from pg_catalog.pg_foreign_server as foreign_server
         where foreign_server.srvowner = candidate.oid
         order by foreign_server.srvname
       ) as owned_foreign_servers,
       array(
         select publication.pubname
         from pg_catalog.pg_publication as publication
         where publication.pubowner = candidate.oid
         order by publication.pubname
       ) as owned_publications,
       array(
         select subscription.subname
         from pg_catalog.pg_subscription as subscription
         where subscription.subowner = candidate.oid
         order by subscription.subname
       ) as owned_subscriptions,
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
         select format('%I.%I', namespace.nspname, owned_type.typname)
         from pg_catalog.pg_type as owned_type
         join pg_catalog.pg_namespace as namespace on namespace.oid = owned_type.typnamespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and (
             owned_type.typtype in ('d', 'e', 'm', 'r')
             or (owned_type.typtype = 'b' and owned_type.typelem = 0)
             or (
               owned_type.typtype = 'c'
               and exists (
                 select 1
                 from pg_catalog.pg_class as composite_relation
                 where composite_relation.reltype = owned_type.oid
                   and composite_relation.relkind = 'c'
               )
             )
           )
           and owned_type.typowner = candidate.oid
         order by namespace.nspname, owned_type.typname
       ) as owned_types,
       array(
         select distinct namespace.nspname
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
         where namespace.nspname !~ '^pg_'
           and namespace.nspname <> 'information_schema'
           and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
           and has_schema_privilege(candidate.oid, namespace.oid, 'USAGE')
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
               or has_table_privilege(candidate.oid, relation.oid, 'MAINTAIN')
           end
         order by namespace.nspname
       ) as relation_privilege_schemas,
       array(
         select distinct format(
           '%I.%I:%I->%I.%I(%s)',
           relation_namespace.nspname,
           relation.relname,
           policy.polname,
           routine_namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from pg_catalog.pg_policy as policy
         join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
         join pg_catalog.pg_namespace as relation_namespace
           on relation_namespace.oid = relation.relnamespace
         join policy_routine_dependencies as dependency
           on dependency.policy_oid = policy.oid
         join pg_catalog.pg_proc as routine on routine.oid = dependency.routine_oid
         join pg_catalog.pg_namespace as routine_namespace
           on routine_namespace.oid = routine.pronamespace
         where relation.relrowsecurity
           and relation_namespace.nspname !~ '^pg_'
           and relation_namespace.nspname <> 'information_schema'
           and routine_namespace.nspname !~ '^pg_'
           and routine_namespace.nspname <> 'information_schema'
           and routine.prosecdef
           and routine.proowner <> candidate.oid
           and (
             (
               has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
               and has_schema_privilege(candidate.oid, relation_namespace.oid, 'USAGE')
               and not candidate.rolbypassrls
               and not candidate.rolsuper
               and (
                 relation.relforcerowsecurity
                 or not pg_has_role(candidate.oid, relation.relowner, 'USAGE')
               )
               and (
                 0::oid = any(policy.polroles)
                 or exists (
                   select 1
                   from unnest(policy.polroles) as policy_role(oid)
                   where policy_role.oid <> 0
                     and (
                       policy_role.oid = candidate.oid
                       or pg_has_role(candidate.oid, policy_role.oid, 'MEMBER')
                     )
                 )
               )
               and case policy.polcmd
                 when 'r' then
                   dependency.used_by_using
                   and (
                     has_table_privilege(candidate.oid, relation.oid, 'SELECT')
                     or has_any_column_privilege(candidate.oid, relation.oid, 'SELECT')
                   )
                 when 'a' then
                   dependency.used_by_with_check
                   and (
                     has_table_privilege(candidate.oid, relation.oid, 'INSERT')
                     or has_any_column_privilege(candidate.oid, relation.oid, 'INSERT')
                   )
                 when 'w' then
                   (dependency.used_by_using or dependency.used_by_with_check)
                   and (
                     has_table_privilege(candidate.oid, relation.oid, 'UPDATE')
                     or has_any_column_privilege(candidate.oid, relation.oid, 'UPDATE')
                   )
                 when 'd' then
                   dependency.used_by_using
                   and has_table_privilege(candidate.oid, relation.oid, 'DELETE')
                 when '*' then
                   (
                     dependency.used_by_using
                     and (
                       has_table_privilege(candidate.oid, relation.oid, 'SELECT')
                       or has_any_column_privilege(candidate.oid, relation.oid, 'SELECT')
                       or has_table_privilege(candidate.oid, relation.oid, 'UPDATE')
                       or has_any_column_privilege(candidate.oid, relation.oid, 'UPDATE')
                       or has_table_privilege(candidate.oid, relation.oid, 'DELETE')
                     )
                   )
                   or (
                     dependency.used_by_with_check
                     and (
                       has_table_privilege(candidate.oid, relation.oid, 'INSERT')
                       or has_any_column_privilege(candidate.oid, relation.oid, 'INSERT')
                       or has_table_privilege(candidate.oid, relation.oid, 'UPDATE')
                       or has_any_column_privilege(candidate.oid, relation.oid, 'UPDATE')
                     )
                   )
                 else false
               end
             )
             or exists (
               select 1
               from view_access_paths as view_access
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = view_access.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   view_access.effective_owner_oid,
                   candidate.oid
                 )
               where view_access.affected_oid = relation.oid
                 and policy.polcmd in ('r', '*')
                 and dependency.used_by_using
                 and has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
                 and (
                   has_table_privilege(candidate.oid, invocation_view.oid, 'SELECT')
                   or has_any_column_privilege(candidate.oid, invocation_view.oid, 'SELECT')
                 )
                 and (
                   has_table_privilege(effective_owner.oid, relation.oid, 'SELECT')
                   or has_any_column_privilege(effective_owner.oid, relation.oid, 'SELECT')
                 )
                 and has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
                 and not effective_owner.rolbypassrls
                 and not effective_owner.rolsuper
                 and (
                   relation.relforcerowsecurity
                   or not pg_has_role(effective_owner.oid, relation.relowner, 'USAGE')
                 )
                 and (
                   0::oid = any(policy.polroles)
                   or exists (
                     select 1
                     from unnest(policy.polroles) as policy_role(oid)
                     where policy_role.oid <> 0
                       and (
                         policy_role.oid = effective_owner.oid
                         or pg_has_role(effective_owner.oid, policy_role.oid, 'MEMBER')
                       )
                   )
                 )
             )
             or exists (
               select 1
               from writable_view_paths as writable_view
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = writable_view.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   writable_view.effective_owner_oid,
                   candidate.oid
                 )
               where writable_view.affected_oid = relation.oid
                 and has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
                 and has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
                 and not effective_owner.rolbypassrls
                 and not effective_owner.rolsuper
                 and (
                   relation.relforcerowsecurity
                   or not pg_has_role(effective_owner.oid, relation.relowner, 'USAGE')
                 )
                 and (
                   0::oid = any(policy.polroles)
                   or exists (
                     select 1
                     from unnest(policy.polroles) as policy_role(oid)
                     where policy_role.oid <> 0
                       and (
                         policy_role.oid = effective_owner.oid
                         or pg_has_role(effective_owner.oid, policy_role.oid, 'MEMBER')
                       )
                   )
                 )
                 and (
                   (
                     policy.polcmd in ('a', '*')
                     and dependency.used_by_with_check
                     and writable_view.actions & 8 <> 0
                     and (
                       has_table_privilege(candidate.oid, invocation_view.oid, 'INSERT')
                       or has_any_column_privilege(candidate.oid, invocation_view.oid, 'INSERT')
                     )
                     and (
                       has_table_privilege(effective_owner.oid, relation.oid, 'INSERT')
                       or has_any_column_privilege(effective_owner.oid, relation.oid, 'INSERT')
                     )
                   )
                   or (
                     policy.polcmd in ('w', '*')
                     and (dependency.used_by_using or dependency.used_by_with_check)
                     and writable_view.actions & 4 <> 0
                     and (
                       has_table_privilege(candidate.oid, invocation_view.oid, 'UPDATE')
                       or has_any_column_privilege(candidate.oid, invocation_view.oid, 'UPDATE')
                     )
                     and (
                       has_table_privilege(effective_owner.oid, relation.oid, 'UPDATE')
                       or has_any_column_privilege(effective_owner.oid, relation.oid, 'UPDATE')
                     )
                   )
                   or (
                     policy.polcmd in ('d', '*')
                     and dependency.used_by_using
                     and writable_view.actions & 16 <> 0
                     and has_table_privilege(candidate.oid, invocation_view.oid, 'DELETE')
                     and has_table_privilege(effective_owner.oid, relation.oid, 'DELETE')
                   )
                 )
             )
           )
         order by 1
       ) as security_definer_policy_bindings,
       array(
         select distinct format(
           '%I.%I:%s->%I.%I(%s)',
           relation_namespace.nspname,
           relation.relname,
           stored_expression.binding,
           routine_namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from stored_expression_dependencies as stored_expression
         join pg_catalog.pg_class as relation on relation.oid = stored_expression.relation_oid
         join pg_catalog.pg_namespace as relation_namespace
           on relation_namespace.oid = relation.relnamespace
         join pg_catalog.pg_class as invocation_relation
           on invocation_relation.oid = stored_expression.invocation_oid
         join pg_catalog.pg_namespace as invocation_namespace
           on invocation_namespace.oid = invocation_relation.relnamespace
         join pg_catalog.pg_proc as routine on routine.oid = stored_expression.routine_oid
         join pg_catalog.pg_namespace as routine_namespace
           on routine_namespace.oid = routine.pronamespace
         where routine_namespace.nspname !~ '^pg_'
           and routine_namespace.nspname <> 'information_schema'
           and routine.prosecdef
           and routine.proowner <> candidate.oid
           and has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
           and (
             (
               stored_expression.selectable
               and has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
               and (
                 has_table_privilege(candidate.oid, invocation_relation.oid, 'SELECT')
                 or (
                   cardinality(stored_expression.select_columns) = 0
                   and has_any_column_privilege(
                     candidate.oid,
                     invocation_relation.oid,
                     'SELECT'
                   )
                 )
                 or exists (
                   select 1
                   from unnest(stored_expression.select_columns) as selected(attnum)
                   where has_column_privilege(
                     candidate.oid,
                     invocation_relation.oid,
                     selected.attnum,
                     'SELECT'
                   )
                 )
                 or exists (
                   select 1
                   from writable_view_paths as writable_view
                   join pg_catalog.pg_roles as effective_owner
                     on effective_owner.oid = coalesce(
                       writable_view.effective_owner_oid,
                       candidate.oid
                     )
                   where writable_view.invocation_oid = stored_expression.invocation_oid
                     and (
                       (
                         writable_view.actions & 4 <> 0
                         and (
                           has_table_privilege(
                             candidate.oid,
                             invocation_relation.oid,
                             'UPDATE'
                           )
                           or has_any_column_privilege(
                             candidate.oid,
                             invocation_relation.oid,
                             'UPDATE'
                           )
                         )
                         and (
                           has_table_privilege(
                             effective_owner.oid,
                             writable_view.affected_oid,
                             'UPDATE'
                           )
                           or has_any_column_privilege(
                             effective_owner.oid,
                             writable_view.affected_oid,
                             'UPDATE'
                           )
                         )
                       )
                       or (
                         writable_view.actions & 16 <> 0
                         and has_table_privilege(
                           candidate.oid,
                           invocation_relation.oid,
                           'DELETE'
                         )
                         and has_table_privilege(
                           effective_owner.oid,
                           writable_view.affected_oid,
                           'DELETE'
                         )
                       )
                     )
                 )
               )
             )
             or (
               not stored_expression.selectable
               and has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
               and (
                 stored_expression.binding !~ '^dml-rule:[^:]+:R:'
                 or has_parameter_privilege(
                   candidate.oid,
                   'session_replication_role',
                   'SET'
                 )
               )
               and (
                 stored_expression.binding !~ '^dml-rule:'
                 or (
                   stored_expression.binding ~ '^dml-rule:INSERT:'
                   and (
                     has_table_privilege(candidate.oid, invocation_relation.oid, 'INSERT')
                     or has_any_column_privilege(
                       candidate.oid,
                       invocation_relation.oid,
                       'INSERT'
                     )
                   )
                 )
                 or (
                   stored_expression.binding ~ '^dml-rule:UPDATE:'
                   and (
                     has_table_privilege(candidate.oid, invocation_relation.oid, 'UPDATE')
                     or has_any_column_privilege(
                       candidate.oid,
                       invocation_relation.oid,
                       'UPDATE'
                     )
                   )
                 )
                 or (
                   stored_expression.binding ~ '^dml-rule:DELETE:'
                   and has_table_privilege(candidate.oid, invocation_relation.oid, 'DELETE')
                 )
               )
               and (
                 has_table_privilege(candidate.oid, invocation_relation.oid, 'INSERT')
                 or exists (
                   select 1
                   from pg_catalog.pg_attribute as writable_column
                   where writable_column.attrelid = invocation_relation.oid
                     and writable_column.attnum > 0
                     and not writable_column.attisdropped
                     and writable_column.attgenerated = ''
                     and has_column_privilege(
                       candidate.oid,
                       invocation_relation.oid,
                       writable_column.attnum,
                       'INSERT'
                     )
                 )
                 or has_table_privilege(candidate.oid, invocation_relation.oid, 'UPDATE')
                 or (
                   cardinality(stored_expression.update_columns) = 0
                   and exists (
                     select 1
                     from pg_catalog.pg_attribute as writable_column
                     where writable_column.attrelid = invocation_relation.oid
                       and writable_column.attnum > 0
                       and not writable_column.attisdropped
                       and writable_column.attgenerated = ''
                       and has_column_privilege(
                         candidate.oid,
                         invocation_relation.oid,
                         writable_column.attnum,
                         'UPDATE'
                       )
                   )
                 )
                 or exists (
                   select 1
                   from unnest(stored_expression.update_columns) as watched(attnum)
                   join pg_catalog.pg_attribute as expression_column
                     on expression_column.attrelid = relation.oid
                    and expression_column.attnum = watched.attnum
                   join pg_catalog.pg_attribute as invocation_column
                     on invocation_column.attrelid = invocation_relation.oid
                    and invocation_column.attname = expression_column.attname
                   where has_column_privilege(
                     candidate.oid,
                     invocation_relation.oid,
                     invocation_column.attnum,
                     'UPDATE'
                   )
                 )
                 or (
                   stored_expression.binding ~ '^dml-rule:DELETE:'
                   and has_table_privilege(candidate.oid, invocation_relation.oid, 'DELETE')
                 )
               )
             )
             or exists (
               select 1
               from writable_view_paths as writable_view
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = writable_view.invocation_oid
               join pg_catalog.pg_namespace as view_namespace
                 on view_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   writable_view.effective_owner_oid,
                   candidate.oid
               )
               where not stored_expression.selectable
                 and writable_view.affected_oid = stored_expression.invocation_oid
                 and has_schema_privilege(candidate.oid, view_namespace.oid, 'USAGE')
                 and (
                   stored_expression.binding !~ '^dml-rule:'
                   or case split_part(stored_expression.binding, ':', 3)
                     when 'O' then true
                     when 'R' then
                       has_parameter_privilege(
                         candidate.oid,
                         'session_replication_role',
                         'SET'
                       )
                     when 'A' then true
                     else false
                   end
                 )
                 and (
                   (
                     writable_view.actions & 8 <> 0
                     and (
                       stored_expression.binding !~ '^dml-rule:'
                       or stored_expression.binding ~ '^dml-rule:INSERT:'
                     )
                     and (
                       has_table_privilege(candidate.oid, invocation_view.oid, 'INSERT')
                       or has_any_column_privilege(
                         candidate.oid,
                         invocation_view.oid,
                         'INSERT'
                       )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                     )
                   )
                   or (
                     writable_view.actions & 4 <> 0
                     and (
                       stored_expression.binding !~ '^dml-rule:'
                       or stored_expression.binding ~ '^dml-rule:UPDATE:'
                     )
                     and (
                       has_table_privilege(candidate.oid, invocation_view.oid, 'UPDATE')
                       or (
                         cardinality(stored_expression.update_columns) = 0
                         and has_any_column_privilege(
                           candidate.oid,
                           invocation_view.oid,
                           'UPDATE'
                         )
                       )
                       or exists (
                         select 1
                         from writable_view_columns as writable_column
                         join pg_catalog.pg_attribute as affected_column
                           on affected_column.attrelid = writable_column.affected_oid
                          and affected_column.attnum = writable_column.affected_attnum
                         join pg_catalog.pg_attribute as expression_column
                           on expression_column.attrelid = relation.oid
                          and expression_column.attname = affected_column.attname
                         where writable_column.invocation_oid = writable_view.invocation_oid
                           and writable_column.affected_oid = writable_view.affected_oid
                           and expression_column.attnum = any(
                             stored_expression.update_columns
                           )
                           and has_column_privilege(
                             candidate.oid,
                             invocation_view.oid,
                             writable_column.invocation_attnum,
                             'UPDATE'
                           )
                       )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                     )
                   )
                   or (
                     stored_expression.binding ~ '^dml-rule:DELETE:'
                     and writable_view.actions & 16 <> 0
                     and has_table_privilege(
                       candidate.oid,
                       invocation_view.oid,
                       'DELETE'
                     )
                     and has_table_privilege(
                       effective_owner.oid,
                       writable_view.affected_oid,
                       'DELETE'
                     )
                   )
                 )
             )
             or exists (
               select 1
               from dml_rule_write_paths as rule_write
               join pg_catalog.pg_class as root_invocation_relation
                 on root_invocation_relation.oid = rule_write.invocation_oid
               join pg_catalog.pg_namespace as root_invocation_namespace
                 on root_invocation_namespace.oid = root_invocation_relation.relnamespace
               where not stored_expression.selectable
                 and rule_write.affected_oid = stored_expression.invocation_oid
                 and (
                   (
                     has_schema_privilege(
                       candidate.oid,
                       root_invocation_namespace.oid,
                       'USAGE'
                     )
                     and case rule_write.invocation_action
                       when 'INSERT' then
                         has_table_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'INSERT'
                         )
                         or has_any_column_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'INSERT'
                         )
                       when 'UPDATE' then
                         has_table_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'UPDATE'
                         )
                         or has_any_column_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'UPDATE'
                         )
                       when 'DELETE' then
                         has_table_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'DELETE'
                         )
                       else false
                     end
                   )
                   or exists (
                     select 1
                     from writable_view_paths as rule_view
                     join pg_catalog.pg_class as rule_invocation_view
                       on rule_invocation_view.oid = rule_view.invocation_oid
                     join pg_catalog.pg_namespace as rule_view_namespace
                       on rule_view_namespace.oid = rule_invocation_view.relnamespace
                     join pg_catalog.pg_roles as rule_effective_owner
                       on rule_effective_owner.oid = coalesce(
                         rule_view.effective_owner_oid,
                         candidate.oid
                       )
                     where rule_view.affected_oid = rule_write.invocation_oid
                       and has_schema_privilege(
                         candidate.oid,
                         rule_view_namespace.oid,
                         'USAGE'
                       )
                       and case rule_write.invocation_action
                         when 'INSERT' then
                           rule_view.actions & 8 <> 0
                           and (
                             has_table_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'INSERT'
                             )
                             or has_any_column_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'INSERT'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                           )
                         when 'UPDATE' then
                           rule_view.actions & 4 <> 0
                           and (
                             has_table_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'UPDATE'
                             )
                             or has_any_column_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'UPDATE'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                           )
                         when 'DELETE' then
                           rule_view.actions & 16 <> 0
                           and has_table_privilege(
                             candidate.oid,
                             rule_invocation_view.oid,
                             'DELETE'
                           )
                           and has_table_privilege(
                             rule_effective_owner.oid,
                             rule_write.invocation_oid,
                             'DELETE'
                           )
                         else false
                       end
                   )
                 )
                 and (
                   rule_write.allowed_modes & 1 <> 0
                   or (
                     rule_write.allowed_modes & 2 <> 0
                     and has_parameter_privilege(
                       candidate.oid,
                       'session_replication_role',
                       'SET'
                     )
                   )
                 )
                 and (
                   (
                     stored_expression.binding !~ '^dml-rule:'
                     and rule_write.affected_action in ('INSERT', 'UPDATE')
                   )
                   or (
                     stored_expression.binding ~ '^dml-rule:'
                     and split_part(stored_expression.binding, ':', 2)
                       = rule_write.affected_action
                     and case split_part(stored_expression.binding, ':', 3)
                       when 'O' then rule_write.allowed_modes & 1 <> 0
                       when 'R' then
                         rule_write.allowed_modes & 2 <> 0
                         and has_parameter_privilege(
                           candidate.oid,
                           'session_replication_role',
                           'SET'
                         )
                       when 'A' then true
                       else false
                     end
                   )
                 )
             )
             or exists (
               select 1
               from referential_write_paths as cascade
               join pg_catalog.pg_class as root_invocation_relation
                 on root_invocation_relation.oid = cascade.invocation_oid
               join pg_catalog.pg_namespace as root_invocation_namespace
                 on root_invocation_namespace.oid = root_invocation_relation.relnamespace
               where not stored_expression.selectable
                 and stored_expression.binding !~ '^dml-rule:'
                 and cascade.affected_action = 'UPDATE'
                 and cascade.affected_oid = stored_expression.invocation_oid
                 and has_schema_privilege(
                   candidate.oid,
                   root_invocation_namespace.oid,
                   'USAGE'
                 )
                 and (
                   (
                     cascade.invocation_action = 'DELETE'
                     and has_table_privilege(
                       candidate.oid,
                       root_invocation_relation.oid,
                       'DELETE'
                     )
                   )
                   or (
                     cascade.invocation_action = 'UPDATE'
                     and (
                       has_table_privilege(
                         candidate.oid,
                         root_invocation_relation.oid,
                         'UPDATE'
                       )
                       or exists (
                         select 1
                         from unnest(cascade.invocation_columns) as changed(attnum)
                         join pg_catalog.pg_attribute as referenced_column
                           on referenced_column.attrelid = cascade.invocation_relation_oid
                          and referenced_column.attnum = changed.attnum
                         join pg_catalog.pg_attribute as root_invocation_column
                           on root_invocation_column.attrelid = root_invocation_relation.oid
                          and root_invocation_column.attname = referenced_column.attname
                         where has_column_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           root_invocation_column.attnum,
                           'UPDATE'
                         )
                       )
                     )
                   )
                 )
                 and (
                   cardinality(stored_expression.update_columns) = 0
                   or exists (
                     select 1
                     from unnest(cascade.affected_columns) as changed(attnum)
                     join pg_catalog.pg_attribute as affected_column
                       on affected_column.attrelid = cascade.affected_oid
                      and affected_column.attnum = changed.attnum
                     join pg_catalog.pg_attribute as expression_column
                       on expression_column.attrelid = relation.oid
                      and expression_column.attname = affected_column.attname
                     where expression_column.attnum = any(stored_expression.update_columns)
                       and (
                         stored_expression.binding !~ '^column-default:'
                         or cascade.affected_uses_default
                       )
                   )
                 )
             )
           )
         order by 1
       ) as security_definer_stored_expression_bindings,
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
           and has_schema_privilege(candidate.oid, namespace.oid, 'USAGE')
           and has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
         order by namespace.nspname, routine.proname, routine.oid
       ) as security_definer_routines,
       array(
         select distinct format(
           'aggregate:%I.%I(%s):%s->%I.%I(%s)',
           aggregate_namespace.nspname,
           aggregate_routine.proname,
           pg_get_function_identity_arguments(aggregate_routine.oid),
           dependency.binding,
           routine_namespace.nspname,
           support_routine.proname,
           pg_get_function_identity_arguments(support_routine.oid)
         )
         from aggregate_routine_dependencies as dependency
         join pg_catalog.pg_proc as aggregate_routine
           on aggregate_routine.oid = dependency.aggregate_oid
         join pg_catalog.pg_namespace as aggregate_namespace
           on aggregate_namespace.oid = aggregate_routine.pronamespace
         join pg_catalog.pg_proc as support_routine
           on support_routine.oid = dependency.routine_oid
         join pg_catalog.pg_namespace as routine_namespace
           on routine_namespace.oid = support_routine.pronamespace
         where routine_namespace.nspname !~ '^pg_'
           and routine_namespace.nspname <> 'information_schema'
           and support_routine.prosecdef
           and support_routine.proowner <> candidate.oid
           and has_schema_privilege(candidate.oid, aggregate_namespace.oid, 'USAGE')
           and has_function_privilege(candidate.oid, aggregate_routine.oid, 'EXECUTE')
         order by 1
       ) as security_definer_aggregate_bindings,
       array(
         select distinct format(
           'operator:%I.%s(%s,%s)->%I.%I(%s)',
           operator_namespace.nspname,
           audited_operator.oprname,
           pg_catalog.format_type(audited_operator.oprleft, null),
           pg_catalog.format_type(audited_operator.oprright, null),
           routine_namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from pg_catalog.pg_operator as audited_operator
         join pg_catalog.pg_namespace as operator_namespace
           on operator_namespace.oid = audited_operator.oprnamespace
         join pg_catalog.pg_proc as routine on routine.oid = audited_operator.oprcode
         join pg_catalog.pg_namespace as routine_namespace
           on routine_namespace.oid = routine.pronamespace
         where routine_namespace.nspname !~ '^pg_'
           and routine_namespace.nspname <> 'information_schema'
           and routine.prosecdef
           and routine.proowner <> candidate.oid
           and has_schema_privilege(candidate.oid, operator_namespace.oid, 'USAGE')
           and has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
         order by 1
       ) as security_definer_operator_bindings,
       array(
         select distinct format(
           '%I.%I:%I->%I.%I(%s)',
           relation_namespace.nspname,
           relation.relname,
           audited_trigger.tgname,
           routine_namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from pg_catalog.pg_trigger as audited_trigger
         join pg_catalog.pg_class as relation on relation.oid = audited_trigger.tgrelid
         join pg_catalog.pg_namespace as relation_namespace
           on relation_namespace.oid = relation.relnamespace
         join trigger_routine_dependencies as trigger_dependency
           on trigger_dependency.trigger_oid = audited_trigger.oid
         join pg_catalog.pg_proc as routine on routine.oid = trigger_dependency.routine_oid
         join pg_catalog.pg_namespace as routine_namespace
           on routine_namespace.oid = routine.pronamespace
         where not audited_trigger.tgisinternal
           and (
             audited_trigger.tgenabled in ('O', 'A')
             or (
               audited_trigger.tgenabled = 'R'
               and has_parameter_privilege(
                 candidate.oid,
                 'session_replication_role',
                 'SET'
               )
             )
           )
           and relation_namespace.nspname !~ '^pg_'
           and relation_namespace.nspname <> 'information_schema'
           and routine_namespace.nspname !~ '^pg_'
           and routine_namespace.nspname <> 'information_schema'
           and routine.prosecdef
           and routine.proowner <> candidate.oid
           and (
             exists (
             select 1
             from (
               select relation.oid
               union
               select ancestor.oid
               from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
             ) as ancestor
             join pg_catalog.pg_class as invocation_relation
               on invocation_relation.oid = ancestor.oid
             join pg_catalog.pg_namespace as invocation_namespace
               on invocation_namespace.oid = invocation_relation.relnamespace
             where has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
               and (
                 invocation_relation.oid = relation.oid
                 or audited_trigger.tgtype & 1 <> 0
               )
               and (
                 (
                   audited_trigger.tgtype & 4 <> 0
                   and (
                     has_table_privilege(candidate.oid, invocation_relation.oid, 'INSERT')
                     or has_any_column_privilege(
                       candidate.oid,
                       invocation_relation.oid,
                       'INSERT'
                     )
                   )
                 )
                 or (
                   audited_trigger.tgtype & 8 <> 0
                   and has_table_privilege(candidate.oid, invocation_relation.oid, 'DELETE')
                 )
                 or (
                   audited_trigger.tgtype & 16 <> 0
                   and (
                     has_table_privilege(candidate.oid, invocation_relation.oid, 'UPDATE')
                     or (
                       cardinality(audited_trigger.tgattr::smallint[]) = 0
                       and has_any_column_privilege(
                         candidate.oid,
                         invocation_relation.oid,
                         'UPDATE'
                       )
                     )
                     or exists (
                       select 1
                       from unnest(audited_trigger.tgattr::smallint[]) as watched(attnum)
                       join pg_catalog.pg_attribute as trigger_column
                         on trigger_column.attrelid = relation.oid
                        and trigger_column.attnum = watched.attnum
                       join pg_catalog.pg_attribute as invocation_column
                         on invocation_column.attrelid = invocation_relation.oid
                        and invocation_column.attname = trigger_column.attname
                       where has_column_privilege(
                         candidate.oid,
                         invocation_relation.oid,
                         invocation_column.attnum,
                         'UPDATE'
                       )
                     )
                   )
                 )
                 or (
                   audited_trigger.tgtype & 32 <> 0
                   and has_table_privilege(candidate.oid, invocation_relation.oid, 'TRUNCATE')
                 )
                 or (
                   invocation_relation.oid <> relation.oid
                   and audited_trigger.tgtype & 1 <> 0
                   and audited_trigger.tgtype & 12 <> 0
                   and exists (
                     select 1
                     from pg_catalog.pg_partitioned_table as partitioned
                     where partitioned.partrelid = invocation_relation.oid
                       and (
                         has_table_privilege(
                           candidate.oid,
                           invocation_relation.oid,
                           'UPDATE'
                         )
                         or exists (
                           select 1
                           from unnest(partitioned.partattrs) as key(attnum)
                           where key.attnum <> 0
                             and has_column_privilege(
                               candidate.oid,
                               invocation_relation.oid,
                               key.attnum,
                               'UPDATE'
                             )
                         )
                         or (
                           0 = any(partitioned.partattrs)
                           and has_any_column_privilege(
                             candidate.oid,
                             invocation_relation.oid,
                             'UPDATE'
                           )
                         )
                       )
                   )
                 )
               )
             )
             or exists (
               select 1
               from writable_view_paths as writable_view
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = writable_view.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   writable_view.effective_owner_oid,
                   candidate.oid
                 )
               where writable_view.affected_oid in (
                   select relation.oid
                   union
                   select ancestor.oid
                   from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
                 )
                 and (
                   writable_view.affected_oid = relation.oid
                   or audited_trigger.tgtype & 1 <> 0
                 )
                 and has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
                 and (
                   (
                     audited_trigger.tgtype & 4 <> 0
                     and writable_view.actions & 8 <> 0
                     and (
                       has_table_privilege(candidate.oid, invocation_view.oid, 'INSERT')
                       or has_any_column_privilege(
                         candidate.oid,
                         invocation_view.oid,
                         'INSERT'
                       )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                     )
                   )
                   or (
                     audited_trigger.tgtype & 8 <> 0
                     and writable_view.actions & 16 <> 0
                     and has_table_privilege(candidate.oid, invocation_view.oid, 'DELETE')
                     and has_table_privilege(
                       effective_owner.oid,
                       writable_view.affected_oid,
                       'DELETE'
                     )
                   )
                   or (
                     audited_trigger.tgtype & 16 <> 0
                     and writable_view.actions & 4 <> 0
                     and (
                       has_table_privilege(candidate.oid, invocation_view.oid, 'UPDATE')
                       or (
                         cardinality(audited_trigger.tgattr::smallint[]) = 0
                         and has_any_column_privilege(
                           candidate.oid,
                           invocation_view.oid,
                           'UPDATE'
                         )
                       )
                       or exists (
                         select 1
                         from writable_view_columns as writable_column
                         join pg_catalog.pg_attribute as affected_column
                           on affected_column.attrelid = writable_column.affected_oid
                          and affected_column.attnum = writable_column.affected_attnum
                         join pg_catalog.pg_attribute as trigger_column
                           on trigger_column.attrelid = relation.oid
                          and trigger_column.attname = affected_column.attname
                         where writable_column.invocation_oid = writable_view.invocation_oid
                           and writable_column.affected_oid = writable_view.affected_oid
                           and trigger_column.attnum = any(
                             audited_trigger.tgattr::smallint[]
                           )
                           and has_column_privilege(
                             candidate.oid,
                             invocation_view.oid,
                             writable_column.invocation_attnum,
                             'UPDATE'
                           )
                       )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                     )
                   )
                   or (
                     writable_view.affected_oid <> relation.oid
                     and audited_trigger.tgtype & 1 <> 0
                     and audited_trigger.tgtype & 12 <> 0
                     and writable_view.actions & 4 <> 0
                     and exists (
                       select 1
                       from pg_catalog.pg_partitioned_table as partitioned
                       where partitioned.partrelid = writable_view.affected_oid
                         and (
                           has_table_privilege(candidate.oid, invocation_view.oid, 'UPDATE')
                           or exists (
                             select 1
                             from writable_view_columns as writable_column
                             where writable_column.invocation_oid = writable_view.invocation_oid
                               and writable_column.affected_oid = writable_view.affected_oid
                               and (
                                 writable_column.affected_attnum = any(partitioned.partattrs)
                                 or 0 = any(partitioned.partattrs)
                               )
                               and has_column_privilege(
                                 candidate.oid,
                                 invocation_view.oid,
                                 writable_column.invocation_attnum,
                                 'UPDATE'
                               )
                           )
                         )
                       )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                     )
                   )
                 )
             )
             or exists (
               select 1
               from dml_rule_write_paths as rule_write
               join pg_catalog.pg_class as root_invocation_relation
                 on root_invocation_relation.oid = rule_write.invocation_oid
               join pg_catalog.pg_namespace as root_invocation_namespace
                 on root_invocation_namespace.oid = root_invocation_relation.relnamespace
               where rule_write.affected_oid in (
                   select relation.oid
                   union
                   select ancestor.oid
                   from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
                 )
                 and (
                   rule_write.affected_oid = relation.oid
                   or audited_trigger.tgtype & 1 <> 0
                 )
                 and (
                   (
                     has_schema_privilege(
                       candidate.oid,
                       root_invocation_namespace.oid,
                       'USAGE'
                     )
                     and case rule_write.invocation_action
                       when 'INSERT' then
                         has_table_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'INSERT'
                         )
                         or has_any_column_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'INSERT'
                         )
                       when 'UPDATE' then
                         has_table_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'UPDATE'
                         )
                         or has_any_column_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'UPDATE'
                         )
                       when 'DELETE' then
                         has_table_privilege(
                           candidate.oid,
                           root_invocation_relation.oid,
                           'DELETE'
                         )
                       else false
                     end
                   )
                   or exists (
                     select 1
                     from writable_view_paths as rule_view
                     join pg_catalog.pg_class as rule_invocation_view
                       on rule_invocation_view.oid = rule_view.invocation_oid
                     join pg_catalog.pg_namespace as rule_view_namespace
                       on rule_view_namespace.oid = rule_invocation_view.relnamespace
                     join pg_catalog.pg_roles as rule_effective_owner
                       on rule_effective_owner.oid = coalesce(
                         rule_view.effective_owner_oid,
                         candidate.oid
                       )
                     where rule_view.affected_oid = rule_write.invocation_oid
                       and has_schema_privilege(
                         candidate.oid,
                         rule_view_namespace.oid,
                         'USAGE'
                       )
                       and case rule_write.invocation_action
                         when 'INSERT' then
                           rule_view.actions & 8 <> 0
                           and (
                             has_table_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'INSERT'
                             )
                             or has_any_column_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'INSERT'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                           )
                         when 'UPDATE' then
                           rule_view.actions & 4 <> 0
                           and (
                             has_table_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'UPDATE'
                             )
                             or has_any_column_privilege(
                               candidate.oid,
                               rule_invocation_view.oid,
                               'UPDATE'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                           )
                         when 'DELETE' then
                           rule_view.actions & 16 <> 0
                           and has_table_privilege(
                             candidate.oid,
                             rule_invocation_view.oid,
                             'DELETE'
                           )
                           and has_table_privilege(
                             rule_effective_owner.oid,
                             rule_write.invocation_oid,
                             'DELETE'
                           )
                         else false
                       end
                   )
                 )
                 and case audited_trigger.tgenabled
                   when 'O' then rule_write.allowed_modes & 1 <> 0
                   when 'R' then
                     rule_write.allowed_modes & 2 <> 0
                     and has_parameter_privilege(
                       candidate.oid,
                       'session_replication_role',
                       'SET'
                     )
                   when 'A' then
                     rule_write.allowed_modes & 1 <> 0
                     or (
                       rule_write.allowed_modes & 2 <> 0
                       and has_parameter_privilege(
                         candidate.oid,
                         'session_replication_role',
                         'SET'
                       )
                     )
                   else false
                 end
                 and (
                   (rule_write.affected_action = 'INSERT' and audited_trigger.tgtype & 4 <> 0)
                   or (
                     rule_write.affected_action = 'DELETE'
                     and audited_trigger.tgtype & 8 <> 0
                   )
                   or (
                     rule_write.affected_action = 'UPDATE'
                     and audited_trigger.tgtype & 16 <> 0
                   )
                 )
             )
             or exists (
               select 1
               from referential_write_paths as cascade
               join pg_catalog.pg_class as invocation_relation
                 on invocation_relation.oid = cascade.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_relation.relnamespace
               where cascade.affected_oid in (
                   select relation.oid
                   union
                   select ancestor.oid
                   from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
                 )
                 and (
                   cascade.affected_oid = relation.oid
                   or audited_trigger.tgtype & 1 <> 0
                 )
                 and has_schema_privilege(candidate.oid, invocation_namespace.oid, 'USAGE')
                 and (
                   (
                     cascade.invocation_action = 'DELETE'
                     and has_table_privilege(candidate.oid, invocation_relation.oid, 'DELETE')
                   )
                   or (
                     cascade.invocation_action = 'UPDATE'
                     and (
                       has_table_privilege(candidate.oid, invocation_relation.oid, 'UPDATE')
                       or exists (
                         select 1
                         from unnest(cascade.invocation_columns) as changed(attnum)
                         join pg_catalog.pg_attribute as referenced_column
                           on referenced_column.attrelid = cascade.invocation_relation_oid
                          and referenced_column.attnum = changed.attnum
                         join pg_catalog.pg_attribute as invocation_column
                           on invocation_column.attrelid = invocation_relation.oid
                          and invocation_column.attname = referenced_column.attname
                         where has_column_privilege(
                           candidate.oid,
                           invocation_relation.oid,
                           invocation_column.attnum,
                           'UPDATE'
                         )
                       )
                     )
                   )
                 )
                 and (
                   (
                     cascade.affected_action = 'DELETE'
                     and audited_trigger.tgtype & 8 <> 0
                   )
                   or (
                     cascade.affected_action = 'UPDATE'
                     and audited_trigger.tgtype & 16 <> 0
                     and (
                       cardinality(audited_trigger.tgattr::smallint[]) = 0
                       or exists (
                         select 1
                         from unnest(cascade.affected_columns) as changed(attnum)
                         join pg_catalog.pg_attribute as affected_column
                           on affected_column.attrelid = cascade.affected_oid
                          and affected_column.attnum = changed.attnum
                         join pg_catalog.pg_attribute as trigger_column
                           on trigger_column.attrelid = relation.oid
                          and trigger_column.attname = affected_column.attname
                         where trigger_column.attnum = any(
                           audited_trigger.tgattr::smallint[]
                         )
                       )
                     )
                   )
                 )
             )
           )
         order by 1
       ) as security_definer_trigger_bindings,
       array(
         select distinct format(
           'event-trigger:%I:%s%s->%I.%I(%s)',
           event_trigger.evtname,
           event_trigger.evtevent,
           case
             when event_trigger.evttags is null then ''
             else format('[%s]', array_to_string(event_trigger.evttags, ','))
           end,
           routine_namespace.nspname,
           routine.proname,
           pg_get_function_identity_arguments(routine.oid)
         )
         from pg_catalog.pg_event_trigger as event_trigger
         join pg_catalog.pg_proc as routine on routine.oid = event_trigger.evtfoid
         join pg_catalog.pg_namespace as routine_namespace
           on routine_namespace.oid = routine.pronamespace
         where (
             event_trigger.evtenabled in ('O', 'A')
             or (
               event_trigger.evtenabled = 'R'
               and has_parameter_privilege(
                 candidate.oid,
                 'session_replication_role',
                 'SET'
               )
             )
           )
           and routine_namespace.nspname !~ '^pg_'
           and routine_namespace.nspname <> 'information_schema'
           and routine.prosecdef
           and routine.proowner <> candidate.oid
           and exists (
             select 1
             from role_ddl_command_tags as authority
             where authority.role_oid = candidate.oid
               and authority.event = event_trigger.evtevent
               and (
                 event_trigger.evttags is null
                 or authority.tag = any(event_trigger.evttags)
               )
           )
         order by 1
       ) as security_definer_event_trigger_bindings
     from pg_catalog.pg_roles as candidate
     where candidate.rolname <> $1
       and (
         pg_has_role($1, candidate.oid, 'MEMBER')
         or candidate.oid in (select role_oid from reachable_roles)
       )
     order by candidate.rolname`,
    [runtimeRole],
  );
  const database = await admin.query<DatabasePrivilegeRow>(
    `select
       current_database() as database,
       has_database_privilege($1, current_database(), 'CONNECT') as connect,
       has_database_privilege($1, current_database(), 'CREATE') as create,
       owner.rolname = $1 as owner,
       has_database_privilege($1, current_database(), 'TEMPORARY') as temporary
     from pg_catalog.pg_database as database
     join pg_catalog.pg_roles as owner on owner.oid = database.datdba
     where database.datname = current_database()`,
    [runtimeRole],
  );
  const databaseRow = database.rows[0];
  if (databaseRow === undefined) throw new Error('database privilege row is absent');

  const extensions = await admin.query<ExtensionOwnershipRow>(
    `select
       extension.extname as extension,
       owner.rolname as owner,
       namespace.nspname as schema
     from pg_catalog.pg_extension as extension
     join pg_catalog.pg_roles as owner on owner.oid = extension.extowner
     join pg_catalog.pg_namespace as namespace on namespace.oid = extension.extnamespace
     order by extension.extname`,
  );
  const foreignDataWrappers = await admin.query<ForeignDataWrapperOwnershipRow>(
    `select
       foreign_data_wrapper.fdwname as wrapper,
       owner.rolname as owner
     from pg_catalog.pg_foreign_data_wrapper as foreign_data_wrapper
     join pg_catalog.pg_roles as owner on owner.oid = foreign_data_wrapper.fdwowner
     order by foreign_data_wrapper.fdwname`,
  );
  const foreignServers = await admin.query<ForeignServerOwnershipRow>(
    `select
       foreign_server.srvname as server,
       owner.rolname as owner
     from pg_catalog.pg_foreign_server as foreign_server
     join pg_catalog.pg_roles as owner on owner.oid = foreign_server.srvowner
     order by foreign_server.srvname`,
  );
  const publications = await admin.query<PublicationOwnershipRow>(
    `select
       publication.pubname as publication,
       owner.rolname as owner
     from pg_catalog.pg_publication as publication
     join pg_catalog.pg_roles as owner on owner.oid = publication.pubowner
     order by publication.pubname`,
  );
  const subscriptions = await admin.query<SubscriptionOwnershipRow>(
    `select
       subscription.subname as subscription,
       owner.rolname as owner
     from pg_catalog.pg_subscription as subscription
     join pg_catalog.pg_roles as owner on owner.oid = subscription.subowner
     order by subscription.subname`,
  );
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
    `with recursive ${storedExpressionDependenciesCte},
     ${referentialWritePathsCte},
     ${roleDdlCommandTagsCte}
     select
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
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_function_privilege($1, routine.oid, 'EXECUTE')
       ) as executable,
       array(
         select distinct format(
           'aggregate:%I.%I(%s):%s',
           aggregate_namespace.nspname,
           aggregate_routine.proname,
           pg_get_function_identity_arguments(aggregate_routine.oid),
           dependency.binding
         )
         from aggregate_routine_dependencies as dependency
         join pg_catalog.pg_proc as aggregate_routine
           on aggregate_routine.oid = dependency.aggregate_oid
         join pg_catalog.pg_namespace as aggregate_namespace
           on aggregate_namespace.oid = aggregate_routine.pronamespace
         where dependency.routine_oid = routine.oid
           and has_schema_privilege($1, aggregate_namespace.oid, 'USAGE')
           and has_function_privilege($1, aggregate_routine.oid, 'EXECUTE')
         order by 1
       ) as aggregate_bindings,
       array(
         select distinct format(
           'operator:%I.%s(%s,%s)',
           operator_namespace.nspname,
           audited_operator.oprname,
           pg_catalog.format_type(audited_operator.oprleft, null),
           pg_catalog.format_type(audited_operator.oprright, null)
         )
         from pg_catalog.pg_operator as audited_operator
         join pg_catalog.pg_namespace as operator_namespace
           on operator_namespace.oid = audited_operator.oprnamespace
         where audited_operator.oprcode = routine.oid
           and has_schema_privilege($1, operator_namespace.oid, 'USAGE')
           and has_function_privilege($1, routine.oid, 'EXECUTE')
         order by 1
       ) as operator_bindings,
       array(
         select distinct format(
           '%I.%I:%I',
           relation_namespace.nspname,
           relation.relname,
           policy.polname
         )
         from pg_catalog.pg_policy as policy
         join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
         join pg_catalog.pg_namespace as relation_namespace
           on relation_namespace.oid = relation.relnamespace
         join policy_routine_dependencies as dependency
           on dependency.policy_oid = policy.oid
          and dependency.routine_oid = routine.oid
         where relation.relrowsecurity
           and relation_namespace.nspname = any($2::text[])
           and routine.prosecdef
           and routine.proowner <> runtime_role.oid
           and (
             (
               has_function_privilege($1, routine.oid, 'EXECUTE')
               and has_schema_privilege($1, relation_namespace.oid, 'USAGE')
               and not runtime_role.rolbypassrls
               and not runtime_role.rolsuper
               and (
                 relation.relforcerowsecurity
                 or not pg_has_role(runtime_role.oid, relation.relowner, 'USAGE')
               )
               and (
                 0::oid = any(policy.polroles)
                 or exists (
                   select 1
                   from unnest(policy.polroles) as policy_role(oid)
                   where policy_role.oid <> 0
                     and (
                       policy_role.oid = runtime_role.oid
                       or pg_has_role(runtime_role.oid, policy_role.oid, 'MEMBER')
                     )
                 )
               )
               and case policy.polcmd
                 when 'r' then
                   dependency.used_by_using
                   and (
                     has_table_privilege($1, relation.oid, 'SELECT')
                     or has_any_column_privilege($1, relation.oid, 'SELECT')
                   )
                 when 'a' then
                   dependency.used_by_with_check
                   and (
                     has_table_privilege($1, relation.oid, 'INSERT')
                     or has_any_column_privilege($1, relation.oid, 'INSERT')
                   )
                 when 'w' then
                   (dependency.used_by_using or dependency.used_by_with_check)
                   and (
                     has_table_privilege($1, relation.oid, 'UPDATE')
                     or has_any_column_privilege($1, relation.oid, 'UPDATE')
                   )
                 when 'd' then
                   dependency.used_by_using
                   and has_table_privilege($1, relation.oid, 'DELETE')
                 when '*' then
                   (
                     dependency.used_by_using
                     and (
                       has_table_privilege($1, relation.oid, 'SELECT')
                       or has_any_column_privilege($1, relation.oid, 'SELECT')
                       or has_table_privilege($1, relation.oid, 'UPDATE')
                       or has_any_column_privilege($1, relation.oid, 'UPDATE')
                       or has_table_privilege($1, relation.oid, 'DELETE')
                     )
                   )
                   or (
                     dependency.used_by_with_check
                     and (
                       has_table_privilege($1, relation.oid, 'INSERT')
                       or has_any_column_privilege($1, relation.oid, 'INSERT')
                       or has_table_privilege($1, relation.oid, 'UPDATE')
                       or has_any_column_privilege($1, relation.oid, 'UPDATE')
                     )
                   )
                 else false
               end
             )
             or exists (
               select 1
               from view_access_paths as view_access
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = view_access.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   view_access.effective_owner_oid,
                   runtime_role.oid
                 )
               where view_access.affected_oid = relation.oid
                 and policy.polcmd in ('r', '*')
                 and dependency.used_by_using
                 and has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
                 and (
                   has_table_privilege($1, invocation_view.oid, 'SELECT')
                   or has_any_column_privilege($1, invocation_view.oid, 'SELECT')
                 )
                 and (
                   has_table_privilege(effective_owner.oid, relation.oid, 'SELECT')
                   or has_any_column_privilege(effective_owner.oid, relation.oid, 'SELECT')
                 )
                 and has_function_privilege($1, routine.oid, 'EXECUTE')
                 and not effective_owner.rolbypassrls
                 and not effective_owner.rolsuper
                 and (
                   relation.relforcerowsecurity
                   or not pg_has_role(effective_owner.oid, relation.relowner, 'USAGE')
                 )
                 and (
                   0::oid = any(policy.polroles)
                   or exists (
                     select 1
                     from unnest(policy.polroles) as policy_role(oid)
                     where policy_role.oid <> 0
                       and (
                         policy_role.oid = effective_owner.oid
                         or pg_has_role(effective_owner.oid, policy_role.oid, 'MEMBER')
                       )
                   )
                 )
             )
             or exists (
               select 1
               from writable_view_paths as writable_view
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = writable_view.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   writable_view.effective_owner_oid,
                   runtime_role.oid
                 )
               where writable_view.affected_oid = relation.oid
                 and has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
                 and has_function_privilege($1, routine.oid, 'EXECUTE')
                 and not effective_owner.rolbypassrls
                 and not effective_owner.rolsuper
                 and (
                   relation.relforcerowsecurity
                   or not pg_has_role(effective_owner.oid, relation.relowner, 'USAGE')
                 )
                 and (
                   0::oid = any(policy.polroles)
                   or exists (
                     select 1
                     from unnest(policy.polroles) as policy_role(oid)
                     where policy_role.oid <> 0
                       and (
                         policy_role.oid = effective_owner.oid
                         or pg_has_role(effective_owner.oid, policy_role.oid, 'MEMBER')
                       )
                   )
                 )
                 and (
                   (
                     policy.polcmd in ('a', '*')
                     and dependency.used_by_with_check
                     and writable_view.actions & 8 <> 0
                     and (
                       has_table_privilege($1, invocation_view.oid, 'INSERT')
                       or has_any_column_privilege($1, invocation_view.oid, 'INSERT')
                     )
                     and (
                       has_table_privilege(effective_owner.oid, relation.oid, 'INSERT')
                       or has_any_column_privilege(effective_owner.oid, relation.oid, 'INSERT')
                     )
                   )
                   or (
                     policy.polcmd in ('w', '*')
                     and (dependency.used_by_using or dependency.used_by_with_check)
                     and writable_view.actions & 4 <> 0
                     and (
                       has_table_privilege($1, invocation_view.oid, 'UPDATE')
                       or has_any_column_privilege($1, invocation_view.oid, 'UPDATE')
                     )
                     and (
                       has_table_privilege(effective_owner.oid, relation.oid, 'UPDATE')
                       or has_any_column_privilege(effective_owner.oid, relation.oid, 'UPDATE')
                     )
                   )
                   or (
                     policy.polcmd in ('d', '*')
                     and dependency.used_by_using
                     and writable_view.actions & 16 <> 0
                     and has_table_privilege($1, invocation_view.oid, 'DELETE')
                     and has_table_privilege(effective_owner.oid, relation.oid, 'DELETE')
                   )
                 )
             )
           )
         order by 1
       ) as policy_bindings,
       array(
         select distinct format(
           '%I.%I:%s',
           relation_namespace.nspname,
           relation.relname,
           stored_expression.binding
         )
         from stored_expression_dependencies as stored_expression
         join pg_catalog.pg_class as relation on relation.oid = stored_expression.relation_oid
         join pg_catalog.pg_namespace as relation_namespace
           on relation_namespace.oid = relation.relnamespace
         join pg_catalog.pg_class as invocation_relation
           on invocation_relation.oid = stored_expression.invocation_oid
         join pg_catalog.pg_namespace as invocation_namespace
           on invocation_namespace.oid = invocation_relation.relnamespace
         where stored_expression.routine_oid = routine.oid
           and relation_namespace.nspname = any($2::text[])
           and routine.prosecdef
           and routine.proowner <> runtime_role.oid
           and has_function_privilege($1, routine.oid, 'EXECUTE')
           and (
             (
               stored_expression.selectable
               and has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
               and (
                 has_table_privilege($1, invocation_relation.oid, 'SELECT')
                 or (
                   cardinality(stored_expression.select_columns) = 0
                   and has_any_column_privilege($1, invocation_relation.oid, 'SELECT')
                 )
                 or exists (
                   select 1
                   from unnest(stored_expression.select_columns) as selected(attnum)
                   where has_column_privilege(
                     $1,
                     invocation_relation.oid,
                     selected.attnum,
                     'SELECT'
                   )
                 )
                 or exists (
                   select 1
                   from writable_view_paths as writable_view
                   join pg_catalog.pg_roles as effective_owner
                     on effective_owner.oid = coalesce(
                       writable_view.effective_owner_oid,
                       runtime_role.oid
                     )
                   where writable_view.invocation_oid = stored_expression.invocation_oid
                     and (
                       (
                         writable_view.actions & 4 <> 0
                         and (
                           has_table_privilege($1, invocation_relation.oid, 'UPDATE')
                           or has_any_column_privilege(
                             $1,
                             invocation_relation.oid,
                             'UPDATE'
                           )
                         )
                         and (
                           has_table_privilege(
                             effective_owner.oid,
                             writable_view.affected_oid,
                             'UPDATE'
                           )
                           or has_any_column_privilege(
                             effective_owner.oid,
                             writable_view.affected_oid,
                             'UPDATE'
                           )
                         )
                       )
                       or (
                         writable_view.actions & 16 <> 0
                         and has_table_privilege($1, invocation_relation.oid, 'DELETE')
                         and has_table_privilege(
                           effective_owner.oid,
                           writable_view.affected_oid,
                           'DELETE'
                         )
                       )
                     )
                 )
               )
             )
             or (
               not stored_expression.selectable
               and has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
               and (
                 stored_expression.binding !~ '^dml-rule:[^:]+:R:'
                 or has_parameter_privilege($1, 'session_replication_role', 'SET')
               )
               and (
                 stored_expression.binding !~ '^dml-rule:'
                 or (
                   stored_expression.binding ~ '^dml-rule:INSERT:'
                   and (
                     has_table_privilege($1, invocation_relation.oid, 'INSERT')
                     or has_any_column_privilege($1, invocation_relation.oid, 'INSERT')
                   )
                 )
                 or (
                   stored_expression.binding ~ '^dml-rule:UPDATE:'
                   and (
                     has_table_privilege($1, invocation_relation.oid, 'UPDATE')
                     or has_any_column_privilege($1, invocation_relation.oid, 'UPDATE')
                   )
                 )
                 or (
                   stored_expression.binding ~ '^dml-rule:DELETE:'
                   and has_table_privilege($1, invocation_relation.oid, 'DELETE')
                 )
               )
               and (
                 has_table_privilege($1, invocation_relation.oid, 'INSERT')
                 or exists (
                   select 1
                   from pg_catalog.pg_attribute as writable_column
                   where writable_column.attrelid = invocation_relation.oid
                     and writable_column.attnum > 0
                     and not writable_column.attisdropped
                     and writable_column.attgenerated = ''
                     and has_column_privilege(
                       $1,
                       invocation_relation.oid,
                       writable_column.attnum,
                       'INSERT'
                     )
                 )
                 or has_table_privilege($1, invocation_relation.oid, 'UPDATE')
                 or (
                   cardinality(stored_expression.update_columns) = 0
                   and exists (
                     select 1
                     from pg_catalog.pg_attribute as writable_column
                     where writable_column.attrelid = invocation_relation.oid
                       and writable_column.attnum > 0
                       and not writable_column.attisdropped
                       and writable_column.attgenerated = ''
                       and has_column_privilege(
                         $1,
                         invocation_relation.oid,
                         writable_column.attnum,
                         'UPDATE'
                       )
                   )
                 )
                 or exists (
                   select 1
                   from unnest(stored_expression.update_columns) as watched(attnum)
                   join pg_catalog.pg_attribute as expression_column
                     on expression_column.attrelid = relation.oid
                    and expression_column.attnum = watched.attnum
                   join pg_catalog.pg_attribute as invocation_column
                     on invocation_column.attrelid = invocation_relation.oid
                    and invocation_column.attname = expression_column.attname
                   where has_column_privilege(
                     $1,
                     invocation_relation.oid,
                     invocation_column.attnum,
                     'UPDATE'
                   )
                 )
                 or (
                   stored_expression.binding ~ '^dml-rule:DELETE:'
                   and has_table_privilege($1, invocation_relation.oid, 'DELETE')
                 )
               )
             )
             or exists (
               select 1
               from writable_view_paths as writable_view
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = writable_view.invocation_oid
               join pg_catalog.pg_namespace as view_namespace
                 on view_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   writable_view.effective_owner_oid,
                   runtime_role.oid
               )
               where not stored_expression.selectable
                 and writable_view.affected_oid = stored_expression.invocation_oid
                 and has_schema_privilege($1, view_namespace.oid, 'USAGE')
                 and (
                   stored_expression.binding !~ '^dml-rule:'
                   or case split_part(stored_expression.binding, ':', 3)
                     when 'O' then true
                     when 'R' then
                       has_parameter_privilege($1, 'session_replication_role', 'SET')
                     when 'A' then true
                     else false
                   end
                 )
                 and (
                   (
                     writable_view.actions & 8 <> 0
                     and (
                       stored_expression.binding !~ '^dml-rule:'
                       or stored_expression.binding ~ '^dml-rule:INSERT:'
                     )
                     and (
                       has_table_privilege($1, invocation_view.oid, 'INSERT')
                       or has_any_column_privilege($1, invocation_view.oid, 'INSERT')
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                     )
                   )
                   or (
                     writable_view.actions & 4 <> 0
                     and (
                       stored_expression.binding !~ '^dml-rule:'
                       or stored_expression.binding ~ '^dml-rule:UPDATE:'
                     )
                     and (
                       has_table_privilege($1, invocation_view.oid, 'UPDATE')
                       or (
                         cardinality(stored_expression.update_columns) = 0
                         and has_any_column_privilege($1, invocation_view.oid, 'UPDATE')
                       )
                       or exists (
                         select 1
                         from writable_view_columns as writable_column
                         join pg_catalog.pg_attribute as affected_column
                           on affected_column.attrelid = writable_column.affected_oid
                          and affected_column.attnum = writable_column.affected_attnum
                         join pg_catalog.pg_attribute as expression_column
                           on expression_column.attrelid = relation.oid
                          and expression_column.attname = affected_column.attname
                         where writable_column.invocation_oid = writable_view.invocation_oid
                           and writable_column.affected_oid = writable_view.affected_oid
                           and expression_column.attnum = any(
                             stored_expression.update_columns
                           )
                           and has_column_privilege(
                             $1,
                             invocation_view.oid,
                             writable_column.invocation_attnum,
                             'UPDATE'
                           )
                       )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                     )
                   )
                   or (
                     stored_expression.binding ~ '^dml-rule:DELETE:'
                     and writable_view.actions & 16 <> 0
                     and has_table_privilege($1, invocation_view.oid, 'DELETE')
                     and has_table_privilege(
                       effective_owner.oid,
                       writable_view.affected_oid,
                       'DELETE'
                     )
                   )
                 )
             )
             or exists (
               select 1
               from dml_rule_write_paths as rule_write
               join pg_catalog.pg_class as root_invocation_relation
                 on root_invocation_relation.oid = rule_write.invocation_oid
               join pg_catalog.pg_namespace as root_invocation_namespace
                 on root_invocation_namespace.oid = root_invocation_relation.relnamespace
               where not stored_expression.selectable
                 and rule_write.affected_oid = stored_expression.invocation_oid
                 and (
                   (
                     has_schema_privilege($1, root_invocation_namespace.oid, 'USAGE')
                     and case rule_write.invocation_action
                       when 'INSERT' then
                         has_table_privilege($1, root_invocation_relation.oid, 'INSERT')
                         or has_any_column_privilege(
                           $1,
                           root_invocation_relation.oid,
                           'INSERT'
                         )
                       when 'UPDATE' then
                         has_table_privilege($1, root_invocation_relation.oid, 'UPDATE')
                         or has_any_column_privilege(
                           $1,
                           root_invocation_relation.oid,
                           'UPDATE'
                         )
                       when 'DELETE' then
                         has_table_privilege($1, root_invocation_relation.oid, 'DELETE')
                       else false
                     end
                   )
                   or exists (
                     select 1
                     from writable_view_paths as rule_view
                     join pg_catalog.pg_class as rule_invocation_view
                       on rule_invocation_view.oid = rule_view.invocation_oid
                     join pg_catalog.pg_namespace as rule_view_namespace
                       on rule_view_namespace.oid = rule_invocation_view.relnamespace
                     join pg_catalog.pg_roles as rule_effective_owner
                       on rule_effective_owner.oid = coalesce(
                         rule_view.effective_owner_oid,
                         runtime_role.oid
                       )
                     where rule_view.affected_oid = rule_write.invocation_oid
                       and has_schema_privilege($1, rule_view_namespace.oid, 'USAGE')
                       and case rule_write.invocation_action
                         when 'INSERT' then
                           rule_view.actions & 8 <> 0
                           and (
                             has_table_privilege($1, rule_invocation_view.oid, 'INSERT')
                             or has_any_column_privilege(
                               $1,
                               rule_invocation_view.oid,
                               'INSERT'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                           )
                         when 'UPDATE' then
                           rule_view.actions & 4 <> 0
                           and (
                             has_table_privilege($1, rule_invocation_view.oid, 'UPDATE')
                             or has_any_column_privilege(
                               $1,
                               rule_invocation_view.oid,
                               'UPDATE'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                           )
                         when 'DELETE' then
                           rule_view.actions & 16 <> 0
                           and has_table_privilege($1, rule_invocation_view.oid, 'DELETE')
                           and has_table_privilege(
                             rule_effective_owner.oid,
                             rule_write.invocation_oid,
                             'DELETE'
                           )
                         else false
                       end
                   )
                 )
                 and (
                   rule_write.allowed_modes & 1 <> 0
                   or (
                     rule_write.allowed_modes & 2 <> 0
                     and has_parameter_privilege($1, 'session_replication_role', 'SET')
                   )
                 )
                 and (
                   (
                     stored_expression.binding !~ '^dml-rule:'
                     and rule_write.affected_action in ('INSERT', 'UPDATE')
                   )
                   or (
                     stored_expression.binding ~ '^dml-rule:'
                     and split_part(stored_expression.binding, ':', 2)
                       = rule_write.affected_action
                     and case split_part(stored_expression.binding, ':', 3)
                       when 'O' then rule_write.allowed_modes & 1 <> 0
                       when 'R' then
                         rule_write.allowed_modes & 2 <> 0
                         and has_parameter_privilege($1, 'session_replication_role', 'SET')
                       when 'A' then true
                       else false
                     end
                   )
                 )
             )
             or exists (
               select 1
               from referential_write_paths as cascade
               join pg_catalog.pg_class as root_invocation_relation
                 on root_invocation_relation.oid = cascade.invocation_oid
               join pg_catalog.pg_namespace as root_invocation_namespace
                 on root_invocation_namespace.oid = root_invocation_relation.relnamespace
               where not stored_expression.selectable
                 and stored_expression.binding !~ '^dml-rule:'
                 and cascade.affected_action = 'UPDATE'
                 and cascade.affected_oid = stored_expression.invocation_oid
                 and has_schema_privilege($1, root_invocation_namespace.oid, 'USAGE')
                 and (
                   (
                     cascade.invocation_action = 'DELETE'
                     and has_table_privilege($1, root_invocation_relation.oid, 'DELETE')
                   )
                   or (
                     cascade.invocation_action = 'UPDATE'
                     and (
                       has_table_privilege($1, root_invocation_relation.oid, 'UPDATE')
                       or exists (
                         select 1
                         from unnest(cascade.invocation_columns) as changed(attnum)
                         join pg_catalog.pg_attribute as referenced_column
                           on referenced_column.attrelid = cascade.invocation_relation_oid
                          and referenced_column.attnum = changed.attnum
                         join pg_catalog.pg_attribute as root_invocation_column
                           on root_invocation_column.attrelid = root_invocation_relation.oid
                          and root_invocation_column.attname = referenced_column.attname
                         where has_column_privilege(
                           $1,
                           root_invocation_relation.oid,
                           root_invocation_column.attnum,
                           'UPDATE'
                         )
                       )
                     )
                   )
                 )
                 and (
                   cardinality(stored_expression.update_columns) = 0
                   or exists (
                     select 1
                     from unnest(cascade.affected_columns) as changed(attnum)
                     join pg_catalog.pg_attribute as affected_column
                       on affected_column.attrelid = cascade.affected_oid
                      and affected_column.attnum = changed.attnum
                     join pg_catalog.pg_attribute as expression_column
                       on expression_column.attrelid = relation.oid
                      and expression_column.attname = affected_column.attname
                     where expression_column.attnum = any(stored_expression.update_columns)
                       and (
                         stored_expression.binding !~ '^column-default:'
                         or cascade.affected_uses_default
                       )
                   )
                 )
             )
           )
         order by 1
       ) as stored_expression_bindings,
       array(
         select distinct format(
           '%I.%I:%I',
           relation_namespace.nspname,
           relation.relname,
           audited_trigger.tgname
         )
         from pg_catalog.pg_trigger as audited_trigger
         join trigger_routine_dependencies as trigger_dependency
           on trigger_dependency.trigger_oid = audited_trigger.oid
          and trigger_dependency.routine_oid = routine.oid
         join pg_catalog.pg_class as relation on relation.oid = audited_trigger.tgrelid
         join pg_catalog.pg_namespace as relation_namespace
           on relation_namespace.oid = relation.relnamespace
         where not audited_trigger.tgisinternal
           and (
             audited_trigger.tgenabled in ('O', 'A')
             or (
               audited_trigger.tgenabled = 'R'
               and has_parameter_privilege($1, 'session_replication_role', 'SET')
             )
           )
           and relation_namespace.nspname = any($2::text[])
           and (
             exists (
             select 1
             from (
               select relation.oid
               union
               select ancestor.oid
               from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
             ) as ancestor
             join pg_catalog.pg_class as invocation_relation
               on invocation_relation.oid = ancestor.oid
             join pg_catalog.pg_namespace as invocation_namespace
               on invocation_namespace.oid = invocation_relation.relnamespace
             where has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
               and (
                 invocation_relation.oid = relation.oid
                 or audited_trigger.tgtype & 1 <> 0
               )
               and (
                 (
                   audited_trigger.tgtype & 4 <> 0
                   and (
                     has_table_privilege($1, invocation_relation.oid, 'INSERT')
                     or has_any_column_privilege($1, invocation_relation.oid, 'INSERT')
                   )
                 )
                 or (
                   audited_trigger.tgtype & 8 <> 0
                   and has_table_privilege($1, invocation_relation.oid, 'DELETE')
                 )
                 or (
                   audited_trigger.tgtype & 16 <> 0
                   and (
                     has_table_privilege($1, invocation_relation.oid, 'UPDATE')
                     or (
                       cardinality(audited_trigger.tgattr::smallint[]) = 0
                       and has_any_column_privilege($1, invocation_relation.oid, 'UPDATE')
                     )
                     or exists (
                       select 1
                       from unnest(audited_trigger.tgattr::smallint[]) as watched(attnum)
                       join pg_catalog.pg_attribute as trigger_column
                         on trigger_column.attrelid = relation.oid
                        and trigger_column.attnum = watched.attnum
                       join pg_catalog.pg_attribute as invocation_column
                         on invocation_column.attrelid = invocation_relation.oid
                        and invocation_column.attname = trigger_column.attname
                       where has_column_privilege(
                         $1,
                         invocation_relation.oid,
                         invocation_column.attnum,
                         'UPDATE'
                       )
                     )
                   )
                 )
                 or (
                   audited_trigger.tgtype & 32 <> 0
                   and has_table_privilege($1, invocation_relation.oid, 'TRUNCATE')
                 )
                 or (
                   invocation_relation.oid <> relation.oid
                   and audited_trigger.tgtype & 1 <> 0
                   and audited_trigger.tgtype & 12 <> 0
                   and exists (
                     select 1
                     from pg_catalog.pg_partitioned_table as partitioned
                     where partitioned.partrelid = invocation_relation.oid
                       and (
                         has_table_privilege($1, invocation_relation.oid, 'UPDATE')
                         or exists (
                           select 1
                           from unnest(partitioned.partattrs) as key(attnum)
                           where key.attnum <> 0
                             and has_column_privilege(
                               $1,
                               invocation_relation.oid,
                               key.attnum,
                               'UPDATE'
                             )
                         )
                         or (
                           0 = any(partitioned.partattrs)
                           and has_any_column_privilege(
                             $1,
                             invocation_relation.oid,
                             'UPDATE'
                           )
                         )
                       )
                   )
                 )
               )
             )
             or exists (
               select 1
               from writable_view_paths as writable_view
               join pg_catalog.pg_class as invocation_view
                 on invocation_view.oid = writable_view.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_view.relnamespace
               join pg_catalog.pg_roles as effective_owner
                 on effective_owner.oid = coalesce(
                   writable_view.effective_owner_oid,
                   runtime_role.oid
                 )
               where writable_view.affected_oid in (
                   select relation.oid
                   union
                   select ancestor.oid
                   from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
                 )
                 and (
                   writable_view.affected_oid = relation.oid
                   or audited_trigger.tgtype & 1 <> 0
                 )
                 and has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
                 and (
                   (
                     audited_trigger.tgtype & 4 <> 0
                     and writable_view.actions & 8 <> 0
                     and (
                       has_table_privilege($1, invocation_view.oid, 'INSERT')
                       or has_any_column_privilege($1, invocation_view.oid, 'INSERT')
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'INSERT'
                       )
                     )
                   )
                   or (
                     audited_trigger.tgtype & 8 <> 0
                     and writable_view.actions & 16 <> 0
                     and has_table_privilege($1, invocation_view.oid, 'DELETE')
                     and has_table_privilege(
                       effective_owner.oid,
                       writable_view.affected_oid,
                       'DELETE'
                     )
                   )
                   or (
                     audited_trigger.tgtype & 16 <> 0
                     and writable_view.actions & 4 <> 0
                     and (
                       has_table_privilege($1, invocation_view.oid, 'UPDATE')
                       or (
                         cardinality(audited_trigger.tgattr::smallint[]) = 0
                         and has_any_column_privilege($1, invocation_view.oid, 'UPDATE')
                       )
                       or exists (
                         select 1
                         from writable_view_columns as writable_column
                         join pg_catalog.pg_attribute as affected_column
                           on affected_column.attrelid = writable_column.affected_oid
                          and affected_column.attnum = writable_column.affected_attnum
                         join pg_catalog.pg_attribute as trigger_column
                           on trigger_column.attrelid = relation.oid
                          and trigger_column.attname = affected_column.attname
                         where writable_column.invocation_oid = writable_view.invocation_oid
                           and writable_column.affected_oid = writable_view.affected_oid
                           and trigger_column.attnum = any(
                             audited_trigger.tgattr::smallint[]
                           )
                           and has_column_privilege(
                             $1,
                             invocation_view.oid,
                             writable_column.invocation_attnum,
                             'UPDATE'
                           )
                       )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                     )
                   )
                   or (
                     writable_view.affected_oid <> relation.oid
                     and audited_trigger.tgtype & 1 <> 0
                     and audited_trigger.tgtype & 12 <> 0
                     and writable_view.actions & 4 <> 0
                     and exists (
                       select 1
                       from pg_catalog.pg_partitioned_table as partitioned
                       where partitioned.partrelid = writable_view.affected_oid
                         and (
                           has_table_privilege($1, invocation_view.oid, 'UPDATE')
                           or exists (
                             select 1
                             from writable_view_columns as writable_column
                             where writable_column.invocation_oid = writable_view.invocation_oid
                               and writable_column.affected_oid = writable_view.affected_oid
                               and (
                                 writable_column.affected_attnum = any(partitioned.partattrs)
                                 or 0 = any(partitioned.partattrs)
                               )
                               and has_column_privilege(
                                 $1,
                                 invocation_view.oid,
                                 writable_column.invocation_attnum,
                                 'UPDATE'
                               )
                           )
                         )
                     )
                     and (
                       has_table_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                       or has_any_column_privilege(
                         effective_owner.oid,
                         writable_view.affected_oid,
                         'UPDATE'
                       )
                     )
                   )
                 )
             )
             or exists (
               select 1
               from dml_rule_write_paths as rule_write
               join pg_catalog.pg_class as root_invocation_relation
                 on root_invocation_relation.oid = rule_write.invocation_oid
               join pg_catalog.pg_namespace as root_invocation_namespace
                 on root_invocation_namespace.oid = root_invocation_relation.relnamespace
               where rule_write.affected_oid in (
                   select relation.oid
                   union
                   select ancestor.oid
                   from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
                 )
                 and (
                   rule_write.affected_oid = relation.oid
                   or audited_trigger.tgtype & 1 <> 0
                 )
                 and (
                   (
                     has_schema_privilege($1, root_invocation_namespace.oid, 'USAGE')
                     and case rule_write.invocation_action
                       when 'INSERT' then
                         has_table_privilege($1, root_invocation_relation.oid, 'INSERT')
                         or has_any_column_privilege(
                           $1,
                           root_invocation_relation.oid,
                           'INSERT'
                         )
                       when 'UPDATE' then
                         has_table_privilege($1, root_invocation_relation.oid, 'UPDATE')
                         or has_any_column_privilege(
                           $1,
                           root_invocation_relation.oid,
                           'UPDATE'
                         )
                       when 'DELETE' then
                         has_table_privilege($1, root_invocation_relation.oid, 'DELETE')
                       else false
                     end
                   )
                   or exists (
                     select 1
                     from writable_view_paths as rule_view
                     join pg_catalog.pg_class as rule_invocation_view
                       on rule_invocation_view.oid = rule_view.invocation_oid
                     join pg_catalog.pg_namespace as rule_view_namespace
                       on rule_view_namespace.oid = rule_invocation_view.relnamespace
                     join pg_catalog.pg_roles as rule_effective_owner
                       on rule_effective_owner.oid = coalesce(
                         rule_view.effective_owner_oid,
                         runtime_role.oid
                       )
                     where rule_view.affected_oid = rule_write.invocation_oid
                       and has_schema_privilege($1, rule_view_namespace.oid, 'USAGE')
                       and case rule_write.invocation_action
                         when 'INSERT' then
                           rule_view.actions & 8 <> 0
                           and (
                             has_table_privilege($1, rule_invocation_view.oid, 'INSERT')
                             or has_any_column_privilege(
                               $1,
                               rule_invocation_view.oid,
                               'INSERT'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'INSERT'
                             )
                           )
                         when 'UPDATE' then
                           rule_view.actions & 4 <> 0
                           and (
                             has_table_privilege($1, rule_invocation_view.oid, 'UPDATE')
                             or has_any_column_privilege(
                               $1,
                               rule_invocation_view.oid,
                               'UPDATE'
                             )
                           )
                           and (
                             has_table_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                             or has_any_column_privilege(
                               rule_effective_owner.oid,
                               rule_write.invocation_oid,
                               'UPDATE'
                             )
                           )
                         when 'DELETE' then
                           rule_view.actions & 16 <> 0
                           and has_table_privilege($1, rule_invocation_view.oid, 'DELETE')
                           and has_table_privilege(
                             rule_effective_owner.oid,
                             rule_write.invocation_oid,
                             'DELETE'
                           )
                         else false
                       end
                   )
                 )
                 and case audited_trigger.tgenabled
                   when 'O' then rule_write.allowed_modes & 1 <> 0
                   when 'R' then
                     rule_write.allowed_modes & 2 <> 0
                     and has_parameter_privilege($1, 'session_replication_role', 'SET')
                   when 'A' then
                     rule_write.allowed_modes & 1 <> 0
                     or (
                       rule_write.allowed_modes & 2 <> 0
                       and has_parameter_privilege($1, 'session_replication_role', 'SET')
                     )
                   else false
                 end
                 and (
                   (rule_write.affected_action = 'INSERT' and audited_trigger.tgtype & 4 <> 0)
                   or (
                     rule_write.affected_action = 'DELETE'
                     and audited_trigger.tgtype & 8 <> 0
                   )
                   or (
                     rule_write.affected_action = 'UPDATE'
                     and audited_trigger.tgtype & 16 <> 0
                   )
                 )
             )
             or exists (
               select 1
               from referential_write_paths as cascade
               join pg_catalog.pg_class as invocation_relation
                 on invocation_relation.oid = cascade.invocation_oid
               join pg_catalog.pg_namespace as invocation_namespace
                 on invocation_namespace.oid = invocation_relation.relnamespace
               where cascade.affected_oid in (
                   select relation.oid
                   union
                   select ancestor.oid
                   from pg_catalog.pg_partition_ancestors(relation.oid) as ancestor(oid)
                 )
                 and (
                   cascade.affected_oid = relation.oid
                   or audited_trigger.tgtype & 1 <> 0
                 )
                 and has_schema_privilege($1, invocation_namespace.oid, 'USAGE')
                 and (
                   (
                     cascade.invocation_action = 'DELETE'
                     and has_table_privilege($1, invocation_relation.oid, 'DELETE')
                   )
                   or (
                     cascade.invocation_action = 'UPDATE'
                     and (
                       has_table_privilege($1, invocation_relation.oid, 'UPDATE')
                       or exists (
                         select 1
                         from unnest(cascade.invocation_columns) as changed(attnum)
                         join pg_catalog.pg_attribute as referenced_column
                           on referenced_column.attrelid = cascade.invocation_relation_oid
                          and referenced_column.attnum = changed.attnum
                         join pg_catalog.pg_attribute as invocation_column
                           on invocation_column.attrelid = invocation_relation.oid
                          and invocation_column.attname = referenced_column.attname
                         where has_column_privilege(
                           $1,
                           invocation_relation.oid,
                           invocation_column.attnum,
                           'UPDATE'
                         )
                       )
                     )
                   )
                 )
                 and (
                   (
                     cascade.affected_action = 'DELETE'
                     and audited_trigger.tgtype & 8 <> 0
                   )
                   or (
                     cascade.affected_action = 'UPDATE'
                     and audited_trigger.tgtype & 16 <> 0
                     and (
                       cardinality(audited_trigger.tgattr::smallint[]) = 0
                       or exists (
                         select 1
                         from unnest(cascade.affected_columns) as changed(attnum)
                         join pg_catalog.pg_attribute as affected_column
                           on affected_column.attrelid = cascade.affected_oid
                          and affected_column.attnum = changed.attnum
                         join pg_catalog.pg_attribute as trigger_column
                           on trigger_column.attrelid = relation.oid
                          and trigger_column.attname = affected_column.attname
                         where trigger_column.attnum = any(
                           audited_trigger.tgattr::smallint[]
                         )
                       )
                     )
                   )
                 )
             )
           )
         order by 1
       ) as trigger_bindings,
       array(
         select distinct format(
           'event-trigger:%I:%s%s',
           event_trigger.evtname,
           event_trigger.evtevent,
           case
             when event_trigger.evttags is null then ''
             else format('[%s]', array_to_string(event_trigger.evttags, ','))
           end
         )
         from pg_catalog.pg_event_trigger as event_trigger
         where event_trigger.evtfoid = routine.oid
           and (
             event_trigger.evtenabled in ('O', 'A')
             or (
               event_trigger.evtenabled = 'R'
               and has_parameter_privilege($1, 'session_replication_role', 'SET')
             )
           )
           and (
             event_trigger.evtevent = 'login'
             or exists (
               select 1
               from role_ddl_command_tags as authority
               where authority.role_oid = runtime_role.oid
                 and authority.event = event_trigger.evtevent
                 and (
                   event_trigger.evttags is null
                   or authority.tag = any(event_trigger.evttags)
                 )
             )
           )
         order by 1
       ) as event_trigger_bindings
     from pg_catalog.pg_proc as routine
     join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
     join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
     join pg_catalog.pg_roles as runtime_role on runtime_role.rolname = $1
     where namespace.nspname = any($2::text[])
     order by namespace.nspname, routine.proname, routine.oid`,
    [runtimeRole, schemaNames],
  );
  const tables = await admin.query<TablePrivilegeRow>(
    `with recursive view_dependencies(view_oid, referenced_oid, effective_owner_oid) as (
       select
         rewrite.ev_class,
         dependency.refobjid,
         case
           when coalesce(
             (
               select option.option_value::boolean
               from pg_catalog.pg_options_to_table(view_relation.reloptions) as option
               where option.option_name = 'security_invoker'
             ),
             false
           )
             then runtime_role.oid
           else view_relation.relowner
         end
       from pg_catalog.pg_rewrite as rewrite
       join pg_catalog.pg_class as view_relation on view_relation.oid = rewrite.ev_class
       join pg_catalog.pg_roles as runtime_role on runtime_role.rolname = $1
       join pg_catalog.pg_depend as dependency
         on dependency.classid = 'pg_catalog.pg_rewrite'::regclass
        and dependency.objid = rewrite.oid
        and dependency.refclassid = 'pg_catalog.pg_class'::regclass
       where rewrite.rulename = '_RETURN'
         and dependency.deptype = 'n'
         and dependency.refobjid <> rewrite.ev_class
       union
       select
         dependency.view_oid,
         nested_dependency.refobjid,
         case
           when coalesce(
             (
               select option.option_value::boolean
               from pg_catalog.pg_options_to_table(nested_view.reloptions) as option
               where option.option_name = 'security_invoker'
             ),
             false
           )
             then dependency.effective_owner_oid
           else nested_view.relowner
         end
       from view_dependencies as dependency
       join pg_catalog.pg_class as nested_view on nested_view.oid = dependency.referenced_oid
       join pg_catalog.pg_rewrite as nested_rewrite
         on nested_rewrite.ev_class = nested_view.oid
        and nested_rewrite.rulename = '_RETURN'
       join pg_catalog.pg_depend as nested_dependency
         on nested_dependency.classid = 'pg_catalog.pg_rewrite'::regclass
        and nested_dependency.objid = nested_rewrite.oid
        and nested_dependency.refclassid = 'pg_catalog.pg_class'::regclass
       where nested_view.relkind = 'v'
         and nested_dependency.deptype = 'n'
         and nested_dependency.refobjid <> nested_view.oid
     )
     select
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
       owner.rolbypassrls as owner_bypass_rls,
       exists (
         select 1
         from view_dependencies as dependency
         join pg_catalog.pg_class as referenced_relation
           on referenced_relation.oid = dependency.referenced_oid
         join pg_catalog.pg_roles as effective_owner
           on effective_owner.oid = dependency.effective_owner_oid
         where dependency.view_oid = relation.oid
           and referenced_relation.relkind in ('r', 'p')
           and referenced_relation.relrowsecurity
           and not referenced_relation.relforcerowsecurity
           and (
             referenced_relation.relowner = dependency.effective_owner_oid
             or effective_owner.rolbypassrls
             or effective_owner.rolsuper
             or pg_has_role(
               dependency.effective_owner_oid,
               referenced_relation.relowner,
               'USAGE'
             )
           )
       ) as owner_context_rls_bypass,
       owner.rolsuper as owner_superuser,
       relation.relrowsecurity as rls_enabled,
       relation.relforcerowsecurity as rls_forced,
       coalesce(
         (
           select option.option_value::boolean
           from pg_catalog.pg_options_to_table(relation.reloptions) as option
           where option.option_name = 'security_invoker'
         ),
         false
       ) as security_invoker,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and (
           has_table_privilege($1, relation.oid, 'SELECT')
           or has_any_column_privilege($1, relation.oid, 'SELECT')
         )
       ) as select,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and (
           has_table_privilege($1, relation.oid, 'INSERT')
           or has_any_column_privilege($1, relation.oid, 'INSERT')
         )
       ) as insert,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and (
           has_table_privilege($1, relation.oid, 'UPDATE')
           or has_any_column_privilege($1, relation.oid, 'UPDATE')
         )
       ) as update,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_table_privilege($1, relation.oid, 'DELETE')
       ) as delete,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_table_privilege($1, relation.oid, 'TRUNCATE')
       ) as truncate,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and (
           has_table_privilege($1, relation.oid, 'REFERENCES')
           or has_any_column_privilege($1, relation.oid, 'REFERENCES')
         )
       ) as references,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_table_privilege($1, relation.oid, 'TRIGGER')
       ) as trigger,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_table_privilege($1, relation.oid, 'MAINTAIN')
       ) as maintain
     from pg_catalog.pg_class as relation
     join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
     join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
     where relation.relkind in ('r', 'p', 'v', 'm', 'f')
       and namespace.nspname = any($2::text[])
     order by namespace.nspname, relation.relname`,
    [runtimeRole, schemaNames],
  );
  const types = await admin.query<TypePrivilegeRow>(
    `select
       namespace.nspname as schema,
       audited_type.typname as type,
       case audited_type.typtype
         when 'b' then 'base'
         when 'c' then 'composite'
         when 'd' then 'domain'
         when 'e' then 'enum'
         when 'm' then 'multirange'
         when 'r' then 'range'
       end as kind,
       owner.rolname as owner
     from pg_catalog.pg_type as audited_type
     join pg_catalog.pg_namespace as namespace on namespace.oid = audited_type.typnamespace
     join pg_catalog.pg_roles as owner on owner.oid = audited_type.typowner
     where (
         audited_type.typtype in ('d', 'e', 'm', 'r')
         or (audited_type.typtype = 'b' and audited_type.typelem = 0)
         or (
           audited_type.typtype = 'c'
           and exists (
             select 1
             from pg_catalog.pg_class as composite_relation
             where composite_relation.reltype = audited_type.oid
               and composite_relation.relkind = 'c'
           )
         )
       )
       and namespace.nspname = any($1::text[])
     order by namespace.nspname, audited_type.typname`,
    [schemaNames],
  );
  const sequences = await admin.query<SequencePrivilegeRow>(
    `select
       namespace.nspname as schema,
       relation.relname as sequence,
       owner.rolname as owner,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_sequence_privilege($1, relation.oid, 'USAGE')
       ) as usage,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_sequence_privilege($1, relation.oid, 'SELECT')
       ) as select,
       (
         has_schema_privilege($1, namespace.oid, 'USAGE')
         and has_sequence_privilege($1, relation.oid, 'UPDATE')
       ) as update
     from pg_catalog.pg_class as relation
     join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
     join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
     where relation.relkind = 'S' and namespace.nspname = any($2::text[])
     order by namespace.nspname, relation.relname`,
    [runtimeRole, schemaNames],
  );
  const parameterPrivileges = await admin.query<ParameterPrivilegeRow>(
    `select
       parameter.parname as parameter,
       has_parameter_privilege($1, parameter.parname, 'ALTER SYSTEM') as alter_system,
       has_parameter_privilege($1, parameter.parname, 'SET') as set
     from pg_catalog.pg_parameter_acl as parameter
     where has_parameter_privilege($1, parameter.parname, 'ALTER SYSTEM')
        or has_parameter_privilege($1, parameter.parname, 'SET')
     order by parameter.parname`,
    [runtimeRole],
  );
  const grantOptions = await admin.query<GrantOptionRow>(
    `with recursive ${reachableRolesCte},
     audited_roles(role_oid, role, source) as (
       select
         candidate.oid,
         candidate.rolname,
         case when candidate.rolname = $1 then 'direct' else 'assumable' end
       from pg_catalog.pg_roles as candidate
       where candidate.oid in (select role_oid from reachable_roles)
     )
     select audited_role.role, audited_role.source, authority.grant_option
     from audited_roles as audited_role
     cross join lateral (
       select format('database:%I:%s', current_database(), privilege.name) as grant_option
       from (values ('CONNECT'::text), ('CREATE'::text), ('TEMPORARY'::text)) as privilege(name)
       where has_database_privilege(
         audited_role.role_oid,
         current_database(),
         privilege.name || ' WITH GRANT OPTION'
       )
       union all
       select format('schema:%I:%s', namespace.nspname, privilege.name)
       from pg_catalog.pg_namespace as namespace
       cross join (values ('CREATE'::text), ('USAGE'::text)) as privilege(name)
       where namespace.nspname = any($2::text[])
         and has_schema_privilege(
           audited_role.role_oid,
           namespace.oid,
           privilege.name || ' WITH GRANT OPTION'
         )
       union all
       select format(
         'relation:%I.%I:%s',
         namespace.nspname,
         relation.relname,
         privilege.name
       )
       from pg_catalog.pg_class as relation
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       cross join (
         values
           ('DELETE'::text),
           ('INSERT'::text),
           ('MAINTAIN'::text),
           ('REFERENCES'::text),
           ('SELECT'::text),
           ('TRIGGER'::text),
           ('TRUNCATE'::text),
           ('UPDATE'::text)
       ) as privilege(name)
       where namespace.nspname = any($2::text[])
         and relation.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_table_privilege(
           audited_role.role_oid,
           relation.oid,
           privilege.name || ' WITH GRANT OPTION'
         )
       union all
       select format(
         'column:%I.%I.%I:%s',
         namespace.nspname,
         relation.relname,
         attribute.attname,
         privilege.name
       )
       from pg_catalog.pg_class as relation
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       join pg_catalog.pg_attribute as attribute
         on attribute.attrelid = relation.oid
        and attribute.attnum > 0
        and not attribute.attisdropped
       cross join (
         values ('INSERT'::text), ('REFERENCES'::text), ('SELECT'::text), ('UPDATE'::text)
       ) as privilege(name)
       where namespace.nspname = any($2::text[])
         and relation.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_column_privilege(
           audited_role.role_oid,
           relation.oid,
           attribute.attnum,
           privilege.name || ' WITH GRANT OPTION'
         )
         and not has_table_privilege(
           audited_role.role_oid,
           relation.oid,
           privilege.name || ' WITH GRANT OPTION'
         )
       union all
       select format(
         'sequence:%I.%I:%s',
         namespace.nspname,
         relation.relname,
         privilege.name
       )
       from pg_catalog.pg_class as relation
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
       cross join (values ('SELECT'::text), ('UPDATE'::text), ('USAGE'::text)) as privilege(name)
       where namespace.nspname = any($2::text[])
         and relation.relkind = 'S'
         and has_sequence_privilege(
           audited_role.role_oid,
           relation.oid,
           privilege.name || ' WITH GRANT OPTION'
         )
       union all
       select format(
         'routine:%I.%I(%s):EXECUTE',
         namespace.nspname,
         routine.proname,
         pg_get_function_identity_arguments(routine.oid)
       )
       from pg_catalog.pg_proc as routine
       join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
       where namespace.nspname = any($2::text[])
         and has_function_privilege(
           audited_role.role_oid,
           routine.oid,
           'EXECUTE WITH GRANT OPTION'
         )
       union all
       select format('type:%I.%I:USAGE', namespace.nspname, audited_type.typname)
       from pg_catalog.pg_type as audited_type
       join pg_catalog.pg_namespace as namespace on namespace.oid = audited_type.typnamespace
       where namespace.nspname = any($2::text[])
         and (
           audited_type.typtype in ('d', 'e', 'm', 'r')
           or (audited_type.typtype = 'b' and audited_type.typelem = 0)
           or (
             audited_type.typtype = 'c'
             and exists (
               select 1
               from pg_catalog.pg_class as composite_relation
               where composite_relation.reltype = audited_type.oid
                 and composite_relation.relkind = 'c'
             )
           )
         )
         and has_type_privilege(
           audited_role.role_oid,
           audited_type.oid,
           'USAGE WITH GRANT OPTION'
         )
       union all
       select format('parameter:%s:%s', parameter.parname, privilege.name)
       from pg_catalog.pg_parameter_acl as parameter
       cross join (values ('ALTER SYSTEM'::text), ('SET'::text)) as privilege(name)
       where has_parameter_privilege(
         audited_role.role_oid,
         parameter.parname,
         privilege.name || ' WITH GRANT OPTION'
       )
       union all
       select format('language:%I:USAGE', language.lanname)
       from pg_catalog.pg_language as language
       where has_language_privilege(
         audited_role.role_oid,
         language.oid,
         'USAGE WITH GRANT OPTION'
       )
       union all
       select format('foreign-data-wrapper:%I:USAGE', wrapper.fdwname)
       from pg_catalog.pg_foreign_data_wrapper as wrapper
       where has_foreign_data_wrapper_privilege(
         audited_role.role_oid,
         wrapper.oid,
         'USAGE WITH GRANT OPTION'
       )
       union all
       select format('foreign-server:%I:USAGE', server.srvname)
       from pg_catalog.pg_foreign_server as server
       where has_server_privilege(
         audited_role.role_oid,
         server.oid,
         'USAGE WITH GRANT OPTION'
       )
       union all
       select format('tablespace:%I:CREATE', tablespace.spcname)
       from pg_catalog.pg_tablespace as tablespace
       where has_tablespace_privilege(
         audited_role.role_oid,
         tablespace.oid,
         'CREATE WITH GRANT OPTION'
       )
     ) as authority
     order by audited_role.role, audited_role.source, authority.grant_option`,
    [runtimeRole, schemaNames],
  );
  const defaultPrivileges = await admin.query<DefaultPrivilegeRow>(
    `with recursive ${reachableRolesCte},
     audit_owners as (
       select
         candidate.oid,
         candidate.rolname,
         has_database_privilege(candidate.oid, current_database(), 'CREATE')
           as can_create_schema,
         has_database_privilege(candidate.oid, current_database(), 'CREATE')
           or exists (
             select 1
             from pg_catalog.pg_namespace as namespace
             where namespace.nspname = any($2::text[])
               and (
                 namespace.nspowner = candidate.oid
                 or has_schema_privilege(candidate.oid, namespace.oid, 'CREATE')
               )
           ) as can_create_object
       from pg_catalog.pg_roles as candidate
       where has_database_privilege(candidate.oid, current_database(), 'CREATE')
          or exists (
            select 1
            from pg_catalog.pg_namespace as namespace
            where namespace.nspname = any($2::text[])
              and (
                namespace.nspowner = candidate.oid
                or has_schema_privilege(candidate.oid, namespace.oid, 'CREATE')
              )
          )
     ),
     object_types(catalog_code, default_code, object_type) as (
       values
         ('r'::"char", 'r'::"char", 'table'::text),
         ('S'::"char", 's'::"char", 'sequence'::text),
         ('f'::"char", 'f'::"char", 'function'::text),
         ('T'::"char", 'T'::"char", 'type'::text),
         ('n'::"char", 'n'::"char", 'schema'::text)
     ),
     global_acl as (
       select
         null::text as schema,
         owner.rolname as owner,
         object_types.object_type,
         coalesce(
           defaults.defaclacl,
           acldefault(object_types.default_code, owner.oid)
         ) as acl
       from audit_owners as owner
       cross join object_types
       left join pg_catalog.pg_default_acl as defaults
         on defaults.defaclrole = owner.oid
        and defaults.defaclnamespace = 0
        and defaults.defaclobjtype = object_types.catalog_code
       where (
         object_types.catalog_code = 'n'
         and owner.can_create_schema
       ) or (
         object_types.catalog_code <> 'n'
         and owner.can_create_object
       )
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
       join audit_owners as owner on owner.oid = defaults.defaclrole
       where namespace.nspname = any($2::text[])
         and (
           namespace.nspowner = owner.oid
           or has_schema_privilege(owner.oid, namespace.oid, 'CREATE')
         )
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
         or grantee.oid in (select role_oid from reachable_roles)
     order by
       expanded.schema nulls first,
       expanded.owner,
       object_type,
       grantee,
       privilege,
       source,
       grantable`,
    [runtimeRole, schemaNames],
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
      owner: databaseRow.owner,
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
    extensions: extensions.rows,
    foreignDataWrappers: foreignDataWrappers.rows,
    foreignServers: foreignServers.rows,
    grantOptions: grantOptions.rows.map(({ grant_option, role, source }) => ({
      authority: grant_option,
      role,
      source,
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
      canAdministerRole: membership.can_administer_role,
      canInheritRole: membership.can_inherit_role,
      canSetRole: membership.can_set_role,
      createSchemas: membership.create_schemas,
      databaseCreate: membership.database_create,
      databaseOwner: membership.database_owner,
      ownedExtensions: membership.owned_extensions,
      ownedForeignDataWrappers: membership.owned_foreign_data_wrappers,
      ownedForeignServers: membership.owned_foreign_servers,
      ownedPublications: membership.owned_publications,
      ownedSubscriptions: membership.owned_subscriptions,
      ownedRelations: membership.owned_relations,
      ownedRoutines: membership.owned_routines,
      ownedSchemas: membership.owned_schemas,
      ownedTypes: membership.owned_types,
      parameterPrivileges: membership.parameter_privileges,
      predefinedRole: membership.predefined_role,
      relationPrivilegeSchemas: membership.relation_privilege_schemas,
      role: membership.role,
      securityDefinerEventTriggerBindings: membership.security_definer_event_trigger_bindings,
      securityDefinerAggregateBindings: membership.security_definer_aggregate_bindings,
      securityDefinerOperatorBindings: membership.security_definer_operator_bindings,
      securityDefinerPolicyBindings: membership.security_definer_policy_bindings,
      securityDefinerRoutines: membership.security_definer_routines,
      securityDefinerStoredExpressionBindings:
        membership.security_definer_stored_expression_bindings,
      securityDefinerTriggerBindings: membership.security_definer_trigger_bindings,
    })),
    parameterPrivileges: parameterPrivileges.rows.map((privilege) => ({
      alterSystem: privilege.alter_system,
      parameter: privilege.parameter,
      set: privilege.set,
    })),
    publications: publications.rows,
    subscriptions: subscriptions.rows,
    role: {
      bypassRls: roleRow.bypass_rls,
      canCreateDatabases: roleRow.can_create_databases,
      canCreateRoles: roleRow.can_create_roles,
      canLogin: roleRow.can_login,
      inherit: roleRow.inherit,
      predefinedRole: roleRow.predefined_role,
      replication: roleRow.replication,
      superuser: roleRow.superuser,
    },
    routines: routines.rows.map((routine) => ({
      aggregateBindings: routine.aggregate_bindings,
      eventTriggerBindings: routine.event_trigger_bindings,
      executable: routine.executable,
      identityArguments: routine.identity_arguments,
      kind: routine.kind,
      owner: routine.owner,
      operatorBindings: routine.operator_bindings,
      policyBindings: routine.policy_bindings,
      routine: routine.routine,
      schema: routine.schema,
      securityDefiner: routine.security_definer,
      storedExpressionBindings: routine.stored_expression_bindings,
      triggerBindings: routine.trigger_bindings,
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
      ownerBypassRls: table.owner_bypass_rls,
      ownerContextRlsBypass: table.owner_context_rls_bypass,
      ownerSuperuser: table.owner_superuser,
      privileges: {
        delete: table.delete,
        insert: table.insert,
        maintain: table.maintain,
        references: table.references,
        select: table.select,
        trigger: table.trigger,
        truncate: table.truncate,
        update: table.update,
      },
      rlsEnabled: table.rls_enabled,
      rlsForced: table.rls_forced,
      schema: table.schema,
      securityInvoker: table.security_invoker,
      table: table.table,
    })),
    trustedContext: {
      legalEntitySettingRetainedAfterRollback: legalEntity.retainedAfterRollback,
      legalEntitySettingSettable: legalEntity.settable,
      tenantSettingRetainedAfterRollback: tenant.retainedAfterRollback,
      tenantSettingSettable: tenant.settable,
      transactionLocal: true,
    },
    types: types.rows,
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
            error instanceof DatabaseTargetMismatchError ||
            error instanceof DatabaseSessionIdentityError
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
          return buildDatabaseTrustBoundaryReport(await collectSnapshot(admin, runtime));
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
    const exit = await Effect.runPromiseExit(auditDatabaseTrustBoundaries());
    if (Exit.isFailure(exit)) {
      console.error(getDatabaseTrustBoundaryFailureMessage(exit.cause));
      process.exitCode = 1;
    } else {
      const report = exit.value;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      console.log(
        `Database trust-boundary evidence written with ${report.findings.length} finding(s).`,
      );
    }
  } catch (error) {
    console.error(
      error instanceof DatabaseTrustBoundaryAuditError ? error.reason : genericAuditFailureMessage,
    );
    process.exitCode = 1;
  }
}
