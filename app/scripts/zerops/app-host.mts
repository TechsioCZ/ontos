#!/usr/bin/env node
import { startProcessObservability } from './process-observability.mts';
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
  Stream,
  Struct,
} from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse, UrlParams } from 'effect/http';
import { ChildProcess } from 'effect/process';

import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/index.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
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
import {
  CALLER_NAMESPACE_ID,
  OWNER_RUNTIME_CONFIGURATIONS,
  unitApiBaseUrl,
} from '../ops/owner-runtime-configuration.mts';
import { SHELL_ID, SHELL_PORT, readHostedUnits, workspaceRoot } from './hosted-units.mts';
import type { HostedUnit } from './hosted-units.mts';

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

const loopbackOrigin = (port: number) => `http://127.0.0.1:${String(port)}`;

/**
 * The owner API bases and caller namespaces the shared owner runtime configuration names. Each base is the serving
 * unit's loopback origin; a unit this host does not serve leaves its base unset (undefined removes it from the child)
 * rather than pointing at an address nothing serves.
 */
const ownerRuntimeEnvironment = (ports: ReadonlyMap<string, number>) =>
  Object.fromEntries(
    OWNER_RUNTIME_CONFIGURATIONS.flatMap(({ apiDependencies, callerNamespaces }) => [
      ...apiDependencies.map(({ unitId, variable }) => {
        const port = unitId === SHELL_ID ? SHELL_PORT : ports.get(unitId);
        return [variable, port === undefined ? undefined : unitApiBaseUrl(loopbackOrigin(port), unitId)] as const;
      }),
      ...callerNamespaces.map((variable) => [variable, CALLER_NAMESPACE_ID] as const),
    ]),
  );

/**
 * Settings every process derives from the public origins of this environment and the host's own ports. They win over
 * stored owner secrets, whose URL values name whatever hostnames the bundle was written for.
 */
export const derivedEnvironment = (
  origin: string,
  storefrontOrigin: string,
  hostPort: number,
  ports: ReadonlyMap<string, number>,
) => {
  const shellGateway = unitApiBaseUrl(loopbackOrigin(SHELL_PORT), SHELL_ID);
  return {
    ...ownerRuntimeEnvironment(ports),
    AKROS_STOREFRONT_PUBLIC_URL: storefrontOrigin,
    BETTER_AUTH_TRUSTED_ORIGINS: `${origin},${storefrontOrigin}`,
    BETTER_AUTH_URL: origin,
    COMMERCE_CORE_IDENTITY_BASE_URL: shellGateway,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: `${origin},${storefrontOrigin}`,
    COMMERCE_PORTAL_AUTH_URL: storefrontOrigin,
    // A container serves one immutable release. The deployment package excludes compressed copies.
    MODERN_SERVER_IMMUTABLE_ASSETS: 'true',
    MODERN_SERVER_LOG_LEVEL: 'info',
    MODERN_SERVER_PRECOMPRESSED_ASSETS: 'false',
    NODE_ENV: 'production',
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${loopbackOrigin(hostPort)}${COMPOSITION_PATH}`,
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

/** Invalid values fail before any child starts; changing this setting never changes owner or worker runtimes. */
export const shellRuntime = Config.schema(Schema.Literals(['node', 'bun']), 'ONTOS_SHELL_RUNTIME').pipe(
  Config.withDefault('node'),
);

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

/** Only the single-unit Shell process can use the packaged Bun binary. Every other unit process uses Node. */
export const startUnitProcess = (ids: readonly string[], runtime: 'node' | 'bun', env: ChildEnvironment) =>
  startChild(
    ids.length === 1 ? (ids[0] ?? 'owners') : 'owners',
    runtime === 'bun' && ids.length === 1 && ids[0] === SHELL_ID
      ? path.join(workspaceRoot, '.zerops/bun/bin/bun')
      : process.execPath,
    [path.join(workspaceRoot, 'scripts/zerops/serve-units.mts'), ...ids],
    workspaceRoot,
    env,
  );

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
  const responseHeaders: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) {
      responseHeaders[name] = value;
    }
  }
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
      ? HttpServerResponse.text(current.value, {
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
        })
      : HttpServerResponse.empty({ status: 503 });
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
    if (request.url === COMPOSITION_PATH) {
      return yield* compositionSourceResponse(request, loadComposition);
    }
    if (request.url === LIVE_PATH) {
      return HttpServerResponse.text('live\n', { headers: { 'cache-control': 'no-store' } });
    }
    if (request.url === READY_PATH) {
      const ready = yield* Ref.get(published);
      return HttpServerResponse.text(ready ? 'ready\n' : 'starting\n', {
        headers: { 'cache-control': 'no-store' },
        status: ready ? 200 : 503,
      });
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

// ---------------------------------------------------------------------------------------------------------------
// Host

export const runAppHost = Effect.gen(function* runAppHost() {
  yield* startProcessObservability('supervisor');
  const publicPort = yield* Config.Int('PORT').pipe(Config.withDefault(3000));
  const publicOrigin = (yield* Config.schema(PublicOriginSchema, 'ONTOS_PUBLIC_ORIGIN')).origin;
  const storefrontOrigin = (yield* Config.schema(PublicOriginSchema, 'ONTOS_STOREFRONT_ORIGIN')).origin;
  const ownerSecrets = yield* Config.Redacted('ONTOS_OWNER_SECRETS_JSON').pipe(
    Config.withDefault(Redacted.make('{}')),
    Effect.flatMap((encoded) => Schema.decodeEffect(OwnerSecretsSchema)(Redacted.value(encoded))),
    Effect.mapError(() => failure('ONTOS_OWNER_SECRETS_JSON must be an owner record of string secrets')),
  );
  const units = yield* readHostedUnits;
  const ports = new Map(units.map(({ id, port }) => [id, port]));
  const derived = derivedEnvironment(publicOrigin, storefrontOrigin, publicPort, ports);
  const node = process.execPath;
  const runtime = yield* shellRuntime;
  const published = yield* Ref.make(false);
  const database = yield* CoreDatabase;
  const pointer = yield* makeCompositionPointer(
    database.executor.execute<{
      readonly phase: string;
      readonly revision: string;
      readonly validUntilMillis: number;
    }>(
      sql`select phase, revision, (extract(epoch from valid_until) * 1000)::double precision as "validUntilMillis" from core.application_composition_authority where authority_key = 'active'`,
      'objects',
    ),
  );

  yield* HttpServer.serveEffect(hostApplication(ports, published, pointer.load));

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
    yield* startUnitProcess([SHELL_ID], runtime, shellEnvironment.environment),
    yield* startUnitProcess(ownerIds, runtime, ownersEnvironment.environment),
  ];
  yield* Console.log(`[app-host] Shell runtime ${runtime}; owners and Outbox runtime node`);
  yield* Console.log(`[app-host] serving ${String(units.length)} units; migrating`);

  const publish = Effect.gen(function* publishObservedComposition() {
    const snapshot = yield* observeOwners(units, publicOrigin);
    yield* publishApplicationCompositionAuthoritySnapshot(snapshot, pointer.publish(snapshot), Effect.void);
    yield* Console.log(
      `[app-host] composition ${snapshot.composition.revision} (${String(snapshot.composition.modules.length)} owners) valid until ${DateTime.formatIso(snapshot.validUntil)}`,
    );
  }).pipe(observeRuntimeJob('composition-publish'));

  // ONTOS_APP_HOST_PUBLISH=false starts and observes every unit without migrating or taking the authority, so a new
  // environment can be checked beside the one that still holds it.
  const takesAuthority = yield* Config.Boolean('ONTOS_APP_HOST_PUBLISH').pipe(Config.withDefault(true));
  const observeOnly = Effect.gen(function* observeWithoutAuthority() {
    yield* Effect.forEach(units, waitForOwner, { concurrency: 'unbounded', discard: true });
    const snapshot = yield* observeOwners(units, publicOrigin);
    yield* Console.log(
      `[app-host] observe-only: composition ${snapshot.composition.revision} (${String(snapshot.composition.modules.length)} owners) not published`,
    );
    yield* Ref.set(published, true);
    return yield* Effect.never;
  });

  const startup = Effect.gen(function* startupSequence() {
    yield* Effect.all(
      [
        runChild('migrator', node, ['scripts/run-zerops-migrator.mjs'], workspaceRoot, { MIGRATOR_ONCE: 'true' }),
        Effect.forEach(units, waitForOwner, { concurrency: 'unbounded', discard: true }),
      ],
      { concurrency: 'unbounded' },
    );
    yield* publish;
    // The canonical SpiceDB schema and the stage service grants follow the published release. A failure is logged
    // loudly but does not stop a release whose data is already served. Like the migrator, the reconciliation is
    // supervisor work: it installs the stage service principals with the database administrator identity.
    yield* runChild(
      'service-grants',
      node,
      ['scripts/demo/reconcile-stage-service-grants.mts', '--apply'],
      workspaceRoot,
      Struct.omit(processEnvironment([SHELL_ID, ...ownerIds], ownerSecrets, derived).environment, [
        'DATABASE_ADMIN_URL',
      ]),
    ).pipe(
      Effect.tapError((problem) => Console.error(`[app-host] service grant reconciliation failed: ${problem.reason}`)),
      Effect.ignore,
    );
    yield* Ref.set(published, true);
    const outbox = yield* startChild(OUTBOX_HOST_ID, node, [OUTBOX_HOST_BUNDLE], workspaceRoot, {
      ...processEnvironment([OUTBOX_HOST_ID, ...ownerIds], ownerSecrets, derived).environment,
      // The host's email trigger authenticates to the Shell's dispatch endpoint with the Shell's own secret.
      ...Object.fromEntries(
        Object.entries(ownerSecrets[SHELL_ID] ?? {}).filter(([key]) => key === 'ONTOS_EMAIL_DISPATCH_SECRET'),
      ),
      OUTBOX_WORKER_HEALTH_PORT: String(OUTBOX_HEALTH_PORT),
      PORT: String(OUTBOX_HEALTH_PORT),
    });
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

if (import.meta.main) {
  const program = runAppHost.pipe(
    Effect.scoped,
    Effect.provide(
      NodeHttpServer.layerConfig(createServer, {
        host: Config.succeed('0.0.0.0'),
        port: Config.Int('PORT').pipe(Config.withDefault(3000)),
      }),
    ),
    // Every authority transition re-observes legacy owner completion, as the operator publisher does.
    Effect.provide(
      Layer.merge(ApplicationCompositionAuthorityAdminDatabaseLive, ApplicationCompositionLegacyOwnersLive),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
    Effect.provide(ProcessDatabasePoolsLive),
    Effect.provideService(UrlParams.CurrentRedactedNames, authenticationQueryRedactions),
    Effect.tapCause((cause) => Console.error(`[app-host] stopped: ${String(cause)}`)),
  );
  const exit = await Effect.runPromiseExit(program);
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
