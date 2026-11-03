import {
  PrincipalIdSchema,
  TenantIdSchema,
  ProviderSubjectIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  ActionRuntime,
  ActiveApplicationCompositionSnapshotSchema,
  bindSelfApiKeyAction,
  parseDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { GatewayContextRequestSchema, GatewayContextResponseSchema } from '@app/shared-contracts';
import { NodeHttpServer, NodeSocketServer } from '@effect/platform-node';
import {
  Context,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Deferred,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Socket } from 'effect/socket';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { exportJWK, generateKeyPair } from 'jose';

import { OwnedAuthRuntimeContract, OwnedAuthRuntimeContractLive } from '../support/api-key-gateway-auth-runtime.ts';
import type { ShellNativeOwnedDatabase } from '../support/api-key-gateway-auth-runtime.ts';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

export class ApiKeyGatewayNativeFixtureError extends Schema.TaggedError<ApiKeyGatewayNativeFixtureError>()(
  'ApiKeyGatewayNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new ApiKeyGatewayNativeFixtureError({
    cause: Redacted.make(cause),
    reason: 'The scoped Shell gateway test fixture is unavailable',
  });
const appRoot = new URL('../../../../', import.meta.url).pathname;
export interface ApiKeyGatewayNativeFixtureOptions {
  readonly ownedDatabase: ShellNativeOwnedDatabase;
  readonly relaySource?: { readonly sourceAppId: 'commerce-market-catalog' };
  readonly snapshotJson: string;
}
export const ShellNativeRelaySourceSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  sourceAppId: Schema.Literal('commerce-market-catalog'),
  sourceBuildMarker: Schema.String.check(Schema.isMinLength(1)),
});
export const ShellNativeChildReadySchema = Schema.Struct({
  baseUrl: Schema.String,
  providerUserId: ProviderSubjectIdSchema,
  relaySourceProviderUserId: Schema.optionalKey(ProviderSubjectIdSchema),
});
export const ShellNativeIssueCommandSchema = Schema.TaggedStruct('issue', {
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export const ShellNativeSessionGatewayCommandSchema = Schema.TaggedStruct('session-gateway', {
  request: GatewayContextRequestSchema,
});
export const ShellNativeSessionGatewayResponseSchema = Schema.TaggedStruct('session-gateway', {
  gateway: GatewayContextResponseSchema,
});
export const ShellNativeBoundCommandSchema = Schema.TaggedStruct('bound', {});
export const ShellNativeRelaySourceIssueCommandSchema = Schema.TaggedStruct('relay-source-issue', {
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export const ShellNativeRelaySourceBoundCommandSchema = Schema.TaggedStruct('relay-source-bound', {});
export const ShellNativeChildCommandSchema = Schema.Union([
  ShellNativeIssueCommandSchema,
  ShellNativeSessionGatewayCommandSchema,
  ShellNativeBoundCommandSchema,
  ShellNativeRelaySourceIssueCommandSchema,
  ShellNativeRelaySourceBoundCommandSchema,
  Schema.TaggedStruct('enabled', { enabled: Schema.Boolean }),
]);
export const ShellNativeIssuedResponseSchema = Schema.TaggedStruct('issued', {
  providerKeyId: ProviderSubjectIdSchema,
  secret: Schema.String,
});
export const ShellNativeUnavailableResponseSchema = Schema.TaggedStruct('unavailable', {});
export const ShellNativeChildResponseSchema = Schema.Union([
  ShellNativeIssuedResponseSchema,
  ShellNativeSessionGatewayResponseSchema,
  Schema.TaggedStruct('ack', {}),
  ShellNativeUnavailableResponseSchema,
]);
const publicJwkSchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  kid: Schema.String,
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Schema.String,
});
const privateJwkSchema = Schema.Struct({ ...publicJwkSchema.fields, d: Schema.String });
const requestTimeout = Effect.timeoutOrElse({
  duration: Duration.seconds(20),
  orElse: () => Effect.fail(unavailable()),
});
export { makeCompositionSnapshot as makeApiKeyGatewayNativeComposition } from './application-composition.ts';

const bundleChild = Effect.fn('ApiKeyGatewayNativeFixture.bundle')(function* bundleChild() {
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new URL('../../node_modules/.cache/ontos-1250/', import.meta.url).pathname;
  yield* filesystem.makeDirectory(cache, { recursive: true });
  const temporary = yield* filesystem.makeTempDirectoryScoped({ directory: cache, prefix: 'shell-' });
  const artifact = path.join(temporary, 'gateway.mjs');
  const bundle = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      new URL('../support/api-key-gateway-native-child.ts', import.meta.url).pathname,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${artifact}`,
    ],
    { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [exit] = yield* Effect.all([bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)], {
    concurrency: 3,
  });
  if (Number(exit) !== 0) {
    return yield* unavailable();
  }
  return artifact;
});

const migrateAuth = Effect.fn('ApiKeyGatewayNativeFixture.migrateAuth')(function* migrateAuth(adminUrl: string) {
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-1250-auth-' });
  const configuration = path.join(temporary, 'drizzle.config.mjs');
  yield* filesystem.writeFileString(
    configuration,
    `export default { dialect: 'postgresql', out: process.env.ONTOS_1250_AUTH_MIGRATIONS, schema: process.env.ONTOS_1250_AUTH_SCHEMA, dbCredentials: { url: process.env.DATABASE_ADMIN_URL }, migrations: { schema: 'drizzle', table: '__drizzle_migrations_auth' } };`,
  );
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/shell-super-app',
      'exec',
      'drizzle-kit',
      'migrate',
      '--config',
      configuration,
    ],
    {
      cwd: appRoot,
      env: {
        DATABASE_ADMIN_URL: adminUrl,
        ONTOS_1250_AUTH_MIGRATIONS: new URL('../../drizzle-auth/', import.meta.url).pathname,
        ONTOS_1250_AUTH_SCHEMA: new URL('../../api/auth/db/schema.ts', import.meta.url).pathname,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [exit] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (Number(exit) !== 0) {
    return yield* unavailable();
  }
  return yield* Effect.void;
});

/** Closed TEST protocol only: the parent owns this listener before starting its Shell child. */
export const openShellNativePrivateChannel = Effect.fn('ShellNativePrivateChannel.open')(
  function* openShellNativePrivateChannel() {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 's1250-' });
    yield* fs.chmod(temporary, 0o700);
    const directory = yield* fs.realPath(temporary);
    const socketPath = `${directory}/native.sock`;
    if (new TextEncoder().encode(socketPath).length > 96) {
      return yield* unavailable();
    }
    const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(Effect.mapError(unavailable));
    const writer = yield* Deferred.make<Socket.Writer>();
    const responses = yield* Queue.unbounded<typeof ShellNativeChildResponseSchema.Type>();
    const failure = yield* Deferred.make<never, ApiKeyGatewayNativeFixtureError>();
    const connected = yield* Ref.make(false);
    const closing = yield* Ref.make(false);
    const close = Ref.set(closing, true).pipe(Effect.andThen(Deferred.fail(failure, unavailable())), Effect.asVoid);
    yield* Effect.forkScoped(
      server
        .run((socket) =>
          Effect.scoped(
            Effect.gen(function* readPrivateResponses() {
              if (yield* Ref.getAndSet(connected, true)) {
                return yield* unavailable();
              }
              yield* Deferred.succeed(writer, yield* socket.writer);
              yield* Socket.toStream(socket).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.mapEffect((line) =>
                  new TextEncoder().encode(line).length > 65_536
                    ? Effect.fail(unavailable())
                    : Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildResponseSchema))(line).pipe(
                        Effect.mapError(unavailable),
                      ),
                ),
                Stream.runForEach((response) => Queue.offer(responses, response)),
              );
              return yield* Deferred.fail(failure, unavailable());
            }),
          ).pipe(
            Effect.catchIf(
              (error) =>
                Socket.isSocketError(error) &&
                Schema.is(Socket.SocketCloseError)(error.reason) &&
                error.reason.code === 1000,
              (error) =>
                Ref.get(closing).pipe(Effect.flatMap((expected) => (expected ? Effect.void : Effect.fail(error)))),
            ),
            Effect.tapError((error) => Deferred.fail(failure, unavailable(error))),
          ),
        )
        .pipe(Effect.catch((error) => Deferred.fail(failure, unavailable(error)))),
    );
    yield* Effect.addFinalizer(() => close.pipe(Effect.andThen(Queue.shutdown(responses))));
    return Object.freeze({
      close,
      exchange: Effect.fn('ShellNativePrivateChannel.exchange')(function* exchange(
        command: typeof ShellNativeChildCommandSchema.Encoded,
      ) {
        if (yield* Ref.get(closing)) {
          return yield* unavailable();
        }
        const line = yield* Schema.decodeUnknownEffect(ShellNativeChildCommandSchema)(command).pipe(
          Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildCommandSchema))),
          Effect.mapError(unavailable),
        );
        const send = Effect.gen(function* sendClosedCommand() {
          const output = yield* Deferred.await(writer);
          yield* output.write(`${line}\n`).pipe(Effect.mapError(unavailable));
          return yield* Queue.take(responses);
        });
        return yield* Effect.raceFirst(send, Deferred.await(failure)).pipe(requestTimeout);
      }),
      socketPath,
    });
  },
);

/** Scope-owned process and private Unix socket protocol; no credentials enter readiness/stdout. */
export const makeApiKeyGatewayNativeFixture = Effect.fn('ApiKeyGatewayNativeFixture.make')(
  function* makeApiKeyGatewayNativeFixture(options: ApiKeyGatewayNativeFixtureOptions) {
    const pair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: options.ownedDatabase.connections.admin.connectionString,
      DATABASE_URL: options.ownedDatabase.connections.runtime.connectionString,
    }).pipe(Effect.mapError(unavailable));
    if (!pair.admin.database.startsWith('ontos_test_party_gateway_') || pair.admin.database !== pair.runtime.database) {
      return yield* unavailable();
    }
    const snapshot = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
    )(options.snapshotJson).pipe(Effect.mapError(unavailable));
    yield* validateActiveApplicationCompositionSnapshot(snapshot).pipe(Effect.mapError(unavailable));
    if (
      snapshot.composition.shell.deployment.appId !== ultramodernDeliveryUnit.appId ||
      snapshot.composition.shell.deployment.buildMarker !== ultramodernDeliveryUnit.buildMarker
    ) {
      return yield* unavailable();
    }
    const sourceDeployment =
      options.relaySource === undefined
        ? undefined
        : snapshot.composition.modules.find(({ deployment }) => deployment.appId === options.relaySource?.sourceAppId)
            ?.deployment;
    if (options.relaySource !== undefined && sourceDeployment === undefined) {
      return yield* unavailable();
    }
    const relaySource: typeof ShellNativeRelaySourceSchema.Type | undefined =
      sourceDeployment === undefined
        ? undefined
        : {
            compositionRevision: snapshot.composition.revision,
            sourceAppId: 'commerce-market-catalog',
            sourceBuildMarker: sourceDeployment.buildMarker,
          };
    const authRuntime = Context.get(
      yield* Layer.build(OwnedAuthRuntimeContractLive(options.ownedDatabase, snapshot.composition.revision)).pipe(
        Effect.mapError(unavailable),
      ),
      OwnedAuthRuntimeContract,
    );
    const artifact = yield* bundleChild();
    yield* migrateAuth(Redacted.value(authRuntime.adminConnectionString));
    yield* authRuntime.establish().pipe(Effect.mapError(unavailable));
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const secret = `${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`;
    const source = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(source.address)) {
      return yield* unavailable();
    }
    yield* source.serve(
      Effect.succeed(HttpServerResponse.text(options.snapshotJson, { contentType: 'application/json' })),
    );
    const sourceUrl = `http://127.0.0.1:${source.address.port}/composition`;
    const signing = yield* Effect.tryPromise({
      catch: unavailable,
      try: generateKeyPair.bind(undefined, 'EdDSA', { crv: 'Ed25519', extractable: true }),
    }).pipe(requestTimeout);
    const privateKey = yield* Effect.tryPromise({
      catch: unavailable,
      try: exportJWK.bind(undefined, signing.privateKey),
    }).pipe(requestTimeout);
    const publicKey = yield* Effect.tryPromise({
      catch: unavailable,
      try: exportJWK.bind(undefined, signing.publicKey),
    }).pipe(requestTimeout);
    const kid = `fixture-${suffix}`;
    const issuer = 'https://shell-native.fixture.invalid';
    const privateJwk = yield* Schema.decodeUnknownEffect(privateJwkSchema)({
      ...privateKey,
      alg: 'EdDSA',
      kid,
      use: 'sig',
    }).pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(privateJwkSchema))), Effect.mapError(unavailable));
    const publicJwks = yield* Schema.decodeUnknownEffect(Schema.Struct({ keys: Schema.Array(publicJwkSchema) }))({
      keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }],
    }).pipe(
      Effect.flatMap(
        Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(publicJwkSchema) }))),
      ),
      Effect.mapError(unavailable),
    );
    const privateChannel = yield* openShellNativePrivateChannel();
    yield* authRuntime.assertCurrent().pipe(Effect.mapError(unavailable));
    const child = yield* ChildProcess.make(process.execPath, [artifact], {
      cwd: appRoot,
      env: {
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: 'http://shell-native.localhost',
        DATABASE_ADMIN_URL: Redacted.value(authRuntime.adminConnectionString),
        DATABASE_URL: Redacted.value(authRuntime.runtimeConnectionString),
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: sourceUrl,
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PRIVATE_JWK: privateJwk,
        ONTOS_GATEWAY_PUBLIC_JWKS: publicJwks,
        ONTOS_SHELL_NATIVE_RELAY_SOURCE: yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.OptionFromNullOr(ShellNativeRelaySourceSchema)),
        )(relaySource === undefined ? Option.none() : Option.some(relaySource)),
        ONTOS_SHELL_NATIVE_SOCKET: privateChannel.socketPath,
      },
      // Inherit the configured native runner's TLS permission environment; every DB/auth destination above is owned.
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    // Register after the process: mark intentional disposal before process/socket finalizers run.
    yield* Effect.addFinalizer(() => privateChannel.close);
    yield* Effect.forkScoped(Stream.runDrain(child.stderr));
    const line = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead, requestTimeout);
    if (Option.isNone(line)) {
      return yield* unavailable();
    }
    const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildReadySchema))(
      line.value,
    ).pipe(Effect.mapError(unavailable));
    const closed = yield* Ref.make(false);
    const issuedOnce = yield* Ref.make(false);
    const sourceIssuedOnce = yield* Ref.make(false);
    const boundPrincipal = yield* Ref.make(Option.none<TrustedPrincipalContext>());
    yield* Effect.addFinalizer(() => Ref.set(closed, true).pipe(Effect.asVoid));
    const ensureOpen = Ref.get(closed).pipe(
      Effect.flatMap((value) => (value ? Effect.fail(unavailable()) : Effect.void)),
    );
    const exchange = Effect.fn('ApiKeyGatewayNativeFixture.exchange')(function* exchange(
      command: typeof ShellNativeChildCommandSchema.Encoded,
    ) {
      yield* ensureOpen;
      const response = yield* Effect.raceFirst(
        privateChannel.exchange(command),
        child.exitCode.pipe(Effect.flatMap(() => Effect.fail(unavailable()))),
      );
      if (Schema.is(ShellNativeUnavailableResponseSchema)(response)) {
        return yield* unavailable();
      }
      return response;
    });
    return Object.freeze({
      baseUrl: ready.baseUrl,
      compositionSourceUrl: sourceUrl,
      issueAndBind: Effect.fn('ApiKeyGatewayNativeFixture.issueAndBind')(function* issueAndBind(
        principal: TrustedPrincipalContext,
      ) {
        yield* ensureOpen;
        if (yield* Ref.getAndSet(issuedOnce, true)) {
          return yield* unavailable();
        }
        const issued = yield* exchange({
          _tag: 'issue',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        });
        if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
          return yield* unavailable();
        }
        const credential = Redacted.make(issued.secret);
        const runtime = yield* ActionRuntime;
        const binding = yield* runtime.runAction({
          payload: { providerSubjectId: issued.providerKeyId },
          principal,
          registration: bindSelfApiKeyAction,
          transport: {
            correlationId: 'native-gateway-bind',
            idempotencyKey: `native-gateway-bind:${issued.providerKeyId}`,
          },
        });
        yield* exchange({ _tag: 'bound' });
        yield* Ref.set(boundPrincipal, Option.some(principal));
        return Object.freeze({
          authBindingId: binding.authBindingId,
          secret: credential,
          setEnabled: (enabled: boolean) => exchange({ _tag: 'enabled', enabled }).pipe(Effect.asVoid),
        });
      }),
      issuer,
      issueRelaySourceAndBind: Effect.fn('ApiKeyGatewayNativeFixture.issueRelaySourceAndBind')(
        function* issueRelaySourceAndBind(principal: TrustedPrincipalContext) {
          yield* ensureOpen;
          const actor = yield* Ref.get(boundPrincipal);
          if (
            relaySource === undefined ||
            ready.relaySourceProviderUserId === undefined ||
            Option.isNone(actor) ||
            actor.value.principalId === principal.principalId ||
            actor.value.tenantId !== principal.tenantId ||
            (yield* Ref.getAndSet(sourceIssuedOnce, true))
          ) {
            return yield* unavailable();
          }
          const issued = yield* exchange({
            _tag: 'relay-source-issue',
            principalId: principal.principalId,
            tenantId: principal.tenantId,
          });
          if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
            return yield* unavailable();
          }
          const sourceCredential = Redacted.make(issued.secret);
          const runtime = yield* ActionRuntime;
          const binding = yield* runtime.runAction({
            payload: { providerSubjectId: issued.providerKeyId },
            principal,
            registration: bindSelfApiKeyAction,
            transport: {
              correlationId: 'native-relay-source-bind',
              idempotencyKey: `native-relay-source-bind:${issued.providerKeyId}`,
            },
          });
          yield* exchange({ _tag: 'relay-source-bound' });
          return Object.freeze({
            ...relaySource,
            authBindingId: binding.authBindingId,
            principalId: principal.principalId,
            providerKeyId: issued.providerKeyId,
            secret: sourceCredential,
          });
        },
      ),
      providerUserId: ready.providerUserId,
      publicJwks,
      relaySourceProviderUserId: ready.relaySourceProviderUserId,
    });
  },
);

export { sealComposition as sealApiKeyGatewayNativeComposition } from './application-composition.ts';
