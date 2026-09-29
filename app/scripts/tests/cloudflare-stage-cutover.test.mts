import { readFileSync } from 'node:fs';

import { Array as Arr, Effect, Layer, Option, Order, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CloudflareApi, CloudflareApiLive, CloudflareCredentials } from '../ops/cloudflare-api.mts';
import {
  CutoverConfiguration,
  activate,
  provision,
  spicedbGatewayHostname,
  publicOrigin,
  stageBuildEnvironment,
  verifyCutover,
  workerSecretPlan,
} from '../ops/cloudflare-stage-cutover.mts';
import type { CutoverSettings } from '../ops/cloudflare-stage-cutover.mts';
import { SPICEDB_GRPC_TLS, SPICEDB_HTTP_TLS, spicedbTlsState } from '../ops/spicedb-tls.mts';
import { ciPolicy, killSwitchRule, peoplePolicy, usageAlert } from '../ops/cloudflare-stage-cost-guard.mts';
import { edgeUnits } from '../ops/stage-edge-units.mts';
import { OpsMode, STAGE_ZEROPS_PROJECT_ID } from '../ops/stage-operations.mts';
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
const PRIVATE_JWK = '{"kty":"OKP","d":"private-jwk-secret"}';
const SPICEDB_KEY = 'spicedb-key-secret';
const PUBLIC_JWKS = '{"keys":["public"]}';
const SNAPSHOT_SECRET = 'ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON';
const CUSTOMER_CONTEXT_WORKER = 'app-commerce-customer-context';
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
  enforceShellAccess: false,
  projectId: STAGE_ZEROPS_PROJECT_ID,
  repository: 'TechsioCZ/ontos',
  shellHostname: 'app.stage.example.com',
  stageEdgeApiToken: Redacted.make(CI_TOKEN),
  stageZone: 'stage.example.com',
};

const VERTICAL_HOSTS = [
  'partyregistry',
  'commercecustomercontext',
  'paymenttermcatalog',
  'commercemarketcatalog',
  'catalog',
  'pricing',
  'storefrontregistry',
  'pricegroupcatalog',
];

const SECRET_VALUES = {
  db18_dbName: 'ontos',
  db18_password: DATABASE_CREDENTIAL,
  shellsuperapp_BETTER_AUTH_SECRET: AUTH_SECRET,
  shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK: PRIVATE_JWK,
  spicedb_SPICEDB_GRPC_PRESHARED_KEY: SPICEDB_KEY,
  ...Object.fromEntries(VERTICAL_HOSTS.map((host) => [`${host}_ONTOS_GATEWAY_PUBLIC_JWKS`, PUBLIC_JWKS])),
};

const SECRETS = [
  'lead-token-secret',
  CI_TOKEN,
  DATABASE_CREDENTIAL,
  AUTH_SECRET,
  'private-jwk-secret',
  SPICEDB_KEY,
  'tunnel-connector-token',
  'service-token-secret',
];

const GATEWAY_HOSTNAME = 'ontos-stage-spicedb.stage.example.com';
/** Generated once: the TLS secrets `spicedb-tls` leaves on a provisioned stage. */
const SPICEDB_TLS = spicedbTlsSecrets({ gatewayHostname: GATEWAY_HOSTNAME });

const PLACEMENT = `${APP_DIRECTORY}/topology/cloudflare-placement.json`;
const ACCOUNT_PATH = '/client/v4/accounts/account-1';
const DATA_PLANE_PATH = /^\/(?:cfd_tunnel|connectivity|hyperdrive)/u;
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
    sensitiveKeys: Object.keys(tls),
    services: [
      { hostname: 'db18', id: 'db18-id', status: 'ACTIVE' },
      { hostname: 'spicedb', id: 'spicedb-id', status: 'ACTIVE' },
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
          host: { hostname: 'db18', resolver_network: { tunnel_id: 'tunnel-1' } },
          name: 'ontos-stage-db18',
          tcp_port: 5432,
          type: 'tcp',
        },
      ],
      [
        '/connectivity/directory/services',
        {
          host: { hostname: 'spicedb', resolver_network: { tunnel_id: 'tunnel-1' } },
          http_port: 8443,
          name: 'ontos-stage-spicedb',
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
    ]);
    for (const request of account.requests) {
      expect(request.url.origin).toBe('https://api.cloudflare.com');
    }

    // cloudflared is imported with the connector token as a secret, next to the worker host, then deployed.
    const imported = stage.inputs.find(({ command }) => command.startsWith('zcli project service-import -'));
    expect(imported?.stdin).toContain('hostname: cloudflared');
    expect(imported?.stdin).toContain('TUNNEL_TOKEN: tunnel-connector-token');
    expect(imported?.stdin).toContain('minContainers: 2');
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
      ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: HYPERDRIVE_ID,
      ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'vpc-2',
      ULTRAMODERN_MF_DEV_ORIGIN: SHELL_ORIGIN,
      ULTRAMODERN_PUBLIC_URL_PRICING: 'https://pricing.stage.example.com',
      ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: SHELL_ORIGIN,
    });
    expect(placement.units).toHaveLength(9);
    expect(stage.environments.has(STAGE_EDGE)).toBe(true);
    expect(stage.variables.get(STAGE_EDGE)?.get('CLOUDFLARE_ACCOUNT_ID')).toBe('account-1');
    expect(stage.inputs.find(({ command }) => command.startsWith('gh secret set CLOUDFLARE_API_TOKEN'))?.stdin).toBe(
      CI_TOKEN,
    );

    // Every placed Worker receives its secrets through `wrangler secret bulk` on stdin.
    const bulk = stage.inputs.filter(({ command }) => command.includes('wrangler secret bulk'));
    expect(bulk.map(({ command }) => command.split(' ').at(-1))).toHaveLength(9);
    const shell = bulk.find(({ command }) => command.endsWith('--name app-shell-super-app'));
    expect(Schema.decodeUnknownSync(StringRecord)(shell?.stdin)).toStrictEqual({
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_TRUSTED_ORIGINS: SHELL_ORIGIN,
      BETTER_AUTH_URL: SHELL_ORIGIN,
      [DEPLOYMENT_ENVIRONMENT]: 'stage',
      ONTOS_GATEWAY_ISSUER: SHELL_ORIGIN,
      ONTOS_GATEWAY_PRIVATE_JWK: PRIVATE_JWK,
      SPICEDB_ENDPOINT: 'spicedb:8443',
      SPICEDB_INSECURE: 'true',
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

it.effect('refuses to publish a gateway key the Zerops verticals do not share', () =>
  Effect.gen(function* refusesDivergentJwks() {
    const account = fakeCloudflareAccount({});
    const stage = newStage({
      projectValues: { ...SECRET_VALUES, pricing_ONTOS_GATEWAY_PUBLIC_JWKS: '{"keys":["other"]}' },
    });
    const files = fakeFiles();

    const error = yield* run(provision, { account, files, stage }).pipe(Effect.flip);

    expect(error.message).toContain('do not share one ONTOS_GATEWAY_PUBLIC_JWKS');
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

/** Each placed Worker's planned runtime secret names, the ones `provision` sets and `verify` requires. */
const plannedSecretNames = Effect.gen(function* plannedSecretNamesEffect() {
  const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
  const secret = Redacted.make('value');
  const plan = workerSecretPlan(units, settings, {
    betterAuthSecret: secret,
    gatewayPrivateJwk: secret,
    gatewayPublicJwks: secret,
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
      { ...peoplePolicy(settings.accessEmails), id: 'policy-1' },
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
      scripts: [
        'app-party-registry',
        CUSTOMER_CONTEXT_WORKER,
        'app-payment-term-catalog',
        'app-commerce-market-catalog',
        'app-catalog',
        'app-pricing',
        'app-storefront-registry',
        'app-price-group-catalog',
        'app-shell-super-app',
      ],
      secrets: Object.fromEntries(
        Object.entries(planned).map(([worker, names]) => [worker, [...names, ...(extraSecrets[worker] ?? [])]]),
      ),
      tunnels: [{ id: 'tunnel-1', name: 'ontos-stage', status: tunnelStatus }],
      vpcServices: [
        {
          app_protocol: 'postgresql',
          host: { hostname: 'db18', resolver_network: { tunnel_id: 'tunnel-1' } },
          name: 'ontos-stage-db18',
          service_id: 'vpc-1',
          tcp_port: 5432,
          type: 'tcp',
        },
        {
          host: { hostname: 'spicedb', resolver_network: { tunnel_id: 'tunnel-1' } },
          http_port: 8443,
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

it.effect('requires the composition snapshot secret on each placed consumer Worker once stage targets Cloudflare', () =>
  Effect.gen(function* requiresSnapshotSecret() {
    const activated = () =>
      newStage({
        deployments: [{ id: 7, sha: FAKE_REVISION, state: 'success' }],
        variables: { stage: { DEPLOY_TARGET: 'cloudflare' } },
      });

    // The first Cloudflare-target deploy has not handed the snapshot over yet.
    const error = yield* run(verifyCutover, {
      account: yield* provisionedAccount('healthy'),
      files: yield* reviewedPlacementFiles,
      stage: activated(),
    }).pipe(Effect.flip);
    expect(error.message).toContain(`holds its ${SNAPSHOT_SECRET} secret: missing on ${CUSTOMER_CONTEXT_WORKER}`);

    yield* run(verifyCutover, {
      account: yield* provisionedAccount('healthy', { [CUSTOMER_CONTEXT_WORKER]: [SNAPSHOT_SECRET] }),
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

it.effect('gives every vertical the Shell key and the callers their stage dependencies', () =>
  Effect.gen(function* plansWorkerSecrets() {
    const units = yield* edgeUnits(readRepositoryFile(TOPOLOGY_FILE), readRepositoryFile(PLACEMENT_FILE));
    const secret = Redacted.make('value');
    const plan = workerSecretPlan(units, settings, {
      betterAuthSecret: secret,
      gatewayPrivateJwk: secret,
      gatewayPublicJwks: secret,
      spicedbPresharedKey: secret,
    });
    const reveal = (worker: string) =>
      Object.fromEntries(Object.entries(plan.get(worker) ?? {}).map(([key, value]) => [key, Redacted.value(value)]));

    expect([...plan.keys()]).toHaveLength(9);
    expect(reveal(CUSTOMER_CONTEXT_WORKER)).toMatchObject({
      ONTOS_CATALOG_BASE_URL: 'https://catalog.stage.example.com/catalog-api',
      ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'https://price-group-catalog.stage.example.com/price-group-catalog-api',
      ONTOS_PRICING_BASE_URL: 'https://pricing.stage.example.com/pricing-api',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://app.stage.example.com/shell-super-app-api',
    });
    expect(reveal('app-commerce-market-catalog')).toMatchObject({
      ONTOS_COMMERCE_CUSTOMER_CONTEXT_BASE_URL:
        'https://commerce-customer-context.stage.example.com/commerce-customer-context-api',
    });
    expect(Arr.sort(Object.keys(reveal('app-pricing')), Order.String)).toStrictEqual([
      'ONTOS_GATEWAY_ISSUER',
      'ONTOS_GATEWAY_PUBLIC_JWKS',
      'SPICEDB_ENDPOINT',
      'SPICEDB_INSECURE',
      'SPICEDB_PRESHARED_KEY',
      DEPLOYMENT_ENVIRONMENT,
    ]);
    for (const secrets of plan.values()) {
      expect(Object.keys(secrets)).not.toContain('DATABASE_URL');
    }
  }),
);
