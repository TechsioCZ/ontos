import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { makeShellAuthenticationApiRuntime, shellProductionRuntimeArguments } from '../../api/index.ts';
import {
  shellAuthenticationApiContract,
  SwitchLegalEntityPayloadSchema,
  SwitchLegalEntityResponseSchema,
} from '../../shared/browser-api.ts';
import { issueGatewayContext } from '@app/shared-contracts';
import type { GatewayContextRequestSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';

import {
  CorePersistenceLive,
  GatewayScopeGrantRegistrarLive,
  DatabaseConfig,
  DatabaseConfigLive,
  ContextAccessLive,
  PrincipalResolverLive,
  PrincipalResolver,
  TenantModuleStateServiceLive,
  loadDatabaseConnectionPair,
  LegalEntityContextLive,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { NodeHttpServer, NodeRuntime, NodeServices, NodeCrypto, NodeSocket } from '@effect/platform-node';
import {
  Config,
  ConfigProvider,
  Context,
  Crypto,
  FileSystem,
  Path,
  Duration,
  Effect,
  Layer,
  Logger,
  Option,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { Socket } from 'effect/socket';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { AuthConfig, AuthConfigLive, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { AuthenticationServiceLive, makeAuthenticationService } from '../../api/auth/service.ts';
import { makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { GatewayIssuer, GatewayIssuerLive } from '../../api/auth/gateway-issuer.ts';
import { ShellGatewayReleaseObserver } from '../../api/auth/gateway-release-diagnostic.ts';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
import { ShellInstalledModuleCatalogLive } from '../../api/modules/installed-module-catalog.ts';
import { AuthPersistenceLive } from '../../api/auth/runtime-infrastructure.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import {
  ShellNativeBoundCommandSchema,
  ShellNativeSessionGatewayCommandSchema,
  ShellNativeIssueCommandSchema,
  ShellNativeChildCommandSchema,
  ShellNativeChildReadySchema,
  ShellNativeChildResponseSchema,
  ShellNativeRelaySourceSchema,
  ShellNativeRelaySourceIssueCommandSchema,
  ShellNativeRelaySourceBoundCommandSchema,
  ShellNativeAdditionalRelaySourceSchema,
  ShellNativeModuleSourceIssueCommandSchema,
  ShellNativeModuleSourceBoundCommandSchema,
  ShellNativeGatewayProblemSchema,
  ShellNativeGatewayDiagnosticsCommandSchema,
  ShellNativeIssuerDiagnosticsCommandSchema,
  ShellNativeRequestDiagnosticsCommandSchema,
  ShellNativeReleaseDiagnosticsCommandSchema,
  ShellNativeModuleAppIdSchema,
  observeShellNativeRequestDispatch,
  describeShellNativeIssuerFailure,
  ShellNativeStartupEventSchema,
  ShellNativeSetupKeyIssueCommandSchema,
  ShellNativeSetupKeyBoundCommandSchema,
  ShellNativeTenantSetupGatewayCommandSchema,
  ShellNativeSafeFailureSchema,
} from '../fixtures/api-key-gateway-native.ts';
import type {
  ShellNativeGatewayDiagnosticSchema,
  ShellNativeIssuerDiagnosticSchema,
  ShellNativeRequestDiagnosticSchema,
  ShellNativeReleaseDiagnosticSchema,
  ShellNativeStartupStageSchema,
} from '../fixtures/api-key-gateway-native.ts';
import { nativeShellAccessGateLive } from './native-shell-access-gate.ts';

class ShellNativeChildUnavailable extends Schema.TaggedError<ShellNativeChildUnavailable>()(
  'ShellNativeChildUnavailable',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new ShellNativeChildUnavailable({
    cause: Redacted.make(cause),
    reason: 'The owned Shell child is unavailable',
  });
const bounded = Effect.timeoutOrElse({ duration: Duration.seconds(20), orElse: () => Effect.fail(unavailable()) });
const startupStage = (stage: typeof ShellNativeStartupStageSchema.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(ShellNativeStartupEventSchema))({ stage }).pipe(
    Effect.flatMap((line) => Effect.sync(() => process.stderr.write(`${line}\n`))),
    Effect.asVoid,
  );

const appendIssuerOutcome = (
  outcomes: Ref.Ref<readonly (typeof ShellNativeIssuerDiagnosticSchema.Type)[]>,
  outcome: typeof ShellNativeIssuerDiagnosticSchema.Type,
) => Ref.update(outcomes, (previous) => [...previous, outcome].slice(-32));

const observeProductionIssuer = (outcomes: Ref.Ref<readonly (typeof ShellNativeIssuerDiagnosticSchema.Type)[]>) =>
  Layer.effect(
    GatewayIssuer,
    Effect.gen(function* observeActualProductionIssuer() {
      const actual = yield* GatewayIssuer;
      return GatewayIssuer.of({
        issue: (input) => {
          const audience = Schema.is(ShellNativeModuleAppIdSchema)(input.audience) ? input.audience : 'other';
          return actual.issue(input).pipe(
            Effect.tap(() => appendIssuerOutcome(outcomes, { audience, outcome: 'success' })),
            Effect.tapError((failure) =>
              appendIssuerOutcome(outcomes, { audience, ...describeShellNativeIssuerFailure(failure) }),
            ),
          );
        },
      });
    }),
  );

const sendPrivate = Effect.fn('ShellNativeChild.sendPrivate')(function* sendPrivate(
  writer: Socket.Writer,
  response: typeof ShellNativeChildResponseSchema.Encoded,
) {
  const line = yield* Schema.decodeUnknownEffect(ShellNativeChildResponseSchema)(response).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildResponseSchema))),
  );
  yield* writer.write(`${line}\n`).pipe(Effect.mapError(unavailable));
});
const describe = Effect.gen(function* describeOwnedShellBundle() {
  const descriptionSchema = Schema.Struct({ appId: Schema.Literal('shell-super-app'), buildMarker: Schema.String });
  const text = yield* Schema.decodeUnknownEffect(descriptionSchema)(ultramodernDeliveryUnit).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(descriptionSchema))),
  );
  yield* Effect.sync(() => process.stdout.write(`${text}\n`));
});
const serve = Effect.scoped(
  Effect.gen(function* serveOwnedShellGateway() {
    yield* startupStage('connecting_private_channel');
    const socketPath = yield* Config.String('ONTOS_SHELL_NATIVE_SOCKET').pipe(Effect.mapError(unavailable));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      !path.isAbsolute(socketPath) ||
      socketPath.includes('\0') ||
      new TextEncoder().encode(socketPath).length > 96 ||
      path.basename(socketPath) !== 'native.sock'
    ) {
      return yield* unavailable();
    }
    const directory = path.dirname(socketPath);
    const parent = yield* fs.stat(directory).pipe(Effect.mapError(unavailable));
    if (
      parent.type !== 'Directory' ||
      parent.mode % 0o1000 !== 0o700 ||
      (yield* fs.realPath(directory)) !== directory
    ) {
      return yield* unavailable();
    }
    const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
    const writer = yield* socket.writer;
    yield* startupStage('loading_database');
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    if (
      !connections.admin.database.startsWith('ontos_test_party_gateway_') ||
      connections.admin.database !== connections.runtime.database
    ) {
      return yield* unavailable();
    }
    const configuration = yield* loadAuthConfig({ envPath: '/dev/null' });
    yield* startupStage('creating_authentication');
    const database = yield* makeAuthDatabase(configuration);
    const core = CorePersistenceLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime)));
    const resolver = yield* Layer.build(
      PrincipalResolverLive({ authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID }).pipe(Layer.provide(core)),
    );
    const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, database),
      Effect.provideContext(resolver),
    );
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const email = `native-${suffix}@fixture.invalid`;
    const password = Redacted.make(`${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`);
    yield* startupStage('creating_provider_users');
    const providerUserId = yield* authentication.createFixtureUser(email, 'Owned native gateway fixture', password);
    const relaySource = yield* Config.schema(
      Schema.fromJsonString(Schema.OptionFromNullOr(ShellNativeRelaySourceSchema)),
      'ONTOS_SHELL_NATIVE_RELAY_SOURCE',
    ).pipe(Config.withDefault(Option.none()), Effect.mapError(unavailable));
    const additionalSources = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(ShellNativeAdditionalRelaySourceSchema)),
      'ONTOS_SHELL_NATIVE_ADDITIONAL_RELAY_SOURCES',
    ).pipe(Config.withDefault([]), Effect.mapError(unavailable));
    const productionGate = yield* Config.Boolean('ONTOS_SHELL_NATIVE_PRODUCTION_GATE').pipe(Config.withDefault(false));
    if (
      additionalSources.length > 0 &&
      (!productionGate ||
        Option.isNone(relaySource) ||
        new Set([...additionalSources.map(({ sourceAppId }) => sourceAppId), relaySource.value.sourceAppId]).size !==
          additionalSources.length + 1)
    ) {
      return yield* unavailable();
    }
    const additionalUsers = yield* Effect.forEach(
      additionalSources,
      (source) =>
        Effect.gen(function* createAdditionalModuleUser() {
          const sourceEmail = `native-${source.sourceAppId}-${suffix}@fixture.invalid`;
          const sourcePassword = Redacted.make(`${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`);
          return {
            email: sourceEmail,
            password: sourcePassword,
            providerUserId: yield* authentication.createFixtureUser(
              sourceEmail,
              'Owned native module relay fixture',
              sourcePassword,
            ),
            source,
          };
        }),
      { concurrency: 1 },
    );
    const moduleKeys = new Map<string, { bound: boolean; readonly keyId: string; readonly principalId: string }>();
    const attemptedModules = new Set<string>();
    const authenticatedIssuers = new Set<string>();
    const gatewayOutcomes = yield* Ref.make<readonly (typeof ShellNativeGatewayDiagnosticSchema.Type)[]>([]);
    const issuerOutcomes = yield* Ref.make<readonly (typeof ShellNativeIssuerDiagnosticSchema.Type)[]>([]);
    const requestOutcomes = yield* Ref.make<readonly (typeof ShellNativeRequestDiagnosticSchema.Type)[]>([]);
    const releaseOutcomes = yield* Ref.make<readonly (typeof ShellNativeReleaseDiagnosticSchema.Type)[]>([]);
    const primarySourceBound = yield* Ref.make(false);
    const relaySourceUser = yield* Effect.gen(function* createRelaySourceUser() {
      if (Option.isNone(relaySource)) {
        return Option.none();
      }
      const sourceEmail = `native-source-${suffix}@fixture.invalid`;
      const sourcePassword = Redacted.make(`${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`);
      return Option.some({
        email: sourceEmail,
        password: sourcePassword,
        providerUserId: yield* authentication.createFixtureUser(
          sourceEmail,
          'Owned native relay source fixture',
          sourcePassword,
        ),
      });
    });
    const keys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, database),
    );
    const issuedKey = yield* Ref.make(Option.none<string>());
    const issueAttempted = yield* Ref.make(false);
    const sourceIssueAttempted = yield* Ref.make(false);
    const issuedSourceKey = yield* Ref.make(Option.none<string>());
    const sessionCookie = yield* Ref.make(Option.none<string>());
    const sessionPrincipal = yield* Ref.make(
      Option.none<{ readonly principalId: string; readonly tenantId: string }>(),
    );
    const originalTarget = yield* Ref.make(Option.none<{ readonly principalId: string; readonly tenantId: string }>());
    const originalBindingAcknowledged = yield* Ref.make(false);
    const setupKey = yield* Ref.make(
      Option.none<{ readonly providerKeyId: string; readonly secret: Redacted.Redacted }>(),
    );
    const setupKeyAttempted = yield* Ref.make(false);
    const setupKeyBound = yield* Ref.make(false);
    const selectedCookies = new Map<string, string>();
    yield* startupStage('composing_runtime');
    const runtimeCore = CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive));
    const runtimeResolver = PrincipalResolverLive({
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    }).pipe(Layer.provide(runtimeCore));
    const runtimeAuthentication = AuthenticationServiceLive.pipe(
      Layer.provide(Layer.mergeAll(AuthPersistenceLive.pipe(Layer.provide(AuthConfigLive)), runtimeResolver)),
    );
    const composition = ActiveApplicationCompositionConfigLive.pipe(
      Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
    );
    const issuer = GatewayIssuerLive.pipe(
      Layer.provide(ShellInstalledModuleCatalogLive.pipe(Layer.provide(composition))),
      Layer.provide(GatewayScopeGrantRegistrarLive),
    );
    // The child scripts one access gate for the fixture's own manager journey: a scripted ALLOW, and the
    // tenant's own companies for the company question.
    const accessGate = nativeShellAccessGateLive.pipe(
      Layer.provide(LegalEntityContextLive.pipe(Layer.provide(runtimeCore))),
    );
    const [productionAuthentication, productionIssuer, ...productionArguments] = shellProductionRuntimeArguments;
    const observedProductionIssuer = observeProductionIssuer(issuerOutcomes).pipe(Layer.provide(productionIssuer));
    const runtime = productionGate
      ? makeShellAuthenticationApiRuntime(productionAuthentication, observedProductionIssuer, ...productionArguments)
      : makeShellAuthenticationApiRuntime(
          runtimeAuthentication,
          issuer,
          TenantModuleStateServiceLive.pipe(Layer.provide(runtimeCore)),
          undefined,
          false,
          ContextAccessLive,
          undefined,
          undefined,
          undefined,
          accessGate,
        );
    const observedRuntime = productionGate
      ? {
          api: runtime.api,
          layer: runtime.layer.pipe(
            Layer.provideMerge(
              Layer.succeed(ShellGatewayReleaseObserver, (reason) =>
                Ref.update(releaseOutcomes, (previous) =>
                  [...previous, { reason, stage: 'release' as const }].slice(-32),
                ),
              ),
            ),
          ),
        }
      : runtime;
    yield* startupStage('binding_server');
    const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
      return yield* unavailable();
    }
    const originalProvider = yield* ConfigProvider.ConfigProvider;
    const mounted = yield* Ref.make(false);
    const mountRuntime = Effect.fn('ShellNativeChild.mountRuntime')(function* mountRuntime(bindings?: string) {
      if (yield* Ref.getAndSet(mounted, true)) {
        return yield* unavailable();
      }
      const module =
        bindings === undefined
          ? { default: observedRuntime }
          : {
              api: runtime.api,
              layer: observedRuntime.layer.pipe(
                Layer.provideMerge(
                  ConfigProvider.layer(
                    ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_MODULE_BINDINGS: bindings }).pipe(
                      ConfigProvider.orElse(originalProvider),
                    ),
                  ),
                ),
              ),
            };
      const handler = yield* Effect.acquireRelease(
        Effect.promise(resolveEffectBffModuleHandler.bind(undefined, module, {})).pipe(
          Effect.flatMap((value) => (value === null ? Effect.fail(unavailable()) : Effect.succeed(value))),
        ),
        (value) => (value.dispose === undefined ? Effect.void : Effect.promise(value.dispose).pipe(Effect.orDie)),
      );
      return yield* server.serve(
        Effect.gen(function* forwardActualShellRequest() {
          const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
          const { pathname } = new URL(request.url);
          const dispatchOptions: NonNullable<Parameters<typeof dispatchEffectBffRequest>[2]> = {};
          if (productionGate && pathname.startsWith('/api/symmy/v1/')) {
            dispatchOptions.prefix = '/api/symmy/v1';
          } else if (pathname.startsWith(`${shellAuthenticationApiContract.apiPrefix}/`)) {
            dispatchOptions.prefix = shellAuthenticationApiContract.apiPrefix;
          }
          const dispatch = Effect.tryPromise({
            catch: unavailable,
            try: dispatchEffectBffRequest.bind(undefined, handler.handler, request, dispatchOptions),
          });
          let surface: typeof ShellNativeRequestDiagnosticSchema.Type.surface = 'other';
          if (pathname.startsWith('/api/symmy/v1/')) {
            surface = 'symmy';
          } else if (pathname.startsWith(`${shellAuthenticationApiContract.apiPrefix}/`)) {
            surface = 'gateway';
          }
          const response = yield* productionGate
            ? observeShellNativeRequestDispatch(dispatch, Effect.fail(unavailable()), requestOutcomes, surface)
            : dispatch.pipe(bounded);
          if (
            productionGate &&
            pathname === `${shellAuthenticationApiContract.apiPrefix}/auth/delegated/gateway-context`
          ) {
            const problem = response.ok
              ? Effect.succeed('success' as const)
              : Effect.tryPromise({
                  catch: unavailable,
                  try: async () => await response.clone().json(),
                }).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(ShellNativeGatewayProblemSchema)),
                  Effect.map((error) => error._tag),
                  Effect.catch(() => Effect.succeed('unclassified' as const)),
                );
            const outcome = { problem: yield* problem, status: response.status };
            yield* Ref.update(gatewayOutcomes, (previous) => [...previous, outcome].slice(-32));
          }
          return HttpServerResponse.fromWeb(response);
        }),
      );
    });
    const assertModuleBinding = Effect.fn('ShellNativeChild.assertModuleBinding')(function* assertModuleBinding(
      keyId: string,
      expectedPrincipalId: string,
    ) {
      const identity = yield* Context.get(resolver, PrincipalResolver).resolveBetterAuthApiKey(keyId);
      const actor = yield* Ref.get(originalTarget);
      if (
        identity.principalKind !== 'service' ||
        identity.principalId !== expectedPrincipalId ||
        Option.isNone(actor) ||
        identity.tenantId !== actor.value.tenantId ||
        identity.principalId === actor.value.principalId
      ) {
        return yield* unavailable();
      }
      return yield* Effect.void;
    });
    const acknowledgeOriginalBinding = Effect.fn('ShellNativeChild.acknowledgeOriginalBinding')(
      function* acknowledgeOriginalBinding() {
        const key = yield* Ref.get(issuedKey);
        const target = yield* Ref.get(originalTarget);
        if (Option.isNone(key) || Option.isNone(target)) {
          return yield* unavailable();
        }
        if (productionGate) {
          const identity = yield* Context.get(resolver, PrincipalResolver).resolveBetterAuthApiKey(key.value);
          if (
            identity.principalKind !== 'integration' ||
            identity.principalId !== target.value.principalId ||
            identity.tenantId !== target.value.tenantId
          ) {
            return yield* unavailable();
          }
        }
        yield* keys.clearPendingCleanup(key.value);
        yield* Ref.set(originalBindingAcknowledged, true);
        return yield* sendPrivate(writer, { _tag: 'ack' });
      },
    );
    const mountAllSources = Effect.fn('ShellNativeChild.mountAllSources')(function* mountAllSources() {
      if (
        !(yield* Ref.get(primarySourceBound)) ||
        additionalSources.some(({ sourceAppId }) => moduleKeys.get(sourceAppId)?.bound !== true)
      ) {
        return yield* Effect.void;
      }
      const sourceKey = yield* Ref.get(issuedSourceKey);
      if (Option.isNone(relaySource) || Option.isNone(sourceKey)) {
        return yield* unavailable();
      }
      const bindings = yield* Schema.decodeEffect(Schema.Array(GatewayModuleBindingSchema))([
        { ...relaySource.value, providerKeyId: sourceKey.value },
        ...additionalSources.map((source) => ({
          ...source,
          providerKeyId: moduleKeys.get(source.sourceAppId)?.keyId ?? '',
        })),
      ]).pipe(
        Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Array(GatewayModuleBindingSchema)))),
        Effect.mapError(unavailable),
      );
      if (productionGate) {
        yield* Effect.forEach(
          [...moduleKeys.values()],
          ({ keyId, principalId }) => assertModuleBinding(keyId, principalId),
          { discard: true },
        );
      }
      return yield* mountRuntime(bindings);
    });
    const issueModuleSource = Effect.fn('ShellNativeChild.issueModuleSource')(function* issueModuleSource(
      command: typeof ShellNativeModuleSourceIssueCommandSchema.Type,
    ) {
      const source = additionalUsers.find(({ source: configured }) => configured.sourceAppId === command.sourceAppId);
      const actor = yield* Ref.get(originalTarget);
      if (
        !productionGate ||
        !(yield* Ref.get(originalBindingAcknowledged)) ||
        source === undefined ||
        Option.isNone(actor) ||
        actor.value.principalId === command.principalId ||
        actor.value.tenantId !== command.tenantId ||
        attemptedModules.has(command.sourceAppId) ||
        [...moduleKeys.values()].some(({ principalId }) => principalId === command.principalId)
      ) {
        return yield* unavailable();
      }
      attemptedModules.add(command.sourceAppId);
      const session = yield* authentication.signIn(
        source.email,
        source.password,
        new Headers({ origin: configuration.baseUrl }),
      );
      if (
        session.identity.principalId !== (command.issuerPrincipalId ?? command.principalId) ||
        authenticatedIssuers.has(session.identity.principalId) ||
        session.identity.tenantId !== command.tenantId
      ) {
        return yield* unavailable();
      }
      const cookie = session.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
      authenticatedIssuers.add(session.identity.principalId);
      const issued = yield* keys.issue(new Headers({ cookie, origin: configuration.baseUrl }), {
        issuerPrincipalId: session.identity.principalId,
        lifecycleOperationId: yield* crypto.randomUUIDv4(),
        name: 'Owned module relay source proof',
        tenantId: command.tenantId,
      });
      moduleKeys.set(command.sourceAppId, {
        bound: false,
        keyId: issued.providerKeyId,
        principalId: command.principalId,
      });
      return yield* sendPrivate(writer, {
        _tag: 'issued',
        providerKeyId: issued.providerKeyId,
        secret: Redacted.value(issued.secret),
      });
    });
    const acknowledgeModuleSource = Effect.fn('ShellNativeChild.acknowledgeModuleSource')(
      function* acknowledgeModuleSource(command: typeof ShellNativeModuleSourceBoundCommandSchema.Type) {
        const issued = moduleKeys.get(command.sourceAppId);
        if (
          !productionGate ||
          !additionalUsers.some(({ source }) => source.sourceAppId === command.sourceAppId) ||
          issued === undefined ||
          issued.bound
        ) {
          return yield* unavailable();
        }
        yield* assertModuleBinding(issued.keyId, issued.principalId);
        yield* keys.clearPendingCleanup(issued.keyId);
        issued.bound = true;
        yield* mountAllSources();
        return yield* sendPrivate(writer, { _tag: 'ack' });
      },
    );
    const issuePrimarySource = Effect.fn('ShellNativeChild.issuePrimarySource')(function* issuePrimarySource(
      command: typeof ShellNativeRelaySourceIssueCommandSchema.Type,
    ) {
      const actor = yield* Ref.get(originalTarget);
      if (
        Option.isNone(relaySource) ||
        Option.isNone(relaySourceUser) ||
        Option.isNone(actor) ||
        !(yield* Ref.get(originalBindingAcknowledged)) ||
        actor.value.principalId === command.principalId ||
        actor.value.tenantId !== command.tenantId ||
        [...moduleKeys.values()].some(({ principalId }) => principalId === command.principalId) ||
        (yield* Ref.getAndSet(sourceIssueAttempted, true))
      ) {
        return yield* unavailable();
      }
      const session = yield* authentication.signIn(
        relaySourceUser.value.email,
        relaySourceUser.value.password,
        new Headers({ origin: configuration.baseUrl }),
      );
      if (
        session.identity.principalId !== (command.issuerPrincipalId ?? command.principalId) ||
        (productionGate && authenticatedIssuers.has(session.identity.principalId)) ||
        session.identity.tenantId !== command.tenantId
      ) {
        return yield* unavailable();
      }
      const cookie = session.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
      authenticatedIssuers.add(session.identity.principalId);
      const issued = yield* keys.issue(new Headers({ cookie, origin: configuration.baseUrl }), {
        issuerPrincipalId: session.identity.principalId,
        lifecycleOperationId: yield* crypto.randomUUIDv4(),
        name: 'Owned Market relay source proof',
        tenantId: command.tenantId,
      });
      yield* Ref.set(issuedSourceKey, Option.some(issued.providerKeyId));
      moduleKeys.set(relaySource.value.sourceAppId, {
        bound: false,
        keyId: issued.providerKeyId,
        principalId: command.principalId,
      });
      return yield* sendPrivate(writer, {
        _tag: 'issued',
        providerKeyId: issued.providerKeyId,
        secret: Redacted.value(issued.secret),
      });
    });
    if (Option.isNone(relaySource)) {
      yield* mountRuntime();
    }
    const baseUrl = `http://127.0.0.1:${server.address.port}`;
    const sessionGateway = Effect.fn('ShellNativeChild.sessionGateway')(function* sessionGateway(
      request: typeof GatewayContextRequestSchema.Type,
    ) {
      if (!(yield* Ref.get(mounted))) {
        yield* startupStage('awaiting_module_bindings');
        return yield* unavailable();
      }
      const retained = yield* Ref.get(sessionCookie);
      const actor = yield* Ref.get(sessionPrincipal);
      if (Option.isNone(retained) || Option.isNone(actor)) {
        return yield* unavailable();
      }
      let cookie = retained.value;
      if (request.legalEntityId !== undefined) {
        const selected = selectedCookies.get(request.legalEntityId);
        if (selected === undefined) {
          const scoped = yield* authentication.signIn(email, password, new Headers({ origin: configuration.baseUrl }));
          if (
            scoped.identity.principalId !== actor.value.principalId ||
            scoped.identity.tenantId !== actor.value.tenantId
          ) {
            return yield* unavailable();
          }
          const originalCookie = scoped.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(SwitchLegalEntityPayloadSchema))({
            legalEntityId: request.legalEntityId,
          });
          const response = yield* Effect.tryPromise({
            catch: unavailable,
            try: async () =>
              await fetch(`${baseUrl}${shellAuthenticationApiContract.apiPrefix}/auth/legal-entity/switch`, {
                body,
                headers: { 'content-type': 'application/json', cookie: originalCookie, origin: configuration.baseUrl },
                method: 'POST',
              }),
          }).pipe(bounded);
          if (!response.ok) {
            return yield* unavailable();
          }
          const switched = yield* Effect.tryPromise({
            catch: unavailable,
            try: async () => await response.json(),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(SwitchLegalEntityResponseSchema)),
            Effect.mapError(unavailable),
          );
          if (switched.selectedLegalEntityId !== request.legalEntityId) {
            return yield* unavailable();
          }
          const cookies = new Map<string, string>();
          for (const header of [...scoped.setCookieHeaders, ...response.headers.getSetCookie()]) {
            const [pair] = header.split(';');
            if (pair !== undefined) {
              cookies.set(pair.split('=')[0] ?? '', pair);
            }
          }
          cookie = [...cookies.values()].join('; ');
          selectedCookies.set(request.legalEntityId, cookie);
        } else {
          cookie = selected;
        }
      }
      const gateway = yield* issueGatewayContext(request, {
        baseUrl: `${baseUrl}${shellAuthenticationApiContract.apiPrefix}`,
        cookie,
      }).pipe(Effect.provide(FetchHttpClient.layer));
      return yield* sendPrivate(writer, { _tag: 'session-gateway', gateway });
    });
    const issueSetupKey = Effect.fn('ShellNativeChild.issueSetupKey')(function* issueSetupKey() {
      const actor = yield* Ref.get(sessionPrincipal);
      const cookie = yield* Ref.get(sessionCookie);
      if (
        !productionGate ||
        Option.isNone(actor) ||
        Option.isNone(cookie) ||
        !(yield* Ref.get(originalBindingAcknowledged)) ||
        (yield* Ref.getAndSet(setupKeyAttempted, true))
      ) {
        return yield* unavailable();
      }
      const session = yield* authentication.signIn(email, password, new Headers({ origin: configuration.baseUrl }));
      if (
        session.identity.principalId !== actor.value.principalId ||
        session.identity.tenantId !== actor.value.tenantId
      ) {
        return yield* unavailable();
      }
      const currentCookie = session.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
      yield* Ref.set(sessionCookie, Option.some(currentCookie));
      const issued = yield* keys.issue(new Headers({ cookie: currentCookie, origin: configuration.baseUrl }), {
        issuerPrincipalId: actor.value.principalId,
        lifecycleOperationId: yield* crypto.randomUUIDv4(),
        name: 'Native human setup proof',
        tenantId: actor.value.tenantId,
      });
      yield* Ref.set(setupKey, Option.some({ providerKeyId: issued.providerKeyId, secret: issued.secret }));
      return yield* sendPrivate(writer, { _tag: 'setup-key-issued', providerKeyId: issued.providerKeyId });
    });
    const verifySetupKey = Effect.fn('ShellNativeChild.verifySetupKey')(function* verifySetupKey() {
      const key = yield* Ref.get(setupKey);
      const actor = yield* Ref.get(sessionPrincipal);
      if (!productionGate || Option.isNone(key) || Option.isNone(actor)) {
        return yield* unavailable();
      }
      const identity = yield* Context.get(resolver, PrincipalResolver).resolveBetterAuthApiKey(key.value.providerKeyId);
      if (
        identity.principalKind !== 'human' ||
        identity.principalId !== actor.value.principalId ||
        identity.tenantId !== actor.value.tenantId
      ) {
        return yield* unavailable();
      }
      return key.value;
    });
    const acknowledgeSetupKey = Effect.fn('ShellNativeChild.acknowledgeSetupKey')(function* acknowledgeSetupKey() {
      const key = yield* verifySetupKey();
      yield* keys.clearPendingCleanup(key.providerKeyId);
      yield* Ref.set(setupKeyBound, true);
      return yield* sendPrivate(writer, { _tag: 'ack' });
    });
    const tenantSetupGateway = Effect.fn('ShellNativeChild.tenantSetupGateway')(function* tenantSetupGateway(
      command: typeof ShellNativeTenantSetupGatewayCommandSchema.Type,
    ) {
      if (!(yield* Ref.get(mounted))) {
        yield* startupStage('awaiting_module_bindings');
        return yield* unavailable();
      }
      if (!(yield* Ref.get(setupKeyBound))) {
        return yield* unavailable();
      }
      const key = yield* verifySetupKey();
      const gateway = yield* issueApiKeyGatewayContext(command.request, {
        apiKey: key.secret,
        baseUrl: new URL(`${baseUrl}${shellAuthenticationApiContract.apiPrefix}`),
        requestCorrelation: 'native-human-tenant-setup',
      }).pipe(Effect.provide(FetchHttpClient.layer));
      return yield* sendPrivate(writer, { _tag: 'setup-gateway', gateway });
    });
    const issueOriginalKey = Effect.fn('ShellNativeChild.issueOriginalKey')(function* issueOriginalKey(
      command: typeof ShellNativeIssueCommandSchema.Type,
    ) {
      if (yield* Ref.getAndSet(issueAttempted, true)) {
        return yield* unavailable();
      }
      const session = yield* authentication.signIn(email, password, new Headers({ origin: configuration.baseUrl }));
      if (
        session.identity.principalId !== (command.issuerPrincipalId ?? command.principalId) ||
        session.identity.tenantId !== command.tenantId
      ) {
        return yield* unavailable();
      }
      const cookie = session.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
      yield* Ref.set(sessionCookie, Option.some(cookie));
      yield* Ref.set(
        sessionPrincipal,
        Option.some({ principalId: session.identity.principalId, tenantId: command.tenantId }),
      );
      const headers = new Headers({
        cookie,
        origin: configuration.baseUrl,
      });
      authenticatedIssuers.add(session.identity.principalId);
      const issued = yield* keys.issue(headers, {
        issuerPrincipalId: session.identity.principalId,
        lifecycleOperationId: suffix,
        name: 'Owned Market Registry proof',
        tenantId: command.tenantId,
      });
      yield* Ref.set(issuedKey, Option.some(issued.providerKeyId));
      yield* Ref.set(originalTarget, Option.some({ principalId: command.principalId, tenantId: command.tenantId }));
      return yield* sendPrivate(writer, {
        _tag: 'issued',
        providerKeyId: issued.providerKeyId,
        secret: Redacted.value(issued.secret),
      });
    });
    const primaryReadiness = Option.isNone(relaySourceUser)
      ? { baseUrl, providerUserId }
      : { baseUrl, providerUserId, relaySourceProviderUserId: relaySourceUser.value.providerUserId };
    const readiness =
      additionalUsers.length === 0
        ? primaryReadiness
        : {
            ...primaryReadiness,
            additionalRelaySourceProviderUsers: additionalUsers.map(({ providerUserId: id, source }) => ({
              providerUserId: id,
              sourceAppId: source.sourceAppId,
            })),
          };
    const encoded = yield* Schema.decodeUnknownEffect(ShellNativeChildReadySchema)(readiness).pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildReadySchema))),
    );
    yield* startupStage('publishing_readiness');
    yield* Effect.sync(() => process.stdout.write(`${encoded}\n`));
    yield* startupStage('ready');
    // Consuming this stream acquires the reader/open latch before any response is written.
    const diagnosticCommands = Schema.Union([
      ShellNativeGatewayDiagnosticsCommandSchema,
      ShellNativeIssuerDiagnosticsCommandSchema,
      ShellNativeRequestDiagnosticsCommandSchema,
      ShellNativeReleaseDiagnosticsCommandSchema,
    ]);
    const replyDiagnostics = Effect.fn('ShellNativeChild.replyDiagnostics')(function* replyDiagnostics(
      command: typeof diagnosticCommands.Type,
    ) {
      if (!productionGate) {
        return yield* unavailable();
      }
      if (Schema.is(ShellNativeGatewayDiagnosticsCommandSchema)(command)) {
        return yield* sendPrivate(writer, {
          _tag: 'gateway-diagnostics',
          outcomes: yield* Ref.get(gatewayOutcomes),
        });
      }
      if (Schema.is(ShellNativeIssuerDiagnosticsCommandSchema)(command)) {
        return yield* sendPrivate(writer, {
          _tag: 'issuer-diagnostics',
          outcomes: yield* Ref.get(issuerOutcomes),
        });
      }
      if (Schema.is(ShellNativeReleaseDiagnosticsCommandSchema)(command)) {
        return yield* sendPrivate(writer, {
          _tag: 'release-diagnostics',
          outcomes: yield* Ref.get(releaseOutcomes),
        });
      }
      return yield* sendPrivate(writer, {
        _tag: 'request-diagnostics',
        outcomes: yield* Ref.get(requestOutcomes),
      });
    });
    const commands = Socket.toStream(socket).pipe(Stream.decodeText(), Stream.splitLines);
    yield* commands.pipe(
      Stream.mapEffect((line) =>
        new TextEncoder().encode(line).length > 65_536
          ? Effect.fail(unavailable())
          : Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildCommandSchema), {
              onExcessProperty: 'error',
            })(line).pipe(Effect.mapError(unavailable)),
      ),
      Stream.runForEach((command) =>
        Effect.gen(function* executeClosedCommand() {
          if (Schema.is(ShellNativeSetupKeyIssueCommandSchema)(command)) {
            return yield* issueSetupKey();
          }
          if (Schema.is(ShellNativeSetupKeyBoundCommandSchema)(command)) {
            return yield* acknowledgeSetupKey();
          }
          if (Schema.is(ShellNativeTenantSetupGatewayCommandSchema)(command)) {
            return yield* tenantSetupGateway(command);
          }
          if (Schema.is(diagnosticCommands)(command)) {
            return yield* replyDiagnostics(command);
          }
          if (Schema.is(ShellNativeIssueCommandSchema)(command)) {
            return yield* issueOriginalKey(command);
          }
          if (Schema.is(ShellNativeSessionGatewayCommandSchema)(command)) {
            return yield* sessionGateway(command.request);
          }
          if (Schema.is(ShellNativeModuleSourceIssueCommandSchema)(command)) {
            return yield* issueModuleSource(command);
          }
          if (Schema.is(ShellNativeModuleSourceBoundCommandSchema)(command)) {
            return yield* acknowledgeModuleSource(command);
          }
          if (Schema.is(ShellNativeRelaySourceIssueCommandSchema)(command)) {
            return yield* issuePrimarySource(command);
          }
          if (Schema.is(ShellNativeRelaySourceBoundCommandSchema)(command)) {
            const sourceKey = yield* Ref.get(issuedSourceKey);
            if (Option.isNone(relaySource) || Option.isNone(sourceKey)) {
              return yield* unavailable();
            }
            if (yield* Ref.get(primarySourceBound)) {
              return yield* unavailable();
            }
            yield* keys.clearPendingCleanup(sourceKey.value);
            yield* Ref.set(primarySourceBound, true);
            yield* mountAllSources();
            return yield* sendPrivate(writer, { _tag: 'ack' });
          }
          if (Schema.is(ShellNativeBoundCommandSchema)(command)) {
            return yield* acknowledgeOriginalBinding();
          }
          const key = yield* Ref.get(issuedKey);
          if (Option.isNone(key)) {
            return yield* unavailable();
          }
          yield* keys.setEnabled(key.value, command.enabled);
          return yield* sendPrivate(writer, { _tag: 'ack' });
        }).pipe(
          Effect.catch((error) =>
            Schema.decodeUnknownEffect(ShellNativeSafeFailureSchema)(error._tag).pipe(
              Effect.orElseSucceed(() => 'unclassified' as const),
              Effect.flatMap((failure) => sendPrivate(writer, { _tag: 'unavailable', failure })),
            ),
          ),
        ),
      ),
    );
    return yield* Effect.void;
  }),
);

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* childEntry() {
      yield* startupStage('entry');
      const services = yield* Layer.build(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Logger.layer([])));
      return yield* (process.argv.includes('--describe') ? describe : serve).pipe(
        Effect.provideContext(services),
        Effect.tapError(() => startupStage('typed_failure')),
        Effect.tapDefect(() => startupStage('defect')),
      );
    }),
  ),
  { disableErrorReporting: true },
);
