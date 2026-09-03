import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDatabaseTrustBoundaryReport,
  type DatabaseTrustBoundarySnapshot,
} from '../audit-database-trust-boundaries.mts';

const snapshot = {
  administrativeRole: 'ontos_admin',
  database: 'ontos',
  databasePrivileges: { connect: true, create: false, temporary: true },
  defaultPrivileges: [
    {
      grantable: false,
      objectType: 'sequence',
      owner: 'ontos_admin',
      privilege: 'USAGE',
      schema: 'contacts',
    },
    {
      grantable: false,
      objectType: 'table',
      owner: 'ontos_admin',
      privilege: 'SELECT',
      schema: 'auth',
    },
  ],
  memberships: [],
  role: {
    bypassRls: false,
    canCreateDatabases: false,
    canCreateRoles: false,
    canLogin: true,
    inherit: false,
    replication: false,
    superuser: false,
  },
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
    report.findings.map(({ code, severity }) => `${severity}:${code}`),
    ['high:runtime_role_can_forge_trusted_context', 'high:runtime_role_has_cross_owner_dml'],
  );
  assert.deepEqual(report.summary, {
    auditedSchemaCount: 3,
    defaultPrivilegeCount: 2,
    dmlSchemaCount: 3,
    dmlTableCount: 3,
    findingCount: 2,
    sequenceCount: 1,
    tableCount: 3,
  });
  assert.equal(report.schemaVersion, 1);
});

test('reports privilege escalation paths without embedding credentials or context values', () => {
  const report = buildDatabaseTrustBoundaryReport({
    ...snapshot,
    memberships: [{ canSetRole: true, role: 'ontos_admin' }],
    role: { ...snapshot.role, bypassRls: true },
    schemas: snapshot.schemas.map((schema) =>
      schema.schema === 'contacts' ? { ...schema, create: true } : schema,
    ),
  });

  assert.deepEqual(
    report.findings.map(({ code }) => code),
    [
      'runtime_role_is_privileged',
      'runtime_role_can_assume_administrative_role',
      'runtime_role_can_create_in_application_schema',
      'runtime_role_can_forge_trusted_context',
      'runtime_role_has_cross_owner_dml',
    ],
  );
  assert.doesNotMatch(JSON.stringify(report), /postgresql:|password|secret|tenant-id|entity-id/iu);
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
