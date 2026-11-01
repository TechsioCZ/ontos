import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { GatewayContextV2ClaimsSchema, GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';
import type { GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { jwtVerify } from 'jose';
import { NodeSocketServer } from '@effect/platform-node';
import { Config, Crypto, Deferred, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpClient } from 'effect/http';

import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';

const SHELL_APP_ID = 'shell-super-app';
const CUSTOMER_CONTEXT_APP_ID = 'commerce-customer-context';
const MARKET_APP_ID = 'commerce-market-catalog';

export class PackagedOwnerStartupError extends Schema.TaggedError<PackagedOwnerStartupError>()(
  'PackagedOwnerStartupError',
  {
    reason: Schema.String,
  },
) {}

const IdentitySchema = Schema.Struct({
  appId: Schema.Literals([SHELL_APP_ID, 'party-registry', 'catalog', CUSTOMER_CONTEXT_APP_ID, MARKET_APP_ID]),
  build: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  buildMarker: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  sourceRevision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  unitId: Schema.Literals([
    'app/shell-super-app',
    'app/party-registry',
    'app/catalog',
    'app/commerce-customer-context',
    'app/commerce-market-catalog',
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
  readonly appId:
    | typeof SHELL_APP_ID
    | 'party-registry'
    | 'catalog'
    | typeof CUSTOMER_CONTEXT_APP_ID
    | typeof MARKET_APP_ID;
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

interface FixtureStorefrontActor {
  readonly authBindingId: string;
  readonly authContextRef: Redacted.Redacted;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

interface FixtureStorefrontGatewayInput<Failure, Requirements> {
  readonly actor: FixtureStorefrontActor;
  readonly buildMarker: string;
  readonly compositionRevision: string;
  readonly gateway: {
    readonly issuer: string;
    readonly publicKey: CryptoKey;
  };
  readonly personalProof: Effect.Effect<Redacted.Redacted, Failure, Requirements>;
  readonly storefrontId: string;
}

interface FixtureStorefrontGatewayAuthorization {
  readonly authorization: Redacted.Redacted;
  readonly compositionRevision: string;
  readonly expiresAt: number;
  readonly fixtureTrust: 'OWNER_FIXTURE_TRUSTED_STOREFRONT_ONLY';
  readonly principal: GatewayTrustedPrincipalContext;
  readonly sourceJti: string;
}

const matchesFixtureStorefrontActor = (principal: GatewayTrustedPrincipalContext, actor: FixtureStorefrontActor) =>
  principal.authMethod === 'api_key' &&
  principal.authenticationNamespaceId === STAFF_AUTHENTICATION_NAMESPACE_ID &&
  principal.principalId === actor.principalId &&
  principal.tenantId === actor.tenantId &&
  principal.legalEntityId === actor.legalEntityId &&
  principal.authBindingId === actor.authBindingId &&
  principal.authContextRef === Redacted.value(actor.authContextRef) &&
  principal.impersonatedByPrincipalId === undefined;

const fixtureSigningFailure = () =>
  new PackagedOwnerStartupError({ reason: 'Qualified Storefront fixture issuance failed closed' });

/**
 * The Storefront precondition is owned by this fixture, not a production authentication producer.
 * Every other identity field comes from fresh actual personal-key issuance and is checked unchanged.
 */
export const issueFixtureStorefrontGatewayAuthorization = Effect.fn(
  'ServerOwnerRelayNative.issueFixtureStorefrontGatewayAuthorization',
)(function* issueFixtureStorefrontGatewayAuthorization<Failure, Requirements>(
  input: FixtureStorefrontGatewayInput<Failure, Requirements>,
): Effect.fn.Return<
  FixtureStorefrontGatewayAuthorization,
  Failure | PackagedOwnerStartupError,
  Requirements | GatewayIssuer
> {
  const originalAuthorization = yield* input.personalProof;
  const token = /^Bearer (?<token>[^\s]+)$/iu.exec(Redacted.value(originalAuthorization))?.groups?.['token'];
  if (token === undefined) {
    return yield* fixtureSigningFailure();
  }
  const verified = yield* Effect.tryPromise({
    catch: fixtureSigningFailure,
    try: async () =>
      await jwtVerify(token, input.gateway.publicKey, {
        algorithms: ['EdDSA'],
        audience: CUSTOMER_CONTEXT_APP_ID,
        issuer: input.gateway.issuer,
      }),
  });
  const source = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(verified.payload).pipe(
    Effect.mapError(fixtureSigningFailure),
  );
  if (
    !matchesFixtureStorefrontActor(source.principal, input.actor) ||
    source.principal.trustedStorefrontId !== undefined ||
    source.sub !== input.actor.principalId ||
    source.compositionRevision !== input.compositionRevision ||
    source.targetBuildMarker !== input.buildMarker
  ) {
    return yield* fixtureSigningFailure();
  }
  const principal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema, {
    onExcessProperty: 'error',
  })({ ...source.principal, trustedStorefrontId: input.storefrontId }).pipe(Effect.mapError(fixtureSigningFailure));
  const issuer = yield* GatewayIssuer;
  const issued = yield* issuer
    .issue({
      audience: CUSTOMER_CONTEXT_APP_ID,
      compositionRevision: input.compositionRevision,
      principal,
      sourceValidity: { expiresAt: source.exp, issuedAt: source.iat },
    })
    .pipe(Effect.mapError(fixtureSigningFailure));
  const signed = yield* Effect.tryPromise({
    catch: fixtureSigningFailure,
    try: async () =>
      await jwtVerify(issued.token, input.gateway.publicKey, {
        algorithms: ['EdDSA'],
        audience: CUSTOMER_CONTEXT_APP_ID,
        issuer: input.gateway.issuer,
      }),
  });
  const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(signed.payload).pipe(
    Effect.mapError(fixtureSigningFailure),
  );
  if (
    !Schema.toEquivalence(GatewayTrustedPrincipalContextSchema)(claims.principal, principal) ||
    claims.sub !== source.sub ||
    claims.jti === source.jti ||
    claims.iat !== source.iat ||
    claims.exp !== source.exp ||
    claims.compositionRevision !== source.compositionRevision ||
    claims.targetBuildMarker !== input.buildMarker ||
    issued.compositionRevision !== source.compositionRevision ||
    issued.expiresAt !== source.exp
  ) {
    return yield* fixtureSigningFailure();
  }
  return {
    authorization: Redacted.make(`Bearer ${issued.token}`),
    compositionRevision: claims.compositionRevision,
    expiresAt: claims.exp,
    fixtureTrust: 'OWNER_FIXTURE_TRUSTED_STOREFRONT_ONLY',
    principal: claims.principal,
    sourceJti: claims.jti,
  };
});

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

const PackagedRetailWorkerArtifactSchema = Schema.Struct({
  appId: Schema.Literal(CUSTOMER_CONTEXT_APP_ID),
  entry: Schema.Literal('worker.mjs'),
  ownerBuildIdentities: Schema.Array(
    Schema.Struct({
      appId: Schema.Literal(CUSTOMER_CONTEXT_APP_ID),
      buildMarker: IdentitySchema.fields.buildMarker,
      sourceRevision: IdentitySchema.fields.sourceRevision,
      unitId: Schema.Literal('app/commerce-customer-context'),
    }),
  ),
  schemaVersion: Schema.Literal(2),
  serviceId: Schema.Literal('commerce-customer-context-worker'),
  sourceRevision: IdentitySchema.fields.sourceRevision,
});

export const loadPackagedRetailWorker = Effect.fn('ServerOwnerRelayNative.loadPackagedRetailWorker')(
  function* loadPackagedRetailWorker(input: {
    readonly expected: {
      readonly appId: string;
      readonly buildMarker: string;
      readonly sourceRevision: string;
      readonly unitId: string;
    };
    readonly relativeDirectory: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(input.relativeDirectory);
    const artifact = yield* fs
      .readFileString(path.join(directory, 'worker-artifact.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PackagedRetailWorkerArtifactSchema))));
    const [owner] = artifact.ownerBuildIdentities;
    if (
      artifact.ownerBuildIdentities.length !== 1 ||
      owner === undefined ||
      owner.appId !== input.expected.appId ||
      owner.buildMarker !== input.expected.buildMarker ||
      owner.sourceRevision !== input.expected.sourceRevision ||
      owner.unitId !== input.expected.unitId ||
      artifact.sourceRevision !== owner.sourceRevision
    ) {
      return yield* new PackagedOwnerStartupError({ reason: 'Actual worker and API immutable identities disagree' });
    }
    yield* fs.stat(path.join(directory, artifact.entry));
    return { artifact, directory };
  },
);

export const startPackagedRetailWorker = Effect.fn('ServerOwnerRelayNative.startPackagedRetailWorker')(
  function* startPackagedRetailWorker(input: {
    readonly compositionReadToken?: Redacted.Redacted;
    readonly compositionUrl: string;
    readonly packaged: Effect.Success<ReturnType<typeof loadPackagedRetailWorker>>;
  }) {
    const environment = {
      APP_ENV_PATH: '/dev/null',
      DATABASE_URL: Redacted.value(yield* Config.Redacted('DATABASE_URL')),
      NODE_ENV: 'production',
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: input.compositionUrl,
      PATH: yield* Config.String('PATH'),
      SPICEDB_CA_CERT: yield* Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: yield* Config.String('SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Redacted.value(yield* Config.Redacted('SPICEDB_PRESHARED_KEY')),
    };
    if (input.compositionReadToken !== undefined) {
      Object.assign(environment, {
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: Redacted.value(input.compositionReadToken),
      });
    }
    const child = yield* ChildProcess.make('node', [input.packaged.artifact.entry], {
      cwd: input.packaged.directory,
      env: environment,
      extendEnv: false,
      forceKillAfter: '3 seconds',
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    const diagnostics: Redacted.Redacted[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      yield* stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            diagnostics.push(Redacted.make(line));
          }),
        ),
        Effect.forkScoped,
      );
    }
    return { child, diagnostics };
  },
);

const PostalFactoryResultSchema = Schema.Struct({
  compositionRevision: Schema.String,
  factory: Schema.Literals(['delivery', 'invoice']),
  outcome: Schema.Literal('FACTORY_ONLY_EXECUTION_REJECTED'),
  requirementCode: Schema.Literal('module_operation_requirement_unavailable'),
});

/** Real verifier/scope/default factory; success means specific missing-execution rejection, never postal facts. */
const PostalFactoryPhaseSchema = Schema.Literals([
  'redemption_started',
  'redemption_completed',
  'scope_admission_started',
  'scope_admitted',
  'factory_ready',
  'requirement_rejected',
  'scope_completed',
]);

const observePostalFactoryPhase = Effect.fn('ServerOwnerRelayNative.observePostalFactoryPhase')(
  function* observePostalFactoryPhase(line: string) {
    const prefix = 'ONTOS_POSTAL_FACTORY_PHASE ';
    if (!line.startsWith(prefix)) {
      return;
    }
    const phase = yield* Schema.decodeUnknownEffect(PostalFactoryPhaseSchema)(line.slice(prefix.length)).pipe(
      Effect.mapError(() => new PackagedOwnerStartupError({ reason: 'Invalid closed postal probe phase protocol' })),
    );
    yield* Effect.logInfo('Registered postal factory probe phase', { phase });
  },
);

export const runRegisteredPostalFactoryProbe = Effect.fn('ServerOwnerRelayNative.runRegisteredPostalFactoryProbe')(
  function* runRegisteredPostalFactoryProbe(input: {
    readonly authorization: Redacted.Redacted;
    readonly compositionRevision: string;
    readonly compositionUrl: string;
    readonly correlationId: string;
    readonly deployment: { readonly appId: 'commerce-customer-context'; readonly buildMarker: string };
    readonly factory: 'delivery' | 'invoice';
    readonly gateway: { readonly issuer: string; readonly publicJwks: string };
    readonly relativeDirectory: string;
    readonly relaySource: { readonly apiKey: Redacted.Redacted; readonly shellBaseUrl: string };
    readonly savedAddress: object;
  }) {
    const path = yield* Path.Path;
    const filesystem = yield* FileSystem.FileSystem;
    const directory = path.resolve(input.relativeDirectory);
    const cache = path.join(directory, 'node_modules', '.cache', 'ontos-1284-postal');
    yield* filesystem.makeDirectory(cache, { recursive: true });
    const temporary = yield* filesystem.makeTempDirectoryScoped({ directory: cache, prefix: 'factory-' });
    const artifact = path.join(temporary, 'probe.mjs');
    const toolchainEnvironment: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'MISE_DATA_DIR', 'MISE_CACHE_DIR', 'MISE_CONFIG_DIR', 'MISE_INSTALL_PATH']) {
      const value = yield* Config.option(Config.String(key));
      if (Option.isSome(value)) {
        toolchainEnvironment[key] = value.value;
      }
    }
    // Same scoped native-child bundling seam as the owner's durable redemption restart test.
    const bundle = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        path.join(directory, 'tests/integration/registered-postal-factory-native-probe.mts'),
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      {
        cwd: path.resolve(directory, '../..'),
        env: toolchainEnvironment,
        extendEnv: false,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [bundleExit] = yield* Effect.all(
      [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
      { concurrency: 3 },
    );
    if (bundleExit !== 0) {
      return yield* new PackagedOwnerStartupError({ reason: 'Owner-local postal probe bundling failed' });
    }
    const command = Redacted.make(
      JSON.stringify({
        authorization: Redacted.value(input.authorization),
        compositionRevision: input.compositionRevision,
        correlationId: input.correlationId,
        deployment: input.deployment,
        factory: input.factory,
        savedAddress: input.savedAddress,
      }),
    );
    const child = yield* ChildProcess.make('node', [artifact], {
      cwd: directory,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_URL: Redacted.value(yield* Config.Redacted('DATABASE_URL')),
        NODE_ENV: 'production',
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: input.compositionUrl,
        ONTOS_GATEWAY_ISSUER: input.gateway.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: input.gateway.publicJwks,
        ONTOS_GATEWAY_RELAY_API_KEY: Redacted.value(input.relaySource.apiKey),
        ONTOS_SHELL_GATEWAY_BASE_URL: input.relaySource.shellBaseUrl,
        PATH: yield* Config.String('PATH'),
        SPICEDB_CA_CERT: yield* Config.String('SPICEDB_CA_CERT'),
        SPICEDB_ENDPOINT: yield* Config.String('SPICEDB_ENDPOINT'),
        SPICEDB_PRESHARED_KEY: Redacted.value(yield* Config.Redacted('SPICEDB_PRESHARED_KEY')),
      },
      extendEnv: false,
      forceKillAfter: '3 seconds',
      stderr: 'pipe',
      stdin: Stream.make(Redacted.value(command)).pipe(Stream.encodeText),
      stdout: 'pipe',
    });
    const diagnostics: Redacted.Redacted[] = [];
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => diagnostics.push(Redacted.make(line)))),
      Effect.forkScoped,
    );
    const lines = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.tap(observePostalFactoryPhase),
      Stream.runCollect,
    );
    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      const failurePrefix = 'ONTOS_POSTAL_FACTORY_FAILURE ';
      const failures = lines.filter((line) => line.startsWith(failurePrefix));
      const safeFailure = Schema.Struct({
        stage: Schema.Literals(['input', 'redemption', 'admitted_factory', 'output', 'execution']),
      });
      for (const line of failures) {
        const failure = yield* Schema.decodeEffect(Schema.fromJsonString(safeFailure))(
          line.slice(failurePrefix.length),
        ).pipe(
          Effect.mapError(
            () => new PackagedOwnerStartupError({ reason: 'Invalid closed postal probe failure protocol' }),
          ),
        );
        yield* Effect.logInfo('Registered postal factory probe failed', failure);
      }
      return yield* new PackagedOwnerStartupError({ reason: 'Actual owner-local registered postal factory failed' });
    }
    if (yield* child.isRunning) {
      return yield* new PackagedOwnerStartupError({ reason: 'Completed postal factory probe remains running' });
    }
    const prefix = 'ONTOS_POSTAL_FACTORY_RESULT ';
    const resultLines = lines.filter((line) => line.startsWith(prefix));
    if (resultLines.length !== 1 || resultLines[0] === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'Postal factory probe response absent or ambiguous' });
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(PostalFactoryResultSchema))(
      resultLines[0].slice(prefix.length),
    ).pipe(
      Effect.mapError(() => new PackagedOwnerStartupError({ reason: 'Invalid closed postal probe result protocol' })),
    );
  },
);
