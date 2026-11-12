#!/usr/bin/env node
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { makeDatabaseIdentityEnrollmentLive } from '../../packages/core-runtime/src/db/database-identities.ts';
import { DatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import {
  TenantIntentLoader,
  TenantIntentLoaderLive,
} from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { startProcessObservability } from './process-observability.mts';
import { heapLimitArguments, heapLimitMiB, readContainerMemoryBytes } from './heap-limits.mts';
import { withKeepAlive } from './http-keep-alive.mts';
import { compositionSnapshotResponse } from './composition-source-response.mts';
import { observeRuntimeJob } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';
import { ProcessDatabasePoolsLive } from './process-database-pools.mts';
import { authenticationQueryRedactions, credentialSubmissionRedirect } from '@app/shared-contracts/credential-url';
/**
 * One stateless Zerops container that serves the whole OntOS application: the Shell, every MicroVertical owner
 * of the release intent and the Outbox Worker host, each as its own process on a loopback port.
 *
 * - The public port routes `/_m/<appId>/…` to that owner's own server (its Module Federation manifest, browser
 *   assets and deployment contract) and every other request to the Shell. The Shell reaches owner APIs through
 *   their loopback `node-http` backend origins, exactly as it would reach a separately hosted owner, so an owner
 *   can move to its own service (or a hot-swapped remote) by changing only its published composition entry.
 * - Startup runs the owner migrations (scripts/run-zerops-migrator.mjs with MIGRATOR_ONCE), starts every owner,
 *   observes the running artifacts and publishes their Application Composition: the PostgreSQL authority row plus
 *   the exact snapshot bytes this host serves on its loopback composition source. The host renews the lease itself.
 * - Each owner process inherits the container environment minus supervisor-only credentials and database identities
 *   other owners hold, plus its own entries of ONTOS_OWNER_SECRETS_JSON.
 * - Any owner that exits stops the container, so Zerops restarts it from a clean state. Nothing is stored locally.
 * - The public port opens only once this host's composition is published. Zerops readiness gates its public
 *   balancer, but project-internal callers (`http://app:3000`) reach every running container. A host that is still
 *   migrating therefore refuses connections instead of answering 503 on a kept-alive socket, so a caller's connect
 *   falls through to the container that still serves. When a newer release takes the authority, this host closes
 *   its public port for the same reason. Probes and the composition source live on the loopback control port.
 */
import { createServer } from 'node:http';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { fromReadable, toReadable } from '@effect/platform-node/NodeStream';
import { request as requestLoopback } from '@effect/platform-node/Undici';
import { sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Config,
  ConfigProvider,
  Context,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Order,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse, UrlParams } from 'effect/http';
import { ChildProcess } from 'effect/process';

import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/index.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { isLoopbackHostname } from '../../packages/core-runtime/src/modules/application-composition-backend.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import type { ObservedArtifact, ObservedModuleDeployment } from '../active-application-composition.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  publishApplicationCompositionAuthoritySnapshot,
} from '../application-composition-authority-publication.mts';
import { ApplicationCompositionLegacyOwnersLive } from '../application-composition-legacy-owners.mts';
import { OWNER_RUNTIME_CONFIGURATIONS, unitApiBaseUrl } from '../ops/owner-runtime-configuration.mts';
import { SHELL_ID, SHELL_PORT, readHostedUnits, workspaceRoot } from './hosted-units.mts';
import type { HostedUnit } from './hosted-units.mts';
import { STAGE_CIMD_FIXTURE_PATH, stageCimdFixtureResponse } from './stage-cimd-fixture.mts';
import { listDeadOutboxDeliveries } from '../../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import { startupDeadOutboxInventory, withOutboxDeadStartupGate } from './outbox-dead-startup-gate.mts';
import { ReleaseAccessIntentReader } from './release-access-intent-reader.mts';
import {
  ReleaseAccessVerificationError,
  loadReleaseAccessDatabaseConfiguration,
  recordReleaseAccessVerification,
  releaseAccessVerificationFailure,
  releaseAccessVerificationStatus,
  verifyReleaseAccess,
} from './release-access-verification.mts';

const OUTBOX_HOST_ID = 'outbox-worker-host';
const OUTBOX_HEALTH_PORT = 4100;
/** The Outbox Worker host bundle scripts/zerops/build-app.sh materializes under each owner's release identity. */
const OUTBOX_HOST_BUNDLE = '.zerops/runtime/outbox-worker-host/worker.mjs';
const MODULE_ASSET_PREFIX = '/_m/';
const FEDERATION_MANIFEST_PATH = '/mf-manifest.json';
const READY_PATH = '/_host/ready';
/** Answers as soon as the host listens: the container is alive while it migrates and starts its units. */
const LIVE_PATH = '/_host/live';
/** Loopback-only: the composition source every hosted process reads. */
const COMPOSITION_PATH = '/_host/composition';
/** Loopback-only listener for Zerops probes and the composition source; open while the public port is not. */
export const CONTROL_PORT = 3001;
const STARTUP_BUDGET = Duration.minutes(5);
const RELAY_HEADERS_TIMEOUT = Duration.seconds(60);

export class AppHostError extends Schema.TaggedError<AppHostError>()('AppHostError', { reason: Schema.String }) {}
const failure = (reason: string) => new AppHostError({ reason });

const OwnerSecretsSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);
type OwnerSecrets = typeof OwnerSecretsSchema.Type;

/**
 * Database identities one process owns. Every other process starts without them, so a hosted owner holds only its
 * own connection URLs, as it did as a separate service.
 */
const OWNED_KEYS = {
  [OUTBOX_HOST_ID]: ['PARTY_REGISTRY_WORKER_DATABASE_URL'],
  'party-registry': ['PARTY_REGISTRY_DATABASE_URL'],
  [SHELL_ID]: ['SHELL_GATEWAY_ISSUER_DATABASE_URL'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
/** Never passed to an owner process: migration and authority credentials and the provider secret bundle. */
const SUPERVISOR_ONLY_KEYS: readonly string[] = [
  'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL',
  'DATABASE_ADMIN_URL',
  'ONTOS_OWNER_SECRETS_JSON',
  'ONTOS_SHELL_RUNTIME',
  'ONTOS_SHELL_RUNTIME_DEFAULT',
  'PARTY_REGISTRY_DB_PASSWORD',
  'PARTY_REGISTRY_WORKER_DB_PASSWORD',
  'SHELL_GATEWAY_ISSUER_DB_PASSWORD',
  'SPICEDB_DATABASE_PASSWORD',
];
/** Host-derived settings that a stored owner secret must not override (the bundle predates this topology). */
const HOST_CONTROLLED_KEYS: ReadonlySet<string> = new Set([
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'BETTER_AUTH_URL',
  'DATABASE_URL',
  'MODERN_SERVER_IMMUTABLE_ASSETS',
  'MODERN_SERVER_LOG_LEVEL',
  'MODERN_SERVER_PRECOMPRESSED_ASSETS',
  'MODERN_SERVER_RENDER_RESOURCES',
  'NODE_ENV',
  'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL',
  'ONTOS_GATEWAY_ISSUER',
  'ONTOS_SHELL_GATEWAY_BASE_URL',
  'PORT',
  'SPICEDB_CA_CERT',
  'SPICEDB_ENDPOINT',
  'SPICEDB_PRESHARED_KEY',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
]);

/**
 * The environment overlay one process starts with for the owners it serves: removed keys map to `undefined` (the
 * child then never sees them), host-derived settings win over stored owner secrets. Owners that share a process
 * share one environment, so two of them storing different values under one key is a configuration error.
 */
export const processEnvironment = (
  processIds: readonly string[],
  ownerSecrets: OwnerSecrets,
  derived: ChildEnvironment,
) => {
  const served = new Set(processIds);
  const hidden = [
    ...SUPERVISOR_ONLY_KEYS,
    ...Object.entries(OWNED_KEYS)
      .filter(([owner]) => !served.has(owner))
      .flatMap(([, keys]) => keys),
  ];
  const removed = new Set(hidden);
  const own = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const processId of processIds) {
    for (const [key, value] of Object.entries(ownerSecrets[processId] ?? {})) {
      if (HOST_CONTROLLED_KEYS.has(key) || removed.has(key)) {
        continue;
      }
      if (own.has(key) && own.get(key) !== value) {
        conflicts.add(key);
      }
      own.set(key, value);
    }
  }
  return {
    conflicts: EffectArray.sort([...conflicts], Order.String),
    environment: {
      ...Object.fromEntries(hidden.map((key) => [key, undefined])),
      ...Object.fromEntries(own),
      ...derived,
    } satisfies ChildEnvironment,
  };
};

const PublicOriginSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'https:' && url.pathname === '/' && url.search === '' && url.hash === '' && url.username === ''
      ? undefined
      : 'the public origins must be bare HTTPS origins',
  ),
);

/** Explicit Stage-only Commerce Portal admission; never inferred from an incoming request. */
const STAGE_N1_PORTAL_ORIGINS = ['https://ontos-stage-n1.web-revolution.cz', 'http://localhost:3071'] as const;

const loopbackOrigin = (port: number) => `http://127.0.0.1:${String(port)}`;

/**
 * The owner API bases the shared owner runtime configuration names. Each base is the serving unit's loopback origin; a
 * unit this host does not serve leaves its base unset (undefined removes it from the child) rather than pointing at an
 * address nothing serves.
 */
const ownerRuntimeEnvironment = (ports: ReadonlyMap<string, number>) =>
  Object.fromEntries(
    OWNER_RUNTIME_CONFIGURATIONS.flatMap(({ apiDependencies }) =>
      apiDependencies.map(({ unitId, variable }) => {
        const port = unitId === SHELL_ID ? SHELL_PORT : ports.get(unitId);
        return [variable, port === undefined ? undefined : unitApiBaseUrl(loopbackOrigin(port), unitId)] as const;
      }),
    ),
  );

/**
 * Settings every process derives from the public origins of this environment and the host's own ports. They win over
 * stored owner secrets, whose URL values name whatever hostnames the bundle was written for.
 */
export const derivedEnvironment = (
  origin: string,
  storefrontOrigin: string,
  controlPort: number,
  ports: ReadonlyMap<string, number>,
  shopStorefrontOrigin: string,
  environment = 'production',
) => {
  const shellGateway = unitApiBaseUrl(loopbackOrigin(SHELL_PORT), SHELL_ID);
  // AKROS names the shared realm. The approved N1 additions belong only to Commerce Portal on Stage.
  const trustedOrigins = [origin, storefrontOrigin, shopStorefrontOrigin].join(',');
  const portalTrustedOrigins = [
    origin,
    storefrontOrigin,
    shopStorefrontOrigin,
    ...(environment === 'stage' ? STAGE_N1_PORTAL_ORIGINS : []),
  ].join(',');
  return {
    ...ownerRuntimeEnvironment(ports),
    // The e-mail dispatcher writes for the demo company only, whose e-shop is the pseudonymous one.
    AKROS_STOREFRONT_PUBLIC_URL: shopStorefrontOrigin,
    BETTER_AUTH_TRUSTED_ORIGINS: trustedOrigins,
    BETTER_AUTH_URL: origin,
    COMMERCE_CORE_IDENTITY_BASE_URL: shellGateway,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: portalTrustedOrigins,
    COMMERCE_PORTAL_AUTH_URL: storefrontOrigin,
    // A container serves one immutable release. The deployment package excludes compressed copies.
    MODERN_SERVER_IMMUTABLE_ASSETS: 'true',
    MODERN_SERVER_LOG_LEVEL: 'info',
    MODERN_SERVER_PRECOMPRESSED_ASSETS: 'false',
    NODE_ENV: 'production',
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${loopbackOrigin(controlPort)}${COMPOSITION_PATH}`,
    ONTOS_EMAIL_DISPATCH_URL: `${origin}/shell-super-app-api/email/dispatch`,
    ONTOS_EMAIL_FROM: `noreply@${new URL(origin).hostname}`,
    ONTOS_GATEWAY_ISSUER: origin,
    ONTOS_OAUTH_ISSUER: `${origin}/shell-super-app-api/oauth`,
    ONTOS_PUBLIC_URL: origin,
    ONTOS_SHELL_GATEWAY_BASE_URL: shellGateway,
  };
};

/** `/_m/<appId>/rest` → that owner's own root path; everything else → the Shell. */
export const routeRequest = (
  url: string,
  owners: ReadonlyMap<string, number>,
): Option.Option<{ readonly path: string; readonly port: number }> => {
  if (!url.startsWith(MODULE_ASSET_PREFIX)) {
    return Option.some({ path: url, port: SHELL_PORT });
  }
  const rest = url.slice(MODULE_ASSET_PREFIX.length);
  const separator = rest.indexOf('/');
  const appId = separator === -1 ? rest : rest.slice(0, separator);
  const port = owners.get(appId);
  return port === undefined || appId === SHELL_ID
    ? Option.none()
    : Option.some({ path: separator === -1 ? '/' : rest.slice(separator), port });
};

// ---------------------------------------------------------------------------------------------------------------
// Processes

type ChildEnvironment = NonNullable<ChildProcess.CommandOptions['env']>;

const ShellRuntime = Schema.Literals(['node', 'bun']);

/**
 * Zerops makes YAML-defined variables read-only. Keep the live override out of YAML so operators can change it
 * and restart without rebuilding. Both settings fail closed on invalid values and affect only the Shell.
 */
export const shellRuntime = Config.all({
  deploymentDefault: Config.schema(ShellRuntime, 'ONTOS_SHELL_RUNTIME_DEFAULT').pipe(Config.withDefault('node')),
  override: Config.option(Config.schema(ShellRuntime, 'ONTOS_SHELL_RUNTIME')),
}).pipe(Config.map(({ deploymentDefault, override }) => Option.getOrElse(override, () => deploymentDefault)));

/** Starts one long-running child in the current Scope. Its exit, for any reason, fails the returned effect. */
const startChild = Effect.fn('AppHost.startChild')(function* startChild(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: ChildEnvironment,
) {
  const handle = yield* ChildProcess.make(command, [...args], {
    cwd,
    env: { ...env },
    extendEnv: true,
    stderr: 'inherit',
    stdout: 'inherit',
  }).pipe(Effect.mapError(() => failure(`${name} failed to start`)));
  return handle.exitCode.pipe(
    Effect.matchEffect({
      onFailure: () => Effect.fail(failure(`${name} failed while running`)),
      onSuccess: (code) => Effect.fail(failure(`${name} exited with code ${String(code)}`)),
    }),
  );
});

const MODULE_BINDINGS_KEY = 'ONTOS_GATEWAY_MODULE_BINDINGS';

/**
 * This host binds no module credential yet (DEPLOYMENT.md, "Not yet provisioned on this host"), so the Shell receives
 * main's explicit enrolment for a deployment without one, `[]`. The Shell reads an absent enrolment as unavailable and
 * then answers 503 to every API-key gateway issuance. An operator's value, stored in the Shell's owner secrets or set
 * on the container, always wins and is passed through unchanged, so it never conflicts with this declaration.
 */
export const shellModuleEnrolment = (
  shellSecrets: Readonly<Record<string, string>> | undefined,
  containerValue: Option.Option<string>,
): ChildEnvironment =>
  shellSecrets?.[MODULE_BINDINGS_KEY] === undefined && Option.isNone(containerValue)
    ? { [MODULE_BINDINGS_KEY]: '[]' }
    : {};

const mebibytes = (bytes: number) => String(Math.floor(bytes / 1024 / 1024));

/**
 * Only the single-unit Shell process can use the packaged Bun binary. Every other unit process uses Node. The Shell on
 * Node gets its heap share of the container (heap-limits.mts); Bun has no V8 heap flag, and the owners keep Node's own.
 */
export const startUnitProcess = (
  ids: readonly string[],
  runtime: typeof ShellRuntime.Type,
  env: ChildEnvironment,
  memoryBytes: number,
) => {
  const name = ids.length === 1 ? (ids[0] ?? 'owners') : 'owners';
  const shell = ids.length === 1 && ids[0] === SHELL_ID;
  const bun = runtime === 'bun' && shell;
  const heap = shell && !bun ? heapLimitArguments('shell', memoryBytes) : [];
  let limit = 'Node default';
  if (bun) {
    limit = 'Bun default';
  } else if (heap.length > 0) {
    limit = `${String(heapLimitMiB('shell', memoryBytes))} MiB`;
  }
  return Console.log(`[app-host] ${name} heap limit: ${limit} (container ${mebibytes(memoryBytes)} MiB)`).pipe(
    Effect.andThen(
      startChild(
        name,
        bun ? path.join(workspaceRoot, '.zerops/bun/bin/bun') : process.execPath,
        [...heap, path.join(workspaceRoot, 'scripts/zerops/serve-units.mts'), ...ids],
        workspaceRoot,
        env,
      ),
    ),
  );
};

/** Finite operator commands own private pools; only long-running hosts install a shared-pool registry. */
export const finiteProcessEnvironment = (environment: ChildEnvironment): ChildEnvironment => ({
  ...environment,
  ONTOS_DATABASE_POOL_SHARED: 'false',
});

/** Runs one finite child to a successful exit. */
const runChild = (name: string, command: string, args: readonly string[], cwd: string, env: ChildEnvironment) =>
  Effect.scoped(
    Effect.gen(function* runFiniteChild() {
      const handle = yield* ChildProcess.make(command, [...args], {
        cwd,
        env: finiteProcessEnvironment(env),
        extendEnv: true,
        stderr: 'inherit',
        stdout: 'inherit',
      });
      const code = yield* handle.exitCode;
      if (code !== 0) {
        return yield* failure(`${name} exited with code ${String(code)}`);
      }
      return yield* Effect.void;
    }),
  ).pipe(
    observeRuntimeJob('supervisor-child', name),
    Effect.catchTag('PlatformError', () => Effect.fail(failure(`${name} could not run`))),
  );

// ---------------------------------------------------------------------------------------------------------------
// HTTP

const fetchLoopback = (url: string) =>
  Effect.gen(function* fetchLoopbackArtifact() {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
    return new Uint8Array(yield* response.arrayBuffer);
  }).pipe(Effect.scoped, Effect.timeout(ARTIFACT_FETCH_TIMEOUT));

const waitForOwner = (owner: HostedUnit) => {
  const probe = owner.id === SHELL_ID ? ONTOS_SHELL_RUNTIME_CONTRACT_PATH : ONTOS_MODULE_CONTRACT_PATH;
  return fetchLoopback(`${loopbackOrigin(owner.port)}${probe}`).pipe(
    Effect.retry(Schedule.spaced(Duration.seconds(1))),
    Effect.timeoutOrElse({
      duration: STARTUP_BUDGET,
      orElse: () => Effect.fail(failure(`${owner.id} did not serve ${probe}`)),
    }),
    Effect.asVoid,
  );
};

const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * The owner's end-to-end headers. A caller retries an unavailable (503) answer: make it reconnect, so the retry
 * can reach another container instead of reusing a kept-alive socket to this one. A superseded release keeps
 * refusing governed requests until Zerops stops it.
 */
export const relayResponseHeaders = (
  statusCode: number,
  upstream: Readonly<Record<string, string | readonly string[] | undefined>>,
) => {
  const headers: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) {
      headers[name] = value;
    }
  }
  if (statusCode === 503) {
    headers.connection = 'close';
  }
  return headers;
};

/** Relays one request byte-for-byte to a loopback owner; its compressed body and every header pass unchanged. */
const relay = Effect.fn('AppHost.relay')(function* relay(
  request: HttpServerRequest.HttpServerRequest,
  port: number,
  pathname: string,
) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(name)) {
      headers[name] = value;
    }
  }
  headers['x-forwarded-host'] ??= request.headers.host ?? '';
  headers['x-forwarded-proto'] ??= 'https';
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody
    ? yield* toReadable(request.stream.pipe(Stream.mapError(() => failure('relay request body'))))
    : null;
  const response = yield* Effect.tryPromise({
    catch: () => failure('relay owner unavailable'),
    try: (signal): PromiseLike<Awaited<ReturnType<typeof requestLoopback>>> =>
      requestLoopback(`${loopbackOrigin(port)}${pathname}`, {
        body,
        bodyTimeout: 0,
        headers,
        headersTimeout: Duration.toMillis(RELAY_HEADERS_TIMEOUT),
        method: request.method,
        signal,
      }),
  });
  const responseHeaders = relayResponseHeaders(response.statusCode, response.headers);
  const noBody = request.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
  if (noBody) {
    response.body.resume();
    return HttpServerResponse.empty({ headers: responseHeaders, status: response.statusCode });
  }
  return HttpServerResponse.stream(
    fromReadable<Uint8Array, AppHostError>({
      evaluate: () => response.body,
      onError: () => failure('relay owner response body'),
    }),
    { headers: responseHeaders, status: response.statusCode },
  );
});

const isLoopbackPeer = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(request.remoteAddress, isLoopbackHostname);

/** Only processes inside this container read the composition; public peers get 404. */
const compositionSourceResponse = <Failure, Requirements>(
  request: HttpServerRequest.HttpServerRequest,
  load: Effect.Effect<Option.Option<string>, Failure, Requirements>,
) =>
  Effect.gen(function* serveApprovedSnapshot() {
    if (request.method !== 'GET' || !isLoopbackPeer(request)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const current = yield* load.pipe(Effect.option, Effect.map(Option.flatten));
    return Option.isSome(current)
      ? compositionSnapshotResponse(current.value, request.headers['if-none-match'])
      : HttpServerResponse.empty({ status: 503 });
  });

/** Liveness, readiness and the loopback composition source; none for every application path. */
const hostControlResponse = <Failure, Requirements>(
  request: HttpServerRequest.HttpServerRequest,
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
) =>
  Effect.gen(function* answerHostControl() {
    if (request.url === COMPOSITION_PATH) {
      return Option.some(yield* compositionSourceResponse(request, loadComposition));
    }
    if (request.url === LIVE_PATH) {
      return Option.some(HttpServerResponse.text('live\n', { headers: { 'cache-control': 'no-store' } }));
    }
    if (request.url === READY_PATH) {
      const ready = yield* Ref.get(published);
      return Option.some(
        HttpServerResponse.text(ready ? 'ready\n' : 'starting\n', {
          headers: { 'cache-control': 'no-store' },
          status: ready ? 200 : 503,
        }),
      );
    }
    return Option.none<HttpServerResponse.HttpServerResponse>();
  });

/** The loopback control port: Zerops probes and the composition source, never application traffic. */
export const hostControlApplication = <Failure, Requirements>(
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
) =>
  Effect.gen(function* routeControlRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const control = yield* hostControlResponse(request, published, loadComposition);
    return Option.getOrElse(control, () => HttpServerResponse.empty({ status: 404 }));
  });

export const hostApplication = <Failure, Requirements>(
  ports: ReadonlyMap<string, number>,
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
) =>
  Effect.gen(function* routeHostRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const location = credentialSubmissionRedirect(new URL(request.url, 'https://host.invalid'), request.method);
    if (location !== undefined) {
      return HttpServerResponse.empty({
        headers: { 'cache-control': 'no-store', location, 'referrer-policy': 'no-referrer' },
        status: 303,
      });
    }
    if (new URL(request.url, 'https://host.invalid').pathname === STAGE_CIMD_FIXTURE_PATH) {
      return yield* stageCimdFixtureResponse;
    }
    const control = yield* hostControlResponse(request, published, loadComposition);
    if (Option.isSome(control)) {
      return control.value;
    }
    const route = routeRequest(request.url, ports);
    if (Option.isNone(route)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    return yield* relay(request, route.value.port, route.value.path).pipe(
      Effect.catchTag('AppHostError', () =>
        Effect.succeed(HttpServerResponse.text('Upstream unavailable\n', { status: 502 })),
      ),
    );
  });

// ---------------------------------------------------------------------------------------------------------------
// Composition

interface ApprovedCompositionObservation {
  readonly encoded: string;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}

/** The candidate first, then the previously committed value, so either side of the authority commit matches. */
const withLatestFirst =
  (observation: ApprovedCompositionObservation) =>
  (current: readonly ApprovedCompositionObservation[]): readonly ApprovedCompositionObservation[] =>
    [observation, ...current.filter(({ encoded }) => encoded !== observation.encoded)].slice(0, 2);

interface CompositionPointerAuthority {
  readonly phase: string;
  readonly revision: string;
  readonly validUntilMillis: number;
}

/**
 * The one approved snapshot this host serves. A value is readable only while the PostgreSQL authority names its
 * revision and lease, so the loopback source never serves a revision the database no longer admits.
 */
export const makeCompositionPointer = <Failure, Requirements>(
  readAuthority: Effect.Effect<readonly CompositionPointerAuthority[], Failure, Requirements>,
) =>
  Effect.gen(function* makePointer() {
    const journal = yield* Ref.make<readonly ApprovedCompositionObservation[]>([]);
    const load = Effect.gen(function* loadApprovedPointer() {
      // Mutable authority is always re-read. Only immutable content validation moves to publication.
      const [authority] = yield* readAuthority;
      if (authority === undefined || (authority.phase !== 'active' && authority.phase !== 'draining')) {
        return Option.none<string>();
      }
      for (const { encoded, snapshot } of yield* Ref.get(journal)) {
        const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot).pipe(Effect.option);
        if (
          Option.isSome(approved) &&
          approved.value.composition.revision === authority.revision &&
          DateTime.toEpochMillis(approved.value.validUntil) === authority.validUntilMillis
        ) {
          return Option.some(encoded);
        }
      }
      return Option.none<string>();
    });
    const publish = Effect.fn('AppHost.publishCompositionPointer')(function* publishPointer(
      snapshot: ActiveApplicationCompositionSnapshot,
    ) {
      const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
      const encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
      yield* Ref.update(journal, withLatestFirst({ encoded, snapshot: approved }));
    });
    return { load, publish };
  });

/**
 * Resolves with the revision that replaced `ownRevision` once the authority names another one. Only a newer release
 * can take the authority row, and a superseded revision is never admitted again. A failed read is not evidence.
 */
export const awaitSupersedingRevision = <Failure, Requirements>(
  ownRevision: string,
  activeRevision: Effect.Effect<Option.Option<string>, Failure, Requirements>,
  interval: Duration.Input = Duration.seconds(1),
) =>
  Effect.gen(function* awaitSuperseding() {
    for (;;) {
      const active = yield* activeRevision.pipe(Effect.option, Effect.map(Option.flatten));
      if (Option.isSome(active) && active.value !== ownRevision) {
        return active.value;
      }
      yield* Effect.sleep(interval);
    }
  });

const publicArtifactUrl = (owner: HostedUnit, artifactPath: string, publicOrigin: string) =>
  new URL(owner.id === SHELL_ID ? artifactPath : `${MODULE_ASSET_PREFIX}${owner.id}${artifactPath}`, publicOrigin).href;

/** Reads every artifact over loopback and records it under the public URL the browser and consumers use. */
const observeOwners = Effect.fn('AppHost.observeOwners')(function* observeOwners(
  owners: readonly HostedUnit[],
  publicOrigin: string,
) {
  const observe = (owner: HostedUnit, artifactPath: string) =>
    fetchLoopback(`${loopbackOrigin(owner.port)}${artifactPath}`).pipe(
      Effect.map((bytes): ObservedArtifact => ({ bytes, url: publicArtifactUrl(owner, artifactPath, publicOrigin) })),
      Effect.mapError(() => failure(`${owner.id} ${artifactPath} could not be observed`)),
    );
  const shell = owners.find(({ id }) => id === SHELL_ID);
  if (shell === undefined) {
    return yield* failure('The Shell is not hosted');
  }
  const modules = yield* Effect.forEach(
    owners.filter(({ id }) => id !== SHELL_ID),
    (owner) =>
      Effect.gen(function* observeOwner() {
        const deployment: ObservedModuleDeployment = {
          appId: owner.id,
          backend: { baseUrl: `${loopbackOrigin(owner.port)}/`, transport: 'node-http' },
          contract: yield* observe(owner, ONTOS_MODULE_CONTRACT_PATH),
        };
        return owner.browser
          ? { ...deployment, federationManifest: yield* observe(owner, FEDERATION_MANIFEST_PATH) }
          : deployment;
      }),
    { concurrency: 4 },
  );
  return yield* deriveActiveApplicationCompositionSnapshot({
    environment: yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    modules,
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: yield* observe(shell, FEDERATION_MANIFEST_PATH),
      runtimeContract: yield* observe(shell, ONTOS_SHELL_RUNTIME_CONTRACT_PATH),
    },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
});

/** The release step's proof, kept on the container so a blocked or admitted release is readable afterwards. */
const recordReleaseAccessStatus = (status: Omit<Parameters<typeof recordReleaseAccessVerification>[1], 'finishedAt'>) =>
  DateTime.now.pipe(
    Effect.flatMap((finishedAt) => recordReleaseAccessVerification(workspaceRoot, { ...status, finishedAt })),
  );

// ---------------------------------------------------------------------------------------------------------------
// Host

export const runAppHost = Effect.gen(function* runAppHost() {
  yield* startProcessObservability('supervisor');
  const publicPort = yield* Config.Int('PORT').pipe(Config.withDefault(3000));
  const publicOrigin = (yield* Config.schema(PublicOriginSchema, 'ONTOS_PUBLIC_ORIGIN')).origin;
  const storefrontOrigin = (yield* Config.schema(PublicOriginSchema, 'ONTOS_STOREFRONT_ORIGIN')).origin;
  const shopStorefrontOrigin = (yield* Config.schema(PublicOriginSchema, 'ONTOS_SHOP_STOREFRONT_ORIGIN')).origin;
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(Config.withDefault('production'));
  const ownerSecrets = yield* Config.Redacted('ONTOS_OWNER_SECRETS_JSON').pipe(
    Config.withDefault(Redacted.make('{}')),
    Effect.flatMap((encoded) => Schema.decodeEffect(OwnerSecretsSchema)(Redacted.value(encoded))),
    Effect.mapError(() => failure('ONTOS_OWNER_SECRETS_JSON must be an owner record of string secrets')),
  );
  const containerModuleEnrolment = yield* Config.option(Config.String(MODULE_BINDINGS_KEY));
  const units = yield* readHostedUnits;
  const ports = new Map(units.map(({ id, port }) => [id, port]));
  const derived = derivedEnvironment(
    publicOrigin,
    storefrontOrigin,
    CONTROL_PORT,
    ports,
    shopStorefrontOrigin,
    environment,
  );
  const node = process.execPath;
  const runtime = yield* shellRuntime;
  const memoryBytes = yield* readContainerMemoryBytes;
  const published = yield* Ref.make(false);
  const database = yield* CoreDatabase;
  const readAuthority = database.executor.execute<{
    readonly phase: string;
    readonly revision: string;
    readonly validUntilMillis: number;
  }>(
    sql`select phase, revision, (extract(epoch from valid_until) * 1000)::double precision as "validUntilMillis" from core.application_composition_authority where authority_key = 'active'`,
    'objects',
  );
  const pointer = yield* makeCompositionPointer(readAuthority);

  // The provided server is the loopback control port. The public port opens below, once this host can serve, and
  // closes when a newer release takes the authority: from then on this host refuses every governed request.
  yield* HttpServer.serveEffect(hostControlApplication(published, pointer.load));
  const publicScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(publicScope, Exit.void));
  const openPublicPort = NodeHttpServer.make(withKeepAlive(createServer), { host: '0.0.0.0', port: publicPort }).pipe(
    Effect.mapError(() => failure(`public port ${String(publicPort)} could not be opened`)),
    Effect.flatMap((server) => server.serve(hostApplication(ports, published, pointer.load))),
    Scope.provide(publicScope),
    Effect.andThen(Console.log(`[app-host] accepting application traffic on port ${String(publicPort)}`)),
  );
  const closePublicPortWhenSuperseded = (ownRevision: string) =>
    awaitSupersedingRevision(
      ownRevision,
      readAuthority.pipe(Effect.map((rows) => Option.map(EffectArray.head(rows), ({ revision }) => revision))),
    ).pipe(
      Effect.flatMap((revision) =>
        Console.log(`[app-host] superseded by composition ${revision}; closing public port ${String(publicPort)}`),
      ),
      Effect.andThen(Scope.close(publicScope, Exit.void)),
    );

  // Two processes serve every unit: the Shell alone (its SSR owns the Module Federation host runtime), and every
  // owner together, so their shared dependencies load once.
  const ownerIds = units.filter(({ id }) => id !== SHELL_ID).map(({ id }) => id);
  const shellEnvironment = processEnvironment([SHELL_ID], ownerSecrets, {
    ...derived,
    MODERN_SERVER_RENDER_RESOURCES: 'eager',
  });
  const ownersEnvironment = processEnvironment(ownerIds, ownerSecrets, {
    ...derived,
    // Owner HTML remains renderable, but BFF/contract/federation asset requests never load its page bundles.
    MODERN_SERVER_RENDER_RESOURCES: 'lazy',
  });
  if (ownersEnvironment.conflicts.length > 0) {
    return yield* failure(`owners store different values for ${ownersEnvironment.conflicts.join(', ')}`);
  }
  const exits = [
    yield* startUnitProcess(
      [SHELL_ID],
      runtime,
      {
        ...shellModuleEnrolment(ownerSecrets[SHELL_ID], containerModuleEnrolment),
        ...shellEnvironment.environment,
      },
      memoryBytes,
    ),
    yield* startUnitProcess(ownerIds, runtime, ownersEnvironment.environment, memoryBytes),
  ];
  yield* Console.log(`[app-host] Shell runtime ${runtime}; owners and Outbox runtime node`);
  yield* Console.log(`[app-host] serving ${String(units.length)} units; migrating`);

  const publishSnapshot = (snapshot: ActiveApplicationCompositionSnapshot) =>
    Effect.gen(function* publishObservedComposition() {
      yield* publishApplicationCompositionAuthoritySnapshot(snapshot, pointer.publish(snapshot), Effect.void);
      yield* Console.log(
        `[app-host] composition ${snapshot.composition.revision} (${String(snapshot.composition.modules.length)} owners) valid until ${DateTime.formatIso(snapshot.validUntil)}`,
      );
      return snapshot.composition.revision;
    }).pipe(observeRuntimeJob('composition-publish'));
  const publish = observeOwners(units, publicOrigin).pipe(Effect.flatMap(publishSnapshot));
  // Before this release takes the authority, every active Tenant's canonical access must be proven: its scopes, its
  // owner membership, and a SpiceDB projection that equals PostgreSQL intent (see release-access-verification.mts).
  // The proof is read-only — it never writes, revokes or re-grants — and it is not ignored. A Tenant without v2 intent,
  // which is what the retired demo tooling left behind, fails the release here with the exact Tenant and the canonical
  // remediation, instead of publishing a release that locks its people out.
  const verifyReleaseAccessIntent = (snapshot: ActiveApplicationCompositionSnapshot) =>
    Effect.gen(function* verifyReleaseSnapshot() {
      // The settings this step receives: the owner secrets over the container environment.
      const inherited = yield* ConfigProvider.ConfigProvider;
      const owned = Object.entries(processEnvironment([SHELL_ID, ...ownerIds], ownerSecrets, derived).environment);
      const provider = ConfigProvider.fromUnknown(
        Object.fromEntries(owned.filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ).pipe(ConfigProvider.orElse(inherited));
      return yield* verifyReleaseAccess(provider);
    }).pipe(
      Effect.tap((result) =>
        Effect.andThen(
          Console.log(
            `[app-host] release access verification: tenants=${String(result.tenants)} verified=${String(result.verified)} tuples=${String(result.tuples)}`,
          ),
          recordReleaseAccessStatus(releaseAccessVerificationStatus(snapshot.composition.revision, result)),
        ),
      ),
      Effect.tapError((problem: ReleaseAccessVerificationError) =>
        Effect.andThen(
          Console.error(
            `[app-host] RELEASE ACCESS VERIFICATION FAILED; composition ${snapshot.composition.revision} not published: ${problem.reason}. ${problem.remediation}`,
          ),
          recordReleaseAccessStatus(releaseAccessVerificationFailure(snapshot.composition.revision, problem)),
        ),
      ),
      Effect.mapError((problem) =>
        failure(`release access verification failed: ${problem.reason}. ${problem.remediation}`),
      ),
      observeRuntimeJob('release-access-verification'),
    );

  // ONTOS_APP_HOST_PUBLISH=false starts and observes every unit without migrating or taking the authority, so a new
  // environment can be checked beside the one that still holds it.
  const takesAuthority = yield* Config.Boolean('ONTOS_APP_HOST_PUBLISH').pipe(Config.withDefault(true));
  const observeOnly = Effect.gen(function* observeWithoutAuthority() {
    yield* Effect.forEach(units, waitForOwner, { concurrency: 'unbounded', discard: true });
    const snapshot = yield* observeOwners(units, publicOrigin);
    yield* Console.log(
      `[app-host] observe-only: composition ${snapshot.composition.revision} (${String(snapshot.composition.modules.length)} owners) not published`,
    );
    yield* openPublicPort;
    yield* Ref.set(published, true);
    return yield* Effect.never;
  });

  const startup = Effect.gen(function* startupSequence() {
    // Inspect all Tenants and workers before DDL or any authority fence. Failure leaves the old release admitted.
    const coreSchemaExists = Effect.gen(function* inspectCoreBootstrap() {
      const rows = yield* database.executor.execute<{ exists: boolean }>(
        sql`select to_regnamespace('core') is not null as "exists"`,
        'objects',
      );
      const [catalog] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ exists: Schema.Boolean })]))(
        rows,
      ).pipe(Effect.mapError(() => failure('Unable to verify the Core bootstrap catalog before owner migrations')));
      return catalog.exists;
    });
    yield* withOutboxDeadStartupGate(
      startupDeadOutboxInventory(coreSchemaExists, listDeadOutboxDeliveries(database.executor, { limit: 10 })),
      Effect.void,
    ).pipe(Effect.mapError((problem) => failure(problem.reason)));
    yield* Effect.all(
      [
        runChild('migrator', node, ['scripts/run-zerops-migrator.mjs'], workspaceRoot, { MIGRATOR_ONCE: 'true' }),
        Effect.forEach(units, waitForOwner, { concurrency: 'unbounded', discard: true }),
      ],
      { concurrency: 'unbounded' },
    );
    const releaseSnapshot = yield* observeOwners(units, publicOrigin);
    yield* verifyReleaseAccessIntent(releaseSnapshot);
    const revision = yield* publishSnapshot(releaseSnapshot);
    // From this commit on the old release refuses every governed request and closes its public port, so this one
    // serves internal callers and reports ready to the Zerops balancer at once.
    yield* openPublicPort;
    yield* Ref.set(published, true);
    yield* closePublicPortWhenSuperseded(revision).pipe(Effect.forkChild);
    // The release step writes no authorization relationship. Authorization v2 (ADR-0030) projects every tuple from
    // PostgreSQL intent through the one Core writer, so the retired `scoped_role`/`action`/`context_permission`
    // reconciliation would only fail here. Live intent is seeded by the operator-gated stage bootstrap
    // (`apps/shell-super-app/scripts/bootstrap-stage-accounts.mts`); the engine's canonical schema arrives with the
    // deployment's SpiceDB bootstrap file, and a live schema or tuple retirement is its own approved operation. The
    // release proves the projected access before it publishes (`verifyReleaseAccessIntent` above) and never mutates it.
    yield* Console.log(
      `[app-host] ${OUTBOX_HOST_ID} heap limit: ${String(heapLimitMiB('outbox', memoryBytes))} MiB (container ${mebibytes(memoryBytes)} MiB)`,
    );
    const outbox = yield* startChild(
      OUTBOX_HOST_ID,
      node,
      [...heapLimitArguments('outbox', memoryBytes), OUTBOX_HOST_BUNDLE],
      workspaceRoot,
      {
        ...processEnvironment([OUTBOX_HOST_ID, ...ownerIds], ownerSecrets, derived).environment,
        // The host's email trigger authenticates to the Shell's dispatch endpoint with the Shell's own secret.
        ...Object.fromEntries(
          Object.entries(ownerSecrets[SHELL_ID] ?? {}).filter(([key]) => key === 'ONTOS_EMAIL_DISPATCH_SECRET'),
        ),
        OUTBOX_WORKER_HEALTH_PORT: String(OUTBOX_HEALTH_PORT),
        PORT: String(OUTBOX_HEALTH_PORT),
      },
    );
    // The host renews its own lease well inside the validity window; no external refresh schedule exists.
    const renew = publish.pipe(
      Effect.tapError((problem) => Console.error(`[app-host] composition renewal failed: ${String(problem)}`)),
      Effect.ignore,
      Effect.delay(ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval),
      Effect.forever,
    );
    return yield* Effect.raceFirst(outbox, renew);
  });
  return yield* Effect.raceFirst(Effect.raceAllFirst(exits), takesAuthority ? startup : observeOnly);
});

/** The runtime reader and publication administrator must never share a Layer memo entry. */
export const ReleaseAccessIntentReaderLive = Layer.effect(
  ReleaseAccessIntentReader,
  Effect.gen(function* releaseAccessRuntimeReader() {
    const provider = yield* ConfigProvider.ConfigProvider;
    const configuration = yield* loadReleaseAccessDatabaseConfiguration(provider);
    const reader = TenantIntentLoaderLive.pipe(
      Layer.provide(CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration)))),
    );
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithMemoMap(reader, memoMap, scope);
    return Context.get(context, TenantIntentLoader);
  }).pipe(
    Effect.mapError(
      () =>
        new ReleaseAccessVerificationError({
          reason: 'The release access runtime reader could not be opened',
          remediation:
            'Configure DATABASE_URL for the enrolled shared runtime role, separately from DATABASE_ADMIN_URL.',
        }),
    ),
  ),
);

if (import.meta.main) {
  const program = runAppHost.pipe(
    Effect.scoped,
    Effect.provide(NodeHttpServer.layer(withKeepAlive(createServer), { host: '127.0.0.1', port: CONTROL_PORT })),
    Effect.provide(ReleaseAccessIntentReaderLive),
    // Every authority transition re-observes legacy owner completion, as the operator publisher does.
    Effect.provide(
      Layer.merge(ApplicationCompositionAuthorityAdminDatabaseLive, ApplicationCompositionLegacyOwnersLive),
    ),
    Effect.provide(makeDatabaseIdentityEnrollmentLive(APP_DATABASE_IDENTITY_ENROLLMENT)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
    Effect.provide(ProcessDatabasePoolsLive),
    Effect.provideService(UrlParams.CurrentRedactedNames, authenticationQueryRedactions),
    Effect.tapCause((cause) => Console.error(`[app-host] stopped: ${String(cause)}`)),
  );
  const exit = await Effect.runPromiseExit(program);
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
