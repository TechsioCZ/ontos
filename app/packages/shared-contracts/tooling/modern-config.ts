import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import {
  getOrElse as getOptionOrElse,
  getOrUndefined as getOptionOrUndefined,
  isNone as isOptionNone,
  toArray as optionToArray,
} from 'effect/Option';
import type { Option } from 'effect/Option';
import { getOrThrow as getResultOrThrow, isSuccess as isResultSuccess } from 'effect/Result';
import {
  Array as ArraySchema,
  Literals,
  OptionFromNullOr,
  OptionFromUndefinedOr,
  String as StringSchema,
  Struct,
  Trim,
  check,
  decodeUnknownResult,
  isMinLength,
  makeFilter,
} from 'effect/Schema';

import type {
  CloudflareHyperdriveBinding,
  DatabaseIdentity,
} from '../../core-runtime/src/db/database-identity-manifest.ts';

type BuildEnvironmentReader = (name: string) => string | undefined;

/**
 * The Hyperdrive bindings a Worker build declares: the `cloudflareHyperdrive` of each database
 * identity the Worker serves. `null` marks an identity without a Worker binding and fails the build.
 */
type CloudflareHyperdriveBuildBindings = readonly DatabaseIdentity['cloudflareHyperdrive'][];

const NonEmptyBuildStringSchema = OptionFromUndefinedOr(Trim.pipe(check(isMinLength(1))));

/** Reads a build input from the framework build environment; blank values count as unset. */
const readBuildEnvironmentValue: BuildEnvironmentReader = (name) => {
  const decoded = decodeUnknownResult(NonEmptyBuildStringSchema)(getBuildConfigEnvironment(name));
  return isResultSuccess(decoded) ? getOptionOrUndefined(decoded.success) : undefined;
};

interface DevelopmentMiddlewareSetup {
  unshift: (
    middleware: (
      request: { url?: string | undefined },
      response: { end: (body: Buffer) => void; setHeader: (name: string, value: string) => void },
      next: () => void,
    ) => void,
  ) => void;
}

/** Serves the unit's prepared development module contract ahead of locale redirects. */
export const createDevelopmentContractMiddleware = (moduleUrl: string) => {
  const contractPath = fileURLToPath(new URL('.dev-public/.well-known/ontos-module-manifest.json', moduleUrl));
  return ({ unshift }: DevelopmentMiddlewareSetup) => {
    unshift((request, response, next) => {
      if (request.url?.split('?', 1)[0] !== '/.well-known/ontos-module-manifest.json') {
        next();
        return;
      }
      const contract = readFileSync(contractPath);
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Length', String(contract.byteLength));
      response.end(contract);
    });
  };
};

const requiredCloudflareBuildValue = (envValue: BuildEnvironmentReader, name: string): string =>
  getResultOrThrow(
    decodeUnknownResult(
      Trim.pipe(check(isMinLength(1, { message: `${name} is required for a Cloudflare Worker build` }))),
    )(envValue(name) ?? ''),
  );

const DeclaredCloudflareHyperdrivesSchema = ArraySchema(
  OptionFromNullOr(Struct({ binding: StringSchema, idVariable: StringSchema })),
).pipe(
  check(
    isMinLength(1, { message: 'A Cloudflare Worker build needs at least one Hyperdrive binding' }),
    makeFilter((hyperdrives: readonly Option<CloudflareHyperdriveBinding>[]) =>
      hyperdrives.some(isOptionNone)
        ? 'A Cloudflare Worker build names a database identity that has no Worker Hyperdrive binding'
        : undefined,
    ),
    makeFilter((hyperdrives: readonly Option<CloudflareHyperdriveBinding>[]) => {
      const bindings = hyperdrives.flatMap(optionToArray).map(({ binding }) => binding);
      const duplicate = bindings.find((binding, index) => bindings.indexOf(binding) !== index);
      return duplicate === undefined ? undefined : `Hyperdrive binding ${duplicate} is declared more than once`;
    }),
  ),
);

const declaredCloudflareHyperdrives = (declared: CloudflareHyperdriveBuildBindings) =>
  getResultOrThrow(decodeUnknownResult(DeclaredCloudflareHyperdrivesSchema)(declared)).flatMap(optionToArray);

const cloudflareHyperdriveBindings = (envValue: BuildEnvironmentReader, declared: CloudflareHyperdriveBuildBindings) =>
  declaredCloudflareHyperdrives(declared).map(({ binding, idVariable }) => ({
    binding,
    id: requiredCloudflareBuildValue(envValue, idVariable),
  }));

/**
 * Every OntOS Worker reaches the private data plane through account objects: PostgreSQL through one
 * Hyperdrive binding per database identity it serves (`HYPERDRIVE` for the shared runtime role, read
 * by Core's `#database-runtime`), and SpiceDB's HTTP gateway through the `SPICEDB` Workers VPC binding
 * (Core's `#spicedb-transport`). It reads the published active Application Composition from the
 * `ONTOS_ACTIVE_APPLICATION_COMPOSITION` Workers KV binding through Core's conditional public source
 * module. Their IDs are reviewed build inputs.
 */
export const createCloudflareDataPlaneBindings = (
  envValue: BuildEnvironmentReader,
  hyperdrives: CloudflareHyperdriveBuildBindings,
) => ({
  vpcServices: [
    {
      binding: 'SPICEDB',
      serviceId: requiredCloudflareBuildValue(envValue, 'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID'),
    },
  ],
  wrangler: {
    hyperdrive: cloudflareHyperdriveBindings(envValue, hyperdrives),
    kv_namespaces: [
      {
        binding: 'ONTOS_ACTIVE_APPLICATION_COMPOSITION',
        id: requiredCloudflareBuildValue(envValue, 'ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID'),
      },
    ],
  },
});

/**
 * CPU budgets per invocation. Workers Paid includes 30M CPU ms a month, so a runaway request is cut
 * off here instead of billed. An API vertical does a few database and SpiceDB round trips (waiting on
 * I/O is not CPU time), and the Shell also renders SSR, so it gets twice the vertical budget.
 *
 * Every BFF request builds and disposes the whole Effect HTTP API runtime, because workerd ties I/O
 * objects to the request that created them, so its CPU cost grows with the API's endpoint count.
 * Catalog (about 200 endpoints) and commerce-customer-context (about 115) spend far more than 100 ms
 * per request, while the next largest vertical has about 20. Workers analytics on stage (72 h, µs
 * rounded to ms): successful requests peaked at 1590 ms (Catalog) and 2015 ms (commerce-customer-context),
 * and the requests Cloudflare cut off had already spent up to 2539 ms. `largeApiVertical` is the
 * smallest round cap above all of them. Raise a cap only with a measured p99 from Workers analytics.
 */
export const CLOUDFLARE_WORKER_CPU_MS = { largeApiVertical: 3000, shell: 200, vertical: 100 } as const;

/**
 * Workers Logs per deployment environment. Every Worker build states its setting, so a deploy never
 * keeps whatever the dashboard last had. The edge deploy sets `ULTRAMODERN_DEPLOYMENT_ENVIRONMENT`;
 * a build without it (a local preview or a CI proof) deploys nowhere and keeps logs off.
 *
 * Stage keeps every invocation: Workers Paid includes 20M log events a month for the account, and
 * stage served about 7.8k Worker invocations a day on its busiest day (Workers analytics,
 * 2026-09-30), about 0.25M a month. Even at ten log lines per invocation that stays near 2.5M events.
 * Lower `head_sampling_rate` only with a measured event count from the Workers Logs telemetry API.
 * Production does not run on Cloudflare yet; its cutover must choose a measured rate here.
 */
export const CLOUDFLARE_WORKER_OBSERVABILITY = {
  development: { enabled: false },
  production: { enabled: false },
  stage: { enabled: true, head_sampling_rate: 1 },
} as const;

const CloudflareDeploymentEnvironmentSchema = OptionFromUndefinedOr(Literals(['stage', 'production']));

/** The Workers Logs setting for the deployment environment this Worker build is for. */
const resolveCloudflareWorkerObservability = (envValue: BuildEnvironmentReader) =>
  CLOUDFLARE_WORKER_OBSERVABILITY[
    getOptionOrElse(
      getResultOrThrow(
        decodeUnknownResult(CloudflareDeploymentEnvironmentSchema)(envValue('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')),
      ),
      () => 'development' as const,
    )
  ];

/**
 * The data plane plus the cost guards every OntOS Worker carries: it answers only on its reviewed
 * custom domain, the hostname of `publicUrlVariable` (no `*.workers.dev` route and no preview URLs,
 * which would bypass the stage zone's WAF kill switch), and stops after `cpuMs` of CPU per request.
 * Wrangler creates the custom domain's DNS record and certificate on deploy. Workers Logs follow
 * the deployment environment (`CLOUDFLARE_WORKER_OBSERVABILITY`).
 */
export const createCloudflareWorkerConfig = (
  envValue: BuildEnvironmentReader,
  {
    cpuMs,
    hyperdrives,
    publicUrlVariable,
  }: {
    readonly cpuMs: number;
    readonly hyperdrives: CloudflareHyperdriveBuildBindings;
    readonly publicUrlVariable: string;
  },
) => {
  const dataPlane = createCloudflareDataPlaneBindings(envValue, hyperdrives);
  const customDomain = new URL(requiredCloudflareBuildValue(envValue, publicUrlVariable)).hostname;
  return {
    ...dataPlane,
    wrangler: {
      ...dataPlane.wrangler,
      compatibility_flags: ['global_fetch_strictly_public'],
      limits: { cpu_ms: cpuMs },
      observability: resolveCloudflareWorkerObservability(envValue),
      preview_urls: false,
      routes: [{ custom_domain: true, pattern: customDomain }],
      workers_dev: false,
    },
  };
};

/** OntOS data-plane policy and module discovery, composed with the published workspace preset. */
export const createWorkspaceModernConfig = ({
  appId,
  cloudflareCpuMs = CLOUDFLARE_WORKER_CPU_MS.vertical,
  cloudflareHyperdrives,
  headless = false,
  moduleUrl,
}: {
  appId: string;
  cloudflareCpuMs?: number;
  /** The Hyperdrive bindings of the database identities this unit's Worker serves. */
  cloudflareHyperdrives: CloudflareHyperdriveBuildBindings;
  /**
   * An `api-only` topology unit keeps domain code in `src/`, so it points Modern's web entries at an
   * absent directory and builds only its BFF.
   */
  headless?: boolean;
  moduleUrl: string;
}) => ({
  ...(resolveDeployTarget().target === 'cloudflare'
    ? {
        deploy: {
          worker: createCloudflareWorkerConfig(readBuildEnvironmentValue, {
            cpuMs: cloudflareCpuMs,
            hyperdrives: cloudflareHyperdrives,
            publicUrlVariable: `ULTRAMODERN_PUBLIC_URL_${appId.replaceAll('-', '_').toUpperCase()}`,
          }),
        },
      }
    : undefined),
  dev: {
    setupMiddlewares: appId === 'shell-super-app' ? [] : [createDevelopmentContractMiddleware(moduleUrl)],
  },
  server: {
    publicDir: ['./.dev-public'],
  },
  source: {
    ...(headless ? { entriesDir: '.api-only-no-web-entry' } : undefined),
    globalVars: {
      ULTRAMODERN_SHELL_ORIGIN: readBuildEnvironmentValue('ULTRAMODERN_MF_DEV_ORIGIN') ?? 'http://localhost:3020',
    },
  },
});
