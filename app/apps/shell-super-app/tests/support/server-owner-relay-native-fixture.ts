import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '@app/core-runtime';
import { NodeSocketServer } from '@effect/platform-node';
import { Config, Crypto, Deferred, Effect, FileSystem, Path, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpClient } from 'effect/http';

const SHELL_APP_ID = 'shell-super-app';
const CUSTOMER_CONTEXT_APP_ID = 'commerce-customer-context';

export class PackagedOwnerStartupError extends Schema.TaggedError<PackagedOwnerStartupError>()(
  'PackagedOwnerStartupError',
  {
    reason: Schema.String,
  },
) {}

const IdentitySchema = Schema.Struct({
  appId: Schema.Literals([SHELL_APP_ID, 'party-registry', 'catalog', CUSTOMER_CONTEXT_APP_ID]),
  build: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  buildMarker: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  sourceRevision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  unitId: Schema.Literals([
    'app/shell-super-app',
    'app/party-registry',
    'app/catalog',
    'app/commerce-customer-context',
  ]),
  version: Schema.String.check(Schema.isMinLength(1)),
});
const PackagedBuildSchema = Schema.Struct({ deliveryUnit: IdentitySchema });
const ReleaseEnvelopeSchema = Schema.Struct({
  identity: Schema.Struct({
    buildMarker: IdentitySchema.fields.buildMarker,
    releaseVersion: IdentitySchema.fields.version,
    sourceRevision: IdentitySchema.fields.sourceRevision,
    unitId: IdentitySchema.fields.unitId,
  }),
  target: Schema.Literal('node'),
});
const sameIdentity = Schema.toEquivalence(IdentitySchema);
const ReadyOriginSchema = Schema.String.check(Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]*$/u));

const PACKAGED_STARTUP_PHASE = 'Packaged native startup phase';

interface PackagedApplicationInput {
  readonly appId: typeof SHELL_APP_ID | 'party-registry' | 'catalog' | typeof CUSTOMER_CONTEXT_APP_ID;
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
  readonly gateway?: {
    readonly issuer: string;
    readonly privateJwk?: Redacted.Redacted;
    readonly publicJwks: string;
  };
  readonly port?: number;
  readonly relativeDirectory: string;
  readonly relaySource?: { readonly apiKey: Redacted.Redacted; readonly shellBaseUrl: string };
  readonly sourceBindings?: Redacted.Redacted;
}

const makePackagedEnvironment = Effect.fn('ServerOwnerRelayNative.makePackagedEnvironment')(
  function* makePackagedEnvironment(input: PackagedApplicationInput) {
    const environment = {
      APP_ENV_PATH: '/dev/null',
      NODE_ENV: 'production',
      PATH: yield* Config.String('PATH'),
      PORT: String(input.authentication?.port ?? input.port ?? 0),
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
    if (input.appId === SHELL_APP_ID) {
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
    if (input.gateway !== undefined) {
      Object.assign(environment, {
        ONTOS_GATEWAY_ISSUER: input.gateway.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: input.gateway.publicJwks,
      });
      if (input.gateway.privateJwk !== undefined) {
        Object.assign(environment, { ONTOS_GATEWAY_PRIVATE_JWK: Redacted.value(input.gateway.privateJwk) });
      }
    }
    if (input.relaySource !== undefined) {
      Object.assign(environment, {
        ONTOS_GATEWAY_RELAY_API_KEY: Redacted.value(input.relaySource.apiKey),
        ONTOS_SHELL_GATEWAY_BASE_URL: input.relaySource.shellBaseUrl,
      });
    }
    if (input.sourceBindings !== undefined) {
      Object.assign(environment, { ONTOS_GATEWAY_RELAY_SOURCE_BINDINGS: Redacted.value(input.sourceBindings) });
    }
    return environment;
  },
);

export const startPackagedApplication = Effect.fn('ServerOwnerRelayNative.startPackagedApplication')(
  function* startPackagedApplication(input: PackagedApplicationInput) {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(input.relativeDirectory);
    const compiled = yield* filesystem
      .readFileString(path.join(directory, '.output', 'ultramodern-build.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PackagedBuildSchema))));
    if (compiled.deliveryUnit.appId !== input.appId) {
      return yield* new PackagedOwnerStartupError({ reason: 'Packaged application identity mismatch' });
    }
    const publishedBuild =
      input.appId === CUSTOMER_CONTEXT_APP_ID
        ? undefined
        : yield* filesystem
            .readFileString(path.join(directory, '.output', 'public', 'ultramodern-build.json'))
            .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PackagedBuildSchema))));
    const release = yield* filesystem
      .readFileString(path.join(directory, '.output', 'release', 'microvertical-release-envelope.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReleaseEnvelopeSchema))));
    const identity = compiled.deliveryUnit;
    if (
      (publishedBuild !== undefined && !sameIdentity(identity, publishedBuild.deliveryUnit)) ||
      identity.build !== identity.buildMarker ||
      release.identity.buildMarker !== identity.buildMarker ||
      release.identity.sourceRevision !== identity.sourceRevision ||
      release.identity.unitId !== identity.unitId ||
      release.identity.releaseVersion !== identity.version
    ) {
      return yield* new PackagedOwnerStartupError({
        reason: 'Compiled, public and immutable release identities disagree',
      });
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
    const environment = yield* makePackagedEnvironment(input);
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
    yield* Effect.logInfo(PACKAGED_STARTUP_PHASE, { appId: input.appId, phase: 'await-ready-address' });
    const origin = yield* Effect.raceFirst(
      Deferred.await(ready),
      child.exitCode.pipe(
        Effect.flatMap(() =>
          Effect.fail(new PackagedOwnerStartupError({ reason: 'Packaged application exited before readiness' })),
        ),
      ),
    );
    yield* Effect.logInfo(PACKAGED_STARTUP_PHASE, { appId: input.appId, phase: 'ready-address-observed' });
    const client = yield* HttpClient.HttpClient;
    const contractPath = input.appId === SHELL_APP_ID ? ONTOS_SHELL_RUNTIME_CONTRACT_PATH : ONTOS_MODULE_CONTRACT_PATH;
    const response = yield* client.get(`${origin}${contractPath}`);
    if (response.status !== 200) {
      return yield* new PackagedOwnerStartupError({ reason: 'Actual packaged contract endpoint is unavailable' });
    }
    yield* Effect.logInfo(PACKAGED_STARTUP_PHASE, {
      appId: input.appId,
      phase: 'contract-response',
      status: response.status,
    });
    const body = yield* response.json;
    const contract =
      input.appId === SHELL_APP_ID
        ? yield* Schema.decodeUnknownEffect(OntosShellRuntimeContractSchema)(body)
        : yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(body);
    if (
      input.appId === CUSTOMER_CONTEXT_APP_ID &&
      (!Schema.is(OntosModuleDeploymentContractSchema)(contract) ||
        contract.manifest.publicSurface.components.length !== 0)
    ) {
      return yield* new PackagedOwnerStartupError({ reason: 'API-only application declares a frontend surface' });
    }
    if (contract.deployment.appId !== identity.appId || contract.deployment.buildMarker !== identity.buildMarker) {
      return yield* new PackagedOwnerStartupError({
        reason: 'Actual HTTP deployment does not match immutable packaged identity',
      });
    }
    yield* Effect.logInfo(PACKAGED_STARTUP_PHASE, { appId: input.appId, phase: 'contract-identity-verified' });
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
