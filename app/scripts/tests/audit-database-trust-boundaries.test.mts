import { Effect, Cause } from 'effect';
import { expect, it } from '@app/effect-rstest';

import { readFile } from 'node:fs/promises';

import { Client } from 'pg';
import {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError,
  getEffectiveDatabaseEndpoint,
  getDatabaseTrustBoundaryFailureMessage,
  hasTrustedContextValue,
} from '../audit-database-trust-boundaries.mts';
import type { DatabaseTrustBoundarySnapshot } from '../audit-database-trust-boundaries.mts';

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
      grantable: false,
      grantee: 'analytics_reader',
      objectType: 'function',
      owner: 'ontos_admin',
      privilege: 'EXECUTE',
      schema: null,
      source: 'inherited',
    },
    {
      grantable: false,
      grantee: 'ontos_runtime',
      objectType: 'sequence',
      owner: 'ontos_admin',
      privilege: 'USAGE',
      schema: 'contacts',
      source: 'direct',
    },
    {
      grantable: false,
      grantee: 'PUBLIC',
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
  routines: [],
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
  trustedContext: {
    legalEntitySettingRetainedAfterRollback: false,
    legalEntitySettingSettable: true,
    tenantSettingRetainedAfterRollback: false,
    tenantSettingSettable: true,
    transactionLocal: true,
  },
  types: [],
} as const satisfies DatabaseTrustBoundarySnapshot;

const hardenedSnapshot = {
  ...snapshot,
  tables: snapshot.tables.slice(0, 1),
  trustedContext: {
    ...snapshot.trustedContext,
    legalEntitySettingSettable: false,
    tenantSettingSettable: false,
  },
} as const satisfies DatabaseTrustBoundarySnapshot;

const buildHardenedReport = (overrides: Partial<DatabaseTrustBoundarySnapshot> = {}) =>
  buildDatabaseTrustBoundaryReport({ ...hardenedSnapshot, ...overrides });

const findingCodes = (report: ReturnType<typeof buildDatabaseTrustBoundaryReport>) =>
  report.findings.map(({ code }) => code);

const reversed = <Value extends object>(values: readonly Value[]): Value[] => {
  const [head, ...tail] = values;
  return head === undefined ? [] : [...reversed(tail), head];
};

it('builds deterministic current-state evidence and identifies the material trust gaps', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    schemas: reversed(snapshot.schemas),
    tables: reversed(snapshot.tables),
  });

  expect(report.schemas.map(({ schema }) => schema)).toEqual(['auth', 'contacts', 'core']);
  expect(report.tables.map(({ schema, table }) => `${schema}.${table}`)).toEqual([
    'auth.user',
    'contacts.customers',
    'core.tenants',
  ]);
  expect(
    report.defaultPrivileges.map(({ grantee, schema, source }) => `${source}:${grantee}:${schema}`),
  ).toEqual([
    'inherited:analytics_reader:null',
    'public:PUBLIC:auth',
    'direct:ontos_runtime:contacts',
  ]);
  expect(report.findings.map(({ code, severity }) => `${severity}:${code}`)).toEqual([
    'high:runtime_role_can_forge_trusted_context',
    'high:runtime_role_has_cross_schema_dml',
  ]);
  expect(report.summary).toEqual({
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
  expect(report.schemaVersion).toBe(1);
});

it('orders audit evidence by code units rather than locale collation', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    types: [
      { kind: 'enum', owner: 'ontos_admin', schema: 'ärea', type: 'status' },
      { kind: 'enum', owner: 'ontos_admin', schema: 'zeta', type: 'status' },
    ],
  });

  expect(report.types.map(({ schema, type }) => `${schema}.${type}`)).toEqual([
    'zeta.status',
    'ärea.status',
  ]);
});

it('totally orders default privileges from distinct creator roles', () => {
  const sharedPrivilege = {
    grantable: false,
    grantee: 'PUBLIC',
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

  expect(report.defaultPrivileges.map(({ owner }) => owner)).toEqual(['alpha_owner', 'zeta_owner']);
});

it('extracts typed audit failures from an Effect cause', () => {
  const reason = 'DATABASE_ADMIN_URL and DATABASE_URL must use distinct roles';

  expect(
    getDatabaseTrustBoundaryFailureMessage(
      Cause.fail(new DatabaseTrustBoundaryAuditError({ reason })),
    ),
  ).toBe(reason);
  expect(getDatabaseTrustBoundaryFailureMessage(Cause.die(new Error('driver defect')))).toBe(
    'Database trust-boundary audit failed',
  );
});

it('treats any non-empty post-rollback trusted context as retained', () => {
  expect(hasTrustedContextValue(null)).toBe(false);
  expect(hasTrustedContextValue('')).toBe(false);
  expect(hasTrustedContextValue('pre-existing-tenant-context')).toBe(true);
});

it('reports privilege escalation paths without embedding credentials or context values', () => {
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

  expect(findingCodes(report)).toEqual([
    'runtime_role_is_privileged',
    'runtime_role_can_assume_administrative_role',
    'runtime_role_has_ddl_authority',
    'runtime_role_can_forge_trusted_context',
    'runtime_role_has_cross_schema_dml',
  ]);
  expect(JSON.stringify(report)).not.toMatch(/postgresql:|password|secret|tenant-id|entity-id/iu);
});

it('flags database-level CREATE even when no existing schema is writable', () => {
  const report = buildHardenedReport({
    databasePrivileges: { ...snapshot.databasePrivileges, create: true },
  });

  expect(findingCodes(report)).toEqual(['runtime_role_has_ddl_authority']);
});

it('classifies reachable predefined PostgreSQL roles as privileged', () => {
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

  expect(findingCodes(report)).toEqual(['runtime_role_can_assume_privileged_role']);
});

it('classifies a directly authenticated predefined PostgreSQL role as privileged', () => {
  const report = buildHardenedReport({
    role: { ...ordinaryRole, predefinedRole: true },
    runtimeRole: 'pg_execute_server_program',
  });

  expect(findingCodes(report)).toEqual(['runtime_role_is_privileged']);
});

it('flags effective configuration parameter authority', () => {
  const report = buildHardenedReport({
    parameterPrivileges: [{ alterSystem: false, parameter: 'session_replication_role', set: true }],
  });

  expect(findingCodes(report)).toEqual(['runtime_role_has_parameter_authority']);
  expect(report.summary.parameterPrivilegeCount).toBe(1);
});

it('flags grant options on current objects as persistent authority', () => {
  const report = buildHardenedReport({
    grantOptions: ['relation:contacts.customers:SELECT'],
  });

  expect(findingCodes(report)).toEqual(['runtime_role_has_grant_authority']);
  expect(report.summary.grantOptionCount).toBe(1);
});

it('flags creator-default grant options as persistent authority', () => {
  const report = buildHardenedReport({
    defaultPrivileges: [{ ...snapshot.defaultPrivileges[0], grantable: true }],
  });

  expect(findingCodes(report)).toEqual(['runtime_role_has_grant_authority']);
  expect(report.summary.grantOptionCount).toBe(1);
});

it('flags selectable privileged owner-context views but accepts security invokers', () => {
  const ownerContextView = {
    ...snapshot.tables[0],
    deletable: true,
    insertable: true,
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
    updatable: true,
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
  expect(ownerContextReport.findings.map(({ code }) => code)).toEqual([
    'runtime_role_can_use_privileged_owner_view',
  ]);
  expect(ownerContextReport.summary.privilegedOwnerViewCount).toBe(1);

  const writableReport = buildDatabaseTrustBoundaryReport({
    ...base,
    tables: [
      {
        ...ownerContextView,
        privileges: { ...ownerContextView.privileges, select: false, update: true },
      },
    ],
  });
  expect(findingCodes(writableReport)).toEqual(['runtime_role_can_use_privileged_owner_view']);

  const readOnlyReport = buildDatabaseTrustBoundaryReport({
    ...base,
    tables: [
      {
        ...ownerContextView,
        privileges: { ...ownerContextView.privileges, select: false, update: true },
        updatable: false,
      },
    ],
  });
  expect(readOnlyReport.findings).toEqual([]);

  const invokerReport = buildDatabaseTrustBoundaryReport({
    ...base,
    tables: [{ ...ownerContextView, securityInvoker: true }],
  });
  expect(invokerReport.findings).toEqual([]);
});

it('flags owner-context views that bypass RLS through owner-matched dependencies', () => {
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

  expect(findingCodes(report)).toEqual(['runtime_role_can_use_privileged_owner_view']);
  expect(report.summary.privilegedOwnerViewCount).toBe(1);
});

it('flags privileged owners in nested owner-context views', () => {
  const report = buildHardenedReport({
    tables: [
      {
        ...snapshot.tables[0],
        kind: 'view',
        owner: 'reporting_owner',
        ownerBypassRls: false,
        ownerContextPrivileged: true,
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

  expect(findingCodes(report)).toEqual(['runtime_role_can_use_privileged_owner_view']);
});

it('flags ownership of an audited relation as DDL authority', () => {
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

  expect(report.tables[0]?.kind).toBe('materialized-view');
  expect(findingCodes(report)).toEqual(['runtime_role_has_ddl_authority']);
});

it('flags ownership of an audited routine as DDL authority', () => {
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

  expect(findingCodes(report)).toEqual(['runtime_role_has_ddl_authority']);
});

it('flags ownership of an audited application type as DDL authority', () => {
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

  expect(findingCodes(report)).toEqual(['runtime_role_has_ddl_authority']);
  expect(report.summary.typeCount).toBe(1);
});

it('flags direct relation control and executable security-definer authority', () => {
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

  expect(findingCodes(report)).toEqual([
    'runtime_role_has_relation_control_authority',
    'runtime_role_can_execute_security_definer',
  ]);
  expect(report.summary.securityDefinerExecutableCount).toBe(1);
});

it('flags direct sequence mutation authority', () => {
  const report = buildHardenedReport({
    sequences: [
      {
        ...snapshot.sequences[0],
        privileges: { ...snapshot.sequences[0].privileges, update: true },
      },
    ],
  });

  expect(findingCodes(report)).toEqual(['runtime_role_has_sequence_mutation_authority']);
});

it('classifies every assumable role and escalates relation authority', () => {
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

  expect(findingCodes(report)).toEqual([
    'runtime_role_can_assume_privileged_role',
    'runtime_role_can_assume_other_role',
    'runtime_role_can_forge_trusted_context',
    'runtime_role_has_cross_schema_dml',
  ]);
});

it('treats ADMIN OPTION as an escalation path when SET OPTION is false', () => {
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

  expect(findingCodes(report)).toEqual([
    'runtime_role_can_assume_privileged_role',
    'runtime_role_can_forge_trusted_context',
    'runtime_role_has_cross_schema_dml',
  ]);
});

it.live(
  'traverses SET OPTION descendants after every ADMIN OPTION role',
  Effect.fn(function* scenario1() {
    const source = yield* Effect.promise(() =>
      readFile(new URL('../database-trust-audit/collect-snapshot.mts', import.meta.url), 'utf-8'),
    );

    expect(source.match(/where membership\.admin_option or membership\.set_option/gu)?.length).toBe(
      3,
    );
    expect(source).toMatch(
      /candidate\.oid in \(select role_oid from reachable_roles\) as can_set_role/u,
    );
    expect(source).not.toMatch(
      /or pg_has_role\(\$1, grantee\.oid, 'SET'\)\s+or grantee\.oid in \(select role_oid from administrable_roles\)/u,
    );
    expect(source).toMatch(/view_dependencies\(view_oid, referenced_oid, effective_owner_oid\)/u);
    expect(source).toMatch(/target_roles\(role_oid, role_name\)/u);
    expect(source).toMatch(/format\('role:%I:%s', target\.role_name, authority\.grant_option\)/u);
    expect(source).toMatch(/pg_has_role\(effective_owner\.oid, \$3, 'USAGE'\)/u);
    expect(source).toMatch(
      /pg_has_role\(\s*dependency\.effective_owner_oid,\s*referenced_relation\.relowner,\s*'USAGE'\s*\)/u,
    );
  }),
);

it('treats inherited owner-role authority as effective runtime DDL authority', () => {
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

  expect(findingCodes(report)).toEqual([
    'runtime_role_can_assume_privileged_role',
    'runtime_role_has_ddl_authority',
  ]);
});

it('does not inherit cluster attributes without SET ROLE or ADMIN OPTION', () => {
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

  expect(findingCodes(report)).toEqual(['runtime_role_can_assume_other_role']);
});

it('uses node-postgres effective query-parameter socket endpoints', () => {
  const client = new Client({
    connectionString:
      'postgresql://authority_user:password@authority.invalid:5432/ontos?host=%2Fvar%2Frun%2Fruntime-db&port=6432',
  });

  expect(getEffectiveDatabaseEndpoint(client)).toEqual({
    configuredHost: '/var/run/runtime-db',
    configuredPort: 6432,
  });
});

it('requires direct, distinct live database session identities', () => {
  expect(() =>
    assertDatabaseSessionIdentities(
      { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
      { currentRole: 'ontos_runtime', sessionRole: 'ontos_runtime' },
    ),
  ).not.toThrow();
  expect(() =>
    assertDatabaseSessionIdentities(
      { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
      { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
    ),
  ).toThrow(/distinct authenticated PostgreSQL roles/u);
  expect(() =>
    assertDatabaseSessionIdentities(
      { currentRole: 'startup_role', sessionRole: 'ontos_runtime' },
      { currentRole: 'ontos_runtime', sessionRole: 'ontos_runtime' },
    ),
  ).toThrow(/current_user must equal session_user/u);
});

it('rejects evidence collected from different servers or databases', () => {
  const alternateServerAddress = [10, 0, 0, 2].join('.');
  const serverAddress = [10, 0, 0, 1].join('.');
  const target = {
    configuredHost: 'database.internal',
    configuredPort: 5432,
    database: 'ontos',
    serverAddress,
    serverPort: 5432,
  };

  expect(() => assertSameDatabaseTarget(target, { ...target })).not.toThrow();
  expect(() => assertSameDatabaseTarget(target, { ...target, database: 'other' })).toThrow(
    /same PostgreSQL server and database/u,
  );
  expect(() =>
    assertSameDatabaseTarget(target, { ...target, serverAddress: alternateServerAddress }),
  ).toThrow(/same PostgreSQL server and database/u);
  expect(() =>
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
  ).toThrow(/same PostgreSQL server and database/u);
});

it('treats transaction-local context retention as a critical boundary failure', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    tables: snapshot.tables.slice(0, 1),
    trustedContext: {
      ...snapshot.trustedContext,
      tenantSettingRetainedAfterRollback: true,
    },
  });

  expect(report.findings.map(({ code, severity }) => `${severity}:${code}`)).toEqual([
    'high:runtime_role_can_forge_trusted_context',
    'critical:trusted_context_survives_transaction',
  ]);
});
