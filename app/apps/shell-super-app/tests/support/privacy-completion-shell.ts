// TEST infrastructure: only this child owns Shell authentication implementation.
import {
  ActiveApplicationCompositionSnapshotSchema,
  bindSelfApiKeyAction,
  changeTenantModuleStateAction,
  ContextAccess,
  CorePersistenceLive,
  DatabaseConfigLive,
  InstalledModuleCatalogService,
  makeContextAccessLive,
  PrincipalResolverLive,
  runAction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  makeLiveOperationFixtureRuntime,
  LiveOperationFixtureBootstrapRequestSchema,
  LiveOperationFixtureBootstrapResponseSchema,
} from '@app/core-runtime/testing/actions';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices, NodeSocket } from '@effect/platform-node';
import { Config, Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { PgClient } from '@effect/sql-pg';
import { Socket } from 'effect/socket';
import { Reactivity } from 'effect/reactivity';

import apiRuntime from '../../api/index.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
import { makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import {
  loadPrivacyCompletionResponseSocket,
  PrivacyCompletionReadySchema,
  privacyCompletionResponseEnvironment,
  privacyCompletionResponseTransport,
  sendPrivacyCompletionResponse,
} from './privacy-completion-response.ts';

class PrivacyCompletionShellFailure extends Schema.TaggedError<PrivacyCompletionShellFailure>()(
  'PrivacyCompletionShellFailure',
  { reason: Schema.String },
) {}
const partyModule = 'party.registry';

const requestCreatorBootstrap = Effect.fn('PrivacyCompletionShell.requestBootstrap')(function* requestCreatorBootstrap(
  socketPath: string,
  providerSubjectId: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* exchangeBootstrap() {
      const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      const request = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(LiveOperationFixtureBootstrapRequestSchema),
      )({
        providerSubjectId,
        type: 'auth-user-created',
      });
      yield* writer.write(`${request}\n`);
      let response = '';
      while (!response.includes('\n')) {
        response += (yield* pull).join('');
        if (new TextEncoder().encode(response).length > 65_536) {
          return yield* new PrivacyCompletionShellFailure({ reason: 'Creator bootstrap exceeds its protocol bound' });
        }
      }
      if (!response.endsWith('\n') || response.indexOf('\n') !== response.length - 1) {
        return yield* new PrivacyCompletionShellFailure({ reason: 'Creator bootstrap requires one response' });
      }
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LiveOperationFixtureBootstrapResponseSchema), {
        onExcessProperty: 'error',
      })(response.trimEnd());
    }),
  ).pipe(
    Effect.mapError(
      () => new PrivacyCompletionShellFailure({ reason: 'Creator-owned fixture bootstrap is unavailable' }),
    ),
  );
});

interface AdditionalLegalEntityFixtureConfiguration {
  readonly additionalLegalEntity?: 'same-tenant';
}
const serve = Effect.scoped(
  Effect.gen(function* completionShell() {
    const responseSocket = yield* loadPrivacyCompletionResponseSocket();
    const unexpectedAdmin = yield* Config.Redacted('DATABASE_ADMIN_URL').pipe(Config.option);
    const additionalLegalEntity = yield* Config.schema(
      Schema.Literals(['none', 'same-tenant']),
      'ONTOS_1258_TEST_ADDITIONAL_LE',
    );
    const additionalLegalEntityConfiguration: AdditionalLegalEntityFixtureConfiguration = {};
    if (additionalLegalEntity === 'same-tenant') {
      Object.assign(additionalLegalEntityConfiguration, { additionalLegalEntity });
    }
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const composition = yield* Config.schema(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
      'ONTOS_1258_TEST_COMPOSITION',
    );
    const configuration = yield* loadAuthConfig({ envPath: '/dev/null' });
    const expectedDatabase = yield* Config.String('ONTOS_1258_TEST_DATABASE');
    const expectedUser = yield* Config.String('ONTOS_1258_TEST_RUNTIME');
    const databaseAddress = new URL(configuration.connectionString);
    if (
      !expectedDatabase.startsWith('ontos_test_party_gateway_') ||
      !['postgres:', 'postgresql:'].includes(databaseAddress.protocol) ||
      !['localhost', '127.0.0.1'].includes(databaseAddress.hostname) ||
      databaseAddress.search !== '' ||
      databaseAddress.hash !== '' ||
      databaseAddress.pathname !== `/${expectedDatabase}` ||
      decodeURIComponent(databaseAddress.username) !== expectedUser ||
      Option.isSome(unexpectedAdmin)
    ) {
      return yield* new PrivacyCompletionShellFailure({ reason: 'Shell test bootstrap requires its owned database' });
    }
    const reactivity = yield* Reactivity.make;
    const native = yield* PgClient.make({ maxConnections: 1, url: Redacted.make(configuration.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(
        () => new PrivacyCompletionShellFailure({ reason: 'Fixture native identity connection is unavailable' }),
      ),
    );
    const rows = yield* native`select current_database() as database, current_user as role,
      session_user as session, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname=current_user`.pipe(
      Effect.mapError(() => new PrivacyCompletionShellFailure({ reason: 'Fixture native identity is unavailable' })),
    );
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          database: Schema.String,
          rolbypassrls: Schema.Boolean,
          rolcreatedb: Schema.Boolean,
          rolcreaterole: Schema.Boolean,
          role: Schema.String,
          rolsuper: Schema.Boolean,
          session: Schema.String,
        }),
      ),
    )(rows).pipe(
      Effect.mapError(() => new PrivacyCompletionShellFailure({ reason: 'Fixture native identity is invalid' })),
    );
    const valid =
      row?.database === expectedDatabase &&
      row.role === expectedUser &&
      row.session === expectedUser &&
      !row.rolsuper &&
      !row.rolbypassrls &&
      !row.rolcreaterole &&
      !row.rolcreatedb;
    if (!valid) {
      return yield* new PrivacyCompletionShellFailure({ reason: 'Shell native runtime identity was refused' });
    }
    const database = yield* makeAuthDatabase(configuration);
    const resolver = yield* Layer.build(
      PrincipalResolverLive({
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      }).pipe(Layer.provide(CorePersistenceLive), Layer.provide(DatabaseConfigLive)),
    );
    const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, database),
      Effect.provideContext(resolver),
    );
    const email = `privacy-completion-${suffix}@example.test`;
    const password = `privacy-completion-${suffix}`;
    const providerSubjectId = yield* authentication.createFixtureUser(email, 'Privacy completion test', password);
    const prepared = yield* requestCreatorBootstrap(responseSocket, providerSubjectId);
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixtureRuntime({
        configuration: {
          ...additionalLegalEntityConfiguration,
          actionKeys: [
            bindSelfApiKeyAction.descriptor.actionKey,
            changeTenantModuleStateAction.descriptor.actionKey,
            'privacy.core.dispatch-privacy-measure',
            'privacy.core.record-owner-execution-outcome',
            'party.registry.execute-privacy-measure',
          ],
          allowedAudiences: ['party-registry', 'privacy'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          // The real module-state setup Action requires tenant manage_identity.
          managerIdentityAdmin: true,
          managerProviderSubjectId: providerSubjectId,
          moduleKeys: [partyModule, 'privacy.core'],
        },
        handoff: prepared.handoff,
        runtimeConnectionString: Redacted.make(configuration.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    );
    const fixtureContext = yield* Layer.build(fixture.layer);
    const signedIn = yield* authentication.signIn(email, password, new Headers({ origin: configuration.baseUrl }));
    const headers = new Headers({
      cookie: signedIn.setCookieHeaders.map((value) => value.split(';')[0]).join('; '),
      origin: configuration.baseUrl,
    });
    const access = yield* makeContextAccessLive();
    const resolved = yield* authentication
      .resolveTenantContext(headers)
      .pipe(Effect.provideService(ContextAccess, access));
    if (resolved.state !== 'authenticated') {
      return yield* new PrivacyCompletionShellFailure({ reason: 'The real fixture staff session did not resolve' });
    }
    const keys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, database),
    );
    const pending = yield* keys.issue(headers, {
      issuerPrincipalId: resolved.principal.principalId,
      lifecycleOperationId: yield* crypto.randomUUIDv4(),
      name: 'Privacy completion test',
      tenantId: fixture.tenantId,
    });
    // Fixture setup only; acceptance dispatch/report never uses this fixture Action layer.
    yield* runAction({
      payload: yield* Schema.decodeEffect(bindSelfApiKeyAction.descriptor.payloadSchema)({
        providerSubjectId: pending.providerKeyId,
      }),
      principal: resolved.principal,
      registration: bindSelfApiKeyAction,
      transport: { correlationId: suffix, idempotencyKey: suffix, targetModuleKey: 'core.identity' },
    }).pipe(Effect.provideContext(fixtureContext));
    yield* keys.clearPendingCleanup(pending.providerKeyId);
    const principal = { ...resolved.principal, legalEntityId: fixture.legalEntityId };
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(composition));
    const changePartyState = (newState: 'active' | 'inactive') =>
      Effect.gen(function* changePartyFixtureState() {
        yield* runAction({
          payload: yield* Schema.decodeEffect(changeTenantModuleStateAction.descriptor.payloadSchema)({
            moduleKey: partyModule,
            newState,
          }),
          principal: resolved.principal,
          registration: changeTenantModuleStateAction,
          transport: {
            correlationId: yield* crypto.randomUUIDv4(),
            idempotencyKey: yield* crypto.randomUUIDv4(),
            targetModuleKey: 'core.modules',
          },
        }).pipe(
          Effect.provideContext(fixtureContext),
          Effect.provideService(InstalledModuleCatalogService, { load: Effect.succeed(catalog) }),
        );
      });
    const changePartyRead = (operation: 'grant' | 'revoke') =>
      fixture.changeManagerModuleAccess(partyModule, operation);
    yield* changePartyRead('grant');
    yield* Effect.addFinalizer(() => changePartyRead('revoke').pipe(Effect.orDie));
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => apiRuntime.createHandler()),
      (value) => Effect.promise(value.dispose.bind(value)),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* shellRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === 'POST' && request.url === '/__1258/deactivate-party') {
          yield* changePartyState('inactive');
          return HttpServerResponse.empty();
        }
        if (request.method === 'POST' && request.url === '/__1258/activate-party') {
          yield* changePartyState('active');
          return HttpServerResponse.empty();
        }
        if (request.method === 'POST' && request.url === '/__1258/revoke-party-read') {
          yield* changePartyRead('revoke');
          return HttpServerResponse.empty();
        }
        if (request.method === 'POST' && request.url === '/__1258/grant-party-read') {
          yield* changePartyRead('grant');
          return HttpServerResponse.empty();
        }
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => new PrivacyCompletionShellFailure({ reason: 'Shell HTTP adapter failed' }),
          try: app.handler.bind(app, webRequest, undefined),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new PrivacyCompletionShellFailure({ reason: 'A loopback Shell TCP address is required' });
    }
    // fd3 is a private parent-owned credential pipe, never stdout or diagnostic readiness.
    const wirePrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(principal);
    const ready = yield* Schema.decodeUnknownEffect(PrivacyCompletionReadySchema)({
      apiKey: Redacted.value(pending.secret),
      legalEntityId: fixture.legalEntityId,
      marker: ultramodernDeliveryUnit,
      port: address.port,
      principal: wirePrincipal,
      protocolVersion: 2,
      responseTransport: privacyCompletionResponseTransport,
      tenantId: fixture.tenantId,
      type: 'ready',
    }).pipe(
      Effect.mapError(() => new PrivacyCompletionShellFailure({ reason: 'Private fixture readiness is invalid' })),
    );
    yield* sendPrivacyCompletionResponse(responseSocket, ready);
    return yield* Effect.never;
  }),
);

const describe = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
  marker: ultramodernDeliveryUnit,
  protocolVersion: 2,
  responseSocketEnvironment: privacyCompletionResponseEnvironment,
  responseTransport: privacyCompletionResponseTransport,
}).pipe(Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))));
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* completionProcessEntry() {
      if (process.argv.includes('--describe')) {
        return yield* describe;
      }
      const services = yield* Layer.build(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeCrypto.layer, NodeServices.layer),
      );
      return yield* serve.pipe(Effect.provideContext(services));
    }),
  ),
);
