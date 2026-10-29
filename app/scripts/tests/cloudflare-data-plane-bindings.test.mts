import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from '@app/party-registry-identity-contracts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createWranglerConfig } from '@modern-js/app-tools-extensions/cloudflare/wrangler-config';
import { Array as EffectArray, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../packages/core-runtime/src/db/database-identity-manifest.ts';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_BINDING } from '../../packages/core-runtime/src/modules/active-application-composition-edge.ts';
import {
  CLOUDFLARE_WORKER_CPU_MS,
  CLOUDFLARE_WORKER_OBSERVABILITY,
  createCloudflareDataPlaneBindings,
  createCloudflareWorkerConfig,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

const HYPERDRIVE_ID = 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID';
const PARTY_REGISTRY_HYPERDRIVE_ID = 'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID';
const GATEWAY_ISSUER_HYPERDRIVE_ID = 'ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID';
const SPICEDB_VPC_SERVICE_ID = 'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID';
const COMPOSITION_KV_ID = 'ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID';
const HYPERDRIVE_CONFIG = 'hyperdrive-id';
const PARTY_REGISTRY_HYPERDRIVE_CONFIG = 'party-registry-hyperdrive-id';
const GATEWAY_ISSUER_HYPERDRIVE_CONFIG = 'gateway-issuer-hyperdrive-id';
const COMPOSITION_KV = 'composition-kv-id';
const COMPOSITION_BINDING = { binding: ACTIVE_APPLICATION_COMPOSITION_EDGE_BINDING, id: COMPOSITION_KV };
const SPICEDB_VPC_SERVICE = 'vpc-service-id';
const PUBLIC_URL = 'ULTRAMODERN_PUBLIC_URL_CATALOG';
const CATALOG_ORIGIN = 'https://ontos-stage-catalog.stage.example.com';
const DEPLOYMENT_ENVIRONMENT = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';
const PRICING_PUBLIC_URL = 'ULTRAMODERN_PUBLIC_URL_PRICING';
const PRICING_WORKER = 'app-pricing';
const PLACEMENT_HOST_VARIABLE = 'ULTRAMODERN_CLOUDFLARE_PLACEMENT_HOST';
const PLACEMENT_HOST = 'backend.example.com:443';
const GeneratedWranglerObservabilitySchema = Schema.Struct({
  name: Schema.String,
  observability: Schema.Unknown,
  placement: Schema.Struct({ host: Schema.String }),
});

const SHARED_HYPERDRIVE = SHARED_RUNTIME_IDENTITY.cloudflareHyperdrive;

const reader =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name];

it('binds every Worker to PostgreSQL, SpiceDB and the published active Application Composition', () => {
  expect(
    createCloudflareDataPlaneBindings(
      reader({
        [COMPOSITION_KV_ID]: COMPOSITION_KV,
        [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
        [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      }),
      [SHARED_HYPERDRIVE],
    ),
  ).toEqual({
    vpcServices: [{ binding: 'SPICEDB', serviceId: SPICEDB_VPC_SERVICE }],
    wrangler: { hyperdrive: [{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }], kv_namespaces: [COMPOSITION_BINDING] },
  });
});

it('serves every Worker only on its custom domain, off workers.dev and preview URLs, and caps its CPU per request', () => {
  const values = reader({
    [COMPOSITION_KV_ID]: COMPOSITION_KV,
    [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
    [PUBLIC_URL]: CATALOG_ORIGIN,
    [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
  });

  expect(
    createCloudflareWorkerConfig(values, { hyperdrives: [SHARED_HYPERDRIVE], publicUrlVariable: PUBLIC_URL }),
  ).toEqual({
    vpcServices: [{ binding: 'SPICEDB', serviceId: SPICEDB_VPC_SERVICE }],
    wrangler: {
      compatibility_flags: ['global_fetch_strictly_public'],
      hyperdrive: [{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }],
      kv_namespaces: [COMPOSITION_BINDING],
      limits: { cpu_ms: CLOUDFLARE_WORKER_CPU_MS },
      observability: { enabled: false },
      placement: { mode: 'off' },
      preview_urls: false,
      routes: [{ custom_domain: true, pattern: 'ontos-stage-catalog.stage.example.com' }],
      workers_dev: false,
    },
  });
  // One budget at the Workers Standard maximum: a cold isolate's first BFF request must never hit 1102.
  expect(CLOUDFLARE_WORKER_CPU_MS).toBe(30_000);
});

const workerConfigFor = (deploymentEnvironment: Readonly<Record<string, string>>) =>
  createCloudflareWorkerConfig(
    reader({
      [COMPOSITION_KV_ID]: COMPOSITION_KV,
      [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
      [PUBLIC_URL]: CATALOG_ORIGIN,
      [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      ...deploymentEnvironment,
    }),
    { hyperdrives: [SHARED_HYPERDRIVE], publicUrlVariable: PUBLIC_URL },
  ).wrangler.observability;

it('keeps every stage Worker invocation in Workers Logs', () => {
  expect(workerConfigFor({ [DEPLOYMENT_ENVIRONMENT]: 'stage' })).toEqual({ enabled: true, head_sampling_rate: 1 });
});

it('states Workers Logs off for production and for builds that deploy nowhere', () => {
  // Explicit `enabled: false`, never an omitted key, so a deploy also undoes a dashboard toggle.
  expect(workerConfigFor({ [DEPLOYMENT_ENVIRONMENT]: 'production' })).toEqual({ enabled: false });
  expect(workerConfigFor({})).toEqual({ enabled: false });
  expect(CLOUDFLARE_WORKER_OBSERVABILITY).toStrictEqual({
    development: { enabled: false },
    production: { enabled: false },
    stage: { enabled: true, head_sampling_rate: 1 },
  });
});

it('refuses a Worker build for an unknown deployment environment', () => {
  expect(() => workerConfigFor({ [DEPLOYMENT_ENVIRONMENT]: 'staging' })).toThrow();
});

it.each(['', '   '])('refuses an empty declared placement host (%j)', (host) => {
  expect(() => workerConfigFor({ [PLACEMENT_HOST_VARIABLE]: host })).toThrow();
});

it.each([
  ['stage', { enabled: true, head_sampling_rate: 1 }],
  ['production', { enabled: false }],
] as const)('writes the %s Workers Logs setting into the generated wrangler.json', (environment, observability) => {
  const deploy = {
    worker: {
      ...createCloudflareWorkerConfig(
        reader({
          [COMPOSITION_KV_ID]: COMPOSITION_KV,
          [DEPLOYMENT_ENVIRONMENT]: environment,
          [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
          [PLACEMENT_HOST_VARIABLE]: PLACEMENT_HOST,
          [PRICING_PUBLIC_URL]: 'https://ontos-stage-pricing.stage.example.com',
          [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
        }),
        {
          hyperdrives: [SHARED_HYPERDRIVE],
          publicUrlVariable: PRICING_PUBLIC_URL,
        },
      ),
      name: PRICING_WORKER,
    },
  };
  expect(deploy).toBeDefined();
  const wrangler = Schema.decodeUnknownSync(GeneratedWranglerObservabilitySchema)(
    createWranglerConfig(process.cwd(), deploy === undefined ? {} : { deploy }),
  );
  expect(wrangler).toEqual({ name: PRICING_WORKER, observability, placement: { host: PLACEMENT_HOST } });
});

it('refuses a Worker build without its public URL', () => {
  const values = reader({
    [COMPOSITION_KV_ID]: COMPOSITION_KV,
    [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
    [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
  });

  expect(() =>
    createCloudflareWorkerConfig(values, { hyperdrives: [SHARED_HYPERDRIVE], publicUrlVariable: PUBLIC_URL }),
  ).toThrow(`${PUBLIC_URL} is required for a Cloudflare Worker build`);
});

it.each([
  [HYPERDRIVE_ID, { [COMPOSITION_KV_ID]: COMPOSITION_KV, [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE }],
  [SPICEDB_VPC_SERVICE_ID, { [COMPOSITION_KV_ID]: COMPOSITION_KV, [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG }],
  [COMPOSITION_KV_ID, { [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG, [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE }],
] as const)('refuses a Worker build without %s', (name, values) => {
  expect(() => createCloudflareDataPlaneBindings(reader(values), [SHARED_HYPERDRIVE])).toThrow(
    `${name} is required for a Cloudflare Worker build`,
  );
});

it('generates Commerce without a retired mutable owner binding while preserving native infrastructure bindings', () => {
  const publicUrlVariable = 'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT';
  const deploy = {
    worker: createCloudflareWorkerConfig(
      reader({
        [COMPOSITION_KV_ID]: COMPOSITION_KV,
        [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
        [publicUrlVariable]: 'https://ontos-stage-commerce-customer-context.stage.example.com',
        [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      }),
      { hyperdrives: [SHARED_HYPERDRIVE], publicUrlVariable },
    ),
  };
  const GeneratedBindingsSchema = Schema.Struct({
    compatibility_flags: Schema.Array(Schema.String),
    dispatch_namespaces: Schema.optional(Schema.Array(Schema.Unknown)),
    hyperdrive: Schema.Array(Schema.Struct({ binding: Schema.String, id: Schema.String })),
    kv_namespaces: Schema.Array(Schema.Struct({ binding: Schema.String, id: Schema.String })),
    services: Schema.optional(Schema.Array(Schema.Struct({ binding: Schema.String, service: Schema.String }))),
    vpc_services: Schema.Array(Schema.Struct({ binding: Schema.String, service_id: Schema.String })),
  });
  const wrangler = Schema.decodeUnknownSync(GeneratedBindingsSchema)(
    createWranglerConfig(process.cwd(), deploy === undefined ? {} : { deploy }),
  );
  expect(wrangler).toEqual({
    compatibility_flags: ['global_fetch_strictly_public', 'nodejs_compat', 'enable_request_signal'],
    hyperdrive: [{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }],
    kv_namespaces: [COMPOSITION_BINDING],
    vpc_services: [{ binding: 'SPICEDB', service_id: SPICEDB_VPC_SERVICE }],
  });
});

const IDENTITY_BINDING_VALUES = {
  [COMPOSITION_KV_ID]: COMPOSITION_KV,
  [GATEWAY_ISSUER_HYPERDRIVE_ID]: GATEWAY_ISSUER_HYPERDRIVE_CONFIG,
  [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
  [PARTY_REGISTRY_HYPERDRIVE_ID]: PARTY_REGISTRY_HYPERDRIVE_CONFIG,
  [PUBLIC_URL]: CATALOG_ORIGIN,
  [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
};

it('binds the shared runtime identity to the HYPERDRIVE binding', () => {
  expect(SHARED_HYPERDRIVE).toEqual({ binding: 'HYPERDRIVE', idVariable: HYPERDRIVE_ID });
  expect(
    createCloudflareWorkerConfig(reader(IDENTITY_BINDING_VALUES), {
      hyperdrives: [SHARED_HYPERDRIVE],
      publicUrlVariable: PUBLIC_URL,
    }).wrangler.hyperdrive,
  ).toEqual([{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }]);
});

it('binds the Party Worker only to its request identity Hyperdrive', () => {
  const values = reader({
    [COMPOSITION_KV_ID]: COMPOSITION_KV,
    [PARTY_REGISTRY_HYPERDRIVE_ID]: PARTY_REGISTRY_HYPERDRIVE_CONFIG,
    [PUBLIC_URL]: 'https://ontos-stage-party-registry.stage.example.com',
    [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
  });
  expect(
    createCloudflareWorkerConfig(values, {
      hyperdrives: [PARTY_REGISTRY_REQUEST_IDENTITY.cloudflareHyperdrive],
      publicUrlVariable: PUBLIC_URL,
    }).wrangler.hyperdrive,
  ).toEqual([{ binding: 'PARTY_REGISTRY_HYPERDRIVE', id: PARTY_REGISTRY_HYPERDRIVE_CONFIG }]);
});

it('binds the Shell Worker to the shared runtime and gateway issuer Hyperdrives', () => {
  expect(
    createCloudflareWorkerConfig(reader(IDENTITY_BINDING_VALUES), {
      hyperdrives: [SHARED_RUNTIME_IDENTITY.cloudflareHyperdrive, SHELL_GATEWAY_ISSUER_IDENTITY.cloudflareHyperdrive],
      publicUrlVariable: PUBLIC_URL,
    }).wrangler.hyperdrive,
  ).toEqual([
    { binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG },
    { binding: 'GATEWAY_ISSUER_HYPERDRIVE', id: GATEWAY_ISSUER_HYPERDRIVE_CONFIG },
  ]);
});

it('refuses a Worker build with no Hyperdrive, a duplicate binding or an identity without a Worker binding', () => {
  const values = reader(IDENTITY_BINDING_VALUES);
  expect(() => createCloudflareDataPlaneBindings(values, [])).toThrow(
    'A Cloudflare Worker build needs at least one Hyperdrive binding',
  );
  expect(() =>
    createCloudflareDataPlaneBindings(values, [
      SHARED_HYPERDRIVE,
      { binding: 'HYPERDRIVE', idVariable: PARTY_REGISTRY_HYPERDRIVE_ID },
    ]),
  ).toThrow('Hyperdrive binding HYPERDRIVE is declared more than once');
  expect(() =>
    createCloudflareDataPlaneBindings(values, [PARTY_REGISTRY_WORKER_IDENTITY.cloudflareHyperdrive]),
  ).toThrow('has no Worker Hyperdrive binding');
});

it('refuses a dedicated-identity Worker build without its Hyperdrive ID', () => {
  expect(() =>
    createCloudflareDataPlaneBindings(
      reader({
        [COMPOSITION_KV_ID]: COMPOSITION_KV,
        [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
        [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      }),
      [PARTY_REGISTRY_REQUEST_IDENTITY.cloudflareHyperdrive],
    ),
  ).toThrow(`${PARTY_REGISTRY_HYPERDRIVE_ID} is required for a Cloudflare Worker build`);
});

const appRoot = path.resolve(import.meta.dirname, '../..');
const PARTY_REGISTRY_APP_ID = 'party-registry';
const TopologyUnitSchema = Schema.Struct({ id: Schema.String, path: Schema.String });
const topology = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ shell: TopologyUnitSchema, verticals: Schema.Array(TopologyUnitSchema) })),
)(readFileSync(path.join(appRoot, 'topology/reference-topology.json'), 'utf-8'));
const readUnitConfig = (unitPath: string) => readFileSync(path.join(appRoot, unitPath, 'modern.config.ts'), 'utf-8');
const DEDICATED_IDENTITY_REFERENCE =
  /\b(?:PARTY_REGISTRY_REQUEST_IDENTITY|PARTY_REGISTRY_WORKER_IDENTITY|SHELL_GATEWAY_ISSUER_IDENTITY)\b/u;

it('loads database identity facts from pure data modules in every Modern configuration', () => {
  for (const unit of [topology.shell, ...topology.verticals]) {
    const config = readUnitConfig(unit.path);
    expect(config, unit.id).toContain(
      unit.id === PARTY_REGISTRY_APP_ID
        ? "from '../../packages/party-registry-identity-contracts/src/database-identity-data.ts'"
        : "from '../../packages/core-runtime/src/db/database-identity-data.ts'",
    );
    expect(config, unit.id).not.toContain('/database-identity-manifest');
    expect(config, unit.id).not.toContain('/database-identities');
  }
});

// Each unit's Worker binds the Hyperdrives of exactly the database identities it serves: Party only
// its request identity, the Shell the shared runtime and the gateway issuer, every other unit only the
// shared runtime identity.
it('declares each unit Worker Hyperdrive from the database identities it serves', () => {
  const party = topology.verticals.find((unit) => unit.id === PARTY_REGISTRY_APP_ID);
  expect(party).toBeDefined();
  const partyConfig = readUnitConfig(party?.path ?? '');
  expect(partyConfig).toMatch(
    /(?:cloudflareHyperdrives|hyperdrives):\s*\[\s*PARTY_REGISTRY_REQUEST_IDENTITY\.cloudflareHyperdrive\s*\]/u,
  );
  expect(partyConfig).not.toMatch(/\b(?:SHARED_RUNTIME_IDENTITY|SHELL_GATEWAY_ISSUER_IDENTITY)\b/u);

  const shellConfig = readUnitConfig(topology.shell.path);
  expect(shellConfig).toMatch(
    /(?:cloudflareHyperdrives|hyperdrives):\s*\[\s*SHARED_RUNTIME_IDENTITY\.cloudflareHyperdrive,\s*SHELL_GATEWAY_ISSUER_IDENTITY\.cloudflareHyperdrive,?\s*\]/u,
  );
  expect(shellConfig).not.toMatch(/\bPARTY_REGISTRY_(?:REQUEST|WORKER)_IDENTITY\b/u);

  for (const unit of topology.verticals.filter(({ id }) => id !== PARTY_REGISTRY_APP_ID)) {
    const config = readUnitConfig(unit.path);
    expect(config, unit.id).toMatch(
      /(?:cloudflareHyperdrives|hyperdrives):\s*\[\s*SHARED_RUNTIME_IDENTITY\.cloudflareHyperdrive\s*\]/u,
    );
    expect(config, unit.id).not.toMatch(DEDICATED_IDENTITY_REFERENCE);
  }
});

it('places every DEMO and upstream unit with each dedicated Hyperdrive ID variable provisioning writes', () => {
  const placement = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        buildEnvironment: Schema.Record(Schema.String, Schema.String),
        units: Schema.Array(Schema.String),
      }),
    ),
  )(readFileSync(path.join(appRoot, 'topology/cloudflare-placement.json'), 'utf-8'));
  expect(placement.units).toHaveLength(topology.verticals.length + 1);
  expect(EffectArray.sort(placement.units, Order.String)).toEqual(
    EffectArray.sort([topology.shell.id, ...topology.verticals.map(({ id }) => id)], Order.String),
  );
  // Empty until cloudflare-stage-cutover.mts provision writes the account's IDs; a unit build then fails closed.
  for (const variable of [HYPERDRIVE_ID, PARTY_REGISTRY_HYPERDRIVE_ID, GATEWAY_ISSUER_HYPERDRIVE_ID]) {
    expect(placement.buildEnvironment[variable]).toMatch(/^(?:[a-f0-9]{32})?$/u);
  }
});

// Exercise Modern's actual jiti dependency in a fresh process, outside Rstest's ESM bundler.
it('loads the canonical identity facts synchronously and every Modern configuration through jiti', () => {
  const units = [topology.shell, ...topology.verticals];
  const loaded = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { createRequire } from 'node:module';
        import path from 'node:path';
        const require = createRequire(import.meta.url);
        const appToolsRequire = createRequire(require.resolve('@modern-js/app-tools'));
        const pluginRequire = createRequire(appToolsRequire.resolve('@modern-js/plugin'));
        const { createJiti } = pluginRequire('jiti');
        const jiti = createJiti(import.meta.url, { fsCache: false, requireCache: false, interopDefault: true });
        const facts = jiti('./packages/core-runtime/src/db/database-identity-data.ts');
        if (!facts.SHARED_RUNTIME_IDENTITY || !facts.SHELL_GATEWAY_ISSUER_IDENTITY) throw new Error('Missing canonical Core database identities');
        const partyFacts = jiti('./packages/party-registry-identity-contracts/src/database-identity-data.ts');
        if (!partyFacts.PARTY_REGISTRY_REQUEST_IDENTITY || !partyFacts.PARTY_REGISTRY_WORKER_IDENTITY) throw new Error('Missing Party database identities');
        if (partyFacts.PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.request !== partyFacts.PARTY_REGISTRY_REQUEST_IDENTITY ||
            partyFacts.PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.worker !== partyFacts.PARTY_REGISTRY_WORKER_IDENTITY) throw new Error('Duplicated Party identity facts');
        const units = JSON.parse(process.argv[1]);
        for (const unit of units) {
          const configuration = await jiti.import(path.resolve(unit.path, 'modern.config.ts'));
          if (!(configuration.default ?? configuration)) throw new Error('Missing Modern configuration');
          console.log(unit.id);
        }
      `,
      JSON.stringify(units),
    ],
    { cwd: appRoot, encoding: 'utf-8', timeout: 90_000 },
  );
  expect(loaded.trim().split('\n')).toEqual(units.map(({ id }) => id));
});
