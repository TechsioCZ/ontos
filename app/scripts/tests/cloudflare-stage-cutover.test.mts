import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';

import { Array as Arr, Config, ConfigProvider, Console, Effect, Layer, Option, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Command } from 'effect/cli';
import { expect, it, rs } from 'effect-rstest';

import { CloudflareApiError } from '../ops/cloudflare-api-error.mts';
import {
  CloudflareApi,
  CloudflareApiLive,
  CloudflareCredentials,
  CloudflareZoneApiLive,
} from '../ops/cloudflare-api.mts';
import type { CloudflareVpcService } from '../ops/cloudflare-api.mts';
import {
  CutoverConfiguration,
  STAGE_HYPERDRIVES,
  STAGE_TUNNEL_NAME,
  ensureHyperdrives,
  ensureTunnel,
  ensureZeropsDataLayer,
  loadCutoverSettings,
  stepCommand,
  verifyStageEdgeZoneAccess,
  ensureStorefrontCatalogKv,
  ensureStageDatabaseIdentities,
  activate,
  provision,
  publicOrigin,
  STAGE_VPC_SERVICES,
  stageBuildEnvironment,
  verifyCutover,
  vpcServiceDrift,
  workerReleaseSecretNames,
  workerSecretPlan,
} from '../ops/cloudflare-stage-cutover.mts';
import type { CutoverSettings } from '../ops/cloudflare-stage-cutover.mts';
import { StageEdgeTopologySchema } from '../ops/stage-edge-topology.mts';
import { DatabaseLoginRoles } from '../ops/database-identities.mts';
import { DATABASE_IDENTITY_SECRETS, migratorSecretReference } from '../ops/database-identity-secrets.mts';
import { SPICEDB_GRPC_TLS, SPICEDB_HTTP_TLS, spicedbTlsState } from '../ops/spicedb-tls.mts';
import {
  ciPolicy,
  killSwitchRule,
  machineEndpointsRule,
  peoplePolicy,
  usageAlert,
} from '../ops/cloudflare-stage-cost-guard.mts';
import {
  GATEWAY_ISSUER_HYPERDRIVE_ID_VARIABLE,
  HYPERDRIVE_ID_VARIABLE,
  PARTY_REGISTRY_HYPERDRIVE_ID_VARIABLE,
  edgeUnits,
  placementGaps,
} from '../ops/stage-edge-units.mts';
import { OpsMode, STAGE_ZEROPS_PROJECT_ID, readZeropsValue } from '../ops/stage-operations.mts';
import {
  APP_DIRECTORY,
  FAKE_REVISION,
  fakeCloudflareAccount,
  fakeFiles as fixtureFiles,
  fakeStage,
  fakeZeropsApi,
  mutatingCommands,
  spicedbTlsSecrets,
} from './stage-operations-fixture.mts';
import type { FakeCloudflareAccount, FakeFiles, FakeStage, FakeZeropsApi } from './stage-operations-fixture.mts';

const SHELL_ORIGIN = 'https://app.stage.example.com';
const SHELL_GATEWAY_BASE = `${SHELL_ORIGIN}/shell-super-app-api`;
const CI_TOKEN = 'ci-token-secret';
const TUNNEL_TOKEN = 'tunnel-connector-token';
const EXISTING_CONNECTOR_ID = 'existing-connector';
const EXISTING_HOST_ID = 'existing-host';
const SERVICE_IMPORT = 'service-import';
const DATABASE_CREDENTIAL = 'db-password-secret';
const AUTH_SECRET = 'better-auth-secret';
const PRIVATE_JWK = JSON.stringify({
  alg: 'EdDSA',
  crv: 'Ed25519',
  d: 'private-jwk-secret',
  key_ops: ['sign'],
  kid: 'gateway-1',
  kty: 'OKP',
  use: 'sig',
  x: 'public-x',
});
const SPICEDB_KEY = 'spicedb-key-secret';
const CUSTOMER_CONTEXT_GATEWAY_API_KEY = 'customer-context-gateway-key-secret';
const CRM_PARTY_INTAKE_API_KEY = 'crm-party-intake-key-secret';
const MARKET_GATEWAY_API_KEY = 'market-gateway-key-secret';
const PRICING_GATEWAY_API_KEY = 'pricing-gateway-key-secret';
// The public half of PRIVATE_JWK, which every vertical verifies Shell gateway tokens with.
const PUBLIC_JWKS = JSON.stringify({
  keys: [
    { alg: 'EdDSA', crv: 'Ed25519', key_ops: ['verify'], kid: 'gateway-1', kty: 'OKP', use: 'sig', x: 'public-x' },
  ],
});
const COMPOSITION_KV = 'ontos-stage-active-application-composition';
const COMPOSITION_KV_ID = 'kv-1';
const STOREFRONT_KV_ID = 'kv-storefront';
const STOREFRONT_KV = 'ontos-stage-akros-storefront-catalog';
const TUNNEL_PATH = '/cfd_tunnel';
const CUSTOMER_CONTEXT_WORKER = 'app-commerce-customer-context';
const CRM_WORKER = 'app-crm';
const MARKET_WORKER = 'app-commerce-market-catalog';
const PRICING_WORKER = 'app-pricing';
const DEPLOYMENT_ENVIRONMENT = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';
const PLACEMENT_FILE = 'topology/cloudflare-placement.json';
const TOPOLOGY_FILE = 'topology/reference-topology.json';
const expectedUnitCount =
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ verticals: Schema.Array(Schema.Unknown) })))(
    readFileSync(`${APP_DIRECTORY}/${TOPOLOGY_FILE}`, 'utf-8'),
  ).verticals.length + 1;
const RUNTIME_HYPERDRIVE = 'ontos-stage-runtime';
const PARTY_REGISTRY_HYPERDRIVE = 'ontos-stage-party-registry';
const GATEWAY_ISSUER_HYPERDRIVE = 'ontos-stage-gateway-issuer';
const HYPERDRIVE_ID = 'hyperdrive-1';
const PARTY_REGISTRY_HYPERDRIVE_ID = 'hyperdrive-2';
const GATEWAY_ISSUER_HYPERDRIVE_ID = 'hyperdrive-3';
const HYPERDRIVE_CONFIGS_PATH = '/hyperdrive/configs';
const OLD_HYPERDRIVE_ID = 'hyperdrive-old';
const MIGRATOR_ID = 'migrator-id';
/** The identity passwords a provisioned stage's migrator service holds, keyed by their `migrator_<KEY>` name. */
const PARTY_REGISTRY_CREDENTIAL = 'party-registry-credential-secret';
const PARTY_REGISTRY_WORKER_CREDENTIAL = 'party-registry-worker-credential-secret';
const GATEWAY_ISSUER_CREDENTIAL = 'gateway-issuer-credential-secret';
const IDENTITY_PASSWORDS = {
  migrator_PARTY_REGISTRY_DB_PASSWORD: PARTY_REGISTRY_CREDENTIAL,
  migrator_PARTY_REGISTRY_WORKER_DB_PASSWORD: PARTY_REGISTRY_WORKER_CREDENTIAL,
  migrator_SHELL_GATEWAY_ISSUER_DB_PASSWORD: GATEWAY_ISSUER_CREDENTIAL,
};
const STAGE_EDGE = 'stage-edge';

const settings: CutoverSettings = {
  accessEmails: ['ops@example.com'],
  accountId: 'account-1',
  apiToken: Redacted.make('lead-token-secret'),
  emailSender: 'noreply@app.stage.example.com',
  enforceAccess: false,
  projectId: STAGE_ZEROPS_PROJECT_ID,
  repository: 'TechsioCZ/ontos',
  shellHostname: 'app.stage.example.com',
  spicedbHostname: 'ontos-stage-spicedb.stage.example.com',
  stageEdgeApiToken: Redacted.make(CI_TOKEN),
  stageZone: 'stage.example.com',
  storefrontHostname: 'ontos-stage-akros.stage.example.com',
  workersDevSubdomain: 'stage-example',
};

const fakeFiles = (overrides: Readonly<Record<string, string>> = {}) =>
  fixtureFiles({
    'topology/stage-edge.json': JSON.stringify({
      accountId: settings.accountId,
      emailSender: settings.emailSender,
      shellHostname: settings.shellHostname,
      spicedbHostname: settings.spicedbHostname,
      storefrontCatalogKvId: '',
      storefrontHostname: settings.storefrontHostname,
      workersDevSubdomain: settings.workersDevSubdomain,
      zone: settings.stageZone,
    }),
    ...overrides,
  });

const VERTICAL_HOSTS = [
  'assortment',
  'partyregistry',
  'commercecustomercontext',
  'paymenttermcatalog',
  'commercemarketcatalog',
  'catalog',
  'pricing',
  'storefrontregistry',
  'pricegroupcatalog',
  'inventory',
  'tax',
  'privacy',
  'projects',
];

const SECRET_VALUES = {
  db18_dbName: 'ontos',
  db18_password: DATABASE_CREDENTIAL,
  spicedb_SPICEDB_GRPC_PRESHARED_KEY: SPICEDB_KEY,
  ...Object.fromEntries(VERTICAL_HOSTS.map((host) => [`${host}_ONTOS_GATEWAY_PUBLIC_JWKS`, PUBLIC_JWKS])),
};

const SPICEDB_VPC_HOST = 'spicedb.zerops';

const SENSITIVE_KEYS = ['db18_password', 'spicedb_SPICEDB_GRPC_PRESHARED_KEY'];

/** The Shell's secrets, which the settings file holds since the Zerops Shell retired. */
const SHELL_SETTINGS = {
  ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: CUSTOMER_CONTEXT_GATEWAY_API_KEY,
  ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: MARKET_GATEWAY_API_KEY,
  ONTOS_CRM_PARTY_INTAKE_API_KEY: CRM_PARTY_INTAKE_API_KEY,
  ONTOS_PRICING_GATEWAY_API_KEY: PRICING_GATEWAY_API_KEY,
  shellsuperapp_BETTER_AUTH_SECRET: AUTH_SECRET,
  shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK: PRIVATE_JWK,
};

const SECRETS = [
  'lead-token-secret',
  CI_TOKEN,
  DATABASE_CREDENTIAL,
  AUTH_SECRET,
  'private-jwk-secret',
  SPICEDB_KEY,
  CUSTOMER_CONTEXT_GATEWAY_API_KEY,
  CRM_PARTY_INTAKE_API_KEY,
  MARKET_GATEWAY_API_KEY,
  PRICING_GATEWAY_API_KEY,
  TUNNEL_TOKEN,
  'service-token-secret',
  ...Object.values(IDENTITY_PASSWORDS),
];

const GATEWAY_HOSTNAME = 'ontos-stage-spicedb.stage.example.com';
/** Generated once: the TLS secrets `spicedb-tls` leaves on a provisioned stage. */
const SPICEDB_TLS = spicedbTlsSecrets({ gatewayHostname: GATEWAY_HOSTNAME });

const PLACEMENT = `${APP_DIRECTORY}/topology/cloudflare-placement.json`;
const ACCOUNT_PATH = '/client/v4/accounts/account-1';
const DATA_PLANE_PATH = /^\/(?:cfd_tunnel|connectivity|hyperdrive|storage)/u;
const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const PlacementJson = Schema.fromJsonString(
  Schema.Struct({ buildEnvironment: Schema.Record(Schema.String, Schema.String), units: Schema.Array(Schema.String) }),
);

/** stage-edge as the cost guards leave it: the zone ID and the Access service token credentials. */
const GUARDED_STAGE_EDGE = {
  secrets: { [STAGE_EDGE]: ['CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET'] },
  variables: {
    [STAGE_EDGE]: {
      CLOUDFLARE_ACCOUNT_ID: settings.accountId,
      CLOUDFLARE_STAGE_ZONE_ID: 'zone-1',
      CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: settings.workersDevSubdomain,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/storage/kv/namespaces/${COMPOSITION_KV_ID}/values/active`,
    },
  },
};

/**
 * A stage whose spicedb service already holds its TLS secrets, unless `spicedbTls` is false, and whose
 * migrator service holds the database identity passwords, unless `databaseIdentities` is false.
 */
const newStage = (
  overrides: Parameters<typeof fakeStage>[0] = {},
  { databaseIdentities = true, spicedbTls = true } = {},
) => {
  const tls = spicedbTls ? SPICEDB_TLS : {};
  const identities = databaseIdentities ? IDENTITY_PASSWORDS : {};
  return fakeStage({
    projectUserKeys: [...Object.keys(tls), ...Object.keys(identities)],
    // zcli prints these as REDACTED, so the kit must read them through the Zerops API.
    sensitiveKeys: [...Object.keys(tls), ...Object.keys(identities), ...SENSITIVE_KEYS],
    services: [
      { hostname: 'db18', id: 'db18-id', status: 'ACTIVE' },
      { hostname: 'migrator', id: MIGRATOR_ID, status: 'ACTIVE' },
      { hostname: 'spicedb', id: 'spicedb-id', status: 'ACTIVE' },
      ...VERTICAL_HOSTS.map((hostname) => ({ hostname, id: `${hostname}-id`, status: 'ACTIVE' })),
    ],
    ...overrides,
    projectValues: { ...SECRET_VALUES, ...tls, ...identities, ...overrides.projectValues },
    secrets: { ...GUARDED_STAGE_EDGE.secrets, ...overrides.secrets },
    variables: { ...GUARDED_STAGE_EDGE.variables, ...overrides.variables },
  });
};

interface FakeLoginRoles {
  /** Each ensured login role with its revealed password, in call order. */
  readonly calls: { readonly password: string; readonly role: string }[];
  readonly layer: Layer.Layer<DatabaseLoginRoles>;
}

/** Records the login roles `database-identities` would create through DATABASE_ADMIN_URL. */
const fakeLoginRoles = (): FakeLoginRoles => {
  const calls: { readonly password: string; readonly role: string }[] = [];
  return {
    calls,
    layer: Layer.succeed(
      DatabaseLoginRoles,
      DatabaseLoginRoles.of({
        ensure: ({ password, role }) =>
          Effect.sync(() => {
            calls.push({ password: Redacted.value(password), role });
          }),
      }),
    ),
  };
};

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fakes: {
    readonly account: FakeCloudflareAccount;
    readonly dryRun?: boolean;
    readonly files: FakeFiles;
    readonly roles?: FakeLoginRoles;
    readonly settingsFile?: Readonly<Record<string, string>>;
    readonly stage: FakeStage;
    readonly zerops?: FakeZeropsApi;
  },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudflareApiLive.pipe(
          Layer.provide(
            Layer.succeed(CloudflareCredentials, { accountId: settings.accountId, apiToken: settings.apiToken }),
          ),
          Layer.provide(fakes.account.layer),
        ),
        CloudflareZoneApiLive.pipe(
          Layer.provide(
            Layer.succeed(CloudflareCredentials, {
              accountId: settings.accountId,
              apiToken: settings.stageEdgeApiToken,
            }),
          ),
          Layer.provide(fakes.account.layer),
        ),
        Layer.succeed(CutoverConfiguration, settings),
        Layer.succeed(OpsMode, { dryRun: fakes.dryRun ?? false }),
        fakes.stage.layer,
        fakes.account.layer,
        (fakes.zerops ?? fakeZeropsApi(fakes.stage)).layer,
        fakes.files.layer,
        (fakes.roles ?? fakeLoginRoles()).layer,
        Reactivity.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(fakes.settingsFile ?? SHELL_SETTINGS)),
      ),
    ),
  );

/** No secret value may reach a command line, a log-rendered argument or a Cloudflare URL. */
const expectNoSecretInArguments = (stage: FakeStage, account: FakeCloudflareAccount) => {
  const visible = [
    ...stage.commands.map(({ args, command }) => [command, ...args].join(' ')),
    ...account.requests.map(({ url }) => url.href),
  ].join('\n');
  for (const secret of SECRETS) {
    expect(visible).not.toContain(secret);
  }
};

it.effect('provisions the whole stage data plane on an empty account, without exposing a secret', () =>
  Effect.gen(function* provisionsEmptyAccount() {
    const account = fakeCloudflareAccount({});
    const stage = newStage({}, { databaseIdentities: false });
    const files = fakeFiles();
    const roles = fakeLoginRoles();
    const zerops = fakeZeropsApi(stage);

    yield* run(provision, { account, files, roles, stage, zerops });

    // database-identities generated one password per identity on migrator and created each login role with it.
    expect(zerops.serviceSecrets.map(({ key, serviceId }) => `${serviceId} ${key}`)).toStrictEqual([
      `${MIGRATOR_ID} PARTY_REGISTRY_DB_PASSWORD`,
      `${MIGRATOR_ID} PARTY_REGISTRY_WORKER_DB_PASSWORD`,
      `${MIGRATOR_ID} SHELL_GATEWAY_ISSUER_DB_PASSWORD`,
    ]);
    const generated = new Map(zerops.serviceSecrets.map(({ content, key }) => [key, content]));
    for (const password of generated.values()) {
      expect(password).toMatch(/^[\w-]{64}$/u);
    }
    expect(new Set(generated.values()).size).toBe(3);
    expect(roles.calls).toStrictEqual([
      { password: generated.get('PARTY_REGISTRY_DB_PASSWORD'), role: 'party_registry_runtime' },
      { password: generated.get('PARTY_REGISTRY_WORKER_DB_PASSWORD'), role: 'party_registry_worker' },
      { password: generated.get('SHELL_GATEWAY_ISSUER_DB_PASSWORD'), role: 'shell_gateway_issuer' },
    ]);

    // The cost guards have their own tests; these are the data-plane objects.
    const posts = account.requests.filter(
      ({ method, url }) => method === 'POST' && DATA_PLANE_PATH.test(url.pathname.replace(ACCOUNT_PATH, '')),
    );
    expect(
      posts.map(({ body, url }) => [url.pathname.replace(ACCOUNT_PATH, ''), Option.getOrNull(body)]),
    ).toStrictEqual([
      [TUNNEL_PATH, { config_src: 'cloudflare', name: STAGE_TUNNEL_NAME }],
      [
        '/connectivity/directory/services',
        {
          app_protocol: 'postgresql',
          host: { hostname: 'db18.zerops', resolver_network: { tunnel_id: 'tunnel-1' } },
          name: 'ontos-stage-db18',
          tcp_port: 5432,
          tls_settings: { cert_verification_mode: 'disabled' },
          type: 'tcp',
        },
      ],
      [
        '/connectivity/directory/services',
        {
          host: { hostname: SPICEDB_VPC_HOST, resolver_network: { tunnel_id: 'tunnel-1' } },
          https_port: 8443,
          name: 'ontos-stage-spicedb',
          tls_settings: { cert_verification_mode: 'verify_full' },
          type: 'http',
        },
      ],
      [
        HYPERDRIVE_CONFIGS_PATH,
        {
          caching: { disabled: true },
          name: RUNTIME_HYPERDRIVE,
          origin: {
            database: 'ontos',
            password: DATABASE_CREDENTIAL,
            scheme: 'postgresql',
            service_id: 'vpc-1',
            user: 'ontos_runtime',
          },
          origin_connection_limit: 60,
        },
      ],
      [
        HYPERDRIVE_CONFIGS_PATH,
        {
          caching: { disabled: true },
          name: PARTY_REGISTRY_HYPERDRIVE,
          origin: {
            database: 'ontos',
            password: generated.get('PARTY_REGISTRY_DB_PASSWORD'),
            scheme: 'postgresql',
            service_id: 'vpc-1',
            user: 'party_registry_runtime',
          },
          origin_connection_limit: 10,
        },
      ],
      [
        HYPERDRIVE_CONFIGS_PATH,
        {
          caching: { disabled: true },
          name: GATEWAY_ISSUER_HYPERDRIVE,
          origin: {
            database: 'ontos',
            password: generated.get('SHELL_GATEWAY_ISSUER_DB_PASSWORD'),
            scheme: 'postgresql',
            service_id: 'vpc-1',
            user: 'shell_gateway_issuer',
          },
          origin_connection_limit: 5,
        },
      ],
      ['/storage/kv/namespaces', { title: COMPOSITION_KV }],
      ['/storage/kv/namespaces', { title: STOREFRONT_KV }],
    ]);
    for (const request of account.requests) {
      expect(request.url.origin).toBe('https://api.cloudflare.com');
    }

    // cloudflared is imported with the connector token as a secret, next to the worker host, then deployed.
    const imported = stage.inputs.find(({ command }) => command.startsWith('zcli project service-import -'));
    expect(imported?.stdin).toContain('hostname: cloudflared');
    expect(imported?.stdin).toContain('TUNNEL_TOKEN: tunnel-connector-token');
    expect(imported?.stdin).toContain('maxContainers: 1');
    expect(imported?.stdin).toContain('hostname: outboxworkerhost');
    expect(stage.variables.get('stage')).toStrictEqual(
      new Map([
        ['ZEROPS_CLOUDFLARED_SERVICE_ID', 'imported-1'],
        ['ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID', 'imported-2'],
      ]),
    );
    // Like CI, the push deploys the committed revision, never the placement file A2 just edited.
    expect(stage.commands.find(({ args, command }) => command === 'zcli' && args[0] === 'push')?.args).toStrictEqual([
      'push',
      '--working-dir',
      '.',
      '--zerops-yaml-path',
      'app/zerops.yaml',
      '--workspace-state',
      'clean',
      '--project-id',
      STAGE_ZEROPS_PROJECT_ID,
      '--service-id',
      'imported-1',
      '--setup',
      'cloudflared',
    ]);

    // The reviewed build environment names the new data-plane IDs; stage-edge gets the account and the CI token.
    const placement = Schema.decodeUnknownSync(PlacementJson)(files.writes.get(PLACEMENT));
    expect(placement.buildEnvironment).toMatchObject({
      ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: COMPOSITION_KV_ID,
      ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID: GATEWAY_ISSUER_HYPERDRIVE_ID,
      ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: HYPERDRIVE_ID,
      ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID: PARTY_REGISTRY_HYPERDRIVE_ID,
      ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'vpc-2',
      ULTRAMODERN_MF_DEV_ORIGIN: SHELL_ORIGIN,
      ULTRAMODERN_PUBLIC_URL_PRICING: 'https://ontos-stage-pricing.stage.example.com',
      ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: SHELL_ORIGIN,
    });
    expect(placement.units).toHaveLength(expectedUnitCount);
    expect(stage.environments.has(STAGE_EDGE)).toBe(true);
    expect(stage.variables.get(STAGE_EDGE)?.get('CLOUDFLARE_ACCOUNT_ID')).toBe('account-1');
    expect(stage.inputs.find(({ command }) => command.startsWith('gh secret set CLOUDFLARE_API_TOKEN'))?.stdin).toBe(
      CI_TOKEN,
    );

    expect(stage.commands.filter(({ args }) => args.includes('wrangler'))).toStrictEqual([]);
    expect(stage.variables.get(STAGE_EDGE)?.get('CLOUDFLARE_WORKERS_DEV_SUBDOMAIN')).toBe(settings.workersDevSubdomain);
    expect(stage.variables.get(STAGE_EDGE)?.get('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL')).toBe(
      `https://api.cloudflare.com/client/v4/accounts/account-1/storage/kv/namespaces/${COMPOSITION_KV_ID}/values/active`,
    );
    expect(placement.buildEnvironment.ULTRAMODERN_EMAIL_SENDER).toBe(settings.emailSender);
    expect(placement.buildEnvironment.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT).toBe(
      `https://${settings.storefrontHostname}`,
    );
    expect(
      Schema.decodeUnknownSync(StageEdgeTopologySchema)(files.writes.get(`${APP_DIRECTORY}/topology/stage-edge.json`))
        .storefrontCatalogKvId,
    ).toBe('kv-2');
    expectNoSecretInArguments(stage, account);
    const visible = [
      ...stage.commands.map(({ args, command }) => [command, ...args].join(' ')),
      ...account.requests.map(({ url }) => url.href),
    ].join('\n');
    for (const password of generated.values()) {
      expect(visible).not.toContain(password);
    }
  }),
);

it('derives each Hyperdrive build variable from its database identity', () => {
  expect([
    HYPERDRIVE_ID_VARIABLE,
    PARTY_REGISTRY_HYPERDRIVE_ID_VARIABLE,
    GATEWAY_ISSUER_HYPERDRIVE_ID_VARIABLE,
  ]).toStrictEqual([
    'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
  ]);
  expect(DATABASE_IDENTITY_SECRETS.map(({ secretKey }) => migratorSecretReference(secretKey))).toStrictEqual(
    Object.keys(IDENTITY_PASSWORDS),
  );
});

it.effect('database-identities creates only the missing passwords and re-ensures every login role', () =>
  Effect.gen(function* ensuresDatabaseIdentities() {
    const stage = newStage({}, { databaseIdentities: false });
    stage.projectValues.set('migrator_PARTY_REGISTRY_DB_PASSWORD', PARTY_REGISTRY_CREDENTIAL);
    const account = fakeCloudflareAccount({});
    const files = fakeFiles();
    const roles = fakeLoginRoles();
    const zerops = fakeZeropsApi(stage);

    yield* run(ensureStageDatabaseIdentities, { account, files, roles, stage, zerops });

    expect(zerops.serviceSecrets.map(({ key, serviceId }) => `${serviceId} ${key}`)).toStrictEqual([
      `${MIGRATOR_ID} PARTY_REGISTRY_WORKER_DB_PASSWORD`,
      `${MIGRATOR_ID} SHELL_GATEWAY_ISSUER_DB_PASSWORD`,
    ]);
    const firstRun = [...roles.calls];
    expect(firstRun.map(({ role }) => role)).toStrictEqual([
      'party_registry_runtime',
      'party_registry_worker',
      'shell_gateway_issuer',
    ]);
    expect(firstRun[0]?.password).toBe(PARTY_REGISTRY_CREDENTIAL);

    // A re-run keeps every password and alters each role to the same one.
    yield* run(ensureStageDatabaseIdentities, { account, files, roles, stage, zerops });

    expect(zerops.serviceSecrets).toHaveLength(2);
    expect(roles.calls.slice(3)).toStrictEqual(firstRun);
    expect(account.requests).toStrictEqual([]);
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('database-identities creates nothing and touches no role in a dry run', () =>
  Effect.gen(function* dryRunDatabaseIdentities() {
    const stage = newStage({}, { databaseIdentities: false });
    const roles = fakeLoginRoles();
    const zerops = fakeZeropsApi(stage);

    yield* run(ensureStageDatabaseIdentities, {
      account: fakeCloudflareAccount({}),
      dryRun: true,
      files: fakeFiles(),
      roles,
      stage,
      zerops,
    });

    expect(zerops.serviceSecrets).toStrictEqual([]);
    expect(roles.calls).toStrictEqual([]);
  }),
);

it.effect('refuses to reuse an identity Hyperdrive config with the shared limit or another login', () =>
  Effect.gen(function* refusesDriftedIdentityHyperdrive() {
    const account = fakeCloudflareAccount({
      hyperdrives: [
        {
          caching: { disabled: true },
          id: OLD_HYPERDRIVE_ID,
          name: PARTY_REGISTRY_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 60,
        },
      ],
    });
    const stage = newStage();
    const files = fakeFiles();

    const error = yield* run(provision, { account, files, stage }).pipe(Effect.flip);

    expect(error.message).toContain(
      'Hyperdrive ontos-stage-party-registry (hyperdrive-old) differs from the runbook: origin connection limit 60, user ontos_runtime',
    );
    expect(files.writes.size).toBe(0);
  }),
);

it.effect('changes nothing in a dry run but still reads the real state', () =>
  Effect.gen(function* dryRunReadsOnly() {
    const account = fakeCloudflareAccount({});
    const stage = newStage({}, { databaseIdentities: false });
    const files = fakeFiles();
    const roles = fakeLoginRoles();
    const zerops = fakeZeropsApi(stage);

    yield* run(provision, { account, dryRun: true, files, roles, stage, zerops });

    expect(zerops.serviceSecrets).toStrictEqual([]);
    expect(roles.calls).toStrictEqual([]);
    expect(account.requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
    expect(files.writes.size).toBe(0);
    expect(
      stage.commands.some(({ args }) => args.join(' ') === `service list --project-id ${STAGE_ZEROPS_PROJECT_ID}`),
    ).toBe(true);
  }),
);

it.effect('creates the SpiceDB TLS secrets first on a stage without them', () =>
  Effect.gen(function* provisionsSpicedbTls() {
    const account = fakeCloudflareAccount({});
    const stage = newStage({}, { spicedbTls: false });
    const files = fakeFiles();
    const zerops = fakeZeropsApi(stage);

    yield* run(provision, { account, files, stage, zerops });

    expect(settings.spicedbHostname).toBe(GATEWAY_HOSTNAME);
    const originCertificate = account.requests.find(({ method }) => method === 'POST');
    expect(originCertificate?.url.href).toBe('https://api.cloudflare.com/client/v4/certificates');
    expect(originCertificate?.body.pipe(Option.getOrNull)).toMatchObject({
      hostnames: [GATEWAY_HOSTNAME],
      request_type: 'origin-ecc',
      requested_validity: 5475,
    });
    expect(zerops.serviceSecrets.map(({ key, serviceId }) => `${serviceId} ${key}`)).toStrictEqual([
      `spicedb-id ${SPICEDB_GRPC_TLS.privateKeyKey}`,
      `spicedb-id ${SPICEDB_GRPC_TLS.certificateKey}`,
      `spicedb-id ${SPICEDB_HTTP_TLS.privateKeyKey}`,
      `spicedb-id ${SPICEDB_HTTP_TLS.certificateKey}`,
    ]);
    const state = yield* run(spicedbTlsState({ gatewayHostname: GATEWAY_HOSTNAME, projectId: settings.projectId }), {
      account,
      files,
      stage,
    });
    expect(state).toStrictEqual(Option.none());
  }),
);

it.effect('refuses a Zerops value a read-only token sees masked', () =>
  Effect.gen(function* refusesMaskedValue() {
    const stage = newStage();
    stage.projectValues.set('db18_password', 'REDACTED');

    const error = yield* run(readZeropsValue(settings.projectId, 'db18_password'), {
      account: fakeCloudflareAccount({}),
      files: fakeFiles(),
      stage,
      zerops: fakeZeropsApi(stage),
    }).pipe(Effect.flip);

    expect(error.message).toBe('the Zerops token can only read db18_password masked; use a full-access token');
  }),
);

it.effect('creates no SpiceDB TLS material in a dry run', () =>
  Effect.gen(function* dryRunSpicedbTls() {
    const account = fakeCloudflareAccount({});
    const stage = newStage({}, { spicedbTls: false });
    const zerops = fakeZeropsApi(stage);

    yield* run(provision, { account, dryRun: true, files: fakeFiles(), stage, zerops });

    expect(stage.commands.filter(({ command }) => command === 'openssl')).toStrictEqual([]);
    expect(zerops.serviceSecrets).toStrictEqual([]);
    expect(account.requests.every(({ method }) => method === 'GET')).toBe(true);
  }),
);

it.effect('reuses every existing object on a re-run and creates nothing twice', () =>
  Effect.gen(function* rerunIsIdempotent() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const files = fakeFiles();
    yield* run(provision, { account, files, stage });
    const firstPosts = account.requests.filter(({ method }) => method === 'POST').length;
    const firstImports = stage.commands.filter(({ args }) => args.includes(SERVICE_IMPORT)).length;
    const firstVariableSets = stage.commands.filter(({ args }) => args[0] === 'variable' && args[1] === 'set').length;

    yield* run(provision, { account, files, stage });

    expect(account.requests.filter(({ method }) => method === 'POST')).toHaveLength(firstPosts);
    expect(stage.commands.filter(({ args }) => args.includes(SERVICE_IMPORT))).toHaveLength(firstImports);
    expect(stage.commands.filter(({ args }) => args[0] === 'variable' && args[1] === 'set')).toHaveLength(
      firstVariableSets,
    );
    expect(stage.commands.filter(({ args }) => args.includes('push'))).toHaveLength(1);
  }),
);

it.effect('synchronizes rotated origin passwords on existing Hyperdrives without logging them or replacing IDs', () =>
  Effect.gen(function* rotatesExistingHyperdriveCredentials() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const files = fakeFiles();
    const roles = fakeLoginRoles();
    yield* run(provision, { account, files, roles, stage });
    const firstHyperdrives = [...account.hyperdrives];
    const posts = account.requests.filter(({ method }) => method === 'POST').length;
    const messages: unknown[] = [];
    const consoleService = yield* Console.Console;
    const rotatedPasswords = new Map<string, string>();
    for (const spec of Object.values(STAGE_HYPERDRIVES)) {
      const password = `${spec.role}-rotated-password-secret`;
      stage.projectValues.set(spec.secretReference, password);
      rotatedPasswords.set(spec.role, password);
    }

    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        rs.spyOn(consoleService, 'log').mockImplementation((...args: readonly unknown[]) => {
          messages.push(...args);
        }),
      ),
      () => run(provision, { account, files, roles, stage }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const updates = account.requests.filter(
      ({ method, url }) => method === 'PUT' && url.pathname.includes(`${HYPERDRIVE_CONFIGS_PATH}/`),
    );
    expect(updates).toHaveLength(3);
    expect(account.hyperdrives).toStrictEqual(firstHyperdrives);
    expect(account.requests.filter(({ method }) => method === 'POST')).toHaveLength(posts);
    for (const { id, ...configuration } of firstHyperdrives) {
      const update = updates.find(({ url }) => url.pathname.endsWith(`/${id}`));
      expect(Option.getOrUndefined(update?.body ?? Option.none())).toStrictEqual({
        ...configuration,
        origin: { ...configuration.origin, password: rotatedPasswords.get(configuration.origin.user) },
      });
    }
    expect(roles.calls.slice(3)).toContainEqual({
      password: rotatedPasswords.get('party_registry_runtime'),
      role: 'party_registry_runtime',
    });
    expect(roles.calls.slice(3)).toContainEqual({
      password: rotatedPasswords.get('shell_gateway_issuer'),
      role: 'shell_gateway_issuer',
    });
    expectNoSecretInArguments(stage, account);
    const visible = [
      ...messages.map(String),
      ...stage.commands.map(({ args, command }) => [command, ...args].join(' ')),
      ...account.requests.map(({ url }) => url.href),
    ].join('\n');
    for (const password of [...SECRETS, ...rotatedPasswords.values()]) {
      expect(visible).not.toContain(password);
    }
    expect(messages.join('\n')).toContain('synchronize Hyperdrive');
  }),
);

it.effect('plans credential synchronization for existing Hyperdrives without sending updates in a dry run', () =>
  Effect.gen(function* dryRunHyperdriveCredentialSync() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const files = fakeFiles();
    yield* run(provision, { account, files, stage });
    const before = account.requests.length;
    const existing = [...account.hyperdrives];

    const ids = yield* run(ensureHyperdrives('vpc-1'), { account, dryRun: true, files, stage });

    expect(ids).toStrictEqual({
      gatewayIssuer: GATEWAY_ISSUER_HYPERDRIVE_ID,
      partyRegistry: PARTY_REGISTRY_HYPERDRIVE_ID,
      runtime: HYPERDRIVE_ID,
    });
    expect(account.hyperdrives).toStrictEqual(existing);
    expect(account.requests.slice(before).every(({ method }) => method === 'GET')).toBe(true);
  }),
);

it.effect('fails a Hyperdrive credential update for an unknown ID instead of creating a config', () =>
  Effect.gen(function* refusesMissingHyperdriveUpdate() {
    const account = fakeCloudflareAccount({});
    const error = yield* run(
      Effect.gen(function* updateUnknownHyperdrive() {
        const api = yield* CloudflareApi;
        return yield* api.updateHyperdrive('missing-config', {
          database: Redacted.make('ontos'),
          name: PARTY_REGISTRY_HYPERDRIVE,
          originConnectionLimit: 10,
          password: Redacted.make(PARTY_REGISTRY_CREDENTIAL),
          serviceId: 'vpc-1',
          user: 'party_registry_runtime',
        });
      }),
      { account, files: fakeFiles(), stage: newStage() },
    ).pipe(Effect.flip);

    expect(Schema.is(CloudflareApiError)(error)).toBe(true);
    expect(error.message).toContain('Hyperdrive update failed');
    expect(error.message).not.toContain(PARTY_REGISTRY_CREDENTIAL);
    expect(account.hyperdrives).toStrictEqual([]);
    expect(account.requests.map(({ method }) => method)).toStrictEqual(['PUT']);
  }),
);

it('accepts the SpiceDB VPC service only over HTTPS with full certificate verification', () => {
  const spec = { ...STAGE_VPC_SERVICES.spicedb, tunnelId: 'tunnel-1' };
  const service = (fields: {
    readonly http_port?: number;
    readonly https_port?: number;
    readonly mode?: string;
  }): CloudflareVpcService => ({
    host: {
      hostname: Option.some(SPICEDB_VPC_HOST),
      resolver_network: Option.some({ tunnel_id: 'tunnel-1' }),
    },
    http_port: Option.fromNullishOr(fields.http_port),
    https_port: Option.fromNullishOr(fields.https_port),
    name: spec.name,
    service_id: 'vpc-2',
    tcp_port: Option.none(),
    tls_settings: Option.some({ cert_verification_mode: Option.fromNullishOr(fields.mode) }),
    type: 'http',
  });

  expect(vpcServiceDrift(service({ https_port: 8443, mode: 'verify_full' }), spec)).toStrictEqual(Option.none());
  expect(vpcServiceDrift(service({ https_port: 8443 }), spec)).toStrictEqual(Option.none());
  expect(vpcServiceDrift(service({ http_port: 8443 }), spec)).toStrictEqual(
    Option.some('port undefined, plaintext port 8443'),
  );
  expect(vpcServiceDrift(service({ https_port: 8443, mode: 'disabled' }), spec)).toStrictEqual(
    Option.some('certificate verification disabled'),
  );
});

it.effect('refuses to reuse a Hyperdrive config that caches tenant reads', () =>
  Effect.gen(function* refusesCachingHyperdrive() {
    const account = fakeCloudflareAccount({
      hyperdrives: [
        {
          caching: { disabled: false },
          id: OLD_HYPERDRIVE_ID,
          name: RUNTIME_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 60,
        },
      ],
    });
    const stage = newStage();
    const files = fakeFiles();

    const error = yield* run(provision, { account, files, stage }).pipe(Effect.flip);

    expect(error.message).toContain(
      'Hyperdrive ontos-stage-runtime (hyperdrive-old) differs from the runbook: caching is enabled',
    );
    expect(
      account.requests.filter(({ url }) => url.pathname.endsWith('/hyperdrive/configs') && url.search === ''),
    ).toHaveLength(0);
    expect(files.writes.size).toBe(0);
  }),
);

it.effect('refuses to reuse a Hyperdrive config that points at another database', () =>
  Effect.gen(function* refusesOtherDatabase() {
    const account = fakeCloudflareAccount({
      hyperdrives: [
        {
          caching: { disabled: true },
          id: OLD_HYPERDRIVE_ID,
          name: RUNTIME_HYPERDRIVE,
          origin: { database: 'postgres', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 60,
        },
      ],
    });
    const stage = newStage();
    const files = fakeFiles();

    const error = yield* run(provision, { account, files, stage }).pipe(Effect.flip);

    expect(error.message).toContain('differs from the runbook: database postgres');
    expect(files.writes.size).toBe(0);
  }),
);

it.effect('provisions without any immutable release secrets or legacy Worker writes', () =>
  Effect.gen(function* provisionsWithoutWorkerSecrets() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    yield* run(provision, { account, files: fakeFiles(), settingsFile: {}, stage });
    expect(stage.commands.filter(({ args }) => args.includes('wrangler'))).toStrictEqual([]);
  }),
);

it.effect('fails before importing when zerops-import.yaml does not declare cloudflared', () =>
  Effect.gen(function* requiresDataLayerSetups() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const withoutCloudflared = readFileSync(`${APP_DIRECTORY}/zerops-import.yaml`, 'utf-8').replace(
      /^ {2}- hostname: cloudflared\n(?: {4}.*\n)*/mu,
      '',
    );
    const files = fakeFiles({ 'zerops-import.yaml': withoutCloudflared });

    const error = yield* run(provision, { account, files, stage }).pipe(Effect.flip);

    expect(error.message).toBe('app/zerops-import.yaml has no "cloudflared" service; merge its Zerops setup first');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

const readRepositoryFile = (path: string) => readFileSync(`${APP_DIRECTORY}/${path}`, 'utf-8');

/** Native runtime secret names used by immutable release preparation. */
const plannedSecretNames = Effect.gen(function* plannedSecretNamesEffect() {
  const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
  const secret = Redacted.make('value');
  const plan = workerSecretPlan(units, settings, {
    betterAuthSecret: secret,
    commerceCustomerContextGatewayApiKey: secret,
    commerceMarketCatalogGatewayApiKey: secret,
    crmPartyIntakeApiKey: secret,
    gatewayPrivateJwk: secret,
    gatewayPublicJwks: secret,
    pricingGatewayApiKey: secret,
    spicedbPresharedKey: secret,
  });
  return Object.fromEntries([...plan].map(([worker, secrets]) => [worker, Object.keys(secrets)]));
});

it.effect(
  'preserves the full cutover plan while distinguishing the catalog outbound client from release prerequisites',
  () =>
    Effect.gen(function* preservesCutoverRequirements() {
      const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
      const names = yield* plannedSecretNames;
      const catalog = units.find(({ id }) => id === 'commerce-market-catalog');
      expect(catalog).toBeDefined();
      if (catalog === undefined) {
        return;
      }
      const full = names[catalog.workerName];
      const planned = Object.fromEntries(full.map((name) => [name, Redacted.make(SHELL_ORIGIN)]));
      const key = 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY';
      const base = 'ONTOS_SHELL_GATEWAY_BASE_URL';
      expect(full).toContain(key);
      expect(full).toContain(base);
      expect(workerReleaseSecretNames(catalog, planned, {})).toEqual(
        full.filter((name) => name !== key && name !== base),
      );
      expect(workerReleaseSecretNames(catalog, planned, { [key]: 'configured' })).toEqual(full);
      expect(workerReleaseSecretNames(catalog, planned, { [base]: SHELL_GATEWAY_BASE })).toEqual(full);
      expect(workerReleaseSecretNames(catalog, planned, { [base]: SHELL_GATEWAY_BASE, [key]: 'configured' })).toEqual(
        full,
      );
      expect(names[catalog.workerName]).toEqual(full);
      for (const unit of units.filter(({ id }) => id !== 'commerce-market-catalog' && id !== 'pricing')) {
        const required = names[unit.workerName];
        const unitPlan = Object.fromEntries(required.map((name) => [name, Redacted.make(SHELL_ORIGIN)]));
        expect(workerReleaseSecretNames(unit, unitPlan, {})).toEqual(required);
        if (unit.id === 'crm') {
          expect(workerReleaseSecretNames(unit, unitPlan, { ONTOS_GATEWAY_ISSUER: SHELL_ORIGIN })).toEqual(
            required.filter((name) => name !== base),
          );
        }
      }
    }),
);

/** Every cost guard as `provision` leaves it, with the kill switch off. */
const guardedAccount = Effect.gen(function* guardedAccountEffect() {
  const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
  const hostnames = [
    ...units.map((unit) => new URL(publicOrigin(unit, settings)).hostname),
    settings.storefrontHostname,
  ];
  return {
    accessPolicies: [
      { ...peoplePolicy, id: 'policy-1' },
      { ...ciPolicy('token-1'), id: 'policy-2' },
    ],
    alertPolicies: [{ ...usageAlert(settings.accessEmails), id: 'alert-1' }],
    rulesets: [
      {
        id: 'custom',
        kind: 'zone',
        phase: 'http_request_firewall_custom',
        rules: [
          { ...killSwitchRule(hostnames, false), id: 'rule-2' },
          { ...machineEndpointsRule(settings.shellHostname), id: 'rule-3' },
        ],
      },
    ],
    serviceTokens: [{ client_id: 'access-client-id', id: 'token-1', name: 'ontos-stage-ci' }],
  };
});

/** A provisioned account, deliberately without any legacy placed Worker state. */
const provisionedAccount = (tunnelStatus: string, compositionKeys: readonly string[] = []) =>
  Effect.gen(function* provisionedAccountEffect() {
    return fakeCloudflareAccount({
      ...(yield* guardedAccount),
      hyperdrives: [
        {
          caching: { disabled: true },
          id: HYPERDRIVE_ID,
          name: RUNTIME_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 60,
        },
        {
          caching: { disabled: true },
          id: PARTY_REGISTRY_HYPERDRIVE_ID,
          name: PARTY_REGISTRY_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'party_registry_runtime' },
          origin_connection_limit: 10,
        },
        {
          caching: { disabled: true },
          id: GATEWAY_ISSUER_HYPERDRIVE_ID,
          name: GATEWAY_ISSUER_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'shell_gateway_issuer' },
          origin_connection_limit: 5,
        },
      ],
      kvKeys: { [COMPOSITION_KV_ID]: compositionKeys },
      kvNamespaces: [
        { id: COMPOSITION_KV_ID, title: COMPOSITION_KV },
        { id: STOREFRONT_KV_ID, title: STOREFRONT_KV },
      ],
      tunnels: [{ id: 'tunnel-1', name: STAGE_TUNNEL_NAME, status: tunnelStatus }],
      vpcServices: [
        {
          app_protocol: 'postgresql',
          host: { hostname: 'db18.zerops', resolver_network: { tunnel_id: 'tunnel-1' } },
          name: 'ontos-stage-db18',
          service_id: 'vpc-1',
          tcp_port: 5432,
          tls_settings: { cert_verification_mode: 'disabled' },
          type: 'tcp',
        },
        {
          host: { hostname: SPICEDB_VPC_HOST, resolver_network: { tunnel_id: 'tunnel-1' } },
          https_port: 8443,
          name: 'ontos-stage-spicedb',
          service_id: 'vpc-2',
          type: 'http',
        },
      ],
    });
  });

/** The placement as the merged A6 PR leaves it: the provisioned IDs in the reviewed build environment. */
const reviewedPlacementFiles = Effect.gen(function* reviewedPlacementFilesEffect() {
  const placementText = readRepositoryFile(PLACEMENT_FILE);
  const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), placementText);
  const buildEnvironment = stageBuildEnvironment({}, units, settings, {
    compositionKvNamespaceId: COMPOSITION_KV_ID,
    hyperdriveIds: {
      gatewayIssuer: GATEWAY_ISSUER_HYPERDRIVE_ID,
      partyRegistry: PARTY_REGISTRY_HYPERDRIVE_ID,
      runtime: HYPERDRIVE_ID,
    },
    spicedbVpcServiceId: 'vpc-2',
  });
  const placement = Schema.decodeUnknownSync(JsonRecord)(placementText);
  const files = fakeFiles();
  files.writes.set(PLACEMENT, Schema.encodeUnknownSync(JsonRecord)({ ...placement, buildEnvironment }));
  files.writes.set(
    `${APP_DIRECTORY}/topology/stage-edge.json`,
    JSON.stringify({
      accountId: settings.accountId,
      emailSender: settings.emailSender,
      shellHostname: settings.shellHostname,
      spicedbHostname: settings.spicedbHostname,
      storefrontCatalogKvId: STOREFRONT_KV_ID,
      storefrontHostname: settings.storefrontHostname,
      workersDevSubdomain: settings.workersDevSubdomain,
      zone: settings.stageZone,
    }),
  );
  return files;
});

it.effect('refuses an old shared limit of 40 without changing either dedicated Hyperdrive', () =>
  Effect.gen(function* refusesSharedConnectionLimitDrift() {
    const account = yield* provisionedAccount('healthy');
    for (const [index, hyperdrive] of account.hyperdrives.entries()) {
      if (hyperdrive.name === RUNTIME_HYPERDRIVE) {
        account.hyperdrives[index] = { ...hyperdrive, origin_connection_limit: 40 };
      }
    }
    const previous = [...account.hyperdrives];
    const error = yield* run(ensureHyperdrives('vpc-1'), {
      account,
      files: fakeFiles(),
      stage: newStage(),
    }).pipe(Effect.flip);

    expect(error.message).toContain('origin connection limit 40');
    expect(account.hyperdrives).toStrictEqual(previous);
    expect(account.requests.every(({ method }) => method === 'GET')).toBe(true);
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the migrator service lacks the identity passwords', () =>
  Effect.gen(function* refusesMissingIdentityPasswords() {
    const stage = newStage(
      { deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] },
      { databaseIdentities: false },
    );

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain(
      'the Zerops migrator service holds every database identity password: missing PARTY_REGISTRY_DB_PASSWORD, PARTY_REGISTRY_WORKER_DB_PASSWORD, SHELL_GATEWAY_ISSUER_DB_PASSWORD; run database-identities',
    );
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('switches stage to DEPLOY_TARGET=cloudflare and the host Outbox Worker mode only after verification', () =>
  Effect.gen(function* activatesAfterVerification() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });

    yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    });

    expect(stage.variables.get('stage')?.get('DEPLOY_TARGET')).toBe('cloudflare');
    // The Cloudflare stage runs every Outbox Worker in the one host provision created.
    expect(stage.variables.get('stage')?.get('OUTBOX_WORKER_MODE')).toBe('host');
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the spicedb service lacks its TLS secrets', () =>
  Effect.gen(function* refusesMissingSpicedbTls() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] }, { spicedbTls: false });

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain(
      `the Zerops spicedb service holds valid gRPC and ${GATEWAY_HOSTNAME} gateway TLS secrets: the spicedb gRPC TLS secrets SPICEDB_GRPC_TLS_CERT and SPICEDB_GRPC_TLS_KEY: they do not exist; run spicedb-tls`,
    );
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the tunnel is unhealthy', () =>
  Effect.gen(function* refusesUnhealthyTunnel() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });

    const error = yield* run(activate, {
      account: yield* provisionedAccount('degraded'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toBe('Tunnel ontos-stage is healthy: status degraded');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('leaves DEPLOY_TARGET unset until a stage-edge deployment succeeded', () =>
  Effect.gen(function* refusesFailedEdgeDeployment() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'failure' }] });

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain('succeeded for the checked-out revision: deployment 7 is failure');
    expect(stage.variables.get('stage')?.has('DEPLOY_TARGET')).not.toBe(true);
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the latest stage-edge deployment is of an older revision', () =>
  Effect.gen(function* refusesStaleEdgeDeployment() {
    const stage = newStage({ deployments: [{ id: 7, sha: 'fedcba9876543210', state: 'success' }] });

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain(
      `deployment 7 deployed fedcba9876543210, not the checked-out revision ${FAKE_REVISION}`,
    );
    expect(stage.variables.get('stage')?.has('DEPLOY_TARGET')).not.toBe(true);
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the placement has uncommitted changes', () =>
  Effect.gen(function* refusesDirtyPlacement() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });
    stage.dirtyPaths.add('app/topology/cloudflare-placement.json');

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain(
      'topology/cloudflare-placement.json or topology/stage-edge.json has uncommitted changes',
    );
    expect(stage.variables.get('stage')?.has('DEPLOY_TARGET')).not.toBe(true);
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the reviewed placement names other data-plane IDs', () =>
  Effect.gen(function* refusesUnreviewedIds() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: fakeFiles(),
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain('buildEnvironment names these data-plane IDs');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('requires the composition snapshot in the composition KV namespace once stage targets Cloudflare', () =>
  Effect.gen(function* requiresCompositionSnapshot() {
    const activated = () =>
      newStage({
        deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }],
        variables: { stage: { DEPLOY_TARGET: 'cloudflare' } },
      });

    // The first Cloudflare-target deploy has not written the snapshot yet.
    const error = yield* run(verifyCutover, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage: activated(),
    }).pipe(Effect.flip);
    expect(error.message).toContain(
      `${COMPOSITION_KV} KV namespace holds the active Application Composition: key active is missing`,
    );

    yield* run(verifyCutover, {
      account: yield* provisionedAccount('healthy', ['active']),
      files: yield* reviewedPlacementFiles,
      stage: activated(),
    });
  }),
);

it.effect('verifies immutable releases without requiring any legacy placed Worker or its secrets', () =>
  Effect.gen(function* verifiesWithoutLegacyWorkers() {
    const account = yield* provisionedAccount('healthy');
    yield* run(verifyCutover, {
      account,
      files: yield* reviewedPlacementFiles,
      stage: newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] }),
    });
    expect(account.requests.some(({ url }) => url.pathname.includes('/workers/scripts'))).toBe(false);
  }),
);

it.effect('surfaces Cloudflare API errors with their codes', () =>
  Effect.gen(function* surfacesApiErrors() {
    const account = fakeCloudflareAccount({});
    const error = yield* Effect.gen(function* readUnknownTunnel() {
      const api = yield* CloudflareApi;
      return yield* api.tunnel('missing/extra');
    }).pipe(
      Effect.provide(
        CloudflareApiLive.pipe(
          Layer.provide(Layer.succeed(CloudflareCredentials, { accountId: 'account-1', apiToken: settings.apiToken })),
          Layer.provide(account.layer),
        ),
      ),
      Effect.flip,
    );

    expect(error.message).toBe('Cloudflare Tunnel read failed: 7003 No route for that URI');
  }),
);

// A vertical merged without its placement entry and public URL would pass review and then fail the
// stage edge deploy after merge; this check runs on every pull request instead.
it.effect('fails closed on unprovisioned account IDs and accepts only the reviewed provisioned placement', () =>
  Effect.gen(function* placesEveryUnit() {
    const gaps = yield* placementGaps(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
    expect(gaps).toStrictEqual([
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID',
    ]);
    const files = yield* reviewedPlacementFiles;
    expect(yield* placementGaps(readRepositoryFile(TOPOLOGY_FILE), files.writes.get(PLACEMENT) ?? '')).toEqual([]);
  }),
);

it.effect('names the unplaced units and unset build variables of an incomplete placement', () =>
  Effect.gen(function* namesPlacementGaps() {
    const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
    // Every variable but the Hyperdrive ID and Pricing's public URL, with Catalog left unplaced.
    const buildEnvironment = Object.fromEntries(
      [
        'ULTRAMODERN_MF_DEV_ORIGIN',
        'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID',
        ...units.map(({ publicUrlEnv }) => publicUrlEnv).filter((key) => key !== 'ULTRAMODERN_PUBLIC_URL_PRICING'),
      ].map((key) => [key, 'set']),
    );
    const incomplete = JSON.stringify({
      buildEnvironment,
      units: units.map(({ id }) => id).filter((id) => id !== 'catalog'),
    });

    expect(yield* placementGaps(readRepositoryFile(TOPOLOGY_FILE), incomplete)).toStrictEqual([
      'units: catalog',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
      'buildEnvironment.ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID',
      'buildEnvironment.ULTRAMODERN_PUBLIC_URL_PRICING',
    ]);
  }),
);

it.effect('gives each caller its own redacted gateway key and the native Shell URL', () =>
  Effect.gen(function* plansWorkerSecrets() {
    const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
    const secret = Redacted.make('value');
    const plan = workerSecretPlan(units, settings, {
      betterAuthSecret: secret,
      commerceCustomerContextGatewayApiKey: Redacted.make(CUSTOMER_CONTEXT_GATEWAY_API_KEY),
      commerceMarketCatalogGatewayApiKey: Redacted.make(MARKET_GATEWAY_API_KEY),
      crmPartyIntakeApiKey: Redacted.make(CRM_PARTY_INTAKE_API_KEY),
      gatewayPrivateJwk: secret,
      gatewayPublicJwks: secret,
      pricingGatewayApiKey: Redacted.make(PRICING_GATEWAY_API_KEY),
      spicedbPresharedKey: secret,
    });
    const reveal = (worker: string) =>
      Object.fromEntries(Object.entries(plan.get(worker) ?? {}).map(([key, value]) => [key, Redacted.value(value)]));

    expect([...plan.keys()]).toHaveLength(expectedUnitCount);
    expect(reveal(CUSTOMER_CONTEXT_WORKER)).toMatchObject({
      ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: CUSTOMER_CONTEXT_GATEWAY_API_KEY,
      ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE,
    });
    expect(reveal(MARKET_WORKER)).toMatchObject({
      ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: MARKET_GATEWAY_API_KEY,
      ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE,
    });
    expect(reveal(CRM_WORKER)).toMatchObject({
      ONTOS_CRM_PARTY_INTAKE_API_KEY: CRM_PARTY_INTAKE_API_KEY,
      ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE,
    });
    expect(Arr.sort(Object.keys(reveal(PRICING_WORKER)), Order.String)).toStrictEqual([
      'ONTOS_GATEWAY_ISSUER',
      'ONTOS_GATEWAY_PUBLIC_JWKS',
      'ONTOS_PRICING_GATEWAY_API_KEY',
      'ONTOS_SHELL_GATEWAY_BASE_URL',
      'SPICEDB_ENDPOINT',
      'SPICEDB_PRESHARED_KEY',
      DEPLOYMENT_ENVIRONMENT,
    ]);
    for (const secrets of plan.values()) {
      expect(Object.keys(secrets)).not.toContain('DATABASE_URL');
      expect(Object.keys(secrets)).not.toContain('ONTOS_CATALOG_BASE_URL');
      expect(Object.keys(secrets)).not.toContain('ONTOS_PRICE_GROUP_CATALOG_BASE_URL');
      expect(Object.keys(secrets)).not.toContain('ONTOS_PRICING_BASE_URL');
      expect(Object.keys(secrets)).not.toContain('ONTOS_COMMERCE_CUSTOMER_CONTEXT_BASE_URL');
    }
    for (const [worker, variable] of [
      [CUSTOMER_CONTEXT_WORKER, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'],
      [MARKET_WORKER, 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'],
      [CRM_WORKER, 'ONTOS_CRM_PARTY_INTAKE_API_KEY'],
      [PRICING_WORKER, 'ONTOS_PRICING_GATEWAY_API_KEY'],
    ] as const) {
      expect(Object.entries(reveal(worker))).toContainEqual([variable, SHELL_SETTINGS[variable]]);
      for (const otherWorker of plan.keys()) {
        if (otherWorker !== worker) {
          expect(Object.keys(reveal(otherWorker))).not.toContain(variable);
        }
      }
    }
  }),
);

it('derives each Hyperdrive build variable from its database identity', () => {
  expect([
    HYPERDRIVE_ID_VARIABLE,
    PARTY_REGISTRY_HYPERDRIVE_ID_VARIABLE,
    GATEWAY_ISSUER_HYPERDRIVE_ID_VARIABLE,
  ]).toStrictEqual([
    'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
  ]);
  expect(DATABASE_IDENTITY_SECRETS.map(({ secretKey }) => migratorSecretReference(secretKey))).toStrictEqual(
    Object.keys(IDENTITY_PASSWORDS),
  );
});

it.effect('database-identities creates only the missing passwords and re-ensures every login role', () =>
  Effect.gen(function* ensuresDatabaseIdentities() {
    const stage = newStage({}, { databaseIdentities: false });
    stage.projectValues.set('migrator_PARTY_REGISTRY_DB_PASSWORD', PARTY_REGISTRY_CREDENTIAL);
    const account = fakeCloudflareAccount({});
    const files = fakeFiles();
    const roles = fakeLoginRoles();
    const zerops = fakeZeropsApi(stage);

    yield* run(ensureStageDatabaseIdentities, { account, files, roles, stage, zerops });

    expect(zerops.serviceSecrets.map(({ key, serviceId }) => `${serviceId} ${key}`)).toStrictEqual([
      `${MIGRATOR_ID} PARTY_REGISTRY_WORKER_DB_PASSWORD`,
      `${MIGRATOR_ID} SHELL_GATEWAY_ISSUER_DB_PASSWORD`,
    ]);
    const firstRun = [...roles.calls];
    expect(firstRun.map(({ role }) => role)).toStrictEqual([
      'party_registry_runtime',
      'party_registry_worker',
      'shell_gateway_issuer',
    ]);
    expect(firstRun[0]?.password).toBe(PARTY_REGISTRY_CREDENTIAL);

    // A re-run keeps every password and alters each role to the same one.
    yield* run(ensureStageDatabaseIdentities, { account, files, roles, stage, zerops });

    expect(zerops.serviceSecrets).toHaveLength(2);
    expect(roles.calls.slice(3)).toStrictEqual(firstRun);
    expect(account.requests).toStrictEqual([]);
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('database-identities creates nothing and touches no role in a dry run', () =>
  Effect.gen(function* dryRunDatabaseIdentities() {
    const stage = newStage({}, { databaseIdentities: false });
    const roles = fakeLoginRoles();
    const zerops = fakeZeropsApi(stage);

    yield* run(ensureStageDatabaseIdentities, {
      account: fakeCloudflareAccount({}),
      dryRun: true,
      files: fakeFiles(),
      roles,
      stage,
      zerops,
    });

    expect(zerops.serviceSecrets).toStrictEqual([]);
    expect(roles.calls).toStrictEqual([]);
  }),
);

it.effect('leaves DEPLOY_TARGET unset while the migrator service lacks the identity passwords', () =>
  Effect.gen(function* refusesMissingIdentityPasswords() {
    const stage = newStage(
      { deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] },
      { databaseIdentities: false },
    );

    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain(
      'the Zerops migrator service holds every database identity password: missing PARTY_REGISTRY_DB_PASSWORD, PARTY_REGISTRY_WORKER_DB_PASSWORD, SHELL_GATEWAY_ISSUER_DB_PASSWORD; run database-identities',
    );
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('refuses to reuse an identity Hyperdrive config with the shared limit or another login', () =>
  Effect.gen(function* refusesDriftedIdentityHyperdrive() {
    const account = fakeCloudflareAccount({
      hyperdrives: [
        {
          caching: { disabled: true },
          id: OLD_HYPERDRIVE_ID,
          name: PARTY_REGISTRY_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 60,
        },
      ],
    });
    const stage = newStage();
    const files = fakeFiles();

    const error = yield* run(provision, { account, files, stage }).pipe(Effect.flip);

    expect(error.message).toContain(
      'Hyperdrive ontos-stage-party-registry (hyperdrive-old) differs from the runbook: origin connection limit 60, user ontos_runtime',
    );
    expect(files.writes.size).toBe(0);
  }),
);

it.effect('replaces an existing Zerops connector token when bootstrapping a fresh account and redeploys it', () =>
  Effect.gen(function* replacesOldConnectorToken() {
    const stage = newStage({
      projectValues: { cloudflared_TUNNEL_TOKEN: 'old-account-connector-token' },
      services: [
        { hostname: 'cloudflared', id: EXISTING_CONNECTOR_ID, status: 'ACTIVE' },
        { hostname: 'outboxworkerhost', id: EXISTING_HOST_ID, status: 'ACTIVE' },
      ],
    });
    const account = fakeCloudflareAccount({});
    const zerops = fakeZeropsApi(stage);
    const effect = Effect.gen(function* ensuresConnector() {
      yield* ensureZeropsDataLayer(yield* ensureTunnel);
    });
    yield* run(effect, { account, files: fakeFiles(), stage, zerops });
    expect(stage.projectValues.get('cloudflared_TUNNEL_TOKEN')).toBe(TUNNEL_TOKEN);
    expect(zerops.serviceSecrets).toEqual([
      { content: TUNNEL_TOKEN, key: 'TUNNEL_TOKEN', serviceId: EXISTING_CONNECTOR_ID },
    ]);
    expect(
      stage.commands.some(
        ({ args, command }) => command === 'zcli' && args[0] === 'push' && args.includes(EXISTING_CONNECTOR_ID),
      ),
    ).toBe(true);
    expect(stage.commands.some(({ args }) => args.includes(SERVICE_IMPORT))).toBe(false);
    // A converged re-run must not restart the only healthy connector.
    const pushes = stage.commands.filter(({ args, command }) => command === 'zcli' && args[0] === 'push').length;
    yield* run(effect, { account, files: fakeFiles(), stage, zerops });
    expect(zerops.serviceSecrets).toHaveLength(1);
    expect(stage.commands.filter(({ args, command }) => command === 'zcli' && args[0] === 'push')).toHaveLength(pushes);
    expectNoSecretInArguments(stage, account);
  }),
);

it.effect('loads public settings from reviewed topology and rejects an account override', () =>
  Effect.gen(function* requiresReviewedAccount() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const secrets = { CLOUDFLARE_API_TOKEN: 'token', STAGE_ACCESS_EMAILS: 'ops@example.com' };
    const loaded = yield* run(loadCutoverSettings, { account, files: fakeFiles(), settingsFile: secrets, stage });
    expect(loaded).toMatchObject({
      accountId: settings.accountId,
      emailSender: settings.emailSender,
      shellHostname: settings.shellHostname,
      spicedbHostname: settings.spicedbHostname,
      stageZone: settings.stageZone,
      storefrontHostname: settings.storefrontHostname,
      workersDevSubdomain: settings.workersDevSubdomain,
    });
    const error = yield* run(loadCutoverSettings, {
      account,
      files: fakeFiles(),
      settingsFile: { ...secrets, CLOUDFLARE_ACCOUNT_ID: 'wrong-account' },
      stage,
    }).pipe(Effect.flip);
    expect(error.message).toContain('differs from topology/stage-edge.json accountId');
    expect(account.requests).toEqual([]);
    expect(mutatingCommands(stage.commands)).toEqual([]);
  }),
);

it.effect('the actual CLI dry run executes its step, reads file credentials first, and reports mutations', () =>
  Effect.gen(function* cliDryRunReadsState() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const files = fakeFiles({
      'cutover.env': [
        'CLOUDFLARE_API_TOKEN=file-token',
        'CLOUDFLARE_STAGE_EDGE_API_TOKEN=file-ci-token',
        'ZEROPS_TOKEN=file-zerops-token',
        'DATABASE_ADMIN_URL=file-database',
        'STAGE_ACCESS_EMAILS=ops@example.com',
      ].join('\n'),
    });
    let executed = false;
    const step = Effect.gen(function* cliStep() {
      executed = true;
      const config = yield* CutoverConfiguration;
      expect(Redacted.value(config.apiToken)).toBe('file-token');
      expect(Redacted.value(config.stageEdgeApiToken)).toBe('file-ci-token');
      expect(yield* Config.String('ZEROPS_TOKEN')).toBe('file-zerops-token');
      expect(yield* Config.String('DATABASE_ADMIN_URL')).toBe('file-database');
      expect((yield* OpsMode).dryRun).toBe(true);
      yield* ensureTunnel;
    });
    yield* run(
      Command.runWith(stepCommand('activate', 'test', step), { renderErrors: false, version: '1' })([
        '--dry-run',
        '--env-file',
        `${APP_DIRECTORY}/cutover.env`,
      ]),
      {
        account,
        files,
        settingsFile: {
          CLOUDFLARE_API_TOKEN: 'ambient-old-token',
          CLOUDFLARE_STAGE_EDGE_API_TOKEN: 'ambient-old-ci-token',
          DATABASE_ADMIN_URL: 'ambient-old-database',
          ZEROPS_TOKEN: 'ambient-old-zerops-token',
        },
        stage,
      },
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(account.layer));
    expect(executed).toBe(true);
    expect(account.requests.some(({ url }) => url.pathname.endsWith(TUNNEL_PATH))).toBe(true);
    expect(account.requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(mutatingCommands(stage.commands)).toEqual([]);
    expect(files.writes.size).toBe(0);
  }),
);

for (const field of ['CLOUDFLARE_WORKERS_DEV_SUBDOMAIN', 'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL']) {
  it.effect(`activation refuses stale stage-edge variable ${field}`, () =>
    Effect.gen(function* staleStageVariable() {
      const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });
      stage.variables.get(STAGE_EDGE)?.set(field, 'stale');
      const error = yield* run(activate, {
        account: yield* provisionedAccount('healthy'),
        files: yield* reviewedPlacementFiles,
        stage,
      }).pipe(Effect.flip);
      expect(error.message).toContain(`${field} is stale`);
      expect(mutatingCommands(stage.commands)).toEqual([]);
    }),
  );
}
for (const field of ['ULTRAMODERN_EMAIL_SENDER', 'ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT']) {
  it.effect(`activation refuses stale placement ${field}`, () =>
    Effect.gen(function* stalePlacementOrigin() {
      const files = yield* reviewedPlacementFiles;
      const placement = Schema.decodeUnknownSync(PlacementJson)(files.writes.get(PLACEMENT));
      files.writes.set(
        PLACEMENT,
        JSON.stringify({ ...placement, buildEnvironment: { ...placement.buildEnvironment, [field]: 'stale' } }),
      );
      const stage = newStage();
      const error = yield* run(activate, { account: yield* provisionedAccount('healthy'), files, stage }).pipe(
        Effect.flip,
      );
      expect(error.message).toContain(`${field} is stale`);
      expect(mutatingCommands(stage.commands)).toEqual([]);
    }),
  );
}
for (const id of ['', 'wrong-id', 'deleted-namespace']) {
  it.effect(`activation refuses missing or unreviewed storefront catalog KV: ${id}`, () =>
    Effect.gen(function* invalidStorefrontKv() {
      const account = yield* provisionedAccount('healthy');
      const files = yield* reviewedPlacementFiles;
      const path = `${APP_DIRECTORY}/topology/stage-edge.json`;
      const topology = Schema.decodeUnknownSync(StageEdgeTopologySchema)(files.writes.get(path));
      files.writes.set(path, JSON.stringify({ ...topology, storefrontCatalogKvId: id }));
      if (id === 'deleted-namespace') {
        account.kvNamespaces.splice(1);
      }
      const stage = newStage();
      const error = yield* run(activate, { account, files, stage }).pipe(Effect.flip);
      expect(error.message).toContain('matches topology/stage-edge.json storefrontCatalogKvId');
      expect(mutatingCommands(stage.commands)).toEqual([]);
    }),
  );
}
for (const step of [provision, verifyCutover]) {
  it.effect('rejects an unverified workers.dev subdomain before any mutation', () =>
    Effect.gen(function* wrongSubdomain() {
      const account = fakeCloudflareAccount({ workersDevSubdomain: 'actual-company' });
      const stage = newStage();
      const files = fakeFiles();
      const error = yield* run(step, { account, files, stage }).pipe(Effect.flip);
      expect(error.message).toContain('differs from topology/stage-edge.json workersDevSubdomain');
      expect(account.requests.every(({ method }) => method === 'GET')).toBe(true);
      expect(mutatingCommands(stage.commands)).toEqual([]);
      expect(files.writes.size).toBe(0);
    }),
  );
}
it.effect('checks Zone Read with the stage-edge token rather than the broader provisioning token', () =>
  Effect.gen(function* narrowTokenZoneAccess() {
    const account = fakeCloudflareAccount({ zoneReadDeniedForToken: CI_TOKEN });
    const error = yield* run(verifyStageEdgeZoneAccess, { account, files: fakeFiles(), stage: newStage() }).pipe(
      Effect.flip,
    );
    expect(error.message).toContain('Zone Read denied');
  }),
);
it.effect('recovers a token-written-but-not-deployed connector only when its tunnel is unhealthy', () =>
  Effect.gen(function* interruptedConnectorDeployment() {
    const stage = newStage({
      projectValues: { cloudflared_TUNNEL_TOKEN: TUNNEL_TOKEN },
      services: [
        { hostname: 'cloudflared', id: EXISTING_CONNECTOR_ID, status: 'ACTIVE' },
        { hostname: 'outboxworkerhost', id: EXISTING_HOST_ID, status: 'ACTIVE' },
      ],
    });
    const account = fakeCloudflareAccount({ tunnels: [{ id: 'tunnel-1', name: STAGE_TUNNEL_NAME, status: 'down' }] });
    const zerops = fakeZeropsApi(stage);
    yield* run(ensureZeropsDataLayer({ exists: true, id: 'tunnel-1' }), { account, files: fakeFiles(), stage, zerops });
    expect(zerops.serviceSecrets).toHaveLength(0);
    expect(stage.commands.filter(({ args, command }) => command === 'zcli' && args[0] === 'push')).toHaveLength(1);
  }),
);
it.effect('writes only the storefront KV field while preserving topology order and extra fields', () =>
  Effect.gen(function* preservesTopologyDocument() {
    const topology = Object.fromEntries<string | { readonly keep: boolean }>([
      ['accountId', settings.accountId],
      ['workersDevSubdomain', settings.workersDevSubdomain],
      ['zone', settings.stageZone],
      ['shellHostname', settings.shellHostname],
      ['storefrontHostname', settings.storefrontHostname],
      ['spicedbHostname', settings.spicedbHostname],
      ['emailSender', settings.emailSender],
      ['storefrontCatalogKvId', ''],
      ['futureField', { keep: true }],
    ]);
    const files = fakeFiles({ 'topology/stage-edge.json': JSON.stringify(topology, null, 2) });
    yield* run(ensureStorefrontCatalogKv, { account: fakeCloudflareAccount({}), files, stage: newStage() });
    expect(files.writes.get(`${APP_DIRECTORY}/topology/stage-edge.json`)).toBe(
      `${JSON.stringify({ ...topology, storefrontCatalogKvId: 'kv-1' }, null, 2)}\n`,
    );
  }),
);

it.effect('activation dry run verifies live state and reports the deploy-target switch without applying it', () =>
  Effect.gen(function* plansActivationOnlyAfterVerification() {
    const account = yield* provisionedAccount('healthy');
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });
    const messages: string[] = [];
    const consoleService = yield* Console.Console;
    const log = rs.spyOn(consoleService, 'log').mockImplementation((...args: unknown[]) => {
      messages.push(...args.map(String));
    });
    yield* run(activate, { account, dryRun: true, files: yield* reviewedPlacementFiles, stage }).pipe(
      Effect.ensuring(Effect.sync(() => log.mockRestore())),
    );
    expect(messages.join('\n')).toContain('DEPLOY_TARGET=cloudflare');
    expect(messages.join('\n')).toContain('OUTBOX_WORKER_MODE=host');
    expect(account.requests.some(({ url }) => url.pathname.endsWith('/workers/subdomain'))).toBe(true);
    expect(mutatingCommands(stage.commands)).toEqual([]);
    expect(account.requests.every(({ method }) => method === 'GET')).toBe(true);
  }),
);
it.effect('activation refuses uncommitted storefront topology changes', () =>
  Effect.gen(function* dirtyStageTopology() {
    const stage = newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] });
    stage.dirtyPaths.add('app/topology/stage-edge.json');
    const error = yield* run(activate, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage,
    }).pipe(Effect.flip);
    expect(error.message).toContain('topology/stage-edge.json has uncommitted changes');
    expect(mutatingCommands(stage.commands)).toEqual([]);
  }),
);

for (const status of ['healthy', 'degraded']) {
  it.effect(`keeps a converged ${status} connector running`, () =>
    Effect.gen(function* keepsConnectedTunnel() {
      const stage = newStage({
        projectValues: { cloudflared_TUNNEL_TOKEN: TUNNEL_TOKEN },
        services: [
          { hostname: 'cloudflared', id: EXISTING_CONNECTOR_ID, status: 'ACTIVE' },
          { hostname: 'outboxworkerhost', id: EXISTING_HOST_ID, status: 'ACTIVE' },
        ],
      });
      const account = fakeCloudflareAccount({ tunnels: [{ id: 'tunnel-1', name: STAGE_TUNNEL_NAME, status }] });
      yield* run(ensureZeropsDataLayer({ exists: true, id: 'tunnel-1' }), { account, files: fakeFiles(), stage });
      expect(stage.commands.filter(({ args, command }) => command === 'zcli' && args[0] === 'push')).toHaveLength(0);
    }),
  );
}
