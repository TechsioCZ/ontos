import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { loadModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { GatewayContextV2ClaimsSchema, GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';
import type { GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { jwtVerify } from 'jose';
import { NodeSocketServer } from '@effect/platform-node';
import {
  Config,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Option,
  Path,
  Queue,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpClient } from 'effect/http';

import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';
import { readCompiledNodeShellIdentity } from '../../../../scripts/ontos-shell-runtime-contract.ts';
import { ApiKeyServiceLive } from '../../api/auth/api-key-service.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import { HostedModuleCredentialsSchema } from '@app/core-runtime/auth/hosted-module-credentials';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { moduleCredentialReleaseOf } from '../../api/auth/module-credential-attestation.ts';
import { provisionModuleCredentials } from '../../api/auth/module-credential-provisioning.service.ts';

const SHELL_APP_ID = 'shell-super-app';
const CUSTOMER_CONTEXT_APP_ID = 'commerce-customer-context';
const MARKET_APP_ID = 'commerce-market-catalog';
const PRICE_GROUP_APP_ID = 'price-group-catalog';

export class PackagedOwnerStartupError extends Schema.TaggedError<PackagedOwnerStartupError>()(
  'PackagedOwnerStartupError',
  {
    reason: Schema.String,
  },
) {}

const IdentitySchema = Schema.Struct({
  appId: Schema.Literals([
    SHELL_APP_ID,
    'party-registry',
    'catalog',
    CUSTOMER_CONTEXT_APP_ID,
    MARKET_APP_ID,
    PRICE_GROUP_APP_ID,
  ]),
  build: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  buildMarker: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  sourceRevision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  unitId: Schema.Literals([
    'app/shell-super-app',
    'app/party-registry',
    'app/catalog',
    'app/commerce-customer-context',
    'app/commerce-market-catalog',
    'app/price-group-catalog',
  ]),
  version: Schema.String.check(Schema.isMinLength(1)),
});
const PackagedBuildSchema = Schema.Struct({ deliveryUnit: IdentitySchema });
const ApiRoutesDocumentSchema = Schema.fromJsonString(
  Schema.Struct({
    routes: Schema.Array(Schema.Struct({ isApi: Schema.optionalKey(Schema.Boolean), urlPath: Schema.String })),
  }),
);
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
const BUILD_IDENTITY_FILE = 'ultramodern-build.json';
const ReadyOriginSchema = Schema.String.check(Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]*$/u));

const PACKAGED_STARTUP_PHASE = 'Packaged native startup phase';
const startupFailureCodes = [
  'AuthConfigError',
  'ConfigError',
  'SchemaError',
  'SyntaxError',
  'TypeError',
  'ReferenceError',
  'NoSuchElementException',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_REQUIRE_ESM',
  'ERR_DLOPEN_FAILED',
] as const;

/** Report only fixed public error codes; child output can contain credentials and stays redacted. */
export const packagedStartupFailureReason = (exitCode: number, diagnostics: readonly Redacted.Redacted[]): string => {
  const codes = startupFailureCodes.filter((code) => diagnostics.some((line) => Redacted.value(line).includes(code)));
  return `Packaged application exited before readiness (exit=${String(exitCode)}; diagnostic codes=${codes.join(', ') || 'not reported'})`;
};

interface PackagedApplicationInput {
  readonly appId:
    | typeof SHELL_APP_ID
    | 'party-registry'
    | 'catalog'
    | typeof CUSTOMER_CONTEXT_APP_ID
    | typeof MARKET_APP_ID
    | typeof PRICE_GROUP_APP_ID;
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
      Object.assign(environment, { ONTOS_GATEWAY_ISSUER: input.gateway.issuer });
      if (input.appId !== SHELL_APP_ID) {
        Object.assign(environment, { ONTOS_GATEWAY_PUBLIC_JWKS: input.gateway.publicJwks });
      }
      // The Shell gets what the app host gives it on stage: its issuer and its own signing key, and no public key set.
      if (input.gateway.privateJwk !== undefined) {
        Object.assign(environment, { ONTOS_GATEWAY_PRIVATE_JWK: Redacted.value(input.gateway.privateJwk) });
      }
    }
    return environment;
  },
);

const HostedOwnerAppIdSchema = Schema.Literals(['crm', 'catalog', CUSTOMER_CONTEXT_APP_ID, MARKET_APP_ID]);
type HostedOwnerAppId = typeof HostedOwnerAppIdSchema.Type;
const HostedOwnerBuildSchema = Schema.Struct({
  deliveryUnit: Schema.Struct({ appId: HostedOwnerAppIdSchema, buildMarker: IdentitySchema.fields.buildMarker }),
});
const HostedOwnerReadyLine = /^\[serve-units\] (?<appId>[a-z][a-z0-9-]*) on (?<origin>127\.0\.0\.1:[1-9][0-9]*)$/u;
const HandoverReceivedPrefix = '[module-credentials] received the credentials of ';

/**
 * One owner served the way the app host serves its owners process: `scripts/zerops/serve-units.mts` claims the
 * process for the owner before it loads, the owner's generated in-process entry (`dist/zerops-entry.mjs`, written by
 * `scripts/zerops/owner-entry.mts` after the unit's build, as `scripts/zerops/build-app.sh` does) serves on the
 * owner's topology port, and every module and workload key arrives on the process's private channel, its file
 * descriptor 3, never in its environment. `handOver` queues one handover line on that channel; `received` takes the
 * next acceptance the process reported (entry names only, never a key).
 */
export const startHostedOwnerWithHandover = Effect.fn('ServerOwnerRelayNative.startHostedOwnerWithHandover')(
  function* startHostedOwnerWithHandover(input: {
    readonly appId: HostedOwnerAppId;
    readonly compositionUrl: string;
    readonly gateway: { readonly issuer: string; readonly publicJwks: string };
    readonly relativeDirectory: string;
    readonly shellGatewayBaseUrl: string;
    readonly workspaceDirectory: string;
  }) {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = path.resolve(input.workspaceDirectory);
    const directory = path.resolve(input.relativeDirectory);
    const compiled = yield* filesystem
      .readFileString(path.join(directory, '.output', BUILD_IDENTITY_FILE))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(HostedOwnerBuildSchema))));
    if (compiled.deliveryUnit.appId !== input.appId) {
      return yield* new PackagedOwnerStartupError({ reason: 'Hosted owner identity mismatch' });
    }
    if (!(yield* filesystem.exists(path.join(directory, 'dist', 'zerops-entry.mjs')))) {
      return yield* new PackagedOwnerStartupError({
        reason: 'The owner has no in-process entry; run scripts/zerops/owner-entry.mts after its build',
      });
    }
    const channel = yield* Queue.unbounded<Uint8Array>();
    const received = yield* Queue.unbounded<string>();
    const child = yield* ChildProcess.make(
      'node',
      [path.join(workspace, 'scripts/zerops/serve-units.mts'), input.appId],
      {
        additionalFds: { fd3: { stream: Stream.fromQueue(channel), type: 'input' } },
        cwd: workspace,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_URL: Redacted.value(yield* Config.Redacted('DATABASE_URL')),
          NODE_ENV: 'production',
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: input.compositionUrl,
          ONTOS_GATEWAY_ISSUER: input.gateway.issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: input.gateway.publicJwks,
          // The app host's switch: the channel lives as long as the host, so its end stops the process.
          ONTOS_MODULE_CREDENTIAL_HANDOVER: 'fd3-lifetime',
          ONTOS_SHELL_GATEWAY_BASE_URL: input.shellGatewayBaseUrl,
          PATH: yield* Config.String('PATH'),
          SPICEDB_CA_CERT: yield* Config.String('SPICEDB_CA_CERT'),
          SPICEDB_ENDPOINT: yield* Config.String('SPICEDB_ENDPOINT'),
          SPICEDB_PRESHARED_KEY: Redacted.value(yield* Config.Redacted('SPICEDB_PRESHARED_KEY')),
        },
        extendEnv: false,
        forceKillAfter: '3 seconds',
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const diagnostics: Redacted.Redacted[] = [];
    const ready = yield* Deferred.make<string, PackagedOwnerStartupError>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const listening = HostedOwnerReadyLine.exec(line)?.groups;
        if (listening?.['appId'] === input.appId && listening['origin'] !== undefined) {
          return Deferred.succeed(ready, `http://${listening['origin']}`);
        }
        if (line.startsWith(HandoverReceivedPrefix)) {
          return Queue.offer(received, line.slice(HandoverReceivedPrefix.length));
        }
        return Effect.sync(() => {
          diagnostics.push(Redacted.make(line));
        });
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
        Effect.flatMap((exitCode) =>
          Effect.fail(new PackagedOwnerStartupError({ reason: packagedStartupFailureReason(exitCode, diagnostics) })),
        ),
      ),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${origin}${ONTOS_MODULE_CONTRACT_PATH}`);
    if (response.status !== 200) {
      return yield* new PackagedOwnerStartupError({ reason: 'Hosted owner contract endpoint is unavailable' });
    }
    const contract = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)),
    );
    if (input.appId === CUSTOMER_CONTEXT_APP_ID && contract.manifest.publicSurface.components.length !== 0) {
      return yield* new PackagedOwnerStartupError({ reason: 'API-only application declares a frontend surface' });
    }
    if (
      contract.deployment.appId !== input.appId ||
      contract.deployment.buildMarker !== compiled.deliveryUnit.buildMarker
    ) {
      return yield* new PackagedOwnerStartupError({
        reason: 'Hosted owner HTTP deployment does not match its packaged identity',
      });
    }
    return {
      buildMarker: compiled.deliveryUnit.buildMarker,
      child,
      diagnostics,
      handOver: (message: Uint8Array) => Queue.offer(channel, message),
      origin,
      received: Queue.take(received).pipe(Effect.timeout('20 seconds')),
    };
  },
);

/**
 * A module that calls others runs the way the app host runs it: served by the owners process (`serve-units.mts`), which
 * claims the unit's own credential store copy, on the unit's topology port (so a restart keeps its origin). With a
 * relay source its key is handed over on the process's private channel; without one it holds none. The environment
 * never carries a module key; a unit started as a standalone server could hold none.
 */
const startHostedCaller = Effect.fn('ServerOwnerRelayNative.startHostedCaller')(function* startHostedCaller(
  input: PackagedApplicationInput,
  appId: HostedOwnerAppId,
  apiPrefix: string,
  compiled: typeof IdentitySchema.Type,
) {
  const path = yield* Path.Path;
  if (input.compositionUrl === undefined || input.gateway === undefined) {
    return yield* new PackagedOwnerStartupError({ reason: 'A hosted caller needs its composition and gateway' });
  }
  const hosted = yield* startHostedOwnerWithHandover({
    appId,
    compositionUrl: input.compositionUrl,
    gateway: input.gateway,
    relativeDirectory: input.relativeDirectory,
    shellGatewayBaseUrl: input.relaySource?.shellBaseUrl ?? `${input.gateway.issuer}/shell-super-app-api`,
    workspaceDirectory: path.resolve(input.relativeDirectory, '../..'),
  });
  if (input.relaySource !== undefined) {
    // One handover line, in the shape `encodeModuleCredentialHandover` writes (scripts/zerops/module-credentials.mts).
    const line = yield* Schema.encodeEffect(Schema.fromJsonString(HostedModuleCredentialsSchema))({
      credentials: { [appId]: input.relaySource.apiKey },
      schemaVersion: 1,
      workloads: {},
    });
    yield* hosted.handOver(new TextEncoder().encode(`${line}\n`));
    const accepted = yield* hosted.received;
    if (!accepted.split(', ').includes(appId)) {
      return yield* new PackagedOwnerStartupError({ reason: 'The hosted caller did not take its module credential' });
    }
  }
  return { apiPrefix, child: hosted.child, compiled, diagnostics: hosted.diagnostics, origin: hosted.origin };
});

/** The packaged unit's API prefix, from its route manifest. */
const packagedApiPrefix = Effect.fn('ServerOwnerRelayNative.packagedApiPrefix')(function* packagedApiPrefix(
  routeFile: string,
) {
  const filesystem = yield* FileSystem.FileSystem;
  const routes = yield* filesystem
    .readFileString(routeFile)
    .pipe(Effect.flatMap(Schema.decodeEffect(ApiRoutesDocumentSchema)));
  const apiRoute = routes.routes.find((route) => route.isApi === true);
  if (apiRoute === undefined) {
    return yield* new PackagedOwnerStartupError({ reason: 'Packaged API prefix is missing' });
  }
  return apiRoute.urlPath;
});

export const startPackagedApplication = Effect.fn('ServerOwnerRelayNative.startPackagedApplication')(
  function* startPackagedApplication(input: PackagedApplicationInput) {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(input.relativeDirectory);
    const compiled = yield* filesystem
      .readFileString(path.join(directory, '.output', BUILD_IDENTITY_FILE))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PackagedBuildSchema))));
    if (compiled.deliveryUnit.appId !== input.appId) {
      return yield* new PackagedOwnerStartupError({ reason: 'Packaged application identity mismatch' });
    }
    const publishedBuild =
      input.appId === CUSTOMER_CONTEXT_APP_ID || input.appId === PRICE_GROUP_APP_ID
        ? undefined
        : yield* filesystem
            .readFileString(path.join(directory, '.output', 'public', BUILD_IDENTITY_FILE))
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
    const apiPrefix = yield* packagedApiPrefix(path.join(directory, '.output', 'route.json'));
    // A calling module that joins a composition runs as the app host runs it; a contract-only start (no composition,
    // no gateway) makes no delegated call and stays a standalone server.
    if (
      Schema.is(HostedOwnerAppIdSchema)(input.appId) &&
      (input.relaySource !== undefined || (input.compositionUrl !== undefined && input.gateway !== undefined))
    ) {
      return yield* startHostedCaller(input, input.appId, apiPrefix, compiled.deliveryUnit);
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
        Effect.flatMap((exitCode) =>
          Effect.fail(new PackagedOwnerStartupError({ reason: packagedStartupFailureReason(exitCode, diagnostics) })),
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
    if (contract.deployment.appId !== identity.appId || contract.deployment.buildMarker !== identity.buildMarker) {
      return yield* new PackagedOwnerStartupError({
        reason: 'Actual HTTP deployment does not match immutable packaged identity',
      });
    }
    yield* Effect.logInfo(PACKAGED_STARTUP_PHASE, { appId: input.appId, phase: 'contract-identity-verified' });
    return { apiPrefix, child, compiled: compiled.deliveryUnit, diagnostics, origin };
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

/** Serve the actual local Node compiler output without claiming a promotable release envelope. */
export const startCompiledSymmyShell = Effect.fn('ServerOwnerRelayNative.startCompiledSymmyShell')(
  function* startCompiledSymmyShell(
    input: PackagedApplicationInput & {
      readonly appId: typeof SHELL_APP_ID;
      readonly authentication: NonNullable<PackagedApplicationInput['authentication']>;
    },
  ) {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(input.relativeDirectory);
    const dist = path.join(directory, 'dist');
    const { routes } = yield* filesystem
      .readFileString(path.join(dist, 'route.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(ApiRoutesDocumentSchema)));
    const prefixes = routes.filter(({ isApi }) => isApi === true).map(({ urlPath }) => urlPath);
    if (prefixes[0] !== '/shell-super-app-api' || !prefixes.includes(SYMMY_REST_PREFIX)) {
      return yield* new PackagedOwnerStartupError({ reason: 'Compiled Shell lacks the internal Symmy Node mount' });
    }
    const contractSchema = Schema.fromJsonString(OntosShellRuntimeContractSchema);
    const contract = yield* filesystem
      .readFileString(path.join(dist, 'public', ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1)))
      .pipe(Effect.flatMap(Schema.decodeEffect(contractSchema)));
    const build = yield* readCompiledNodeShellIdentity(directory);
    if (Option.isNone(build) || build.value.buildMarker !== contract.deployment.buildMarker) {
      return yield* new PackagedOwnerStartupError({
        reason: 'Local runtime contract does not identify the compiled Shell',
      });
    }
    const environment = yield* makePackagedEnvironment(input);
    const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', 'serve'], {
      cwd: directory,
      env: { ...environment, ONTOS_INTERNAL_SYMMY_INGRESS: '1' },
      extendEnv: false,
      forceKillAfter: '3 seconds',
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    const diagnostics = yield* Ref.make<readonly string[]>([]);
    yield* Effect.forEach(
      [child.stdout, child.stderr],
      (stream) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const status = /['"]http\.status['"]:\s*(?<status>[1-5][0-9]{2})/u.exec(line)?.groups?.['status'];
            return status === undefined
              ? Effect.void
              : Ref.update(diagnostics, (previous) => [...previous, `http.status=${status}`].slice(-16));
          }),
          Effect.forkScoped,
        ),
      { discard: true },
    );
    const origin = `http://127.0.0.1:${input.authentication.port}`;
    const client = yield* HttpClient.HttpClient;
    const ready = client.get(`${origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`).pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* readContract(response) {
          if (response.status !== 200) {
            return yield* new PackagedOwnerStartupError({ reason: 'Compiled Shell contract is not ready' });
          }
          return yield* response.json;
        }),
      ),
      Effect.timeout('1 second'),
      Effect.retry({ schedule: Schedule.spaced('250 millis'), times: 60 }),
    );
    const body = yield* Effect.raceFirst(
      ready,
      child.exitCode.pipe(
        Effect.flatMap(() =>
          Effect.fail(new PackagedOwnerStartupError({ reason: 'Compiled Shell process exited before readiness' })),
        ),
      ),
    );
    const served = yield* Schema.decodeUnknownEffect(OntosShellRuntimeContractSchema)(body);
    if (!Schema.toEquivalence(OntosShellRuntimeContractSchema)(served, contract)) {
      return yield* new PackagedOwnerStartupError({ reason: 'Compiled Shell served a different runtime contract' });
    }
    return { apiPrefix: prefixes[0], diagnostics: Ref.get(diagnostics), origin };
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
        moduleCredential: Redacted.value(input.relaySource.apiKey),
        savedAddress: input.savedAddress,
        storeModule: path.resolve(directory, '../../packages/core-runtime/src/auth/hosted-module-credential-store.ts'),
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

/**
 * A source module's credential exactly as the platform provisions it on every boot: the platform's module principal,
 * a key it owns and its binding. No person issues it, and the Shell derives its binding from the enrolment.
 */
export const provisionSourceModuleCredential = Effect.fn('ServerOwnerRelayNative.provisionSourceModuleCredential')(
  function* provisionSourceModuleCredential(input: {
    readonly appId: string;
    /** The composition the Shell serves; the key is attested for its revision and the module's build. */
    readonly composition: {
      readonly composition: {
        readonly modules: readonly { readonly deployment: { readonly appId: string; readonly buildMarker: string } }[];
        readonly revision: string;
      };
    };
    readonly configuration: typeof AuthConfig.Service;
    readonly database: (typeof CoreDatabase.Service)['executor'];
    readonly persistence: typeof AuthDatabase.Service;
  }) {
    const crypto = yield* Crypto.Crypto;
    const provisioned = yield* provisionModuleCredentials({
      appIds: [input.appId],
      bootId: yield* crypto.randomUUIDv4(),
      hostId: 'server-owner-relay-native',
      operationId: yield* crypto.randomUUIDv4(),
      release: moduleCredentialReleaseOf({
        composition: input.composition.composition,
        contracts: input.composition.composition.modules,
      }),
    }).pipe(
      Effect.provide(ApiKeyServiceLive),
      Effect.provideService(AuthConfig, input.configuration),
      Effect.provideService(AuthDatabase, input.persistence),
      Effect.provideService(CoreDatabase, { executor: input.database }),
    );
    const secret = provisioned.credentials.get(input.appId);
    const enrolled = (yield* loadModuleCredentialEnrolment(input.database)).find(
      (credential) => credential.appId === input.appId && provisioned.providerKeyIds.has(credential.providerKeyId),
    );
    if (secret === undefined || enrolled === undefined) {
      return yield* new PackagedOwnerStartupError({
        reason: `The platform issued no module credential for ${input.appId}`,
      });
    }
    return {
      authBindingId: enrolled.authBindingId,
      providerKeyId: enrolled.providerKeyId,
      secret,
      serviceId: enrolled.principalId,
    };
  },
);
