import { readFileSync } from 'node:fs';

import { createWranglerConfig } from '@modern-js/app-tools-extensions/cloudflare/wrangler-config';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_BINDING } from '../../packages/core-runtime/src/modules/active-application-composition-edge.ts';
import {
  CLOUDFLARE_WORKER_CPU_MS,
  CLOUDFLARE_WORKER_OBSERVABILITY,
  createCloudflareDataPlaneBindings,
  createCloudflareWorkerConfig,
  createModernBuildContext,
  createModernConfig,
} from '../../packages/shared-contracts/tooling/modern-config.ts';
import { PRICE_GROUP_CATALOG_SERVICE_BINDING } from '../../verticals/commerce-customer-context/shared/deployment-paths.ts';

const HYPERDRIVE_ID = 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID';
const SPICEDB_VPC_SERVICE_ID = 'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID';
const COMPOSITION_KV_ID = 'ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID';
const HYPERDRIVE_CONFIG = 'hyperdrive-id';
const COMPOSITION_KV = 'composition-kv-id';
const COMPOSITION_BINDING = { binding: ACTIVE_APPLICATION_COMPOSITION_EDGE_BINDING, id: COMPOSITION_KV };
const SPICEDB_VPC_SERVICE = 'vpc-service-id';
const PUBLIC_URL = 'ULTRAMODERN_PUBLIC_URL_CATALOG';
const DEPLOYMENT_ENVIRONMENT = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';
const PRICING_PUBLIC_URL = 'ULTRAMODERN_PUBLIC_URL_PRICING';
const PRICING_WORKER = 'app-pricing';
const GeneratedWranglerObservabilitySchema = Schema.Struct({ name: Schema.String, observability: Schema.Unknown });

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
    [PUBLIC_URL]: 'https://ontos-stage-catalog.stage.example.com',
    [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
  });

  expect(
    createCloudflareWorkerConfig(values, { cpuMs: CLOUDFLARE_WORKER_CPU_MS.vertical, publicUrlVariable: PUBLIC_URL }),
  ).toEqual({
    vpcServices: [{ binding: 'SPICEDB', serviceId: SPICEDB_VPC_SERVICE }],
    wrangler: {
      hyperdrive: [{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }],
      kv_namespaces: [COMPOSITION_BINDING],
      limits: { cpu_ms: 100 },
      observability: { enabled: false },
      preview_urls: false,
      routes: [{ custom_domain: true, pattern: 'ontos-stage-catalog.stage.example.com' }],
      workers_dev: false,
    },
  });
  expect(
    createCloudflareWorkerConfig(values, { cpuMs: CLOUDFLARE_WORKER_CPU_MS.shell, publicUrlVariable: PUBLIC_URL })
      .wrangler.limits,
  ).toEqual({
    cpu_ms: 200,
  });
  expect(
    createCloudflareWorkerConfig(values, {
      cpuMs: CLOUDFLARE_WORKER_CPU_MS.largeApiVertical,
      publicUrlVariable: PUBLIC_URL,
    }).wrangler.limits,
  ).toEqual({
    cpu_ms: 3000,
  });
});

const workerConfigFor = (deploymentEnvironment: Readonly<Record<string, string>>) =>
  createCloudflareWorkerConfig(
    reader({
      [COMPOSITION_KV_ID]: COMPOSITION_KV,
      [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
      [PUBLIC_URL]: 'https://ontos-stage-catalog.stage.example.com',
      [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      ...deploymentEnvironment,
    }),
    { cpuMs: CLOUDFLARE_WORKER_CPU_MS.shell, publicUrlVariable: PUBLIC_URL },
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

it.each([
  ['stage', { enabled: true, head_sampling_rate: 1 }],
  ['production', { enabled: false }],
] as const)('writes the %s Workers Logs setting into the generated wrangler.json', (environment, observability) => {
  const build = createModernBuildContext({
    appId: 'pricing',
    cloudflarePublicUrlEnvironmentVariable: PRICING_PUBLIC_URL,
    cloudflareWorkerName: PRICING_WORKER,
    defaultPort: 3999,
    deployTarget: 'cloudflare',
    getBuildConfigEnvironment: reader({
      [COMPOSITION_KV_ID]: COMPOSITION_KV,
      [DEPLOYMENT_ENVIRONMENT]: environment,
      [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
      [PRICING_PUBLIC_URL]: 'https://ontos-stage-pricing.stage.example.com',
      [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
    }),
    portEnvironmentVariable: 'PRICING_PORT',
  });
  const modernConfig = createModernConfig({
    appId: 'pricing',
    bffPrefix: '/pricing-api',
    build,
    chunkLoadingGlobal: '__PRICING__',
    cloudflareWorkerName: PRICING_WORKER,
    moduleUrl: import.meta.url,
    plugins: [],
    uniqueName: 'pricing',
  });
  const { deploy } = modernConfig;
  expect(deploy).toBeDefined();
  const wrangler = Schema.decodeUnknownSync(GeneratedWranglerObservabilitySchema)(
    createWranglerConfig(process.cwd(), deploy === undefined ? {} : { deploy }),
  );
  expect(wrangler).toEqual({ name: PRICING_WORKER, observability });
});

it('refuses a Worker build without its public URL', () => {
  const values = reader({
    [COMPOSITION_KV_ID]: COMPOSITION_KV,
    [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
    [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
  });

  expect(() =>
    createCloudflareWorkerConfig(values, { cpuMs: CLOUDFLARE_WORKER_CPU_MS.vertical, publicUrlVariable: PUBLIC_URL }),
  ).toThrow(`${PUBLIC_URL} is required for a Cloudflare Worker build`);
});

it.each([
  [HYPERDRIVE_ID, { [COMPOSITION_KV_ID]: COMPOSITION_KV, [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE }],
  [SPICEDB_VPC_SERVICE_ID, { [COMPOSITION_KV_ID]: COMPOSITION_KV, [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG }],
  [COMPOSITION_KV_ID, { [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG, [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE }],
] as const)('refuses a Worker build without %s', (name, values) => {
  expect(() => createCloudflareDataPlaneBindings(reader(values))).toThrow(
    `${name} is required for a Cloudflare Worker build`,
  );
});

const readDocument = (name: string) => readFileSync(new URL(`../../topology/${name}`, import.meta.url), 'utf-8');

it("names Commerce's Price Group Catalog binding exactly as the topology and placement bind it", () => {
  const TopologySchema = Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        backendFederation: Schema.optionalKey(
          Schema.Struct({
            executionSurfaces: Schema.Struct({
              cloudflare: Schema.Struct({ workerDispatch: Schema.Struct({ serviceBinding: Schema.String }) }),
            }),
          }),
        ),
        id: Schema.String,
      }),
    ),
  });
  const PlacementSchema = Schema.Struct({
    unitServiceBindings: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  });
  const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
    readDocument('reference-topology.json'),
  );
  const placement = Schema.decodeUnknownSync(Schema.fromJsonString(PlacementSchema))(
    readDocument('cloudflare-placement.json'),
  );
  // The Worker config emits the target's topology binding; Commerce's routed fetch must ask for it.
  expect(placement.unitServiceBindings['commerce-customer-context']).toContain('price-group-catalog');
  expect(
    topology.verticals.find(({ id }) => id === 'price-group-catalog')?.backendFederation?.executionSurfaces.cloudflare
      .workerDispatch.serviceBinding,
  ).toBe(PRICE_GROUP_CATALOG_SERVICE_BINDING);
});
