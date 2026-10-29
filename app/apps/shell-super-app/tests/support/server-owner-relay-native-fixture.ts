import { NodeSocketServer } from '@effect/platform-node';
import { Config, Crypto, Deferred, Effect, FileSystem, Path, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

export class PackagedOwnerStartupError extends Schema.TaggedError<PackagedOwnerStartupError>()(
  'PackagedOwnerStartupError',
  {
    reason: Schema.String,
  },
) {}

const IdentitySchema = Schema.Struct({
  appId: Schema.Literals(['shell-super-app', 'party-registry', 'catalog']),
  buildMarker: Schema.String.check(Schema.isMinLength(1)),
  sourceRevision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
});
const PackagedBuildSchema = Schema.Struct({ deliveryUnit: IdentitySchema });
const ReadyOriginSchema = Schema.String.check(Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]*$/u));

export const startPackagedApplication = Effect.fn('ServerOwnerRelayNative.startPackagedApplication')(
  function* startPackagedApplication(input: {
    readonly appId: 'shell-super-app' | 'party-registry' | 'catalog';
    readonly authentication?: {
      readonly baseUrl: string;
      readonly connectionString: Redacted.Redacted;
      readonly issuerConnectionString: Redacted.Redacted;
      readonly port: number;
      readonly secret: Redacted.Redacted;
      readonly spice: {
        readonly caCertificate: string;
        readonly endpoint: string;
        readonly preSharedKey: Redacted.Redacted;
      };
    };
    readonly compositionUrl?: string;
    readonly relativeDirectory: string;
  }) {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(input.relativeDirectory);
    const compiled = yield* filesystem
      .readFileString(path.join(directory, '.output', 'ultramodern-build.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PackagedBuildSchema))));
    if (compiled.deliveryUnit.appId !== input.appId) {
      return yield* new PackagedOwnerStartupError({ reason: 'Packaged application identity mismatch' });
    }
    const routes = yield* filesystem.readFileString(path.join(directory, '.output', 'route.json')).pipe(
      Effect.flatMap(
        Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              routes: Schema.Array(
                Schema.Struct({ isApi: Schema.optionalKey(Schema.Boolean), urlPath: Schema.String }),
              ),
            }),
          ),
        ),
      ),
    );
    const apiRoute = routes.routes.find((route) => route.isApi === true);
    if (apiRoute === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'Packaged API prefix is missing' });
    }
    const environment = {
      APP_ENV_PATH: '/dev/null',
      NODE_ENV: 'production',
      PATH: yield* Config.String('PATH'),
      PORT: String(input.authentication?.port ?? 0),
      SPICEDB_CA_CERT: yield* Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: yield* Config.String('SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Redacted.value(yield* Config.Redacted('SPICEDB_PRESHARED_KEY')),
    };
    if (input.appId === 'party-registry') {
      Object.assign(environment, {
        PARTY_REGISTRY_DATABASE_URL: Redacted.value(yield* Config.Redacted('PARTY_REGISTRY_DATABASE_URL')),
      });
    } else {
      Object.assign(environment, { DATABASE_URL: Redacted.value(yield* Config.Redacted('DATABASE_URL')) });
    }
    if (input.appId === 'shell-super-app') {
      const crypto = yield* Crypto.Crypto;
      const anonymousSecret = yield* crypto.randomUUIDv4();
      Object.assign(environment, {
        BETTER_AUTH_SECRET: anonymousSecret,
        BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3020',
        BETTER_AUTH_URL: 'http://localhost:3020',
        SHELL_GATEWAY_ISSUER_DATABASE_URL: Redacted.value(yield* Config.Redacted('SHELL_GATEWAY_ISSUER_DATABASE_URL')),
      });
    }
    if (input.authentication !== undefined) {
      Object.assign(environment, {
        BETTER_AUTH_SECRET: Redacted.value(input.authentication.secret),
        BETTER_AUTH_TRUSTED_ORIGINS: input.authentication.baseUrl,
        BETTER_AUTH_URL: input.authentication.baseUrl,
        DATABASE_URL: Redacted.value(input.authentication.connectionString),
        SHELL_GATEWAY_ISSUER_DATABASE_URL: Redacted.value(input.authentication.issuerConnectionString),
        SPICEDB_CA_CERT: input.authentication.spice.caCertificate,
        SPICEDB_ENDPOINT: input.authentication.spice.endpoint,
        SPICEDB_PRESHARED_KEY: Redacted.value(input.authentication.spice.preSharedKey),
      });
    }
    if (input.compositionUrl !== undefined) {
      Object.assign(environment, { ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: input.compositionUrl });
    }
    const child = yield* ChildProcess.make('node', ['.output/index.js'], {
      cwd: directory,
      env: environment,
      extendEnv: false,
      forceKillAfter: '3 seconds',
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    const diagnostics: Redacted.Redacted[] = [];
    const ready = yield* Deferred.make<string, PackagedOwnerStartupError>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const candidate = /Server is listening on (?<origin>http:\/\/[^\s]+)/u.exec(line)?.groups?.['origin'];
        if (candidate === undefined) {
          return Effect.sync(() => {
            diagnostics.push(Redacted.make(line));
          });
        }
        return Schema.decodeEffect(ReadyOriginSchema)(candidate).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Deferred.fail(ready, new PackagedOwnerStartupError({ reason: 'Invalid packaged application address' })),
            onSuccess: (origin) => Deferred.succeed(ready, origin),
          }),
        );
      }),
      Effect.forkScoped,
    );
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          diagnostics.push(Redacted.make(line));
        }),
      ),
      Effect.forkScoped,
    );
    const origin = yield* Effect.raceFirst(
      Deferred.await(ready),
      child.exitCode.pipe(
        Effect.flatMap(() =>
          Effect.fail(new PackagedOwnerStartupError({ reason: 'Packaged application exited before readiness' })),
        ),
      ),
    );
    return { apiPrefix: apiRoute.urlPath, child, compiled: compiled.deliveryUnit, diagnostics, origin };
  },
);

export const allocateLoopbackPort = Effect.fn('ServerOwnerRelayNative.allocateLoopbackPort')(
  function* allocateLoopbackPort() {
    return yield* Effect.scoped(
      Effect.gen(function* reserveLoopbackPort() {
        const server = yield* NodeSocketServer.make({ host: 'localhost', port: 0 });
        const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address);
        return address.port;
      }),
    );
  },
);
