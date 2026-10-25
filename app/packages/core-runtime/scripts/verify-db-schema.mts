// @effect-diagnostics processEnv:off globalConsole:off strictEffectProvide:off -- Existing compatibility boundary; expires: 2026-12-31.
import { PgClient } from '@effect/sql-pg';
import { getTableName, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import type { CatalogEntry } from '../src/db/catalog.ts';
import { compareApplicationCatalog } from '../src/db/catalog.ts';
import { CoreDatabase, CoreDatabaseLive } from '../src/db/client.ts';
import { DatabaseConfigLive, loadDatabaseConnectionPair } from '../src/db/config.ts';
import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  TRUST_ROUTINES,
} from '../src/db/database-identities.ts';
import {
  CORE_SCHEMA_NAME,
  actionInvocations,
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  evidenceReferences,
  legalEntities,
  mediaAssets,
  mediaLinks,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  principalAuthBindings,
  principals,
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../src/db/schema.ts';

class DatabaseVerificationError extends Schema.TaggedError<DatabaseVerificationError>()('DatabaseVerificationError', {
  reason: Schema.String,
}) {}

const CatalogRowSchema = Schema.Struct({
  kind: Schema.Literals(['migration', 'table']),
  schema_name: Schema.String,
  table_name: Schema.Union([Schema.Null, Schema.String]),
});
type CatalogRow = typeof CatalogRowSchema.Type;

const RuntimeRoleRowSchema = Schema.Struct({
  rolbypassrls: Schema.Boolean,
  rolsuper: Schema.Boolean,
});
type RuntimeRoleRow = typeof RuntimeRoleRowSchema.Type;

const SHARED_ROLE = SHARED_RUNTIME_IDENTITY.role;
const REQUEST_ROLE = PARTY_REGISTRY_REQUEST_IDENTITY.role;
const WORKER_ROLE = PARTY_REGISTRY_WORKER_IDENTITY.role;
const COMPOSITION_AUTHORITY_ROLES = [SHARED_ROLE, REQUEST_ROLE, WORKER_ROLE];

interface ExpectedPolicy {
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly name: string;
  readonly roles: readonly string[];
  readonly trustedLegalEntity?: true;
  /** The policy must read the trusted tenant through trust.current_tenant_id(). */
  readonly trustedTenant?: true;
}

const sharedRuntimeAll = (table: string): ExpectedPolicy => ({
  command: 'ALL',
  name: `core_${table}_shared_runtime_all`,
  roles: [SHARED_ROLE],
});

const SEARCH_POLICY_COMMANDS = { delete: 'DELETE', insert: 'INSERT', select: 'SELECT', update: 'UPDATE' } as const;

const sharedSearchPolicies = (
  table: string,
  operations: readonly ('select' | 'insert' | 'update' | 'delete')[],
): readonly ExpectedPolicy[] =>
  operations.map((operation) => ({
    command: SEARCH_POLICY_COMMANDS[operation],
    name: `core_${table}_tenant_${operation}`,
    roles: [SHARED_ROLE],
  }));

const workerSearchPolicies = (table: string): readonly ExpectedPolicy[] => [
  { command: 'SELECT', name: `core_${table}_party_registry_worker_select`, roles: [WORKER_ROLE] },
  { command: 'INSERT', name: `core_${table}_party_registry_worker_insert`, roles: [WORKER_ROLE] },
  { command: 'UPDATE', name: `core_${table}_party_registry_worker_update`, roles: [WORKER_ROLE] },
];

/** Tables whose RLS is enabled but not forced so the admin-owned migrations keep owner access. */
const DEDICATED_IDENTITY_RLS_TABLES = [
  'tenants',
  'tenant_module_states',
  'legal_entities',
  'principals',
  'principal_auth_bindings',
  'action_invocations',
  'audit_events',
  'data_access_events',
  'domain_events',
  'outbox_messages',
] as const;

/** Exact policy sets per Core table that the dedicated database identities depend on. */
const EXPECTED_CORE_POLICIES: ReadonlyMap<string, readonly ExpectedPolicy[]> = new Map(
  Object.entries({
    action_invocations: [
      sharedRuntimeAll('action_invocations'),
      {
        command: 'SELECT',
        name: 'core_action_invocations_party_registry_request_select',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
      {
        command: 'INSERT',
        name: 'core_action_invocations_party_registry_request_insert',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
      {
        command: 'UPDATE',
        name: 'core_action_invocations_party_registry_request_update',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
      { command: 'SELECT', name: 'core_action_invocations_party_registry_worker_select', roles: [WORKER_ROLE] },
    ],
    audit_events: [
      sharedRuntimeAll('audit_events'),
      {
        command: 'SELECT',
        name: 'core_audit_events_party_registry_request_select',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
      {
        command: 'INSERT',
        name: 'core_audit_events_party_registry_request_insert',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
    ],
    data_access_events: [
      sharedRuntimeAll('data_access_events'),
      {
        command: 'INSERT',
        name: 'core_data_access_events_party_registry_request_insert',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
    ],
    domain_events: [
      sharedRuntimeAll('domain_events'),
      {
        command: 'INSERT',
        name: 'core_domain_events_party_registry_request_insert',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
      { command: 'SELECT', name: 'core_domain_events_party_registry_worker_select', roles: [WORKER_ROLE] },
      { command: 'UPDATE', name: 'core_domain_events_party_registry_worker_lock', roles: [WORKER_ROLE] },
    ],
    legal_entities: [
      sharedRuntimeAll('legal_entities'),
      {
        command: 'SELECT',
        name: 'core_legal_entities_party_registry_request_select',
        roles: [REQUEST_ROLE],
        trustedTenant: true,
      },
      { command: 'SELECT', name: 'core_legal_entities_party_registry_worker_select', roles: [WORKER_ROLE] },
    ],
    outbox_messages: [
      sharedRuntimeAll('outbox_messages'),
      {
        command: 'INSERT',
        name: 'core_outbox_messages_party_registry_request_insert',
        roles: [REQUEST_ROLE],
        trustedTenant: true,
      },
      { command: 'SELECT', name: 'core_outbox_messages_party_registry_worker_select', roles: [WORKER_ROLE] },
      { command: 'UPDATE', name: 'core_outbox_messages_party_registry_worker_update', roles: [WORKER_ROLE] },
    ],
    principal_auth_bindings: [
      sharedRuntimeAll('principal_auth_bindings'),
      {
        command: 'SELECT',
        name: 'core_principal_auth_bindings_party_registry_request_select',
        roles: [REQUEST_ROLE],
        trustedTenant: true,
      },
    ],
    principals: [
      sharedRuntimeAll('principals'),
      {
        command: 'SELECT',
        name: 'core_principals_party_registry_request_select',
        roles: [REQUEST_ROLE],
        trustedTenant: true,
      },
    ],
    search_index_entries: [
      ...sharedSearchPolicies('search_index_entries', ['select', 'insert', 'update', 'delete']),
      {
        command: 'SELECT',
        name: 'core_search_index_entries_party_registry_request_select',
        roles: [REQUEST_ROLE],
        trustedLegalEntity: true,
        trustedTenant: true,
      },
      ...workerSearchPolicies('search_index_entries'),
    ],
    search_projection_generations: [
      ...sharedSearchPolicies('search_projection_generations', ['select', 'insert', 'update']),
      ...workerSearchPolicies('search_projection_generations'),
    ],
    search_projection_rebuilds: [
      ...sharedSearchPolicies('search_projection_rebuilds', ['select', 'insert', 'update']),
      ...workerSearchPolicies('search_projection_rebuilds'),
    ],
    tenant_module_states: [
      sharedRuntimeAll('tenant_module_states'),
      {
        command: 'SELECT',
        name: 'core_tenant_module_states_party_registry_select',
        roles: [REQUEST_ROLE, WORKER_ROLE],
      },
      { command: 'UPDATE', name: 'core_tenant_module_states_party_registry_worker_lock', roles: [WORKER_ROLE] },
    ],
    tenants: [
      sharedRuntimeAll('tenants'),
      { command: 'SELECT', name: 'core_tenants_party_registry_select', roles: [REQUEST_ROLE, WORKER_ROLE] },
      {
        command: 'UPDATE',
        name: 'core_tenants_party_registry_request_lock',
        roles: [REQUEST_ROLE],
        trustedTenant: true,
      },
      { command: 'UPDATE', name: 'core_tenants_party_registry_worker_lock', roles: [WORKER_ROLE] },
    ],
  } satisfies Record<string, readonly ExpectedPolicy[]>),
);

const policyIdentity = ({
  command,
  name,
  roles,
}: {
  readonly command: string;
  readonly name: string;
  readonly roles: readonly string[];
}): string => `${name}:${command}:${roles.toSorted().join('+')}`;

const isUnsafeRuntimeRole = (role: RuntimeRoleRow | undefined): boolean =>
  role === undefined || role.rolsuper || role.rolbypassrls;

const verifyTypedQuery = <Result,>(
  tableName: string,
  query: () => Effect.Effect<Result, EffectDrizzleQueryError>,
): Effect.Effect<void, DatabaseVerificationError> =>
  query().pipe(
    Effect.mapError(
      () =>
        new DatabaseVerificationError({
          reason: `Typed verification failed for ${CORE_SCHEMA_NAME}.${tableName}`,
        }),
    ),
    Effect.asVoid,
  );

const verifyRuntimeRole = Effect.gen(function* verifyRuntimeRoleEffect() {
  const database = yield* CoreDatabase;
  const runtimeRole = yield* database.executor
    .execute<RuntimeRoleRow>(
      sql`
        select role.rolsuper, role.rolbypassrls
        from pg_catalog.pg_roles as role
        where role.rolname = current_user
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify the PostgreSQL runtime role',
          }),
      ),
    );
  const [role] = runtimeRole;
  if (isUnsafeRuntimeRole(role)) {
    return yield* new DatabaseVerificationError({
      reason: 'The application runtime role must be non-superuser and must not bypass RLS',
    });
  }
  return yield* Effect.void;
});

const verifySearchIsolation = Effect.gen(function* verifySearchIsolationEffect() {
  const database = yield* CoreDatabase;
  for (const tableName of ['search_index_entries', 'search_projection_generations', 'search_projection_rebuilds']) {
    const searchIsolation = yield* database.executor
      .execute<{
        policy_names: string[];
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
      }>(
        sql`
        select
          relation.relrowsecurity,
          relation.relforcerowsecurity,
          coalesce(array_agg(policy.policyname::text order by policy.policyname)
            filter (where policy.policyname is not null), array[]::text[]) as policy_names
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        left join pg_catalog.pg_policies as policy
          on policy.schemaname = namespace.nspname and policy.tablename = relation.relname
        where namespace.nspname = ${CORE_SCHEMA_NAME}
          and relation.relname = ${tableName}
        group by relation.relrowsecurity, relation.relforcerowsecurity
      `,
        'objects',
      )
      .pipe(
        Effect.mapError(
          () =>
            new DatabaseVerificationError({
              reason: 'Unable to verify Core Search tenant isolation',
            }),
        ),
      );
    const [searchIsolationRow] = searchIsolation;
    const expectedSearchPolicies = (EXPECTED_CORE_POLICIES.get(tableName) ?? []).map(({ name }) => name).toSorted();
    if (
      searchIsolationRow === undefined ||
      !searchIsolationRow.relrowsecurity ||
      !searchIsolationRow.relforcerowsecurity ||
      searchIsolationRow.policy_names.length !== expectedSearchPolicies.length ||
      searchIsolationRow.policy_names.some((policy, index) => policy !== expectedSearchPolicies[index])
    ) {
      return yield* new DatabaseVerificationError({
        reason: 'Core Search must enforce forced tenant RLS with complete owner-operation policies',
      });
    }
  }
  return yield* Effect.void;
});

const verifyApplicationCompositionAuthority = (
  table: typeof applicationCompositionAuthority | typeof applicationCompositionDurableWork,
  expectedRoles: readonly string[],
) =>
  Effect.gen(function* verifyApplicationCompositionAuthorityEffect() {
    const database = yield* CoreDatabase;
    const rows = yield* database.executor
      .execute<{
        can_assume_owner: boolean;
        policy_count: number;
        relrowsecurity: boolean;
        select_policy_count: number;
        select_privilege: boolean;
        write_privilege: boolean;
      }>(
        sql`
        select
          relation.relrowsecurity,
          (
            pg_has_role(current_user, relation.relowner, 'USAGE')
            or pg_has_role(current_user, relation.relowner, 'SET')
          ) as can_assume_owner,
          has_table_privilege(current_user, relation.oid, 'SELECT') as select_privilege,
          (
            has_table_privilege(current_user, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            or has_any_column_privilege(current_user, relation.oid, 'INSERT,UPDATE,REFERENCES')
          ) as write_privilege,
          count(policy.policyname)::integer as policy_count,
          count(policy.policyname) filter (
            where policy.policyname = ${`core_${getTableName(table)}_select`}
              and policy.cmd = 'SELECT'
              and policy.permissive = 'PERMISSIVE'
              and array(select role_name::text from unnest(policy.roles) as role_name order by 1) = array[${sql.join(
                expectedRoles.toSorted().map((role) => sql`${role}`),
                sql`, `,
              )}]::text[]
              and policy.qual = 'true'
              and policy.with_check is null
          )::integer as select_policy_count
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        left join pg_catalog.pg_policies as policy
          on policy.schemaname = namespace.nspname and policy.tablename = relation.relname
        where namespace.nspname = ${CORE_SCHEMA_NAME}
          and relation.relname = ${getTableName(table)}
        group by relation.oid, relation.relrowsecurity, relation.relowner
      `,
        'objects',
      )
      .pipe(
        Effect.mapError(
          () =>
            new DatabaseVerificationError({
              reason: 'Unable to verify Application Composition publication authority',
            }),
        ),
      );
    const [authority] = rows;
    if (
      authority === undefined ||
      authority.can_assume_owner ||
      !authority.relrowsecurity ||
      !authority.select_privilege ||
      authority.write_privilege ||
      authority.policy_count !== 1 ||
      authority.select_policy_count !== 1
    ) {
      return yield* new DatabaseVerificationError({
        reason: 'Application runtimes must only read the admin-owned Application Composition authority',
      });
    }
    return yield* Effect.void;
  });

const verifyDurableWorkRoutine = Effect.gen(function* verifyDurableWorkRoutineEffect() {
  const database = yield* CoreDatabase;
  const rows = yield* database.executor
    .execute<{
      can_assume_owner: boolean;
      can_execute: boolean;
      fixed_search_path: boolean;
      security_definer: boolean;
    }>(
      sql`
    select routine.prosecdef as security_definer,
      routine.proconfig = array['search_path=pg_catalog, core']::text[] as fixed_search_path,
      has_function_privilege(current_user, routine.oid, 'EXECUTE') as can_execute,
      (pg_has_role(current_user, routine.proowner, 'USAGE') or pg_has_role(current_user, routine.proowner, 'SET')) as can_assume_owner
    from pg_catalog.pg_proc as routine
    where routine.oid = to_regprocedure('core.track_application_composition_durable_work(text,text,text,boolean)')
  `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify Application Composition durable work tracking routine',
          }),
      ),
    );
  const [routine] = rows;
  if (
    routine === undefined ||
    routine.can_execute ||
    routine.can_assume_owner ||
    routine.security_definer ||
    !routine.fixed_search_path
  ) {
    return yield* new DatabaseVerificationError({
      reason:
        'Application Composition durable work tracking must only be callable by trusted administrator-owned triggers',
    });
  }
  return yield* Effect.void;
});

const hasEntityOrGlobalPredicate = (expression: string | null): boolean =>
  expression === null ||
  (expression.includes('trust.current_legal_entity_id()') &&
    (expression.match(/IS NULL/gu)?.length ?? 0) >= 2 &&
    (expression.match(/ OR /gu)?.length ?? 0) >= 2);

const verifyDedicatedIdentityPolicies = Effect.gen(function* verifyDedicatedIdentityPoliciesEffect() {
  const database = yield* CoreDatabase;
  const relations = yield* database.executor
    .execute<{ relforcerowsecurity: boolean; relname: string; relrowsecurity: boolean }>(
      sql`
        select relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
        from pg_catalog.pg_class as relation
        inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = ${CORE_SCHEMA_NAME}
          and relation.relname in (${sql.join(
            DEDICATED_IDENTITY_RLS_TABLES.map((table) => sql`${table}`),
            sql`, `,
          )})
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () => new DatabaseVerificationError({ reason: 'Unable to verify Core dedicated-identity row security' }),
      ),
    );
  const unprotected = DEDICATED_IDENTITY_RLS_TABLES.filter((table) => {
    const relation = relations.find(({ relname }) => relname === table);
    return relation === undefined || !relation.relrowsecurity || relation.relforcerowsecurity;
  });
  if (unprotected.length > 0) {
    return yield* new DatabaseVerificationError({
      reason: `Core tables must enable, and not force, row security: ${unprotected.join(', ')}`,
    });
  }
  const tables = [...EXPECTED_CORE_POLICIES.keys()];
  const policies = yield* database.executor
    .execute<{
      cmd: string;
      policyname: string;
      qual: string | null;
      roles: string[];
      tablename: string;
      with_check: string | null;
    }>(
      sql`
        select policy.tablename::text as tablename, policy.policyname::text as policyname, policy.cmd,
          array(select role_name::text from unnest(policy.roles) as role_name order by 1) as roles,
          policy.qual, policy.with_check
        from pg_catalog.pg_policies as policy
        where policy.schemaname = ${CORE_SCHEMA_NAME}
          and policy.tablename in (${sql.join(
            tables.map((table) => sql`${table}`),
            sql`, `,
          )})
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () => new DatabaseVerificationError({ reason: 'Unable to verify Core dedicated-identity policies' }),
      ),
    );
  for (const table of tables) {
    const expected = (EXPECTED_CORE_POLICIES.get(table) ?? []).map(policyIdentity).toSorted();
    const actual = policies
      .filter(({ tablename }) => tablename === table)
      .map(({ cmd, policyname, roles }) => policyIdentity({ command: cmd, name: policyname, roles }))
      .toSorted();
    if (actual.length !== expected.length || actual.some((policy, index) => policy !== expected[index])) {
      return yield* new DatabaseVerificationError({
        reason: `Core ${table} policies must be exactly [${expected.join(', ')}], found [${actual.join(', ')}]`,
      });
    }
  }
  const expectedPolicies = [...EXPECTED_CORE_POLICIES.values()].flat();
  for (const policy of policies) {
    const expected = expectedPolicies.find(({ name }) => name === policy.policyname);
    const predicate = `${policy.qual ?? ''} ${policy.with_check ?? ''}`;
    if (expected?.trustedLegalEntity === true && ![policy.qual, policy.with_check].every(hasEntityOrGlobalPredicate)) {
      return yield* new DatabaseVerificationError({
        reason: `Core policy ${policy.policyname} must allow global rows and tenant-wide scope while checking sealed legal entity`,
      });
    }
    if (
      policy.roles.includes(REQUEST_ROLE) &&
      (predicate.includes('current_setting') ||
        (expected?.trustedTenant === true && !predicate.includes('trust.current_tenant_id()')))
    ) {
      return yield* new DatabaseVerificationError({
        reason: `Core policy ${policy.policyname} must read tenant scope only through trust.current_tenant_id()`,
      });
    }
  }
  return yield* Effect.void;
});

const TRUST_TABLE_NAMES = ['scope_sealing_keys', 'gateway_audience_roles', 'gateway_scope_grants'] as const;
const TRUST_ROUTINE_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

const trustCatalogFailure = (reason: string): DatabaseVerificationError => new DatabaseVerificationError({ reason });

const verifyTrustAudience = (client: PgClient.PgClient) =>
  Effect.gen(function* verifyTrustAudienceEffect() {
    const audiences = yield* client
      .unsafe<{ audience: string; role_name: string }>(
        'select audience, role_name::text from trust.gateway_audience_roles order by audience',
      )
      .pipe(Effect.mapError(() => trustCatalogFailure('Unable to verify trust gateway audiences')));
    if (
      audiences.length !== 1 ||
      audiences[0]?.audience !== 'party-registry' ||
      audiences[0]?.role_name !== REQUEST_ROLE
    ) {
      return yield* trustCatalogFailure(
        'trust.gateway_audience_roles must contain exactly party-registry -> party_registry_runtime',
      );
    }
    return yield* Effect.void;
  });

/**
 * Verifies the trust schema as the migration administrator: only that session can see the sealing-key
 * count, and the routines must be owned by it.
 */
const verifyTrustCatalog = Effect.gen(function* verifyTrustCatalogEffect() {
  const connections = yield* loadDatabaseConnectionPair().pipe(
    Effect.mapError((failure) => trustCatalogFailure(failure.reason)),
  );
  const client = yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.mapError((cause) =>
      trustCatalogFailure(`Unable to connect as the PostgreSQL administrator: ${cause.message}`),
    ),
  );
  const query = <Row extends object>(text: string, values?: readonly string[]) =>
    client
      .unsafe<Row>(text, values)
      .pipe(Effect.mapError((cause) => trustCatalogFailure(`Unable to verify the trust catalog: ${cause.message}`)));
  const [schema] = yield* query<{ present: boolean }>(
    "select exists(select 1 from pg_catalog.pg_namespace where nspname = 'trust') as present",
  );
  if (schema?.present !== true) {
    return yield* trustCatalogFailure('PostgreSQL schema trust is missing');
  }
  for (const table of TRUST_TABLE_NAMES) {
    const [relation] = yield* query<{ foreign_grantees: number; present: boolean }>(
      `select pg_catalog.to_regclass($1) is not null as present,
         (select count(*)::int from pg_catalog.pg_class as relation
            cross join lateral pg_catalog.aclexplode(relation.relacl) as acl
           where relation.oid = pg_catalog.to_regclass($1) and acl.grantee <> relation.relowner) as foreign_grantees`,
      [`trust.${table}`],
    );
    if (relation?.present !== true || relation.foreign_grantees !== 0) {
      return yield* trustCatalogFailure(`trust.${table} must exist and grant nothing beyond its owner`);
    }
  }
  for (const routine of TRUST_ROUTINES) {
    const [row] = yield* query<{
      config: string[] | null;
      executors: string[];
      owned_by_admin: boolean;
      public_execute: boolean;
      security_definer: boolean;
    }>(
      `select routine.prosecdef as security_definer, routine.proconfig as config,
         routine.proowner = (select oid from pg_catalog.pg_roles where rolname = session_user) as owned_by_admin,
         exists (select 1 from pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) as acl
           where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
         array(select grantee.rolname::text
                 from pg_catalog.aclexplode(routine.proacl) as acl
                 join pg_catalog.pg_roles as grantee on grantee.oid = acl.grantee
                where acl.privilege_type = 'EXECUTE' and acl.grantee <> routine.proowner
                order by 1) as executors
        from pg_catalog.pg_proc as routine
       where routine.oid = pg_catalog.to_regprocedure($1)`,
      [routine.signature],
    );
    const expectedExecutors = routine.executableBy.toSorted();
    if (
      row === undefined ||
      row.security_definer !== routine.securityDefiner ||
      row.config?.length !== 1 ||
      row.config[0] !== TRUST_ROUTINE_SEARCH_PATH ||
      !row.owned_by_admin ||
      row.public_execute ||
      row.executors.length !== expectedExecutors.length ||
      row.executors.some((executor, index) => executor !== expectedExecutors[index])
    ) {
      return yield* trustCatalogFailure(
        `${routine.signature} must exist, be admin-owned, ${routine.securityDefiner ? '' : 'not '}be SECURITY DEFINER, pin ${TRUST_ROUTINE_SEARCH_PATH} and be executable only by [${expectedExecutors.join(', ')}]`,
      );
    }
  }
  yield* verifyTrustAudience(client);
  const [keys] = yield* query<{ key_count: number }>('select count(*)::int as key_count from trust.scope_sealing_keys');
  if (keys?.key_count !== 1) {
    return yield* trustCatalogFailure('trust.scope_sealing_keys must hold exactly one sealing key');
  }
  return yield* Effect.void;
}).pipe(Effect.scoped);

const verifyCatalog = Effect.gen(function* verifyCatalogEffect() {
  const database = yield* CoreDatabase;
  // Necessary migration-verification exception: Drizzle has no typed builder
  // for PostgreSQL catalog metadata. Values stay parameterized and the query is
  // covered by exact-set mismatch tests.
  const catalogResult = yield* database.executor
    .execute<CatalogRow>(
      sql`
        with application_tables as (
          select
            ${'table'}::text as kind,
            namespace.nspname as schema_name,
            relation.relname as table_name
          from pg_catalog.pg_namespace as namespace
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = namespace.oid
          where relation.relkind in (${'r'}, ${'p'})
            and namespace.nspname = ${CORE_SCHEMA_NAME}
        ),
        migration_bookkeeping as (
          select
            ${'migration'}::text as kind,
            namespace.nspname as schema_name,
            relation.relname as table_name
          from pg_catalog.pg_namespace as namespace
          inner join pg_catalog.pg_class as relation
            on relation.relnamespace = namespace.oid
          where relation.relkind = ${'r'}
            and namespace.nspname = ${'drizzle'}
            and relation.relname = ${'__drizzle_migrations_core'}
        )
        select kind, schema_name, table_name from application_tables
        union all
        select kind, schema_name, table_name from migration_bookkeeping
        order by kind, schema_name, table_name
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to compare the PostgreSQL application catalog',
          }),
      ),
    );

  const entries: CatalogEntry[] = [];
  const migrationBookkeepingTables: string[] = [];

  for (const row of catalogResult) {
    if (row.kind === 'migration') {
      if (row.table_name !== null) {
        migrationBookkeepingTables.push(row.table_name);
      }
      continue;
    }

    if (row.table_name === null) {
      return yield* new DatabaseVerificationError({
        reason: `Catalog table ${row.schema_name} is missing its table name`,
      });
    }

    entries.push({
      kind: 'table',
      schemaName: row.schema_name,
      tableName: row.table_name,
    });
  }

  const expectedMigrationBookkeepingTables = ['__drizzle_migrations_core'];
  migrationBookkeepingTables.sort();

  if (
    migrationBookkeepingTables.length !== expectedMigrationBookkeepingTables.length ||
    migrationBookkeepingTables.some((tableName, index) => tableName !== expectedMigrationBookkeepingTables[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: `Expected Drizzle migration bookkeeping tables [${expectedMigrationBookkeepingTables.join(', ')}], found [${migrationBookkeepingTables.join(', ')}]`,
    });
  }

  const difference = compareApplicationCatalog(entries);

  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    return yield* new DatabaseVerificationError({
      reason: `Core catalog mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }
  return yield* Effect.void;
});

const EXPECTED_COMPOSITE_CONSTRAINTS = [
  'core_action_invocations_tenant_auth_binding_fk',
  'core_action_invocations_tenant_impersonator_fk',
  'core_action_invocations_tenant_legal_entity_fk',
  'core_action_invocations_tenant_principal_fk',
  'core_audit_events_tenant_auth_binding_fk',
  'core_audit_events_tenant_impersonator_fk',
  'core_audit_events_tenant_invocation_fk',
  'core_audit_events_tenant_legal_entity_fk',
  'core_audit_events_tenant_principal_fk',
  'core_auth_bindings_tenant_principal_fk',
  'core_data_access_events_tenant_auth_binding_fk',
  'core_data_access_events_tenant_impersonator_fk',
  'core_data_access_events_tenant_invocation_fk',
  'core_data_access_events_tenant_legal_entity_fk',
  'core_data_access_events_tenant_principal_fk',
  'core_domain_events_tenant_invocation_fk',
  'core_domain_events_tenant_legal_entity_fk',
  'core_evidence_tenant_asset_fk',
  'core_evidence_tenant_audit_fk',
  'core_evidence_tenant_data_access_fk',
  'core_evidence_tenant_domain_event_fk',
  'core_evidence_tenant_invocation_fk',
  'core_evidence_tenant_legal_entity_fk',
  'core_media_assets_tenant_legal_entity_fk',
  'core_media_assets_tenant_principal_fk',
  'core_media_links_tenant_asset_fk',
  'core_media_links_tenant_invocation_fk',
  'core_media_links_tenant_principal_fk',
  'core_module_state_changes_tenant_invocation_fk',
  'core_module_state_changes_tenant_principal_fk',
  'core_outbox_messages_tenant_domain_event_fk',
  'core_search_index_entries_tenant_legal_entity_fk',
].toSorted();

const EXPECTED_AUTH_CONSTRAINTS = [
  'core_auth_bindings_tenant_principal_fk',
  'core_auth_bindings_provider_ck',
  'core_auth_bindings_namespace_ck',
  'core_auth_bindings_subject_type_ck',
  'core_auth_bindings_subject_id_ck',
  'core_auth_bindings_status_ck',
  'core_auth_bindings_revision_ck',
  'core_auth_bindings_lifecycle_ck',
].toSorted();

const EXPECTED_AUTH_COLUMNS = [
  { columnName: 'authentication_namespace_id', dataType: 'text', isNullable: 'NO' },
  { columnName: 'provider', dataType: 'text', isNullable: 'NO' },
  { columnName: 'binding_revision', dataType: 'integer', isNullable: 'NO' },
  { columnName: 'provider_subject_id', dataType: 'text', isNullable: 'NO' },
  { columnName: 'created_by_invocation_id', dataType: 'uuid', isNullable: 'YES' },
  { columnName: 'last_transition_ref', dataType: 'uuid', isNullable: 'YES' },
] as const;

const EXPECTED_AUTH_INDEXES = [
  {
    columns: ['tenant_id', 'principal_auth_binding_id'],
    name: 'core_auth_bindings_tenant_id_uk',
    predicate: null,
    unique: true,
  },
  {
    columns: ['tenant_id', 'authentication_namespace_id', 'subject_type', 'provider_subject_id'],
    name: 'core_auth_bindings_namespace_subject_uk',
    predicate: null,
    unique: true,
  },
  {
    columns: ['provider', 'subject_type', 'provider_subject_id'],
    name: 'core_auth_bindings_api_key_subject_global_uk',
    predicate: `subject_type = 'api_key'`,
    unique: true,
  },
  {
    columns: ['principal_id'],
    name: 'core_auth_bindings_principal_idx',
    predicate: null,
    unique: false,
  },
] as const;

const normalizeIndexPredicate = (predicate: string | null): string | null =>
  predicate === null
    ? null
    : predicate
        .replaceAll('"', '')
        .replaceAll('(', '')
        .replaceAll(')', '')
        .replaceAll('::text', '')
        .replaceAll(/\s+/gu, ' ')
        .trim()
        .toLowerCase();

const verifyCoreConstraints = Effect.gen(function* verifyCoreConstraintsEffect() {
  const database = yield* CoreDatabase;
  const constraintRows = yield* database.executor
    .execute<{ conname: string }>(
      sql`
        select constraint_record.conname
        from pg_catalog.pg_constraint as constraint_record
        inner join pg_catalog.pg_namespace as namespace
          on namespace.oid = constraint_record.connamespace
        where namespace.nspname = ${CORE_SCHEMA_NAME}
        order by constraint_record.conname
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify same-tenant constraints',
          }),
      ),
    );
  const presentCompositeConstraints = constraintRows
    .map((row) => row.conname)
    .filter((name) => EXPECTED_COMPOSITE_CONSTRAINTS.includes(name))
    .toSorted();
  if (
    presentCompositeConstraints.length !== EXPECTED_COMPOSITE_CONSTRAINTS.length ||
    presentCompositeConstraints.some((name, index) => name !== EXPECTED_COMPOSITE_CONSTRAINTS[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Required composite same-tenant constraints are missing',
    });
  }

  const actualAuthConstraints = constraintRows
    .map((row) => row.conname)
    .filter((name) => name.startsWith('core_auth_bindings_'))
    .toSorted();
  if (
    actualAuthConstraints.length !== EXPECTED_AUTH_CONSTRAINTS.length ||
    actualAuthConstraints.some((name, index) => name !== EXPECTED_AUTH_CONSTRAINTS[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Core authentication binding constraints are missing or unexpected',
    });
  }
  return yield* Effect.void;
});

const verifyAuthBindingColumns = Effect.gen(function* verifyAuthBindingColumnsEffect() {
  const database = yield* CoreDatabase;
  const authColumnRows = yield* database.executor
    .execute<{
      column_default: string | null;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      sql`
        select column_name, is_nullable, data_type, column_default
        from information_schema.columns
        where table_schema = ${CORE_SCHEMA_NAME}
          and table_name = ${getTableName(principalAuthBindings)}
        order by ordinal_position
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify Core authentication binding columns',
          }),
      ),
    );
  const authColumns = new Map(authColumnRows.map((row) => [row.column_name, row]));
  const requiredColumnsMatch = EXPECTED_AUTH_COLUMNS.every(({ columnName, dataType, isNullable }) => {
    const column = authColumns.get(columnName);
    return column !== undefined && column.data_type === dataType && column.is_nullable === isNullable;
  });
  const namespaceColumn = authColumns.get('authentication_namespace_id');
  const revisionColumn = authColumns.get('binding_revision');
  const normalizedRevisionDefault = revisionColumn?.column_default
    ?.replaceAll('::integer', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .trim();
  if (!requiredColumnsMatch || namespaceColumn?.column_default !== null || normalizedRevisionDefault !== '1') {
    return yield* new DatabaseVerificationError({
      reason:
        'Core authentication binding namespace, revision, or subject columns have incompatible nullability or types',
    });
  }
  return yield* Effect.void;
});

const verifyAuthBindingIndexes = Effect.gen(function* verifyAuthBindingIndexesEffect() {
  const database = yield* CoreDatabase;
  const authIndexRows = yield* database.executor
    .execute<{
      column_names: string[];
      index_name: string;
      is_unique: boolean;
      predicate: string | null;
    }>(
      sql`
        select
          index_relation.relname as index_name,
          index_record.indisunique as is_unique,
          max(pg_get_expr(index_record.indpred, index_record.indrelid)) as predicate,
          coalesce(
            array_agg(attribute.attname::text order by index_key.ordinality)
              filter (where attribute.attname is not null),
            array[]::text[]
          ) as column_names
        from pg_catalog.pg_class as table_relation
        inner join pg_catalog.pg_namespace as table_namespace
          on table_namespace.oid = table_relation.relnamespace
        inner join pg_catalog.pg_index as index_record
          on index_record.indrelid = table_relation.oid
        inner join pg_catalog.pg_class as index_relation
          on index_relation.oid = index_record.indexrelid
        cross join lateral unnest(index_record.indkey) with ordinality as index_key(attnum, ordinality)
        left join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = table_relation.oid and attribute.attnum = index_key.attnum
        where table_namespace.nspname = ${CORE_SCHEMA_NAME}
          and table_relation.relname = ${getTableName(principalAuthBindings)}
        group by index_relation.relname, index_record.indisunique, index_record.indrelid
        order by index_relation.relname
      `,
      'objects',
    )
    .pipe(
      Effect.mapError(
        () =>
          new DatabaseVerificationError({
            reason: 'Unable to verify Core authentication binding indexes',
          }),
      ),
    );
  const namedAuthIndexRows = authIndexRows.filter(({ index_name }) => index_name.startsWith('core_auth_bindings_'));
  const expectedAuthIndexNames = EXPECTED_AUTH_INDEXES.map(({ name }) => name).toSorted();
  const actualAuthIndexNames = namedAuthIndexRows.map(({ index_name }) => index_name).toSorted();
  if (
    actualAuthIndexNames.length !== expectedAuthIndexNames.length ||
    actualAuthIndexNames.some((name, index) => name !== expectedAuthIndexNames[index])
  ) {
    return yield* new DatabaseVerificationError({
      reason: 'Core authentication binding indexes are missing or unexpected',
    });
  }

  const authIndexes = new Map(namedAuthIndexRows.map((row) => [row.index_name, row]));
  const mismatchedAuthIndex = EXPECTED_AUTH_INDEXES.find((expectedIndex) => {
    const actualIndex = authIndexes.get(expectedIndex.name);
    return (
      actualIndex === undefined ||
      actualIndex.is_unique !== expectedIndex.unique ||
      actualIndex.column_names.length !== expectedIndex.columns.length ||
      actualIndex.column_names.some((name, index) => name !== expectedIndex.columns[index]) ||
      normalizeIndexPredicate(actualIndex.predicate) !== normalizeIndexPredicate(expectedIndex.predicate)
    );
  });
  if (mismatchedAuthIndex !== undefined) {
    return yield* new DatabaseVerificationError({
      reason: `Core authentication binding index ${mismatchedAuthIndex.name} is missing or incompatible`,
    });
  }
  return yield* Effect.void;
});

const verifyDatabase = Effect.gen(function* verifyDatabaseEffect() {
  const database = yield* CoreDatabase;
  yield* verifyRuntimeRole;
  yield* verifyApplicationCompositionAuthority(applicationCompositionAuthority, COMPOSITION_AUTHORITY_ROLES);
  yield* verifyApplicationCompositionAuthority(applicationCompositionDurableWork, [SHARED_ROLE]);
  yield* verifyDurableWorkRoutine;
  yield* verifySearchIsolation;
  yield* verifyDedicatedIdentityPolicies;
  yield* verifyTrustCatalog;
  yield* verifyCoreConstraints;
  yield* verifyAuthBindingColumns;
  yield* verifyAuthBindingIndexes;
  const typedQueries = [
    applicationCompositionAuthority,
    applicationCompositionDurableWork,
    tenants,
    legalEntities,
    principals,
    principalAuthBindings,
    tenantModuleStates,
    actionInvocations,
    tenantModuleStateChanges,
    auditEvents,
    dataAccessEvents,
    domainEvents,
    outboxMessages,
    outboxDeliveries,
    outboxAttempts,
    mediaAssets,
    mediaLinks,
    evidenceReferences,
    searchIndexEntries,
    searchProjectionGenerations,
    searchProjectionRebuilds,
    workerCheckpoints,
  ].map((table) => verifyTypedQuery(getTableName(table), () => database.executor.select().from(table).limit(0)));

  for (const query of typedQueries) {
    yield* query;
  }

  yield* verifyCatalog;

  return {
    tableCount: typedQueries.length,
  };
});

const DatabaseRuntimeLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
const result = await Effect.runPromise(
  verifyDatabase.pipe(Effect.provide(Layer.merge(Reactivity.layer, DatabaseRuntimeLive))),
);

console.log(`Verified ${result.tableCount} typed tables in PostgreSQL schema ${CORE_SCHEMA_NAME}`);
