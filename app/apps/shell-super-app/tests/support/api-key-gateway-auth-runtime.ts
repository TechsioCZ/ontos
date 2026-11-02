import { parseDatabaseConnectionPair } from '@app/core-runtime';
import type { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import { Config, Context, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { AUTH_TABLE_INVENTORY } from '../../api/auth/db/schema.ts';

export type ShellNativeOwnedDatabase = Pick<
  Effect.Success<ReturnType<typeof makeIsolatedNativeDatabaseFixture>>,
  'composition' | 'connections'
>;

class AuthRuntimeFixtureError extends Schema.TaggedError<AuthRuntimeFixtureError>()('AuthRuntimeFixtureError', {
  reason: Schema.String,
}) {}
const unavailable = () => new AuthRuntimeFixtureError({ reason: 'The owned Auth runtime contract is unavailable' });
const identitySchema = Schema.Struct({
  address: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/u)),
  bypass_rls: Schema.Boolean,
  database: Schema.String,
  database_oid: Schema.Int,
  owner: Schema.String,
  port: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65_535)),
  role: Schema.String,
  session_role: Schema.String,
  superuser: Schema.Boolean,
});
const objectSchema = Schema.Struct({ kind: Schema.String, name: Schema.String, owner: Schema.String });
const safeSchema = Schema.Struct({ safe: Schema.Boolean });
const loopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
interface RouteFact {
  readonly database: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}
interface RoutePairFact {
  readonly admin: RouteFact;
  readonly runtime: RouteFact;
}
interface AuthorityFact {
  readonly phase: string;
  readonly revision: string;
}
const fixedPlan = Object.freeze({
  schema: 'auth' as const,
  schemaPrivileges: Object.freeze(['USAGE'] as const),
  tablePrivileges: Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const),
  tables: Object.freeze([...AUTH_TABLE_INVENTORY]),
});
/** Pure closed decisions only; actual authority observations, clients and SQL stay private below. */
export const ownedAuthRuntimePolicy = Object.freeze({
  authorityIsCurrent: (closed: boolean, observed: AuthorityFact, revision: string) =>
    !closed && observed.phase === 'active' && observed.revision === revision,
  effectivePrivilegesAreSafe: (safe: boolean) => safe,
  fixedGrantPlan: (objects: readonly (typeof objectSchema.Type)[], schemaOwned: boolean, owner: string) =>
    schemaOwned &&
    objects.length === fixedPlan.tables.length &&
    objects.every((object) => object.kind === 'r' && object.owner === owner) &&
    fixedPlan.tables.every((table) => objects.some((object) => object.name === table))
      ? fixedPlan
      : undefined,
  identityPairIsOwned: (
    routes: RoutePairFact,
    admin: Partial<typeof identitySchema.Type>,
    runtime: Partial<typeof identitySchema.Type>,
  ) =>
    Schema.is(identitySchema)(admin) &&
    Schema.is(identitySchema)(runtime) &&
    admin.database === routes.admin.database &&
    runtime.database === routes.runtime.database &&
    Number.isSafeInteger(admin.database_oid) &&
    admin.database_oid === runtime.database_oid &&
    admin.owner === routes.admin.user &&
    runtime.owner === routes.admin.user &&
    admin.role === routes.admin.user &&
    admin.session_role === routes.admin.user &&
    runtime.role === routes.runtime.user &&
    runtime.session_role === routes.runtime.user &&
    !runtime.superuser &&
    !runtime.bypass_rls &&
    admin.address === runtime.address &&
    admin.port === runtime.port,
  routePairIsOwned: (owned: RoutePairFact, source: RoutePairFact, deployment?: string) =>
    deployment !== 'stage' &&
    deployment !== 'production' &&
    loopback(owned.admin.host) &&
    loopback(owned.runtime.host) &&
    owned.admin.host === source.admin.host &&
    owned.admin.port === source.admin.port &&
    owned.runtime.host === source.runtime.host &&
    owned.runtime.port === source.runtime.port &&
    owned.admin.port === owned.runtime.port &&
    owned.admin.database === owned.runtime.database &&
    owned.admin.user !== owned.runtime.user &&
    owned.runtime.user !== 'postgres' &&
    /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(owned.admin.database) &&
    ![source.admin.database, source.runtime.database].includes(owned.admin.database),
});

const readIdentity = (client: PgClient.PgClient) =>
  client
    .unsafe(`select current_database() as database, current_user as role, session_user as session_role,
    d.oid::integer as database_oid, pg_get_userbyid(d.datdba) as owner,
    inet_server_addr()::text as address, inet_server_port() as port,
    r.rolsuper as superuser, r.rolbypassrls as bypass_rls
    from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.rolname=current_user
    where d.datname=current_database()`)
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([identitySchema]))),
      Effect.map(([identity]) => identity),
      Effect.mapError(unavailable),
    );

/** Private finite Auth setup: no executor, connection selector or arbitrary query escapes. */
const makeOwnedAuthRuntimeContract = Effect.fn('ShellNativeAuthRuntime.make')(function* makeOwnedAuthRuntimeContract(
  owned: ShellNativeOwnedDatabase,
  revision: string,
) {
  // Copy values now; later caller mutation cannot retarget either client or migration.
  const connections = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: owned.connections.admin.connectionString,
    DATABASE_URL: owned.connections.runtime.connectionString,
  }).pipe(Effect.mapError(unavailable));
  const { observe } = owned.composition;
  const sourceEnvironment = yield* Config.all({
    DATABASE_ADMIN_URL: Config.String('DATABASE_ADMIN_URL'),
    DATABASE_URL: Config.String('DATABASE_URL'),
  }).pipe(Effect.mapError(unavailable));
  const source = yield* parseDatabaseConnectionPair(sourceEnvironment).pipe(Effect.mapError(unavailable));
  const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
  if (!ownedAuthRuntimePolicy.routePairIsOwned(connections, source, Option.getOrUndefined(deployment))) {
    return yield* unavailable();
  }
  const closed = yield* Ref.make(false);
  yield* Effect.addFinalizer(() => Ref.set(closed, true));
  const assertAuthority = Effect.fn('ShellNativeAuthRuntime.assertAuthority')(function* assertAuthority() {
    if (yield* Ref.get(closed)) {
      return yield* unavailable();
    }
    const current = yield* observe().pipe(Effect.mapError(unavailable));
    if (!ownedAuthRuntimePolicy.authorityIsCurrent(false, current, revision)) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  });
  yield* assertAuthority();
  const reactivity = yield* Reactivity.make;
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(unavailable),
  );
  const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(unavailable),
  );
  const assertIdentity = Effect.fn('ShellNativeAuthRuntime.assertIdentity')(function* assertIdentity() {
    yield* assertAuthority();
    const administrative = yield* readIdentity(admin);
    const restricted = yield* readIdentity(runtime);
    if (!ownedAuthRuntimePolicy.identityPairIsOwned(connections, administrative, restricted)) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  });
  // This first real target check completes before the caller may launch migrateAuth.
  yield* assertIdentity();
  return Object.freeze({
    adminConnectionString: Redacted.make(connections.admin.connectionString),
    assertCurrent: assertIdentity,
    establish: Effect.fn('ShellNativeAuthRuntime.establish')(function* establish() {
      yield* assertIdentity();
      const objects = yield* admin
        .unsafe(`select c.relname as name, c.relkind::text as kind,
          pg_get_userbyid(c.relowner) as owner from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid=c.relnamespace
          where n.nspname='auth' and c.relkind in ('r','p','S','v','m','f') order by c.relname`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(objectSchema))), Effect.mapError(unavailable));
      const schemaOwner = yield* admin
        .unsafe(
          `select pg_get_userbyid(nspowner) = $1 as safe
          from pg_catalog.pg_namespace where nspname='auth'`,
          [connections.admin.user],
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([safeSchema]))), Effect.mapError(unavailable));
      const plan = ownedAuthRuntimePolicy.fixedGrantPlan(objects, schemaOwner[0].safe, connections.admin.user);
      if (plan === undefined) {
        return yield* unavailable();
      }
      yield* admin
        .withTransaction(
          Effect.gen(function* grantFixedAuthObjects() {
            yield* admin`grant usage on schema auth to ${admin(connections.runtime.user)}`;
            yield* Effect.forEach(
              plan.tables,
              (table) => {
                const relation = admin(`${plan.schema}.${table}`);
                return admin`grant select, insert, update, delete on table ${relation} to ${admin(connections.runtime.user)}`;
              },
              { concurrency: 1, discard: true },
            );
          }),
        )
        .pipe(Effect.mapError(unavailable));
      // Effective checks catch inherited/public privileges as well as the finite direct grants.
      const privileges = yield* runtime
        .unsafe(
          `select has_schema_privilege(current_user, 'auth', 'USAGE')
          and not has_schema_privilege(current_user, 'auth', 'CREATE')
          and not exists (select 1 from unnest($1::text[]) as t(name)
            where not (has_table_privilege(current_user, format('auth.%I', t.name), 'SELECT')
              and has_table_privilege(current_user, format('auth.%I', t.name), 'INSERT')
              and has_table_privilege(current_user, format('auth.%I', t.name), 'UPDATE')
              and has_table_privilege(current_user, format('auth.%I', t.name), 'DELETE'))
            or has_table_privilege(current_user, format('auth.%I', t.name), 'TRUNCATE')
            or has_table_privilege(current_user, format('auth.%I', t.name), 'REFERENCES')
            or has_table_privilege(current_user, format('auth.%I', t.name), 'TRIGGER')) as safe`,
          [plan.tables],
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([safeSchema]))), Effect.mapError(unavailable));
      if (!ownedAuthRuntimePolicy.effectivePrivilegesAreSafe(privileges[0].safe)) {
        return yield* unavailable();
      }
      yield* assertIdentity();
      return yield* Effect.void;
    }),
    runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
  });
});

export const OwnedAuthRuntimeContract = Context.Service<
  Effect.Success<ReturnType<typeof makeOwnedAuthRuntimeContract>>
>('ShellNativeAuthRuntime/Contract');

export const OwnedAuthRuntimeContractLive = (owned: ShellNativeOwnedDatabase, revision: string) =>
  Layer.effect(OwnedAuthRuntimeContract, makeOwnedAuthRuntimeContract(owned, revision));
