import { readFileSync } from 'node:fs';

import { Array as Arr, ConfigProvider, Effect, Layer, Option, Order, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CloudflareApi, CloudflareApiLive, CloudflareCredentials } from '../ops/cloudflare-api.mts';
import type { CloudflareVpcService } from '../ops/cloudflare-api.mts';
import {
  CutoverConfiguration,
  activate,
  provision,
  spicedbGatewayHostname,
  publicOrigin,
  STAGE_VPC_SERVICES,
  stageBuildEnvironment,
  verifyCutover,
  vpcServiceDrift,
  workerSecretPlan,
} from '../ops/cloudflare-stage-cutover.mts';
import type { CutoverSettings } from '../ops/cloudflare-stage-cutover.mts';
import { SPICEDB_GRPC_TLS, SPICEDB_HTTP_TLS, spicedbTlsState } from '../ops/spicedb-tls.mts';
import { ciPolicy, killSwitchRule, peoplePolicy, usageAlert } from '../ops/cloudflare-stage-cost-guard.mts';
import { edgeUnits, placementGaps } from '../ops/stage-edge-units.mts';
import { OpsMode, STAGE_ZEROPS_PROJECT_ID, readZeropsValue } from '../ops/stage-operations.mts';
import {
  APP_DIRECTORY,
  FAKE_REVISION,
  fakeCloudflareAccount,
  fakeFiles,
  fakeStage,
  fakeZeropsApi,
  mutatingCommands,
  spicedbTlsSecrets,
} from './stage-operations-fixture.mts';
import type { FakeCloudflareAccount, FakeFiles, FakeStage, FakeZeropsApi } from './stage-operations-fixture.mts';

const SHELL_ORIGIN = 'https://app.stage.example.com';
const CI_TOKEN = 'ci-token-secret';
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
const CUSTOMER_CONTEXT_WORKER = 'app-commerce-customer-context';
const MARKET_WORKER = 'app-commerce-market-catalog';
const PRICING_WORKER = 'app-pricing';
const DEPLOYMENT_ENVIRONMENT = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';
const PLACEMENT_FILE = 'topology/cloudflare-placement.json';
const TOPOLOGY_FILE = 'topology/reference-topology.json';
const RUNTIME_HYPERDRIVE = 'ontos-stage-runtime';
const HYPERDRIVE_ID = 'hyperdrive-1';
const STAGE_EDGE = 'stage-edge';

const settings: CutoverSettings = {
  accessEmails: ['ops@example.com'],
  accountId: 'account-1',
  apiToken: Redacted.make('lead-token-secret'),
  enforceAccess: false,
  projectId: STAGE_ZEROPS_PROJECT_ID,
  repository: 'TechsioCZ/ontos',
  shellHostname: 'app.stage.example.com',
  stageEdgeApiToken: Redacted.make(CI_TOKEN),
  stageZone: 'stage.example.com',
};

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
  MARKET_GATEWAY_API_KEY,
  PRICING_GATEWAY_API_KEY,
  'tunnel-connector-token',
  'service-token-secret',
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
const StringRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

/** stage-edge as the cost guards leave it: the zone ID and the Access service token credentials. */
const GUARDED_STAGE_EDGE = {
  secrets: { [STAGE_EDGE]: ['CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET'] },
  variables: { [STAGE_EDGE]: { CLOUDFLARE_STAGE_ZONE_ID: 'zone-1' } },
};

/** A stage whose spicedb service already holds its TLS secrets, unless `spicedbTls` is false. */
const newStage = (overrides: Parameters<typeof fakeStage>[0] = {}, { spicedbTls = true } = {}) => {
  const tls = spicedbTls ? SPICEDB_TLS : {};
  return fakeStage({
    projectUserKeys: Object.keys(tls),
    // zcli prints these as REDACTED, so the kit must read them through the Zerops API.
    sensitiveKeys: [...Object.keys(tls), ...SENSITIVE_KEYS],
    services: [
      { hostname: 'db18', id: 'db18-id', status: 'ACTIVE' },
      { hostname: 'spicedb', id: 'spicedb-id', status: 'ACTIVE' },
      ...VERTICAL_HOSTS.map((hostname) => ({ hostname, id: `${hostname}-id`, status: 'ACTIVE' })),
    ],
    ...overrides,
    projectValues: { ...SECRET_VALUES, ...tls, ...overrides.projectValues },
    secrets: { ...GUARDED_STAGE_EDGE.secrets, ...overrides.secrets },
    variables: { ...GUARDED_STAGE_EDGE.variables, ...overrides.variables },
  });
};

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fakes: {
    readonly account: FakeCloudflareAccount;
    readonly dryRun?: boolean;
    readonly files: FakeFiles;
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
        Layer.succeed(CutoverConfiguration, settings),
        Layer.succeed(OpsMode, { dryRun: fakes.dryRun ?? false }),
        fakes.stage.layer,
        (fakes.zerops ?? fakeZeropsApi(fakes.stage)).layer,
        fakes.files.layer,
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
    const stage = newStage();
    const files = fakeFiles();

    yield* run(provision, { account, files, stage });

    // The cost guards have their own tests; these are the data-plane objects.
    const posts = account.requests.filter(
      ({ method, url }) => method === 'POST' && DATA_PLANE_PATH.test(url.pathname.replace(ACCOUNT_PATH, '')),
    );
    expect(
      posts.map(({ body, url }) => [url.pathname.replace(ACCOUNT_PATH, ''), Option.getOrNull(body)]),
    ).toStrictEqual([
      ['/cfd_tunnel', { config_src: 'cloudflare', name: 'ontos-stage' }],
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
        '/hyperdrive/configs',
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
          origin_connection_limit: 40,
        },
      ],
      ['/storage/kv/namespaces', { title: COMPOSITION_KV }],
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
      ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: HYPERDRIVE_ID,
      ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'vpc-2',
      ULTRAMODERN_MF_DEV_ORIGIN: SHELL_ORIGIN,
      ULTRAMODERN_PUBLIC_URL_PRICING: 'https://ontos-stage-pricing.stage.example.com',
      ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: SHELL_ORIGIN,
    });
    expect(placement.units).toHaveLength(12);
    expect(stage.environments.has(STAGE_EDGE)).toBe(true);
    expect(stage.variables.get(STAGE_EDGE)?.get('CLOUDFLARE_ACCOUNT_ID')).toBe('account-1');
    expect(stage.inputs.find(({ command }) => command.startsWith('gh secret set CLOUDFLARE_API_TOKEN'))?.stdin).toBe(
      CI_TOKEN,
    );

    // Every placed Worker receives its secrets through `wrangler secret bulk` on stdin.
    const bulk = stage.inputs.filter(({ command }) => command.includes('wrangler secret bulk'));
    expect(bulk.map(({ command }) => command.split(' ').at(-1))).toHaveLength(12);
    const shell = bulk.find(({ command }) => command.endsWith('--name app-shell-super-app'));
    expect(Schema.decodeUnknownSync(StringRecord)(shell?.stdin)).toStrictEqual({
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_TRUSTED_ORIGINS: SHELL_ORIGIN,
      BETTER_AUTH_URL: SHELL_ORIGIN,
      [DEPLOYMENT_ENVIRONMENT]: 'stage',
      ONTOS_GATEWAY_ISSUER: SHELL_ORIGIN,
      ONTOS_GATEWAY_PRIVATE_JWK: PRIVATE_JWK,
      SPICEDB_ENDPOINT: GATEWAY_HOSTNAME,
      SPICEDB_PRESHARED_KEY: SPICEDB_KEY,
    });
    expectNoSecretInArguments(stage, account);
  }),
);

it.effect('changes nothing in a dry run but still reads the real state', () =>
  Effect.gen(function* dryRunReadsOnly() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const files = fakeFiles();

    yield* run(provision, { account, dryRun: true, files, stage });

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

    expect(spicedbGatewayHostname(settings)).toBe(GATEWAY_HOSTNAME);
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
    const firstImports = stage.commands.filter(({ args }) => args.includes('service-import')).length;
    const firstVariableSets = stage.commands.filter(({ args }) => args[0] === 'variable' && args[1] === 'set').length;

    yield* run(provision, { account, files, stage });

    expect(account.requests.filter(({ method }) => method === 'POST')).toHaveLength(firstPosts);
    expect(stage.commands.filter(({ args }) => args.includes('service-import'))).toHaveLength(firstImports);
    expect(stage.commands.filter(({ args }) => args[0] === 'variable' && args[1] === 'set')).toHaveLength(
      firstVariableSets,
    );
    expect(stage.commands.filter(({ args }) => args.includes('push'))).toHaveLength(1);
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
          id: 'hyperdrive-old',
          name: RUNTIME_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 40,
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
          id: 'hyperdrive-old',
          name: RUNTIME_HYPERDRIVE,
          origin: { database: 'postgres', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 40,
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

it.effect('refuses a Shell gateway key that is not an Ed25519 private JWK', () =>
  Effect.gen(function* refusesMalformedGatewayKey() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const settingsFile = { ...SHELL_SETTINGS, shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK: '{"kty":"OKP"}' };

    const error = yield* run(provision, { account, files: fakeFiles(), settingsFile, stage }).pipe(Effect.flip);

    expect(error.message).toBe('the Shell ONTOS_GATEWAY_PRIVATE_JWK is not an Ed25519 private JWK');
    expect(stage.commands.filter(({ args }) => args.includes('wrangler'))).toStrictEqual([]);
  }),
);

it.effect('fails before setting any Worker secret when the settings file lacks a Shell secret', () =>
  Effect.gen(function* requiresShellSecrets() {
    const account = fakeCloudflareAccount({});
    const stage = newStage();
    const settingsFile = { shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK: PRIVATE_JWK };

    const error = yield* run(provision, { account, files: fakeFiles(), settingsFile, stage }).pipe(Effect.flip);

    expect(error.message).toBe(
      'the Shell secret shellsuperapp_BETTER_AUTH_SECRET is missing; set it in the settings file (see DEPLOYMENT.md, Stage cut-over)',
    );
    expect(stage.commands.filter(({ args }) => args.includes('wrangler'))).toStrictEqual([]);
  }),
);

it.effect('requires every caller key before writing any Worker secret', () =>
  Effect.gen(function* requiresCallerGatewayKeys() {
    for (const missingKey of [
      'ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY',
      'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY',
      'ONTOS_PRICING_GATEWAY_API_KEY',
    ]) {
      const account = fakeCloudflareAccount({});
      const stage = newStage();
      const settingsFile = Object.fromEntries(Object.entries(SHELL_SETTINGS).filter(([key]) => key !== missingKey));
      const error = yield* run(provision, { account, files: fakeFiles(), settingsFile, stage }).pipe(Effect.flip);
      expect(error.message).toBe(
        'the workload gateway API keys are missing; provide all three caller keys in the settings',
      );
      expect(stage.commands.filter(({ args }) => args.includes('wrangler'))).toStrictEqual([]);
      expectNoSecretInArguments(stage, account);
    }
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

/** Each placed Worker's planned runtime secret names, the ones `provision` sets and `verify` requires. */
const plannedSecretNames = Effect.gen(function* plannedSecretNamesEffect() {
  const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
  const secret = Redacted.make('value');
  const plan = workerSecretPlan(units, settings, {
    betterAuthSecret: secret,
    commerceCustomerContextGatewayApiKey: secret,
    commerceMarketCatalogGatewayApiKey: secret,
    gatewayPrivateJwk: secret,
    gatewayPublicJwks: secret,
    pricingGatewayApiKey: secret,
    spicedbPresharedKey: secret,
  });
  return Object.fromEntries([...plan].map(([worker, secrets]) => [worker, Object.keys(secrets)]));
});

/** Every cost guard as `provision` leaves it, with the kill switch off. */
const guardedAccount = Effect.gen(function* guardedAccountEffect() {
  const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
  const hostnames = units.map((unit) => new URL(publicOrigin(unit, settings)).hostname);
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
        rules: [{ ...killSwitchRule(hostnames, false), id: 'rule-2' }],
      },
    ],
    serviceTokens: [{ client_id: 'access-client-id', id: 'token-1', name: 'ontos-stage-ci' }],
  };
});

/** An account `provision` completed; `extraSecrets` adds names to a Worker's planned ones. */
const provisionedAccount = (
  tunnelStatus: string,
  extraSecrets: Readonly<Record<string, readonly string[]>> = {},
  plannedOverride?: Readonly<Record<string, readonly string[]>>,
  compositionKeys: readonly string[] = [],
) =>
  Effect.gen(function* provisionedAccountEffect() {
    const planned: Readonly<Record<string, readonly string[]>> = plannedOverride ?? (yield* plannedSecretNames);
    return fakeCloudflareAccount({
      ...(yield* guardedAccount),
      hyperdrives: [
        {
          caching: { disabled: true },
          id: HYPERDRIVE_ID,
          name: RUNTIME_HYPERDRIVE,
          origin: { database: 'ontos', scheme: 'postgresql', service_id: 'vpc-1', user: 'ontos_runtime' },
          origin_connection_limit: 40,
        },
      ],
      kvKeys: { [COMPOSITION_KV_ID]: compositionKeys },
      kvNamespaces: [{ id: COMPOSITION_KV_ID, title: COMPOSITION_KV }],
      scripts: [
        'app-availability',
        'app-assortment',
        'app-party-registry',
        CUSTOMER_CONTEXT_WORKER,
        'app-payment-term-catalog',
        MARKET_WORKER,
        'app-catalog',
        PRICING_WORKER,
        'app-storefront-registry',
        'app-price-group-catalog',
        'app-inventory',
        'app-shell-super-app',
      ],
      secrets: Object.fromEntries(
        Object.entries(planned).map(([worker, names]) => [worker, [...names, ...(extraSecrets[worker] ?? [])]]),
      ),
      tunnels: [{ id: 'tunnel-1', name: 'ontos-stage', status: tunnelStatus }],
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
    hyperdriveId: HYPERDRIVE_ID,
    spicedbVpcServiceId: 'vpc-2',
  });
  const placement = Schema.decodeUnknownSync(JsonRecord)(placementText);
  return fakeFiles({
    [PLACEMENT_FILE]: Schema.encodeUnknownSync(JsonRecord)({ ...placement, buildEnvironment }),
  });
});

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

    expect(error.message).toContain('topology/cloudflare-placement.json has uncommitted changes');
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
      account: yield* provisionedAccount('healthy', {}, undefined, ['active']),
      files: yield* reviewedPlacementFiles,
      stage: activated(),
    });
  }),
);

it.effect('requires every planned runtime secret on each placed Worker', () =>
  Effect.gen(function* requiresPlannedSecrets() {
    const planned = yield* plannedSecretNames;
    const partial = {
      ...planned,
      [CUSTOMER_CONTEXT_WORKER]: (planned[CUSTOMER_CONTEXT_WORKER] ?? []).filter(
        (name) => name !== 'SPICEDB_PRESHARED_KEY' && name !== DEPLOYMENT_ENVIRONMENT,
      ),
    };

    const error = yield* run(verifyCutover, {
      account: yield* provisionedAccount('healthy', {}, partial),
      files: yield* reviewedPlacementFiles,
      stage: newStage({ deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }] }),
    }).pipe(Effect.flip);

    expect(error.message).toContain(
      `${CUSTOMER_CONTEXT_WORKER} lacks SPICEDB_PRESHARED_KEY, ${DEPLOYMENT_ENVIRONMENT}; run worker-secrets`,
    );
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
it.effect('places every topology unit with its public URL and the shared data-plane variables', () =>
  Effect.gen(function* placesEveryUnit() {
    expect(yield* placementGaps(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE))).toStrictEqual(
      [],
    );
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
      gatewayPrivateJwk: secret,
      gatewayPublicJwks: secret,
      pricingGatewayApiKey: Redacted.make(PRICING_GATEWAY_API_KEY),
      spicedbPresharedKey: secret,
    });
    const reveal = (worker: string) =>
      Object.fromEntries(Object.entries(plan.get(worker) ?? {}).map(([key, value]) => [key, Redacted.value(value)]));

    expect([...plan.keys()]).toHaveLength(12);
    expect(reveal(CUSTOMER_CONTEXT_WORKER)).toMatchObject({
      ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: CUSTOMER_CONTEXT_GATEWAY_API_KEY,
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://app.stage.example.com/shell-super-app-api',
    });
    expect(reveal(MARKET_WORKER)).toMatchObject({
      ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: MARKET_GATEWAY_API_KEY,
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://app.stage.example.com/shell-super-app-api',
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
