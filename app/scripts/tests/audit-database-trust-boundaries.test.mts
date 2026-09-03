import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  type DatabaseTrustBoundarySnapshot,
} from '../audit-database-trust-boundaries.mts';

const ordinaryRole = {
  bypassRls: false,
  canCreateDatabases: false,
  canCreateRoles: false,
  canLogin: true,
  inherit: false,
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
  memberships: [],
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
    ['high:runtime_role_can_forge_trusted_context', 'high:runtime_role_has_cross_owner_dml'],
  );
  assert.deepEqual(report.summary, {
    auditedSchemaCount: 3,
    defaultPrivilegeCount: 3,
    dmlSchemaCount: 3,
    dmlTableCount: 3,
    findingCount: 2,
    routineCount: 0,
    securityDefinerExecutableCount: 0,
    sequenceCount: 1,
    tableCount: 3,
  });
  assert.equal(report.schemaVersion, 1);
});

test('reports privilege escalation paths without embedding credentials or context values', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [
      {
        attributes: ordinaryRole,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedSchemas: [],
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
      'runtime_role_has_cross_owner_dml',
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

test('flags direct relation control and executable security-definer authority', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
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
        privileges: { ...snapshot.tables[0].privileges, truncate: true },
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
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedSchemas: [],
        relationPrivilegeSchemas: ['private'],
        role: 'table_truncator',
        securityDefinerRoutines: [],
      },
      {
        attributes: ordinaryRole,
        canSetRole: true,
        createSchemas: [],
        databaseCreate: false,
        ownedRelations: [],
        ownedSchemas: [],
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
      'runtime_role_has_cross_owner_dml',
    ],
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
