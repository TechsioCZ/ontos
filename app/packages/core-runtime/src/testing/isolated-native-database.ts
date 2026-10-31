import { asc, eq, sql } from 'drizzle-orm';
import { Config, Crypto, DateTime, Effect, Exit, Option, Redacted, Ref, Schema, Scope, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import type { PlatformError } from 'effect';

import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { makeCoreDatabase } from '../db/client.ts';
import { defineDatabaseIdentityEnrollment } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../db/config.ts';
import type { DatabaseConnectionPair, DatabaseConfigValue } from '../db/config.ts';
import { validateActiveApplicationCompositionSnapshot } from '../modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../modules/active-application-composition.ts';
import { applicationCompositionAuthority, applicationCompositionDurableWork } from '../db/schema.ts';
import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
  sealApplicationCompositionAuthority,
} from '../modules/application-composition-authority.ts';

export class IsolatedNativeDatabaseError extends Schema.TaggedError<IsolatedNativeDatabaseError>()(
  'IsolatedNativeDatabaseError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

const unavailable = (reason = 'The isolated native test database is unavailable', cause?: unknown) =>
  new IsolatedNativeDatabaseError({ cause: Redacted.make(cause), reason });
const prefix = 'ontos_test_party_gateway_';

const replaceDatabase = (configuration: DatabaseConfigValue, database: string) => {
  const url = new URL(configuration.connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

const postgresTool = Effect.fn('IsolatedNativeDatabase.postgresTool')(function* postgresToolCommand(
  configuration: DatabaseConfigValue,
  program: 'pg_dump' | 'psql',
  args: readonly string[],
  input?: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
) {
  const url = new URL(configuration.connectionString);
  const path = yield* Config.String('PATH').pipe(
    Effect.mapError((cause) => unavailable('Unable to resolve PostgreSQL tool PATH', cause)),
  );
  return yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      program,
      '--host',
      'localhost',
      '--username',
      configuration.user,
      '--dbname',
      configuration.database,
      ...args,
    ],
    {
      env: { PATH: path, PGPASSWORD: decodeURIComponent(url.password) },
      stderr: 'pipe',
      stdin: input ?? 'pipe',
      stdout: 'pipe',
    },
  );
});

const fingerprintSql = sql`
select json_build_object(
  'relations', (select json_agg(row_to_json(r) order by r.schema, r.name) from (
    select n.nspname as schema, c.relname as name, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      array(select a::text from unnest(coalesce(c.relacl,acldefault((case when c.relkind='S' then 's' else 'r' end)::"char",c.relowner))) a order by a::text)::text as acl,pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
      and c.relkind in ('r','p','v','m','S')
  ) r),
  'policies', (select json_agg(row_to_json(p) order by p.schemaname,p.tablename,p.policyname)
    from pg_policies p where p.schemaname not in ('pg_catalog','information_schema')),
  'constraints', (select json_agg(row_to_json(k) order by k.schema,k.table_name,k.name) from (
    select n.nspname as schema,c.relname as table_name,k.conname as name,pg_get_constraintdef(k.oid,true) as definition
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
  ) k),
  'functions', (select json_agg(row_to_json(f) order by f.schema,f.name,f.arguments) from (
    select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_functiondef(p.oid) as definition,array(select a::text from unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a order by a::text)::text as acl,pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
  ) f)
)::text as fingerprint`;

// PostgreSQL deparse is visibility-sensitive. Both catalogs are rendered by PostgreSQL itself
// in the same transaction-local context; pretty CHECK rendering is stable across pg_dump reparse.
const readFingerprint = Effect.fn('IsolatedNativeDatabase.readFingerprint')(function* readFingerprint(
  executor: CoreDatabaseExecutor,
) {
  return yield* executor
    .transaction(
      Effect.fn('IsolatedNativeDatabase.catalogSnapshot')(function* catalogSnapshot(transaction) {
        yield* transaction.execute(sql`select set_config('search_path','pg_catalog',true)`, 'objects');
        const [row] = yield* transaction.execute<{ readonly fingerprint: string }>(fingerprintSql, 'objects');
        if (row === undefined) {
          return yield* unavailable('Schema catalog fingerprint is unavailable');
        }
        return row.fingerprint;
      }),
    )
    .pipe(Effect.mapError((cause) => unavailable('Unable to read the schema catalog fingerprint', cause)));
});

const schemaOnly = 'schema-only' as const;
const exactDeadlinePurpose = 'stabilization-1271-exact-obligation-deadline';
type IsolatedNativeDatabaseInput = (
  | {
      readonly compositionSnapshot: ActiveApplicationCompositionSnapshot;
      readonly mode: typeof schemaOnly;
      readonly purpose:
        | 'stabilization-1196-product-create'
        | 'stabilization-1229-payment-entitlement'
        | 'stabilization-1232-current-access'
        | 'stabilization-1238-invitation-claim'
        | 'stabilization-1282-verification-settlement'
        | 'stabilization-1231-redemption-restart'
        | 'stabilization-1263-optional-configuration'
        | 'stabilization-1266-quantity-profile-admission'
        | 'stabilization-1230-preference-period'
        | 'stabilization-1267-party-gateway'
        | 'stabilization-1268-address-plan'
        | 'stabilization-1261-retained-purpose-withdrawal'
        | 'stabilization-1247-set-component-current-closure'
        | 'stabilization-1253-product-axis-allowance'
        | 'stabilization-1249-promotion-eligible-subset'
        | 'stabilization-1262-catalog-public-reads'
        | 'stabilization-1278-bulk-intent'
        | 'stabilization-1256-approval-currentness'
        | 'stabilization-1257-approval-fresh-proof'
        | 'stabilization-1239-reviewed-match-reuse'
        | 'stabilization-1281-original-input'
        | 'stabilization-1240-identifier-correction-reuse'
        | 'stabilization-1246-approval-post-lock-expiry'
        | 'stabilization-1275-notice-instants'
        | 'stabilization-1274-media-ordering'
        | 'stabilization-1241-guest-evidence'
        | 'stabilization-1265-dsr-multi-owner'
        | 'stabilization-1251-postal-future-end'
        | 'stabilization-1254-retained-controlled-values'
        | 'stabilization-1269-override-target-existence'
        | typeof exactDeadlinePurpose
        | 'stabilization-1270-set-effective-revision'
        | 'stabilization-1252-retired-sibling'
        | 'stabilization-1273-group-archive-scheduled-end'
        | 'stabilization-1272-party-controller'
        | 'stabilization-1225-whole-candidate'
        | 'stabilization-1225-cart-population'
        | 'stabilization-1280-person-owner';
    }
  | {
      readonly mode: 'empty';
      readonly purpose:
        | 'stabilization-1229-payment-entitlement'
        | 'stabilization-1234-outbox-clock'
        | 'stabilization-1235-inventory-release'
        | 'stabilization-1237-protection-intent'
        | 'stabilization-1260-privacy-legacy'
        | 'stabilization-1264-terminal-protection-health'
        | 'stabilization-1258-privacy-drain'
        | 'stabilization-1257-approval-fresh-proof'
        | 'stabilization-1274-media-ordering'
        | 'stabilization-1270-set-effective-revision'
        | 'stabilization-1250-market-revision'
        | 'stabilization-1248-price-group-effective-period'
        | 'stabilization-1281-party-legacy'
        | typeof exactDeadlinePurpose;
    }
) & {
  /** Enrollment whose gateway audiences the isolated trust catalog mirrors; Core-only fixtures enroll none. */
  readonly databaseIdentities?: DatabaseIdentityEnrollment;
  /** Explicit test-runner configuration; validated again and still restricted to local isolated databases. */
  readonly sourceConnections?: DatabaseConnectionPair;
};
const supportsPurpose = (input: IsolatedNativeDatabaseInput) =>
  input.mode === schemaOnly
    ? [
        'stabilization-1196-product-create',
        'stabilization-1229-payment-entitlement',
        'stabilization-1232-current-access',
        'stabilization-1238-invitation-claim',
        'stabilization-1282-verification-settlement',
        'stabilization-1231-redemption-restart',
        'stabilization-1263-optional-configuration',
        'stabilization-1266-quantity-profile-admission',
        'stabilization-1230-preference-period',
        'stabilization-1267-party-gateway',
        'stabilization-1268-address-plan',
        'stabilization-1261-retained-purpose-withdrawal',
        'stabilization-1247-set-component-current-closure',
        'stabilization-1253-product-axis-allowance',
        'stabilization-1249-promotion-eligible-subset',
        'stabilization-1262-catalog-public-reads',
        'stabilization-1278-bulk-intent',
        'stabilization-1256-approval-currentness',
        'stabilization-1257-approval-fresh-proof',
        'stabilization-1239-reviewed-match-reuse',
        'stabilization-1281-original-input',
        'stabilization-1240-identifier-correction-reuse',
        'stabilization-1246-approval-post-lock-expiry',
        'stabilization-1275-notice-instants',
        'stabilization-1274-media-ordering',
        'stabilization-1241-guest-evidence',
        'stabilization-1265-dsr-multi-owner',
        'stabilization-1251-postal-future-end',
        'stabilization-1254-retained-controlled-values',
        'stabilization-1269-override-target-existence',
        exactDeadlinePurpose,
        'stabilization-1270-set-effective-revision',
        'stabilization-1252-retired-sibling',
        'stabilization-1273-group-archive-scheduled-end',
        'stabilization-1272-party-controller',
        'stabilization-1225-whole-candidate',
        'stabilization-1225-cart-population',
        'stabilization-1280-person-owner',
      ].includes(input.purpose)
    : input.mode === 'empty' &&
      [
        'stabilization-1229-payment-entitlement',
        'stabilization-1234-outbox-clock',
        'stabilization-1235-inventory-release',
        'stabilization-1237-protection-intent',
        'stabilization-1260-privacy-legacy',
        'stabilization-1264-terminal-protection-health',
        'stabilization-1258-privacy-drain',
        'stabilization-1257-approval-fresh-proof',
        'stabilization-1274-media-ordering',
        'stabilization-1270-set-effective-revision',
        'stabilization-1250-market-revision',
        'stabilization-1248-price-group-effective-period',
        'stabilization-1281-party-legacy',
        exactDeadlinePurpose,
      ].includes(input.purpose);

/** A fresh schema-only database; it never drains, copies, or deletes the source database's data. */
export const makeIsolatedNativeDatabaseFixture = Effect.fn('IsolatedNativeDatabase.make')(
  function* makeIsolatedNativeDatabaseFixture(input: IsolatedNativeDatabaseInput) {
    if (!supportsPurpose(input)) {
      return yield* unavailable('Unsupported isolated database test purpose');
    }
    const snapshot =
      input.mode === schemaOnly
        ? yield* validateActiveApplicationCompositionSnapshot(input.compositionSnapshot).pipe(
            Effect.mapError((cause) => unavailable('Invalid isolated test composition', cause)),
          )
        : undefined;
    const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    if (Option.isSome(deployment) && ['stage', 'production'].includes(deployment.value)) {
      return yield* unavailable('Isolated native database fixtures are forbidden in deployed environments');
    }
    const source = yield* (
      input.sourceConnections === undefined
        ? loadDatabaseConnectionPair({ envPath: '/dev/null' })
        : parseDatabaseConnectionPair({
            DATABASE_ADMIN_URL: input.sourceConnections.admin.connectionString,
            DATABASE_URL: input.sourceConnections.runtime.connectionString,
          })
    ).pipe(Effect.mapError((cause) => unavailable(undefined, cause)));
    if (
      ![source.admin, source.runtime].every((configuration) => ['localhost', '127.0.0.1'].includes(configuration.host))
    ) {
      return yield* unavailable('Isolated native test databases require localhost');
    }
    const crypto = yield* Crypto.Crypto;
    const databaseName = `${prefix}${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: replaceDatabase(source.admin, databaseName),
      DATABASE_URL: replaceDatabase(source.runtime, databaseName),
    }).pipe(Effect.mapError((cause) => unavailable(undefined, cause)));
    // A separate pool scope outlives cleanup. Later owner/process scopes close first.
    const sourceScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(sourceScope, exit));
    const admin = yield* makeCoreDatabase(source.admin).pipe(
      Scope.provide(sourceScope),
      Effect.mapError((cause) => unavailable(undefined, cause)),
    );
    const original = input.mode === schemaOnly ? yield* readFingerprint(admin.executor) : undefined;
    yield* Effect.acquireRelease(
      admin.executor
        .execute(sql`create database ${sql.identifier(databaseName)}`, 'objects')
        .pipe(Effect.mapError((cause) => unavailable('Unable to create the isolated test database', cause))),
      () => {
        if (
          !databaseName.startsWith(prefix) ||
          databaseName === source.admin.database ||
          databaseName === source.runtime.database
        ) {
          return Effect.die(unavailable('Unsafe isolated database cleanup target'));
        }
        return admin.executor.execute(sql`drop database ${sql.identifier(databaseName)}`, 'objects').pipe(
          Effect.mapError((cause) => unavailable('Unable to drop the isolated test database', cause)),
          Effect.orDie,
          Effect.asVoid,
        );
      },
    );
    if (input.mode === schemaOnly) {
      const sourceDump = yield* postgresTool(source.admin, 'pg_dump', ['--schema-only', '--no-comments']);
      // One transaction: committing each of the dump's thousands of DDL statements separately made the clone
      // cost seconds per test, and a failed restore now leaves no partial schema behind.
      const restore = yield* postgresTool(
        connections.admin,
        'psql',
        ['--set', 'ON_ERROR_STOP=1', '--quiet', '--single-transaction'],
        sourceDump.stdout,
      );
      const [dumpExit, restoreExit] = yield* Effect.all(
        [
          sourceDump.exitCode,
          restore.exitCode,
          Stream.runDrain(sourceDump.stderr),
          Stream.runDrain(restore.stderr),
          Stream.runDrain(restore.stdout),
        ],
        { concurrency: 5 },
      ).pipe(
        Effect.mapError((cause) => unavailable('Schema-only clone failed', cause)),
        Effect.timeoutOrElse({
          duration: '30 seconds',
          orElse: () => Effect.fail(unavailable('Schema-only clone timed out')),
        }),
      );
      if (dumpExit !== 0 || restoreExit !== 0) {
        return yield* unavailable('Schema-only clone failed');
      }
    }
    const isolatedScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(isolatedScope, exit));
    const { clone, runtimeRole } = yield* Effect.all(
      {
        clone: makeCoreDatabase(connections.admin).pipe(
          Scope.provide(isolatedScope),
          Effect.mapError((cause) => unavailable(undefined, cause)),
        ),
        // Role validation is the only use of this runtime pool. Close it before any caller observes a baseline.
        runtimeRole: Effect.scoped(
          Effect.gen(function* validateIsolatedRuntimeRole() {
            const runtime = yield* makeCoreDatabase(connections.runtime);
            return yield* runtime.executor.execute<{
              readonly rolbypassrls: boolean;
              readonly rolsuper: boolean;
            }>(sql`select rolbypassrls,rolsuper from pg_roles where rolname=current_user`, 'objects');
          }),
        ).pipe(Effect.mapError((cause) => unavailable(undefined, cause))),
      },
      { concurrency: 2 },
    );
    const assertClonedSchema = Effect.fn('IsolatedNativeDatabase.assertClonedSchema')(function* assertClonedSchema() {
      if (input.mode !== schemaOnly || original === undefined) {
        return yield* unavailable('Schema clone validation requires this scope’s schema-only database');
      }
      const copied = yield* readFingerprint(clone.executor);
      if (copied !== original) {
        return yield* unavailable('Schema-only clone changed schema, RLS or grants');
      }
      return yield* Effect.void;
    });
    if (input.mode === schemaOnly) {
      yield* assertClonedSchema();
    }
    const [role] = runtimeRole;
    if (!Schema.is(Schema.Struct({ rolbypassrls: Schema.Literal(false), rolsuper: Schema.Literal(false) }))(role)) {
      return yield* unavailable('Unsafe isolated runtime role');
    }
    const tables = yield* clone.executor
      .execute<{ readonly schemaname: string; readonly tablename: string }>(
        sql`select schemaname,tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by schemaname,tablename`,
        'objects',
      )
      .pipe(Effect.mapError((cause) => unavailable(undefined, cause)));
    yield* Effect.forEach(
      tables,
      Effect.fn('IsolatedNativeDatabase.assertEmpty')(function* assertEmpty(table) {
        const [row] = yield* clone.executor
          .execute<{ readonly populated: boolean }>(
            sql`select exists(select 1 from ${sql.identifier(table.schemaname)}.${sql.identifier(table.tablename)} limit 1) as populated`,
            'objects',
          )
          .pipe(Effect.mapError((cause) => unavailable(undefined, cause)));
        if (row?.populated !== false) {
          return yield* unavailable('Schema-only clone contains source data');
        }
        return yield* Effect.void;
      }),
      { concurrency: 1 },
    );
    if (
      input.mode === schemaOnly &&
      tables.some(
        ({ schemaname, tablename }) =>
          schemaname === 'trust' && ['scope_sealing_keys', 'gateway_audience_roles'].includes(tablename),
      )
    ) {
      // pg_dump deliberately carries no rows. Only after every cloned table proved empty,
      // recreate the migration's technical HMAC state using fresh database-local entropy.
      // Never read source key material, grants, identities or business rows.
      yield* clone.executor
        .transaction(
          Effect.fn('IsolatedNativeDatabase.initializeTrust')(function* initializeTrust(transaction) {
            yield* transaction.execute(
              sql`
              do $$
              declare
                v_key bytea := pg_catalog.sha256(pg_catalog.convert_to(
                  pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text,
                  'UTF8'));
                v_block bytea := v_key || pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');
                v_inner bytea := v_block;
                v_outer bytea := v_block;
              begin
                for i in 0..63 loop
                  v_inner := pg_catalog.set_byte(v_inner, i, pg_catalog.get_byte(v_block, i) # 54);
                  v_outer := pg_catalog.set_byte(v_outer, i, pg_catalog.get_byte(v_block, i) # 92);
                end loop;
                insert into trust.scope_sealing_keys (key_id, inner_pad, outer_pad) values (1, v_inner, v_outer);
              end $$`,
              'objects',
            );
            // Match runtime-role bootstrap's canonical enrollment, never source table contents.
            const enrollment = input.databaseIdentities ?? defineDatabaseIdentityEnrollment([]);
            const audienceRoles = enrollment.identities
              .filter(({ scopeAuthority }) => scopeAuthority === 'gateway_grant')
              .flatMap(({ gatewayScopeAudiences, role: audienceRole }) =>
                gatewayScopeAudiences.map((audience) => ({ audience, audienceRole })),
              );
            yield* Effect.forEach(
              audienceRoles,
              ({ audience, audienceRole }) =>
                transaction.execute(
                  sql`insert into trust.gateway_audience_roles (audience, role_name) values (${audience}, ${audienceRole})`,
                  'objects',
                ),
              { concurrency: 1, discard: true },
            );
          }),
        )
        .pipe(Effect.mapError((cause) => unavailable('Unable to initialize isolated trust configuration', cause)));
      yield* assertClonedSchema();
    }
    const retainedOriginalEnabled = input.mode === 'empty' && input.purpose === 'stabilization-1258-privacy-drain';
    const replacementEnabled =
      input.mode === 'empty' && (input.purpose === exactDeadlinePurpose || retainedOriginalEnabled);
    const retainedReplacementRevision = yield* Ref.make<string | null>(null);
    const replacementState = yield* Ref.make<'unused' | 'pending' | 'published' | 'failed'>('unused');
    const controllerClosed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() => Ref.set(controllerClosed, true));
    const ownedBoundary = Object.freeze({
      adminUser: connections.admin.user,
      database: databaseName,
      runtimeUser: connections.runtime.user,
      sourceAdminDatabase: source.admin.database,
      sourceRuntimeDatabase: source.runtime.database,
    });
    const [nativeOwnedIdentity] = yield* clone.executor
      .execute<{
        readonly databaseOid: string;
        readonly runtimeRoleOid: string;
        readonly serverAddress: string | null;
        readonly serverPort: number | null;
      }>(
        sql`select d.oid::text as "databaseOid",r.oid::text as "runtimeRoleOid",
      inet_server_addr()::text as "serverAddress",inet_server_port() as "serverPort"
      from pg_database d cross join pg_roles r
      where d.datname=current_database() and r.rolname=${ownedBoundary.runtimeUser}`,
        'objects',
      )
      .pipe(Effect.mapError((cause) => unavailable('Unable to capture isolated database identity', cause)));
    let managedInitialRevision: string | undefined;
    let managedInitialObservedAt: number | undefined;
    let managedInitialValidUntil: number | undefined;
    const publishInitialComposition = Effect.fn('IsolatedNativeDatabase.publishInitialComposition')(
      function* publishInitialComposition(candidate: ActiveApplicationCompositionSnapshot) {
        const validated = yield* validateActiveApplicationCompositionSnapshot(candidate).pipe(
          Effect.mapError((cause) => unavailable('Invalid isolated test composition', cause)),
        );
        yield* clone.executor
          .transaction(
            Effect.fn('IsolatedNativeDatabase.initialPublication')(function* initialPublication(transaction) {
              yield* lockApplicationCompositionPublication(transaction);
              const existing = yield* transaction
                .select({ key: applicationCompositionAuthority.authorityKey })
                .from(applicationCompositionAuthority)
                .limit(1);
              if (existing.length !== 0) {
                return yield* unavailable('The isolated test database already has composition authority');
              }
              return yield* publishApplicationCompositionAuthority(transaction, validated);
            }),
          )
          .pipe(Effect.mapError((cause) => unavailable('Unable to publish initial isolated composition', cause)));
        managedInitialRevision = validated.composition.revision;
        managedInitialObservedAt = DateTime.toEpochMillis(validated.observedAt);
        managedInitialValidUntil = DateTime.toEpochMillis(validated.validUntil);
      },
    );
    if (snapshot !== undefined) {
      yield* publishInitialComposition(snapshot);
    }
    const migrateCoreSchema = Effect.fn('IsolatedNativeDatabase.migrateCoreSchema')(function* migrateCoreSchema() {
      if (input.mode !== 'empty') {
        return yield* unavailable('Core schema bootstrap requires the empty test database mode');
      }
      // Core's own `db:migrate`: its main and demo migration lineages converge through the reviewed equivalence
      // plan, which a plain `drizzle-kit migrate` would replay twice.
      const migration = yield* ChildProcess.make(
        process.execPath,
        ['../../scripts/migration-convergence-cli.mts', 'core'],
        {
          cwd: new URL('../../', import.meta.url).pathname,
          env: {
            DATABASE_ADMIN_URL: connections.admin.connectionString,
            DATABASE_URL: connections.runtime.connectionString,
          },
          extendEnv: true,
          stderr: 'pipe',
          stdout: 'pipe',
        },
      ).pipe(Effect.mapError((cause) => unavailable('Unable to start the isolated Core migration', cause)));
      const [migrationExit] = yield* Effect.all(
        [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError((cause) => unavailable('Unable to migrate the isolated Core schema', cause)),
        Effect.timeoutOrElse({
          duration: '30 seconds',
          orElse: () => Effect.fail(unavailable('The isolated Core migration timed out')),
        }),
      );
      if (migrationExit !== 0) {
        return yield* unavailable('The isolated Core migration failed');
      }
      // Match the Core-only portion of the repository runtime bootstrap. No role flags,
      // passwords, source database privileges or other owner's schema are changed.
      const roleIdentifier = sql.identifier(connections.runtime.user);
      return yield* clone.executor
        .transaction(
          Effect.fn('IsolatedNativeDatabase.bootstrapCoreRuntime')(function* bootstrapCoreRuntime(transaction) {
            yield* transaction.execute(
              sql`grant connect on database ${sql.identifier(connections.admin.database)} to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(sql`grant usage on schema core to ${roleIdentifier}`, 'objects');
            yield* transaction.execute(
              sql`grant select,insert,update,delete on all tables in schema core to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`grant usage,select on all sequences in schema core to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`alter default privileges in schema core grant select,insert,update,delete on tables to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`alter default privileges in schema core grant usage,select on sequences to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`revoke all on table core.application_composition_authority from public,${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`grant select on table core.application_composition_authority to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`revoke all on table core.application_composition_durable_work from public,${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`grant select on table core.application_composition_durable_work to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`revoke all on table core.outbox_delivery_resolutions from public,${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`grant select on table core.outbox_delivery_resolutions to ${roleIdentifier}`,
              'objects',
            );
            yield* transaction.execute(
              sql`revoke all on function core.track_application_composition_durable_work(text,text,text,boolean) from public,${roleIdentifier}`,
              'objects',
            );
          }),
        )
        .pipe(Effect.mapError((cause) => unavailable('Unable to establish the isolated Core runtime contract', cause)));
    });
    const runCompositionOperation = Effect.fn('IsolatedNativeDatabase.boundCompositionOperation')(
      function* runCompositionOperation<Result, Failure>(
        operation: (transaction: CoreTransaction, revision: string) => Effect.Effect<Result, Failure>,
        replacement = false,
      ) {
        const revision = managedInitialRevision;
        if (
          revision === undefined ||
          (replacementEnabled &&
            ((yield* Ref.get(controllerClosed)) ||
              (!replacement && (yield* Ref.get(replacementState)) !== 'unused'))) ||
          !databaseName.startsWith(prefix) ||
          databaseName === source.admin.database ||
          databaseName === source.runtime.database ||
          connections.admin.database !== databaseName ||
          connections.runtime.database !== databaseName
        ) {
          return yield* unavailable(
            'Composition controls require this scope’s created database and initial publication',
          );
        }
        return yield* clone.executor
          .transaction(
            Effect.fn('IsolatedNativeDatabase.controlInitialComposition')(
              function* controlInitialComposition(transaction) {
                yield* lockApplicationCompositionPublication(transaction);
                const [identity] = yield* transaction.execute<{ readonly owned: boolean }>(
                  sql`select
              current_database() = ${databaseName} and
              exists(select 1 from pg_database where datname=current_database()
                and pg_get_userbyid(datdba)=${connections.admin.user}) as owned`,
                  'objects',
                );
                if (identity?.owned !== true) {
                  return yield* unavailable('Composition controls cannot target a source or unowned database');
                }
                const [authority] = yield* transaction
                  .select({
                    revision: applicationCompositionAuthority.revision,
                    unexpired: sql<boolean>`${applicationCompositionAuthority.validUntil} > clock_timestamp()`,
                  })
                  .from(applicationCompositionAuthority)
                  .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
                if (authority?.revision !== revision || !authority.unexpired) {
                  return yield* unavailable(
                    'Composition controls cannot target a source database or foreign/expired revision',
                  );
                }
                return yield* operation(transaction, revision);
              },
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('Unable to control this isolated initial composition', cause)));
      },
    );
    const observeComposition = Effect.fn('IsolatedNativeDatabase.observeInitialComposition')(
      function* observeComposition(transaction: CoreTransaction, revision: string) {
        const [authority] = yield* transaction
          .select({
            durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
            phase: applicationCompositionAuthority.phase,
          })
          .from(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        if (authority === undefined) {
          return yield* unavailable('The isolated initial composition is unavailable');
        }
        const work = yield* transaction
          .select({
            originalRevision: applicationCompositionDurableWork.originalRevision,
            ownerModuleKey: applicationCompositionDurableWork.ownerModuleKey,
            workId: applicationCompositionDurableWork.workId,
          })
          .from(applicationCompositionDurableWork)
          .where(eq(applicationCompositionDurableWork.originalRevision, revision))
          .orderBy(asc(applicationCompositionDurableWork.ownerModuleKey), asc(applicationCompositionDurableWork.workId))
          .limit(26);
        return Object.freeze({
          durableWorkAdmission: authority.durableWorkAdmission,
          hasMoreDurableWork: work.length > 25,
          pendingDurableWork: Object.freeze(work.slice(0, 25).map((item) => Object.freeze(item))),
          phase: authority.phase,
          revision,
        });
      },
    );
    // TEST-1258 only: bounded original proof, never a history or a mutation capability.
    const observeRetainedOriginal = Effect.fn('IsolatedNativeDatabase.observeRetainedOriginal')(
      function* observeRetainedOriginal() {
        const originalRevision = managedInitialRevision;
        const validUntilEpochMilliseconds = managedInitialValidUntil;
        if (
          !retainedOriginalEnabled ||
          originalRevision === undefined ||
          validUntilEpochMilliseconds === undefined ||
          nativeOwnedIdentity === undefined ||
          (yield* Ref.get(controllerClosed)) ||
          !databaseName.startsWith(prefix) ||
          databaseName === source.admin.database ||
          databaseName === source.runtime.database ||
          connections.admin.database !== databaseName ||
          connections.runtime.database !== databaseName
        ) {
          return yield* unavailable(
            'Retained observation requires the exact live TEST-1258 scope and initial publication',
          );
        }
        return yield* clone.executor
          .transaction(
            Effect.fn('IsolatedNativeDatabase.readOwnedOriginal')(function* readOwnedOriginal(transaction) {
              yield* lockApplicationCompositionPublication(transaction);
              // Physical identity and PostgreSQL wall clock cannot be expressed by a table query alone.
              const [identity] = yield* transaction.execute<{
                readonly observedAtEpochMilliseconds: number;
                readonly owned: boolean;
              }>(
                sql`select
                current_database()=${ownedBoundary.database} and d.oid::text=${nativeOwnedIdentity.databaseOid}
                and current_user=${ownedBoundary.adminUser} and session_user=${ownedBoundary.adminUser}
                and pg_get_userbyid(d.datdba)=${ownedBoundary.adminUser}
                and r.oid::text=${nativeOwnedIdentity.runtimeRoleOid} and not r.rolsuper and not r.rolbypassrls
                and inet_server_addr()::text is not distinct from ${nativeOwnedIdentity.serverAddress}
                and inet_server_port() is not distinct from ${nativeOwnedIdentity.serverPort} as owned,
                floor(extract(epoch from clock_timestamp()) * 1000)::float8 as "observedAtEpochMilliseconds"
                from pg_database d cross join pg_roles r
                where d.datname=current_database() and r.rolname=${ownedBoundary.runtimeUser}`,
                'objects',
              );
              if (identity?.owned !== true) {
                return yield* unavailable('Retained observation cannot target a foreign database, role or endpoint');
              }
              const [current] = yield* transaction
                .select({
                  durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
                  phase: applicationCompositionAuthority.phase,
                  revision: applicationCompositionAuthority.revision,
                  validUntil: applicationCompositionAuthority.validUntil,
                })
                .from(applicationCompositionAuthority)
                .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
              const replacementRevision = yield* Ref.get(retainedReplacementRevision);
              if (
                current === undefined ||
                (current.revision === originalRevision
                  ? current.validUntil.getTime() !== validUntilEpochMilliseconds || replacementRevision !== null
                  : current.revision !== replacementRevision || (yield* Ref.get(replacementState)) !== 'published')
              ) {
                return yield* unavailable(
                  'Retained observation requires the exact original or this scope’s published replacement',
                );
              }
              const work = yield* transaction
                .select({
                  originalRevision: applicationCompositionDurableWork.originalRevision,
                  ownerModuleKey: applicationCompositionDurableWork.ownerModuleKey,
                  workId: applicationCompositionDurableWork.workId,
                })
                .from(applicationCompositionDurableWork)
                .where(eq(applicationCompositionDurableWork.originalRevision, originalRevision))
                .orderBy(
                  asc(applicationCompositionDurableWork.ownerModuleKey),
                  asc(applicationCompositionDurableWork.workId),
                )
                .limit(26);
              return Object.freeze({
                currentRevision: current.revision,
                durableWorkAdmission:
                  current.revision === originalRevision ? current.durableWorkAdmission : ('closed' as const),
                hasMoreDurableWork: work.length > 25,
                observedAtEpochMilliseconds: identity.observedAtEpochMilliseconds,
                originalRevision,
                pendingDurableWork: Object.freeze(work.slice(0, 25).map((item) => Object.freeze(item))),
                phase: current.revision === originalRevision ? current.phase : ('draining' as const),
                unexpired: identity.observedAtEpochMilliseconds < validUntilEpochMilliseconds,
                validUntilEpochMilliseconds,
              });
            }),
          )
          .pipe(Effect.mapError((cause) => unavailable('Unable to observe this isolated original composition', cause)));
      },
    );
    // Dedicated one-shot TEST transition. The original controller never follows the replacement revision.
    const publishReplacement = Effect.fn('IsolatedNativeDatabase.publishReplacement')(function* publishReplacement(
      candidate: ActiveApplicationCompositionSnapshot,
    ) {
      const initialObservedAt = managedInitialObservedAt;
      if (
        !replacementEnabled ||
        nativeOwnedIdentity === undefined ||
        initialObservedAt === undefined ||
        (yield* Ref.get(controllerClosed))
      ) {
        return yield* unavailable('Replacement requires this dedicated live isolated scope');
      }
      const approved = yield* validateActiveApplicationCompositionSnapshot(candidate).pipe(
        Effect.mapError((cause) => unavailable('Invalid isolated replacement composition', cause)),
      );
      const claimed = yield* Ref.modify(replacementState, (state) =>
        state === 'unused' ? [true, 'pending' as const] : [false, state],
      );
      if (!claimed) {
        return yield* unavailable('This isolated replacement attempt has already been consumed');
      }
      return yield* runCompositionOperation(
        Effect.fn('IsolatedNativeDatabase.publishOwnedReplacement')(
          function* publishOwnedReplacement(transaction, revision) {
            const [identity] = yield* transaction.execute<{ readonly owned: boolean }>(
              sql`select
            current_database()=${ownedBoundary.database} and d.oid::text=${nativeOwnedIdentity.databaseOid}
            and current_user=${ownedBoundary.adminUser} and session_user=${ownedBoundary.adminUser}
            and pg_get_userbyid(d.datdba)=${ownedBoundary.adminUser}
            and r.oid::text=${nativeOwnedIdentity.runtimeRoleOid} and not r.rolsuper and not r.rolbypassrls
            and inet_server_addr()::text is not distinct from ${nativeOwnedIdentity.serverAddress}
            and inet_server_port() is not distinct from ${nativeOwnedIdentity.serverPort} as owned
            from pg_database d cross join pg_roles r
            where d.datname=current_database() and r.rolname=${ownedBoundary.runtimeUser}`,
              'objects',
            );
            if (
              identity?.owned !== true ||
              !ownedBoundary.database.startsWith(prefix) ||
              ownedBoundary.database === ownedBoundary.sourceAdminDatabase ||
              ownedBoundary.database === ownedBoundary.sourceRuntimeDatabase
            ) {
              return yield* unavailable('Replacement cannot target a source or foreign database, role or endpoint');
            }
            const [current] = yield* transaction
              .select({
                admission: applicationCompositionAuthority.durableWorkAdmission,
                phase: applicationCompositionAuthority.phase,
                validUntil: applicationCompositionAuthority.validUntil,
              })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
            if (
              current === undefined ||
              current.phase !== 'draining' ||
              current.admission !== 'closed' ||
              (retainedOriginalEnabled && current.validUntil.getTime() !== managedInitialValidUntil) ||
              approved.composition.revision === revision ||
              DateTime.toEpochMillis(approved.observedAt) <= initialObservedAt ||
              DateTime.toEpochMillis(approved.validUntil) <= current.validUntil.getTime()
            ) {
              return yield* unavailable(
                'Replacement requires the exact closed draining initial revision and newer freshness',
              );
            }
            // The real publisher independently validates the catalog and all native durable/Outbox debt.
            yield* publishApplicationCompositionAuthority(transaction, approved);
            const [published] = yield* transaction
              .select({
                durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
                phase: applicationCompositionAuthority.phase,
                revision: applicationCompositionAuthority.revision,
              })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
            if (
              published?.revision !== approved.composition.revision ||
              published.phase !== 'active' ||
              published.durableWorkAdmission !== 'open'
            ) {
              return yield* unavailable('Replacement did not establish the exact new active authority');
            }
            return Object.freeze({ ...published });
          },
        ),
        true,
      ).pipe(
        Effect.tap(() =>
          retainedOriginalEnabled
            ? Ref.set(retainedReplacementRevision, approved.composition.revision).pipe(
                Effect.andThen(Ref.set(replacementState, 'published')),
              )
            : Ref.set(replacementState, 'published'),
        ),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(replacementState, 'failed') : Effect.void)),
      );
    });
    const composition = Object.freeze({
      closeAdmission: () => runCompositionOperation(closeApplicationCompositionDurableAdmission),
      drain: () => runCompositionOperation(drainApplicationCompositionAuthority),
      observe: () => runCompositionOperation(observeComposition),
      observeRetainedOriginal,
      publishReplacement,
      seal: () => runCompositionOperation(sealApplicationCompositionAuthority),
    });
    // Only this scope's new database is reachable; no administrative executor escapes.
    return {
      assertClonedSchema,
      composition,
      connections: connections satisfies DatabaseConnectionPair,
      migrateCoreSchema,
      publishInitialComposition,
    };
  },
);
