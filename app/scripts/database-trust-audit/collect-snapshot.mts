import type { Client, ClientBase } from 'pg';
import {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  getEffectiveDatabaseEndpoint,
  type DatabaseTrustBoundarySnapshot,
} from './report.mts';

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
  readonly inherit: boolean;
  readonly owned_relations: string[];
  readonly owned_routines: string[];
  readonly owned_schemas: string[];
  readonly owned_types: string[];
  readonly parameter_privileges: string[];
  readonly predefined_role: boolean;
  readonly relation_privilege_schemas: string[];
  readonly replication: boolean;
  readonly role: string;
  readonly security_definer_routines: string[];
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
  readonly temporary: boolean;
}

interface SchemaPrivilegeRow {
  readonly create: boolean;
  readonly owner: string;
  readonly schema: string;
  readonly usage: boolean;
}

interface RoutinePrivilegeRow {
  readonly executable: boolean;
  readonly identity_arguments: string;
  readonly kind: 'aggregate' | 'function' | 'procedure' | 'window';
  readonly owner: string;
  readonly routine: string;
  readonly schema: string;
  readonly security_definer: boolean;
}

interface TablePrivilegeRow {
  readonly deletable: boolean;
  readonly delete: boolean;
  readonly insertable: boolean;
  readonly insert: boolean;
  readonly kind: 'foreign-table' | 'materialized-view' | 'partitioned-table' | 'table' | 'view';
  readonly owner: string;
  readonly owner_bypass_rls: boolean;
  readonly owner_context_privileged: boolean;
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
  readonly updatable: boolean;
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

export const collectSnapshot = async (
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
    `with recursive reachable_roles(role_oid) as (
       select candidate.oid
       from pg_catalog.pg_roles as candidate
       where candidate.rolname = $1
          or pg_has_role($1, candidate.oid, 'SET')
       union
       select membership.roleid
       from pg_catalog.pg_auth_members as membership
       join reachable_roles as reachable on reachable.role_oid = membership.member
       where membership.admin_option or membership.set_option
     ),
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
       ) as security_definer_routines
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
       has_database_privilege($1, current_database(), 'TEMPORARY') as temporary`,
    [runtimeRole],
  );
  const databaseRow = database.rows[0];
  if (databaseRow === undefined) throw new Error('database privilege row is absent');

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
    `select
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
       ) as executable
     from pg_catalog.pg_proc as routine
     join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
     join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
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
               select option_value::boolean
               from pg_catalog.pg_options_to_table(view_relation.reloptions)
               where option_name = 'security_invoker'
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
               select option_value::boolean
               from pg_catalog.pg_options_to_table(nested_view.reloptions)
               where option_name = 'security_invoker'
             ),
             false
           )
             then runtime_role.oid
           else nested_view.relowner
         end
       from view_dependencies as dependency
       join pg_catalog.pg_class as nested_view on nested_view.oid = dependency.referenced_oid
       join pg_catalog.pg_roles as runtime_role on runtime_role.rolname = $1
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
         join pg_catalog.pg_roles as effective_owner
           on effective_owner.oid = dependency.effective_owner_oid
         where dependency.view_oid = relation.oid
           and (
             pg_has_role(effective_owner.oid, $3, 'USAGE')
             or effective_owner.rolbypassrls
             or effective_owner.rolsuper
           )
       ) as owner_context_privileged,
       exists (
         select 1
         from view_dependencies as dependency
         join pg_catalog.pg_class as referenced_relation
           on referenced_relation.oid = dependency.referenced_oid
         where dependency.view_oid = relation.oid
           and referenced_relation.relkind in ('r', 'p')
           and pg_has_role(
             dependency.effective_owner_oid,
             referenced_relation.relowner,
             'USAGE'
           )
           and referenced_relation.relrowsecurity
           and not referenced_relation.relforcerowsecurity
       ) as owner_context_rls_bypass,
       owner.rolsuper as owner_superuser,
       relation.relrowsecurity as rls_enabled,
       relation.relforcerowsecurity as rls_forced,
       coalesce(
         (
           select option_value::boolean
           from pg_catalog.pg_options_to_table(relation.reloptions)
           where option_name = 'security_invoker'
         ),
         false
       ) as security_invoker,
       (pg_catalog.pg_relation_is_updatable(relation.oid, true) & 8) <> 0 as insertable,
       (pg_catalog.pg_relation_is_updatable(relation.oid, true) & 4) <> 0 as updatable,
       (pg_catalog.pg_relation_is_updatable(relation.oid, true) & 16) <> 0 as deletable,
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
    [runtimeRole, schemaNames, administrativeRole],
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
    `with recursive reachable_roles(role_oid) as (
       select candidate.oid
       from pg_catalog.pg_roles as candidate
       where candidate.rolname = $1
          or pg_has_role($1, candidate.oid, 'SET')
       union
       select membership.roleid
       from pg_catalog.pg_auth_members as membership
       join reachable_roles as reachable on reachable.role_oid = membership.member
       where membership.admin_option or membership.set_option
     ),
     target_roles(role_oid, role_name) as (
       select candidate.oid, candidate.rolname
       from pg_catalog.pg_roles as candidate
       join reachable_roles as reachable on reachable.role_oid = candidate.oid
     )
     select format('role:%I:%s', target.role_name, authority.grant_option) as grant_option
     from target_roles as target
     cross join lateral (
       select format('database:%I:%s', current_database(), privilege.name) as grant_option
       from (
         values ('CONNECT'::text), ('CREATE'::text), ('TEMPORARY'::text)
       ) as privilege(name)
       where has_database_privilege(
         target.role_oid,
         current_database(),
         privilege.name || ' WITH GRANT OPTION'
       )
       union all
       select format('schema:%I:%s', namespace.nspname, privilege.name)
       from pg_catalog.pg_namespace as namespace
       cross join (values ('CREATE'::text), ('USAGE'::text)) as privilege(name)
       where namespace.nspname = any($2::text[])
         and has_schema_privilege(
           target.role_oid,
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
           target.role_oid,
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
           target.role_oid,
           relation.oid,
           attribute.attnum,
           privilege.name || ' WITH GRANT OPTION'
         )
         and not has_table_privilege(
           target.role_oid,
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
           target.role_oid,
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
           target.role_oid,
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
         and has_type_privilege(target.role_oid, audited_type.oid, 'USAGE WITH GRANT OPTION')
       union all
       select format('parameter:%s:%s', parameter.parname, privilege.name)
       from pg_catalog.pg_parameter_acl as parameter
       cross join (values ('ALTER SYSTEM'::text), ('SET'::text)) as privilege(name)
       where has_parameter_privilege(
         target.role_oid,
         parameter.parname,
         privilege.name || ' WITH GRANT OPTION'
       )
       union all
       select format('language:%I:USAGE', language.lanname)
       from pg_catalog.pg_language as language
       where has_language_privilege(
         target.role_oid,
         language.oid,
         'USAGE WITH GRANT OPTION'
       )
       union all
       select format('foreign-data-wrapper:%I:USAGE', wrapper.fdwname)
       from pg_catalog.pg_foreign_data_wrapper as wrapper
       where has_foreign_data_wrapper_privilege(
         target.role_oid,
         wrapper.oid,
         'USAGE WITH GRANT OPTION'
       )
       union all
       select format('foreign-server:%I:USAGE', server.srvname)
       from pg_catalog.pg_foreign_server as server
       where has_server_privilege(target.role_oid, server.oid, 'USAGE WITH GRANT OPTION')
       union all
       select format('tablespace:%I:CREATE', tablespace.spcname)
       from pg_catalog.pg_tablespace as tablespace
       where has_tablespace_privilege(
         target.role_oid,
         tablespace.oid,
         'CREATE WITH GRANT OPTION'
       )
     ) as authority
     order by target.role_name, authority.grant_option`,
    [runtimeRole, schemaNames],
  );
  const defaultPrivileges = await admin.query<DefaultPrivilegeRow>(
    `with recursive reachable_roles(role_oid) as (
       select candidate.oid
       from pg_catalog.pg_roles as candidate
       where candidate.rolname = $1
          or pg_has_role($1, candidate.oid, 'SET')
       union
       select membership.roleid
       from pg_catalog.pg_auth_members as membership
       join reachable_roles as reachable on reachable.role_oid = membership.member
       where membership.admin_option or membership.set_option
     ),
     audit_owners as (
       select candidate.oid, candidate.rolname
       from pg_catalog.pg_roles as candidate
       where candidate.rolname = $3
          or (
            candidate.oid in (select role_oid from reachable_roles)
            and has_database_privilege(candidate.oid, current_database(), 'CREATE')
          )
          or exists (
            select 1
            from pg_catalog.pg_namespace as namespace
            where namespace.nspname = any($2::text[])
              and (
                namespace.nspowner = candidate.oid
                or has_schema_privilege(candidate.oid, namespace.oid, 'CREATE')
              )
          )
          or exists (
            select 1
            from pg_catalog.pg_default_acl as defaults
            left join pg_catalog.pg_namespace as namespace
              on namespace.oid = defaults.defaclnamespace
            where defaults.defaclrole = candidate.oid
              and (
                defaults.defaclnamespace = 0
                or namespace.nspname = any($2::text[])
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
       join pg_catalog.pg_roles as owner on owner.oid = defaults.defaclrole
       where namespace.nspname = any($2::text[])
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
    [runtimeRole, schemaNames, administrativeRole],
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
    grantOptions: grantOptions.rows.map(({ grant_option }) => grant_option),
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
      ownedRelations: membership.owned_relations,
      ownedRoutines: membership.owned_routines,
      ownedSchemas: membership.owned_schemas,
      ownedTypes: membership.owned_types,
      parameterPrivileges: membership.parameter_privileges,
      predefinedRole: membership.predefined_role,
      relationPrivilegeSchemas: membership.relation_privilege_schemas,
      role: membership.role,
      securityDefinerRoutines: membership.security_definer_routines,
    })),
    parameterPrivileges: parameterPrivileges.rows.map((privilege) => ({
      alterSystem: privilege.alter_system,
      parameter: privilege.parameter,
      set: privilege.set,
    })),
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
      executable: routine.executable,
      identityArguments: routine.identity_arguments,
      kind: routine.kind,
      owner: routine.owner,
      routine: routine.routine,
      schema: routine.schema,
      securityDefiner: routine.security_definer,
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
      deletable: table.deletable,
      insertable: table.insertable,
      kind: table.kind,
      owner: table.owner,
      ownerBypassRls: table.owner_bypass_rls,
      ownerContextPrivileged: table.owner_context_privileged,
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
      updatable: table.updatable,
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
