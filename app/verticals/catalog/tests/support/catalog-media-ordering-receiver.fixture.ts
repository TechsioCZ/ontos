import { Socket } from 'node:net';
import { promisify } from 'node:util';
import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  ReadRuntimeLive,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
  parseDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices, NodeStream } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import {
  Config,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Path,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createProductActionApiLive } from '../../api/create-product-action-server.ts';
import { assignCatalogMediaActionApiLive } from '../../api/assign-catalog-media-action-server.ts';
import { reorderCatalogMediaActionApiLive } from '../../api/reorder-catalog-media-action-server.ts';
import { removeCatalogMediaActionApiLive } from '../../api/remove-catalog-media-action-server.ts';
import { catalogMediaCurrentReadApiLive } from '../../api/catalog-media-current-read-server.ts';
import { reorderCatalogMediaRecoveryReadApiLive } from '../../api/reorder-catalog-media-recovery-read-server.ts';
import { catalogApi } from '../../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { CATALOG_TABLES, catalogRelations, gatewayAssertionRedemptions } from '../../src/database/schema.ts';

export const mediaOrderingProtocol = 'ontos.catalog.media-ordering.fixture.v1' as const;
const bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const secret = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)));
const strict = { parseOptions: { onExcessProperty: 'error' as const } };
export const MediaOwnedDatabaseCertificateSchema = Schema.Struct({
  adminRole: bounded,
  adminUrl: secret,
  name: Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f0-9]{32}$/u)),
  oid: positive,
  owner: bounded,
  runtimeRole: bounded,
  runtimeUrl: secret,
  serverAddress: bounded,
  serverPort: positive,
}).annotate(strict);
export const MediaOrderingBootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  composition: ActiveApplicationCompositionSnapshotSchema,
  database: MediaOwnedDatabaseCertificateSchema,
  issuer: bounded,
  jwks: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  spiceDb: Schema.Struct({
    caCertificate: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    endpoint: bounded,
    token: secret,
  }).annotate(strict),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(mediaOrderingProtocol),
}).annotate(strict);
export const MediaOrderingCommandSchema = Schema.Union([
  MediaOrderingBootstrapSchema,
  Schema.Struct({ type: Schema.Literal('stop'), version: Schema.Literal(mediaOrderingProtocol) }).annotate(strict),
]);
export const MediaOrderingResponseSchema = Schema.Union([
  Schema.Struct({
    buildMarker: bounded,
    compositionRevision: bounded,
    port: positive,
    type: Schema.Literal('BOOTED'),
    version: Schema.Literal(mediaOrderingProtocol),
  }).annotate(strict),
  Schema.Struct({ type: Schema.Literal('STOPPED'), version: Schema.Literal(mediaOrderingProtocol) }).annotate(strict),
]);
class MediaOrderingFixtureUnavailable extends Schema.TaggedError<MediaOrderingFixtureUnavailable>()(
  'MediaOrderingFixtureUnavailable',
  { stage: Schema.String },
) {}
const failure = (stage: string) => new MediaOrderingFixtureUnavailable({ stage });
const requireCondition = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(failure(stage)));

const addressMatchesCertificate = (
  pair: Effect.Success<ReturnType<typeof parseDatabaseConnectionPair>>,
  certificate: typeof MediaOwnedDatabaseCertificateSchema.Type,
): boolean =>
  pair.admin.database === certificate.name &&
  pair.runtime.database === certificate.name &&
  pair.admin.host === pair.runtime.host &&
  pair.admin.port === pair.runtime.port &&
  ['localhost', '127.0.0.1'].includes(pair.admin.host) &&
  pair.admin.user === certificate.adminRole &&
  pair.runtime.user === certificate.runtimeRole &&
  certificate.owner === certificate.adminRole &&
  certificate.adminRole !== certificate.runtimeRole;

/** Repeat the parent certificate against the actual Core-created database; a name prefix alone is insufficient. */
export const guardMediaOwnedDatabase = Effect.fn('MediaOrdering.guardOwnedDatabase')(function* guardOwnedDatabase(
  certificate: typeof MediaOwnedDatabaseCertificateSchema.Type,
) {
  const pair = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(certificate.adminUrl),
    DATABASE_URL: Redacted.value(certificate.runtimeUrl),
  }).pipe(Effect.mapError(() => failure('owned-configuration')));
  yield* requireCondition(addressMatchesCertificate(pair, certificate), 'owned-address');
  for (const [kind, connection] of [
    ['admin', pair.admin],
    ['runtime', pair.runtime],
  ] as const) {
    const ctx = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(connection.connectionString) }),
    );
    const client = Context.get(ctx, PgClient.PgClient);
    const rows = yield* client<{
      bypass_rls: boolean;
      database_name: string;
      database_oid: number;
      database_owner: string;
      effective_role: string;
      server_address: string;
      server_port: number;
      session_role: string;
      superuser: boolean;
    }>`select current_database() as database_name, d.oid::int as database_oid, pg_get_userbyid(d.datdba) as database_owner,
      session_user::text as session_role, current_user::text as effective_role, inet_server_addr()::text as server_address,
      inet_server_port() as server_port, r.rolsuper as superuser, r.rolbypassrls as bypass_rls
      from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`.pipe(
      Effect.mapError(() => failure('owned-identity-read')),
    );
    const [actual] = rows;
    const role = kind === 'admin' ? certificate.adminRole : certificate.runtimeRole;
    yield* requireCondition(
      rows.length === 1 &&
        actual !== undefined &&
        actual.database_name === certificate.name &&
        actual.database_oid === certificate.oid &&
        actual.database_owner === certificate.owner &&
        actual.session_role === role &&
        actual.effective_role === role &&
        actual.server_address === certificate.serverAddress &&
        actual.server_port === certificate.serverPort &&
        (kind === 'admin' || (!actual.superuser && !actual.bypass_rls)),
      'owned-identity',
    );
    if (kind === 'runtime') {
      yield* requireCondition(actual !== undefined && !actual.superuser && !actual.bypass_rls, 'owned-runtime-rls');
    }
  }
  return pair;
});

export const mediaOrderingClosedEnvironment = (bootstrap: typeof MediaOrderingBootstrapSchema.Type) =>
  Object.freeze({
    APP_ENV_PATH: '/dev/null',
    DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
    ONTOS_GATEWAY_ISSUER: bootstrap.issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: bootstrap.jwks,
    SPICEDB_CA_CERT: bootstrap.spiceDb.caCertificate ?? '',
    SPICEDB_ENDPOINT: bootstrap.spiceDb.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.value(bootstrap.spiceDb.token),
  });
const checkFixedEnvironment = Effect.fn('MediaOrdering.checkFixedEnvironment')(function* checkFixedEnvironment(
  bootstrap: typeof MediaOrderingBootstrapSchema.Type,
) {
  for (const [key, value] of Object.entries(mediaOrderingClosedEnvironment(bootstrap))) {
    const actual = yield* Config.Redacted(key);
    yield* requireCondition(Redacted.value(actual) === value, 'closed-runtime-configuration');
  }
});

const migrateCatalog = Effect.fn('MediaOrdering.migrateCatalog')(function* migrateCatalog(
  bootstrap: typeof MediaOrderingBootstrapSchema.Type,
) {
  // Both actual owned credentials are rechecked before this owner's migration effects.
  yield* guardMediaOwnedDatabase(bootstrap.database);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.resolve('.');
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-1274-migration-' });
  const configuration = path.join(temporary, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    "export default { dialect:'postgresql', out:process.env.ONTOS_1274_HISTORY, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_catalog'} };\n",
  );
  const child = yield* ChildProcess.make(
    process.execPath,
    [path.join(directory, 'node_modules/drizzle-kit/bin.cjs'), 'migrate', '--config', configuration],
    {
      cwd: directory,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
        ONTOS_1274_HISTORY: path.join(directory, 'drizzle'),
      },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  yield* requireCondition(code === 0, 'owned-catalog-migration');
});
const catalogJournalFingerprint = Effect.fn('MediaOrdering.catalogJournalFingerprint')(
  function* catalogJournalFingerprint(bootstrap: typeof MediaOrderingBootstrapSchema.Type) {
    yield* guardMediaOwnedDatabase(bootstrap.database);
    const context = yield* Layer.build(PgClient.layer({ maxConnections: 1, url: bootstrap.database.adminUrl }));
    const client = Context.get(context, PgClient.PgClient);
    const [observed] = yield* client<{ count: number; fingerprint: string }>`select count(*)::int as count,
    md5(string_agg(row_to_json(m)::text,',' order by m.id)) as fingerprint
    from drizzle.__drizzle_migrations_catalog m`;
    if (observed === undefined || observed.count < 1) {
      return yield* failure('catalog-journal-empty');
    }
    return observed;
  },
);
const verifyCatalog = Effect.fn('MediaOrdering.verifyCatalog')(function* verifyCatalog(
  bootstrap: typeof MediaOrderingBootstrapSchema.Type,
) {
  yield* guardMediaOwnedDatabase(bootstrap.database);
  const path = yield* Path.Path;
  const directory = path.resolve('.');
  const child = yield* ChildProcess.make(process.execPath, [path.join(directory, 'scripts/verify-db-schema.mts')], {
    cwd: directory,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
      DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
    },
    extendEnv: false,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  yield* requireCondition(code === 0, 'owned-catalog-full-verifier');
});
const grantCatalogRuntimeAccess = Effect.fn('MediaOrdering.grantCatalogRuntimeAccess')(
  function* grantCatalogRuntimeAccess(bootstrap: typeof MediaOrderingBootstrapSchema.Type) {
    yield* guardMediaOwnedDatabase(bootstrap.database);
    const context = yield* Layer.build(
      PgClient.layer({
        maxConnections: 1,
        url: bootstrap.database.adminUrl,
      }).pipe(Layer.provideMerge(Reactivity.layer)),
    );
    const client = Context.get(context, PgClient.PgClient);
    const tenantTables = CATALOG_TABLES.filter((table) => table !== gatewayAssertionRedemptions);
    const [before] = yield* client<{ forced: number; tables: number }>`
    select count(*)::integer as tables,
      count(*) filter (where c.relrowsecurity and c.relforcerowsecurity)::integer as forced
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='catalog' and c.relkind='r'`;
    yield* requireCondition(
      before !== undefined && before.tables === CATALOG_TABLES.length && before.forced === tenantTables.length,
      'owned-catalog-before-acl',
    );
    const admin = yield* makeWithDefaults({ relations: catalogRelations }).pipe(Effect.provide(context));
    const runtimeRole = sql.identifier(bootstrap.database.runtimeRole);
    // Same finite current-owner privileges as normal bootstrap, in this certified owned DB only.
    // Never modify global/default privileges or bypass RLS and immutable-history protections.
    yield* admin.execute(sql`grant usage on schema catalog to ${runtimeRole}`, 'objects');
    yield* Effect.forEach(
      tenantTables,
      (table) => admin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects'),
      { concurrency: 1, discard: true },
    );
    const [after] = yield* client<{
      can_create: boolean;
      can_use: boolean;
      complete: number;
      forced: number;
      tables: number;
    }>`
    select count(*)::integer as tables,
      count(*) filter (where c.relrowsecurity and c.relforcerowsecurity)::integer as forced,
      count(*) filter (where c.relname <> 'gateway_assertion_redemptions' and
        has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'SELECT') and
        has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'INSERT') and
        has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'UPDATE') and
        has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'DELETE'))::integer as complete,
      has_schema_privilege(${bootstrap.database.runtimeRole},'catalog','USAGE') as can_use,
      has_schema_privilege(${bootstrap.database.runtimeRole},'catalog','CREATE') as can_create
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='catalog' and c.relkind='r'`;
    yield* requireCondition(
      after !== undefined &&
        after.tables === CATALOG_TABLES.length &&
        after.forced === tenantTables.length &&
        after.complete === tenantTables.length &&
        after.can_use &&
        !after.can_create,
      'owned-catalog-after-acl',
    );
    const [replay] = yield* client<{ valid: boolean }>`select
      (count(*) = 1 and bool_and(
        not c.relrowsecurity and not c.relforcerowsecurity
        and has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'SELECT')
        and has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'INSERT')
        and has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'DELETE')
        and not has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'UPDATE')
        and not has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'REFERENCES')
        and not has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'TRUNCATE')
        and not has_table_privilege(${bootstrap.database.runtimeRole},c.oid,'TRIGGER')
        and not exists (select 1
          from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
          where acl.grantee=0)
      )) as valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='catalog' and c.relname='gateway_assertion_redemptions' and c.relkind='r'`;
    yield* requireCondition(replay !== undefined && replay.valid, 'owned-catalog-replay-exact-privileges-and-no-rls');
    yield* guardMediaOwnedDatabase(bootstrap.database);
  },
);
const serveCatalog = Effect.fn('MediaOrdering.serveCatalog')(function* serveCatalog(
  bootstrap: typeof MediaOrderingBootstrapSchema.Type,
) {
  yield* guardMediaOwnedDatabase(bootstrap.database);
  const pair = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
    DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
  });
  const database = Layer.succeed(DatabaseConfig, pair.runtime);
  const persistence = CorePersistenceLive.pipe(Layer.provide(database));
  const stateGate = ModuleStateGateLive.pipe(
    Layer.provide(TenantModuleStateServiceLive.pipe(Layer.provide(persistence))),
  );
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(stateGate));
  const resolver = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
  const namespace = staffAuthenticationNamespaceRegistryLayer(['catalog']);
  const composition = makeActiveApplicationCompositionLayer(Effect.succeed(bootstrap.composition));
  const common = Layer.mergeAll(persistence, ContextAccessLive, stateGate, gateway, resolver, namespace, composition);
  const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(Layer.mergeAll(common, ActionRepositoryLive, ActionPermissionLive)),
    Layer.provide(NodeCrypto.layer),
  );
  const reads = ReadRuntimeLive.pipe(Layer.provide(common), Layer.provide(NodeCrypto.layer));
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    bootstrap.composition,
  );
  const source = Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(encoded) });
  // TEST-only atomic in-process redemption; this does not attest the default production store.
  const redeemed = new Set<string>();
  const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
    consume: ({ jti }) =>
      Effect.suspend(() => {
        if (redeemed.has(jti)) {
          return Effect.fail(new GatewayAssertionReplayError({ reason: 'TEST assertion already redeemed' }));
        }
        redeemed.add(jti);
        return Effect.void;
      }),
  });
  const handlers = Layer.mergeAll(
    createProductActionApiLive,
    assignCatalogMediaActionApiLive,
    reorderCatalogMediaActionApiLive,
    removeCatalogMediaActionApiLive,
    catalogMediaCurrentReadApiLive,
    reorderCatalogMediaRecoveryReadApiLive,
  ).pipe(
    Layer.provide(ActionPrincipalVerifierLive.pipe(Layer.provide(composition))),
    Layer.provide(Layer.mergeAll(actions, reads, namespace, redemption, source, RequestSchemaProblemLive)),
    Layer.provide(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(
          HttpApi.make('CatalogApi')
            .add(catalogApi.groups.createProductAction)
            .add(catalogApi.groups.assignCatalogMediaAction)
            .add(catalogApi.groups.reorderCatalogMediaAction)
            .add(catalogApi.groups.removeCatalogMediaAction)
            .add(catalogApi.groups.catalogMediaCurrent)
            .add(catalogApi.groups.reorderCatalogMediaRecovery),
        ).pipe(
          Layer.provide(handlers),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeCrypto.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (handler) => Effect.promise(async () => await handler.dispose()).pipe(Effect.orDie),
  );
  const serverContext = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(serverContext, HttpServer.HttpServer);
  const empty = Context.makeUnsafe<unknown>(new Map());
  yield* server.serve(
    Effect.gen(function* catalogRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: () => failure('catalog-http'),
        try: async () => await app.handler(web, empty),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: positive }))(server.address);
  return {
    buildMarker: ultramodernApiMarker.buildMarker,
    compositionRevision: bootstrap.composition.composition.revision,
    port: address.port,
  };
});
const validateBootstrap = Effect.fn('MediaOrdering.validateBootstrap')(function* validateBootstrap(
  bootstrap: typeof MediaOrderingBootstrapSchema.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const identity = yield* fs
    .readFileString('package.json')
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ name: bounded })))));
  yield* requireCondition(identity.name === '@app/catalog', 'owner-directory');
  yield* requireCondition(
    bootstrap.actor.authenticationNamespaceId === STAFF_AUTHENTICATION_NAMESPACE_ID &&
      ['session', 'api_key'].includes(bootstrap.actor.authMethod) &&
      bootstrap.actor.legalEntityId === undefined &&
      bootstrap.actor.trustedStorefrontId === undefined &&
      bootstrap.actor.impersonatedByPrincipalId === undefined,
    'staff-tenant-scope',
  );
  yield* validateActiveApplicationCompositionSnapshot(bootstrap.composition);
  const module = bootstrap.composition.composition.modules.find(({ deployment }) => deployment.appId === 'catalog');
  yield* requireCondition(
    module?.moduleId === 'commerce.catalog' && module.deployment.buildMarker === ultramodernApiMarker.buildMarker,
    'catalog-composition-build',
  );
  const spice = yield* Schema.decodeEffect(Schema.URLFromString)(`https://${bootstrap.spiceDb.endpoint}`);
  yield* requireCondition(
    ['localhost', '127.0.0.1'].includes(spice.hostname) &&
      spice.pathname === '/' &&
      spice.username === '' &&
      spice.password === '' &&
      spice.search === '' &&
      spice.hash === '',
    'spicedb-loopback',
  );
  yield* guardMediaOwnedDatabase(bootstrap.database);
  yield* checkFixedEnvironment(bootstrap);
});
const privateResponseFailure = () => failure('private-response');
const privateInputFailure = () => failure('private-input');
const makeSendParent = Effect.gen(function* makeSendParent() {
  let failed = false;
  const output = yield* Effect.acquireRelease(
    Effect.try({
      catch: privateResponseFailure,
      try: () => {
        const socket = new Socket({ fd: 3, readable: false, writable: true });
        socket.on('error', () => {
          failed = true;
        });
        return socket;
      },
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );
  const write = promisify((bytes: Uint8Array, onWrite: (error?: Error | null) => void) => {
    output.write(bytes, onWrite);
  });
  return (response: typeof MediaOrderingResponseSchema.Type) =>
    Schema.encodeEffect(Schema.fromJsonString(MediaOrderingResponseSchema))(response).pipe(
      Effect.flatMap((line) =>
        failed
          ? Effect.fail(privateResponseFailure())
          : Effect.tryPromise({
              catch: privateResponseFailure,
              try: async () => await write(Buffer.from(`${line}\n`)),
            }),
      ),
      Effect.mapError(privateResponseFailure),
    );
});
const receiveCommands = Effect.fn('MediaOrdering.receiveCommands')(function* receiveCommands() {
  const queue = yield* Queue.bounded<typeof MediaOrderingCommandSchema.Type | MediaOrderingFixtureUnavailable>(4);
  let bytes = 0;
  const input = yield* Effect.acquireRelease(
    Effect.try({
      catch: privateInputFailure,
      try: () => new Socket({ fd: 4, readable: true, writable: false }),
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );
  yield* NodeStream.fromReadable({
    closeOnDone: false,
    evaluate: () => input,
    onError: privateInputFailure,
  }).pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;
      return requireCondition(bytes <= 65_536, 'private-input-cap').pipe(Effect.as(chunk));
    }),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(MediaOrderingCommandSchema), { onExcessProperty: 'error' })(
        line,
      ),
    ),
    Stream.runForEach((command) => Queue.offer(queue, command)),
    Effect.andThen(Queue.offer(queue, failure('private-eof'))),
    Effect.catch(() => Queue.offer(queue, failure('private-input'))),
    Effect.forkScoped,
  );
  return Queue.take(queue).pipe(
    Effect.flatMap((value) =>
      Schema.is(MediaOrderingFixtureUnavailable)(value) ? Effect.fail(value) : Effect.succeed(value),
    ),
  );
});
const runReceiver = Effect.gen(function* runMediaOrderingReceiver() {
  let stage = 'response-channel';
  yield* Effect.addFinalizer((exit) =>
    Exit.isFailure(exit) ? Effect.logError('CATALOG_MEDIA_RECEIVER_FAILURE', stage, exit.cause) : Effect.void,
  );
  const sendParent = yield* makeSendParent;
  stage = 'command-channel';
  const next = yield* receiveCommands();
  stage = 'bootstrap';
  const bootstrap = yield* next;
  if (bootstrap.type !== 'bootstrap') {
    return yield* failure('bootstrap-order');
  }
  stage = 'bootstrap-validation';
  yield* validateBootstrap(bootstrap).pipe(
    Effect.tapError((error) =>
      Schema.is(MediaOrderingFixtureUnavailable)(error)
        ? Effect.logError('CATALOG_MEDIA_BOOTSTRAP_FAILURE_STAGE', error.stage)
        : Effect.void,
    ),
  );
  stage = 'catalog-migration';
  yield* migrateCatalog(bootstrap);
  stage = 'catalog-migration-reapply';
  const beforeReapply = yield* catalogJournalFingerprint(bootstrap);
  yield* migrateCatalog(bootstrap);
  const afterReapply = yield* catalogJournalFingerprint(bootstrap);
  yield* requireCondition(
    beforeReapply.count === afterReapply.count && beforeReapply.fingerprint === afterReapply.fingerprint,
    'catalog-migration-reapply',
  );
  stage = 'catalog-runtime-grants';
  yield* grantCatalogRuntimeAccess(bootstrap);
  stage = 'catalog-verification';
  yield* verifyCatalog(bootstrap);
  stage = 'catalog-serving';
  const receiver = yield* serveCatalog(bootstrap);
  stage = 'booted-response';
  yield* sendParent({ ...receiver, type: 'BOOTED', version: mediaOrderingProtocol });
  stage = 'stop-command';
  const command = yield* next;
  if (command.type !== 'stop') {
    return yield* failure('stop-order');
  }
  stage = 'stopped-verification';
  yield* verifyCatalog(bootstrap);
  stage = 'stopped-response';
  return yield* sendParent({ type: 'STOPPED', version: mediaOrderingProtocol });
});
if (process.argv.includes('--serve-media-ordering')) {
  NodeRuntime.runMain(
    Effect.scoped(runReceiver).pipe(
      Effect.mapError(() => failure('fixture-unavailable')),
      Effect.provideService(Logger.LogToStderr, true),
      Effect.provide(
        NodeServices.layer.pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(FetchHttpClient.layer)),
      ),
    ),
  );
}
