import { Cause, Option, Redacted, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { hasTrustedContextValue } from '../database-trust-audit/collect-snapshot.mts';
import {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError,
  databaseTrustBoundaryExitCode,
  findAcceptance,
  getDatabaseTrustBoundaryFailureMessage,
  getEffectiveDatabaseEndpoint,
} from '../database-trust-audit/report.mts';
import type {
  DatabaseIdentitySnapshot,
  DatabaseIdentityTrustReport,
  DatabaseTrustBoundaryReport,
  DatabaseTrustBoundarySnapshot,
  DatabaseTrustManifestEntry,
  DatabaseTrustRoutineExpectation,
  GlobalTrustSnapshot,
} from '../database-trust-audit/report.mts';

const contactsCustomersTable = 'contacts.customers';

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

const allDmlPrivileges = {
  delete: true,
  insert: true,
  maintain: false,
  references: false,
  select: true,
  trigger: false,
  truncate: false,
  update: true,
};

const allTableGrants = { delete: true, insert: true, select: true, update: true };

const closedTrustedContext = {
  legalEntitySettingRetainedAfterRollback: false,
  legalEntitySettingSettable: true,
  scopeRetainedAfterCommit: false,
  scopeRetainedAfterRollback: false,
  sessionSettingRetainedAfterCommit: false,
  tenantSetLocalSettable: false,
  tenantSettingRetainedAfterRollback: false,
  tenantSettingSettable: true,
  transactionLocal: true,
  trustedScope: { executable: false, forgedSealAccepted: false, sessionSettingAccepted: false },
} as const;

const snapshot = {
  administrativeRole: 'ontos_admin',
  columnPrivileges: [],
  database: 'ontos',
  databasePrivileges: { connect: true, create: false, temporary: false },
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
  policies: [
    {
      command: 'all',
      policy: 'customers_tenant_isolation',
      readsSessionSetting: true,
      readsTrustedScope: false,
      schema: 'contacts',
      table: 'customers',
    },
  ],
  role: ordinaryRole,
  roleSettings: [],
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
      privileges: allDmlPrivileges,
      rlsEnabled: true,
      rlsForced: true,
      schema: 'contacts',
      table: 'customers',
      tableGrants: allTableGrants,
    },
    {
      kind: 'table',
      owner: 'ontos_admin',
      privileges: allDmlPrivileges,
      rlsEnabled: false,
      rlsForced: false,
      schema: 'auth',
      table: 'user',
      tableGrants: allTableGrants,
    },
    {
      kind: 'table',
      owner: 'ontos_admin',
      privileges: allDmlPrivileges,
      rlsEnabled: false,
      rlsForced: false,
      schema: 'core',
      table: 'tenants',
      tableGrants: allTableGrants,
    },
  ],
  trustedContext: closedTrustedContext,
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

const emptyGlobal: GlobalTrustSnapshot = { identityMemberships: [], trustRoutines: [], trustTableGrantees: [] };

const legacyEntry: DatabaseTrustManifestEntry = {
  acceptedFindings: [],
  identity: { id: 'shared_runtime', role: 'ontos_runtime' },
  kind: 'legacy_shared',
  revokedSchemas: [],
  roleSettings: [],
};

const onlyIdentity = (report: DatabaseTrustBoundaryReport): DatabaseIdentityTrustReport =>
  Option.getOrThrow(Option.fromNullishOr(report.identities[0]));

/** Audits one snapshot as the legacy shared runtime identity. */
const legacyReport = (
  value: DatabaseTrustBoundarySnapshot,
  entry: DatabaseTrustManifestEntry = legacyEntry,
): DatabaseIdentityTrustReport =>
  onlyIdentity(
    buildDatabaseTrustBoundaryReport(
      {
        administrativeRole: value.administrativeRole,
        database: value.database,
        global: emptyGlobal,
        identities: [{ identityId: 'shared_runtime', scopeAuthority: 'session_setting', snapshot: value }],
      },
      [entry],
      [],
    ),
  );

const buildHardenedReport = (overrides: Partial<DatabaseTrustBoundarySnapshot> = {}) =>
  legacyReport({ ...hardenedSnapshot, ...overrides });

const findingCodes = (report: Pick<DatabaseIdentityTrustReport, 'findings'>) => report.findings.map(({ code }) => code);

const reversed = <Value extends object>(values: readonly Value[]): Value[] => {
  const [head, ...tail] = values;
  return head === undefined ? [] : [...reversed(tail), head];
};

it('builds deterministic current-state evidence and identifies the material trust gaps', () => {
  const fullReport = buildDatabaseTrustBoundaryReport(
    {
      administrativeRole: snapshot.administrativeRole,
      database: snapshot.database,
      global: emptyGlobal,
      identities: [
        {
          identityId: 'shared_runtime',
          scopeAuthority: 'session_setting',
          snapshot: { ...snapshot, schemas: reversed(snapshot.schemas), tables: reversed(snapshot.tables) },
        },
      ],
    },
    [legacyEntry],
    [],
  );
  const report = onlyIdentity(fullReport);

  expect(report.snapshot.schemas.map(({ schema }) => schema)).toEqual(['auth', 'contacts', 'core']);
  expect(report.snapshot.tables.map(({ schema, table }) => `${schema}.${table}`)).toEqual([
    'auth.user',
    contactsCustomersTable,
    'core.tenants',
  ]);
  expect(
    report.snapshot.defaultPrivileges.map(({ grantee, schema, source }) => `${source}:${grantee}:${schema}`),
  ).toEqual(['inherited:analytics_reader:null', 'public:PUBLIC:auth', 'direct:ontos_runtime:contacts']);
  expect(report.findings.map(({ code, severity }) => `${severity}:${code}`)).toEqual([
    'high:runtime_role_can_forge_trusted_context',
    'high:runtime_role_has_cross_schema_dml',
  ]);
  expect(report.summary).toEqual({
    acceptedFindingCount: 0,
    auditedSchemaCount: 3,
    columnPrivilegeCount: 0,
    defaultPrivilegeCount: 3,
    dmlSchemaCount: 3,
    dmlTableCount: 3,
    findingCount: 2,
    grantOptionCount: 0,
    parameterPrivilegeCount: 0,
    policyCount: 1,
    privilegedOwnerViewCount: 0,
    routineCount: 0,
    securityDefinerExecutableCount: 0,
    sequenceCount: 1,
    tableCount: 3,
    typeCount: 0,
    unacceptedFindingCount: 2,
  });
  expect(fullReport.schemaVersion).toBe(2);
  expect(fullReport.unacceptedFindingCount).toBe(2);
});

it('orders audit evidence by code units rather than locale collation', () => {
  const report = legacyReport({
    ...snapshot,
    types: [
      { kind: 'enum', owner: 'ontos_admin', schema: 'ärea', type: 'status' },
      { kind: 'enum', owner: 'ontos_admin', schema: 'zeta', type: 'status' },
    ],
  });

  expect(report.snapshot.types.map(({ schema, type }) => `${schema}.${type}`)).toEqual(['zeta.status', 'ärea.status']);
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
  const report = legacyReport({
    ...snapshot,
    defaultPrivileges: [
      { ...sharedPrivilege, owner: 'zeta_owner' },
      { ...sharedPrivilege, owner: 'alpha_owner' },
    ],
  });

  expect(report.snapshot.defaultPrivileges.map(({ owner }) => owner)).toEqual(['alpha_owner', 'zeta_owner']);
});

it('extracts typed audit failures from an Effect cause', () => {
  const reason = 'DATABASE_ADMIN_URL and DATABASE_URL must use distinct roles';

  expect(getDatabaseTrustBoundaryFailureMessage(Cause.fail(new DatabaseTrustBoundaryAuditError({ reason })))).toBe(
    reason,
  );
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
  const report = legacyReport({
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
    schemas: [...snapshot.schemas, { create: true, owner: 'empty_owner', schema: 'empty', usage: true }],
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

  const ownerContextReport = legacyReport(base);
  expect(ownerContextReport.findings.map(({ code }) => code)).toEqual(['runtime_role_can_use_privileged_owner_view']);
  expect(ownerContextReport.summary.privilegedOwnerViewCount).toBe(1);

  const writableReport = legacyReport({
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
  expect(findingCodes(writableReport)).toEqual(['runtime_role_can_use_privileged_owner_view']);

  const readOnlyReport = legacyReport({
    ...base,
    tables: [
      {
        ...ownerContextView,
        privileges: {
          ...ownerContextView.privileges,
          select: false,
          update: true,
        },
        updatable: false,
      },
    ],
  });
  expect(readOnlyReport.findings).toEqual([]);

  const invokerReport = legacyReport({
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
  const report = legacyReport({
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

  expect(report.snapshot.tables[0]?.kind).toBe('materialized-view');
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
        signature: 'contacts.refresh_projection()',
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
        signature: 'contacts.enter_trusted_scope(uuid)',
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
  const report = legacyReport({
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
  const report = legacyReport({
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
        ownedRelations: [contactsCustomersTable],
        ownedRoutines: [],
        ownedSchemas: [],
        ownedTypes: [],
        relationPrivilegeSchemas: [],
        role: 'contacts_owner',
        securityDefinerRoutines: [],
      },
    ],
  });

  expect(findingCodes(report)).toEqual(['runtime_role_can_assume_privileged_role', 'runtime_role_has_ddl_authority']);
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

it('uses the native driver effective query-parameter socket endpoints', () => {
  expect(
    getEffectiveDatabaseEndpoint(
      Redacted.make(
        'postgresql://authority_user:password@authority.invalid:5432/ontos?host=%2Fvar%2Frun%2Fruntime-db&port=6432',
      ),
    ),
  ).toStrictEqual(Result.succeed({ configuredHost: '/var/run/runtime-db', configuredPort: 6432 }));
  expect(getEffectiveDatabaseEndpoint(Redacted.make('postgresql://authority_user:password@[::1]/ontos'))).toStrictEqual(
    Result.succeed({ configuredHost: '::1', configuredPort: 5432 }),
  );
  expect(getEffectiveDatabaseEndpoint(Redacted.make('postgresql:///ontos?user=authority_user'))).toStrictEqual(
    Result.succeed({ configuredHost: 'localhost', configuredPort: 5432 }),
  );
});

const failureMessage = (result: Result.Result<void, { readonly message: string }>): string | undefined =>
  Result.isFailure(result) ? result.failure.message : undefined;

it('requires direct, distinct live database session identities', () => {
  expect(
    failureMessage(
      assertDatabaseSessionIdentities([
        { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
        { currentRole: 'ontos_runtime', sessionRole: 'ontos_runtime' },
      ]),
    ),
  ).toBeUndefined();
  expect(
    failureMessage(
      assertDatabaseSessionIdentities([
        { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
        { currentRole: 'ontos_admin', sessionRole: 'ontos_admin' },
      ]),
    ),
  ).toMatch(/distinct authenticated PostgreSQL roles/u);
  expect(
    failureMessage(
      assertDatabaseSessionIdentities([
        { currentRole: 'startup_role', sessionRole: 'ontos_runtime' },
        { currentRole: 'ontos_runtime', sessionRole: 'ontos_runtime' },
      ]),
    ),
  ).toMatch(/current_user must equal session_user/u);
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

  expect(failureMessage(assertSameDatabaseTarget(target, { ...target }, 'DATABASE_URL'))).toBeUndefined();
  expect(failureMessage(assertSameDatabaseTarget(target, { ...target, database: 'other' }, 'DATABASE_URL'))).toMatch(
    /same PostgreSQL server and database/u,
  );
  expect(
    failureMessage(
      assertSameDatabaseTarget(
        target,
        { ...target, serverAddress: alternateServerAddress },
        'PARTY_REGISTRY_DATABASE_URL',
      ),
    ),
  ).toMatch(/DATABASE_ADMIN_URL and PARTY_REGISTRY_DATABASE_URL must target the same PostgreSQL server and database/u);
  expect(
    failureMessage(
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
        'DATABASE_URL',
      ),
    ),
  ).toMatch(/same PostgreSQL server and database/u);
});

it('treats transaction-local context retention as a critical boundary failure', () => {
  const report = legacyReport({
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

const partyRole = 'party_registry_runtime';
const currentTenantSignature = 'trust.current_tenant_id()';
const partiesTable = 'party.parties';
const workerRole = 'party_registry_worker';
const bearerRoleSettings = ['log_parameter_max_length=0', 'log_parameter_max_length_on_error=0'];
const trustedRoutineConfig = ['search_path=pg_catalog, pg_temp'];
const noDml = { ...allDmlPrivileges, delete: false, insert: false, select: false, update: false };
const noTableGrants = { delete: false, insert: false, select: false, update: false };

const trustRoutine = (routine: string, identityArguments = '') => ({
  executable: true,
  identityArguments,
  kind: 'function' as const,
  owner: 'ontos_admin',
  routine,
  schema: 'trust',
  securityDefiner: true,
  signature: `trust.${routine}(${identityArguments})`,
});

const partySnapshot = {
  ...hardenedSnapshot,
  columnPrivileges: [{ column: 'display_name', privilege: 'update', schema: 'party', table: 'party_names' }],
  defaultPrivileges: [],
  policies: [
    {
      command: 'all',
      policy: 'parties_gateway_scope',
      readsSessionSetting: false,
      readsTrustedScope: true,
      schema: 'party',
      table: 'parties',
    },
  ],
  roleSettings: bearerRoleSettings.map((setting) => ({ scope: 'all_databases' as const, setting })),
  routines: [trustRoutine('current_tenant_id'), trustRoutine('establish_gateway_scope', 'text')],
  runtimeRole: partyRole,
  schemas: [
    { create: false, owner: 'ontos_admin', schema: 'party', usage: true },
    { create: false, owner: 'ontos_admin', schema: 'public', usage: true },
    { create: false, owner: 'ontos_admin', schema: 'trust', usage: true },
  ],
  sequences: [],
  tables: [
    {
      ...snapshot.tables[0],
      privileges: { ...allDmlPrivileges, delete: false },
      schema: 'party',
      table: 'parties',
      tableGrants: { ...allTableGrants, delete: false },
    },
    {
      ...snapshot.tables[0],
      privileges: { ...noDml, select: true },
      schema: 'party',
      table: 'party_names',
      tableGrants: { ...noTableGrants, select: true },
    },
  ],
  trustedContext: { ...closedTrustedContext, trustedScope: { ...closedTrustedContext.trustedScope, executable: true } },
} as const satisfies DatabaseTrustBoundarySnapshot;

const partyEntry = {
  grants: {
    acceptedFindings: [],
    routines: [currentTenantSignature, 'trust.establish_gateway_scope(text)'],
    schemas: ['party', 'trust'],
    sequences: [],
    tables: [
      { privileges: ['select', 'insert', 'update'], reason: 'party writes', table: partiesTable },
      {
        columns: { update: ['display_name'] },
        privileges: ['select', 'update'],
        reason: 'display name edits',
        table: 'party.party_names',
      },
    ],
  },
  identity: { id: 'party_registry_request', role: partyRole },
  kind: 'explicit',
  roleSettings: bearerRoleSettings,
} as const satisfies DatabaseTrustManifestEntry;

const trustExpectations: readonly DatabaseTrustRoutineExpectation[] = [
  { executableBy: [partyRole], securityDefiner: true, signature: currentTenantSignature },
  { executableBy: [partyRole], securityDefiner: true, signature: 'trust.establish_gateway_scope(text)' },
];

const hardenedGlobal: GlobalTrustSnapshot = {
  identityMemberships: [],
  trustRoutines: trustExpectations.map(({ executableBy, securityDefiner, signature }) => ({
    config: trustedRoutineConfig,
    grantees: executableBy,
    owner: 'ontos_admin',
    publicExecute: false,
    securityDefiner,
    signature,
  })),
  trustTableGrantees: [],
};

const partyIdentity = (value: DatabaseTrustBoundarySnapshot = partySnapshot): DatabaseIdentitySnapshot => ({
  identityId: 'party_registry_request',
  scopeAuthority: 'gateway_grant',
  snapshot: value,
});

const auditIdentities = (
  identities: readonly DatabaseIdentitySnapshot[],
  options: {
    readonly global?: GlobalTrustSnapshot;
    readonly manifest?: readonly DatabaseTrustManifestEntry[];
  } = {},
): DatabaseTrustBoundaryReport =>
  buildDatabaseTrustBoundaryReport(
    { administrativeRole: 'ontos_admin', database: 'ontos', global: options.global ?? hardenedGlobal, identities },
    options.manifest ?? [partyEntry],
    trustExpectations,
  );

const partyReport = (
  overrides: Partial<DatabaseTrustBoundarySnapshot> = {},
  entry: DatabaseTrustManifestEntry = partyEntry,
): DatabaseIdentityTrustReport =>
  onlyIdentity(auditIdentities([partyIdentity({ ...partySnapshot, ...overrides })], { manifest: [entry] }));

const findingObjects = (report: Pick<DatabaseIdentityTrustReport, 'findings'>) =>
  report.findings.map(({ code, objects }) => `${code}:${objects.join(',')}`);

it('reports zero findings for a compliant gateway-scoped Party request identity', () => {
  const report = auditIdentities([partyIdentity()]);

  expect(report.globalFindings).toEqual([]);
  expect(report.unacceptedFindingCount).toBe(0);
  expect(onlyIdentity(report).findings).toEqual([]);
  expect(onlyIdentity(report).scopeAuthority).toBe('gateway_grant');
  expect(databaseTrustBoundaryExitCode(report)).toBe(0);
});

it('flags a table privilege the explicit manifest does not declare', () => {
  const report = partyReport({
    tables: [
      { ...partySnapshot.tables[0], privileges: allDmlPrivileges, tableGrants: allTableGrants },
      partySnapshot.tables[1],
    ],
  });

  expect(findingObjects(report)).toEqual(['runtime_role_privilege_outside_manifest:party.parties']);
});

it('flags a column privilege the explicit manifest does not declare', () => {
  const report = partyReport({
    columnPrivileges: [
      ...partySnapshot.columnPrivileges,
      { column: 'legal_name', privilege: 'update', schema: 'party', table: 'party_names' },
    ],
  });

  expect(findingObjects(report)).toEqual(['runtime_role_privilege_outside_manifest:party.party_names(legal_name)']);
});

it('flags a table-wide grant where the manifest declares column grants', () => {
  const report = partyReport({
    tables: [
      partySnapshot.tables[0],
      { ...partySnapshot.tables[1], tableGrants: { ...noTableGrants, select: true, update: true } },
    ],
  });

  expect(findingObjects(report)).toEqual(['runtime_role_privilege_outside_manifest:party.party_names']);
});

it('flags undeclared schemas and SECURITY DEFINER routines but expects public USAGE', () => {
  const report = partyReport({
    routines: [...partySnapshot.routines, trustRoutine('register_gateway_scope_grant', 'text')],
    schemas: [...partySnapshot.schemas, { create: false, owner: 'ontos_admin', schema: 'contacts', usage: true }],
  });

  expect(findingObjects(report)).toEqual([
    'runtime_role_can_execute_security_definer:trust.register_gateway_scope_grant(text)',
    'runtime_role_privilege_outside_manifest:contacts,trust.register_gateway_scope_grant(text)',
  ]);
});

it('flags declared privileges that the role lacks', () => {
  const report = partyReport({
    columnPrivileges: [],
    routines: partySnapshot.routines.slice(0, 1),
    tables: [
      {
        ...partySnapshot.tables[0],
        privileges: { ...partySnapshot.tables[0].privileges, insert: false },
        tableGrants: { ...partySnapshot.tables[0].tableGrants, insert: false },
      },
    ],
  });

  expect(findingObjects(report)).toEqual([
    'runtime_role_missing_manifest_privilege:party.parties,party.party_names,trust.establish_gateway_scope(text)',
  ]);
});

it('reports column grants that the role lacks by column', () => {
  const report = partyReport({ columnPrivileges: [] });

  expect(findingObjects(report)).toEqual(['runtime_role_missing_manifest_privilege:party.party_names(display_name)']);
});

it('flags a gateway-scoped policy that reads an ontos.* session setting', () => {
  const report = partyReport({
    policies: [{ ...partySnapshot.policies[0], readsSessionSetting: true }],
  });

  expect(findingObjects(report)).toEqual(['runtime_role_can_forge_trusted_context:party.parties']);
});

it('flags a gateway-scoped accessor that accepts a forged seal or a plain session setting', () => {
  for (const trustedScope of [
    { executable: true, forgedSealAccepted: true, sessionSettingAccepted: false },
    { executable: true, forgedSealAccepted: false, sessionSettingAccepted: true },
  ]) {
    const report = partyReport({ trustedContext: { ...partySnapshot.trustedContext, trustedScope } });
    expect(findingObjects(report)).toEqual(['runtime_role_can_forge_trusted_context:trust.current_tenant_id()']);
  }
});

it('treats a retained scope seal as a critical boundary failure', () => {
  for (const retention of [{ scopeRetainedAfterCommit: true }, { scopeRetainedAfterRollback: true }]) {
    const report = partyReport({ trustedContext: { ...partySnapshot.trustedContext, ...retention } });
    expect(report.findings.map(({ code, objects, severity }) => `${severity}:${code}:${objects.join(',')}`)).toEqual([
      'critical:trusted_context_survives_transaction:ontos_trust.scope',
    ]);
  }
  const committed = partyReport({
    trustedContext: { ...partySnapshot.trustedContext, sessionSettingRetainedAfterCommit: true },
  });
  expect(findingObjects(committed)).toEqual(['trusted_context_survives_transaction:ontos.tenant_id']);
});

it('flags effective TEMPORARY authority', () => {
  const report = partyReport({ databasePrivileges: { connect: true, create: false, temporary: true } });

  expect(findingObjects(report)).toEqual(['runtime_role_has_temporary_authority:ontos']);
});

it('flags role settings that differ from the manifest in either direction', () => {
  const unexpected = partyReport({
    roleSettings: [
      ...partySnapshot.roleSettings,
      { scope: 'current_database', setting: 'log_parameter_max_length=0' },
      { scope: 'all_databases', setting: 'search_path=public' },
    ],
  });
  expect(findingObjects(unexpected)).toEqual([
    'runtime_role_has_role_settings:all_databases:search_path=public,current_database:log_parameter_max_length=0',
  ]);

  const missing = partyReport({ roleSettings: [] });
  expect(findingObjects(missing)).toEqual([
    'runtime_role_has_role_settings:all_databases:log_parameter_max_length=0,all_databases:log_parameter_max_length_on_error=0',
  ]);
});

const currentTenantRoutine: GlobalTrustSnapshot['trustRoutines'][number] = {
  config: trustedRoutineConfig,
  grantees: [partyRole],
  owner: 'ontos_admin',
  publicExecute: false,
  securityDefiner: true,
  signature: currentTenantSignature,
};

for (const [name, global, expectedObjects] of [
  [
    'PUBLIC execute',
    {
      ...hardenedGlobal,
      trustRoutines: [{ ...currentTenantRoutine, publicExecute: true }, ...hardenedGlobal.trustRoutines.slice(1)],
    },
    [currentTenantSignature],
  ],
  [
    'a mutable search_path',
    {
      ...hardenedGlobal,
      trustRoutines: [
        { ...currentTenantRoutine, config: ['search_path=public'] },
        ...hardenedGlobal.trustRoutines.slice(1),
      ],
    },
    [currentTenantSignature],
  ],
  [
    'a non-administrative owner',
    {
      ...hardenedGlobal,
      trustRoutines: [{ ...currentTenantRoutine, owner: partyRole }, ...hardenedGlobal.trustRoutines.slice(1)],
    },
    [currentTenantSignature],
  ],
  [
    'an undeclared grantee',
    {
      ...hardenedGlobal,
      trustRoutines: [
        { ...currentTenantRoutine, grantees: [partyRole, 'ontos_runtime'] },
        ...hardenedGlobal.trustRoutines.slice(1),
      ],
    },
    [currentTenantSignature],
  ],
  [
    'the wrong SECURITY DEFINER flag',
    {
      ...hardenedGlobal,
      trustRoutines: [{ ...currentTenantRoutine, securityDefiner: false }, ...hardenedGlobal.trustRoutines.slice(1)],
    },
    [currentTenantSignature],
  ],
  [
    'a missing routine',
    { ...hardenedGlobal, trustRoutines: hardenedGlobal.trustRoutines.slice(1) },
    [currentTenantSignature],
  ],
  [
    'an undeclared routine',
    {
      ...hardenedGlobal,
      trustRoutines: [...hardenedGlobal.trustRoutines, { ...currentTenantRoutine, signature: 'trust.bypass(uuid)' }],
    },
    ['trust.bypass(uuid)'],
  ],
  [
    'a runtime grantee on a trust table',
    {
      ...hardenedGlobal,
      trustTableGrantees: [{ grantee: 'ontos_runtime', privilege: 'select', table: 'trust.gateway_scope_grants' }],
    },
    ['trust.gateway_scope_grants'],
  ],
] satisfies readonly (readonly [string, GlobalTrustSnapshot, readonly string[]])[]) {
  it(`flags an unhardened trusted-scope entry point with ${name}`, () => {
    const report = auditIdentities([partyIdentity()], { global });

    expect(
      report.globalFindings.map(({ code, objects, severity }) => `${severity}:${code}:${objects.join(',')}`),
    ).toEqual([`critical:trusted_scope_entry_point_unhardened:${expectedObjects.join(',')}`]);
    expect(databaseTrustBoundaryExitCode(report)).toBe(1);
  });
}

it('flags two identities that authenticate as the same role', () => {
  const report = auditIdentities([partyIdentity(), { ...partyIdentity(), identityId: 'party_registry_worker' }]);

  expect(report.globalFindings.map(({ code, objects }) => `${code}:${objects.join(',')}`)).toEqual([
    `runtime_identities_share_role:${partyRole}`,
  ]);
});

it('flags membership between checked-in identities', () => {
  const workerIdentity: DatabaseIdentitySnapshot = {
    identityId: 'party_registry_worker',
    scopeAuthority: 'session_setting',
    snapshot: {
      ...partySnapshot,
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
          role: partyRole,
          securityDefinerRoutines: [],
        },
      ],
      runtimeRole: workerRole,
    },
  };
  const report = auditIdentities([partyIdentity(), workerIdentity], {
    global: { ...hardenedGlobal, identityMemberships: [{ member: partyRole, role: workerRole }] },
  });

  expect(report.globalFindings.map(({ code, objects }) => `${code}:${objects.join(',')}`)).toEqual([
    `runtime_identity_can_assume_other_identity:${partyRole}>${workerRole},${workerRole}>${partyRole}`,
  ]);
});

it('accepts a finding only when the accepted objects cover every finding object', () => {
  const accepted = [{ code: 'runtime_role_privilege_outside_manifest', objects: [partiesTable], reason: 'reviewed' }];
  const entry: DatabaseTrustManifestEntry = {
    ...partyEntry,
    grants: { ...partyEntry.grants, acceptedFindings: accepted },
  };
  const extraParties = { ...partySnapshot.tables[0], privileges: allDmlPrivileges, tableGrants: allTableGrants };

  const covered = partyReport({ tables: [extraParties, partySnapshot.tables[1]] }, entry);
  expect(covered.unacceptedFindings).toEqual([]);
  expect(covered.acceptedFindings.map(({ code, reason }) => `${code}:${reason}`)).toEqual([
    'runtime_role_privilege_outside_manifest:reviewed',
  ]);
  expect(covered.summary.acceptedFindingCount).toBe(1);

  const superset = partyReport(
    {
      columnPrivileges: [
        ...partySnapshot.columnPrivileges,
        { column: 'legal_name', privilege: 'update', schema: 'party', table: 'party_names' },
      ],
      tables: [extraParties, partySnapshot.tables[1]],
    },
    entry,
  );
  expect(superset.acceptedFindings).toEqual([]);
  expect(findingObjects({ findings: superset.unacceptedFindings })).toEqual([
    'runtime_role_privilege_outside_manifest:party.parties,party.party_names(legal_name)',
  ]);

  expect(Option.isSome(findAcceptance({ code: 'runtime_role_has_temporary_authority', objects: [] }, accepted))).toBe(
    false,
  );
  expect(
    Option.isSome(
      findAcceptance({ code: 'runtime_role_privilege_outside_manifest', objects: [partiesTable, 'party.extra'] }, [
        { code: 'runtime_role_privilege_outside_manifest', objects: 'all', reason: 'reviewed' },
      ]),
    ),
  ).toBe(true);
});

it('keeps cross-schema DML on the legacy shared identity only', () => {
  const legacy = legacyReport(snapshot, {
    ...legacyEntry,
    acceptedFindings: [{ code: 'runtime_role_has_cross_schema_dml', objects: 'all', reason: 'shared baseline' }],
  });
  expect(legacy.acceptedFindings.map(({ code }) => code)).toEqual(['runtime_role_has_cross_schema_dml']);
  expect(legacy.unacceptedFindings.map(({ code }) => code)).toEqual(['runtime_role_can_forge_trusted_context']);

  const contactsTable = { ...snapshot.tables[0], tableGrants: { ...allTableGrants, delete: false } };
  const explicit = partyReport(
    {
      schemas: [...partySnapshot.schemas, { create: false, owner: 'ontos_admin', schema: 'contacts', usage: true }],
      tables: [...partySnapshot.tables, { ...contactsTable, privileges: { ...allDmlPrivileges, delete: false } }],
    },
    {
      ...partyEntry,
      grants: {
        ...partyEntry.grants,
        schemas: [...partyEntry.grants.schemas, 'contacts'],
        tables: [
          ...partyEntry.grants.tables,
          { privileges: ['select', 'insert', 'update'], reason: 'contact links', table: contactsCustomersTable },
        ],
      },
    },
  );
  expect(explicit.summary.dmlSchemaCount).toBe(2);
  expect(explicit.findings).toEqual([]);
});

it("accepts the outbox worker's declared session-setting forge finding", () => {
  const workerEntry: DatabaseTrustManifestEntry = {
    grants: {
      acceptedFindings: [
        {
          code: 'runtime_role_can_forge_trusted_context',
          objects: [partiesTable],
          reason: 'outbox worker is multi-tenant by design',
        },
      ],
      routines: [],
      schemas: ['party'],
      sequences: [],
      tables: [{ privileges: ['select'], reason: 'outbox reads', table: partiesTable }],
    },
    identity: { id: 'party_registry_worker', role: workerRole },
    kind: 'explicit',
    roleSettings: [],
  };
  const workerSnapshot: DatabaseTrustBoundarySnapshot = {
    ...partySnapshot,
    columnPrivileges: [],
    policies: [{ ...partySnapshot.policies[0], readsSessionSetting: true, readsTrustedScope: false }],
    roleSettings: [],
    routines: [],
    runtimeRole: workerRole,
    schemas: partySnapshot.schemas.filter(({ schema }) => schema !== 'trust'),
    tables: [
      {
        ...partySnapshot.tables[0],
        privileges: { ...noDml, select: true },
        tableGrants: { ...noTableGrants, select: true },
      },
    ],
    trustedContext: closedTrustedContext,
  };
  const report = onlyIdentity(
    auditIdentities(
      [{ identityId: 'party_registry_worker', scopeAuthority: 'session_setting', snapshot: workerSnapshot }],
      {
        manifest: [workerEntry],
      },
    ),
  );

  expect(report.unacceptedFindings).toEqual([]);
  expect(findingObjects({ findings: report.acceptedFindings })).toEqual([
    'runtime_role_can_forge_trusted_context:party.parties',
  ]);
});

it('treats an identity without a manifest entry as holding no declared grants', () => {
  const report = onlyIdentity(auditIdentities([partyIdentity()], { manifest: [] }));

  expect(report.findings.map(({ code }) => code)).toEqual([
    'runtime_role_can_execute_security_definer',
    'runtime_role_privilege_outside_manifest',
    'runtime_role_has_role_settings',
  ]);
});

it('fails the audit on any unaccepted or global finding', () => {
  expect(databaseTrustBoundaryExitCode({ globalFindings: [], unacceptedFindingCount: 0 })).toBe(0);
  expect(databaseTrustBoundaryExitCode({ globalFindings: [], unacceptedFindingCount: 1 })).toBe(1);
  expect(
    databaseTrustBoundaryExitCode({
      globalFindings: [
        { code: 'runtime_identities_share_role', evidence: 'shared', objects: [partyRole], severity: 'critical' },
      ],
      unacceptedFindingCount: 0,
    }),
  ).toBe(1);
});

it('never accepts withheld Party/Contacts authority as the shared non-pilot baseline', () => {
  const report = legacyReport(snapshot, {
    ...legacyEntry,
    acceptedFindings: [
      { code: 'runtime_role_has_cross_schema_dml', objects: 'all', reason: 'non-pilot baseline' },
      { code: 'runtime_role_privilege_outside_manifest', objects: 'all', reason: 'must not override revocation' },
    ],
    kind: 'legacy_shared',
    revokedSchemas: ['contacts'],
  });
  const drift = report.unacceptedFindings.find(({ code }) => code === 'runtime_role_privilege_outside_manifest');
  expect(drift?.objects).toContain('contacts');
  expect(drift?.objects).toContain('contacts.customers');
  expect(drift?.objects).toContain('default:ontos_admin:sequence:contacts:USAGE');
  expect(report.acceptedFindings.flatMap(({ objects }) => objects)).not.toContain(contactsCustomersTable);
});

it('rejects withheld column, sequence and invoker-routine authority without schema usage', () => {
  const report = legacyReport(
    {
      ...hardenedSnapshot,
      columnPrivileges: [{ column: 'name', privilege: 'select', schema: 'contacts', table: 'customers' }],
      defaultPrivileges: [],
      routines: [{ ...trustRoutine('read'), schema: 'contacts', securityDefiner: false, signature: 'contacts.read()' }],
      schemas: [],
      sequences: [
        {
          owner: 'ontos_admin',
          privileges: { select: true, update: false, usage: false },
          schema: 'contacts',
          sequence: 'ids',
        },
      ],
      tables: [],
    },
    { ...legacyEntry, kind: 'legacy_shared', revokedSchemas: ['contacts'] },
  );
  expect(findingObjects(report)).toEqual([
    'runtime_role_privilege_outside_manifest:contacts.customers(name),contacts.ids,contacts.read()',
  ]);
});

it.each([
  ['table', 'core', 'direct'],
  ['sequence', null, 'public'],
  ['table', null, 'inherited'],
  ['sequence', 'party', 'assumable'],
] as const)(
  'rejects ordinary default %s grants in %s from %s for an explicit identity',
  (objectType, schema, source) => {
    const report = partyReport({
      defaultPrivileges: [
        {
          grantable: false,
          grantee: source === 'public' ? 'PUBLIC' : partyRole,
          objectType,
          owner: 'another_creator',
          privilege: 'SELECT',
          schema,
          source,
        },
      ],
    });
    expect(findingObjects(report)).toEqual([
      `runtime_role_privilege_outside_manifest:default:another_creator:${objectType}:${schema ?? '*'}:SELECT`,
    ]);
  },
);
