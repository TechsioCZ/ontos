#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as Arr,
  Config,
  ConfigProvider,
  Console,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Redacted,
  Schedule,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import { serviceIdVariable } from '../publish-active-application-composition.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import {
  CloudflareApi,
  CloudflareApiLive,
  CloudflareCredentials,
  VPC_CERT_VERIFICATION_MODE,
} from './cloudflare-api.mts';
import type { CloudflareHyperdrive, CloudflareVpcService, VpcServiceSpec } from './cloudflare-api.mts';
import { costGuardChecks, ensureCostGuards, setKillSwitch } from './cloudflare-stage-cost-guard.mts';
import type { CostGuardPlan } from './cloudflare-stage-cost-guard.mts';
import { OpsShellLive, runCommand } from './ops-shell.mts';
import type { SecretValues } from './ops-shell.mts';
import { ensureSpicedbTls, spicedbTlsState } from './spicedb-tls.mts';
import {
  BuildEnvironmentSchema,
  COMPOSITION_KV_ID_VARIABLE,
  HYPERDRIVE_ID_VARIABLE,
  MF_DEV_ORIGIN_VARIABLE,
  PLACEMENT_LABEL,
  PLACEMENT_PATH,
  PlacementSchema,
  readEdgeUnits,
  SPICEDB_VPC_SERVICE_ID_VARIABLE,
} from './stage-edge-units.mts';
import type { BuildEnvironment, EdgeUnit } from './stage-edge-units.mts';
import { StageOperationError } from './stage-operation-error.mts';
import {
  DEPLOY_TARGET_VARIABLE,
  ONTOS_REPOSITORY,
  OUTBOX_WORKER_MODE_VARIABLE,
  OpsMode,
  STAGE_EDGE_ENVIRONMENT,
  STAGE_ENVIRONMENT,
  STAGE_ZEROPS_PROJECT_ID,
  appDirectory,
  appFile,
  decodeInput,
  githubApi,
  importEntry,
  importZeropsServices,
  listGithubVariables,
  listZeropsServices,
  mutate,
  perform,
  readAppText,
  readZeropsImport,
  readZeropsValue,
  repositoryDirectory,
  setGithubSecret,
  setGithubVariable,
} from './stage-operations.mts';
import type { ServiceImport, ZeropsService } from './stage-operations.mts';

/**
 * Idempotent Cloudflare stage cut-over (design runbook section 13.3). Every step first reads the
 * current state and creates only what is missing, so a re-run after a partial failure converges.
 * `--dry-run` performs the reads and reports each mutation instead of running it.
 *
 * Settings come from the environment, else from the dotenv file `--env-file` names (default
 * `~/.cloudflare-ontos-stage-token`): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, STAGE_ZONE,
 * STAGE_SHELL_HOSTNAME, STAGE_ACCESS_EMAILS (comma-separated people Access admits and the usage
 * notification emails) and, optionally, CLOUDFLARE_STAGE_EDGE_API_TOKEN (the narrower CI token;
 * without it CI receives CLOUDFLARE_API_TOKEN) and STAGE_ACCESS_ENFORCE_SHELL (default false),
 * plus ZEROPS_TOKEN for the SpiceDB TLS secrets. Secret values are read from Zerops with the
 * locally authenticated `zcli` and never printed.
 */
export const STAGE_TUNNEL_NAME = 'ontos-stage';
export const STAGE_HYPERDRIVE_NAME = 'ontos-stage-runtime';
/** The KV namespace every placed Worker reads the active Application Composition from. */
export const STAGE_COMPOSITION_KV_NAME = 'ontos-stage-active-application-composition';
export const HYPERDRIVE_ORIGIN_CONNECTION_LIMIT = 40;
export const HYPERDRIVE_RUNTIME_ROLE = 'ontos_runtime';
const TUNNEL_HEALTH_POLL = Duration.seconds(10);
const TUNNEL_HEALTH_TIMEOUT = Duration.minutes(10);
const TUNNEL_HEALTHY = 'healthy';
const NOT_FOUND = 'it does not exist';
const READY_TO_DEPLOY = 'READY_TO_DEPLOY';
const DB18_DATABASE_NAME = 'db18_dbName';

type StageVpcService = Omit<VpcServiceSpec, 'tunnelId'>;

/**
 * The two Zerops origins the tunnel exposes, and nothing else. cloudflared resolves fully qualified names, and
 * Zerops only answers a service's `<hostname>.zerops` name that way. Zerops Postgres serves a self-signed
 * certificate, so db18 is encrypted without a certificate check; the hop stays inside the Tunnel and the project network.
 * A CA check isn't possible yet: Workers VPC trusts no custom CA and Hyperdrive rejects `mtls` with a VPC
 * `service_id`. DEPLOYMENT.md, "Why db18 TLS is not CA-verified", has the evidence.
 */
export const STAGE_VPC_SERVICES = {
  db18: {
    certificateVerification: 'disabled',
    hostname: 'db18.zerops',
    name: 'ontos-stage-db18',
    port: 5432,
    type: 'tcp',
  },
  spicedb: {
    certificateVerification: 'verify_full',
    hostname: 'spicedb.zerops',
    name: 'ontos-stage-spicedb',
    port: 8443,
    type: 'http',
  },
} as const satisfies Readonly<Record<'db18' | 'spicedb', StageVpcService>>;

/** The Zerops data-layer services Cloudflare mode adds: the tunnel connector and the combined outbox worker host. */
export const CLOUDFLARED_SERVICE = { hostname: 'cloudflared', setup: 'cloudflared' } as const;
export const OUTBOX_WORKER_HOST_SERVICE = { hostname: 'outboxworkerhost', setup: 'outbox-worker-host' } as const;

export interface StageOrigins {
  readonly shellHostname: string;
  readonly stageZone: string;
}

export interface CutoverSettings extends StageOrigins {
  readonly accessEmails: readonly string[];
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted;
  /**
   * Gates the Shell hostname behind Access. Off until the framework's `cloudflare:proof` can send the
   * CI service token's headers: until then every stage-edge proof would fail and roll back.
   */
  readonly enforceShellAccess: boolean;
  readonly projectId: string;
  readonly repository: string;
  readonly stageEdgeApiToken: Redacted.Redacted;
}

export const CutoverConfiguration = Context.Service<CutoverSettings>(
  '@app/scripts/ops/cloudflare-stage-cutover/CutoverConfiguration',
);

// ---------------------------------------------------------------------------------------------
// Edge units and their stage origins

/** The whole placement document, so writing `buildEnvironment` preserves every other key. */
const PlacementDocumentSchema = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ buildEnvironment: BuildEnvironmentSchema }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
  { space: 2 },
);

const shellOrigin = (origins: StageOrigins) => `https://${origins.shellHostname}`;

/** The stage zone is shared with other projects, so every vertical hostname carries this prefix. */
const VERTICAL_HOSTNAME_PREFIX = 'ontos-stage-';

const verticalOrigin = (unitId: string, origins: StageOrigins) =>
  `https://${VERTICAL_HOSTNAME_PREFIX}${unitId}.${origins.stageZone}`;

/** The Shell answers on its own hostname; every vertical on `ontos-stage-<unit>.<zone>`. */
export const publicOrigin = (unit: EdgeUnit, origins: StageOrigins) =>
  unit.kind === 'shell' ? shellOrigin(origins) : verticalOrigin(unit.id, origins);

export interface DataPlaneIds {
  readonly compositionKvNamespaceId: string;
  readonly hyperdriveId: string;
  readonly spicedbVpcServiceId: string;
}

/** The reviewed `buildEnvironment` for these data-plane IDs; unrelated keys (e.g. MODERN_ASSET_PREFIX) are kept. */
export const stageBuildEnvironment = (
  current: BuildEnvironment,
  units: readonly EdgeUnit[],
  origins: StageOrigins,
  ids: DataPlaneIds,
): BuildEnvironment => {
  const merged = new Map([
    ...Object.entries(current),
    [COMPOSITION_KV_ID_VARIABLE, ids.compositionKvNamespaceId],
    [HYPERDRIVE_ID_VARIABLE, ids.hyperdriveId],
    [MF_DEV_ORIGIN_VARIABLE, shellOrigin(origins)],
    [SPICEDB_VPC_SERVICE_ID_VARIABLE, ids.spicedbVpcServiceId],
    ...units.map((unit): [string, string] => [unit.publicUrlEnv, publicOrigin(unit, origins)]),
  ]);
  return Object.fromEntries(Arr.sortWith([...merged], ([key]) => key, Order.String));
};

// ---------------------------------------------------------------------------------------------
// Worker secrets

const DEPLOYMENT_ENVIRONMENT_BINDING = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';

export interface WorkerSecretSources {
  readonly betterAuthSecret: Redacted.Redacted;
  readonly gatewayPrivateJwk: Redacted.Redacted;
  readonly gatewayPublicJwks: Redacted.Redacted;
  readonly spicedbPresharedKey: Redacted.Redacted;
}

/**
 * The URL-addressed dependencies of the verticals that call others (runbook A7). Calls a service
 * binding carries (Commerce → Price Group Catalog) still keep their URL for Node.
 */
const VERTICAL_DEPENDENCIES = new Map([
  [
    'commerce-customer-context',
    new Map([
      ['ONTOS_CATALOG_BASE_URL', 'catalog'],
      ['ONTOS_PRICE_GROUP_CATALOG_BASE_URL', 'price-group-catalog'],
      ['ONTOS_PRICING_BASE_URL', 'pricing'],
    ]),
  ],
  ['commerce-market-catalog', new Map([['ONTOS_COMMERCE_CUSTOMER_CONTEXT_BASE_URL', 'commerce-customer-context']])],
]);

const shellSecrets = (origins: StageOrigins, sources: WorkerSecretSources) =>
  new Map([
    ['BETTER_AUTH_SECRET', sources.betterAuthSecret],
    ['BETTER_AUTH_TRUSTED_ORIGINS', Redacted.make(shellOrigin(origins))],
    ['BETTER_AUTH_URL', Redacted.make(shellOrigin(origins))],
    ['ONTOS_GATEWAY_PRIVATE_JWK', sources.gatewayPrivateJwk],
  ]);

const verticalSecrets = (unit: EdgeUnit, origins: StageOrigins, sources: WorkerSecretSources) => {
  const secrets = new Map([['ONTOS_GATEWAY_PUBLIC_JWKS', sources.gatewayPublicJwks]]);
  const dependencies = VERTICAL_DEPENDENCIES.get(unit.id);
  for (const [variable, target] of dependencies ?? []) {
    secrets.set(variable, Redacted.make(`${verticalOrigin(target, origins)}/${target}-api`));
  }
  // A vertical that calls another asks the Shell for the gateway credential first.
  if (dependencies !== undefined) {
    secrets.set('ONTOS_SHELL_GATEWAY_BASE_URL', Redacted.make(`${shellOrigin(origins)}/shell-super-app-api`));
  }
  return secrets;
};

/** The TLS server name of the SpiceDB HTTP gateway; Workers VPC verifies it, and it needs no DNS record. */
export const spicedbGatewayHostname = ({ stageZone }: StageOrigins) =>
  `${STAGE_VPC_SERVICES.spicedb.name}.${stageZone}`;

/**
 * The runtime secrets of every placed Worker (runbook A7). Workers read PostgreSQL through their
 * `HYPERDRIVE` binding, so no Worker receives a DATABASE_URL.
 */
export const workerSecretPlan = (
  units: readonly EdgeUnit[],
  origins: StageOrigins,
  sources: WorkerSecretSources,
): ReadonlyMap<string, SecretValues> =>
  new Map(
    units.map((unit) => {
      const common = new Map([
        ['ONTOS_GATEWAY_ISSUER', Redacted.make(shellOrigin(origins))],
        // The Worker fetches the HTTP gateway by its TLS server name; the SPICEDB VPC binding routes
        // the request to the spicedb service and verifies the gateway certificate for that name.
        ['SPICEDB_ENDPOINT', Redacted.make(spicedbGatewayHostname(origins))],
        ['SPICEDB_PRESHARED_KEY', sources.spicedbPresharedKey],
        // The Worker build's environment never reaches the Worker's runtime bindings, so the Worker
        // names its deployment environment itself.
        [DEPLOYMENT_ENVIRONMENT_BINDING, Redacted.make('stage')],
      ]);
      const own = unit.kind === 'shell' ? shellSecrets(origins, sources) : verticalSecrets(unit, origins, sources);
      return [unit.workerName, Object.fromEntries([...common, ...own])];
    }),
  );

/** Zerops hostnames never contain a hyphen; the verticals' and the Shell's are their IDs without one. */
const zeropsHostname = (unitId: string) => unitId.replaceAll('-', '');

/** The Shell's Ed25519 gateway signing key, as stored on stage (a private JWK). */
const GatewayPrivateJwkSchema = Schema.fromJsonString(
  Schema.Struct({
    alg: Schema.String,
    crv: Schema.String,
    d: Schema.String,
    kid: Schema.String,
    kty: Schema.String,
    use: Schema.String,
    x: Schema.String,
  }),
);

const GatewayPublicJwksSchema = Schema.fromJsonString(
  Schema.Struct({
    keys: Schema.Tuple([
      Schema.Struct({
        alg: Schema.String,
        crv: Schema.String,
        key_ops: Schema.Tuple([Schema.Literal('verify')]),
        kid: Schema.String,
        kty: Schema.String,
        use: Schema.String,
        x: Schema.String,
      }),
    ]),
  }),
);

/**
 * The JWKS every vertical verifies Shell gateway tokens with: the public half of the Shell's
 * signing key. Deriving it keeps one source of truth, so a vertical without a Zerops service
 * (or after the Zerops verticals retire) still gets the key the Shell signs with.
 */
export const gatewayPublicJwksFor = (privateJwk: Redacted.Redacted) =>
  Schema.decodeUnknownEffect(GatewayPrivateJwkSchema)(Redacted.value(privateJwk)).pipe(
    Effect.flatMap(({ alg, crv, kid, kty, use, x }) =>
      Schema.encodeEffect(GatewayPublicJwksSchema)({
        keys: [{ alg, crv, key_ops: ['verify'], kid, kty, use, x }],
      }),
    ),
    Effect.map(Redacted.make),
    Effect.mapError(
      () => new StageOperationError({ message: 'the Shell ONTOS_GATEWAY_PRIVATE_JWK is not an Ed25519 private JWK' }),
    ),
  );

const readWorkerSecretSources = (units: readonly EdgeUnit[]) =>
  Effect.gen(function* readWorkerSecretSourcesEffect() {
    const { projectId } = yield* CutoverConfiguration;
    const shell = units.find((unit) => unit.kind === 'shell');
    if (shell === undefined) {
      return yield* new StageOperationError({ message: 'the Cloudflare placement does not place the Shell' });
    }
    const shellHost = zeropsHostname(shell.id);
    const gatewayPrivateJwk = yield* readZeropsValue(projectId, `${shellHost}_ONTOS_GATEWAY_PRIVATE_JWK`);
    return {
      betterAuthSecret: yield* readZeropsValue(projectId, `${shellHost}_BETTER_AUTH_SECRET`),
      gatewayPrivateJwk,
      gatewayPublicJwks: yield* gatewayPublicJwksFor(gatewayPrivateJwk),
      spicedbPresharedKey: yield* readZeropsValue(projectId, 'spicedb_SPICEDB_GRPC_PRESHARED_KEY'),
    } satisfies WorkerSecretSources;
  });

const SecretDocumentSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const secretDocument = (secrets: SecretValues) =>
  Schema.encodeEffect(SecretDocumentSchema)(
    Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, Redacted.value(value)])),
  ).pipe(
    Effect.map((json) => Redacted.make(json)),
    Effect.mapError((cause) => new StageOperationError({ cause, message: 'the Worker secrets could not be encoded' })),
  );

/** `wrangler secret bulk` creates a Worker that does not exist yet as a draft, so this may run before the seed. */
export const setWorkerSecrets = Effect.gen(function* setWorkerSecretsEffect() {
  const settings = yield* CutoverConfiguration;
  const units = yield* readEdgeUnits;
  const plan = workerSecretPlan(units, settings, yield* readWorkerSecretSources(units));
  const cwd = yield* appDirectory;
  for (const [workerName, secrets] of plan) {
    const stdin = yield* secretDocument(secrets);
    yield* perform(
      `set the secrets ${Object.keys(secrets).join(', ')} on Worker ${workerName}`,
      runCommand({
        args: ['--filter', '@app/shell-super-app', 'exec', 'wrangler', 'secret', 'bulk', '--name', workerName],
        command: 'pnpm',
        cwd,
        env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(settings.accountId), CLOUDFLARE_API_TOKEN: settings.apiToken },
        stdin,
      }),
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Tunnel, Workers VPC services, Hyperdrive

export interface StageTunnel {
  /** False only in a dry run that would create the tunnel. */
  readonly exists: boolean;
  readonly id: string;
}

export const ensureTunnel = Effect.gen(function* ensureTunnelEffect() {
  const api = yield* CloudflareApi;
  const existing = yield* api.findTunnel(STAGE_TUNNEL_NAME);
  if (Option.isSome(existing)) {
    yield* Console.log(`Tunnel ${STAGE_TUNNEL_NAME} exists: ${existing.value.id} (${existing.value.status})`);
    return { exists: true, id: existing.value.id } satisfies StageTunnel;
  }
  return yield* mutate(
    `create the remotely managed Tunnel ${STAGE_TUNNEL_NAME}`,
    api.createTunnel(STAGE_TUNNEL_NAME).pipe(Effect.map(({ id }): StageTunnel => ({ exists: true, id }))),
    { exists: false, id: `<${STAGE_TUNNEL_NAME} tunnel id>` },
  );
});

export const awaitTunnelHealthy = (tunnelId: string) =>
  perform(
    `wait until Tunnel ${STAGE_TUNNEL_NAME} reports ${TUNNEL_HEALTHY}`,
    Effect.gen(function* awaitTunnelHealthyEffect() {
      const api = yield* CloudflareApi;
      return yield* api.tunnel(tunnelId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(TUNNEL_HEALTH_POLL),
          until: ({ status }) => status === TUNNEL_HEALTHY,
        }),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: TUNNEL_HEALTH_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new StageOperationError({
              message: `Tunnel ${STAGE_TUNNEL_NAME} is not ${TUNNEL_HEALTHY}; check the Zerops cloudflared service logs`,
            }),
          ),
      }),
    ),
  );

const vpcSpec = (tunnelId: string, service: StageVpcService): VpcServiceSpec => ({ ...service, tunnelId });

const differences = (items: readonly (string | false)[]): Option.Option<string> => {
  const found = items.filter((item) => item !== false);
  return found.length === 0 ? Option.none() : Option.some(found.join(', '));
};

/** Why an existing VPC service does not match its spec, if it does not. */
export const vpcServiceDrift = (service: CloudflareVpcService, spec: VpcServiceSpec): Option.Option<string> => {
  const port = Option.getOrUndefined(spec.type === 'tcp' ? service.tcp_port : service.https_port);
  const plaintextPort = spec.type === 'http' ? Option.getOrUndefined(service.http_port) : undefined;
  // Cloudflare verifies in full when a service names no mode.
  const verification = service.tls_settings.pipe(
    Option.flatMap((settings) => settings.cert_verification_mode),
    Option.getOrElse(() => VPC_CERT_VERIFICATION_MODE),
  );
  const hostname = Option.getOrUndefined(service.host.hostname);
  const tunnelId = service.host.resolver_network.pipe(
    Option.map((network) => network.tunnel_id),
    Option.getOrUndefined,
  );
  return differences([
    service.type !== spec.type && `type ${service.type}`,
    port !== spec.port && `port ${String(port)}`,
    plaintextPort !== undefined && `plaintext port ${String(plaintextPort)}`,
    verification !== spec.certificateVerification && `certificate verification ${verification}`,
    hostname !== spec.hostname && `hostname ${String(hostname)}`,
    tunnelId !== spec.tunnelId && 'another tunnel',
  ]);
};

const ensureVpcService = (existing: readonly CloudflareVpcService[], spec: VpcServiceSpec) =>
  Effect.gen(function* ensureVpcServiceEffect() {
    const current = existing.find((service) => service.name === spec.name);
    if (current !== undefined) {
      const drift = vpcServiceDrift(current, spec);
      if (Option.isSome(drift)) {
        return yield* new StageOperationError({
          message: `Workers VPC service ${spec.name} (${current.service_id}) differs from the runbook: ${drift.value}; fix or delete it, then re-run`,
        });
      }
      yield* Console.log(`Workers VPC service ${spec.name} exists: ${current.service_id}`);
      return current.service_id;
    }
    const api = yield* CloudflareApi;
    return yield* mutate(
      `create the Workers VPC ${spec.type} service ${spec.name} for ${spec.hostname}:${String(spec.port)}`,
      api.createVpcService(spec).pipe(Effect.map(({ service_id }) => service_id)),
      `<${spec.name} id>`,
    );
  });

export const ensureVpcServices = (tunnelId: string) =>
  Effect.gen(function* ensureVpcServicesEffect() {
    const api = yield* CloudflareApi;
    const existing = yield* api.vpcServices;
    return {
      db18: yield* ensureVpcService(existing, vpcSpec(tunnelId, STAGE_VPC_SERVICES.db18)),
      spicedb: yield* ensureVpcService(existing, vpcSpec(tunnelId, STAGE_VPC_SERVICES.spicedb)),
    };
  });

/** The origin a stage Hyperdrive config must use: the db18 VPC service and the Zerops database name. */
export interface HyperdriveOrigin {
  readonly database: string;
  readonly serviceId: string;
}

export const hyperdriveDrift = (hyperdrive: CloudflareHyperdrive, origin: HyperdriveOrigin): Option.Option<string> => {
  const cachingDisabled = hyperdrive.caching.pipe(
    Option.flatMap((caching) => caching.disabled),
    Option.getOrUndefined,
  );
  const limit = Option.getOrUndefined(hyperdrive.origin_connection_limit);
  const user = Option.getOrUndefined(hyperdrive.origin.user);
  const scheme = Option.getOrUndefined(hyperdrive.origin.scheme);
  const database = Option.getOrUndefined(hyperdrive.origin.database);
  return differences([
    cachingDisabled !== true && 'caching is enabled',
    limit !== HYPERDRIVE_ORIGIN_CONNECTION_LIMIT && `origin connection limit ${String(limit)}`,
    Option.getOrUndefined(hyperdrive.origin.service_id) !== origin.serviceId && 'another origin service',
    scheme !== 'postgresql' && `scheme ${String(scheme)}`,
    database !== origin.database && `database ${String(database)}`,
    user !== HYPERDRIVE_RUNTIME_ROLE && `user ${String(user)}`,
  ]);
};

export const ensureHyperdrive = (db18ServiceId: string) =>
  Effect.gen(function* ensureHyperdriveEffect() {
    const api = yield* CloudflareApi;
    const { projectId } = yield* CutoverConfiguration;
    const current = (yield* api.hyperdrives).find((hyperdrive) => hyperdrive.name === STAGE_HYPERDRIVE_NAME);
    const database = yield* readZeropsValue(projectId, DB18_DATABASE_NAME);
    if (current !== undefined) {
      const drift = hyperdriveDrift(current, { database: Redacted.value(database), serviceId: db18ServiceId });
      if (Option.isSome(drift)) {
        return yield* new StageOperationError({
          message: `Hyperdrive ${STAGE_HYPERDRIVE_NAME} (${current.id}) differs from the runbook: ${drift.value}; fix or delete it, then re-run`,
        });
      }
      yield* Console.log(`Hyperdrive ${STAGE_HYPERDRIVE_NAME} exists: ${current.id}`);
      return current.id;
    }
    // Hyperdrive connects to the origin on creation, so the tunnel must already be healthy.
    return yield* mutate(
      `create Hyperdrive ${STAGE_HYPERDRIVE_NAME} (role ${HYPERDRIVE_RUNTIME_ROLE}, caching disabled, origin connection limit ${String(HYPERDRIVE_ORIGIN_CONNECTION_LIMIT)})`,
      Effect.gen(function* createHyperdrive() {
        const created = yield* api.createHyperdrive({
          database,
          name: STAGE_HYPERDRIVE_NAME,
          originConnectionLimit: HYPERDRIVE_ORIGIN_CONNECTION_LIMIT,
          password: yield* readZeropsValue(projectId, 'db18_password'),
          serviceId: db18ServiceId,
          user: HYPERDRIVE_RUNTIME_ROLE,
        });
        return created.id;
      }),
      `<${STAGE_HYPERDRIVE_NAME} id>`,
    );
  });

/** The composition KV namespace; CI writes the published snapshot to it, so it starts empty. */
export const ensureCompositionKvNamespace = Effect.gen(function* ensureCompositionKvNamespaceEffect() {
  const api = yield* CloudflareApi;
  const current = (yield* api.kvNamespaces).find(({ title }) => title === STAGE_COMPOSITION_KV_NAME);
  if (current !== undefined) {
    yield* Console.log(`KV namespace ${STAGE_COMPOSITION_KV_NAME} exists: ${current.id}`);
    return current.id;
  }
  return yield* mutate(
    `create KV namespace ${STAGE_COMPOSITION_KV_NAME}`,
    api.createKvNamespace(STAGE_COMPOSITION_KV_NAME).pipe(Effect.map(({ id }) => id)),
    `<${STAGE_COMPOSITION_KV_NAME} id>`,
  );
});

// ---------------------------------------------------------------------------------------------
// Zerops data layer: cloudflared and the outbox worker host

const plannedService = ({ entry }: ServiceImport): ZeropsService => ({
  hostname: entry.hostname,
  id: `<${entry.hostname} service id>`,
  status: READY_TO_DEPLOY,
});

const missingDataLayerImports = (tunnel: StageTunnel, present: ReadonlySet<string>) =>
  Effect.gen(function* missingDataLayerImportsEffect() {
    const entries = yield* readZeropsImport;
    const imports: ServiceImport[] = [];
    if (!present.has(CLOUDFLARED_SERVICE.hostname)) {
      const entry = yield* importEntry(entries, CLOUDFLARED_SERVICE.hostname);
      const api = yield* CloudflareApi;
      const token = tunnel.exists ? yield* api.tunnelToken(tunnel.id) : Redacted.make('<planned tunnel token>');
      imports.push({ entry, envSecrets: { TUNNEL_TOKEN: token } });
    }
    if (!present.has(OUTBOX_WORKER_HOST_SERVICE.hostname)) {
      imports.push({ entry: yield* importEntry(entries, OUTBOX_WORKER_HOST_SERVICE.hostname), envSecrets: {} });
    }
    return imports;
  });

const pushCloudflared = (service: ZeropsService) =>
  Effect.gen(function* pushCloudflaredEffect() {
    const { projectId } = yield* CutoverConfiguration;
    yield* perform(
      `deploy the ${CLOUDFLARED_SERVICE.setup} setup to Zerops service ${service.id}`,
      runCommand({
        args: [
          'push',
          '--working-dir',
          '.',
          '--zerops-yaml-path',
          'app/zerops.yaml',
          // Like CI: deploy the committed revision, never local edits (A2 writes the placement file).
          '--workspace-state',
          'clean',
          '--project-id',
          projectId,
          '--service-id',
          service.id,
          '--setup',
          CLOUDFLARED_SERVICE.setup,
        ],
        command: 'zcli',
        cwd: yield* repositoryDirectory,
      }),
    );
  });

/**
 * Imports the missing data-layer services from `app/zerops-import.yaml` (cloudflared receives the
 * tunnel connector token as its TUNNEL_TOKEN secret), records their `ZEROPS_*_SERVICE_ID` stage
 * variables, and pushes cloudflared when it has never been deployed. CI deploys the outbox worker host.
 */
export const ensureZeropsDataLayer = (tunnel: StageTunnel) =>
  Effect.gen(function* ensureZeropsDataLayerEffect() {
    const { projectId, repository } = yield* CutoverConfiguration;
    const services = yield* listZeropsServices(projectId);
    const imports = yield* missingDataLayerImports(tunnel, new Set(services.map(({ hostname }) => hostname)));
    const current =
      imports.length === 0
        ? services
        : yield* mutate(
            `import the Zerops services ${imports.map(({ entry }) => entry.hostname).join(', ')} from app/zerops-import.yaml`,
            importZeropsServices(projectId, imports).pipe(Effect.andThen(listZeropsServices(projectId))),
            [...services, ...imports.map(plannedService)],
          );
    const stageVariables = yield* listGithubVariables(repository, STAGE_ENVIRONMENT);
    for (const { hostname, setup } of [CLOUDFLARED_SERVICE, OUTBOX_WORKER_HOST_SERVICE]) {
      const service = current.find((candidate) => candidate.hostname === hostname);
      if (service === undefined) {
        return yield* new StageOperationError({ message: `Zerops did not create the ${hostname} service` });
      }
      const variable = serviceIdVariable(setup);
      if (stageVariables.get(variable) !== service.id) {
        yield* perform(
          `set the ${STAGE_ENVIRONMENT} variable ${variable}=${service.id}`,
          setGithubVariable(repository, STAGE_ENVIRONMENT, variable, service.id),
        );
      }
    }
    const cloudflared = current.find((service) => service.hostname === CLOUDFLARED_SERVICE.hostname);
    if (cloudflared?.status === READY_TO_DEPLOY) {
      yield* pushCloudflared(cloudflared);
    }
    return current;
  });

// ---------------------------------------------------------------------------------------------
// Reviewed build environment and GitHub

/** Writes the data-plane IDs and stage origins into `topology/cloudflare-placement.json` for the A6 PR. */
export const writeBuildEnvironment = (ids: DataPlaneIds) =>
  Effect.gen(function* writeBuildEnvironmentEffect() {
    const settings = yield* CutoverConfiguration;
    const fileSystem = yield* FileSystem.FileSystem;
    const document = yield* decodeInput(
      PlacementDocumentSchema,
      PLACEMENT_LABEL,
    )(yield* readAppText(...PLACEMENT_PATH));
    const buildEnvironment = stageBuildEnvironment(document.buildEnvironment, yield* readEdgeUnits, settings, ids);
    const changed = Object.keys(buildEnvironment).filter(
      (key) => document.buildEnvironment[key] !== buildEnvironment[key],
    );
    if (changed.length === 0) {
      yield* Console.log(`${PLACEMENT_LABEL} buildEnvironment is current`);
      return;
    }
    const text = yield* Schema.encodeEffect(PlacementDocumentSchema)({ ...document, buildEnvironment }).pipe(
      Effect.mapError(
        (cause) => new StageOperationError({ cause, message: `${PLACEMENT_LABEL} could not be encoded` }),
      ),
    );
    const path = yield* appFile(...PLACEMENT_PATH);
    yield* perform(
      `write ${changed.join(', ')} into the ${PLACEMENT_LABEL} buildEnvironment; open the reviewed A6 PR with it`,
      fileSystem.writeFileString(path, `${text}\n`),
    );
  });

/**
 * The edge deploy reads CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_API_TOKEN secret from `stage-edge`.
 * The data-plane IDs are not variables: CI reads them only from the reviewed placement
 * `buildEnvironment`, so a Worker's configuration is always a reviewed revision.
 */
export const configureStageEdge = Effect.gen(function* configureStageEdgeEffect() {
  const { accountId, repository, stageEdgeApiToken } = yield* CutoverConfiguration;
  const environments = yield* githubApi([`repos/${repository}/environments`, '--jq', '.environments[].name']);
  if (!environments.split('\n').includes(STAGE_EDGE_ENVIRONMENT)) {
    yield* perform(
      `create the GitHub environment ${STAGE_EDGE_ENVIRONMENT} without deployment protection rules`,
      githubApi(['-X', 'PUT', `repos/${repository}/environments/${STAGE_EDGE_ENVIRONMENT}`]),
    );
  }
  const variables = yield* listGithubVariables(repository, STAGE_EDGE_ENVIRONMENT);
  if (variables.get('CLOUDFLARE_ACCOUNT_ID') !== accountId) {
    yield* perform(
      `set the ${STAGE_EDGE_ENVIRONMENT} variable CLOUDFLARE_ACCOUNT_ID=${accountId}`,
      setGithubVariable(repository, STAGE_EDGE_ENVIRONMENT, 'CLOUDFLARE_ACCOUNT_ID', accountId),
    );
  }
  yield* perform(
    `set the ${STAGE_EDGE_ENVIRONMENT} secret CLOUDFLARE_API_TOKEN`,
    setGithubSecret(repository, STAGE_EDGE_ENVIRONMENT, 'CLOUDFLARE_API_TOKEN', stageEdgeApiToken),
  );
});

// ---------------------------------------------------------------------------------------------
// SpiceDB TLS

const spicedbTlsTarget = Effect.gen(function* spicedbTlsTargetEffect() {
  const settings = yield* CutoverConfiguration;
  return { gatewayHostname: spicedbGatewayHostname(settings), projectId: settings.projectId };
});

/** Creates the SpiceDB gRPC and HTTP gateway TLS secrets on the Zerops `spicedb` service when they are missing. */
export const ensureStageSpicedbTls = spicedbTlsTarget.pipe(Effect.flatMap(ensureSpicedbTls));

// Cost guards

/** The cost guards cover the Shell and every placed vertical's public hostname. */
const costGuardPlan = Effect.gen(function* costGuardPlanEffect() {
  const settings = yield* CutoverConfiguration;
  const units = yield* readEdgeUnits;
  const plan: CostGuardPlan = {
    accessEmails: settings.accessEmails,
    enforceShellAccess: settings.enforceShellAccess,
    hostnames: units.map((unit) => new URL(publicOrigin(unit, settings)).hostname),
    repository: settings.repository,
    shellHostname: settings.shellHostname,
    stageZone: settings.stageZone,
  };
  return plan;
});

export const provisionCostGuards = Effect.gen(function* provisionCostGuardsEffect() {
  yield* ensureCostGuards(yield* costGuardPlan);
});

/** Turns the kill switch off again once the cause of the usage spike is understood. */
export const resume = Effect.gen(function* resumeEffect() {
  const api = yield* CloudflareApi;
  const { stageZone } = yield* CutoverConfiguration;
  const zoneId = yield* api.findZoneId(stageZone);
  if (Option.isNone(zoneId)) {
    return yield* new StageOperationError({ message: `the API token cannot read the zone ${stageZone}` });
  }
  return yield* setKillSwitch(zoneId.value, false);
});

// ---------------------------------------------------------------------------------------------
// Provisioning and verification

/** Every provisioning step, in dependency order. Activation is separate and runs only after verification. */
export const provision = Effect.gen(function* provisionEffect() {
  yield* ensureStageSpicedbTls;
  const tunnel = yield* ensureTunnel;
  yield* ensureZeropsDataLayer(tunnel);
  yield* awaitTunnelHealthy(tunnel.id);
  const vpc = yield* ensureVpcServices(tunnel.id);
  const hyperdriveId = yield* ensureHyperdrive(vpc.db18);
  const compositionKvNamespaceId = yield* ensureCompositionKvNamespace;
  yield* writeBuildEnvironment({ compositionKvNamespaceId, hyperdriveId, spicedbVpcServiceId: vpc.spicedb });
  yield* configureStageEdge;
  yield* provisionCostGuards;
  yield* setWorkerSecrets;
});

const DeploymentsSchema = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.Number, sha: Schema.String })));
const StatusesSchema = Schema.fromJsonString(Schema.Array(Schema.Struct({ state: Schema.String })));

const check = (label: string, failure: Option.Option<string>) =>
  Option.match(failure, {
    onNone: () => Console.log(`ok   ${label}`),
    onSome: (reason) => Effect.fail(new StageOperationError({ message: `${label}: ${reason}` })),
  });

const latestStageEdgeState = Effect.gen(function* latestStageEdgeStateEffect() {
  const { repository } = yield* CutoverConfiguration;
  const deployments = yield* githubApi([
    `repos/${repository}/deployments?environment=${STAGE_EDGE_ENVIRONMENT}&per_page=1`,
  ]).pipe(Effect.flatMap(decodeInput(DeploymentsSchema, `the ${STAGE_EDGE_ENVIRONMENT} deployments`)));
  const [deployment] = deployments;
  if (deployment === undefined) {
    return Option.some('there is none; seed it with a full run');
  }
  const [status] = yield* githubApi([
    `repos/${repository}/deployments/${String(deployment.id)}/statuses?per_page=1`,
  ]).pipe(Effect.flatMap(decodeInput(StatusesSchema, `the ${STAGE_EDGE_ENVIRONMENT} deployment statuses`)));
  if (status?.state !== 'success') {
    return Option.some(`deployment ${String(deployment.id)} is ${status?.state ?? 'without a status'}`);
  }
  // An older successful deployment does not prove the current placement and bindings are live.
  const cwd = yield* repositoryDirectory;
  const revision = (yield* runCommand({ args: ['rev-parse', 'HEAD'], command: 'git', cwd })).trim();
  if (deployment.sha !== revision) {
    return Option.some(
      `deployment ${String(deployment.id)} deployed ${deployment.sha}, not the checked-out revision ${revision}; pull main or wait for its stage-edge deployment`,
    );
  }
  // `provision` rewrites the placement in the working tree; the deployed Workers bind only the committed IDs.
  const placementChanges = (yield* runCommand({
    args: ['status', '--porcelain', '--', `app/${PLACEMENT_LABEL}`],
    command: 'git',
    cwd,
  })).trim();
  return placementChanges === ''
    ? Option.none<string>()
    : Option.some(
        `${PLACEMENT_LABEL} has uncommitted changes that deployment ${String(deployment.id)} did not deploy; merge the build-environment PR and verify from main`,
      );
});

const SNAPSHOT_KEY = 'active';

/**
 * A placed Worker that consumes the active Application Composition fails closed without the snapshot in
 * the composition KV namespace. CI writes every publication there only once stage deploys with
 * DEPLOY_TARGET=cloudflare (`sync-edge-composition`, then `refresh-stage-edge` on each scheduled
 * refresh), so before activation the item is pending, and after it the key must exist before the stage
 * hostnames move to the Workers.
 */
const compositionSnapshotState = (namespaceId: string) =>
  Effect.gen(function* compositionSnapshotStateEffect() {
    const api = yield* CloudflareApi;
    const { repository } = yield* CutoverConfiguration;
    const label = `the ${STAGE_COMPOSITION_KV_NAME} KV namespace holds the active Application Composition`;
    const variables = yield* listGithubVariables(repository, STAGE_ENVIRONMENT);
    if (variables.get(DEPLOY_TARGET_VARIABLE) !== 'cloudflare') {
      return yield* Console.log(
        `wait ${label}: the first ${DEPLOY_TARGET_VARIABLE}=cloudflare deploy after activate writes it; verify again before moving DNS`,
      );
    }
    return yield* check(
      label,
      (yield* api.kvKeyExists(namespaceId, SNAPSHOT_KEY))
        ? Option.none()
        : Option.some(`key ${SNAPSHOT_KEY} is missing; run the full stage deploy so sync-edge-composition writes it`),
    );
  });

/** Every placed Worker holds each runtime secret `provision` plans for it; values are never read back. */
const workerSecretsState = Effect.gen(function* workerSecretsStateEffect() {
  const api = yield* CloudflareApi;
  const settings = yield* CutoverConfiguration;
  const units = yield* readEdgeUnits;
  const plan = workerSecretPlan(units, settings, yield* readWorkerSecretSources(units));
  const gaps: string[] = [];
  for (const [workerName, secrets] of plan) {
    const present = yield* api.workerSecretNames(workerName);
    const missing = Object.keys(secrets).filter((name) => !present.has(name));
    if (missing.length > 0) {
      gaps.push(`${workerName} lacks ${missing.join(', ')}`);
    }
  }
  return yield* check(
    'every placed Worker holds its planned runtime secrets',
    gaps.length === 0 ? Option.none() : Option.some(`${gaps.join('; ')}; run worker-secrets`),
  );
});

/**
 * The cut-over verification checklist. It fails on the first unmet item, before anything changes.
 * Only when every item holds does `activate` switch `stage` to DEPLOY_TARGET=cloudflare and OUTBOX_WORKER_MODE=host.
 */
export const verifyCutover = Effect.gen(function* verifyCutoverEffect() {
  const api = yield* CloudflareApi;
  const { projectId } = yield* CutoverConfiguration;
  const tunnel = yield* api.findTunnel(STAGE_TUNNEL_NAME);
  if (Option.isNone(tunnel)) {
    return yield* check(`Tunnel ${STAGE_TUNNEL_NAME} is ${TUNNEL_HEALTHY}`, Option.some(NOT_FOUND));
  }
  yield* check(
    `Tunnel ${STAGE_TUNNEL_NAME} is ${TUNNEL_HEALTHY}`,
    tunnel.value.status === TUNNEL_HEALTHY ? Option.none() : Option.some(`status ${tunnel.value.status}`),
  );
  const tlsTarget = yield* spicedbTlsTarget;
  yield* check(
    `the Zerops spicedb service holds valid gRPC and ${tlsTarget.gatewayHostname} gateway TLS secrets`,
    yield* spicedbTlsState(tlsTarget),
  );
  const vpcServices = yield* api.vpcServices;
  const vpcIds = new Map<string, string>();
  for (const service of Object.values(STAGE_VPC_SERVICES)) {
    const spec = vpcSpec(tunnel.value.id, service);
    const current = vpcServices.find(({ name }) => name === spec.name);
    yield* check(
      `Workers VPC service ${spec.name} targets ${spec.hostname}:${String(spec.port)} through the tunnel`,
      current === undefined ? Option.some(NOT_FOUND) : vpcServiceDrift(current, spec),
    );
    vpcIds.set(spec.name, current?.service_id ?? '');
  }
  const hyperdrive = (yield* api.hyperdrives).find(({ name }) => name === STAGE_HYPERDRIVE_NAME);
  yield* check(
    `Hyperdrive ${STAGE_HYPERDRIVE_NAME} uses ${HYPERDRIVE_RUNTIME_ROLE} through the db18 service, caching off, limit ${String(HYPERDRIVE_ORIGIN_CONNECTION_LIMIT)}`,
    hyperdrive === undefined
      ? Option.some(NOT_FOUND)
      : hyperdriveDrift(hyperdrive, {
          database: Redacted.value(yield* readZeropsValue(projectId, DB18_DATABASE_NAME)),
          serviceId: vpcIds.get(STAGE_VPC_SERVICES.db18.name) ?? '',
        }),
  );
  const compositionKv = (yield* api.kvNamespaces).find(({ title }) => title === STAGE_COMPOSITION_KV_NAME);
  yield* check(
    `KV namespace ${STAGE_COMPOSITION_KV_NAME} exists`,
    compositionKv === undefined ? Option.some(NOT_FOUND) : Option.none(),
  );
  const placement = yield* decodeInput(PlacementSchema, PLACEMENT_LABEL)(yield* readAppText(...PLACEMENT_PATH));
  yield* check(
    `the ${PLACEMENT_LABEL} buildEnvironment names these data-plane IDs`,
    placement.buildEnvironment[HYPERDRIVE_ID_VARIABLE] === hyperdrive?.id &&
      placement.buildEnvironment[COMPOSITION_KV_ID_VARIABLE] === compositionKv?.id &&
      placement.buildEnvironment[SPICEDB_VPC_SERVICE_ID_VARIABLE] === vpcIds.get(STAGE_VPC_SERVICES.spicedb.name)
      ? Option.none()
      : Option.some('run provision, then merge the build-environment PR and verify from main'),
  );
  const scripts = yield* api.workerScriptNames;
  const missingWorkers = (yield* readEdgeUnits)
    .map(({ workerName }) => workerName)
    .filter((name) => !scripts.has(name));
  yield* check(
    'every placed Worker is deployed',
    missingWorkers.length === 0 ? Option.none() : Option.some(`missing ${missingWorkers.join(', ')}`),
  );
  yield* workerSecretsState;
  for (const [label, failure] of yield* costGuardChecks(yield* costGuardPlan)) {
    yield* check(label, failure);
  }
  yield* check(
    `the latest ${STAGE_EDGE_ENVIRONMENT} deployment (Worker deploy plus cloudflare:proof) succeeded for the checked-out revision`,
    yield* latestStageEdgeState,
  );
  yield* compositionSnapshotState(compositionKv?.id ?? '');
  return yield* Effect.void;
});

/**
 * The Cloudflare stage runs its Outbox Workers in the one host `provision` created, the cheap mode for stage.
 * The mode stays its own variable: a later `OUTBOX_WORKER_MODE` change and a deploy switch it alone.
 */
const ACTIVATED_STAGE_VARIABLES = [
  [OUTBOX_WORKER_MODE_VARIABLE, 'host'],
  [DEPLOY_TARGET_VARIABLE, 'cloudflare'],
] as const;

export const activate = Effect.gen(function* activateEffect() {
  const { repository } = yield* CutoverConfiguration;
  yield* verifyCutover;
  const variables = yield* listGithubVariables(repository, STAGE_ENVIRONMENT);
  for (const [variable, value] of ACTIVATED_STAGE_VARIABLES) {
    yield* variables.get(variable) === value
      ? Console.log(`${STAGE_ENVIRONMENT} already deploys with ${variable}=${value}`)
      : perform(
          `set the ${STAGE_ENVIRONMENT} variable ${variable}=${value}`,
          setGithubVariable(repository, STAGE_ENVIRONMENT, variable, value),
        );
  }
});

// ---------------------------------------------------------------------------------------------
// Composition root

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u;

export const loadCutoverSettings = Effect.gen(function* loadCutoverSettingsEffect() {
  const apiToken = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
  const settings: CutoverSettings = {
    accessEmails: (yield* Config.String('STAGE_ACCESS_EMAILS'))
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email !== ''),
    accountId: yield* Config.String('CLOUDFLARE_ACCOUNT_ID'),
    apiToken,
    enforceShellAccess: yield* Config.Boolean('STAGE_ACCESS_ENFORCE_SHELL').pipe(Config.withDefault(false)),
    projectId: STAGE_ZEROPS_PROJECT_ID,
    repository: ONTOS_REPOSITORY,
    shellHostname: yield* Config.String('STAGE_SHELL_HOSTNAME'),
    stageEdgeApiToken: yield* Config.Redacted('CLOUDFLARE_STAGE_EDGE_API_TOKEN').pipe(Config.withDefault(apiToken)),
    stageZone: yield* Config.String('STAGE_ZONE'),
  };
  if (!HOSTNAME_PATTERN.test(settings.stageZone) || !HOSTNAME_PATTERN.test(settings.shellHostname)) {
    return yield* new StageOperationError({ message: 'STAGE_ZONE and STAGE_SHELL_HOSTNAME must be DNS hostnames' });
  }
  if (settings.accessEmails.length === 0 || !settings.accessEmails.every((email) => EMAIL_PATTERN.test(email))) {
    return yield* new StageOperationError({ message: 'STAGE_ACCESS_EMAILS must list at least one email address' });
  }
  if (settings.shellHostname !== settings.stageZone && !settings.shellHostname.endsWith(`.${settings.stageZone}`)) {
    return yield* new StageOperationError({ message: 'STAGE_SHELL_HOSTNAME must be inside STAGE_ZONE' });
  }
  return settings;
});

/** The settings file, when it exists, backs every setting the environment does not provide. */
const settingsFileProvider = (envFile: Option.Option<string>) =>
  Effect.gen(function* settingsFileProviderEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = Option.isSome(envFile)
      ? envFile.value
      : `${yield* Config.String('HOME')}/.cloudflare-ontos-stage-token`;
    return (yield* fileSystem.exists(path))
      ? yield* ConfigProvider.fromDotEnv({ path })
      : ConfigProvider.fromUnknown({});
  });

const cutoverLayer = ({ dryRun, envFile }: { readonly dryRun: boolean; readonly envFile: Option.Option<string> }) => {
  const configuration = Layer.effect(
    CutoverConfiguration,
    loadCutoverSettings.pipe(
      Effect.catchTag('ConfigError', (cause) =>
        Effect.fail(
          new StageOperationError({
            cause,
            message: `a Cloudflare setting is missing or invalid (${cause.message}); set it in the environment or in ${Option.getOrElse(envFile, () => 'the dotenv file ~/.cloudflare-ontos-stage-token')}. Nothing was changed`,
          }),
        ),
      ),
    ),
  );
  const credentials = Layer.effect(
    CloudflareCredentials,
    Effect.gen(function* cloudflareCredentials() {
      const { accountId, apiToken } = yield* CutoverConfiguration;
      return { accountId, apiToken };
    }),
  );
  // The settings file stays in the steps' context: the Zerops API reads ZEROPS_TOKEN per request.
  return Layer.mergeAll(
    CloudflareApiLive.pipe(Layer.provide(credentials)),
    ZeropsPublicApiLive,
    Layer.succeed(OpsMode, { dryRun }),
  ).pipe(Layer.provideMerge(configuration), Layer.provideMerge(ConfigProvider.layerAdd(settingsFileProvider(envFile))));
};

const stepCommand = <A, E, R>(name: string, description: string, step: Effect.Effect<A, E, R>) =>
  Command.make(
    name,
    {
      dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
      envFile: Flag.String('env-file').pipe(Flag.optional),
    },
    () => step,
  ).pipe(Command.withDescription(description), Command.provide(cutoverLayer));

const cli = Command.make('cloudflare-stage-cutover').pipe(
  Command.withSubcommands([
    stepCommand(
      'provision',
      'Create or reuse the SpiceDB TLS secrets, the Tunnel, cloudflared and outbox-worker-host, VPC services, Hyperdrive, the composition KV namespace, build environment, stage-edge, cost guards and Worker secrets',
      provision,
    ),
    stepCommand(
      'spicedb-tls',
      'Create the SpiceDB gRPC and HTTP gateway TLS certificates as Zerops spicedb service secrets when missing',
      ensureStageSpicedbTls,
    ),
    stepCommand(
      'cost-guards',
      'Create or converge Access, the disabled kill switch and the usage notification',
      provisionCostGuards,
    ),
    stepCommand('worker-secrets', "Set every placed Worker's runtime secrets from Zerops", setWorkerSecrets),
    stepCommand('verify', 'Run the cut-over verification checklist without changing anything', verifyCutover),
    stepCommand(
      'activate',
      'Verify, then set DEPLOY_TARGET=cloudflare and OUTBOX_WORKER_MODE=host on the stage environment',
      activate,
    ),
    stepCommand('resume', 'Turn the cost kill switch off so the stage hostnames reach the Workers again', resume),
  ]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(main).pipe(
        Layer.provide(OpsShellLive),
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
