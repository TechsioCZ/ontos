import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import {
  shellAuthenticationApiContract,
  SwitchLegalEntityPayloadSchema,
  SwitchLegalEntityResponseSchema,
} from '../../shared/api.ts';
import { issueGatewayContext } from '@app/shared-contracts';
import type { GatewayContextRequestSchema } from '@app/shared-contracts';
import { dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';

import {
  CorePersistenceLive,
  GatewayScopeGrantRegistrarLive,
  DatabaseConfig,
  DatabaseConfigLive,
  ContextAccessLive,
  PrincipalResolverLive,
  TenantModuleStateServiceLive,
  loadDatabaseConnectionPair,
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
import { GatewayIssuerLive } from '../../api/auth/gateway-issuer.ts';
import { GatewayRelaySourceBindingSchema } from '../../api/auth/gateway-relay-policy.ts';
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
} from '../fixtures/api-key-gateway-native.ts';

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
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    if (
      !connections.admin.database.startsWith('ontos_test_party_gateway_') ||
      connections.admin.database !== connections.runtime.database
    ) {
      return yield* unavailable();
    }
    const configuration = yield* loadAuthConfig({ envPath: '/dev/null' });
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
    const providerUserId = yield* authentication.createFixtureUser(email, 'Owned native gateway fixture', password);
    const relaySource = yield* Config.schema(
      Schema.fromJsonString(Schema.OptionFromNullOr(ShellNativeRelaySourceSchema)),
      'ONTOS_SHELL_NATIVE_RELAY_SOURCE',
    ).pipe(Config.withDefault(Option.none()), Effect.mapError(unavailable));
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
    const selectedCookies = new Map<string, string>();
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
    const runtime = makeShellAuthenticationApiRuntime(
      runtimeAuthentication,
      issuer,
      TenantModuleStateServiceLive.pipe(Layer.provide(runtimeCore)),
      undefined,
      false,
      ContextAccessLive,
    );
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
          ? { default: runtime }
          : {
              api: runtime.api,
              layer: runtime.layer.pipe(
                Layer.provideMerge(
                  ConfigProvider.layer(
                    ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_RELAY_SOURCE_BINDINGS: bindings }).pipe(
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
          const response = yield* Effect.tryPromise({
            catch: unavailable,
            try: dispatchEffectBffRequest.bind(
              undefined,
              handler.handler,
              request,
              new URL(request.url).pathname.startsWith(`${shellAuthenticationApiContract.apiPrefix}/`)
                ? { prefix: shellAuthenticationApiContract.apiPrefix }
                : {},
            ),
          }).pipe(bounded);
          return HttpServerResponse.fromWeb(response);
        }),
      );
    });
    if (Option.isNone(relaySource)) {
      yield* mountRuntime();
    }
    const baseUrl = `http://127.0.0.1:${server.address.port}`;
    const sessionGateway = Effect.fn('ShellNativeChild.sessionGateway')(function* sessionGateway(
      request: typeof GatewayContextRequestSchema.Type,
    ) {
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
    const readiness = Option.isNone(relaySourceUser)
      ? { baseUrl, providerUserId }
      : { baseUrl, providerUserId, relaySourceProviderUserId: relaySourceUser.value.providerUserId };
    const encoded = yield* Schema.decodeUnknownEffect(ShellNativeChildReadySchema)(readiness).pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildReadySchema))),
    );
    yield* Effect.sync(() => process.stdout.write(`${encoded}\n`));
    // Consuming this stream acquires the reader/open latch before any response is written.
    const commands = Socket.toStream(socket).pipe(Stream.decodeText(), Stream.splitLines);
    yield* commands.pipe(
      Stream.mapEffect((line) =>
        new TextEncoder().encode(line).length > 65_536
          ? Effect.fail(unavailable())
          : Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildCommandSchema))(line).pipe(
              Effect.mapError(unavailable),
            ),
      ),
      Stream.runForEach((command) =>
        Effect.gen(function* executeClosedCommand() {
          if (Schema.is(ShellNativeIssueCommandSchema)(command)) {
            if (yield* Ref.getAndSet(issueAttempted, true)) {
              return yield* unavailable();
            }
            const session = yield* authentication.signIn(
              email,
              password,
              new Headers({ origin: configuration.baseUrl }),
            );
            if (
              session.identity.principalId !== command.principalId ||
              session.identity.tenantId !== command.tenantId
            ) {
              return yield* unavailable();
            }
            const cookie = session.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
            yield* Ref.set(sessionCookie, Option.some(cookie));
            yield* Ref.set(
              sessionPrincipal,
              Option.some({ principalId: command.principalId, tenantId: command.tenantId }),
            );
            const headers = new Headers({
              cookie,
              origin: configuration.baseUrl,
            });
            const issued = yield* keys.issue(headers, {
              issuerPrincipalId: command.principalId,
              lifecycleOperationId: suffix,
              name: 'Owned Market Registry proof',
              tenantId: command.tenantId,
            });
            yield* Ref.set(issuedKey, Option.some(issued.providerKeyId));
            return yield* sendPrivate(writer, {
              _tag: 'issued',
              providerKeyId: issued.providerKeyId,
              secret: Redacted.value(issued.secret),
            });
          }
          if (Schema.is(ShellNativeSessionGatewayCommandSchema)(command)) {
            return yield* sessionGateway(command.request);
          }
          if (Schema.is(ShellNativeRelaySourceIssueCommandSchema)(command)) {
            const actor = yield* Ref.get(sessionPrincipal);
            if (
              Option.isNone(relaySourceUser) ||
              Option.isNone(actor) ||
              actor.value.principalId === command.principalId ||
              actor.value.tenantId !== command.tenantId ||
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
              session.identity.principalId !== command.principalId ||
              session.identity.tenantId !== command.tenantId
            ) {
              return yield* unavailable();
            }
            const cookie = session.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
            const issued = yield* keys.issue(new Headers({ cookie, origin: configuration.baseUrl }), {
              issuerPrincipalId: command.principalId,
              lifecycleOperationId: yield* crypto.randomUUIDv4(),
              name: 'Owned Market relay source proof',
              tenantId: command.tenantId,
            });
            yield* Ref.set(issuedSourceKey, Option.some(issued.providerKeyId));
            return yield* sendPrivate(writer, {
              _tag: 'issued',
              providerKeyId: issued.providerKeyId,
              secret: Redacted.value(issued.secret),
            });
          }
          if (Schema.is(ShellNativeRelaySourceBoundCommandSchema)(command)) {
            const sourceKey = yield* Ref.get(issuedSourceKey);
            if (Option.isNone(relaySource) || Option.isNone(sourceKey)) {
              return yield* unavailable();
            }
            const bindings = yield* Schema.decodeEffect(Schema.Array(GatewayRelaySourceBindingSchema))([
              { ...relaySource.value, providerKeyId: sourceKey.value },
            ]).pipe(
              Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Array(GatewayRelaySourceBindingSchema)))),
              Effect.mapError(unavailable),
            );
            yield* keys.clearPendingCleanup(sourceKey.value);
            yield* mountRuntime(bindings);
            return yield* sendPrivate(writer, { _tag: 'ack' });
          }
          const key = yield* Ref.get(issuedKey);
          if (Option.isNone(key)) {
            return yield* unavailable();
          }
          yield* Schema.is(ShellNativeBoundCommandSchema)(command)
            ? keys.clearPendingCleanup(key.value)
            : keys.setEnabled(key.value, command.enabled);
          return yield* sendPrivate(writer, { _tag: 'ack' });
        }).pipe(Effect.catch(() => sendPrivate(writer, { _tag: 'unavailable' }))),
      ),
    );
    return yield* Effect.void;
  }),
);

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* childEntry() {
      const services = yield* Layer.build(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Logger.layer([])));
      return yield* (process.argv.includes('--describe') ? describe : serve).pipe(Effect.provideContext(services));
    }),
  ),
  { disableErrorReporting: true },
);
