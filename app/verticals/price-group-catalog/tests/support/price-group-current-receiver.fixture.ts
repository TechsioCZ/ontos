import { Socket } from 'effect/socket';
import { NodeSocket, NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
  parseDatabaseConnectionPair,
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
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { sql } from 'drizzle-orm';
import { Config, Context, DateTime, Effect, FileSystem, Layer, Path, Queue, Redacted, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { createPriceGroupActionApiLive } from '../../api/create-price-group-action-server.ts';
import { priceGroupCatalogOwnerAuthorizationOverlayLive } from '../../api/index.ts';
import { createPriceGroupDefinitionRevisionActionApiLive } from '../../api/create-price-group-definition-revision-action-server.ts';
import { priceGroupDefinitionReadApiLive } from '../../api/price-group-definition-read-server.ts';
import { retirePriceGroupActionApiLive } from '../../api/retire-price-group-action-server.ts';
import { validatePriceGroupCompatibilityReadApiLive } from '../../api/validate-price-group-compatibility-read-server.ts';
import {
  executeCreatePriceGroupDefinitionRevisionWithAuthorization,
  executeCreatePriceGroupWithAuthorization,
  executeRetirePriceGroupWithAuthorization,
} from '../../src/api/price-group-catalog-client.ts';
import { PriceGroupCatalogDatabase, PriceGroupCatalogDatabaseLive } from '../../src/database/client.ts';
import { CreatePriceGroupPayloadSchema } from '../../shared/actions/create-price-group.ts';
import { CreatePriceGroupDefinitionRevisionPayloadSchema } from '../../shared/actions/create-price-group-definition-revision.ts';
import { RetirePriceGroupPayloadSchema } from '../../shared/actions/retire-price-group.ts';
import { priceGroupCatalogApi } from '../../shared/api.ts';
import {
  PriceGroupCreatedResultSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupRetirementAcceptanceSchema,
} from '../../shared/domain/price-group.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { priceGroupPrivateLines } from './price-group-private-lines.ts';

// Executable owner fixture only. No exports, foreign private imports, signing capability,
// arbitrary payload, executor, callback, or permission mutation crosses this protocol.
const version = 'ontos.price-group-current.fixture.v1' as const;
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const secret = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)));
const strict = { parseOptions: { onExcessProperty: 'error' as const } };
const DatabaseCertificateSchema = Schema.Struct({
  adminRole: text,
  adminUrl: secret,
  name: Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f0-9]{32}$/u)),
  oid: positive,
  owner: text,
  runtimeRole: text,
  runtimeUrl: secret,
  serverAddress: text,
  serverPort: positive,
}).annotate(strict);
const BootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  composition: ActiveApplicationCompositionSnapshotSchema,
  database: DatabaseCertificateSchema,
  issuer: text,
  jwks: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  spiceDb: Schema.Struct({
    caCertificate: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    endpoint: text,
    token: secret,
  }).annotate(strict),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(version),
}).annotate(strict);
const MutationCommandSchema = Schema.Struct({
  authorization: secret,
  requestId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PriceGroupCurrentFixtureRequestId')),
  type: Schema.Literals(['CREATE_G1', 'CREATE_G2', 'CREATE_INCOMPATIBLE', 'RETIRE_G2', 'REVISE_G2']),
  version: Schema.Literal(version),
}).annotate(strict);
const StopSchema = Schema.Struct({ type: Schema.Literal('stop'), version: Schema.Literal(version) }).annotate(strict);
const CommandSchema = Schema.Union([BootstrapSchema, MutationCommandSchema, StopSchema]);
const ResponseSchema = Schema.Union([
  Schema.Struct({
    code: Schema.optionalKey(
      Schema.Literals([
        'action_invocation_persistence_failed',
        'action_permission_check_failed',
        'action_policy_evaluation_failed',
        'action_transaction_failed',
        'price_group_persistence_unavailable',
        'module_state_check_unavailable',
        'operation_context_unavailable',
      ]),
    ),
    stage: Schema.Literals([
      'CREATE_INVALID',
      'CREATE_AUTHENTICATION',
      'CREATE_FORBIDDEN',
      'CREATE_CONFLICT',
      'CREATE_UNAVAILABLE',
      'CREATE_INTERNAL',
      'CREATE_DECODE',
    ]),
    type: Schema.Literal('FAILED'),
    version: Schema.Literal(version),
  }),
  Schema.Struct({
    buildMarker: text,
    compositionRevision: text,
    port: positive,
    type: Schema.Literal('BOOTED'),
    version: Schema.Literal(version),
  }),
  Schema.Struct({
    result: PriceGroupCreatedResultSchema,
    type: Schema.Literals(['CREATED_G1', 'CREATED_G2', 'CREATED_INCOMPATIBLE']),
    version: Schema.Literal(version),
  }),
  Schema.Struct({
    result: PriceGroupDefinitionRevisionSchema,
    type: Schema.Literal('REVISED_G2'),
    version: Schema.Literal(version),
  }),
  Schema.Struct({
    result: PriceGroupRetirementAcceptanceSchema,
    type: Schema.Literal('RETIRED_G2'),
    version: Schema.Literal(version),
  }),
  Schema.Struct({ type: Schema.Literal('STOPPED'), version: Schema.Literal(version) }),
]);
class PriceGroupCurrentFixtureFailure extends Schema.TaggedError<PriceGroupCurrentFixtureFailure>()(
  'PriceGroupCurrentFixtureFailure',
  { stage: Schema.String },
) {}
const fail = (stage: string) => new PriceGroupCurrentFixtureFailure({ stage });
const demand = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(fail(stage)));
const connectParent = Effect.gen(function* connectParent() {
  const socketPath = yield* Config.String('ONTOS_PRICE_GROUP_TEMPORAL_SOCKET');
  // The parent names the socket under the resolved /tmp (/private/tmp on macOS).
  const temporaryRoot = yield* (yield* FileSystem.FileSystem).realPath('/tmp');
  yield* demand(
    socketPath.startsWith(`${temporaryRoot}/`) &&
      /^\/pg1248-[a-zA-Z0-9_-]+\/owner\.sock$/u.test(socketPath.slice(temporaryRoot.length)),
    'private-socket-path',
  );
  const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
  const pull = yield* Socket.readerBytes(socket);
  const writer = yield* socket.writer;
  return {
    pull,
    send: (response: typeof ResponseSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(ResponseSchema))(response).pipe(
        Effect.flatMap((line) => writer.write(`${line}\n`)),
      ),
  };
});

const guardOwnedDatabase = Effect.fn('PriceGroupCurrentFixture.guardOwnedDatabase')(function* guardOwnedDatabase(
  bootstrap: typeof BootstrapSchema.Type,
) {
  const certificate = bootstrap.database;
  const connections = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(certificate.adminUrl),
    DATABASE_URL: Redacted.value(certificate.runtimeUrl),
  }).pipe(Effect.mapError(() => fail('database-configuration')));
  yield* demand(
    connections.admin.database === certificate.name &&
      connections.runtime.database === certificate.name &&
      connections.admin.host === connections.runtime.host &&
      connections.admin.port === connections.runtime.port &&
      ['127.0.0.1', 'localhost'].includes(connections.admin.host) &&
      connections.admin.user === certificate.adminRole &&
      connections.runtime.user === certificate.runtimeRole &&
      certificate.adminRole !== certificate.runtimeRole &&
      certificate.owner === certificate.adminRole,
    'owned-address-certificate',
  );
  for (const [role, configuration] of [
    ['admin', connections.admin],
    ['runtime', connections.runtime],
  ] as const) {
    const databaseContext = yield* Layer.build(
      PriceGroupCatalogDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
    ).pipe(Effect.mapError(() => fail('database-identity-connect')));
    const database = Context.get(databaseContext, PriceGroupCatalogDatabase);
    const identity = yield* database.executor
      .execute<{
        readonly bypass_rls: boolean;
        readonly database_name: string;
        readonly database_oid: number;
        readonly database_owner: string;
        readonly effective_role: string;
        readonly server_address: string;
        readonly server_port: number;
        readonly session_role: string;
        readonly superuser: boolean;
      }>(
        sql`select current_database() as database_name, d.oid::int as database_oid,
        pg_get_userbyid(d.datdba) as database_owner, session_user::text as session_role,
        current_user::text as effective_role, inet_server_addr()::text as server_address,
        inet_server_port() as server_port, r.rolsuper as superuser, r.rolbypassrls as bypass_rls
        from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`,
        'objects',
      )
      .pipe(Effect.mapError(() => fail('database-identity-read')));
    const [actual] = identity;
    const expectedRole = role === 'admin' ? certificate.adminRole : certificate.runtimeRole;
    yield* demand(identity.length === 1 && actual !== undefined, 'owned-database-identity-count');
    if (actual === undefined) {
      return yield* fail('owned-database-identity-count');
    }
    yield* demand(
      actual.database_name === certificate.name &&
        actual.database_oid === certificate.oid &&
        actual.database_owner === certificate.owner,
      'owned-database-certificate',
    );
    yield* demand(
      actual.session_role === expectedRole &&
        actual.effective_role === expectedRole &&
        actual.server_address === certificate.serverAddress &&
        actual.server_port === certificate.serverPort,
      'owned-database-role-endpoint',
    );
    if (role === 'runtime') {
      yield* demand(!actual.superuser && !actual.bypass_rls, 'runtime-rls-role');
    }
  }
  return connections;
});

const migrateOwner = Effect.fn('PriceGroupCurrentFixture.migrateOwner')(function* migrateOwner(
  bootstrap: typeof BootstrapSchema.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.resolve(process.cwd());
  const packageIdentity = yield* fs.readFileString(path.join(directory, 'package.json')).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))),
    Effect.mapError(() => fail('owner-package')),
  );
  yield* demand(packageIdentity.name === '@app/price-group-catalog', 'owner-package');
  const migration = yield* ChildProcess.make(
    process.execPath,
    [path.join(directory, 'node_modules/drizzle-kit/bin.cjs'), 'migrate', '--config', 'drizzle.config.ts'],
    {
      cwd: directory,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
        DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  ).pipe(Effect.mapError(() => fail('owner-migration-start')));
  const [exit] = yield* Effect.all(
    [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
    { concurrency: 3 },
  ).pipe(
    Effect.mapError(() => fail('owner-migration')),
    Effect.timeoutOrElse({ duration: '30 seconds', orElse: () => Effect.fail(fail('owner-migration-timeout')) }),
  );
  yield* demand(exit === 0, 'owner-migration-exit');
});

const serveOwner = Effect.fn('PriceGroupCurrentFixture.serveOwner')(function* serveOwner(
  bootstrap: typeof BootstrapSchema.Type,
) {
  yield* demand(
    bootstrap.actor.authenticationNamespaceId === STAFF_AUTHENTICATION_NAMESPACE_ID &&
      ['session', 'api_key'].includes(bootstrap.actor.authMethod) &&
      bootstrap.actor.legalEntityId === undefined &&
      bootstrap.actor.trustedStorefrontId === undefined &&
      bootstrap.actor.impersonatedByPrincipalId === undefined,
    'isolated-staff-tenant-context',
  );
  const connections = yield* guardOwnedDatabase(bootstrap);
  const spiceEndpoint = yield* Schema.decodeEffect(Schema.URLFromString)(`https://${bootstrap.spiceDb.endpoint}`).pipe(
    Effect.mapError(() => fail('spicedb-address')),
  );
  yield* demand(
    ['localhost', '127.0.0.1'].includes(spiceEndpoint.hostname) &&
      spiceEndpoint.pathname === '/' &&
      spiceEndpoint.username === '' &&
      spiceEndpoint.password === '' &&
      spiceEndpoint.search === '' &&
      spiceEndpoint.hash === '',
    'spicedb-loopback',
  );
  // The parent validates the owned handle before launching with this closed environment.
  // Verify the same immutable configuration again before migrations or runtime acquisition.
  yield* Config.schema(Schema.Literal('/dev/null'), 'APP_ENV_PATH');
  const fixed = yield* Effect.all({
    database: Config.Redacted('DATABASE_URL'),
    issuer: Config.String('ONTOS_GATEWAY_ISSUER'),
    jwks: Config.String('ONTOS_GATEWAY_PUBLIC_JWKS'),
    spiceEndpoint: Config.String('SPICEDB_ENDPOINT'),
    spiceToken: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  yield* demand(
    Redacted.value(fixed.database) === connections.runtime.connectionString &&
      fixed.issuer === bootstrap.issuer &&
      fixed.jwks === bootstrap.jwks &&
      fixed.spiceEndpoint === bootstrap.spiceDb.endpoint &&
      Redacted.value(fixed.spiceToken) === Redacted.value(bootstrap.spiceDb.token),
    'captured-runtime-configuration',
  );
  const fixedCa = yield* Config.String('SPICEDB_CA_CERT').pipe(Config.withDefault(''));
  yield* demand(fixedCa === (bootstrap.spiceDb.caCertificate ?? ''), 'captured-spicedb-ca');
  yield* migrateOwner(bootstrap);
  const databaseConfig = Layer.succeed(DatabaseConfig, connections.runtime);
  const persistence = CorePersistenceLive.pipe(Layer.provide(databaseConfig));
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
  const gate = ModuleStateGateLive.pipe(Layer.provide(states));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
  const scopes = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
  const namespace = staffAuthenticationNamespaceRegistryLayer(['price-group-catalog']);
  const composition = makeActiveApplicationCompositionLayer(Effect.succeed(bootstrap.composition));
  const common = Layer.mergeAll(
    persistence,
    ContextAccessLive,
    gate,
    gateway,
    scopes,
    namespace,
    composition,
    priceGroupCatalogOwnerAuthorizationOverlayLive,
  );
  const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(Layer.mergeAll(common, ActionRepositoryLive, ActionPermissionLive)),
    Layer.provide(NodeCrypto.layer),
  );
  const reads = ReadRuntimeLive.pipe(Layer.provide(common), Layer.provide(NodeCrypto.layer));
  const encodedComposition = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(bootstrap.composition);
  const source = Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(encodedComposition) });
  const redemption = GatewayAssertionRedemptionLive.pipe(
    Layer.provide(GatewayAssertionRedemptionDatabaseLive),
    Layer.provide(databaseConfig),
  );
  const handlers = Layer.mergeAll(
    createPriceGroupActionApiLive,
    createPriceGroupDefinitionRevisionActionApiLive,
    retirePriceGroupActionApiLive,
    priceGroupDefinitionReadApiLive,
    validatePriceGroupCompatibilityReadApiLive,
  ).pipe(
    Layer.provide(ActionPrincipalVerifierLive.pipe(Layer.provide(actions))),
    Layer.provide(Layer.mergeAll(actions, reads, namespace, redemption, source, RequestSchemaProblemLive)),
    Layer.provide(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(
          HttpApi.make('PriceGroupCatalogApi')
            .add(priceGroupCatalogApi.groups.createPriceGroupAction)
            .add(priceGroupCatalogApi.groups.createPriceGroupDefinitionRevisionAction)
            .add(priceGroupCatalogApi.groups.retirePriceGroupAction)
            .add(priceGroupCatalogApi.groups.priceGroupDefinition)
            .add(priceGroupCatalogApi.groups.validatePriceGroupCompatibility)
            .annotateMerge(priceGroupCatalogApi.annotations),
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
    (value) => Effect.promise(async () => await value.dispose()).pipe(Effect.orDie),
  );
  const context = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(context, HttpServer.HttpServer);
  const emptyContext = Context.makeUnsafe<unknown>(new Map());
  yield* server.serve(
    Effect.gen(function* forwardOwnerRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: () => fail('owner-http'),
        try: async () => await app.handler(web, emptyContext),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: positive }))(server.address);
  return { compositionRevision: bootstrap.composition.composition.revision, port: address.port };
});

const program = Effect.gen(function* priceGroupCurrentChild() {
  const { pull, send } = yield* connectParent;
  const commands = yield* Queue.bounded<typeof CommandSchema.Type | PriceGroupCurrentFixtureFailure>(8);
  yield* Stream.fromPull(Effect.succeed(pull)).pipe(
    priceGroupPrivateLines,
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(CommandSchema), {
        onExcessProperty: 'error',
      })(line),
    ),
    Stream.runForEach((command) => Queue.offer(commands, command)),
    Effect.andThen(Queue.offer(commands, fail('private-input-ended'))),
    Effect.catch(() => Queue.offer(commands, fail('private-input'))),
    Effect.forkScoped,
  );
  const next = Queue.take(commands).pipe(
    Effect.flatMap((item) =>
      Schema.is(PriceGroupCurrentFixtureFailure)(item) ? Effect.fail(item) : Effect.succeed(item),
    ),
  );
  const bootstrap = yield* next;
  if (bootstrap.type !== 'bootstrap') {
    return yield* fail('bootstrap-order');
  }
  const receiver = yield* serveOwner(bootstrap);
  yield* send({ ...receiver, buildMarker: ultramodernApiMarker.buildMarker, type: 'BOOTED', version });
  const options = (command: typeof MutationCommandSchema.Type) => ({
    baseUrl: `http://127.0.0.1:${receiver.port}`,
    compositionRevision: receiver.compositionRevision,
    idempotencyKey: command.requestId,
  });
  let first: typeof PriceGroupCreatedResultSchema.Type | undefined;
  let second: typeof PriceGroupCreatedResultSchema.Type | undefined;
  let incompatible: typeof PriceGroupCreatedResultSchema.Type | undefined;
  let secondRevision: typeof PriceGroupDefinitionRevisionSchema.Type | undefined;
  let catalogRevision = 0;
  let retired = false;
  const createGroup = Effect.fn('PriceGroupCurrentFixture.createGroup')(function* createGroup(
    command: typeof MutationCommandSchema.Type,
  ) {
    if (command.type === 'RETIRE_G2' || command.type === 'REVISE_G2') {
      return yield* fail('create-command');
    }
    const authorization = Redacted.value(command.authorization);
    yield* demand(
      (command.type === 'CREATE_G1' && first === undefined && catalogRevision === 0) ||
        (command.type === 'CREATE_G2' && first !== undefined && second === undefined) ||
        (command.type === 'CREATE_INCOMPATIBLE' && second !== undefined && incompatible === undefined),
      'create-order',
    );
    const suffix = ({ CREATE_G1: 'G1', CREATE_G2: 'G2', CREATE_INCOMPATIBLE: 'G3' } as const)[command.type];
    const now = yield* DateTime.now;
    const effectiveFrom = DateTime.formatIso(DateTime.add(now, { seconds: 5 }));
    const payload = yield* Schema.decodeUnknownEffect(CreatePriceGroupPayloadSchema)({
      businessCode: `STABILIZATION_1248_${suffix}`,
      classificationPurpose: `TEST #1248 native temporal receiver ${suffix}`,
      compatibilityContracts: [
        {
          contractId:
            suffix === 'G3' ? 'test.stabilization-1248.incompatible.v1' : 'commerce.customer-price-group-assignment.v1',
          version: 1,
        },
      ],
      description: `Owned #1248 public producer ${suffix}`,
      displayName: `Temporal assignment ${suffix}`,
      effectiveFrom,
      effectiveTo: null,
      expectedCatalogRevision: catalogRevision,
      reason: 'TEST #1248 create genuine owner Catalog truth',
    });
    const result = yield* executeCreatePriceGroupWithAuthorization(
      payload,
      authorization,
      command.requestId,
      options(command),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PriceGroupCreatedResultSchema)));
    catalogRevision = result.acceptance.acceptedCatalogRevision;
    if (command.type === 'CREATE_G1') {
      first = result;
    } else if (command.type === 'CREATE_G2') {
      second = result;
      secondRevision = result.initialDefinition;
    } else {
      incompatible = result;
    }
    yield* send({
      result,
      type: ({ G1: 'CREATED_G1', G2: 'CREATED_G2', G3: 'CREATED_INCOMPATIBLE' } as const)[suffix],
      version,
    });
    return yield* Effect.void;
  });
  while (true) {
    const command = yield* next;
    if (command.type === 'stop') {
      yield* send({ type: 'STOPPED', version });
      return yield* Effect.void;
    }
    if (command.type === 'bootstrap') {
      return yield* fail('duplicate-bootstrap');
    }
    const authorization = Redacted.value(command.authorization);
    if (command.type === 'CREATE_G1' || command.type === 'CREATE_G2' || command.type === 'CREATE_INCOMPATIBLE') {
      yield* createGroup(command).pipe(
        Effect.catchTags({
          CreatePriceGroupActionAuthenticationProblem: () =>
            send({ stage: 'CREATE_AUTHENTICATION', type: 'FAILED', version }),
          CreatePriceGroupActionConflictProblem: () => send({ stage: 'CREATE_CONFLICT', type: 'FAILED', version }),
          CreatePriceGroupActionForbiddenProblem: () => send({ stage: 'CREATE_FORBIDDEN', type: 'FAILED', version }),
          CreatePriceGroupActionInternalProblem: () => send({ stage: 'CREATE_INTERNAL', type: 'FAILED', version }),
          CreatePriceGroupActionInvalidProblem: () => send({ stage: 'CREATE_INVALID', type: 'FAILED', version }),
          CreatePriceGroupActionUnavailableProblem: (error) =>
            send({ code: error.code, stage: 'CREATE_UNAVAILABLE', type: 'FAILED', version }),
          SchemaError: () => send({ stage: 'CREATE_DECODE', type: 'FAILED', version }),
        }),
      );
      continue;
    }
    if (second === undefined || secondRevision === undefined || retired) {
      return yield* fail('mutation-order');
    }
    const expectedCurrent = {
      catalogRevision: secondRevision.acceptedCatalogRevision,
      definitionRevisionId: secondRevision.definitionRevisionId,
      definitionRevisionNumber: secondRevision.revisionNumber,
      meaningFingerprint: secondRevision.meaningFingerprint,
      priceGroupRef: second.identity.priceGroupRef,
    };
    const now = yield* DateTime.now;
    const effectiveAt = DateTime.formatIso(DateTime.add(now, { seconds: 2 }));
    if (command.type === 'REVISE_G2') {
      const payload = yield* Schema.decodeUnknownEffect(CreatePriceGroupDefinitionRevisionPayloadSchema)({
        classificationPurpose: secondRevision.classificationPurpose,
        compatibilityContracts: secondRevision.compatibilityContracts,
        description: secondRevision.description,
        displayName: 'Temporal assignment G2 revised display',
        effectiveFrom: effectiveAt,
        effectiveTo: null,
        expectedCurrent,
        reason: 'TEST #1248 change real Catalog generation without changing meaning',
        semanticDecision: {
          comparedDefinitionRevisionId: secondRevision.definitionRevisionId,
          decision: 'SAME_MEANING',
        },
      });
      const result = yield* executeCreatePriceGroupDefinitionRevisionWithAuthorization(
        payload,
        authorization,
        command.requestId,
        options(command),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PriceGroupDefinitionRevisionSchema)));
      secondRevision = result;
      catalogRevision = result.acceptedCatalogRevision;
      yield* send({ result, type: 'REVISED_G2', version });
    } else {
      const payload = yield* Schema.decodeUnknownEffect(RetirePriceGroupPayloadSchema)({
        effectiveAt,
        expectedCurrent,
        reason: 'TEST #1248 retire real owner Catalog identity',
      });
      const result = yield* executeRetirePriceGroupWithAuthorization(
        payload,
        authorization,
        command.requestId,
        options(command),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PriceGroupRetirementAcceptanceSchema)));
      catalogRevision = result.acceptedCatalogRevision;
      retired = true;
      yield* send({ result, type: 'RETIRED_G2', version });
    }
  }
});

const services = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const describe = Effect.sync(() =>
  process.stdout.write(
    `${JSON.stringify({
      actionKeys: [
        'pricing.price-group-catalog.create-price-group',
        'pricing.price-group-catalog.create-price-group-definition-revision',
        'pricing.price-group-catalog.retire-price-group',
      ],
      appId: 'price-group-catalog',
      buildMarker: ultramodernApiMarker.buildMarker,
      type: 'description',
      version,
    })}\n`,
  ),
);
const runnable = process.argv.includes('--describe')
  ? describe
  : Effect.scoped(program).pipe(Effect.mapError(() => fail('fixture-unavailable')));
NodeRuntime.runMain(runnable.pipe(Effect.provide(services)));
