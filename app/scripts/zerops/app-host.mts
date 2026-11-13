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
  loggableRoute,
} from './host-refusal-log.mts';
import type { HostRefusalLog } from './host-refusal-log.mts';
import {
  APP_SERVICE_HOSTNAME,
  DRAIN_FORWARDED_HEADER,
  DRAIN_FORWARD_CONNECT_TIMEOUT,
  DRAIN_REFUSED_HEADER,
  DRAIN_FORWARD_HEADERS_TIMEOUT,
  SUPERSEDED_DRAIN,
  containerBoot,
  drainSupersededHost,
  makeSupersedeDrain,
  platformDrainPeers,
  publicationAllowed,
  renewWhileHolding,
  restartMayPublish,
} from './supersede-drain.mts';
import type { DrainPeer, SupersedeDrain } from './supersede-drain.mts';
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
  MODULE_INTERNAL_WORKLOADS,
} from './module-credentials.mts';
import type { ProvisioningOutput } from './module-credentials.mts';
import { liveModuleKeyIds } from './module-credential-liveness.mts';
import {
  internalWorkloadEntryId,
  workloadEntryAppId,
} from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import { loadInternalWorkloadBindings } from '../../packages/core-runtime/src/auth/module-credentials.ts';
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
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { fromReadable, toReadable } from '@effect/platform-node/NodeStream';
import { Agent, getGlobalDispatcher } from '@effect/platform-node/Undici';
import type { Dispatcher } from '@effect/platform-node/Undici';
import { sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Order,
  Redacted,
  Queue,
  Ref,
  Result,
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
  renewApplicationCompositionAuthoritySnapshot,
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

/** The release step that registers every module's own declared internal workload, per tenant and company. */
export const RELEASE_INTERNAL_WORKLOADS_SCRIPT = 'scripts/demo/release-internal-workloads.mts';
/** The only settings that step reads; it is started with these alone, never the host's other secrets. */
export const RELEASE_INTERNAL_WORKLOADS_SETTINGS = [
  'DATABASE_URL',
  'PATH',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
] as const;

/**
 * Whether the platform's internal workload registrations differ from the workload keys the host holds: a registration
 * without a held key, or a held key whose registration ended.
 */
export const workloadKeysDiffer = (
  held: ProvisioningOutput,
  registered: readonly {
    readonly appId: string;
    readonly legalEntityId: string;
    readonly tenantId: string;
    readonly workloadKey: string;
  }[],
): boolean => {
  const wanted = new Set(registered.map((entry) => internalWorkloadEntryId(entry)));
  const holding = new Set(Object.keys(held.workloadCredentials));
  return wanted.size !== holding.size || [...wanted].some((entry) => !holding.has(entry));
};

/** Finite operator commands own private pools; only long-running hosts install a shared-pool registry. */
export const finiteProcessEnvironment = (environment: ChildEnvironment): ChildEnvironment => ({
  ...environment,
  ONTOS_DATABASE_POOL_SHARED: 'false',
});

/**
 * How long a finite child gets between SIGTERM and SIGKILL. A child that holds a Tenant's access fence finishes
 * its projection and gives the fence back in that time; only a child that is truly stuck is killed.
 */
export const FINITE_CHILD_FORCE_KILL_AFTER = Duration.minutes(2);

/** Runs one finite child to a successful exit. */
const runChild = (
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: ChildEnvironment,
  /** `false`: the child sees exactly `env` and nothing of the supervisor's own environment. */
  extendEnv = true,
) =>
  Effect.scoped(
    Effect.gen(function* runFiniteChild() {
      const handle = yield* ChildProcess.make(command, [...args], {
        cwd,
        env: finiteProcessEnvironment(env),
        extendEnv,
        forceKillAfter: FINITE_CHILD_FORCE_KILL_AFTER,
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

/**
 * The platform's internal workload registration (`release-internal-workloads.mts`), started with its own settings
 * only. It never holds or fails the boot: a failure is one loud line, and the registrations stay as they were until
 * the next run.
 */
export const registerInternalWorkloads = (release: { readonly compositionRevision: string }) =>
  Effect.gen(function* registerWorkloads() {
    const settings: Record<string, string> = {};
    for (const key of RELEASE_INTERNAL_WORKLOADS_SETTINGS) {
      const value = yield* Config.option(Config.String(key));
      if (Option.isSome(value)) {
        settings[key] = value.value;
      }
    }
    yield* runChild(
      'release-internal-workloads',
      process.execPath,
      [RELEASE_INTERNAL_WORKLOADS_SCRIPT, '--run', release.compositionRevision],
      workspaceRoot,
      settings,
    ).pipe(
      Effect.catchTag('AppHostError', ({ reason }) =>
        Console.error(
          `[app-host] INTERNAL WORKLOAD REGISTRATION FAILED (${reason}); the registrations stay as they were until the next run`,
        ),
      ),
    );
  });

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
  | { readonly kind: 'renew'; readonly reason: 'expiring' | 'registrations' | 'revoked' };

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
  /**
   * Set when the internal workload registrations changed after this boot's keys were issued (the release step after
   * publish): the next step renews every caller, so new registrations get keys and retired ones lose them.
   */
  readonly renewal: Ref.Ref<boolean>;
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
  const plan: ModuleCredentialHealing = (yield* Ref.getAndSet(input.renewal, false))
    ? { kind: 'renew', reason: 'registrations' }
    : planModuleCredentialHealing(held, active, yield* Clock.currentTimeMillis);
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
      : Console.log(
          plan.reason === 'registrations'
            ? '[app-host] internal workload registrations changed; issuing and handing over keys for them'
            : '[app-host] module credentials near their end; rotating them',
        );
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

/** The release step that installs the modules each stage Tenant is approved to have and still lacks. */
export const RELEASE_MODULES_SCRIPT = 'scripts/demo/release-tenant-modules.mts';
/**
 * The container settings the release step reads, by name; it is started with these and the host-derived composition
 * URL only, so the supervisor's own secrets (the admin database URL, the owner secrets bundle, database passwords)
 * never reach it.
 */
export const RELEASE_MODULES_SETTINGS = [
  'DATABASE_URL',
  'PATH',
  'SPICEDB_CA_CERT',
  'SPICEDB_ENDPOINT',
  'SPICEDB_PRESHARED_KEY',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
] as const;

/** The release step's whole environment: the named settings that are set, and the active composition's URL. */
export const releaseModulesEnvironment = (
  settings: ReadonlyMap<string, string>,
  derived: ChildEnvironment,
): ChildEnvironment => ({
  ...Object.fromEntries(
    RELEASE_MODULES_SETTINGS.flatMap((key) =>
      Option.toArray(Option.fromUndefinedOr(settings.get(key))).map((value) => [key, value]),
    ),
  ),
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: derived.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL,
});

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

/**
 * Request headers this host answers itself and never passes on: the drain marker, and `Expect`, whose 100-continue
 * this host's server already answered to the client (undici rejects any `expect` header, so passing it on turned every
 * such upload, curl's default above 1 MiB, into a 502, and into a 503 during a drain).
 */
const HOST_ANSWERED: ReadonlySet<string> = new Set([DRAIN_FORWARDED_HEADER, 'expect']);

const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Response headers only a host sets: a unit's answer never carries them on, or a draining host relaying through this
 * one would read a unit's `x-ontos-drain-refused` as this host refusing, and drop a serving peer.
 */
const HOST_SIGNALS: ReadonlySet<string> = new Set([DRAIN_FORWARDED_HEADER, DRAIN_REFUSED_HEADER]);

/** The headers a `Connection` header names are hop-by-hop too (RFC 9110, 7.6.1). */
type HeaderValue = string | readonly string[] | undefined;
const connectionNamed = (connection: HeaderValue): ReadonlySet<string> =>
  new Set(
    [connection ?? []]
      .flat()
      .flatMap((value) => value.split(','))
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );

/**
 * Response headers that never leave the public port: `server-timing` carries per-request authorization and storage
 * timings (a module owner's gate, SpiceDB and SQL phases and counts, the Shell's gateway phases), a side channel no
 * outside client needs. The numbers stay in the processes' own logs.
 */
const PRIVATE_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['server-timing']);

/**
 * Build output whose file name carries its content hash (`s.a5d64c6353.js`): a new build names a new file, so the
 * bytes behind one name never change. The units send these with no caching header at all, and a browser then fetched
 * every one of them again on each page (2026-11-13 on stage: about 100 files, 2.5 MB, none from cache).
 * Only the bundler's own folders count. `/static/` alone is not enough: the Shell does not redirect that prefix, so
 * `/static/resources/a/b/c.abcdef1234.js` reaches a signed-in page route with `static` as its language, and a
 * person's page must never be kept. Files named the same in every build (`remoteEntry.js`, `mf-manifest.json`) do
 * not match either.
 */
const BUILD_OUTPUT = /^(?:\/_m\/[^/]+)?\/static\/(?:assets|css|font|image|js|media|svg|wasm)\//u;
const CONTENT_HASH_IN_NAME = /\.[0-9a-f]{8,}\.[a-z0-9]+$/u;
const isContentHashedAsset = (url: string): boolean => {
  const pathname = url.split('?', 1)[0] ?? '';
  return BUILD_OUTPUT.test(pathname) && CONTENT_HASH_IN_NAME.test(pathname.slice(pathname.lastIndexOf('/') + 1));
};
/** A page is never a build file, whatever its address: an answer without a type, or typed as HTML, is not kept. */
const isPage = (contentType: HeaderValue): boolean => {
  const types = [contentType ?? []].flat();
  return types.length === 0 || types.some((type) => type.trim().toLowerCase().startsWith('text/html'));
};
const KEEP_FOR_GOOD = 'public, max-age=31536000, immutable';

/**
 * The owner's end-to-end headers. A caller retries an unavailable (503) answer: make it reconnect, so the retry
 * can reach another container instead of reusing a kept-alive socket to this one. A superseded release keeps
 * refusing governed requests until Zerops stops it. Private headers stay inside. A found (200) content-hashed build
 * file the unit sent without caching may be kept by the browser; a missing one answers 404 and is never kept, and
 * neither is any page. The page and type checks read the headers after the filtering above, and `url` is the original
 * request target (with its `/_m/<module>` prefix), never the path the unit was asked for.
 */
export const relayResponseHeaders = (
  statusCode: number,
  upstream: Readonly<Record<string, string | readonly string[] | undefined>>,
  url?: string,
) => {
  const headers: Record<string, string | readonly string[]> = {};
  const named = connectionNamed(upstream.connection);
  for (const [name, value] of Object.entries(upstream)) {
    if (
      value !== undefined &&
      !HOP_BY_HOP.has(name) &&
      !named.has(name) &&
      !HOST_SIGNALS.has(name) &&
      !PRIVATE_RESPONSE_HEADERS.has(name)
    ) {
      headers[name] = value;
    }
  }
  if (statusCode === 503) {
    headers.connection = 'close';
  }
  if (
    statusCode === 200 &&
    url !== undefined &&
    headers['cache-control'] === undefined &&
    !isPage(headers['content-type']) &&
    isContentHashedAsset(url)
  ) {
    headers['cache-control'] = KEEP_FOR_GOOD;
  }
  return headers;
};

/** Where one relayed request goes: a loopback unit, or (while this host drains) a peer app container. */
interface RelayTarget {
  readonly dispatcher?: Agent;
  /** A peer app container: its refusal as a draining host is a failure, so the relaying host tries the next one. */
  readonly drainPeer?: boolean;
  /** Headers the target receives in addition to the request's own end-to-end headers. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly headersTimeout: Duration.Duration;
  readonly origin: string;
  readonly path: string;
}

/**
 * When a relayed response must stop before its unit ends it. `end` completes it cleanly (an event stream: its client
 * reconnects); `cut` fails it, so the connection drops instead of a truncated body passing as complete.
 */
interface RelayCutoff {
  readonly cut?: Effect.Effect<unknown>;
  readonly end?: Effect.Effect<unknown>;
}

const isEventStream = (headers: Readonly<Record<string, string | readonly string[] | undefined>>) =>
  String(headers['content-type'] ?? '').startsWith('text/event-stream');

/**
 * Relays one request byte-for-byte; its body streams (never buffered), its compressed response and every end-to-end
 * header pass unchanged. Hop-by-hop headers and the drain marker never pass: a client cannot hand a unit or a peer
 * the marker, and an upgrade request reaches the target as a plain request, which it answers.
 */
const relay = Effect.fn('AppHost.relay')(function* relay(
  request: HttpServerRequest.HttpServerRequest,
  target: RelayTarget,
  reportCut: (problem: RelayFailure) => Effect.Effect<void>,
  cutoffOf: (eventStream: boolean) => RelayCutoff,
  stopping: Effect.Effect<unknown>,
) {
  const headers: Record<string, string> = {};
  const named = connectionNamed(request.headers.connection);
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(name) && !named.has(name) && !HOST_ANSWERED.has(name)) {
      headers[name] = value;
    }
  }
  headers['x-forwarded-host'] ??= request.headers.host ?? '';
  headers['x-forwarded-proto'] ??= 'https';
  Object.assign(headers, target.extraHeaders);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody
    ? yield* toReadable(request.stream.pipe(Stream.mapError(() => failure('relay request body'))))
    : null;
  const response = yield* Effect.tryPromise({
    catch: (cause) => new RelayFailure({ code: relayFailureCode(decodeRelayCause(cause)), stage: 'request' }),
    // The dispatcher takes the path as it is: no URL parsing, so `//`, `\\`, dot segments and encodings reach the
    // target exactly as the client sent them.
    try: (signal): PromiseLike<Dispatcher.ResponseData> =>
      (target.dispatcher ?? getGlobalDispatcher()).request({
        body,
        bodyTimeout: 0,
        headers,
        headersTimeout: Duration.toMillis(target.headersTimeout),
        method: request.method,
        origin: target.origin,
        path: target.path,
        signal,
      }),
  }).pipe(
    // A host that stops does not wait for an answer still to come (an upload in flight): it answers 503 at once.
    Effect.raceFirst(
      stopping.pipe(Effect.andThen(Effect.fail(new RelayFailure({ code: 'HOST_STOPPING', stage: 'request' })))),
    ),
  );
  if (target.drainPeer === true && response.headers[DRAIN_REFUSED_HEADER] !== undefined) {
    response.body.resume();
    return yield* new RelayFailure({ code: 'PEER_DRAINING', stage: 'request' });
  }
  const responseHeaders = relayResponseHeaders(response.statusCode, response.headers, request.url);
  const noBody = request.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
  if (noBody) {
    response.body.resume();
    return HttpServerResponse.empty({ headers: responseHeaders, status: response.statusCode });
  }
  const cutoff = cutoffOf(isEventStream(response.headers));
  const cutProblem = new RelayFailure({ code: 'DRAIN_ENDED', stage: 'response body' });
  // The status and headers are sent by then: a unit that fails its body cuts the response, and that is logged.
  let body$ = fromReadable<Uint8Array, RelayFailure>({
    evaluate: () => response.body,
    onError: (cause) => new RelayFailure({ code: relayFailureCode(decodeRelayCause(cause)), stage: 'response body' }),
  });
  if (cutoff.end !== undefined) {
    body$ = body$.pipe(Stream.interruptWhen(cutoff.end));
  }
  if (cutoff.cut !== undefined) {
    body$ = body$.pipe(Stream.interruptWhen(cutoff.cut.pipe(Effect.andThen(Effect.fail(cutProblem)))));
  }
  return HttpServerResponse.stream(body$.pipe(Stream.tapError(reportCut)), {
    headers: responseHeaders,
    status: response.statusCode,
  });
});

const isLoopbackPeer = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(request.remoteAddress, isLoopbackHostname);

/** Fields of a refusal the host answered itself: the method and the route shape, never the path, query or body. */
const refusedRequest = (request: HttpServerRequest.HttpServerRequest, status: number) => ({
  method: request.method,
  route: loggableRoute(request.url),
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

/**
 * The one way the public port closes (drain end, stop signal, any end of the host): first `stopping`, so relayed
 * event streams end, other relayed responses are cut and relays awaiting an answer answer 503, then the server's
 * graceful close, which then has nothing left to wait for. Runs once, whoever asks first.
 */
/**
 * Stops accepting connections on the public port, nothing more: Node closes the idle kept-alive ones, and every
 * request already on its way finishes (the drain's end; its relays keep their answers).
 */
export const stopAccepting = (server: Server) =>
  Effect.sync(() => {
    if (server.listening) {
      server.close();
    }
  });

/**
 * Bounds of the public port's stop. The platform's stop timeout is not documented in this repository; it is assumed
 * to be 30 s, so the port closes well inside it and leaves the units their time. After `stopping`, connections that are
 * kept alive or hold a half-sent request get a 2 s grace, then are closed; the server's graceful close is capped at
 * 10 s whatever happens.
 */
export const PUBLIC_PORT_FORCE_CLOSE_AFTER = Duration.seconds(2);
export const PUBLIC_PORT_GRACEFUL_CLOSE_CAP = Duration.seconds(10);

export const publicPortClosing = (publicScope: Scope.Closeable, drain: SupersedeDrain, server: Server) =>
  Effect.cached(
    Effect.gen(function* closePublicPort() {
      yield* Deferred.succeed(drain.stopping, true);
      yield* Effect.sync(() => {
        server.closeIdleConnections();
      });
      const force = yield* Effect.forkChild(
        Effect.sleep(PUBLIC_PORT_FORCE_CLOSE_AFTER).pipe(
          Effect.andThen(
            Effect.sync(() => {
              server.closeAllConnections();
            }),
          ),
        ),
      );
      yield* Scope.close(publicScope, Exit.void);
      // Never cancelled: once the drain's deadline closed the listener, the server's shutdown returns at once, and a
      // connection holding a half-sent request would otherwise keep the process alive until the platform kills it.
      yield* Fiber.join(force);
    }),
  );

/**
 * The answer when a request may already have reached its target (its peer or unit could have acted on it): 502, or
 * 504 when no answer came in time, and never `Retry-After`, so a caller without an idempotency key does not write
 * twice.
 */
const mayHaveReachedTarget = (code: string) =>
  HttpServerResponse.text(code === 'UND_ERR_HEADERS_TIMEOUT' ? 'Gateway timeout\n' : 'Upstream unavailable\n', {
    headers: { 'cache-control': 'no-store', connection: 'close' },
    status: code === 'UND_ERR_HEADERS_TIMEOUT' ? 504 : 502,
  });

/** 503 when nothing reached the target; 504 when it may have but did not answer in time; 502 otherwise. */
const failureStatus = (code: string, reached: boolean) => {
  if (!reached) {
    return 503;
  }
  return code === 'UND_ERR_HEADERS_TIMEOUT' ? 504 : 502;
};

/** The answer a caller already retries: 503 on a fresh connection (which can reach another container). */
const retryableUnavailable = () =>
  HttpServerResponse.text('Service temporarily unavailable\n', {
    headers: { 'cache-control': 'no-store', connection: 'close', 'retry-after': '1' },
    status: 503,
  });

const ABSOLUTE_FORM = /^[A-Za-z][\w+.-]*:\/\/[^/?#]*/u;
const SINGLE_SLASH_PATH = /^\/(?!\/)/u;

/**
 * The request target relayed, byte for byte: an origin-form target starting with exactly one `/` as received; of an
 * absolute-form target only its path and query, as received (its scheme, host and any user:pass@ choose nothing).
 * Anything else (`*`, `//x`, an authority-form target) is not relayed.
 */
export const relayedTarget = (url: string): Option.Option<string> => {
  if (SINGLE_SLASH_PATH.test(url)) {
    return Option.some(url);
  }
  const authority = ABSOLUTE_FORM.exec(url);
  if (authority === null) {
    return Option.none();
  }
  const rest = url.slice(authority[0].length);
  if (rest === '' || rest.startsWith('?')) {
    return Option.some(`/${rest}`);
  }
  return SINGLE_SLASH_PATH.test(rest) ? Option.some(rest) : Option.none();
};

const hostLiteral = (address: string) => (address.includes(':') ? `[${address}]` : address);
const peerOrigin = ({ address, port }: DrainPeer) => `http://${hostLiteral(address)}:${String(port)}`;

/** Failures before a single request byte left: the next peer may take the request, its body included. */
const CONNECT_FAILURES: ReadonlySet<string> = new Set([
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * While this host drains, it serves nothing itself: every public request goes to a peer app container of the same
 * service, unchanged but for the drain marker, so every cookie, token and gateway check runs there exactly as for a
 * direct request. A request that already carries the marker came from another draining host (two deploys in a row):
 * it is refused, marked so that host drops this one. Peers are tried in turn; a peer that refuses as draining or
 * refuses the connection is dropped for the rest of the drain. A request with a body moves to the next peer only
 * when the connection was refused (nothing sent yet), never after its bytes may have been sent. When every known
 * peer failed, the peers are resolved again (at most once per second). Every failure answers the retryable 503.
 */
const forwardDuringDrain = Effect.fn('AppHost.forwardDuringDrain')(function* forwardDuringDrain(
  request: HttpServerRequest.HttpServerRequest,
  relayed: string,
  drain: SupersedeDrain,
  refusals: HostRefusalLog,
  dispatcher: Agent,
) {
  const started = yield* Clock.currentTimeMillis;
  /** Nothing reached a peer (refused connections, a draining peer's refusal): the caller may retry elsewhere. */
  const refuse = (cause: string, peer: string, reached = false) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        refusals.record({
          fields: {
            cause,
            elapsedMs: now - started,
            method: request.method,
            peer,
            route: loggableRoute(request.url),
            status: failureStatus(cause, reached),
          },
          key: 'drain-forward',
          what: 'drain relay failed',
        }),
      ),
      Effect.as(reached ? mayHaveReachedTarget(cause) : retryableUnavailable()),
    );
  if (request.headers[DRAIN_FORWARDED_HEADER] !== undefined) {
    yield* drain.count('looped');
    return yield* refuse('ALREADY_RELAYED', 'none').pipe(
      Effect.map(HttpServerResponse.setHeader(DRAIN_REFUSED_HEADER, 'draining')),
    );
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let last = new RelayFailure({ code: 'NO_PEER', stage: 'request' });
  let lastPeer = 'none';
  for (const round of [1, 2]) {
    const peers = round === 1 ? yield* drain.livePeers : yield* drain.refresh;
    for (const peer of peers) {
      const target = peerOrigin(peer);
      const answer = yield* relay(
        request,
        {
          dispatcher,
          drainPeer: true,
          extraHeaders: { [DRAIN_FORWARDED_HEADER]: '1' },
          headersTimeout: DRAIN_FORWARD_HEADERS_TIMEOUT,
          origin: target,
          path: relayed,
        },
        (problem) => refuse(problem.code, target, true).pipe(Effect.asVoid),
        // At the drain's end event streams end (their clients reconnect elsewhere); any other relayed answer finishes,
        // and only the host's stop cuts it.
        (eventStream) =>
          eventStream
            ? { end: Effect.raceFirst(Deferred.await(drain.ended), Deferred.await(drain.stopping)) }
            : { cut: Deferred.await(drain.stopping) },
        Deferred.await(drain.stopping),
      ).pipe(Effect.result);
      if (Result.isSuccess(answer)) {
        yield* drain.count('forwarded');
        return answer.success;
      }
      last = answer.failure;
      lastPeer = target;
      const refusedConnection = CONNECT_FAILURES.has(last.code);
      if (refusedConnection || last.code === 'PEER_DRAINING') {
        yield* drain.drop(peer, refusedConnection ? 'refused' : 'draining');
      }
      if (!refusedConnection && last.code !== 'PEER_DRAINING') {
        // The request may have reached this peer: it is never sent to another one, and the caller is not told to retry.
        yield* drain.count('failed');
        return yield* refuse(last.code, lastPeer, true);
      }
      if (hasBody && !refusedConnection) {
        yield* drain.count('failed');
        return yield* refuse(last.code, lastPeer);
      }
    }
  }
  yield* drain.count('failed');
  return yield* refuse(last.code, lastPeer);
});

export const hostApplication = <Failure, Requirements>(
  ports: ReadonlyMap<string, number>,
  published: Ref.Ref<boolean>,
  loadComposition: Effect.Effect<Option.Option<string>, Failure, Requirements>,
  refusals: HostRefusalLog = makeHostRefusalLog(),
  drain: SupersedeDrain = makeSupersedeDrain(),
) => {
  const forwardDispatcher = new Agent({
    bodyTimeout: 0,
    connect: { timeout: Duration.toMillis(DRAIN_FORWARD_CONNECT_TIMEOUT) },
    headersTimeout: Duration.toMillis(DRAIN_FORWARD_HEADERS_TIMEOUT),
  });
  return Effect.gen(function* routeHostRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const relayed = relayedTarget(request.url);
    if (Option.isNone(relayed)) {
      yield* refusals.tally('invalidTarget');
      return HttpServerResponse.empty({ status: 400 });
    }
    if (yield* drain.active) {
      return yield* forwardDuringDrain(request, relayed.value, drain, refusals, forwardDispatcher);
    }
    const location = credentialSubmissionRedirect(new URL(request.url, 'https://host.invalid'), request.method);
    if (location !== undefined) {
      return HttpServerResponse.empty({
        headers: { 'cache-control': 'no-store', location, 'referrer-policy': 'no-referrer' },
        status: 303,
      });
    }
    if (new URL(request.url, 'https://host.invalid').pathname === STAGE_CIMD_FIXTURE_PATH) {
      const fixture = yield* stageCimdFixtureResponse;
      // It exists only on stage under the stage origin; any client can ask it wrongly, so refusals are counted.
      if (fixture.status >= 400) {
        yield* refusals.tally('stageClientMetadata');
      }
      return fixture;
    }
    const control = yield* hostControlResponse(request, published, loadComposition, refusals);
    if (Option.isSome(control)) {
      return control.value;
    }
    const route = routeRequest(relayed.value, ports);
    const unit = routedUnit(relayed.value);
    if (Option.isNone(route)) {
      // Any client can ask for a module path no unit serves: counted, never a line of its own.
      yield* refusals.tally('unroutedModulePath');
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
              route: loggableRoute(request.url),
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
    return yield* relay(
      request,
      { headersTimeout: RELAY_HEADERS_TIMEOUT, origin: loopbackOrigin(port), path: upstreamPath },
      (problem) => report(problem, 'cut'),
      // An event stream of this release ends once a newer one took over, so its browser reconnects to the new one.
      // An event stream of this release ends once a newer one took over or the host stops, so its browser reconnects;
      // every other response is cut when the host stops.
      (eventStream) =>
        eventStream
          ? { end: Effect.raceFirst(Deferred.await(drain.superseded), Deferred.await(drain.stopping)) }
          : { cut: Deferred.await(drain.stopping) },
      Deferred.await(drain.stopping),
    ).pipe(
      Effect.catchTag('RelayFailure', (problem) =>
        problem.code === 'HOST_STOPPING' || !CONNECT_FAILURES.has(problem.code)
          ? report(problem, problem.code === 'UND_ERR_HEADERS_TIMEOUT' ? 504 : 502).pipe(
              Effect.as(mayHaveReachedTarget(problem.code)),
            )
          : report(problem, 502).pipe(Effect.as(HttpServerResponse.text('Upstream unavailable\n', { status: 502 }))),
      ),
    );
  }).pipe(
    // Once the listener stopped (the drain's end) or the host stops, every answer closes its connection, so the client's
    // next request opens a new one, on a container that still serves.
    Effect.map((response) =>
      Deferred.isDoneUnsafe(drain.ended) || Deferred.isDoneUnsafe(drain.stopping)
        ? HttpServerResponse.setHeader(response, 'connection', 'close')
        : response,
    ),
  );
};

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
  // First thing: a restart inside this container must know when the container first booted (restartMayPublish).
  const boot = yield* Config.String('ONTOS_APP_HOST_BOOT_MARKER').pipe(
    Config.option,
    Effect.flatMap((marker) => Effect.transposeOption(marker.pipe(Option.map(containerBoot)))),
  );
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
    readonly activatedAtMillis: number;
    readonly phase: string;
    readonly revision: string;
    readonly validUntilMillis: number;
  }>(
    sql`select phase, revision, (extract(epoch from valid_until) * 1000)::double precision as "validUntilMillis", (extract(epoch from revision_activated_at) * 1000)::double precision as "activatedAtMillis" from core.application_composition_authority where authority_key = 'active'`,
    'objects',
  );
  const pointer = yield* makeCompositionPointer(readAuthority);

  // The provided server is the loopback control port. The public port opens below, once this host can serve, and
  // closes when a newer release takes the authority: from then on this host refuses every governed request.
  // One refusal log for the control and the public port; it writes the counts it held back every 10 seconds.
  const refusals = makeHostRefusalLog();
  // Superseded, this host keeps its public port open as a relay to the new release (supersede-drain.mts).
  const drain = makeSupersedeDrain();
  yield* refusals.flush.pipe(Effect.repeat(Schedule.spaced(HOST_REFUSAL_LOG_WINDOW)), Effect.forkScoped);
  yield* HttpServer.serveEffect(hostControlApplication(published, pointer.load, refusals));
  const publicScope = yield* Scope.make();
  // Closing waits for in-flight requests (the server's graceful shutdown) and happens once, whoever asks first.
  // The public server is made here so the host can stop its listener alone (the drain's end) or close it whole (stop).
  const publicServer = withKeepAlive(createServer)();
  const closePublicPort = yield* publicPortClosing(publicScope, drain, publicServer);
  yield* Effect.addFinalizer(() => closePublicPort);
  const openPublicPort = NodeHttpServer.make(() => publicServer, {
    gracefulShutdownTimeout: PUBLIC_PORT_GRACEFUL_CLOSE_CAP,
    host: '0.0.0.0',
    port: publicPort,
  }).pipe(
    Effect.mapError(() => failure(`public port ${String(publicPort)} could not be opened`)),
    Effect.flatMap((server) => server.serve(hostApplication(ports, published, pointer.load, refusals, drain))),
    Scope.provide(publicScope),
    Effect.andThen(Console.log(`[app-host] accepting application traffic on port ${String(publicPort)}`)),
  );
  const drainWhenSuperseded = (ownRevision: string) =>
    awaitSupersedingRevision(
      ownRevision,
      readAuthority.pipe(Effect.map((rows) => Option.map(EffectArray.head(rows), ({ revision }) => revision))),
    ).pipe(
      Effect.flatMap((revision) =>
        drainSupersededHost({
          drain,
          duration: SUPERSEDED_DRAIN,
          peers: platformDrainPeers(APP_SERVICE_HOSTNAME, publicPort),
          publicPort,
          revision,
          stopAccepting: stopAccepting(publicServer),
        }),
      ),
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
  // Registered after the units started, so it runs before they are stopped: on a stop signal (or any end) the
  // public port first ends this release's event streams, lets in-flight requests finish and closes; then the
  // units stop.
  yield* Effect.addFinalizer(() =>
    Console.log(
      '[app-host] stopping: ending relayed event streams and uploads in flight, then closing the public port',
    ).pipe(
      Effect.andThen(closePublicPort),
      Effect.andThen(Console.log('[app-host] public port closed; stopping the units')),
    ),
  );
  const credentialHolders = yield* Ref.make<readonly Pick<CredentialHolder, 'handOver'>[]>([owners]);
  const replacedKeys = yield* makeReplacedKeyLedger;
  const heldCredentials = yield* Ref.make(noProvisionedCredentials(callers));
  const renewal = yield* Ref.make(false);
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
  /** After a run that may have changed registrations: renew the callers' keys when they no longer match. */
  const renewWhenRegistrationsChanged = Effect.gen(function* compareRegistrations() {
    const workloads = [...new Set([...MODULE_INTERNAL_WORKLOADS.values()].flat())];
    const registered = yield* loadInternalWorkloadBindings(database.executor, workloads).pipe(Effect.option);
    if (Option.isNone(registered)) {
      return yield* Console.error(
        '[app-host] internal workload registrations could not be read; keys renew on schedule',
      );
    }
    const appOf = new Map(
      [...MODULE_INTERNAL_WORKLOADS].flatMap(([appId, keys]) => keys.map((key) => [key, appId] as const)),
    );
    const entries = registered.value.flatMap((binding) => {
      const appId = appOf.get(binding.workloadKey);
      return appId === undefined || !callers.includes(appId) ? [] : [{ ...binding, appId }];
    });
    return workloadKeysDiffer(yield* Ref.get(heldCredentials), entries)
      ? yield* Ref.set(renewal, true)
      : yield* Effect.void;
  });
  const healCredentials = (release: HostRelease, serving: Effect.Effect<boolean>) =>
    healModuleCredentials({
      renewal,
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

  // The revision this host published, once it did; a superseded host never writes the authority row again.
  const ownRevision = yield* Ref.make(Option.none<string>());
  const activeRevision = readAuthority.pipe(
    Effect.map((rows) => Option.map(EffectArray.head(rows), ({ revision }) => revision)),
  );
  const publishSnapshot = (snapshot: ActiveApplicationCompositionSnapshot) =>
    Effect.gen(function* publishObservedComposition() {
      const allowed = yield* publicationAllowed({
        activeRevision,
        ownRevision: yield* Ref.get(ownRevision),
        superseded: drain.superseded,
      });
      if (!allowed) {
        return yield* failure('this host was superseded and never writes the authority again');
      }
      yield* publishApplicationCompositionAuthoritySnapshot(snapshot, pointer.publish(snapshot), Effect.void);
      yield* Ref.set(ownRevision, Option.some(snapshot.composition.revision));
      yield* Console.log(
        `[app-host] composition ${snapshot.composition.revision} (${String(snapshot.composition.modules.length)} owners) valid until ${DateTime.formatIso(snapshot.validUntil)}`,
      );
      return snapshot.composition.revision;
    }).pipe(observeRuntimeJob('composition-publish'));
  // The renewal only ever renews: under the publication lock it refuses when the row names another release.
  const renewHeld = observeOwners(units, publicOrigin).pipe(
    Effect.flatMap((snapshot) =>
      Effect.gen(function* renewObservedComposition() {
        const allowed = yield* publicationAllowed({
          activeRevision,
          ownRevision: yield* Ref.get(ownRevision),
          superseded: drain.superseded,
        });
        if (!allowed) {
          return yield* failure('this host was superseded and never writes the authority again');
        }
        yield* renewApplicationCompositionAuthoritySnapshot(snapshot, pointer.publish(snapshot));
        return yield* Console.log(
          `[app-host] composition ${snapshot.composition.revision} renewed, valid until ${DateTime.formatIso(snapshot.validUntil)}`,
        );
      }),
    ),
    observeRuntimeJob('composition-renewal'),
  );
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
    // A process restarted inside a container that a newer release superseded never publishes its old release again.
    const holder = Option.map(EffectArray.head(yield* readAuthority), ({ activatedAtMillis, revision }) => ({
      activatedAtMillis,
      revision,
    }));
    if (!restartMayPublish({ boot, holder, ownRevision: releaseSnapshot.composition.revision })) {
      yield* Console.error(
        `[app-host] WARN restarted in a superseded container: composition ${Option.match(holder, { onNone: () => 'none', onSome: ({ revision }) => revision })} took the authority after this container first booted; composition ${releaseSnapshot.composition.revision} is not published and the public port stays closed`,
      );
      return yield* Effect.never;
    }
    // After migrations, the role bootstrap and schema verification (all inside the migrator) and before this host
    // serves anything: the observed release's keys are issued and handed to the owners.
    const release = hostReleaseOf(releaseSnapshot);
    // Keys can only be issued for registrations that exist: the platform registers every module's declared internal
    // workloads first (per tenant and company), so the boot's provisioning keys them in the same pass.
    yield* registerInternalWorkloads(release);
    yield* provisionForRelease(release);
    yield* verifyReleaseAccessIntent(releaseSnapshot);
    const revision = yield* publishSnapshot(releaseSnapshot);
    // From this commit on Core refuses the old release's governed requests, and the old host relays its public
    // traffic here until the balancer moved (supersede-drain.mts); this one serves at once and reports ready.
    yield* openPublicPort;
    yield* Ref.set(published, true);
    yield* drainWhenSuperseded(revision).pipe(Effect.forkChild);
    // Once in-flight delegated calls had time to finish, this host retires its own earlier boots' keys and, as it holds
    // the authority now, the credentials its release superseded. The provisioning program checks the authority row
    // itself: only while this release holds it, and only credentials bound before its revision took it.
    yield* retireReplaced(release, { replaced: [], superseded: true }).pipe(Effect.forkChild);
    // Platform module installation (`release-tenant-modules.mts`): against the composition just published, every
    // stage Tenant gets the approved modules it still lacks, written as `system` and projected into SpiceDB by the
    // step itself, so routine module installs need neither a person nor a host shell. It is additive only, keeps its
    // own time limit (it is never killed for time while it holds a Tenant's fence), runs beside the Outbox host and
    // never holds or fails the boot: a failure is one loud line.
    const releaseSettings = new Map<string, string>();
    for (const key of RELEASE_MODULES_SETTINGS) {
      const value = yield* Config.option(Config.String(key));
      if (Option.isSome(value)) {
        releaseSettings.set(key, value.value);
      }
    }
    const installReleaseModules = runChild(
      'release-modules',
      node,
      [RELEASE_MODULES_SCRIPT],
      workspaceRoot,
      releaseModulesEnvironment(releaseSettings, derived),
      false,
    ).pipe(
      Effect.catchTag('AppHostError', ({ reason }) =>
        Console.error(
          `[app-host] RELEASE MODULE INSTALLATION FAILED (${reason}); the modules stay as they were until the next release`,
        ),
      ),
    );
    // One fiber, in this order: module installation, then internal workload registration (which follows the release
    // just published and the modules it installed), then key renewal when the registrations now differ from the keys
    // held. A module this release installed has its workloads registered and keyed in the same boot; a module
    // installed later at runtime gets its registrations at the next deploy (ADR-0028). Neither step holds the boot.
    yield* installReleaseModules.pipe(
      Effect.andThen(registerInternalWorkloads(release)),
      Effect.andThen(renewWhenRegistrationsChanged),
      Effect.forkChild,
    );
    // No relationship is written by hand here. Authorization v2 (ADR-0030) projects every tuple from PostgreSQL
    // intent through the one Core writer, so the retired `scoped_role`/`action`/`context_permission` reconciliation
    // would only fail here. Two release steps change intent and then project it through that writer: the migrator's
    // access catalog activation, and the release module step above, which reconciles each Tenant it installed a module
    // in; the internal workload registration writes Core intent only (no relationship). Everything else in a live
    // Tenant is seeded by the operator-gated stage bootstrap
    // (`apps/shell-super-app/scripts/bootstrap-stage-accounts.mts`). The engine's canonical schema arrives with the
    // deployment's SpiceDB bootstrap file, and a live schema or tuple retirement is its own approved operation. The
    // release proves the projected access before it publishes (`verifyReleaseAccessIntent` above).
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
    // The host renews its own lease well inside the validity window while it holds the authority; no external refresh
    // schedule exists. Superseded, it stops for good.
    const renew = renewWhileHolding({
      interval: ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval,
      renew: renewHeld.pipe(
        Effect.tapError((problem) => Console.error(`[app-host] composition renewal failed: ${String(problem)}`)),
        Effect.ignore,
      ),
      superseded: drain.superseded,
    });
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

/**
 * Ends when the platform stops this container (SIGTERM; SIGINT locally). Zerops stops the old container this way
 * once traffic moved; racing it interrupts the host, so its finalizers run in order: the public port ends event
 * streams, finishes in-flight requests and closes, then the units stop.
 */
export const stopSignal = Effect.callback<string>((resume) => {
  const stop = (signal: string) => resume(Effect.succeed(signal));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return Effect.sync(() => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  });
}).pipe(Effect.flatMap((signal) => Console.log(`[app-host] ${signal} received; stopping gracefully`)));

if (import.meta.main) {
  const program = runAppHost.pipe(
    Effect.scoped,
    Effect.raceFirst(stopSignal),
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
