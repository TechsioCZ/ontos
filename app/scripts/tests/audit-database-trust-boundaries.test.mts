import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Cause } from 'effect';
import { Client } from 'pg';
import {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError,
  getEffectiveDatabaseEndpoint,
  getDatabaseTrustBoundaryFailureMessage,
  hasTrustedContextValue,
  type DatabaseTrustBoundarySnapshot,
} from '../audit-database-trust-boundaries.mts';

const ordinaryRole = {
  bypassRls: false,
  canCreateDatabases: false,
  canCreateRoles: false,
  canLogin: true,
  inherit: false,
  predefinedRole: false,
  replication: false,
  superuser: false,
};

const snapshot = {
  administrativeRole: 'ontos_admin',
  database: 'ontos',
  databasePrivileges: { connect: true, create: false, owner: false, temporary: true },
  defaultPrivileges: [
    {
      grantee: 'analytics_reader',
      grantable: false,
      objectType: 'function',
      owner: 'ontos_admin',
      privilege: 'EXECUTE',
      schema: null,
      source: 'inherited',
    },
    {
      grantee: 'ontos_runtime',
      grantable: false,
      objectType: 'sequence',
      owner: 'ontos_admin',
      privilege: 'USAGE',
      schema: 'contacts',
      source: 'direct',
    },
    {
      grantee: 'PUBLIC',
      grantable: false,
      objectType: 'table',
      owner: 'ontos_admin',
      privilege: 'SELECT',
      schema: 'auth',
      source: 'public',
    },
  ],
  extensions: [],
  foreignDataWrappers: [],
  foreignServers: [],
  grantOptions: [],
  memberships: [],
  parameterPrivileges: [],
  role: ordinaryRole,
  runtimeRole: 'ontos_runtime',
  schemas: [
    { create: false, owner: 'ontos_admin', schema: 'contacts', usage: true },
    { create: false, owner: 'ontos_admin', schema: 'auth', usage: true },
    { create: false, owner: 'ontos_admin', schema: 'core', usage: true },
  ],
  sequences: [
    {
      owner: 'ontos_admin',
      privileges: { select: true, update: false, usage: true },
      schema: 'contacts',
      sequence: 'customers_id_seq',
    },
  ],
  routines: [],
  tables: [
    {
      kind: 'table',
      owner: 'ontos_admin',
      privileges: {
        delete: true,
        insert: true,
        maintain: false,
        references: false,
        select: true,
        trigger: false,
        truncate: false,
        update: true,
      },
      rlsEnabled: true,
      rlsForced: true,
      schema: 'contacts',
      table: 'customers',
    },
    {
      kind: 'table',
      owner: 'ontos_admin',
      privileges: {
        delete: true,
        insert: true,
        maintain: false,
        references: false,
        select: true,
        trigger: false,
        truncate: false,
        update: true,
      },
      rlsEnabled: false,
      rlsForced: false,
      schema: 'auth',
      table: 'user',
    },
    {
      kind: 'table',
      owner: 'ontos_admin',
      privileges: {
        delete: true,
        insert: true,
        maintain: false,
        references: false,
        select: true,
        trigger: false,
        truncate: false,
        update: true,
      },
      rlsEnabled: false,
      rlsForced: false,
      schema: 'core',
      table: 'tenants',
    },
  ],
  types: [],
  trustedContext: {
    legalEntitySettingRetainedAfterRollback: false,
    legalEntitySettingSettable: true,
    tenantSettingRetainedAfterRollback: false,
    tenantSettingSettable: true,
    transactionLocal: true,
  },
} satisfies DatabaseTrustBoundarySnapshot;

test('builds deterministic current-state evidence and identifies the material trust gaps', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    schemas: snapshot.schemas.toReversed(),
    tables: snapshot.tables.toReversed(),
  });

  assert.deepEqual(
    report.schemas.map(({ schema }) => schema),
    ['auth', 'contacts', 'core'],
  );
  assert.deepEqual(
    report.tables.map(({ schema, table }) => `${schema}.${table}`),
    ['auth.user', 'contacts.customers', 'core.tenants'],
  );
  assert.deepEqual(
    report.defaultPrivileges.map(({ grantee, schema, source }) => `${source}:${grantee}:${schema}`),
    ['inherited:analytics_reader:null', 'public:PUBLIC:auth', 'direct:ontos_runtime:contacts'],
  );
  assert.deepEqual(
    report.findings.map(({ code, severity }) => `${severity}:${code}`),
    ['high:runtime_role_can_forge_trusted_context', 'high:runtime_role_has_cross_schema_dml'],
  );
  assert.deepEqual(report.summary, {
    auditedSchemaCount: 3,
    defaultPrivilegeCount: 3,
    dmlSchemaCount: 3,
    dmlTableCount: 3,
    extensionCount: 0,
    findingCount: 2,
    foreignDataWrapperCount: 0,
    foreignServerCount: 0,
    grantOptionCount: 0,
    parameterPrivilegeCount: 0,
    privilegedOwnerViewCount: 0,
    routineCount: 0,
    securityDefinerExecutableCount: 0,
    sequenceCount: 1,
    tableCount: 3,
    typeCount: 0,
  });
  assert.equal(report.schemaVersion, 1);
});

test('orders audit evidence by code units rather than locale collation', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    types: [
      { kind: 'enum', owner: 'ontos_admin', schema: 'ärea', type: 'status' },
      { kind: 'enum', owner: 'ontos_admin', schema: 'zeta', type: 'status' },
    ],
  });

  assert.deepEqual(
    report.types.map(({ schema, type }) => `${schema}.${type}`),
    ['zeta.status', 'ärea.status'],
  );
});

test('totally orders default privileges from distinct creator roles', () => {
  const sharedPrivilege = {
    grantee: 'PUBLIC',
    grantable: false,
    objectType: 'function',
    privilege: 'EXECUTE',
    schema: null,
    source: 'public' as const,
  };
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    defaultPrivileges: [
      { ...sharedPrivilege, owner: 'zeta_owner' },
      { ...sharedPrivilege, owner: 'alpha_owner' },
    ],
  });

  assert.deepEqual(
    report.defaultPrivileges.map(({ owner }) => owner),
    ['alpha_owner', 'zeta_owner'],
  );
});

test('extracts typed audit failures from an Effect cause', () => {
  const reason = 'DATABASE_ADMIN_URL and DATABASE_URL must use distinct roles';

  assert.equal(
    getDatabaseTrustBoundaryFailureMessage(
      Cause.fail(new DatabaseTrustBoundaryAuditError({ reason })),
    ),
    reason,
  );
  assert.equal(
    getDatabaseTrustBoundaryFailureMessage(Cause.die(new Error('driver defect'))),
    'Database trust-boundary audit failed',
  );
});

test('treats any non-empty post-rollback trusted context as retained', () => {
  assert.equal(hasTrustedContextValue(null), false);
  assert.equal(hasTrustedContextValue(''), false);
  assert.equal(hasTrustedContextValue('pre-existing-tenant-context'), true);
});

test('reports privilege escalation paths without embedding credentials or context values', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'ontos_admin',
        securityDefinerRoutines: [],
      },
    ],
    role: { ...snapshot.role, bypassRls: true },
    schemas: [
      ...snapshot.schemas,
      { create: true, owner: 'empty_owner', schema: 'empty', usage: true },
    ],
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    [
      'runtime_role_is_privileged',
      'runtime_role_can_assume_administrative_role',
      'runtime_role_has_ddl_authority',
      'runtime_role_can_forge_trusted_context',
      'runtime_role_has_cross_schema_dml',
    ],
  );
  assert.doesNotMatch(JSON.stringify(report), /postgresql:|password|secret|tenant-id|entity-id/iu);
});

test('flags database-level CREATE even when no existing schema is writable', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    databasePrivileges: { ...snapshot.databasePrivileges, create: true },
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
});

test('flags current database ownership even when CREATE was revoked', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    databasePrivileges: { ...snapshot.databasePrivileges, owner: true },
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
});

test('classifies reachable predefined PostgreSQL roles as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: true,
        canSetRole: false,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        parameterPrivileges: [],
        predefinedRole: true,
        relationPrivilegeSchemas: [],
        role: 'pg_execute_server_program',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('classifies a directly authenticated predefined PostgreSQL role as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    role: { ...ordinaryRole, predefinedRole: true },
    runtimeRole: 'pg_execute_server_program',
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_is_privileged'],
  );
});

test('flags effective configuration parameter authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    parameterPrivileges: [{ alterSystem: false, parameter: 'session_replication_role', set: true }],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_parameter_authority'],
  );
  assert.equal(report.summary.parameterPrivilegeCount, 1);
});

test('flags grant options on current objects as persistent authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    grantOptions: [
      {
        authority: 'relation:contacts.customers:SELECT',
        role: snapshot.runtimeRole,
        source: 'direct',
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_grant_authority'],
  );
  assert.equal(report.summary.grantOptionCount, 1);
});

test('flags creator-default grant options as persistent authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    defaultPrivileges: [{ ...snapshot.defaultPrivileges[1], grantable: true }],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_grant_authority'],
  );
  assert.equal(report.summary.grantOptionCount, 1);
});

test('classifies grant options held by a reachable role as privileged membership authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    grantOptions: [
      {
        authority: 'database:ontos:CONNECT',
        role: 'grant_delegate',
        source: 'assumable',
      },
    ],
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'grant_delegate',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
  assert.equal(report.summary.grantOptionCount, 1);
});

test('does not treat inheritance-only grant options as exercisable', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    defaultPrivileges: [
      {
        ...snapshot.defaultPrivileges[0],
        grantable: true,
        grantee: 'inherited_reader',
        source: 'inherited',
      },
    ],
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: true,
        canSetRole: false,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'inherited_reader',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_other_role'],
  );
  assert.equal(report.summary.grantOptionCount, 0);
});

test('flags selectable privileged owner-context views but accepts security invokers', () => {
  const ownerContextView = {
    ...snapshot.tables[0],
    kind: 'view' as const,
    owner: snapshot.administrativeRole,
    ownerBypassRls: false,
    ownerSuperuser: false,
    privileges: {
      delete: false,
      insert: false,
      maintain: false,
      references: false,
      select: true,
      trigger: false,
      truncate: false,
      update: false,
    },
    securityInvoker: false,
  };
  const base = {
    ...snapshot,
    tables: [ownerContextView],
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  };

  const ownerContextReport = buildDatabaseTrustBoundaryReport(base);
  assert.deepEqual(
    ownerContextReport.findings.map(({ code }) => code),
    ['runtime_role_can_select_privileged_owner_view'],
  );
  assert.equal(ownerContextReport.summary.privilegedOwnerViewCount, 1);

  const writableOwnerContextReport = buildDatabaseTrustBoundaryReport({
    ...base,
    tables: [
      {
        ...ownerContextView,
        privileges: {
          ...ownerContextView.privileges,
          select: false,
          update: true,
        },
      },
    ],
  });
  assert.deepEqual(
    writableOwnerContextReport.findings.map(({ code }) => code),
    ['runtime_role_can_select_privileged_owner_view'],
  );
  assert.equal(writableOwnerContextReport.summary.privilegedOwnerViewCount, 1);

  const invokerReport = buildDatabaseTrustBoundaryReport({
    ...base,
    tables: [{ ...ownerContextView, securityInvoker: true }],
  });
  assert.deepEqual(invokerReport.findings, []);
});

test('preserves nested owner-context RLS bypasses through security-invoker views', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    tables: [
      {
        ...snapshot.tables[0],
        kind: 'view',
        owner: 'reporting_owner',
        ownerBypassRls: false,
        ownerContextRlsBypass: true,
        ownerSuperuser: false,
        securityInvoker: true,
      },
    ],
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_select_privileged_owner_view'],
  );
  assert.equal(report.summary.privilegedOwnerViewCount, 1);
});

test('flags ownership of an audited relation as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    sequences: [],
    tables: [
      {
        ...snapshot.tables[0],
        kind: 'materialized-view',
        owner: snapshot.runtimeRole,
        privileges: {
          delete: false,
          insert: false,
          maintain: false,
          references: false,
          select: false,
          trigger: false,
          truncate: false,
          update: false,
        },
      },
    ],
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.equal(report.tables[0]?.kind, 'materialized-view');
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
});

test('flags ownership of an otherwise non-writable schema as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    schemas: [{ create: false, owner: snapshot.runtimeRole, schema: 'runtime_owned' }],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
});

test('flags ownership of an audited routine as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    routines: [
      {
        eventTriggerBindings: [],
        executable: true,
        identityArguments: '',
        kind: 'procedure',
        owner: snapshot.runtimeRole,
        policyBindings: [],
        routine: 'refresh_projection',
        schema: 'contacts',
        securityDefiner: false,
        storedExpressionBindings: [],
        triggerBindings: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
});

test('flags direct extension ownership as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    extensions: [{ extension: 'pgcrypto', owner: snapshot.runtimeRole, schema: 'public' }],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
  assert.equal(report.summary.extensionCount, 1);
});

test('classifies an assumable extension owner as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedExtensions: ['pgcrypto'],
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'extension_owner',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('flags direct foreign-server ownership as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    foreignServers: [{ owner: snapshot.runtimeRole, server: 'customer_warehouse' }],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
  assert.equal(report.summary.foreignServerCount, 1);
});

test('classifies an assumable foreign-server owner as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedForeignServers: ['customer_warehouse'],
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'foreign_server_owner',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('flags direct foreign-data-wrapper ownership as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    foreignDataWrappers: [{ owner: snapshot.runtimeRole, wrapper: 'customer_connector' }],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
  assert.equal(report.summary.foreignDataWrapperCount, 1);
});

test('classifies an assumable foreign-data-wrapper owner as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedForeignDataWrappers: ['customer_connector'],
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'foreign_data_wrapper_owner',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('flags ownership of an audited application type as DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
    types: [
      {
        kind: 'range',
        owner: snapshot.runtimeRole,
        schema: 'contacts',
        type: 'contact_status',
      },
    ],
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_ddl_authority'],
  );
  assert.equal(report.summary.typeCount, 1);
});

test('flags direct relation control and executable security-definer authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    routines: [
      {
        executable: true,
        eventTriggerBindings: [],
        identityArguments: 'uuid',
        kind: 'function',
        owner: 'ontos_admin',
        policyBindings: [],
        routine: 'enter_trusted_scope',
        schema: 'contacts',
        securityDefiner: true,
        storedExpressionBindings: [],
        triggerBindings: [],
      },
    ],
    tables: [
      {
        ...snapshot.tables[0],
        privileges: { ...snapshot.tables[0].privileges, maintain: true },
      },
    ],
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_relation_control_authority', 'runtime_role_can_execute_security_definer'],
  );
  assert.equal(report.summary.securityDefinerExecutableCount, 1);
});

test('flags security-definer routines invocable only through table triggers', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    routines: [
      {
        executable: false,
        eventTriggerBindings: [],
        identityArguments: '',
        kind: 'function',
        owner: 'ontos_admin',
        policyBindings: [],
        routine: 'capture_customer_change',
        schema: 'contacts',
        securityDefiner: true,
        storedExpressionBindings: [],
        triggerBindings: ['contacts.customers:capture_customer_change'],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_execute_security_definer'],
  );
  assert.equal(report.summary.securityDefinerExecutableCount, 1);
});

test('flags security-definer routines invoked through applicable RLS policies', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    routines: [
      {
        executable: false,
        eventTriggerBindings: [],
        identityArguments: 'uuid',
        kind: 'function',
        owner: 'ontos_admin',
        policyBindings: ['contacts.customers:tenant_isolation'],
        routine: 'can_access_tenant',
        schema: 'private',
        securityDefiner: true,
        storedExpressionBindings: [],
        triggerBindings: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_execute_security_definer'],
  );
  assert.equal(report.summary.securityDefinerExecutableCount, 1);
});

test('flags security-definer routines invoked through stored expressions', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    routines: [
      {
        executable: false,
        eventTriggerBindings: [],
        identityArguments: '',
        kind: 'function',
        owner: 'ontos_admin',
        policyBindings: [],
        routine: 'normalize_customer',
        schema: 'private',
        securityDefiner: true,
        storedExpressionBindings: [
          'contacts.customer_labels:domain-constraint:contacts.nonempty_text:nonempty_text_check',
          'contacts.customers:generated-column:normalized_name',
          'contacts.customers:expression-index:customers_normalized_name_idx',
          'contacts.customer_overview:view-expression',
        ],
        triggerBindings: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_execute_security_definer'],
  );
  assert.equal(report.summary.securityDefinerExecutableCount, 1);
});

test('flags security-definer routines invoked through applicable event triggers', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    routines: [
      {
        eventTriggerBindings: ['event-trigger:audit_ddl:ddl_command_end[ALTER DEFAULT PRIVILEGES]'],
        executable: false,
        identityArguments: '',
        kind: 'function',
        owner: 'ontos_admin',
        policyBindings: [],
        routine: 'audit_ddl',
        schema: 'private',
        securityDefiner: true,
        storedExpressionBindings: [],
        triggerBindings: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_execute_security_definer'],
  );
  assert.equal(report.summary.securityDefinerExecutableCount, 1);
});

test('classifies reachable roles that invoke security-definer stored expressions as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'expression_writer',
        securityDefinerRoutines: [],
        securityDefinerStoredExpressionBindings: [
          'contacts.customers:check-constraint:customers_valid->private.validate_customer()',
        ],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('classifies reachable roles that invoke security-definer RLS policies as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'policy_reader',
        securityDefinerPolicyBindings: [
          'contacts.customers:tenant_isolation->private.can_access_tenant(uuid)',
        ],
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('classifies reachable roles that can fire security-definer triggers as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'trigger_writer',
        securityDefinerRoutines: [],
        securityDefinerTriggerBindings: [
          'contacts.customers:capture_customer_change->contacts.capture_customer_change()',
        ],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('classifies reachable roles that can fire security-definer event triggers as privileged', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'ddl_operator',
        securityDefinerEventTriggerBindings: [
          'event-trigger:audit_ddl:ddl_command_end[ALTER DEFAULT PRIVILEGES]->private.audit_ddl()',
        ],
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role'],
  );
});

test('flags direct sequence mutation authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    sequences: [
      {
        ...snapshot.sequences[0],
        privileges: { ...snapshot.sequences[0].privileges, update: true },
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_has_sequence_mutation_authority'],
  );
});

test('classifies every assumable role and escalates relation authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: ['private'],
        role: 'table_truncator',
        securityDefinerRoutines: [],
      },
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'report_reader',
        securityDefinerRoutines: [],
      },
    ],
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    [
      'runtime_role_can_assume_privileged_role',
      'runtime_role_can_assume_other_role',
      'runtime_role_can_forge_trusted_context',
      'runtime_role_has_cross_schema_dml',
    ],
  );
});

test('treats ADMIN OPTION as an escalation path when SET OPTION is false', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: true,
        canInheritRole: false,
        canSetRole: false,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: ['contacts.contact_status'],
        relationPrivilegeSchemas: [],
        role: 'tenant_bypass',
        securityDefinerRoutines: [],
      },
    ],
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    [
      'runtime_role_can_assume_privileged_role',
      'runtime_role_can_forge_trusted_context',
      'runtime_role_has_cross_schema_dml',
    ],
  );
});

test('traverses SET OPTION descendants after every ADMIN OPTION role', async () => {
  const source = await readFile(
    new URL('../audit-database-trust-boundaries.mts', import.meta.url),
    'utf-8',
  );

  assert.equal(
    source.match(/where membership\.admin_option or membership\.set_option/gu)?.length,
    1,
  );
  assert.equal(source.match(/\$\{reachableRolesCte\}/gu)?.length, 3);
  assert.match(
    source,
    /candidate\.oid in \(select role_oid from reachable_roles\) as can_set_role/u,
  );
  assert.doesNotMatch(
    source,
    /or pg_has_role\(\$1, grantee\.oid, 'SET'\)\s+or grantee\.oid in \(select role_oid from administrable_roles\)/u,
  );
  assert.match(source, /view_dependencies\(view_oid, referenced_oid, effective_owner_oid\)/u);
  assert.match(source, /referenced_relation\.relowner = dependency\.effective_owner_oid/u);
  assert.match(source, /effective_owner\.rolbypassrls/u);
  assert.match(source, /effective_owner\.rolsuper/u);
  assert.equal(source.match(/pg_catalog\.pg_options_to_table\([^)]*\.reloptions\)/gu)?.length, 6);
  assert.match(source, /select audited_role\.role, audited_role\.source, authority\.grant_option/u);
  assert.equal(source.match(/from pg_catalog\.pg_trigger as audited_trigger/gu)?.length, 2);
  assert.equal(source.match(/audited_trigger\.tgenabled in \('O', 'A'\)/gu)?.length, 2);
  assert.equal(source.match(/audited_trigger\.tgenabled = 'R'/gu)?.length, 2);
  assert.match(
    source,
    /has_parameter_privilege\(\s+candidate\.oid,\s+'session_replication_role',\s+'SET'\s+\)/u,
  );
  assert.match(source, /has_parameter_privilege\(\$1, 'session_replication_role', 'SET'\)/u);
  assert.equal(source.match(/pg_catalog\.pg_partition_ancestors\(relation\.oid\)/gu)?.length, 7);
  assert.equal(
    source.match(
      /select relation\.oid\s+union\s+select ancestor\.oid\s+from pg_catalog\.pg_partition_ancestors\(relation\.oid\)/gu,
    )?.length,
    6,
  );
  assert.equal(source.match(/from pg_catalog\.pg_policy as policy/gu)?.length, 2);
  assert.equal(source.match(/\$\{storedExpressionDependenciesCte\}/gu)?.length, 2);
  assert.equal(source.match(/\$\{referentialWritePathsCte\}/gu)?.length, 2);
  assert.equal(source.match(/\$\{roleDdlCommandTagsCte\}/gu)?.length, 2);
  assert.match(source, /from pg_catalog\.pg_attrdef as expression/u);
  assert.match(source, /from pg_catalog\.pg_constraint as expression/u);
  assert.match(source, /from pg_catalog\.pg_index as stored_index/u);
  assert.match(source, /pg_catalog\.pg_rewrite as expression/u);
  assert.match(source, /view_invocation_paths\(invocation_oid, dependency_oid\)/u);
  assert.match(source, /view_access_paths\(invocation_oid, affected_oid, effective_owner_oid\)/u);
  assert.match(
    source,
    /writable_view_rewrites\(view_oid, affected_oid, actions, target_list, effective_owner_oid\)/u,
  );
  assert.match(source, /direct_writable_view_paths\(invocation_oid, affected_oid, actions/u);
  assert.match(source, /direct_writable_view_columns\(/u);
  assert.match(source, /writable_view_columns\(/u);
  assert.match(
    source,
    /writable_view_paths\(invocation_oid, affected_oid, actions, effective_owner_oid\)/u,
  );
  assert.match(source, /:resorigtbl \(\[1-9\]\[0-9\]\*\) :resorigcol/u);
  assert.match(source, /split_part\(rewrite\.ev_action::text, ':rteperminfos', 1\)/u);
  assert.match(source, /cross join lateral regexp_matches\(/u);
  assert.match(source, /affected_relation\.oid <> view_relation\.oid/u);
  assert.match(source, /pg_catalog\.pg_relation_is_updatable/u);
  assert.equal(source.match(/from writable_view_paths as writable_view/gu)?.length, 6);
  assert.equal(source.match(/from writable_view_columns as writable_column/gu)?.length, 2);
  assert.equal(source.match(/from view_access_paths as view_access/gu)?.length, 2);
  assert.match(source, /relation_invocation_paths\(invocation_oid, dependency_oid\)/u);
  assert.match(source, /stored_expression\.invocation_oid/u);
  assert.match(source, /nested-view-expression/u);
  assert.match(source, /expression\.rulename <> '_RETURN'/u);
  assert.match(source, /expression\.ev_type in \('2', '3', '4'\)/u);
  assert.match(source, /expression\.ev_enabled in \('O', 'A', 'R'\)/u);
  assert.match(source, /'dml-rule:%s:%s:%I'/u);
  assert.equal(source.match(/stored_expression\.binding !~ '\^dml-rule:'/gu)?.length, 6);
  assert.equal(source.match(/stored_expression\.binding ~ '\^dml-rule:INSERT:'/gu)?.length, 2);
  assert.equal(source.match(/stored_expression\.binding ~ '\^dml-rule:UPDATE:'/gu)?.length, 2);
  assert.equal(source.match(/stored_expression\.binding ~ '\^dml-rule:DELETE:'/gu)?.length, 4);
  assert.match(source, /expression\.contypid/u);
  assert.match(source, /from pg_catalog\.pg_trigger as before_update_trigger/u);
  assert.match(source, /before_update_trigger\.tgrelid = expression\.adrelid/u);
  assert.match(source, /before_update_trigger\.tgtype & 1 <> 0/u);
  assert.match(source, /before_update_trigger\.tgtype & 2 <> 0/u);
  assert.match(source, /before_update_trigger\.tgtype & 16 <> 0/u);
  assert.match(source, /referential_write_paths\(/u);
  assert.match(source, /foreign_key\.confdeltype/u);
  assert.match(source, /foreign_key\.confupdtype/u);
  assert.match(source, /foreign_key\.confdelsetcols/u);
  assert.match(source, /changed\.attnum = any\(coalesce\(foreign_key\.confkey/u);
  assert.match(source, /cascade\.affected_action/u);
  assert.match(source, /cascade\.affected_uses_default/u);
  assert.equal(
    source.match(/cascade\.affected_oid = stored_expression\.invocation_oid/gu)?.length,
    2,
  );
  assert.equal(source.match(/stored_expression\.binding !~ '\^column-default:'/gu)?.length, 2);
  assert.equal(source.match(/from pg_catalog\.pg_event_trigger as event_trigger/gu)?.length, 2);
  assert.match(source, /join pg_catalog\.pg_extension as extension/u);
  assert.match(source, /join pg_catalog\.pg_foreign_data_wrapper as foreign_data_wrapper/u);
  assert.match(source, /join pg_catalog\.pg_foreign_server as foreign_server/u);
  assert.match(source, /has_database_privilege\(role\.oid, current_database\(\), 'TEMPORARY'\)/u);
  assert.match(source, /cross join \(values \('GRANT'::text\), \('REVOKE'::text\)\)/u);
  assert.match(source, /event_trigger\.evtevent = 'ddl_command_start'/u);
  assert.match(
    source,
    /left join lateral unnest\(event_trigger\.evttags\) as configured_tag\(name\) on true/u,
  );
  assert.match(source, /'SELECT WITH GRANT OPTION'/u);
  assert.match(source, /has_column_privilege\(role\.oid, attribute\.attrelid/u);
  assert.match(
    source,
    /has_function_privilege\(role\.oid, routine\.oid, 'EXECUTE WITH GRANT OPTION'\)/u,
  );
  assert.equal(source.match(/event_trigger\.evttags is null/gu)?.length, 4);
  assert.equal(source.match(/from pg_catalog\.pg_partitioned_table as partitioned/gu)?.length, 4);
  assert.equal(source.match(/audited_trigger\.tgtype & 12 <> 0/gu)?.length, 4);
  assert.match(
    source,
    /format\('check-constraint:%I', expression\.conname\),\s+false,\s+array\[\]::smallint\[\]/u,
  );
  assert.equal(source.match(/stored_expression\.selectable/gu)?.length, 8);
  assert.equal(
    source.match(/cardinality\(audited_trigger\.tgattr::smallint\[\]\) = 0/gu)?.length,
    4,
  );
  assert.equal(
    source.match(/from unnest\(audited_trigger\.tgattr::smallint\[\]\) as watched\(attnum\)/gu)
      ?.length,
    2,
  );
  assert.match(source, /from pg_catalog\.pg_extension as extension/u);
  assert.match(source, /from pg_catalog\.pg_foreign_server as foreign_server/u);
  assert.match(source, /foreign_data_wrapper\.fdwowner/u);
  assert.match(source, /join audit_owners as owner on owner\.oid = defaults\.defaclrole/u);
  assert.match(source, /as can_create_schema/u);
  assert.match(source, /as can_create_object/u);
  assert.match(source, /object_types\.catalog_code = 'n'\s+and owner\.can_create_schema/u);
  assert.match(source, /object_types\.catalog_code <> 'n'\s+and owner\.can_create_object/u);
  assert.match(source, /owner\.rolname = \$1 as owner/u);
  assert.match(source, /candidate\.oid = \(\s+select database\.datdba/u);
  assert.match(
    source,
    /namespace\.nspowner = owner\.oid\s+or has_schema_privilege\(owner\.oid, namespace\.oid, 'CREATE'\)/u,
  );
});

test('treats inherited owner-role authority as effective runtime DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: true,
        canSetRole: false,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: ['contacts.customers'],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'contacts_owner',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role', 'runtime_role_has_ddl_authority'],
  );
});

test('treats SET-reachable database ownership as effective runtime DDL authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canAdministerRole: false,
        canInheritRole: false,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        databaseOwner: true,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'database_owner',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_privileged_role', 'runtime_role_has_ddl_authority'],
  );
});

test('does not inherit cluster attributes without SET ROLE or ADMIN OPTION', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: { ...ordinaryRole, bypassRls: true },
        canAdministerRole: false,
        canInheritRole: true,
        canSetRole: false,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'attribute_only_role',
        securityDefinerRoutines: [],
      },
    ],
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['runtime_role_can_assume_other_role'],
  );
});

test('uses node-postgres effective query-parameter socket endpoints', () => {
  const client = new Client({
    connectionString:
      'postgresql://authority_user:password@authority.invalid:5432/ontos?host=%2Ftmp%2Fruntime-db&port=6432',
  });

  assert.deepEqual(getEffectiveDatabaseEndpoint(client), {
    configuredHost: '/tmp/runtime-db',
    configuredPort: 6432,
  });
});

test('requires direct, distinct live database session identities', () => {
  assert.doesNotThrow(() =>
    assertDatabaseSessionIdentities(
      { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
      { currentRole: 'ontos_runtime', sessionRole: 'ontos_runtime' },
    ),
  );
  assert.throws(
    () =>
      assertDatabaseSessionIdentities(
        { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
        { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
      ),
    /distinct authenticated PostgreSQL roles/u,
  );
  assert.throws(
    () =>
      assertDatabaseSessionIdentities(
        { currentRole: 'startup_role', sessionRole: 'ontos_runtime' },
        { currentRole: 'ontos_runtime', sessionRole: 'ontos_runtime' },
      ),
    /current_user must equal session_user/u,
  );
});

test('rejects evidence collected from different servers or databases', () => {
  const target = {
    configuredHost: 'database.internal',
    configuredPort: 5432,
    database: 'ontos',
    serverAddress: '10.0.0.1',
    serverPort: 5432,
  };

  assert.doesNotThrow(() => assertSameDatabaseTarget(target, { ...target }));
  assert.throws(
    () => assertSameDatabaseTarget(target, { ...target, database: 'other' }),
    /same PostgreSQL server and database/u,
  );
  assert.throws(
    () => assertSameDatabaseTarget(target, { ...target, serverAddress: '10.0.0.2' }),
    /same PostgreSQL server and database/u,
  );
  assert.throws(
    () =>
      assertSameDatabaseTarget(
        {
          ...target,
          configuredHost: '/var/run/postgresql-a',
          serverAddress: null,
          serverPort: null,
        },
        {
          ...target,
          configuredHost: '/var/run/postgresql-b',
          serverAddress: null,
          serverPort: null,
        },
      ),
    /same PostgreSQL server and database/u,
  );
});

test('treats transaction-local context retention as a critical boundary failure', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      tenantSettingRetainedAfterRollback: true,
    },
  });

  assert.deepEqual(
    report.findings.map(({ code, severity }) => `${severity}:${code}`),
    [
      'high:runtime_role_can_forge_trusted_context',
      'critical:trusted_context_survives_transaction',
    ],
  );
});
