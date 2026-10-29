#!/usr/bin/env node
import { PARTY_REGISTRY_REQUEST_IDENTITY } from '@app/party-registry-identity-contracts';
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
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import { selectZeropsSetup } from '../materialize-zerops-environment.mts';
import { serviceIdVariable } from '../publish-active-application-composition.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';
import {
  CloudflareApi,
  CloudflareApiLive,
  CloudflareCredentials,
  CloudflareZoneApi,
  CloudflareZoneApiLive,
  VPC_CERT_VERIFICATION_MODE,
} from './cloudflare-api.mts';
import type {
  CloudflareHyperdrive,
  CloudflareKvNamespace,
  CloudflareVpcService,
  VpcServiceSpec,
} from './cloudflare-api.mts';
import { readStageEdgeTopology, STAGE_EDGE_TOPOLOGY_PATH } from './stage-edge-topology.mts';
import { seedComposition } from './cloudflare-stage-composition-seed.mts';
import { costGuardChecks, ensureCostGuards, setKillSwitch } from './cloudflare-stage-cost-guard.mts';
import type { CostGuardPlan } from './cloudflare-stage-cost-guard.mts';
import {
  DatabaseLoginRolesLive,
  databaseIdentitySecretsState,
  ensureDatabaseIdentities,
} from './database-identities.mts';
import { MIGRATOR_SERVICE_HOSTNAME, migratorSecretReference } from './database-identity-secrets.mts';
import { OpsShellLive, runCommand } from './ops-shell.mts';
import type { SecretValues } from './ops-shell.mts';
import { ensureSpicedbTls, spicedbTlsState } from './spicedb-tls.mts';
import {
  BuildEnvironmentSchema,
  COMPOSITION_KV_ID_VARIABLE,
  GATEWAY_ISSUER_HYPERDRIVE_ID_VARIABLE,
  HYPERDRIVE_ID_VARIABLE,
  MF_DEV_ORIGIN_VARIABLE,
  PARTY_REGISTRY_HYPERDRIVE_ID_VARIABLE,
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
 * Idempotent Cloudflare stage bootstrap. Public topology comes only from topology/stage-edge.json.
 * --env-file is required for credentials (CLOUDFLARE_API_TOKEN, ZEROPS_TOKEN, DATABASE_ADMIN_URL),
 * STAGE_ACCESS_EMAILS, optional STAGE_ACCESS_ENFORCE and CLOUDFLARE_STAGE_EDGE_API_TOKEN.
 * --dry-run performs reads and reports each planned mutation without writing.
 */
export const STAGE_TUNNEL_NAME = 'ontos-stage';
/** The KV namespace every placed Worker reads the active Application Composition from. */
export const STAGE_COMPOSITION_KV_NAME = 'ontos-stage-active-application-composition';
export const STAGE_STOREFRONT_CATALOG_KV_NAME = 'ontos-stage-akros-storefront-catalog';

/** One stage Hyperdrive config: a database identity's login reaching db18 through the VPC service. */
export interface StageHyperdriveSpec {
  /** The placement build variable the config's ID is written to. */
  readonly idVariable: string;
  readonly name: string;
  readonly originConnectionLimit: number;
  readonly role: string;
  /** The `<hostname>_<KEY>` Zerops value holding the login's password. */
  readonly secretReference: string;
}

export const STAGE_HYPERDRIVE_NAME = 'ontos-stage-runtime';
export const PARTY_REGISTRY_STAGE_HYPERDRIVE_NAME = 'ontos-stage-party-registry';
export const GATEWAY_ISSUER_STAGE_HYPERDRIVE_NAME = 'ontos-stage-gateway-issuer';
/**
 * The three configs split one db18 connection budget: 60 for the shared runtime pool, 10 for Party
 * Registry requests and 5 for the Shell's gateway-grant registrations, 75 origin connections in total.
 * Raise one only when db18 `max_connections` leaves room for the sum.
 */
export const HYPERDRIVE_ORIGIN_CONNECTION_LIMIT = 60;
export const PARTY_REGISTRY_HYPERDRIVE_ORIGIN_CONNECTION_LIMIT = 10;
export const GATEWAY_ISSUER_HYPERDRIVE_ORIGIN_CONNECTION_LIMIT = 5;
export const HYPERDRIVE_RUNTIME_ROLE = SHARED_RUNTIME_IDENTITY.role;

/** Every stage Hyperdrive config. Caching is disabled on each: reads are tenant-scoped. */
export const STAGE_HYPERDRIVES = {
  gatewayIssuer: {
    idVariable: GATEWAY_ISSUER_HYPERDRIVE_ID_VARIABLE,
    name: GATEWAY_ISSUER_STAGE_HYPERDRIVE_NAME,
    originConnectionLimit: GATEWAY_ISSUER_HYPERDRIVE_ORIGIN_CONNECTION_LIMIT,
    role: SHELL_GATEWAY_ISSUER_IDENTITY.role,
    secretReference: migratorSecretReference('SHELL_GATEWAY_ISSUER_DB_PASSWORD'),
  },
  partyRegistry: {
    idVariable: PARTY_REGISTRY_HYPERDRIVE_ID_VARIABLE,
    name: PARTY_REGISTRY_STAGE_HYPERDRIVE_NAME,
    originConnectionLimit: PARTY_REGISTRY_HYPERDRIVE_ORIGIN_CONNECTION_LIMIT,
    role: PARTY_REGISTRY_REQUEST_IDENTITY.role,
    secretReference: migratorSecretReference('PARTY_REGISTRY_DB_PASSWORD'),
  },
  runtime: {
    idVariable: HYPERDRIVE_ID_VARIABLE,
    name: STAGE_HYPERDRIVE_NAME,
    originConnectionLimit: HYPERDRIVE_ORIGIN_CONNECTION_LIMIT,
    role: HYPERDRIVE_RUNTIME_ROLE,
    secretReference: 'db18_password',
  },
} as const satisfies Readonly<Record<string, StageHyperdriveSpec>>;
export type StageHyperdriveKey = keyof typeof STAGE_HYPERDRIVES;
const STAGE_HYPERDRIVE_KEYS: readonly StageHyperdriveKey[] = ['runtime', 'partyRegistry', 'gatewayIssuer'];
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
  readonly spicedbHostname: string;
  readonly stageZone: string;
}

export interface CutoverSettings extends StageOrigins {
  readonly accessEmails: readonly string[];
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted;
  readonly emailSender: string;
  /**
   * Gates every stage hostname behind Access. Turn it on only once the deploy's `cloudflare:proof`
   * sends the CI service token's headers; without them every stage-edge proof fails and rolls back.
   */
  readonly enforceAccess: boolean;
  readonly projectId: string;
  readonly repository: string;
  readonly stageEdgeApiToken: Redacted.Redacted;
  readonly storefrontHostname: string;
  readonly workersDevSubdomain: string;
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
  /** Each stage Hyperdrive config's ID. */
  readonly hyperdriveIds: Readonly<Record<StageHyperdriveKey, string>>;
  readonly spicedbVpcServiceId: string;
}

/** The reviewed `buildEnvironment` for these data-plane IDs; unrelated keys (e.g. MODERN_ASSET_PREFIX) are kept. */
export const stageBuildEnvironment = (
  current: BuildEnvironment,
  units: readonly EdgeUnit[],
  origins: StageOrigins & Pick<CutoverSettings, 'emailSender' | 'storefrontHostname'>,
  ids: DataPlaneIds,
): BuildEnvironment => {
  const merged = new Map([
    ...Object.entries(current),
    [COMPOSITION_KV_ID_VARIABLE, ids.compositionKvNamespaceId],
    ...STAGE_HYPERDRIVE_KEYS.map((key): [string, string] => [
      STAGE_HYPERDRIVES[key].idVariable,
      ids.hyperdriveIds[key],
    ]),
    [MF_DEV_ORIGIN_VARIABLE, shellOrigin(origins)],
    ['ULTRAMODERN_EMAIL_SENDER', origins.emailSender],
    ['ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', `https://${origins.storefrontHostname}`],
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
  readonly commerceCustomerContextGatewayApiKey: Redacted.Redacted;
  readonly commerceMarketCatalogGatewayApiKey: Redacted.Redacted;
  readonly crmPartyIntakeApiKey: Redacted.Redacted;
  readonly gatewayPrivateJwk: Redacted.Redacted;
  readonly gatewayPublicJwks: Redacted.Redacted;
  readonly pricingGatewayApiKey: Redacted.Redacted;
  readonly spicedbPresharedKey: Redacted.Redacted;
}

const shellSecrets = (origins: StageOrigins, sources: WorkerSecretSources) =>
  new Map([
    ['BETTER_AUTH_SECRET', sources.betterAuthSecret],
    ['BETTER_AUTH_TRUSTED_ORIGINS', Redacted.make(shellOrigin(origins))],
    ['BETTER_AUTH_URL', Redacted.make(shellOrigin(origins))],
    ['ONTOS_GATEWAY_PRIVATE_JWK', sources.gatewayPrivateJwk],
  ]);

const gatewayApiKeys = new Map<string, { readonly binding: string; readonly source: keyof WorkerSecretSources }>([
  [
    'commerce-customer-context',
    { binding: 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY', source: 'commerceCustomerContextGatewayApiKey' },
  ],
  [
    'commerce-market-catalog',
    { binding: 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY', source: 'commerceMarketCatalogGatewayApiKey' },
  ],
  ['crm', { binding: 'ONTOS_CRM_PARTY_INTAKE_API_KEY', source: 'crmPartyIntakeApiKey' }],
  ['pricing', { binding: 'ONTOS_PRICING_GATEWAY_API_KEY', source: 'pricingGatewayApiKey' }],
]);
const SHELL_GATEWAY_BASE_URL = 'ONTOS_SHELL_GATEWAY_BASE_URL';

/**
 * Full cutover provisions every outbound client. Immutable release preserves the native unavailable
 * client state in Market Catalog and Pricing; their dependent operations still fail closed.
 * Configuring either binding requires both. CRM can derive its URL from the trusted stage issuer.
 * Foundation, Shell, and the Commerce enrollment client's bindings remain mandatory.
 */
export const workerReleaseSecretNames = (
  unit: EdgeUnit,
  planned: SecretValues,
  configured: Readonly<Record<string, string>>,
): readonly string[] => {
  const plannedNames = Object.keys(planned);
  const issuer = planned.ONTOS_GATEWAY_ISSUER;
  if (
    unit.id === 'crm' &&
    !Object.hasOwn(configured, SHELL_GATEWAY_BASE_URL) &&
    issuer !== undefined &&
    configured.ONTOS_GATEWAY_ISSUER === Redacted.value(issuer)
  ) {
    return plannedNames.filter((name) => name !== SHELL_GATEWAY_BASE_URL);
  }
  if (unit.id !== 'commerce-market-catalog' && unit.id !== 'pricing') {
    return plannedNames;
  }
  const client = gatewayApiKeys.get(unit.id);
  if (
    client === undefined ||
    Object.hasOwn(configured, client.binding) ||
    Object.hasOwn(configured, SHELL_GATEWAY_BASE_URL)
  ) {
    return plannedNames;
  }
  return plannedNames.filter((name) => name !== client.binding && name !== SHELL_GATEWAY_BASE_URL);
};

const verticalSecrets = (unit: EdgeUnit, origins: StageOrigins, sources: WorkerSecretSources) => {
  const secrets = new Map([['ONTOS_GATEWAY_PUBLIC_JWKS', sources.gatewayPublicJwks]]);
  const gatewayApiKey = gatewayApiKeys.get(unit.id);
  if (gatewayApiKey !== undefined) {
    secrets.set(gatewayApiKey.binding, sources[gatewayApiKey.source]);
    secrets.set(SHELL_GATEWAY_BASE_URL, Redacted.make(`${shellOrigin(origins)}/shell-super-app-api`));
  }
  return secrets;
};

/**
 * The runtime secrets of every placed Worker (runbook A7). Workers read PostgreSQL through their
 * identities' Hyperdrive bindings, so no Worker receives a database URL.
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
        ['SPICEDB_ENDPOINT', Redacted.make(origins.spicedbHostname)],
        ['SPICEDB_PRESHARED_KEY', sources.spicedbPresharedKey],
        // The Worker build's environment never reaches the Worker's runtime bindings, so the Worker
        // names its deployment environment itself.
        [DEPLOYMENT_ENVIRONMENT_BINDING, Redacted.make('stage')],
      ]);
      const own = unit.kind === 'shell' ? shellSecrets(origins, sources) : verticalSecrets(unit, origins, sources);
      return [unit.workerName, Object.fromEntries([...common, ...own])];
    }),
  );

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

export const hyperdriveDrift = (
  hyperdrive: CloudflareHyperdrive,
  origin: HyperdriveOrigin,
  spec: StageHyperdriveSpec,
): Option.Option<string> => {
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
    limit !== spec.originConnectionLimit && `origin connection limit ${String(limit)}`,
    Option.getOrUndefined(hyperdrive.origin.service_id) !== origin.serviceId && 'another origin service',
    scheme !== 'postgresql' && `scheme ${String(scheme)}`,
    database !== origin.database && `database ${String(database)}`,
    user !== spec.role && `user ${String(user)}`,
  ]);
};

export const ensureHyperdrive = (spec: StageHyperdriveSpec, db18ServiceId: string) =>
  Effect.gen(function* ensureHyperdriveEffect() {
    const api = yield* CloudflareApi;
    const { projectId } = yield* CutoverConfiguration;
    const current = (yield* api.hyperdrives).find((hyperdrive) => hyperdrive.name === spec.name);
    const database = yield* readZeropsValue(projectId, DB18_DATABASE_NAME);
    if (current !== undefined) {
      const drift = hyperdriveDrift(current, { database: Redacted.value(database), serviceId: db18ServiceId }, spec);
      if (Option.isSome(drift)) {
        return yield* new StageOperationError({
          message: `Hyperdrive ${spec.name} (${current.id}) differs from the runbook: ${drift.value}; fix or delete it, then re-run`,
        });
      }
    }
    // Origin passwords are write-only: reapply the current secret even when non-secret settings match.
    // Both creation and updates require the tunnel and the login role to exist first.
    return yield* mutate(
      current === undefined
        ? `create Hyperdrive ${spec.name} (role ${spec.role}, caching disabled, origin connection limit ${String(spec.originConnectionLimit)})`
        : `synchronize Hyperdrive ${spec.name} (${current.id}) origin credentials`,
      Effect.gen(function* reconcileHyperdrive() {
        const configuration = {
          database,
          name: spec.name,
          originConnectionLimit: spec.originConnectionLimit,
          password: yield* readZeropsValue(projectId, spec.secretReference),
          serviceId: db18ServiceId,
          user: spec.role,
        };
        const reconciled = yield* current === undefined
          ? api.createHyperdrive(configuration)
          : api.updateHyperdrive(current.id, configuration);
        return reconciled.id;
      }),
      current?.id ?? `<${spec.name} id>`,
    );
  });

/**
 * Creates or synchronizes every stage Hyperdrive config, one after another, and returns their IDs.
 * The shared runtime config goes first, so a drifted one stops the run before any identity config is changed.
 */
export const ensureHyperdrives = (db18ServiceId: string) =>
  Effect.gen(function* ensureHyperdrivesEffect() {
    const runtime = yield* ensureHyperdrive(STAGE_HYPERDRIVES.runtime, db18ServiceId);
    const partyRegistry = yield* ensureHyperdrive(STAGE_HYPERDRIVES.partyRegistry, db18ServiceId);
    const gatewayIssuer = yield* ensureHyperdrive(STAGE_HYPERDRIVES.gatewayIssuer, db18ServiceId);
    return { gatewayIssuer, partyRegistry, runtime } satisfies Readonly<Record<StageHyperdriveKey, string>>;
  });

const ensureKvNamespace = (name: string) =>
  Effect.gen(function* ensureKvNamespaceEffect() {
    const api = yield* CloudflareApi;
    const current = (yield* api.kvNamespaces).find(({ title }) => title === name);
    if (current !== undefined) {
      yield* Console.log(`KV namespace ${name} exists: ${current.id}`);
      return current.id;
    }
    return yield* mutate(
      `create KV namespace ${name}`,
      api.createKvNamespace(name).pipe(Effect.map(({ id }) => id)),
      `<${name} id>`,
    );
  });

export const ensureCompositionKvNamespace = ensureKvNamespace(STAGE_COMPOSITION_KV_NAME);

/** The price-free catalog cache starts empty; it is never copied from the old account. */
export const ensureStorefrontCatalogKv = Effect.gen(function* ensureStorefrontCatalogKvEffect() {
  const id = yield* ensureKvNamespace(STAGE_STOREFRONT_CATALOG_KV_NAME);
  const topology = yield* readStageEdgeTopology;
  if (topology.storefrontCatalogKvId !== id) {
    const fileSystem = yield* FileSystem.FileSystem;
    // Patch the one field in the reviewed document, keeping its key order.
    const document = yield* decodeInput(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      'topology/stage-edge.json',
    )(yield* readAppText(...STAGE_EDGE_TOPOLOGY_PATH));
    const text = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), { space: 2 }),
    )({ ...document, storefrontCatalogKvId: id });
    const path = yield* appFile(...STAGE_EDGE_TOPOLOGY_PATH);
    yield* perform(
      'write storefrontCatalogKvId into topology/stage-edge.json',
      fileSystem.writeFileString(path, `${text}\n`),
    );
  }
  return id;
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

/** Zerops rejects a build file over 50 kB, so the push sends only the cloudflared setup. */
const cloudflaredZeropsYaml = Effect.gen(function* cloudflaredZeropsYamlEffect() {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* selectZeropsSetup(
    yield* fs.readFileString(yield* appFile('zerops.yaml')),
    CLOUDFLARED_SERVICE.setup,
  );
  const path = yield* fs.makeTempFileScoped({ suffix: '.zerops.yaml' });
  yield* fs.writeFileString(path, text);
  return path;
});

const pushCloudflared = (service: ZeropsService) =>
  Effect.gen(function* pushCloudflaredEffect() {
    const { projectId } = yield* CutoverConfiguration;
    yield* perform(
      `deploy the ${CLOUDFLARED_SERVICE.setup} setup to Zerops service ${service.id}`,
      Effect.scoped(
        Effect.gen(function* deployCloudflared() {
          const zeropsYamlPath = yield* cloudflaredZeropsYaml;
          return yield* runCommand({
            args: [
              'push',
              '--working-dir',
              '.',
              '--zerops-yaml-path',
              zeropsYamlPath,
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
          });
        }),
      ),
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
    if (cloudflared !== undefined) {
      let tokenReplaced = false;
      // Reconcile even when the Tunnel already exists: a prior run may have stopped after creating it.
      const existing = services.find((service) => service.id === cloudflared.id);
      if (existing !== undefined) {
        const api = yield* CloudflareApi;
        const zerops = yield* ZeropsPublicApi;
        const token = tunnel.exists ? yield* api.tunnelToken(tunnel.id) : Redacted.make('<planned tunnel token>');
        const currentToken = (yield* zerops.serviceSecrets(cloudflared.id)).get('TUNNEL_TOKEN');
        if (currentToken === undefined || Redacted.value(currentToken) !== Redacted.value(token)) {
          tokenReplaced = true;
          yield* perform(
            'replace the cloudflared TUNNEL_TOKEN with this account tunnel connector token',
            Effect.gen(function* replaceConnectorToken() {
              if (currentToken !== undefined) {
                yield* zerops.deleteServiceSecret(cloudflared.id, 'TUNNEL_TOKEN');
              }
              yield* zerops.createServiceSecret(cloudflared.id, 'TUNNEL_TOKEN', Redacted.value(token));
            }),
          );
        }
      }
      // A matching stored token may not have reached the running connector after an interrupted run.
      // Recover only a disconnected tunnel; never restart a healthy connector on a converged re-run.
      let needsDeployment = tokenReplaced || cloudflared.status === READY_TO_DEPLOY;
      if (!needsDeployment && existing !== undefined && tunnel.exists) {
        const api = yield* CloudflareApi;
        const { status } = yield* api.tunnel(tunnel.id);
        // Degraded still serves traffic; recover only a connector with no active tunnel.
        needsDeployment = status === 'down' || status === 'inactive';
      }
      if (needsDeployment) {
        yield* pushCloudflared(cloudflared);
      }
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
/** A guessed workers.dev subdomain must never be published as verified account configuration. */
export const verifyWorkersDevSubdomain = Effect.gen(function* verifyWorkersDevSubdomainEffect() {
  const { workersDevSubdomain } = yield* CutoverConfiguration;
  const api = yield* CloudflareApi;
  const actual = yield* api.workersDevSubdomain;
  if (actual !== workersDevSubdomain) {
    return yield* new StageOperationError({
      message: `account workers.dev subdomain ${actual} differs from topology/stage-edge.json workersDevSubdomain ${workersDevSubdomain}; correct the reviewed topology before provisioning`,
    });
  }
  return yield* Effect.void;
});

/** Exercise Zone Read with the actual CI token, not the broader provisioning token. */
export const verifyStageEdgeZoneAccess = Effect.gen(function* verifyStageEdgeZoneAccessEffect() {
  const { stageZone } = yield* CutoverConfiguration;
  const api = yield* CloudflareZoneApi;
  const zoneId = yield* api.findZoneId(stageZone);
  if (Option.isNone(zoneId)) {
    return yield* new StageOperationError({
      message: `the stage-edge token needs Zone Read for topology zone ${stageZone}; the hourly cost guard requires it`,
    });
  }
  return yield* Effect.void;
});

const stageEdgeVariables = (settings: CutoverSettings, namespaceId: string) =>
  [
    ['CLOUDFLARE_ACCOUNT_ID', settings.accountId],
    [
      'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL',
      `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/storage/kv/namespaces/${namespaceId}/values/active`,
    ],
  ] as const;

export const configureStageEdge = (namespaceId: string) =>
  Effect.gen(function* configureStageEdgeEffect() {
    yield* verifyWorkersDevSubdomain;
    const settings = yield* CutoverConfiguration;
    const { repository, stageEdgeApiToken } = settings;
    const environments = yield* githubApi([`repos/${repository}/environments`, '--jq', '.environments[].name']);
    if (!environments.split('\n').includes(STAGE_EDGE_ENVIRONMENT)) {
      yield* perform(
        `create the GitHub environment ${STAGE_EDGE_ENVIRONMENT} without deployment protection rules`,
        githubApi(['-X', 'PUT', `repos/${repository}/environments/${STAGE_EDGE_ENVIRONMENT}`]),
      );
    }
    const variables = yield* listGithubVariables(repository, STAGE_EDGE_ENVIRONMENT);
    if (!namespaceId) {
      return yield* new StageOperationError({
        message: `${PLACEMENT_LABEL}: ${COMPOSITION_KV_ID_VARIABLE} is empty; provision composition KV first`,
      });
    }
    for (const [name, value] of stageEdgeVariables(settings, namespaceId)) {
      if (variables.get(name) !== value) {
        yield* perform(
          `set the ${STAGE_EDGE_ENVIRONMENT} variable ${name}=${value}`,
          setGithubVariable(repository, STAGE_EDGE_ENVIRONMENT, name, value),
        );
      }
    }
    yield* perform(
      `set the ${STAGE_EDGE_ENVIRONMENT} secret CLOUDFLARE_API_TOKEN`,
      setGithubSecret(repository, STAGE_EDGE_ENVIRONMENT, 'CLOUDFLARE_API_TOKEN', stageEdgeApiToken),
    );
    return yield* Effect.void;
  });

// ---------------------------------------------------------------------------------------------
// SpiceDB TLS

const spicedbTlsTarget = Effect.gen(function* spicedbTlsTargetEffect() {
  const settings = yield* CutoverConfiguration;
  return { gatewayHostname: settings.spicedbHostname, projectId: settings.projectId };
});

/** Creates the SpiceDB gRPC and HTTP gateway TLS secrets on the Zerops `spicedb` service when they are missing. */
export const ensureStageSpicedbTls = spicedbTlsTarget.pipe(Effect.flatMap(ensureSpicedbTls));

// Database identities

/** Creates the missing identity passwords on `migrator`, then the login roles Hyperdrive connects as. */
export const ensureStageDatabaseIdentities = Effect.gen(function* ensureStageDatabaseIdentitiesEffect() {
  const { projectId } = yield* CutoverConfiguration;
  yield* ensureDatabaseIdentities(projectId);
});

// Cost guards

/** The cost guards cover the Shell and every placed vertical's public hostname. */
const costGuardPlan = Effect.gen(function* costGuardPlanEffect() {
  const settings = yield* CutoverConfiguration;
  const units = yield* readEdgeUnits;
  const plan: CostGuardPlan = {
    accessEmails: settings.accessEmails,
    enforceAccess: settings.enforceAccess,
    hostnames: [...units.map((unit) => new URL(publicOrigin(unit, settings)).hostname), settings.storefrontHostname],
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
  yield* verifyWorkersDevSubdomain;
  yield* verifyStageEdgeZoneAccess;
  yield* ensureStageSpicedbTls;
  const tunnel = yield* ensureTunnel;
  yield* ensureZeropsDataLayer(tunnel);
  yield* awaitTunnelHealthy(tunnel.id);
  const vpc = yield* ensureVpcServices(tunnel.id);
  yield* ensureStageDatabaseIdentities;
  const hyperdriveIds = yield* ensureHyperdrives(vpc.db18);
  const compositionKvNamespaceId = yield* ensureCompositionKvNamespace;
  yield* writeBuildEnvironment({ compositionKvNamespaceId, hyperdriveIds, spicedbVpcServiceId: vpc.spicedb });
  yield* ensureStorefrontCatalogKv;
  yield* configureStageEdge(compositionKvNamespaceId);
  yield* provisionCostGuards;
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
      `deployment ${String(deployment.id)} deployed ${deployment.sha}, not the checked-out revision ${revision}; check out the deployed revision or wait for this revision's stage-edge deployment`,
    );
  }
  // `provision` rewrites the placement in the working tree; the deployed Workers bind only the committed IDs.
  const placementChanges = (yield* runCommand({
    args: ['status', '--porcelain', '--', `app/${PLACEMENT_LABEL}`, `app/${STAGE_EDGE_TOPOLOGY_PATH.join('/')}`],
    command: 'git',
    cwd,
  })).trim();
  return placementChanges === ''
    ? Option.none<string>()
    : Option.some(
        `${PLACEMENT_LABEL} or topology/stage-edge.json has uncommitted changes that deployment ${String(deployment.id)} did not deploy; commit the reviewed topology and placement, then verify the deployed revision`,
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

const verifyReviewedTopology = (
  namespaces: readonly CloudflareKvNamespace[],
  buildEnvironment: BuildEnvironment,
  compositionKvId: string,
) =>
  Effect.gen(function* verifyReviewedTopologyEffect() {
    const topology = yield* readStageEdgeTopology;
    const storefrontKv = namespaces.find(({ title }) => title === STAGE_STOREFRONT_CATALOG_KV_NAME);
    yield* check(
      `KV namespace ${STAGE_STOREFRONT_CATALOG_KV_NAME} matches topology/stage-edge.json storefrontCatalogKvId`,
      storefrontKv !== undefined &&
        topology.storefrontCatalogKvId !== '' &&
        topology.storefrontCatalogKvId === storefrontKv.id
        ? Option.none()
        : Option.some(
            'the namespace is missing or its reviewed ID is empty or stale; run provision and commit topology/stage-edge.json',
          ),
    );
    const settings = yield* CutoverConfiguration;
    const expected = stageBuildEnvironment(buildEnvironment, yield* readEdgeUnits, settings, {
      compositionKvNamespaceId: compositionKvId,
      hyperdriveIds: {
        gatewayIssuer: buildEnvironment[GATEWAY_ISSUER_HYPERDRIVE_ID_VARIABLE] ?? '',
        partyRegistry: buildEnvironment[PARTY_REGISTRY_HYPERDRIVE_ID_VARIABLE] ?? '',
        runtime: buildEnvironment[HYPERDRIVE_ID_VARIABLE] ?? '',
      },
      spicedbVpcServiceId: buildEnvironment[SPICEDB_VPC_SERVICE_ID_VARIABLE] ?? '',
    });
    yield* check(
      `the ${PLACEMENT_LABEL} buildEnvironment matches topology URLs and email sender`,
      differences(
        Object.entries(expected).map(([name, value]) => buildEnvironment[name] !== value && `${name} is stale`),
      ),
    );
    const variables = yield* listGithubVariables(settings.repository, STAGE_EDGE_ENVIRONMENT);
    yield* check(
      'the stage-edge variables match the reviewed account, workers.dev subdomain and composition KV URL',
      differences(
        stageEdgeVariables(settings, compositionKvId).map(
          ([name, value]) => variables.get(name) !== value && `${name} is stale`,
        ),
      ),
    );
    return yield* Effect.void;
  });

/**
 * The cut-over verification checklist. It fails on the first unmet item, before anything changes.
 * Only when every item holds does `activate` switch `stage` to DEPLOY_TARGET=cloudflare and OUTBOX_WORKER_MODE=host.
 */
export const verifyCutover = Effect.gen(function* verifyCutoverEffect() {
  yield* verifyWorkersDevSubdomain;
  yield* verifyStageEdgeZoneAccess;
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
  yield* check(
    `the Zerops ${MIGRATOR_SERVICE_HOSTNAME} service holds every database identity password`,
    yield* databaseIdentitySecretsState(projectId),
  );
  const hyperdrives = yield* api.hyperdrives;
  const database = Redacted.value(yield* readZeropsValue(projectId, DB18_DATABASE_NAME));
  const hyperdriveIds = new Map<string, string | undefined>();
  for (const key of STAGE_HYPERDRIVE_KEYS) {
    const spec = STAGE_HYPERDRIVES[key];
    const hyperdrive = hyperdrives.find(({ name }) => name === spec.name);
    yield* check(
      `Hyperdrive ${spec.name} uses ${spec.role} through the db18 service, caching off, limit ${String(spec.originConnectionLimit)}`,
      hyperdrive === undefined
        ? Option.some(NOT_FOUND)
        : hyperdriveDrift(hyperdrive, { database, serviceId: vpcIds.get(STAGE_VPC_SERVICES.db18.name) ?? '' }, spec),
    );
    hyperdriveIds.set(spec.idVariable, hyperdrive?.id);
  }
  const namespaces = yield* api.kvNamespaces;
  const compositionKv = namespaces.find(({ title }) => title === STAGE_COMPOSITION_KV_NAME);
  yield* check(
    `KV namespace ${STAGE_COMPOSITION_KV_NAME} exists`,
    Option.fromNullishOr(compositionKv).pipe(
      Option.match({ onNone: () => Option.some(NOT_FOUND), onSome: () => Option.none() }),
    ),
  );
  const placement = yield* decodeInput(PlacementSchema, PLACEMENT_LABEL)(yield* readAppText(...PLACEMENT_PATH));
  yield* check(
    `the ${PLACEMENT_LABEL} buildEnvironment names these data-plane IDs`,
    [...hyperdriveIds].every(([variable, id]) => placement.buildEnvironment[variable] === id) &&
      placement.buildEnvironment[COMPOSITION_KV_ID_VARIABLE] === compositionKv?.id &&
      placement.buildEnvironment[SPICEDB_VPC_SERVICE_ID_VARIABLE] === vpcIds.get(STAGE_VPC_SERVICES.spicedb.name)
      ? Option.none()
      : Option.some(
          'run provision, then commit the reviewed topology and placement, then verify the deployed revision',
        ),
  );
  yield* verifyReviewedTopology(namespaces, placement.buildEnvironment, compositionKv?.id ?? '');
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

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u;

export const loadCutoverSettings = Effect.gen(function* loadCutoverSettingsEffect() {
  const apiToken = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
  const topology = yield* readStageEdgeTopology;
  const configuredAccount = yield* Config.String('CLOUDFLARE_ACCOUNT_ID').pipe(Config.option);
  if (Option.isSome(configuredAccount) && configuredAccount.value !== topology.accountId) {
    return yield* new StageOperationError({
      message: 'CLOUDFLARE_ACCOUNT_ID differs from topology/stage-edge.json accountId; nothing was changed',
    });
  }
  const settings: CutoverSettings = {
    accessEmails: (yield* Config.String('STAGE_ACCESS_EMAILS'))
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email !== ''),
    accountId: topology.accountId,
    apiToken,
    emailSender: topology.emailSender,
    enforceAccess: yield* Config.Boolean('STAGE_ACCESS_ENFORCE').pipe(Config.withDefault(false)),
    projectId: STAGE_ZEROPS_PROJECT_ID,
    repository: ONTOS_REPOSITORY,
    shellHostname: topology.shellHostname,
    spicedbHostname: topology.spicedbHostname,
    stageEdgeApiToken: yield* Config.Redacted('CLOUDFLARE_STAGE_EDGE_API_TOKEN').pipe(Config.withDefault(apiToken)),
    stageZone: topology.zone,
    storefrontHostname: topology.storefrontHostname,
    workersDevSubdomain: topology.workersDevSubdomain,
  };
  if (settings.accessEmails.length === 0 || !settings.accessEmails.every((email) => EMAIL_PATTERN.test(email))) {
    return yield* new StageOperationError({ message: 'STAGE_ACCESS_EMAILS must list at least one email address' });
  }
  return settings;
});

/** A named settings file is mandatory; no personal-account credential path is inferred. */
const settingsFileProvider = (envFile: string) => ConfigProvider.fromDotEnv({ path: envFile });

const cutoverLayer = ({ dryRun, envFile }: { readonly dryRun: boolean; readonly envFile: string }) => {
  const configuration = Layer.effect(
    CutoverConfiguration,
    loadCutoverSettings.pipe(
      Effect.catchTag('ConfigError', (cause) =>
        Effect.fail(
          new StageOperationError({
            cause,
            message: `a Cloudflare setting is missing or invalid (${cause.message}); set it in the environment or in ${envFile}. Nothing was changed`,
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
  const stageEdgeCredentials = Layer.effect(
    CloudflareCredentials,
    Effect.gen(function* stageEdgeCredentialsEffect() {
      const { accountId, stageEdgeApiToken } = yield* CutoverConfiguration;
      return { accountId, apiToken: stageEdgeApiToken };
    }),
  );
  // The settings file stays in the steps' context: the Zerops API reads ZEROPS_TOKEN per request.
  return Layer.mergeAll(
    CloudflareApiLive.pipe(Layer.provide(credentials)),
    CloudflareZoneApiLive.pipe(Layer.provide(stageEdgeCredentials)),
    ZeropsPublicApiLive,
    DatabaseLoginRolesLive,
    Reactivity.layer,
    Layer.succeed(OpsMode, { dryRun }),
  ).pipe(
    Layer.provideMerge(configuration),
    Layer.provideMerge(ConfigProvider.layerAdd(settingsFileProvider(envFile), { asPrimary: true })),
  );
};

export const stepCommand = <A, E, R>(name: string, description: string, step: Effect.Effect<A, E, R>) =>
  Command.make(
    name,
    {
      dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
      envFile: Flag.String('env-file'),
    },
    () => Effect.asVoid(step),
  ).pipe(Command.withDescription(description), Command.provide(cutoverLayer));

const cli = Command.make('cloudflare-stage-cutover').pipe(
  Command.withSubcommands([
    Command.make(
      'seed-composition',
      {
        dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
        envFile: Flag.String('env-file'),
        oldEnvFile: Flag.String('old-env-file'),
      },
      ({ dryRun, envFile, oldEnvFile }) => seedComposition({ dryRun, envFile, oldEnvFile }),
    ),
    stepCommand(
      'provision',
      'Bootstrap stage TLS, Tunnel, Zerops connector, VPC, database identities, Hyperdrive, KV, reviewed topology, GitHub and cost guards',
      provision,
    ),
    stepCommand(
      'database-identities',
      'Create the missing database identity passwords as migrator service secrets, then the login roles with LOGIN and CONNECT only (needs DATABASE_ADMIN_URL)',
      ensureStageDatabaseIdentities,
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
