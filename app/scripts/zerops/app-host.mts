#!/usr/bin/env node
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { makeDatabaseIdentityEnrollmentLive } from '../../packages/core-runtime/src/db/database-identities.ts';
import { DatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import {
  TenantIntentLoader,
  TenantIntentLoaderLive,
} from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { startProcessObservability } from './process-observability.mts';
import {
  OWNERS_SEMI_SPACE_MIB,
  OWNERS_YOUNG_GENERATION_ARGUMENTS,
  heapLimitArguments,
  heapLimitMiB,
  readContainerMemoryBytes,
} from './heap-limits.mts';
import { withKeepAlive } from './http-keep-alive.mts';
import { compositionSnapshotResponse } from './composition-source-response.mts';
import {
  HOST_REFUSAL_LOG_WINDOW,
  RelayFailure,
  decodeRelayCause,
  makeHostRefusalLog,
  relayFailureCode,
  requestPathOnly,
} from './host-refusal-log.mts';
import type { HostRefusalLog } from './host-refusal-log.mts';
import { observeRuntimeJob } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';
import { ProcessDatabasePoolsLive } from './process-database-pools.mts';
import {
  earliestExpiryOf,
  encodeModuleCredentialHandover,
  MODULE_CREDENTIAL_CALLERS,
  MODULE_CREDENTIAL_HANDOVER_GRACE,
  MODULE_CREDENTIAL_HANDOVER_VARIABLE,
  MODULE_CREDENTIAL_ROTATION_LEAD,
  noProvisionedCredentials,
  providerKeyIdsOf,
  ProvisioningOutputJsonSchema,
} from './module-credentials.mts';
import type { ProvisioningOutput } from './module-credentials.mts';
import { liveModuleKeyIds } from './module-credential-liveness.mts';
import { workloadEntryAppId } from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
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
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { fromReadable, toReadable } from '@effect/platform-node/NodeStream';
import { request as requestLoopback } from '@effect/platform-node/Undici';
import { sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Redacted,
  Queue,
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

/** One process's private handover channel: each message queued here reaches its file descriptor 3, in order. */
export type HandoverChannel = Queue.Queue<Uint8Array>;

/**
 * Starts one long-running child in the current Scope. Its exit, for any reason, fails the returned effect. A child
 * given a handover channel reads it on its file descriptor 3 (never its environment, arguments, stdin or stdout).
 */
const startChild = Effect.fn('AppHost.startChild')(function* startChild(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: ChildEnvironment,
  channel?: HandoverChannel,
) {
  const additionalFds =
    channel === undefined ? undefined : { fd3: { stream: Stream.fromQueue(channel), type: 'input' as const } };
  const handle = yield* ChildProcess.make(command, [...args], {
    additionalFds,
    cwd,
    // The channel lives as long as this host: its end tells the child the host is gone, so it never runs orphaned.
    env: channel === undefined ? { ...env } : { ...env, [MODULE_CREDENTIAL_HANDOVER_VARIABLE]: 'fd3-lifetime' },
    extendEnv: true,
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  }).pipe(Effect.mapError(() => failure(`${name} failed to start`)));
  const started = yield* Clock.currentTimeMillis;
  // The supervisor restarts nothing itself: any exit stops the host, and Zerops restarts the container.
  const exited = (outcome: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Console.error(
          `[app-host] ${name} ${outcome} after ${String(Math.round((now - started) / 1000))}s up; the host stops so Zerops restarts the container`,
        ),
      ),
    );
  return handle.exitCode.pipe(
    Effect.matchEffect({
      onFailure: () =>
        exited('could no longer be watched').pipe(Effect.andThen(Effect.fail(failure(`${name} failed while running`)))),
      onSuccess: (code) =>
        exited(`exited with code ${String(code)}`).pipe(
          Effect.andThen(Effect.fail(failure(`${name} exited with code ${String(code)}`))),
        ),
    }),
  );
});

/** The hosted owners that call other modules, each of which gets its own module credential. */
export const moduleCredentialCallersOf = (ownerIds: readonly string[]): readonly string[] =>
  ownerIds.filter((ownerId) => MODULE_CREDENTIAL_CALLERS.includes(ownerId));

/**
 * A long-running child that holds a module credential channel. `handOver` queues a message on its channel, which it
 * reads on its file descriptor 3 for as long as it runs: its first keys, a late key, a fresh key after a revocation
 * and every rotation, each replacing the key an owner held, never a restart. `exit` fails, like any child, when it
 * exits on its own.
 */
export interface CredentialHolder<Requirements = never> {
  readonly exit: Effect.Effect<never, AppHostError, Requirements>;
  readonly handOver: (message: Uint8Array) => Effect.Effect<void>;
}

export const makeCredentialHolder = Effect.fn('AppHost.makeCredentialHolder')(function* makeCredentialHolder<
  Requirements,
>(
  spawn: (
    channel: HandoverChannel,
  ) => Effect.Effect<Effect.Effect<never, AppHostError>, AppHostError, Requirements | Scope.Scope>,
  initial?: Uint8Array,
) {
  const channel = yield* Queue.unbounded<Uint8Array>();
  if (initial !== undefined) {
    yield* Queue.offer(channel, initial);
  }
  return {
    exit: spawn(channel).pipe(Effect.flatten, Effect.scoped),
    handOver: (message) => Queue.offer(channel, message).pipe(Effect.asVoid),
  } satisfies CredentialHolder<Exclude<Requirements, Scope.Scope>>;
});

const mebibytes = (bytes: number) => String(Math.floor(bytes / 1024 / 1024));

/**
 * Only the single-unit Shell process can use the packaged Bun binary. Every other unit process uses Node. The Shell on
 * Node gets its heap share of the container (heap-limits.mts); Bun has no V8 heap flag. The owners keep Node's own
 * old-space limit and get a larger young generation, so request garbage dies young (heap-limits.mts).
 */
export const startUnitProcess = (
  ids: readonly string[],
  runtime: typeof ShellRuntime.Type,
  env: ChildEnvironment,
  memoryBytes: number,
  channel?: HandoverChannel,
) => {
  const name = ids.length === 1 ? (ids[0] ?? 'owners') : 'owners';
  const shell = ids.length === 1 && ids[0] === SHELL_ID;
  const bun = runtime === 'bun' && shell;
  let heap: readonly string[] = shell ? [] : OWNERS_YOUNG_GENERATION_ARGUMENTS;
  let limit = `Node default, semi-space ${String(OWNERS_SEMI_SPACE_MIB)} MiB`;
  if (bun) {
    limit = 'Bun default';
  } else if (shell) {
    heap = heapLimitArguments('shell', memoryBytes);
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
        channel,
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

const PROVISIONING_SCRIPT = path.join(workspaceRoot, 'scripts/zerops/provision-module-credentials.mts');
/**
 * The bound of one provisioning pass. A boot runs one pass before it verifies release access and publishes, so this is
 * all the time module credentials can add to a deploy (Zerops allows the whole start 15 minutes, `zerops.yaml`
 * `readinessCheck.failureTimeout`). A pass that fails or overruns leaves the callers without a key: their delegated
 * calls fail closed, the host publishes anyway, and the healing loop retries a minute later.
 */
export const PROVISIONING_BUDGET = Duration.minutes(2);

/**
 * Runs one finite child to a successful exit and returns what it wrote to its private channel (file descriptor 3),
 * which only this process reads. Its standard output and standard error stay logs, so a stray log line never reaches
 * the channel. Interrupting the effect (its time budget) stops the child.
 */
export const captureChannel = (name: string, args: readonly string[], env: ChildEnvironment) =>
  Effect.scoped(
    Effect.gen(function* runCapturedChild() {
      const handle = yield* ChildProcess.make(process.execPath, [...args], {
        additionalFds: { fd3: { type: 'output' } },
        cwd: workspaceRoot,
        env: finiteProcessEnvironment(env),
        extendEnv: true,
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'inherit',
      });
      const [output, code] = yield* Effect.all(
        [handle.getOutputFd(3).pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: 2 },
      );
      if (code !== 0) {
        return yield* failure(`${name} exited with code ${String(code)}`);
      }
      return output;
    }),
  ).pipe(
    observeRuntimeJob('supervisor-child', name),
    Effect.catchTag('PlatformError', () => Effect.fail(failure(`${name} could not run`))),
  );

/** The release a host serves, as its module credentials are attested: the revision and each module's build. */
export interface HostRelease {
  readonly buildMarkers: Readonly<Record<string, string>>;
  readonly compositionRevision: string;
}

export const hostReleaseOf = (snapshot: ActiveApplicationCompositionSnapshot): HostRelease => ({
  buildMarkers: Object.fromEntries(
    snapshot.composition.modules.map(({ deployment }) => [deployment.appId, deployment.buildMarker] as const),
  ),
  compositionRevision: snapshot.composition.revision,
});

/**
 * This host's identity: the container's host name, and a fresh id for this boot of the host process. Every key the
 * host issues is attested with both, so it can prove which keys are its own and retire its earlier boots' keys.
 */
const HOST_ID = hostname();
const BOOT_ID = randomUUID();

/**
 * One provisioning pass for the given callers of this host's release, with the Shell's settings: each key is attested
 * for its module's build and the release's revision. It never fails the host and never retries: a pass that cannot
 * run within `PROVISIONING_BUDGET` leaves those callers without a key (their delegated calls fail closed), the host
 * says so loudly, and the background healing retries.
 */
export const provisionModuleCredentialsForReleaseWith =
  <Requirements,>(
    capture: (
      name: string,
      args: readonly string[],
      env: ChildEnvironment,
    ) => Effect.Effect<string, AppHostError, Requirements>,
  ) =>
  (input: {
    readonly appIds: readonly string[];
    readonly operationId: string;
    readonly release: HostRelease;
    readonly shellEnvironment: ChildEnvironment;
  }) => {
    const builds = input.appIds.flatMap((appId) => {
      const buildMarker = input.release.buildMarkers[appId];
      return buildMarker === undefined ? [] : [`${appId}=${buildMarker}`];
    });
    return builds.length === 0
      ? Effect.succeed(noProvisionedCredentials(input.appIds))
      : capture(
          'module-credentials',
          [
            PROVISIONING_SCRIPT,
            'issue',
            `--operation=${input.operationId}`,
            `--host=${HOST_ID}`,
            `--boot=${BOOT_ID}`,
            `--revision=${input.release.compositionRevision}`,
            ...builds,
          ],
          input.shellEnvironment,
        ).pipe(
          Effect.flatMap((output) =>
            Schema.decodeEffect(ProvisioningOutputJsonSchema)(output.trim()).pipe(
              Effect.mapError(() => failure('the module credential provisioning output is malformed')),
            ),
          ),
          Effect.timeoutOrElse({
            duration: PROVISIONING_BUDGET,
            orElse: () => Effect.fail(failure('module credential provisioning exceeded its time budget')),
          }),
          Effect.tap((output) =>
            output.failedAppIds.length === 0
              ? Console.log(`[app-host] module credentials issued for ${Object.keys(output.credentials).join(', ')}`)
              : Console.error(
                  `[app-host] MODULE CREDENTIALS UNAVAILABLE for ${output.failedAppIds.join(', ')}; their delegated calls fail closed until a retry succeeds`,
                ),
          ),
          Effect.catchTag('AppHostError', () =>
            Console.error(
              `[app-host] MODULE CREDENTIAL PROVISIONING FAILED; delegated calls of ${input.appIds.join(', ')} fail closed until a retry succeeds`,
            ).pipe(Effect.as(noProvisionedCredentials(input.appIds))),
          ),
        );
  };

export const provisionModuleCredentialsForRelease = provisionModuleCredentialsForReleaseWith(captureChannel);

/**
 * Where this container records the boots of its host process. A container runs one host process at a time, so every
 * boot recorded here other than the current one is a host process of this container that has ended: its keys are
 * provably this host's own and no longer held by anything running. A new container (every deploy) starts with no
 * record, so it never names the boots of the container it replaces, which keeps serving until the switch, whatever
 * host name either of them has.
 */
export const HOST_BOOT_RECORD = path.join(workspaceRoot, '.zerops/state/module-credential-boots.json');
const HOST_BOOT_RECORD_LIMIT = 20;
const HostBootRecordJson = Schema.fromJsonString(Schema.Array(Schema.String.check(Schema.isUUID())));

/**
 * Records this boot in the container's boot record and returns the earlier boots recorded there. A record that cannot
 * be read names no earlier boot, and one that cannot be written is reported: either way nothing is retired that this
 * host cannot prove is its own; those keys end within a day.
 */
export const recordHostBoot = Effect.fn('AppHost.recordHostBoot')(function* recordHostBoot(
  file: string,
  bootId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const earlier = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(HostBootRecordJson)),
    Effect.orElseSucceed((): readonly string[] => []),
  );
  const recorded = yield* Schema.encodeEffect(HostBootRecordJson)(
    [...earlier, bootId].slice(-HOST_BOOT_RECORD_LIMIT),
  ).pipe(
    Effect.flatMap((json) =>
      fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.andThen(fs.writeFileString(file, json))),
    ),
    Effect.exit,
  );
  if (Exit.isFailure(recorded)) {
    yield* Console.error('[app-host] this boot could not be recorded; its keys end within a day if never retired');
  }
  return earlier.filter((earlierBoot) => earlierBoot !== bootId);
});

/** One retirement pass of the provisioning program, reported and never failing the host. */
const runRetirement = (
  pass: 'retire' | 'retire-own',
  input: {
    readonly compositionRevision: string;
    readonly earlierBoots: readonly string[];
    readonly providerKeyIds: readonly string[];
    readonly shellEnvironment: ChildEnvironment;
  },
) =>
  captureChannel(
    pass === 'retire' ? 'module-credential-retirement' : 'own-module-credential-retirement',
    [
      PROVISIONING_SCRIPT,
      pass,
      `--operation=${randomUUID()}`,
      `--host=${HOST_ID}`,
      `--boot=${BOOT_ID}`,
      `--revision=${input.compositionRevision}`,
      ...(pass === 'retire-own' ? [`--earlier-boots=${input.earlierBoots.join(',')}`] : []),
      ...input.providerKeyIds,
    ],
    input.shellEnvironment,
  ).pipe(
    Effect.asVoid,
    Effect.catchTag('AppHostError', () =>
      Console.error(
        pass === 'retire'
          ? '[app-host] superseded module credentials could not be retired; the next boot retries'
          : "[app-host] this host's own earlier module credentials could not be retired; the next renewal retries",
      ),
    ),
  );

/**
 * Once the grace period passed for delegated calls already started with keys being replaced, retires the host's own
 * keys it no longer holds (`retire-own`): exactly the provider key ids this boot `replaced`, and every key of the
 * ended boots its container recorded (`earlierBoots`). It never names a key of this boot it still holds or of another
 * container, even one with the same host name. With `superseded`, the host's release took the authority, and it then
 * also retires the credentials that release superseded, keeping the keys it holds when that pass runs (`current`,
 * read then, so a key a fill issued during the grace period is kept too): the provisioning
 * program decides from the authority row, only while this release holds it and only credentials bound before its
 * revision took it. A failure is reported; the next renewal or boot retries.
 */
export interface RetirementAfterHandover {
  readonly compositionRevision: string;
  readonly current: Effect.Effect<readonly string[]>;
  readonly earlierBoots: readonly string[];
  readonly replaced: readonly string[];
  readonly shellEnvironment: ChildEnvironment;
  readonly superseded: boolean;
}

/** The same, with the given runner of one retirement pass (the provisioning program in the host). */
export const retireAfterHandoverWith =
  <Requirements,>(
    run: (
      pass: 'retire' | 'retire-own',
      retiring: Parameters<typeof runRetirement>[1],
    ) => Effect.Effect<void, never, Requirements>,
  ) =>
  (input: RetirementAfterHandover) =>
    Effect.gen(function* retireReplacedKeys() {
      if (input.replaced.length > 0 || input.earlierBoots.length > 0) {
        yield* run('retire-own', { ...input, providerKeyIds: input.replaced });
      }
      if (!input.superseded) {
        return;
      }
      // Even when the boot pass issued nothing: the superseded release's keys are retired all the same, and any key a
      // later fill issues is bound after this release took the authority, so the cutoff never reaches it.
      yield* run('retire', { ...input, providerKeyIds: yield* input.current });
    }).pipe(Effect.delay(MODULE_CREDENTIAL_HANDOVER_GRACE));

export const retireAfterHandover = retireAfterHandoverWith(runRetirement);

/**
 * The keys this boot replaced, with when: a replaced key stays in use for the grace period after its hand-over (calls
 * already started with it), and its own renewal retires it then. Until that moment the superseded-key retirement must
 * keep it too, or a renewal in the first minutes after publishing would have its replaced keys revoked at once.
 */
interface ReplacedKey {
  readonly at: number;
  readonly providerKeyId: string;
}
const replacedAt =
  (at: number) =>
  (providerKeyId: string): ReplacedKey => ({ at, providerKeyId });
const replacedWithin = (now: number, grace: number) => (replaced: ReplacedKey) => now - replaced.at < grace;
const replacedKeyIdOf = (replaced: ReplacedKey) => replaced.providerKeyId;

export const makeReplacedKeyLedger = Effect.gen(function* replacedKeyLedger() {
  const replaced = yield* Ref.make<readonly ReplacedKey[]>([]);
  const record = Effect.fn('AppHost.recordReplacedKeys')(function* recordReplacedKeys(
    providerKeyIds: readonly string[],
  ) {
    const stamp = replacedAt(yield* Clock.currentTimeMillis);
    yield* Ref.update(replaced, (earlier) => [...earlier, ...providerKeyIds.map(stamp)]);
  });
  /** The keys held now and those replaced less than the grace period ago: what a superseded retirement keeps. */
  const keptWith = Effect.fn('AppHost.keptKeys')(function* keptKeys(held: Effect.Effect<readonly string[]>) {
    const within = replacedWithin(yield* Clock.currentTimeMillis, Duration.toMillis(MODULE_CREDENTIAL_HANDOVER_GRACE));
    const recent = yield* Ref.updateAndGet(replaced, (all) => all.filter(within));
    return [...new Set([...(yield* held), ...recent.map(replacedKeyIdOf)])];
  });
  return { keptWith, record };
});

/**
 * A held workload entry a pass leaves behind: its module got its module key and all its workload keys in this pass
 * (no failure), yet this one is not among them, because the operator no longer registers that workload in that
 * tenant. Its key is retired and no longer handed over; otherwise its end would ask for a renewal every step.
 */
const droppedWorkloadEntry = (fresh: ProvisioningOutput) => {
  const failed = new Set<string>(fresh.failedAppIds);
  const renewed = new Set(Object.keys(fresh.credentials).filter((appId) => !failed.has(appId)));
  return (entry: string) =>
    entry.includes('/') && renewed.has(workloadEntryAppId(entry)) && fresh.keys[entry] === undefined;
};

/** The provider key ids `held` had for the modules `fresh` gave a new key: what a renewal replaced. */
export const replacedKeyIdsOf = (held: ProvisioningOutput, fresh: ProvisioningOutput): readonly string[] => {
  const dropped = droppedWorkloadEntry(fresh);
  return Object.entries(held.keys).flatMap(([entry, key]) =>
    (fresh.keys[entry] !== undefined && fresh.keys[entry].providerKeyId !== key.providerKeyId) || dropped(entry)
      ? [key.providerKeyId]
      : [],
  );
};

/**
 * What the host holds after a pass: each module's newest key (a module the pass missed keeps the key it held) and the
 * callers that still hold none.
 */
export const mergeProvisioning = (held: ProvisioningOutput, fresh: ProvisioningOutput): ProvisioningOutput => {
  const dropped = droppedWorkloadEntry(fresh);
  const kept = <Value,>(entries: Readonly<Record<string, Value>>) =>
    Object.fromEntries(Object.entries(entries).filter(([entry]) => !dropped(entry)));
  return {
    credentials: { ...held.credentials, ...fresh.credentials },
    failedAppIds: fresh.failedAppIds.filter((appId) => held.keys[appId] === undefined),
    keys: { ...kept(held.keys), ...fresh.keys },
    schemaVersion: 1,
    workloadCredentials: { ...kept(held.workloadCredentials), ...fresh.workloadCredentials },
  };
};

/**
 * What healing does next: nothing, fill the callers that hold no key, or renew every caller's key, because some key
 * the host holds was revoked (another host retired it) or its keys end within `MODULE_CREDENTIAL_ROTATION_LEAD`.
 */
export type ModuleCredentialHealing =
  | { readonly appIds: readonly string[]; readonly kind: 'fill' }
  | { readonly kind: 'none' }
  | { readonly kind: 'renew'; readonly reason: 'expiring' | 'revoked' };

/** Whether the keys the host holds end within `MODULE_CREDENTIAL_ROTATION_LEAD`: known locally, no read needed. */
const nearTheirEnd = (held: ProvisioningOutput, nowMillis: number) => {
  const earliest = earliestExpiryOf(held);
  return earliest !== undefined && earliest - Duration.toMillis(MODULE_CREDENTIAL_ROTATION_LEAD) <= nowMillis;
};

/**
 * What healing does next, given what the host holds, which module credentials are still active (`none` when that
 * could not be read), and the time. Without the read only rotation by end of life is decided: it needs nothing but
 * the ends the host holds, so an unreadable store never lets keys run out.
 */
export const planModuleCredentialHealing = (
  held: ProvisioningOutput,
  activeProviderKeyIds: Option.Option<ReadonlySet<string>>,
  nowMillis: number,
): ModuleCredentialHealing => {
  if (
    Option.isSome(activeProviderKeyIds) &&
    providerKeyIdsOf(held).some((providerKeyId) => !activeProviderKeyIds.value.has(providerKeyId))
  ) {
    return { kind: 'renew', reason: 'revoked' };
  }
  if (nearTheirEnd(held, nowMillis)) {
    return { kind: 'renew', reason: 'expiring' };
  }
  return Option.isNone(activeProviderKeyIds) || held.failedAppIds.length === 0
    ? { kind: 'none' }
    : { appIds: held.failedAppIds, kind: 'fill' };
};

/** How many healing steps in a row could not read liveness, and renewed because keys looked revoked. */
export interface ModuleCredentialHealingStreaks {
  readonly revocations: number;
  readonly unreadable: number;
}

const HEALING_INTERVAL = Duration.minutes(1);
const HEALING_BACKOFF_CAP = Duration.minutes(15);

/** The inputs of one host's credential healing. */
export interface ModuleCredentialHealingInput<Requirements> {
  readonly activeProviderKeyIds: Effect.Effect<ReadonlySet<string>, unknown, Requirements>;
  readonly callers: readonly string[];
  readonly held: Ref.Ref<ProvisioningOutput>;
  readonly holders: Effect.Effect<readonly Pick<CredentialHolder, 'handOver'>[]>;
  readonly issue: (appIds: readonly string[]) => Effect.Effect<ProvisioningOutput, never, Requirements>;
  /** Retires exactly the given keys this boot replaced (and its container's ended boots' keys), after the grace. */
  readonly retireOwn: (replaced: readonly string[]) => Effect.Effect<void, never, Requirements>;
  readonly serving: Effect.Effect<boolean>;
}

/**
 * One healing step. Returns whether every caller now holds a live key, so the caller can back off while not. When a
 * key the host holds was revoked (another host retired it) it says so loudly; then, and when its keys near their end,
 * it issues every caller a fresh key, hands the fresh keys to every process holding the old ones (each replaces its
 * owner's key, no restart) and, after the grace period, retires its own replaced keys. A caller without a key gets one
 * handed over late. A pass that issues nothing changes nothing: the keys held stay in use until they end. An
 * unreadable enrolment is not evidence of anything.
 */
export const healModuleCredentialsOnce = Effect.fn('AppHost.healModuleCredentialsOnce')(function* healOnce<
  Requirements,
>(input: ModuleCredentialHealingInput<Requirements>, streaks: Ref.Ref<ModuleCredentialHealingStreaks>) {
  const active = yield* input.activeProviderKeyIds.pipe(Effect.option);
  const before = yield* Ref.getAndUpdate(streaks, (counted) => ({
    ...counted,
    unreadable: Option.isNone(active) ? counted.unreadable + 1 : 0,
  }));
  if (Option.isNone(active) && before.unreadable === 0) {
    yield* Console.error(
      '[app-host] module credential liveness could not be read; keys are still rotated before they end, revocations are noticed once it can be read again',
    );
  }
  if (Option.isSome(active) && before.unreadable > 0) {
    yield* Console.log(
      `[app-host] module credential liveness readable again after ${String(before.unreadable)} step(s)`,
    );
  }
  const held = yield* Ref.get(input.held);
  const plan = planModuleCredentialHealing(held, active, yield* Clock.currentTimeMillis);
  const revoked = plan.kind === 'renew' && plan.reason === 'revoked';
  const { revocations } = yield* Ref.updateAndGet(streaks, (counted) => ({
    ...counted,
    revocations: revoked ? counted.revocations + 1 : 0,
  }));
  if (plan.kind === 'none') {
    return true;
  }
  if (plan.kind === 'renew') {
    yield* revoked
      ? Console.error(
          `[app-host] MODULE CREDENTIALS OF THIS HOST WERE REVOKED (${String(revocations)} renewal(s) in a row); issuing and handing over fresh ones`,
        )
      : Console.log('[app-host] module credentials near their end; rotating them');
  }
  const appIds = plan.kind === 'fill' ? plan.appIds : input.callers;
  const fresh = yield* input.issue(appIds);
  if (providerKeyIdsOf(fresh).length === 0) {
    return false;
  }
  const next = mergeProvisioning(held, fresh);
  yield* Ref.set(input.held, next);
  const message = yield* encodeModuleCredentialHandover(
    fresh.credentials,
    [
      ...new Set([
        ...Object.keys(fresh.credentials),
        ...Object.keys(fresh.workloadCredentials).map(workloadEntryAppId),
      ]),
    ],
    // Each named owner's complete current set: the receiver replaces an owner's workloads with what it is handed.
    next.workloadCredentials,
  ).pipe(Effect.orDie);
  yield* Effect.forEach(yield* input.holders, (holder) => holder.handOver(message), { concurrency: 1, discard: true });
  if (plan.kind === 'renew') {
    // Exactly the keys this renewal replaced, which only this boot ever held: never a key it was not told about.
    yield* input.retireOwn(replacedKeyIdsOf(held, fresh));
  }
  // A renewal because keys looked revoked backs off like a failure: if the store keeps saying "not live" (wrongly or
  // not), the host reissues after 2, 4, 8 and then every 15 minutes, never every minute.
  return fresh.failedAppIds.length === 0 && !revoked;
});

/**
 * Keeps this host's callers holding live module credentials, in the background, for as long as it serves: one
 * healing step a minute, backing off (up to a quarter hour) while a pass keeps failing.
 */
export const healModuleCredentials = <Requirements,>(input: ModuleCredentialHealingInput<Requirements>) =>
  Effect.gen(function* healCredentials() {
    let backoff = HEALING_INTERVAL;
    const streaks = yield* Ref.make<ModuleCredentialHealingStreaks>({ revocations: 0, unreadable: 0 });
    while (yield* input.serving.pipe(Effect.delay(backoff))) {
      const healthy = yield* healModuleCredentialsOnce(input, streaks);
      backoff = healthy ? HEALING_INTERVAL : Duration.min(Duration.times(backoff, 2), HEALING_BACKOFF_CAP);
    }
    return yield* Console.log('[app-host] superseded; module credential healing stops');
  });

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

const unitAddress = ({ id, port }: HostedUnit) => `${id} 127.0.0.1:${String(port)}`;

/** Waits until every unit serves its contract, then names each unit and its port in one line. */
const waitForUnits = (units: readonly HostedUnit[]) =>
  Effect.forEach(units, waitForOwner, { concurrency: 'unbounded', discard: true }).pipe(
    Effect.andThen(
      Console.log(`[app-host] all ${String(units.length)} units serving: ${units.map(unitAddress).join(', ')}`),
    ),
  );

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
  reportCut: (problem: RelayFailure) => Effect.Effect<void>,
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
    catch: (cause) => new RelayFailure({ code: relayFailureCode(decodeRelayCause(cause)), stage: 'request' }),
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
  // The status and headers are sent by then: a unit that fails its body cuts the response, and that is logged.
  return HttpServerResponse.stream(
    fromReadable<Uint8Array, RelayFailure>({
      evaluate: () => response.body,
      onError: (cause) => new RelayFailure({ code: relayFailureCode(decodeRelayCause(cause)), stage: 'response body' }),
    }).pipe(Stream.tapError(reportCut)),
    { headers: responseHeaders, status: response.statusCode },
  );
});

const isLoopbackPeer = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(request.remoteAddress, isLoopbackHostname);

/** Fields of a refusal the host answered itself: the method and the path, never the query, headers or body. */
const refusedRequest = (request: HttpServerRequest.HttpServerRequest, status: number) => ({
  method: request.method,
  path: requestPathOnly(request.url),
  status,
});

/**
 * Only processes inside this container read the composition; public peers get 404 without a log line (a public probe
 * of an internal path is expected noise). A process inside the container that is refused is logged: a reader with a
 * wrong method, or a published host that has no snapshot it may serve (before publication, 503 is the expected
 * answer while the host starts).
 */
const compositionSourceResponse = <Failure, Requirements>(
  request: HttpServerRequest.HttpServerRequest,
  published: Ref.Ref<boolean>,
  load: Effect.Effect<Option.Option<string>, Failure, Requirements>,
  refusals: HostRefusalLog,
) =>
  Effect.gen(function* serveApprovedSnapshot() {
    if (!isLoopbackPeer(request)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    if (request.method !== 'GET') {
      yield* refusals.record({
        fields: refusedRequest(request, 404),
        key: 'composition',
        what: 'composition source refused',
      });
      return HttpServerResponse.empty({ status: 404 });
    }
    const current = yield* load.pipe(Effect.option, Effect.map(Option.flatten));
    if (Option.isSome(current)) {
      return compositionSnapshotResponse(current.value, request.headers['if-none-match']);
    }
    if (yield* Ref.get(published)) {
      yield* refusals.record({
        fields: { ...refusedRequest(request, 503), reason: 'no snapshot the authority admits' },
        key: 'composition',
        what: 'composition source unavailable',
      });
    }
    return HttpServerResponse.empty({ status: 503 });
  });

/** Liveness, readiness and the loopback composition source; none for every application path. */
const hostControlResponse = <Failure, Requirements>(
  request: HttpServerRequest.HttpServerRequest,
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
  refusals: HostRefusalLog,
) =>
  Effect.gen(function* answerHostControl() {
    if (request.url === COMPOSITION_PATH) {
      return Option.some(yield* compositionSourceResponse(request, published, loadComposition, refusals));
    }
    if (request.url === LIVE_PATH) {
      return Option.some(HttpServerResponse.text('live\n', { headers: { 'cache-control': 'no-store' } }));
    }
    if (request.url === READY_PATH) {
      // A readiness probe before publication is expected to answer 503; the boot lines say why.
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

/**
 * The loopback control port: Zerops probes and the composition source, never application traffic. Only processes
 * of this container reach it, so any other path is a misconfigured caller and is logged.
 */
export const hostControlApplication = <Failure, Requirements>(
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
  refusals: HostRefusalLog = makeHostRefusalLog(),
) =>
  Effect.gen(function* routeControlRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const control = yield* hostControlResponse(request, published, loadComposition, refusals);
    if (Option.isSome(control)) {
      return control.value;
    }
    yield* refusals.record({ fields: refusedRequest(request, 404), key: 'control', what: 'control port refused' });
    return HttpServerResponse.empty({ status: 404 });
  });

/** The unit a public path is relayed to: `/_m/<appId>/…` names an owner, everything else is the Shell's. */
const routedUnit = (url: string) => {
  if (!url.startsWith(MODULE_ASSET_PREFIX)) {
    return SHELL_ID;
  }
  const rest = requestPathOnly(url).slice(MODULE_ASSET_PREFIX.length);
  const separator = rest.indexOf('/');
  return separator === -1 ? rest : rest.slice(0, separator);
};

export const hostApplication = <Failure, Requirements>(
  ports: ReadonlyMap<string, number>,
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
  refusals: HostRefusalLog = makeHostRefusalLog(),
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
      const fixture = yield* stageCimdFixtureResponse;
      // It exists only on stage under the stage origin; a refusal there breaks MCP client sign-in, so it is logged.
      if (fixture.status >= 400) {
        yield* refusals.record({
          fields: refusedRequest(request, fixture.status),
          key: 'cimd-fixture',
          what: 'stage client metadata refused',
        });
      }
      return fixture;
    }
    const control = yield* hostControlResponse(request, published, loadComposition, refusals);
    if (Option.isSome(control)) {
      return control.value;
    }
    const route = routeRequest(request.url, ports);
    const unit = routedUnit(request.url);
    if (Option.isNone(route)) {
      yield* refusals.record({
        fields: { ...refusedRequest(request, 404), unit },
        key: 'unrouted',
        what: 'no unit serves this path',
      });
      return HttpServerResponse.empty({ status: 404 });
    }
    const { path: upstreamPath, port } = route.value;
    const started = yield* Clock.currentTimeMillis;
    const report = (problem: RelayFailure, status: number | 'cut') =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          refusals.record({
            fields: {
              cause: problem.code,
              elapsedMs: now - started,
              method: request.method,
              path: requestPathOnly(request.url),
              stage: problem.stage,
              status,
              unit,
              upstream: `loopback:${String(port)}`,
            },
            key: unit,
            what: status === 'cut' ? 'relayed response cut by its unit' : 'relay refused',
          }),
        ),
      );
    return yield* relay(request, port, upstreamPath, (problem) => report(problem, 'cut')).pipe(
      Effect.catchTag('RelayFailure', (problem) =>
        report(problem, 502).pipe(Effect.as(HttpServerResponse.text('Upstream unavailable\n', { status: 502 }))),
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
  // One refusal log for the control and the public port; it writes the counts it held back every 10 seconds.
  const refusals = makeHostRefusalLog();
  yield* refusals.flush.pipe(Effect.repeat(Schedule.spaced(HOST_REFUSAL_LOG_WINDOW)), Effect.forkScoped);
  yield* HttpServer.serveEffect(hostControlApplication(published, pointer.load, refusals));
  const publicScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(publicScope, Exit.void));
  const openPublicPort = NodeHttpServer.make(withKeepAlive(createServer), { host: '0.0.0.0', port: publicPort }).pipe(
    Effect.mapError(() => failure(`public port ${String(publicPort)} could not be opened`)),
    Effect.flatMap((server) => server.serve(hostApplication(ports, published, pointer.load, refusals))),
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
  // Owners start holding no module credential: a key is attested for the release's revision, which exists only once
  // the owners run and are observed. The platform issues the keys after migrations and schema verification and before
  // this host serves any traffic, and hands each hosted caller's key over the owners' private channel; the Shell gets
  // none. The channel stays open, so the host replaces keys there (renewed, rotated) without a restart.
  const callers = moduleCredentialCallersOf(ownerIds);
  // Recorded before any key is issued, so even a boot that fails right after issuing is named by the next one.
  const earlierBoots = yield* recordHostBoot(HOST_BOOT_RECORD, BOOT_ID);
  const owners = yield* makeCredentialHolder((channel) =>
    startUnitProcess(ownerIds, runtime, ownersEnvironment.environment, memoryBytes, channel),
  );
  const exits = [yield* startUnitProcess([SHELL_ID], runtime, shellEnvironment.environment, memoryBytes), owners.exit];
  const credentialHolders = yield* Ref.make<readonly Pick<CredentialHolder, 'handOver'>[]>([owners]);
  const replacedKeys = yield* makeReplacedKeyLedger;
  const heldCredentials = yield* Ref.make(noProvisionedCredentials(callers));
  const issueFor = (release: HostRelease) => (appIds: readonly string[]) =>
    provisionModuleCredentialsForRelease({
      appIds,
      operationId: randomUUID(),
      release,
      shellEnvironment: shellEnvironment.environment,
    });
  /** Issues this release's keys and hands them to the owners; the Outbox host gets them when it starts. */
  const provisionForRelease = (release: HostRelease) =>
    Effect.gen(function* provisionAndHandOver() {
      const provisioned = yield* issueFor(release)(callers);
      yield* Ref.set(heldCredentials, provisioned);
      const message = yield* encodeModuleCredentialHandover(
        provisioned.credentials,
        callers,
        provisioned.workloadCredentials,
      ).pipe(Effect.mapError((problem) => failure(problem.reason)));
      yield* owners.handOver(message);
      return provisioned;
    });
  /** After the grace period, retires this host's own other keys and, when it holds the authority, superseded ones. */
  const retireReplaced = (
    release: HostRelease,
    retiring: { readonly replaced: readonly string[]; readonly superseded: boolean },
  ) =>
    retireAfterHandover({
      ...retiring,
      compositionRevision: release.compositionRevision,
      // Read when the retirement runs: every key the host holds then is kept, and every key a renewal replaced less
      // than the grace period ago (that renewal retires it when its own grace ends).
      current: replacedKeys.keptWith(Ref.get(heldCredentials).pipe(Effect.map(providerKeyIdsOf))),
      earlierBoots,
      shellEnvironment: shellEnvironment.environment,
    });
  const healCredentials = (release: HostRelease, serving: Effect.Effect<boolean>) =>
    healModuleCredentials({
      // Bound and, for the keys this host holds, still verifying (enabled, not ended) in the key store.
      activeProviderKeyIds: Ref.get(heldCredentials).pipe(
        Effect.flatMap((held) => liveModuleKeyIds(database.executor, providerKeyIdsOf(held))),
      ),
      callers,
      held: heldCredentials,
      holders: Ref.get(credentialHolders),
      issue: issueFor(release),
      retireOwn: (replaced) =>
        replacedKeys.record(replaced).pipe(Effect.andThen(retireReplaced(release, { replaced, superseded: false }))),
      serving,
    });
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
    yield* waitForUnits(units);
    const snapshot = yield* observeOwners(units, publicOrigin);
    const release = hostReleaseOf(snapshot);
    yield* provisionForRelease(release);
    // An observe-only host holds no authority: it retires only its own earlier boots' keys.
    yield* retireReplaced(release, { replaced: [], superseded: false }).pipe(Effect.forkChild);
    yield* healCredentials(release, Effect.succeed(true)).pipe(Effect.forkChild);
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
        waitForUnits(units),
      ],
      { concurrency: 'unbounded' },
    );
    const releaseSnapshot = yield* observeOwners(units, publicOrigin);
    // After migrations, the role bootstrap and schema verification (all inside the migrator) and before this host
    // serves anything: the observed release's keys are issued and handed to the owners.
    const release = hostReleaseOf(releaseSnapshot);
    yield* provisionForRelease(release);
    yield* verifyReleaseAccessIntent(releaseSnapshot);
    const revision = yield* publishSnapshot(releaseSnapshot);
    // From this commit on the old release refuses every governed request and closes its public port, so this one
    // serves internal callers and reports ready to the Zerops balancer at once.
    yield* openPublicPort;
    yield* Ref.set(published, true);
    yield* closePublicPortWhenSuperseded(revision).pipe(Effect.forkChild);
    // Once in-flight delegated calls had time to finish, this host retires its own earlier boots' keys and, as it holds
    // the authority now, the credentials its release superseded. The provisioning program checks the authority row
    // itself: only while this release holds it, and only credentials bound before its revision took it.
    yield* retireReplaced(release, { replaced: [], superseded: true }).pipe(Effect.forkChild);
    // The release step writes no authorization relationship. Authorization v2 (ADR-0030) projects every tuple from
    // PostgreSQL intent through the one Core writer, so the retired `scoped_role`/`action`/`context_permission`
    // reconciliation would only fail here. Live intent is seeded by the operator-gated stage bootstrap
    // (`apps/shell-super-app/scripts/bootstrap-stage-accounts.mts`); the engine's canonical schema arrives with the
    // deployment's SpiceDB bootstrap file, and a live schema or tuple retirement is its own approved operation. The
    // release proves the projected access before it publishes (`verifyReleaseAccessIntent` above) and never mutates it.
    const held = yield* Ref.get(heldCredentials);
    const outboxHandover = yield* encodeModuleCredentialHandover(
      held.credentials,
      callers,
      held.workloadCredentials,
    ).pipe(Effect.mapError((problem) => failure(problem.reason)));
    yield* Console.log(
      `[app-host] ${OUTBOX_HOST_ID} heap limit: ${String(heapLimitMiB('outbox', memoryBytes))} MiB (container ${mebibytes(memoryBytes)} MiB)`,
    );
    const outboxHost = yield* makeCredentialHolder(
      (channel) =>
        startChild(
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
          channel,
        ),
      outboxHandover,
    );
    yield* Ref.update(credentialHolders, (holders) => [...holders, outboxHost]);
    const outbox = outboxHost.exit;
    // While this release holds the authority, keep every caller holding a live key.
    yield* healCredentials(
      release,
      readAuthority.pipe(
        Effect.map((rows) => rows[0]?.revision === revision),
        Effect.orElseSucceed(() => true),
      ),
    ).pipe(Effect.forkChild);
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
