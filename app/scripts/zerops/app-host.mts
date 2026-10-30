#!/usr/bin/env node
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
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';

import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/index.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { isLoopbackHostname } from '../../packages/core-runtime/src/modules/application-composition-backend.ts';
import { OntosDeploymentAppIdSchema } from '../../packages/core-runtime/src/modules/manifest.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  decodeActiveApplicationCompositionSnapshot,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import type { ObservedArtifact, ObservedModuleDeployment } from '../active-application-composition.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  publishApplicationCompositionAuthoritySnapshot,
} from '../application-composition-authority-publication.mts';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const SHELL_ID = 'shell-super-app';
const OUTBOX_HOST_ID = 'outbox-worker-host';
const SHELL_PORT = 3020;
const OUTBOX_HEALTH_PORT = 4100;
const FIRST_SERVER_ONLY_PORT = 4200;
const MODULE_ASSET_PREFIX = '/_m/';
const FEDERATION_MANIFEST_PATH = '/mf-manifest.json';
const READY_PATH = '/_host/ready';
/** Loopback-only: the composition source every hosted process reads. */
const COMPOSITION_PATH = '/_host/composition';
const STARTUP_BUDGET = Duration.minutes(5);
const RELAY_HEADERS_TIMEOUT = Duration.seconds(60);

export class AppHostError extends Schema.TaggedError<AppHostError>()('AppHostError', { reason: Schema.String }) {}
const failure = (reason: string) => new AppHostError({ reason });

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({ path: Schema.NonEmptyString }),
    verticals: Schema.Array(
      Schema.Struct({
        id: OntosDeploymentAppIdSchema,
        moduleFederation: Schema.optionalKey(Schema.Struct({ manifestUrl: Schema.URLFromString })),
        path: Schema.NonEmptyString,
        surfaceProfile: Schema.optionalKey(Schema.Literal('api-only')),
      }),
    ),
  }),
);
const ReleaseIntentSchema = Schema.fromJsonString(
  Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })) }),
);
const OwnerSecretsSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);
type OwnerSecrets = typeof OwnerSecretsSchema.Type;

/** One owner server inside this container. */
export interface HostedOwner {
  readonly browser: boolean;
  readonly directory: string;
  readonly id: string;
  readonly port: number;
}

/** The Shell plus every owner the release intent serves, on stable loopback ports (topology ports first). */
export const hostedOwners = (
  topology: typeof TopologySchema.Type,
  intent: typeof ReleaseIntentSchema.Type,
): readonly HostedOwner[] => {
  const served = new Set(intent.modules.map(({ appId }) => appId));
  const verticals = topology.verticals.filter(({ id }) => served.has(id));
  const serverOnly = verticals.filter(
    (vertical) => vertical.surfaceProfile === 'api-only' || vertical.moduleFederation === undefined,
  );
  const owners = verticals.map((vertical): HostedOwner =>
    vertical.surfaceProfile !== 'api-only' && vertical.moduleFederation !== undefined
      ? {
          browser: true,
          directory: vertical.path,
          id: vertical.id,
          port: Number(vertical.moduleFederation.manifestUrl.port),
        }
      : {
          browser: false,
          directory: vertical.path,
          id: vertical.id,
          port: FIRST_SERVER_ONLY_PORT + serverOnly.indexOf(vertical),
        },
  );
  return [{ browser: true, directory: topology.shell.path, id: SHELL_ID, port: SHELL_PORT }, ...owners];
};

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
 * The environment overlay one process starts with: removed keys map to `undefined` (the child then never sees
 * them), host-derived settings win over stored owner secrets.
 */
export const ownerEnvironment = (
  processId: string,
  ownerSecrets: OwnerSecrets,
  derived: Readonly<Record<string, string>>,
) => {
  const hidden = [
    ...SUPERVISOR_ONLY_KEYS,
    ...Object.entries(OWNED_KEYS)
      .filter(([owner]) => owner !== processId)
      .flatMap(([, keys]) => keys),
  ];
  const removed = new Set(hidden);
  const own = Object.entries(ownerSecrets[processId] ?? {}).filter(
    ([key]) => !HOST_CONTROLLED_KEYS.has(key) && !removed.has(key),
  );
  return {
    ...Object.fromEntries(hidden.map((key) => [key, undefined])),
    ...Object.fromEntries(own),
    ...derived,
  } satisfies ChildEnvironment;
};

const PublicOriginSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'https:' && url.pathname === '/' && url.search === '' && url.hash === '' && url.username === ''
      ? undefined
      : 'ONTOS_PUBLIC_ORIGIN must be a bare HTTPS origin',
  ),
);

const loopbackOrigin = (port: number) => `http://127.0.0.1:${String(port)}`;

/** Settings every process derives from the one public origin of this environment and the host's own port. */
export const derivedEnvironment = (origin: string, hostPort: number) => ({
  BETTER_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_URL: origin,
  NODE_ENV: 'production',
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${loopbackOrigin(hostPort)}${COMPOSITION_PATH}`,
  ONTOS_GATEWAY_ISSUER: origin,
  ONTOS_SHELL_GATEWAY_BASE_URL: `${loopbackOrigin(SHELL_PORT)}/shell-super-app-api`,
});

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

/** Runs one finite child to a successful exit. */
const runChild = (name: string, command: string, args: readonly string[], cwd: string, env: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* runFiniteChild() {
      const handle = yield* ChildProcess.make(command, [...args], {
        cwd,
        env,
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
  ).pipe(Effect.catchTag('PlatformError', () => Effect.fail(failure(`${name} could not run`))));

// ---------------------------------------------------------------------------------------------------------------
// HTTP

const fetchLoopback = (url: string) =>
  Effect.gen(function* fetchLoopbackArtifact() {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
    return new Uint8Array(yield* response.arrayBuffer);
  }).pipe(Effect.scoped, Effect.timeout(ARTIFACT_FETCH_TIMEOUT));

const waitForOwner = (owner: HostedOwner) => {
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

const hostApplication = <Failure, Requirements>(
  ports: ReadonlyMap<string, number>,
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
) =>
  Effect.gen(function* routeHostRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.url === COMPOSITION_PATH) {
      return yield* compositionSourceResponse(request, loadComposition);
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

/** The candidate first, then the previously committed value, so either side of the authority commit matches. */
const withLatestFirst =
  (encoded: string) =>
  (current: readonly string[]): readonly string[] =>
    [encoded, ...current.filter((value) => value !== encoded)].slice(0, 2);

/**
 * The one approved snapshot this host serves. A value is readable only while the PostgreSQL authority names its
 * revision and lease, so the loopback source never serves a revision the database no longer admits.
 */
const makeCompositionPointer = Effect.gen(function* makePointer() {
  const database = yield* CoreDatabase;
  const journal = yield* Ref.make<readonly string[]>([]);
  const load = Effect.gen(function* loadApprovedPointer() {
    const [authority] = yield* database.executor.execute<{
      readonly phase: string;
      readonly revision: string;
      readonly validUntilMillis: number;
    }>(
      sql`select phase, revision, (extract(epoch from valid_until) * 1000)::double precision as "validUntilMillis" from core.application_composition_authority where authority_key = 'active'`,
      'objects',
    );
    if (authority === undefined || (authority.phase !== 'active' && authority.phase !== 'draining')) {
      return Option.none<string>();
    }
    for (const encoded of yield* Ref.get(journal)) {
      const approved = yield* decodeActiveApplicationCompositionSnapshot(encoded).pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.option,
      );
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
  const publish = (snapshot: ActiveApplicationCompositionSnapshot) =>
    encodeActiveApplicationCompositionSnapshot(snapshot).pipe(
      Effect.flatMap((encoded) => Ref.update(journal, withLatestFirst(encoded))),
    );
  return { load, publish };
});

const publicArtifactUrl = (owner: HostedOwner, artifactPath: string, publicOrigin: string) =>
  new URL(owner.id === SHELL_ID ? artifactPath : `${MODULE_ASSET_PREFIX}${owner.id}${artifactPath}`, publicOrigin).href;

/** Reads every artifact over loopback and records it under the public URL the browser and consumers use. */
const observeOwners = Effect.fn('AppHost.observeOwners')(function* observeOwners(
  owners: readonly HostedOwner[],
  publicOrigin: string,
) {
  const observe = (owner: HostedOwner, artifactPath: string) =>
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

const readJson = <A,>(relative: string, schema: Schema.Codec<A, string>) =>
  Effect.gen(function* readWorkspaceJson() {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeEffect(schema)(yield* fs.readFileString(path.join(workspaceRoot, relative)));
  });

export const runAppHost = Effect.gen(function* runAppHost() {
  const publicPort = yield* Config.Int('PORT').pipe(Config.withDefault(3000));
  const publicOrigin = (yield* Config.schema(PublicOriginSchema, 'ONTOS_PUBLIC_ORIGIN')).origin;
  const ownerSecrets = yield* Config.Redacted('ONTOS_OWNER_SECRETS_JSON').pipe(
    Config.withDefault(Redacted.make('{}')),
    Effect.flatMap((encoded) => Schema.decodeEffect(OwnerSecretsSchema)(Redacted.value(encoded))),
    Effect.mapError(() => failure('ONTOS_OWNER_SECRETS_JSON must be an owner record of string secrets')),
  );
  const owners = hostedOwners(
    yield* readJson('topology/reference-topology.json', TopologySchema),
    yield* readJson('topology/application-release-intent.json', ReleaseIntentSchema),
  );
  const ports = new Map(owners.map(({ id, port }) => [id, port]));
  const derived = derivedEnvironment(publicOrigin, publicPort);
  const node = process.execPath;
  const published = yield* Ref.make(false);
  const pointer = yield* makeCompositionPointer;

  yield* HttpServer.serveEffect(hostApplication(ports, published, pointer.load));

  const exits = yield* Effect.forEach(
    owners,
    (owner) =>
      startChild(
        owner.id,
        path.join(workspaceRoot, owner.directory, 'node_modules/.bin/modern'),
        ['serve'],
        path.join(workspaceRoot, owner.directory),
        { ...ownerEnvironment(owner.id, ownerSecrets, derived), PORT: String(owner.port) },
      ),
    { concurrency: 'unbounded' },
  );
  yield* Console.log(`[app-host] started ${String(owners.length)} owners; migrating`);

  const publish = Effect.gen(function* publishObservedComposition() {
    const snapshot = yield* observeOwners(owners, publicOrigin);
    yield* publishApplicationCompositionAuthoritySnapshot(snapshot, pointer.publish(snapshot), Effect.void);
    yield* Console.log(
      `[app-host] composition ${snapshot.composition.revision} (${String(snapshot.composition.modules.length)} owners) valid until ${DateTime.formatIso(snapshot.validUntil)}`,
    );
  });

  const startup = Effect.gen(function* startupSequence() {
    yield* Effect.all(
      [
        runChild('migrator', node, ['scripts/run-zerops-migrator.mjs'], workspaceRoot, { MIGRATOR_ONCE: 'true' }),
        Effect.forEach(owners, waitForOwner, { concurrency: 'unbounded', discard: true }),
      ],
      { concurrency: 'unbounded' },
    );
    yield* publish;
    yield* Ref.set(published, true);
    const outbox = yield* startChild(
      OUTBOX_HOST_ID,
      node,
      ['scripts/outbox-worker-host.generated.mts'],
      workspaceRoot,
      {
        ...ownerEnvironment(OUTBOX_HOST_ID, ownerSecrets, derived),
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
  return yield* Effect.raceFirst(Effect.raceAllFirst(exits), startup);
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
    Effect.provide(ApplicationCompositionAuthorityAdminDatabaseLive),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
    Effect.tapCause((cause) => Console.error(`[app-host] stopped: ${String(cause)}`)),
  );
  const exit = await Effect.runPromiseExit(program);
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
