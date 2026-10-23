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
const PLACEMENT_HOST_VARIABLE = 'ULTRAMODERN_CLOUDFLARE_PLACEMENT_HOST';
const PLACEMENT_HOST = 'backend.example.com:443';
const GeneratedWranglerObservabilitySchema = Schema.Struct({
  name: Schema.String,
  observability: Schema.Unknown,
  placement: Schema.Struct({ host: Schema.String }),
});

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

  expect(createCloudflareWorkerConfig(values, { publicUrlVariable: PUBLIC_URL })).toEqual({
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
      [PUBLIC_URL]: 'https://ontos-stage-catalog.stage.example.com',
      [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      ...deploymentEnvironment,
    }),
    { publicUrlVariable: PUBLIC_URL },
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
      [PLACEMENT_HOST_VARIABLE]: PLACEMENT_HOST,
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
  expect(wrangler).toEqual({ name: PRICING_WORKER, observability, placement: { host: PLACEMENT_HOST } });
});

it('refuses a Worker build without its public URL', () => {
  const values = reader({
    [COMPOSITION_KV_ID]: COMPOSITION_KV,
    [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
    [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
  });

  expect(() => createCloudflareWorkerConfig(values, { publicUrlVariable: PUBLIC_URL })).toThrow(
    `${PUBLIC_URL} is required for a Cloudflare Worker build`,
  );
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

it('generates Commerce without a retired mutable owner binding while preserving native infrastructure bindings', () => {
  const appId = 'commerce-customer-context';
  const cloudflareWorkerName = `app-${appId}`;
  const publicUrlVariable = 'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT';
  const build = createModernBuildContext({
    appId,
    cloudflarePublicUrlEnvironmentVariable: publicUrlVariable,
    cloudflareWorkerName,
    defaultPort: 3998,
    deployTarget: 'cloudflare',
    getBuildConfigEnvironment: reader({
      [COMPOSITION_KV_ID]: COMPOSITION_KV,
      [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
      [publicUrlVariable]: 'https://ontos-stage-commerce-customer-context.stage.example.com',
      [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
    }),
    portEnvironmentVariable: 'COMMERCE_CUSTOMER_CONTEXT_PORT',
  });
  const { deploy } = createModernConfig({
    appId,
    bffPrefix: '/commerce-customer-context-api',
    build,
    chunkLoadingGlobal: '__COMMERCE_CUSTOMER_CONTEXT__',
    cloudflareWorkerName,
    moduleUrl: import.meta.url,
    plugins: [],
    uniqueName: appId,
  });
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
    compatibility_flags: ['global_fetch_strictly_public', 'nodejs_compat'],
    hyperdrive: [{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }],
    kv_namespaces: [COMPOSITION_BINDING],
    vpc_services: [{ binding: 'SPICEDB', service_id: SPICEDB_VPC_SERVICE }],
  });
});
