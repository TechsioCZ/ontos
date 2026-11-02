import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import type { DatabaseConnectionPair, TrustedPrincipalContext } from '@app/core-runtime';
import { ActionRuntime, ReadRuntime, DatabaseConfig, parseDatabaseConnectionPair } from '@app/core-runtime';
import { defineEffectBff, dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import {
  ConfigProvider,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';

import { NodeHttpServer } from '@effect/platform-node';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { storefrontRegistryApiRuntimeFromContext } from '../../api/index.ts';
import { storefrontRegistryApiContract } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

import type { RegisterStorefrontApplicationPayloadSchema } from '../../shared/actions/register-storefront-application.ts';
import { registerStorefrontApplicationAction } from '../../src/actions/register-storefront-application.action.ts';

export class CurrentStorefrontNativeFixtureError extends Schema.TaggedError<CurrentStorefrontNativeFixtureError>()(
  'CurrentStorefrontNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

const unavailable = (cause?: unknown) =>
  new CurrentStorefrontNativeFixtureError({
    cause: Redacted.make(cause),
    reason: 'The scoped Registry test fixture is unavailable',
  });
const configurationSchema = Schema.Struct({
  compositionSourceUrl: Schema.URLFromString,
  issuer: Schema.URLFromString,
  publicJwks: Schema.String.check(Schema.isMinLength(1)),
});
export interface CurrentStorefrontNativeFixtureOptions {
  readonly compositionRevision: string;
  readonly compositionSourceUrl: string;
  readonly issuer: string;
  readonly principal: TrustedPrincipalContext;
  readonly publicJwks: string;
  readonly storefrontAppId: string;
}

/**
 * Owner-local component fixture. The real verifier and native Read runtime consume each assertion.
 * Replay protection uses the actual owner-native durable redemption adapter in the owned database.
 * Database migration and exact resource grants remain with the caller's owned test infrastructure.
 */
export const makeCurrentStorefrontNativeFixture = Effect.fn('CurrentStorefrontNativeFixture.make')(
  function* makeCurrentStorefrontNativeFixture(options: CurrentStorefrontNativeFixtureOptions) {
    const configuration = yield* Schema.decodeUnknownEffect(configurationSchema)(options).pipe(
      Effect.mapError(unavailable),
    );
    if (!/^[a-f0-9]{64}$/u.test(options.compositionRevision) || options.storefrontAppId.length === 0) {
      return yield* unavailable();
    }
    const actionRuntime = yield* ActionRuntime;
    const readRuntime = yield* ReadRuntime;
    const closed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() => Ref.set(closed, true));
    const redemption = yield* Layer.build(
      GatewayAssertionRedemptionLive.pipe(Layer.provide(GatewayAssertionRedemptionDatabaseLive)),
    );
    // Static imports describe the owner runtime; acquire it only after validated fixture setup.
    const runtime = yield* storefrontRegistryApiRuntimeFromContext.pipe(
      Effect.provideService(ReadRuntime, readRuntime),
      Effect.provideService(ActionRuntime, actionRuntime),
      Effect.provideContext(redemption),
      Effect.catchDefect((cause) => Effect.fail(unavailable(cause))),
      Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.fail(unavailable()) }),
    );
    const configured = defineEffectBff({
      api: runtime.api,
      layer: runtime.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({
              ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: configuration.compositionSourceUrl.href,
              ONTOS_GATEWAY_ISSUER: options.issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: options.publicJwks,
            }),
          ),
        ),
      ),
    });
    const handler = yield* Effect.acquireRelease(
      Effect.promise(resolveEffectBffModuleHandler.bind(undefined, { default: configured }, {})).pipe(
        Effect.flatMap((value) => (value === null ? Effect.fail(unavailable()) : Effect.succeed(value))),
      ),
      (value) => (value.dispose === undefined ? Effect.void : Effect.promise(value.dispose).pipe(Effect.orDie)),
    );
    const ensureOpen = Ref.get(closed).pipe(
      Effect.flatMap((current) => (current ? Effect.fail(unavailable()) : Effect.void)),
    );
    return Object.freeze({
      dispatch: (request: Request) =>
        ensureOpen.pipe(
          Effect.andThen(
            Effect.tryPromise({
              catch: unavailable,
              try: dispatchEffectBffRequest.bind(
                undefined,
                handler.handler,
                request,
                new URL(request.url).pathname.startsWith(`${storefrontRegistryApiContract.apiPrefix}/`)
                  ? { prefix: storefrontRegistryApiContract.apiPrefix }
                  : {},
              ),
            }).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.fail(unavailable()) })),
          ),
        ),
      register: Effect.fn('CurrentStorefrontNativeFixture.register')(function* register(
        input: typeof RegisterStorefrontApplicationPayloadSchema.Encoded,
      ) {
        yield* ensureOpen;
        if (input.storefrontAppId !== options.storefrontAppId) {
          return yield* unavailable();
        }
        return yield* actionRuntime.runAction({
          payload: input,
          principal: options.principal,
          registration: registerStorefrontApplicationAction,
          transport: {
            correlationId: 'registry-native-register',
            idempotencyKey: `registry-native:${options.storefrontAppId}`,
          },
        });
      }),
    });
  },
);

interface RegistryNativeConnectionOptions {
  readonly adminConnectionString: Redacted.Redacted;
  readonly runtimeConnectionString: Redacted.Redacted;
}

/** Allocate the receiving address before sealing the immutable cross-owner test composition. */
export const makeCurrentStorefrontNativeReceiver = Effect.fn('CurrentStorefrontNativeReceiver.make')(
  function* makeCurrentStorefrontNativeReceiver() {
    const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
      return yield* unavailable();
    }
    type Fixture = Effect.Success<ReturnType<typeof makeCurrentStorefrontNativeFixture>>;
    const installed = yield* Ref.make(Option.none<Fixture>());
    const activated = yield* Ref.make(false);
    const ownedRuntime = yield* Ref.make(Option.none<DatabaseConnectionPair['runtime']>());
    const closed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() =>
      Effect.all([Ref.set(closed, true), Ref.set(ownedRuntime, Option.none()), Ref.set(installed, Option.none())], {
        concurrency: 1,
        discard: true,
      }),
    );
    const ensureOpen = Ref.get(closed).pipe(
      Effect.flatMap((value) => (value ? Effect.fail(unavailable()) : Effect.void)),
    );
    yield* server.serve(
      Effect.gen(function* receiveOriginalOwnerHttp() {
        const fixture = yield* Ref.get(installed);
        if (Option.isNone(fixture)) {
          return HttpServerResponse.empty({ status: 503 });
        }
        const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
        return HttpServerResponse.fromWeb(yield* fixture.value.dispatch(request));
      }),
    );
    return Object.freeze({
      activate: Effect.fn('CurrentStorefrontNativeReceiver.activate')(function* activate(
        options: CurrentStorefrontNativeFixtureOptions,
      ) {
        yield* ensureOpen;
        if (yield* Ref.getAndSet(activated, true)) {
          return yield* unavailable();
        }
        const configuration = yield* Ref.get(ownedRuntime);
        if (Option.isNone(configuration)) {
          return yield* unavailable();
        }
        const fixture = yield* makeCurrentStorefrontNativeFixture(options).pipe(
          Effect.provideService(DatabaseConfig, configuration.value),
        );
        yield* Ref.set(installed, Option.some(fixture));
        return fixture;
      }),
      baseUrl: `http://127.0.0.1:${server.address.port}/`,
      deployment: Object.freeze({ appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker }),
      migrate: Effect.fn('CurrentStorefrontNativeReceiver.migrate')(function* migrate(
        options: RegistryNativeConnectionOptions,
      ) {
        yield* ensureOpen;
        const connections = yield* parseDatabaseConnectionPair({
          DATABASE_ADMIN_URL: Redacted.value(options.adminConnectionString),
          DATABASE_URL: Redacted.value(options.runtimeConnectionString),
        }).pipe(Effect.mapError(unavailable));
        if (
          !connections.admin.database.startsWith('ontos_test_party_gateway_') ||
          connections.admin.database !== connections.runtime.database
        ) {
          return yield* unavailable();
        }
        const filesystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-1250-registry-' });
        const configuration = path.join(temporary, 'drizzle.config.mjs');
        yield* filesystem.writeFileString(
          configuration,
          `export default { dialect: 'postgresql', out: process.env.ONTOS_1250_REGISTRY_MIGRATIONS, schema: process.env.ONTOS_1250_REGISTRY_SCHEMA, dbCredentials: { url: process.env.DATABASE_ADMIN_URL }, migrations: { schema: 'drizzle', table: '__drizzle_migrations_storefront_registry' } };`,
        );
        const process = yield* ChildProcess.make(
          'mise',
          [
            'exec',
            '--',
            'pnpm',
            '--filter',
            '@app/storefront-registry',
            'exec',
            'drizzle-kit',
            'migrate',
            '--config',
            configuration,
          ],
          {
            cwd: new URL('../../../../', import.meta.url).pathname,
            env: {
              DATABASE_ADMIN_URL: connections.admin.connectionString,
              ONTOS_1250_REGISTRY_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
              ONTOS_1250_REGISTRY_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
            },
            extendEnv: true,
            stderr: 'pipe',
            stdout: 'pipe',
          },
        );
        const [exit] = yield* Effect.all(
          [process.exitCode, Stream.runDrain(process.stdout), Stream.runDrain(process.stderr)],
          { concurrency: 3 },
        );
        if (Number(exit) !== 0) {
          return yield* unavailable();
        }
        yield* Ref.set(ownedRuntime, Option.some(connections.runtime));
        return yield* Effect.void;
      }),
    });
  },
);
