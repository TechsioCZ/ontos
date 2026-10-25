import {
  DATABASE_IDENTITIES,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from '@app/core-runtime';
import type { DatabaseRoleGrants } from '@app/core-runtime';
import { is, sql } from 'drizzle-orm';
import type { PgPolicy, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig, PgRole } from 'drizzle-orm/pg-core';
import { Effect } from 'effect';

import {
  PARTY_REGISTRY_REQUEST_DATABASE_GRANTS,
  PARTY_REGISTRY_WORKER_DATABASE_GRANTS,
} from '../src/db/database-grants.ts';
import type { PartyDatabaseExecutor } from '../src/db/types.ts';

/**
 * Catalog checks shared by the Party and Contacts verifiers. Expected privileges come from the Party
 * grant declarations, which the root database role manifest (scripts/postgres/database-role-manifest.mts)
 * adopts verbatim for the two Party roles. Every other runtime identity owns nothing in `party` or
 * `contacts`: the manifest revokes both schemas from ontos_runtime and grants the issuer only `trust`.
 * Expected policies come from the Drizzle table definitions.
 */

const TABLE_PRIVILEGES = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] as const;

const LEGAL_ENTITY_TABLES = new Set([
  'counterparties',
  'counterparty_role_periods',
  'privacy_measure_executions',
  'counterparty_admin_read_models',
]);

interface TablePrivilegeRow extends Readonly<Record<string, boolean | string>> {
  readonly granted: boolean;
  readonly privilege: string;
  readonly role_name: string;
  readonly table_name: string;
}

interface ColumnPrivilegeRow extends Readonly<Record<string, string>> {
  readonly column_name: string;
  readonly privilege: string;
  readonly role_name: string;
  readonly table_name: string;
}

interface SchemaPrivilegeRow extends Readonly<Record<string, boolean | string>> {
  readonly can_create: boolean;
  readonly can_use: boolean;
  readonly role_name: string;
}

/** A policy row; an absent USING or WITH CHECK expression is read as the empty string. */
interface PolicyRow extends Readonly<Record<string, string>> {
  readonly command: string;
  readonly policy_name: string;
  readonly qual: string;
  readonly role_names: string;
  readonly table_name: string;
  readonly with_check: string;
}

interface RlsRow extends Readonly<Record<string, boolean | string>> {
  readonly force_rls: boolean;
  readonly row_security: boolean;
  readonly table_name: string;
}

interface ExpectedTablePrivileges {
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
  readonly table: ReadonlySet<string>;
}

const NO_PRIVILEGES: ExpectedTablePrivileges = { columns: new Map(), table: new Set() };

const runtimeRoles = DATABASE_IDENTITIES.map((identity) => identity.role);

const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

const PARTY_GRANTS_BY_ROLE: ReadonlyMap<string, DatabaseRoleGrants> = new Map([
  [PARTY_REGISTRY_REQUEST_IDENTITY.role, PARTY_REGISTRY_REQUEST_DATABASE_GRANTS],
  [PARTY_REGISTRY_WORKER_IDENTITY.role, PARTY_REGISTRY_WORKER_DATABASE_GRANTS],
]);

/** Privileges `role` is declared to hold on `schema.table`, split into table-level and column-level grants. */
const expectedTablePrivileges = (role: string, qualifiedTable: string): ExpectedTablePrivileges => {
  const grant = PARTY_GRANTS_BY_ROLE.get(role)?.tables.find((candidate) => candidate.table === qualifiedTable);
  if (grant === undefined) {
    return NO_PRIVILEGES;
  }
  const table = new Set<string>();
  const columns = new Map<string, ReadonlySet<string>>();
  for (const privilege of grant.privileges) {
    const columnGrant = privilege === 'delete' ? undefined : grant.columns?.[privilege];
    if (columnGrant === undefined) {
      table.add(privilege);
    } else {
      columns.set(privilege, new Set(columnGrant));
    }
  }
  return { columns, table };
};

const expectedSchemaUsage = (role: string, schema: string): boolean =>
  PARTY_GRANTS_BY_ROLE.get(role)?.schemas.includes(schema) ?? false;

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

const describe = (values: Iterable<string>): string => `{${[...values].toSorted().join(',')}}`;

/** Every runtime role exists, none may CREATE in `schema`, and only declared roles may use it. */
const schemaPrivilegeMismatches = (schema: string, rows: readonly SchemaPrivilegeRow[]): readonly string[] => {
  const mismatches: string[] = [];
  const foundRoles = new Set(rows.map((row) => row.role_name));
  for (const role of runtimeRoles) {
    if (!foundRoles.has(role)) {
      mismatches.push(`Runtime role ${role} does not exist`);
    }
  }
  for (const row of rows) {
    if (row.can_create) {
      mismatches.push(`${row.role_name} has CREATE on schema ${schema}`);
    }
    const usage = expectedSchemaUsage(row.role_name, schema);
    if (usage !== row.can_use) {
      mismatches.push(`${row.role_name} USAGE on schema ${schema} is ${row.can_use}, expected ${usage}`);
    }
  }
  return mismatches;
};

const groupTablePrivileges = (schema: string, rows: readonly TablePrivilegeRow[]) => {
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.role_name} ${schema}.${row.table_name}`;
    const privileges = actual.get(key) ?? new Set<string>();
    if (row.granted) {
      privileges.add(row.privilege);
    }
    actual.set(key, privileges);
  }
  return actual;
};

const groupColumnPrivileges = (schema: string, rows: readonly ColumnPrivilegeRow[]) => {
  const actual = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const key = `${row.role_name} ${schema}.${row.table_name}`;
    const byPrivilege = actual.get(key) ?? new Map<string, Set<string>>();
    const columns = byPrivilege.get(row.privilege) ?? new Set<string>();
    columns.add(row.column_name);
    byPrivilege.set(row.privilege, columns);
    actual.set(key, byPrivilege);
  }
  return actual;
};

const columnPrivilegeMismatches = (
  role: string,
  qualifiedTable: string,
  actualByPrivilege: ReadonlyMap<string, ReadonlySet<string>>,
  expected: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] =>
  [...new Set<string>([...actualByPrivilege.keys(), ...expected.keys()])].flatMap((privilege) => {
    const actualSet = actualByPrivilege.get(privilege) ?? new Set<string>();
    const expectedSet = expected.get(privilege) ?? new Set<string>();
    return sameSet(actualSet, expectedSet)
      ? []
      : [
          `${role} ${privilege} columns on ${qualifiedTable} are ${describe(actualSet)}, expected ${describe(expectedSet)}`,
        ];
  });

/** Table- and column-level privileges of every runtime role on `schema` match the Party declarations. */
const tablePrivilegeMismatches = (
  schema: string,
  tableRows: readonly TablePrivilegeRow[],
  columnRows: readonly ColumnPrivilegeRow[],
): readonly string[] => {
  const actualColumns = groupColumnPrivileges(schema, columnRows);
  return [...groupTablePrivileges(schema, tableRows)].flatMap(([key, actual]) => {
    const [role = '', qualifiedTable = ''] = key.split(' ');
    const expected = expectedTablePrivileges(role, qualifiedTable);
    const tableMismatch = sameSet(actual, expected.table)
      ? []
      : [`${role} table privileges on ${qualifiedTable} are ${describe(actual)}, expected ${describe(expected.table)}`];
    return [
      ...tableMismatch,
      ...columnPrivilegeMismatches(role, qualifiedTable, actualColumns.get(key) ?? new Map(), expected.columns),
    ];
  });
};

/**
 * Compares the live table, column and schema privileges of every runtime identity on `schema` with the
 * Party grant declarations. Returns one line per mismatch.
 */
export const rolePrivilegeMismatches = Effect.fn('DatabaseRoleContract.rolePrivilegeMismatches')(
  function* rolePrivilegeMismatches(executor: PartyDatabaseExecutor, schema: string) {
    const tablePrivileges = yield* executor.execute<TablePrivilegeRow>(
      sql`
      select
        role_name,
        relation.relname as table_name,
        privilege,
        has_table_privilege(role_name, relation.oid, upper(privilege)) as granted
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join unnest(${textArray(runtimeRoles)}) as role_name
      cross join unnest(${textArray(TABLE_PRIVILEGES)}) as privilege
      where namespace.nspname = ${schema}
        and relation.relkind in (${'r'}, ${'p'})
        and exists (select 1 from pg_catalog.pg_roles as role where role.rolname = role_name)
    `,
      'objects',
    );
    const columnPrivileges = yield* executor.execute<ColumnPrivilegeRow>(
      sql`
      select
        pg_catalog.pg_get_userbyid(acl.grantee) as role_name,
        relation.relname as table_name,
        attribute.attname as column_name,
        lower(acl.privilege_type) as privilege
      from pg_catalog.pg_attribute as attribute
      inner join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral aclexplode(attribute.attacl) as acl
      where namespace.nspname = ${schema}
        and attribute.attnum > 0
        and not attribute.attisdropped
        and attribute.attacl is not null
        and pg_catalog.pg_get_userbyid(acl.grantee) = any(${textArray(runtimeRoles)})
    `,
      'objects',
    );
    const schemaPrivileges = yield* executor.execute<SchemaPrivilegeRow>(
      sql`
      select
        role.rolname as role_name,
        has_schema_privilege(role.rolname, ${schema}, ${'CREATE'}) as can_create,
        has_schema_privilege(role.rolname, ${schema}, ${'USAGE'}) as can_use
      from pg_catalog.pg_roles as role
      where role.rolname = any(${textArray(runtimeRoles)})
    `,
      'objects',
    );

    return [
      ...schemaPrivilegeMismatches(schema, schemaPrivileges),
      ...tablePrivilegeMismatches(schema, tablePrivileges, columnPrivileges),
    ];
  },
);

interface RoutineRow extends Readonly<Record<string, boolean | string>> {
  readonly owner: string;
  readonly pinned_search_path: boolean;
  readonly public_execute: boolean;
  readonly routine: string;
  readonly security_definer: boolean;
}

interface RoutineExecuteRow extends Readonly<Record<string, boolean | string>> {
  readonly can_execute: boolean;
  readonly role_name: string;
  readonly routine: string;
}

const PINNED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

const expectedRoutineExecute = (role: string, routine: string): boolean =>
  PARTY_GRANTS_BY_ROLE.get(role)?.routines.includes(routine) ?? false;

/**
 * Every routine in `schema` is owned by `owner`, never executable by PUBLIC, executable by exactly the
 * runtime roles that declare it, and a SECURITY DEFINER routine pins its search_path. Returns one line
 * per mismatch.
 */
export const routineMismatches = Effect.fn('DatabaseRoleContract.routineMismatches')(function* routineMismatches(
  executor: PartyDatabaseExecutor,
  schema: string,
  owner: string,
) {
  const routines = yield* executor.execute<RoutineRow>(
    sql`
      select
        routine.oid::regprocedure::text as routine,
        pg_catalog.pg_get_userbyid(routine.proowner) as owner,
        routine.prosecdef as security_definer,
        coalesce(${PINNED_SEARCH_PATH} = any(routine.proconfig), false) as pinned_search_path,
        exists (
          select 1 from pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) as acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as public_execute
      from pg_catalog.pg_proc as routine
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = ${schema}
    `,
    'objects',
  );
  const execute = yield* executor.execute<RoutineExecuteRow>(
    sql`
      select
        routine.oid::regprocedure::text as routine,
        role_name,
        pg_catalog.has_function_privilege(role_name, routine.oid, ${'EXECUTE'}) as can_execute
      from pg_catalog.pg_proc as routine
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      cross join unnest(${textArray(runtimeRoles)}) as role_name
      where namespace.nspname = ${schema}
        and exists (select 1 from pg_catalog.pg_roles as role where role.rolname = role_name)
    `,
    'objects',
  );
  const canonical = yield* executor.execute<{ readonly declared: string; readonly routine: string | null }>(
    sql`
      select declared, pg_catalog.to_regprocedure(declared)::text as routine
      from unnest(${textArray([...PARTY_GRANTS_BY_ROLE.values()].flatMap((grants) => grants.routines))}) as declared
    `,
    'objects',
  );
  const declaredByRoutine = new Map(
    canonical.flatMap(({ declared, routine }) => (routine === null ? [] : [[routine, declared] as const])),
  );
  const mismatches: string[] = canonical.flatMap(({ declared, routine }) =>
    declared.startsWith(`${schema}.`) && routine === null ? [`Required routine ${declared} is missing`] : [],
  );
  for (const row of routines) {
    if (row.owner !== owner) {
      mismatches.push(`Routine ${row.routine} is owned by ${row.owner}, expected ${owner}`);
    }
    if (row.public_execute) {
      mismatches.push(`Routine ${row.routine} is executable by PUBLIC`);
    }
    if (row.security_definer && !row.pinned_search_path) {
      mismatches.push(`SECURITY DEFINER routine ${row.routine} does not pin ${PINNED_SEARCH_PATH}`);
    }
  }
  for (const row of execute) {
    const declared = declaredByRoutine.get(row.routine) ?? row.routine;
    const expected = expectedRoutineExecute(row.role_name, declared);
    if (row.can_execute !== expected) {
      mismatches.push(`${row.role_name} EXECUTE on ${row.routine} is ${row.can_execute}, expected ${expected}`);
    }
  }
  return mismatches;
});

const policyCommands = {
  all: '*',
  delete: 'd',
  insert: 'a',
  select: 'r',
  update: 'w',
} as const;

/** The sorted role names a Drizzle policy applies to; an omitted target means PUBLIC. */
const policyRoles = (to: PgPolicy['to']): readonly string[] => {
  if (to === undefined) {
    return ['public'];
  }
  if (Array.isArray(to)) {
    return to.flatMap(policyRoles).toSorted();
  }
  return [is(to, PgRole) ? to.name : to];
};

const containsUnscopedSetting = (expression: string): boolean => expression.includes('current_setting');

const missingTrustAccessor = (expression: string, accessor: string): boolean =>
  expression !== '' && !expression.includes(accessor);

const requestPolicyMismatches = (row: PolicyRow): readonly string[] => {
  const mismatches: string[] = [];
  if (containsUnscopedSetting(row.qual) || containsUnscopedSetting(row.with_check)) {
    mismatches.push(`Request policy ${row.policy_name} reads a session setting`);
  }
  for (const expression of [row.qual, row.with_check]) {
    if (expression === '') {
      continue;
    }
    if (
      LEGAL_ENTITY_TABLES.has(row.table_name) &&
      ((expression.match(/IS NULL/gu)?.length ?? 0) < 2 || (expression.match(/ OR /gu)?.length ?? 0) < 2)
    ) {
      mismatches.push(
        `Request policy ${row.policy_name} must allow global rows and tenant-wide scope while checking sealed legal entity`,
      );
    }
    if (
      row.table_name === 'counterparty_role_admin_read_models' &&
      (!expression.includes('counterparty_admin_read_models') ||
        !expression.includes('parent.counterparty_id') ||
        !expression.includes('parent.tenant_id'))
    ) {
      mismatches.push(`Request policy ${row.policy_name} must inherit its scoped counterparty projection`);
    }
  }
  const accessors = LEGAL_ENTITY_TABLES.has(row.table_name)
    ? ['trust.current_tenant_id()', 'trust.current_legal_entity_id()']
    : ['trust.current_tenant_id()'];
  for (const accessor of accessors) {
    if (missingTrustAccessor(row.qual, accessor) || missingTrustAccessor(row.with_check, accessor)) {
      mismatches.push(`Request policy ${row.policy_name} does not use ${accessor}`);
    }
  }
  return mismatches;
};

/** One live policy matches its Drizzle declaration and the Party identity contract. */
const policyRowMismatches = (policy: PgPolicy, row: PolicyRow): readonly string[] => {
  const mismatches: string[] = [];
  const roles = policyRoles(policy.to).join(',');
  if (row.role_names !== roles) {
    mismatches.push(`Policy ${policy.name} applies to {${row.role_names}}, expected {${roles}}`);
  }
  if (row.command !== policyCommands[policy.for ?? 'all']) {
    mismatches.push(`Policy ${policy.name} has command ${row.command}`);
  }
  if (roles === PARTY_REGISTRY_REQUEST_IDENTITY.role) {
    mismatches.push(...requestPolicyMismatches(row));
  } else if (
    roles !== PARTY_REGISTRY_WORKER_IDENTITY.role ||
    row.command !== 'r' ||
    !policy.name.endsWith('_worker_select')
  ) {
    mismatches.push(`Policy ${policy.name} is outside the Party identity contract`);
  }
  return mismatches;
};

/** The declared policy shape of one table: four request policies and one worker read policy on worker tables. */
const declaredPolicyMismatches = (
  qualifiedTable: string,
  expected: readonly PgPolicy[],
  workerTables: readonly string[],
): readonly string[] => {
  const mismatches: string[] = [];
  const requestPolicies = expected.filter((policy) =>
    policyRoles(policy.to).includes(PARTY_REGISTRY_REQUEST_IDENTITY.role),
  );
  if (requestPolicies.length !== 4) {
    mismatches.push(`${qualifiedTable} declares ${requestPolicies.length} request policies, expected 4`);
  }
  const workerPolicies = expected.filter((policy) => policy.name.endsWith('_worker_select'));
  if (workerPolicies.length !== (workerTables.includes(qualifiedTable) ? 1 : 0)) {
    mismatches.push(`${qualifiedTable} declares ${workerPolicies.length} worker read policies`);
  }
  return mismatches;
};

const tablePolicyMismatches = (
  schema: string,
  table: PgTable,
  actualByTable: ReadonlyMap<string, readonly PolicyRow[]>,
  rlsByTable: ReadonlyMap<string, RlsRow>,
  workerTables: readonly string[],
): readonly string[] => {
  const config = getTableConfig(table);
  const qualifiedTable = `${schema}.${config.name}`;
  const expected = config.policies;
  const actual = actualByTable.get(config.name) ?? [];
  if (expected.length === 0) {
    return actual.length > 0 ? [`${qualifiedTable} has unexpected policies`] : [];
  }
  const mismatches: string[] = [];
  const tableRls = rlsByTable.get(config.name);
  if (tableRls === undefined || !tableRls.row_security || !tableRls.force_rls) {
    mismatches.push(`${qualifiedTable} does not enable and force row-level security`);
  }
  mismatches.push(...declaredPolicyMismatches(qualifiedTable, expected, workerTables));
  if (actual.length !== expected.length) {
    mismatches.push(`${qualifiedTable} has ${actual.length} policies, expected ${expected.length}`);
  }
  for (const policy of expected) {
    const row = actual.find((candidate) => candidate.policy_name === policy.name);
    mismatches.push(...(row === undefined ? [`Policy ${policy.name} is missing`] : policyRowMismatches(policy, row)));
  }
  return mismatches;
};

/**
 * Compares the live policies and RLS flags of `tables` with their Drizzle definitions and the Party
 * identity contract: four request policies per RLS table on trust accessors only, and exactly one
 * worker read policy on each worker table. Returns one line per mismatch.
 */
export const policyMismatches = Effect.fn('DatabaseRoleContract.policyMismatches')(function* policyMismatches(
  executor: PartyDatabaseExecutor,
  schema: string,
  tables: readonly PgTable[],
  workerTables: readonly string[],
) {
  const policies = yield* executor.execute<PolicyRow>(
    sql`
      select
        relation.relname as table_name,
        policy.polname as policy_name,
        policy.polcmd::text as command,
        coalesce((
          select string_agg(role.rolname, ',' order by role.rolname)
          from pg_catalog.pg_roles as role
          where role.oid = any(policy.polroles)
        ), 'public') as role_names,
        coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '') as qual,
        coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '') as with_check
      from pg_catalog.pg_policy as policy
      inner join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${schema}
    `,
    'objects',
  );
  const rls = yield* executor.execute<RlsRow>(
    sql`
      select relation.relname as table_name, relation.relrowsecurity as row_security, relation.relforcerowsecurity as force_rls
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${schema} and relation.relkind in (${'r'}, ${'p'})
    `,
    'objects',
  );

  const actualByTable = new Map<string, PolicyRow[]>();
  for (const row of policies) {
    actualByTable.set(row.table_name, [...(actualByTable.get(row.table_name) ?? []), row]);
  }
  const rlsByTable = new Map(rls.map((row) => [row.table_name, row]));
  return tables.flatMap((table) => tablePolicyMismatches(schema, table, actualByTable, rlsByTable, workerTables));
});
