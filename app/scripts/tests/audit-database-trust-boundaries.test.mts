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
  publications: [],
  subscriptions: [],
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

type RoleMembership = DatabaseTrustBoundarySnapshot['memberships'][number];
type RoutinePrivilege = DatabaseTrustBoundarySnapshot['routines'][number];

const reachableRole = (overrides: Partial<RoleMembership>): RoleMembership => ({
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
  securityDefinerRoutines: [],
  ...overrides,
  role: overrides.role ?? 'reachable_role',
});

const securityDefinerRoutine = (overrides: Partial<RoutinePrivilege>): RoutinePrivilege => ({
  executable: false,
  eventTriggerBindings: [],
  identityArguments: '',
  kind: 'function',
  owner: 'ontos_admin',
  policyBindings: [],
  routine: 'privileged_routine',
  schema: 'private',
  securityDefiner: true,
  storedExpressionBindings: [],
  triggerBindings: [],
  ...overrides,
});

const findingCodes = (report: ReturnType<typeof buildDatabaseTrustBoundaryReport>) =>
  report.findings.map(({ code }) => code);

const assertSourceContains = (source: string, patterns: ReadonlyArray<RegExp>) => {
  for (const pattern of patterns) {
    assert.match(source, pattern);
  }
};

const assertSourceOccurrences = (
  source: string,
  expectations: ReadonlyArray<readonly [pattern: RegExp, count: number]>,
) => {
  for (const [pattern, count] of expectations) {
    assert.equal(source.match(pattern)?.length ?? 0, count, `${pattern}`);
  }
};

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
    publicationCount: 0,
    privilegedOwnerViewCount: 0,
    routineCount: 0,
    securityDefinerExecutableCount: 0,
    sequenceCount: 1,
    subscriptionCount: 0,
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
      reachableRole({
        role: 'ontos_admin',
      }),
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

test('flags current database ownership even when CREATE was revoked', () => {
  const report = buildHardenedReport({
    databasePrivileges: { ...snapshot.databasePrivileges, owner: true },
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
});

test('classifies reachable predefined PostgreSQL roles as privileged', () => {
  const report = buildHardenedReport({
    memberships: [
      reachableRole({
        canInheritRole: true,
        canSetRole: false,
        parameterPrivileges: [],
        predefinedRole: true,
        role: 'pg_execute_server_program',
      }),
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
    grantOptions: [
      {
        authority: 'relation:contacts.customers:SELECT',
        role: snapshot.runtimeRole,
        source: 'direct',
      },
    ],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_grant_authority']);
  assert.equal(report.summary.grantOptionCount, 1);
});

test('flags creator-default grant options as persistent authority', () => {
  const report = buildHardenedReport({
    defaultPrivileges: [{ ...snapshot.defaultPrivileges[1], grantable: true }],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_grant_authority']);
  assert.equal(report.summary.grantOptionCount, 1);
});

test('classifies grant options held by a reachable role as privileged membership authority', () => {
  const report = buildHardenedReport({
    grantOptions: [
      {
        authority: 'database:ontos:CONNECT',
        role: 'grant_delegate',
        source: 'assumable',
      },
    ],
    memberships: [
      reachableRole({
        role: 'grant_delegate',
      }),
    ],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_can_assume_privileged_role']);
  assert.equal(report.summary.grantOptionCount, 1);
});

test('does not treat inheritance-only grant options as exercisable', () => {
  const report = buildHardenedReport({
    defaultPrivileges: [
      {
        ...snapshot.defaultPrivileges[0],
        grantable: true,
        grantee: 'inherited_reader',
        source: 'inherited',
      },
    ],
    memberships: [
      reachableRole({
        canInheritRole: true,
        canSetRole: false,
        role: 'inherited_reader',
      }),
    ],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_can_assume_other_role']);
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

test('flags ownership of an otherwise non-writable schema as DDL authority', () => {
  const report = buildHardenedReport({
    schemas: [{ create: false, owner: snapshot.runtimeRole, schema: 'runtime_owned' }],
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
});

test('flags ownership of an audited routine as DDL authority', () => {
  const report = buildHardenedReport({
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
  });

  assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
});

const directOwnershipCases = [
  {
    label: 'extension',
    overrides: {
      extensions: [{ extension: 'pgcrypto', owner: snapshot.runtimeRole, schema: 'public' }],
    },
    summary: 'extensionCount',
  },
  {
    label: 'publication',
    overrides: {
      publications: [{ owner: snapshot.runtimeRole, publication: 'tenant_changes' }],
    },
    summary: 'publicationCount',
  },
  {
    label: 'subscription',
    overrides: {
      subscriptions: [{ owner: snapshot.runtimeRole, subscription: 'tenant_changes' }],
    },
    summary: 'subscriptionCount',
  },
  {
    label: 'foreign-server',
    overrides: {
      foreignServers: [{ owner: snapshot.runtimeRole, server: 'customer_warehouse' }],
    },
    summary: 'foreignServerCount',
  },
  {
    label: 'foreign-data-wrapper',
    overrides: {
      foreignDataWrappers: [{ owner: snapshot.runtimeRole, wrapper: 'customer_connector' }],
    },
    summary: 'foreignDataWrapperCount',
  },
] satisfies ReadonlyArray<{
  readonly label: string;
  readonly overrides: Partial<DatabaseTrustBoundarySnapshot>;
  readonly summary: keyof ReturnType<typeof buildDatabaseTrustBoundaryReport>['summary'];
}>;

for (const { label, overrides, summary } of directOwnershipCases) {
  test(`flags direct ${label} ownership as DDL authority`, () => {
    const report = buildHardenedReport(overrides);

    assert.deepEqual(findingCodes(report), ['runtime_role_has_ddl_authority']);
    assert.equal(report.summary[summary], 1);
  });
}

const reachableOwnershipCases = [
  { label: 'extension', ownedExtensions: ['pgcrypto'] },
  { label: 'publication', ownedPublications: ['tenant_changes'] },
  { label: 'subscription', ownedSubscriptions: ['tenant_changes'] },
  { label: 'foreign-server', ownedForeignServers: ['customer_warehouse'] },
  { label: 'foreign-data-wrapper', ownedForeignDataWrappers: ['customer_connector'] },
] satisfies ReadonlyArray<Partial<RoleMembership> & { readonly label: string }>;

for (const { label, ...ownership } of reachableOwnershipCases) {
  test(`classifies an assumable ${label} owner as privileged`, () => {
    const report = buildHardenedReport({
      memberships: [reachableRole({ ...ownership, role: `${label}_owner` })],
    });

    assert.deepEqual(findingCodes(report), ['runtime_role_can_assume_privileged_role']);
  });
}

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
      securityDefinerRoutine({
        executable: true,
        identityArguments: 'uuid',
        routine: 'enter_trusted_scope',
        schema: 'contacts',
      }),
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

const runtimeSecurityDefinerCases = [
  {
    label: 'table triggers',
    routine: {
      routine: 'capture_customer_change',
      schema: 'contacts',
      triggerBindings: ['contacts.customers:capture_customer_change'],
    },
  },
  {
    label: 'accessible operators',
    routine: {
      identityArguments: 'integer, integer',
      operatorBindings: ['operator:public.##(integer,integer)'],
      routine: 'private_integer_equal',
    },
  },
  {
    label: 'accessible aggregate support paths',
    routine: {
      aggregateBindings: ['aggregate:public.audit_sum(integer):transition'],
      identityArguments: 'integer, integer',
      routine: 'private_sum_transition',
    },
  },
  {
    label: 'applicable RLS policies',
    routine: {
      identityArguments: 'uuid',
      policyBindings: ['contacts.customers:tenant_isolation'],
      routine: 'can_access_tenant',
    },
  },
  {
    label: 'stored expressions',
    routine: {
      routine: 'normalize_customer',
      storedExpressionBindings: [
        'contacts.customer_labels:domain-constraint:contacts.nonempty_text:nonempty_text_check',
        'contacts.customers:generated-column:normalized_name',
        'contacts.customers:expression-index:customers_normalized_name_idx',
        'contacts.customer_overview:view-expression',
      ],
    },
  },
  {
    label: 'applicable event triggers',
    routine: {
      eventTriggerBindings: ['event-trigger:audit_ddl:ddl_command_end[ALTER DEFAULT PRIVILEGES]'],
      routine: 'audit_ddl',
    },
  },
] satisfies ReadonlyArray<{
  readonly label: string;
  readonly routine: Partial<RoutinePrivilege>;
}>;

for (const { label, routine } of runtimeSecurityDefinerCases) {
  test(`flags security-definer routines invocable through ${label}`, () => {
    const report = buildHardenedReport({
      routines: [securityDefinerRoutine(routine)],
    });

    assert.deepEqual(findingCodes(report), ['runtime_role_can_execute_security_definer']);
    assert.equal(report.summary.securityDefinerExecutableCount, 1);
  });
}

const reachableSecurityDefinerCases = [
  {
    label: 'stored expressions',
    role: {
      role: 'expression_writer',
      securityDefinerStoredExpressionBindings: [
        'contacts.customers:check-constraint:customers_valid->private.validate_customer()',
      ],
    },
  },
  {
    label: 'operators',
    role: {
      role: 'operator_user',
      securityDefinerOperatorBindings: [
        'operator:public.##(integer,integer)->private.private_integer_equal(integer, integer)',
      ],
    },
  },
  {
    label: 'aggregate support paths',
    role: {
      role: 'aggregate_user',
      securityDefinerAggregateBindings: [
        'aggregate:public.audit_sum(integer):transition->private.private_sum_transition(integer, integer)',
      ],
    },
  },
  {
    label: 'RLS policies',
    role: {
      role: 'policy_reader',
      securityDefinerPolicyBindings: [
        'contacts.customers:tenant_isolation->private.can_access_tenant(uuid)',
      ],
    },
  },
  {
    label: 'triggers',
    role: {
      role: 'trigger_writer',
      securityDefinerTriggerBindings: [
        'contacts.customers:capture_customer_change->contacts.capture_customer_change()',
      ],
    },
  },
  {
    label: 'event triggers',
    role: {
      role: 'ddl_operator',
      securityDefinerEventTriggerBindings: [
        'event-trigger:audit_ddl:ddl_command_end[ALTER DEFAULT PRIVILEGES]->private.audit_ddl()',
      ],
    },
  },
] satisfies ReadonlyArray<{
  readonly label: string;
  readonly role: Partial<RoleMembership>;
}>;

for (const { label, role } of reachableSecurityDefinerCases) {
  test(`classifies reachable roles that invoke security-definer ${label} as privileged`, () => {
    const report = buildHardenedReport({
      memberships: [reachableRole(role)],
    });

    assert.deepEqual(findingCodes(report), ['runtime_role_can_assume_privileged_role']);
  });
}

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
      reachableRole({
        relationPrivilegeSchemas: ['private'],
        role: 'table_truncator',
      }),
      reachableRole({
        role: 'report_reader',
      }),
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
      reachableRole({
        canAdministerRole: true,
        canSetRole: false,
        ownedTypes: ['contacts.contact_status'],
        role: 'tenant_bypass',
      }),
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
    new URL('../audit-database-trust-boundaries.mts', import.meta.url),
    'utf-8',
  );

  assertSourceOccurrences(source, [
    [/where membership\.admin_option or membership\.set_option/gu, 1],
    [/\$\{reachableRolesCte\}/gu, 3],
    [/pg_catalog\.pg_options_to_table\([^)]*\.reloptions\)/gu, 6],
    [/from pg_catalog\.pg_trigger as audited_trigger/gu, 3],
    [/join trigger_routine_dependencies as trigger_dependency/gu, 2],
    [/audited_trigger\.tgenabled in \('O', 'A'\)/gu, 2],
    [/audited_trigger\.tgenabled = 'R'/gu, 2],
    [/pg_catalog\.pg_partition_ancestors\(relation\.oid\)/gu, 9],
    [
      /select relation\.oid\s+union\s+select ancestor\.oid\s+from pg_catalog\.pg_partition_ancestors\(relation\.oid\)/gu,
      8,
    ],
    [/from pg_catalog\.pg_policy as policy/gu, 3],
    [/\$\{storedExpressionDependenciesCte\}/gu, 2],
    [/\$\{referentialWritePathsCte\}/gu, 2],
    [/\$\{roleDdlCommandTagsCte\}/gu, 2],
    [/from dml_rule_write_paths as rule_write/gu, 4],
    [/policy\.polcmd in \('a', '\*'\)/gu, 2],
    [/from writable_view_paths as writable_view/gu, 8],
    [/from writable_view_paths as rule_view/gu, 4],
    [/from writable_view_columns as writable_column/gu, 6],
    [/from view_access_paths as view_access/gu, 2],
    [/from unnest\(stored_expression\.select_columns\) as selected\(attnum\)/gu, 2],
    [/stored_expression\.binding !~ '\^dml-rule:'/gu, 12],
    [/stored_expression\.binding ~ '\^dml-rule:INSERT:'/gu, 4],
    [/stored_expression\.binding ~ '\^dml-rule:UPDATE:'/gu, 4],
    [/stored_expression\.binding ~ '\^dml-rule:DELETE:'/gu, 6],
    [/from pg_catalog\.pg_trigger as before_update_trigger/gu, 2],
    [/cascade\.affected_oid = stored_expression\.invocation_oid/gu, 2],
    [/stored_expression\.binding !~ '\^column-default:'/gu, 2],
    [/from pg_catalog\.pg_event_trigger as event_trigger/gu, 2],
    [/from pg_catalog\.pg_operator as audited_operator/gu, 2],
    [/event_trigger\.evttags is null/gu, 4],
    [/from pg_catalog\.pg_partitioned_table as partitioned/gu, 4],
    [/audited_trigger\.tgtype & 12 <> 0/gu, 4],
    [/stored_expression\.selectable/gu, 10],
    [/cardinality\(audited_trigger\.tgattr::smallint\[\]\) = 0/gu, 6],
    [/from unnest\(audited_trigger\.tgattr::smallint\[\]\) as watched\(attnum\)/gu, 2],
  ]);

  assert.doesNotMatch(
    source,
    /or pg_has_role\(\$1, grantee\.oid, 'SET'\)\s+or grantee\.oid in \(select role_oid from administrable_roles\)/u,
  );

  assertSourceContains(source, [
    /candidate\.oid in \(select role_oid from reachable_roles\) as can_set_role/u,
    /view_dependencies\(view_oid, referenced_oid, effective_owner_oid\)/u,
    /referenced_relation\.relowner = dependency\.effective_owner_oid/u,
    /effective_owner\.rolbypassrls/u,
    /effective_owner\.rolsuper/u,
    /select audited_role\.role, audited_role\.source, authority\.grant_option/u,
    /trigger_routine_dependencies\(\s+trigger_oid,\s+routine_oid\s+\)/u,
    /dependency\.refobjid = audited_trigger\.tgfoid/u,
    /audited_trigger\.tgqual::text/u,
    /has_parameter_privilege\(\s+candidate\.oid,\s+'session_replication_role',\s+'SET'\s+\)/u,
    /has_parameter_privilege\(\$1, 'session_replication_role', 'SET'\)/u,
    /policy_routine_dependencies\(/u,
    /used_by_using/u,
    /used_by_with_check/u,
    /policy\.polwithcheck is null/u,
    /from pg_catalog\.pg_attrdef as expression/u,
    /from pg_catalog\.pg_constraint as expression/u,
    /from pg_catalog\.pg_index as stored_index/u,
    /pg_catalog\.pg_rewrite as expression/u,
    /view_invocation_paths\(invocation_oid, dependency_oid\)/u,
    /view_access_paths\(invocation_oid, affected_oid, effective_owner_oid\)/u,
    /direct_view_access_columns\(/u,
    /view_access_columns\(invocation_oid, affected_oid/u,
    /access\.affected_attnum = target\.fields\[1\]::smallint/u,
    /writable_view_rewrites\(view_oid, affected_oid, actions, target_list, effective_owner_oid\)/u,
    /direct_writable_view_paths\(invocation_oid, affected_oid, actions/u,
    /direct_writable_view_columns\(/u,
    /writable_view_columns\(/u,
    /writable_view_paths\(invocation_oid, affected_oid, actions, effective_owner_oid\)/u,
    /:resorigtbl \(\[1-9\]\[0-9\]\*\) :resorigcol/u,
    /split_part\(rewrite\.ev_action::text, ':rteperminfos', 1\)/u,
    /cross join lateral regexp_matches\(/u,
    /affected_relation\.oid <> view_relation\.oid/u,
    /pg_catalog\.pg_relation_is_updatable/u,
    /direct_dml_rule_write_paths\(/u,
    /dml_rule_write_paths\(/u,
    /:commandType \(\[234\]\).*:resultRelation/u,
    /action\.fields\[2\]::integer \+ 1/u,
    /path\.allowed_modes & nested\.allowed_modes/u,
    /relation_invocation_paths\(invocation_oid, dependency_oid\)/u,
    /stored_expression\.invocation_oid/u,
    /stored_expression\.select_columns/u,
    /expression_routine\.provolatile = 'v'/u,
    /nested-view-expression/u,
    /expression\.rulename <> '_RETURN'/u,
    /expression\.ev_type in \('2', '3', '4'\)/u,
    /expression\.ev_enabled in \('O', 'A', 'R'\)/u,
    /'dml-rule:%s:%s:%I'/u,
    /expression\.contypid/u,
    /before_update_trigger\.tgrelid = expression\.adrelid/u,
    /before_update_trigger\.tgrelid = stored_index\.indrelid/u,
    /before_update_trigger\.tgtype & 1 <> 0/u,
    /before_update_trigger\.tgtype & 2 <> 0/u,
    /before_update_trigger\.tgtype & 16 <> 0/u,
    /referential_write_paths\(/u,
    /foreign_key\.confdeltype/u,
    /foreign_key\.confupdtype/u,
    /foreign_key\.confdelsetcols/u,
    /changed\.attnum = any\(coalesce\(foreign_key\.confkey/u,
    /cascade\.affected_action/u,
    /cascade\.affected_uses_default/u,
    /join pg_catalog\.pg_extension as extension/u,
    /join pg_catalog\.pg_foreign_data_wrapper as foreign_data_wrapper/u,
    /join pg_catalog\.pg_foreign_server as foreign_server/u,
    /from pg_catalog\.pg_publication as publication/u,
    /publication\.pubowner = candidate\.oid/u,
    /from pg_catalog\.pg_subscription as subscription/u,
    /subscription\.subowner = candidate\.oid/u,
    /'ddl_command_end'::text, 'ALTER SUBSCRIPTION'::text/u,
    /has_database_privilege\(role\.oid, current_database\(\), 'TEMPORARY'\)/u,
    /cross join \(values \('GRANT'::text\), \('REVOKE'::text\)\)/u,
    /event_trigger\.evtevent = 'ddl_command_start'/u,
    /has_table_privilege\(role\.oid, relation\.oid, 'TRIGGER'\)/u,
    /trigger_routine\.prorettype = 'pg_catalog\.trigger'::regtype/u,
    /'ddl_command_end'::text, 'CREATE TRIGGER'::text/u,
    /'CREATE COLLATION'::text/u,
    /audited_operator\.oprcode = routine\.oid/u,
    /security_definer_operator_bindings/u,
    /operator_bindings/u,
    /aggregate_routine_dependencies\(/u,
    /aggregate\.aggtransfn/u,
    /aggregate\.aggfinalfn/u,
    /aggregate\.aggcombinefn/u,
    /aggregate\.aggserialfn/u,
    /aggregate\.aggdeserialfn/u,
    /aggregate\.aggmtransfn/u,
    /aggregate\.aggminvtransfn/u,
    /aggregate\.aggmfinalfn/u,
    /security_definer_aggregate_bindings/u,
    /aggregate_bindings/u,
    /'ddl_command_end'::text, 'ALTER PUBLICATION'::text/u,
    /left join lateral unnest\(event_trigger\.evttags\) as configured_tag\(name\) on true/u,
    /'SELECT WITH GRANT OPTION'/u,
    /has_column_privilege\(role\.oid, attribute\.attrelid/u,
    /has_function_privilege\(role\.oid, routine\.oid, 'EXECUTE WITH GRANT OPTION'\)/u,
    /format\('check-constraint:%I', expression\.conname\),\s+false,\s+array\[\]::smallint\[\]/u,
    /from pg_catalog\.pg_extension as extension/u,
    /from pg_catalog\.pg_foreign_server as foreign_server/u,
    /foreign_data_wrapper\.fdwowner/u,
    /join audit_owners as owner on owner\.oid = defaults\.defaclrole/u,
    /as can_create_schema/u,
    /as can_create_object/u,
    /object_types\.catalog_code = 'n'\s+and owner\.can_create_schema/u,
    /object_types\.catalog_code <> 'n'\s+and owner\.can_create_object/u,
    /owner\.rolname = \$1 as owner/u,
    /candidate\.oid = \(\s+select database\.datdba/u,
    /namespace\.nspowner = owner\.oid\s+or has_schema_privilege\(owner\.oid, namespace\.oid, 'CREATE'\)/u,
  ]);
});

test('treats inherited owner-role authority as effective runtime DDL authority', () => {
  const report = buildHardenedReport({
    memberships: [
      reachableRole({
        canInheritRole: true,
        canSetRole: false,
        ownedRelations: ['contacts.customers'],
        role: 'contacts_owner',
      }),
    ],
  });

  assert.deepEqual(findingCodes(report), [
    'runtime_role_can_assume_privileged_role',
    'runtime_role_has_ddl_authority',
  ]);
});

test('treats SET-reachable database ownership as effective runtime DDL authority', () => {
  const report = buildHardenedReport({
    memberships: [
      reachableRole({
        databaseOwner: true,
        role: 'database_owner',
      }),
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
      reachableRole({
        attributes: { ...ordinaryRole, bypassRls: true },
        canInheritRole: true,
        canSetRole: false,
        role: 'attribute_only_role',
      }),
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
