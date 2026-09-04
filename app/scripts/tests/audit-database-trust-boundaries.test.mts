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
  databasePrivileges: { connect: true, create: false, temporary: true },
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

const hardenedSnapshot = {
  ...snapshot,
  tables: snapshot.tables.slice(0, 1),
  trustedContext: {
    ...snapshot.trustedContext,
    legalEntitySettingSettable: false,
    tenantSettingSettable: false,
  },
} satisfies DatabaseTrustBoundarySnapshot;

const buildHardenedReport = (overrides: Partial<DatabaseTrustBoundarySnapshot> = {}) =>
  buildDatabaseTrustBoundaryReport({ ...hardenedSnapshot, ...overrides });

const findingCodes = (report: ReturnType<typeof buildDatabaseTrustBoundaryReport>) =>
  report.findings.map(({ code }) => code);

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
    findingCount: 2,
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

  assert.deepEqual(findingCodes(report), [
    'runtime_role_is_privileged',
    'runtime_role_can_assume_administrative_role',
    'runtime_role_has_ddl_authority',
    'runtime_role_can_forge_trusted_context',
    'runtime_role_has_cross_schema_dml',
  ]);
  assert.doesNotMatch(JSON.stringify(report), /postgresql:|password|secret|tenant-id|entity-id/iu);
});

test('flags database-level CREATE even when no existing schema is writable', () => {
  const report = buildHardenedReport({
    databasePrivileges: { ...snapshot.databasePrivileges, create: true },
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
});

test('classifies reachable predefined PostgreSQL roles as privileged', () => {
  const report = buildHardenedReport({
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
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_can_assume_privileged_role']);
});

test('classifies a directly authenticated predefined PostgreSQL role as privileged', () => {
  const report = buildHardenedReport({
    role: { ...ordinaryRole, predefinedRole: true },
    runtimeRole: 'pg_execute_server_program',
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_is_privileged']);
});

test('flags effective configuration parameter authority', () => {
  const report = buildHardenedReport({
    parameterPrivileges: [{ alterSystem: false, parameter: 'session_replication_role', set: true }],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_parameter_authority']);
  assert.equal(report.summary.parameterPrivilegeCount, 1);
});

test('flags grant options on current objects as persistent authority', () => {
  const report = buildHardenedReport({
    grantOptions: ['relation:contacts.customers:SELECT'],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_grant_authority']);
  assert.equal(report.summary.grantOptionCount, 1);
});

test('flags creator-default grant options as persistent authority', () => {
  const report = buildHardenedReport({
    defaultPrivileges: [{ ...snapshot.defaultPrivileges[0], grantable: true }],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_grant_authority']);
  assert.equal(report.summary.grantOptionCount, 1);
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

  const invokerReport = buildDatabaseTrustBoundaryReport({
    ...base,
    tables: [{ ...ownerContextView, securityInvoker: true }],
  });
  assert.deepEqual(invokerReport.findings, []);
});

test('flags owner-context views that bypass RLS through owner-matched dependencies', () => {
  const report = buildHardenedReport({
    tables: [
      {
        ...snapshot.tables[0],
        kind: 'view',
        owner: 'reporting_owner',
        ownerBypassRls: false,
        ownerContextRlsBypass: true,
        ownerSuperuser: false,
        securityInvoker: false,
      },
    ],
    trustedContext: {
      ...snapshot.trustedContext,
      legalEntitySettingSettable: false,
      tenantSettingSettable: false,
    },
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_can_select_privileged_owner_view']);
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
  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
});

test('flags ownership of an audited routine as DDL authority', () => {
  const report = buildHardenedReport({
    routines: [
      {
        executable: true,
        identityArguments: '',
        kind: 'procedure',
        owner: snapshot.runtimeRole,
        routine: 'refresh_projection',
        schema: 'contacts',
        securityDefiner: false,
      },
    ],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
});

test('flags ownership of an audited application type as DDL authority', () => {
  const report = buildHardenedReport({
    types: [
      {
        kind: 'range',
        owner: snapshot.runtimeRole,
        schema: 'contacts',
        type: 'contact_status',
      },
    ],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
  assert.equal(report.summary.typeCount, 1);
});

test('flags direct relation control and executable security-definer authority', () => {
  const report = buildHardenedReport({
    routines: [
      {
        executable: true,
        identityArguments: 'uuid',
        kind: 'function',
        owner: 'ontos_admin',
        routine: 'enter_trusted_scope',
        schema: 'contacts',
        securityDefiner: true,
      },
    ],
    tables: [
      {
        ...snapshot.tables[0],
        privileges: { ...snapshot.tables[0].privileges, maintain: true },
      },
    ],
  });

  assert.deepEqual(findingCodes(report), [
    'runtime_role_has_relation_control_authority',
    'runtime_role_can_execute_security_definer',
  ]);
  assert.equal(report.summary.securityDefinerExecutableCount, 1);
});

test('flags direct sequence mutation authority', () => {
  const report = buildHardenedReport({
    sequences: [
      {
        ...snapshot.sequences[0],
        privileges: { ...snapshot.sequences[0].privileges, update: true },
      },
    ],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_sequence_mutation_authority']);
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

  assert.deepEqual(findingCodes(report), [
    'runtime_role_can_assume_privileged_role',
    'runtime_role_can_assume_other_role',
    'runtime_role_can_forge_trusted_context',
    'runtime_role_has_cross_schema_dml',
  ]);
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

  assert.deepEqual(findingCodes(report), [
    'runtime_role_can_assume_privileged_role',
    'runtime_role_can_forge_trusted_context',
    'runtime_role_has_cross_schema_dml',
  ]);
});

test('traverses SET OPTION descendants after every ADMIN OPTION role', async () => {
  const source = await readFile(
    new URL('../database-trust-audit/collect-snapshot.mts', import.meta.url),
    'utf-8',
  );

  assert.equal(
    source.match(/where membership\.admin_option or membership\.set_option/gu)?.length,
    2,
  );
  assert.match(
    source,
    /candidate\.oid in \(select role_oid from reachable_roles\) as can_set_role/u,
  );
  assert.doesNotMatch(
    source,
    /or pg_has_role\(\$1, grantee\.oid, 'SET'\)\s+or grantee\.oid in \(select role_oid from administrable_roles\)/u,
  );
  assert.match(source, /view_dependencies\(view_oid, referenced_oid, effective_owner_oid\)/u);
  assert.match(
    source,
    /pg_has_role\(\s*dependency\.effective_owner_oid,\s*referenced_relation\.relowner,\s*'USAGE'\s*\)/u,
  );
});

test('treats inherited owner-role authority as effective runtime DDL authority', () => {
  const report = buildHardenedReport({
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
  });

  assert.deepEqual(findingCodes(report), [
    'runtime_role_can_assume_privileged_role',
    'runtime_role_has_ddl_authority',
  ]);
});

test('does not inherit cluster attributes without SET ROLE or ADMIN OPTION', () => {
  const report = buildHardenedReport({
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
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_can_assume_other_role']);
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
