// TEST infrastructure: only this child owns Shell authentication implementation.
import {
  ActiveApplicationCompositionSnapshotSchema,
  bindManagedApiKeyAction,
  bindSelfApiKeyAction,
  changeTenantModuleStateAction,
  CorePersistenceLive,
  createNonHumanPrincipalAction,
  DatabaseConfigLive,
  InstalledModuleCatalogService,
  OAuthAuthenticationAuditLive,
  OAuthGrantRegistryLive,
  PrincipalResolverLive,
  runAction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  makeLiveOperationFixtureRuntime,
  LiveOperationFixtureBootstrapRequestSchema,
  LiveOperationFixtureBootstrapResponseSchema,
} from '@app/core-runtime/testing/actions';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices, NodeSocket } from '@effect/platform-node';
import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { Config, Console, Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { PgClient } from '@effect/sql-pg';
import { Socket } from 'effect/socket';
import { Reactivity } from 'effect/reactivity';

import { makeShellAuthenticationApiRuntime, shellProductionRuntimeArguments } from '../../api/index.ts';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { BetterAuthFrameworkLive } from '../../api/auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from '../../api/auth/better-auth-runtime.ts';
import { AuthDatabase, BetterAuthNativeAdapterLive, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import { OAuthEndpointGuardsLive } from '../../api/auth/oauth-server/endpoint-guards.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
import { OAuthConnectionHooksLive } from '../../api/oauth-connections/better-auth-hooks.ts';
import { OAuthEndpointGuardDataLive } from '../../api/oauth-connections/grant-store.ts';
import { ApiKeyService, makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { moduleCredentialReleaseOf } from '../../api/auth/module-credential-attestation.ts';
import type { ModuleCredentialRelease } from '../../api/auth/module-credential-attestation.ts';
import { provisionModuleCredentials } from '../../api/auth/module-credential-provisioning.service.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { createShellRuntimeContract } from '../../../../scripts/ontos-shell-runtime-contract.ts';
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
const partyAppId = 'party-registry';

// Only fixed stage names cross stderr: bootstrap failures may carry private credentials in their causes.
const startupStage = (stage: 'create-user' | 'creator-bootstrap' | 'fixture-runtime' | 'module-credential' | 'serve') =>
  Effect.tapCause(() => Console.error(`privacy-completion-shell:${stage}`));

/** Party Registry's module credential, provisioned through the platform's own program. */
const partyModuleCredential = Effect.fn('PrivacyCompletionShell.partyModuleCredential')(function* partyModuleCredential(
  crypto: Crypto.Crypto,
  release: ModuleCredentialRelease,
) {
  const provisioned = yield* provisionModuleCredentials({
    appIds: [partyAppId],
    bootId: yield* crypto.randomUUIDv4(),
    hostId: 'privacy-completion-shell',
    operationId: yield* crypto.randomUUIDv4(),
    release,
  });
  const secret = provisioned.credentials.get(partyAppId);
  const [providerKeyId] = provisioned.providerKeyIds;
  if (secret === undefined || providerKeyId === undefined) {
    return yield* new PrivacyCompletionShellFailure({ reason: 'Party module credential is unavailable' });
  }
  return { providerKeyId, secret };
});

/** Mounts the production Shell API; it derives its module bindings from the platform's enrolment. */
const mountShellApiHandler = Effect.fn('PrivacyCompletionShell.mountShellApiHandler')(function* mountShellApiHandler(
  accessGate: Layer.Layer<AccessDecisionGate>,
) {
  const runtime = makeShellAuthenticationApiRuntime(...shellProductionRuntimeArguments, accessGate);
  return yield* Effect.acquireRelease(
    Effect.promise(resolveEffectBffModuleHandler.bind(undefined, { default: runtime }, {})).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(new PrivacyCompletionShellFailure({ reason: 'Shell API handler is unavailable' }))
          : Effect.succeed(value),
      ),
    ),
    (value) => (value.dispose === undefined ? Effect.void : Effect.promise(value.dispose).pipe(Effect.orDie)),
  );
});

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
    const database = yield* makeAuthDatabase({
      connectionString: configuration.connectionString,
      expectedRole: expectedUser,
    });
    const resolver = yield* Layer.build(
      PrincipalResolverLive({
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      }).pipe(Layer.provide(CorePersistenceLive), Layer.provide(DatabaseConfigLive)),
    );
    // The same framework, OAuth endpoint guards and native adapter layers as the Shell, with fixture sign-up enabled.
    const persistence = Layer.mergeAll(
      CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive)),
      Layer.succeed(AuthDatabase, database),
    );
    const oauthAuthentication = Layer.mergeAll(
      BetterAuthRuntimeLive,
      BetterAuthNativeAdapterLive,
      OAuthAuthenticationAuditLive,
      OAuthEndpointGuardDataLive,
      OAuthConnectionHooksLive.pipe(Layer.provide(OAuthGrantRegistryLive)),
    ).pipe(Layer.provide(Layer.mergeAll(OAuthGrantRegistryLive, OAuthCredentialsLive)), Layer.provide(persistence));
    const authenticationGuards = OAuthEndpointGuardsLive.pipe(
      Layer.provideMerge(BetterAuthFrameworkLive({ allowFixtureSignUp: true })),
      Layer.provideMerge(oauthAuthentication),
    );
    const authenticationContext = yield* Layer.build(
      authenticationGuards.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AuthConfig, configuration),
            Layer.succeed(AuthDatabase, database),
            Layer.succeedContext(resolver),
          ),
        ),
      ),
    );
    const authentication = yield* makeAuthenticationService().pipe(Effect.provideContext(authenticationContext));
    const email = `privacy-completion-${suffix}@example.test`;
    const password = `privacy-completion-${suffix}`;
    const providerSubjectId = yield* authentication
      .createFixtureUser(email, 'Privacy completion test', password)
      .pipe(startupStage('create-user'));
    const prepared = yield* requestCreatorBootstrap(responseSocket, providerSubjectId).pipe(
      startupStage('creator-bootstrap'),
    );
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixtureRuntime({
        configuration: {
          ...additionalLegalEntityConfiguration,
          access: 'allowed',
          actionKeys: [
            bindSelfApiKeyAction.descriptor.actionKey,
            createNonHumanPrincipalAction.descriptor.actionKey,
            bindManagedApiKeyAction.descriptor.actionKey,
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
    const fixtureContext = yield* Layer.build(fixture.layer).pipe(startupStage('fixture-runtime'));
    /**
     * The one gate this fixture serves HTTP with (CUTOVER-PLAN §3.1 step 8). The child's database
     * carries no v2 access intent, so the production default would refuse every gateway-context
     * request; the suite scripts its answers and names the companies the fixture created, which is
     * exactly the question `issueApiKeyGatewayContext` asks through `selectableLegalEntities`.
     */
    const fixtureAccessGate = makeTestAccessDecision({
      defaultAnswer: { outcome: 'ALLOWED' },
      legalEntityIds: [fixture.legalEntityId, fixture.runtimeHandoff.secondaryLegalEntityId]
        .filter((legalEntityId) => legalEntityId !== undefined)
        .map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
    });
    const signedIn = yield* authentication.signIn(email, password, new Headers({ origin: configuration.baseUrl }));
    const headers = new Headers({
      cookie: signedIn.setCookieHeaders.map((value) => value.split(';')[0]).join('; '),
      origin: configuration.baseUrl,
    });
    // Session resolution asks the gate only for a support impersonator; this fixture signs in as the
    // person themselves, so the scripted answer is never reached.
    const resolved = yield* authentication
      .resolveTenantContext(headers)
      .pipe(Effect.provideService(AccessDecisionGate, fixtureAccessGate));
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
    // The party-registry module credential is provisioned by the platform, as on every environment.
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(composition));
    const moduleCredential = yield* partyModuleCredential(crypto, moduleCredentialReleaseOf(catalog)).pipe(
      Effect.provideContext(fixtureContext),
      Effect.provideService(ApiKeyService, keys),
      Effect.provideService(AuthDatabase, database),
      startupStage('module-credential'),
    );
    const principal = { ...resolved.principal, legalEntityId: fixture.legalEntityId };
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
          Effect.provideService(InstalledModuleCatalogService, {
            loadForRevision: (_compositionRevision) => Effect.succeed(catalog),
          }),
        );
      });
    const changePartyRead = (operation: 'grant' | 'revoke') =>
      fixture.changeManagerModuleAccess(partyModule, operation);
    yield* changePartyRead('grant');
    yield* Effect.addFinalizer(() => changePartyRead('revoke').pipe(Effect.orDie));
    const app = yield* mountShellApiHandler(Layer.succeed(AccessDecisionGate, fixtureAccessGate));
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
          try: dispatchEffectBffRequest.bind(
            undefined,
            app.handler,
            webRequest,
            new URL(webRequest.url).pathname.startsWith(`${shellAuthenticationApiContract.apiPrefix}/`)
              ? { prefix: shellAuthenticationApiContract.apiPrefix }
              : {},
          ),
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
      moduleApiKey: Redacted.value(moduleCredential.secret),
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
  runtimeContract: createShellRuntimeContract(ultramodernDeliveryUnit.buildMarker),
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
      return yield* serve.pipe(Effect.provideContext(services), startupStage('serve'));
    }),
  ),
);
