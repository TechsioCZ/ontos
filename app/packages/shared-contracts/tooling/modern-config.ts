// @effect-diagnostics nodeBuiltinImport:off -- Build-time Modern config: Node's connect dev middleware, Rspack resolution and file URLs run outside any Effect runtime, and the effect barrel cannot load under jiti; expires: 2027-03-31.
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

const DEVELOPMENT_CONTRACT_ARTIFACTS: ReadonlySet<string> = new Set([
  '/.well-known/ontos-module-manifest.json',
  '/.well-known/ontos-module-mcp-tools.json',
]);

/** Serves the unit's prepared development module contract and its MCP tool catalog ahead of locale redirects. */
export const createDevelopmentContractMiddleware =
  (moduleUrl: string) =>
  ({ unshift }: DevelopmentMiddlewareSetup) => {
    unshift((request, response, next) => {
      const requestPath = request.url?.split('?', 1)[0];
      if (requestPath === undefined || !DEVELOPMENT_CONTRACT_ARTIFACTS.has(requestPath)) {
        next();
        return;
      }
      const contract = readFileSync(fileURLToPath(new URL(`.dev-public${requestPath}`, moduleUrl)));
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Length', String(contract.byteLength));
      response.end(contract);
    });
  };

export const createCloudflareWorkerSecurity = () => ({
  contentSecurityPolicy: {
    directives: {
      'base-uri': ["'self'"],
      'connect-src': ["'self'", 'https:', 'http:', 'wss:', 'ws:'],
      'default-src': ["'self'"],
      'font-src': ["'self'", 'data:', 'https:', 'http:'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
      'manifest-src': ["'self'", 'https:', 'http:'],
      'object-src': ["'none'"],
      'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https:', 'http:'],
      'worker-src': ["'self'", 'blob:'],
    },
    mode: 'report-only' as const,
    reason:
      'Report-only by default so Cloudflare Module Federation SSR can prove remote script, style, and connect compatibility before enforcement.',
  },
  enabled: true,
  headers: {
    contentTypeOptions: 'nosniff' as const,
    permissionsPolicy: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    referrerPolicy: 'strict-origin-when-cross-origin' as const,
  },
  noindex: {
    localhost: true,
    previewHostnames: [],
    workersDev: true,
  },
});

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

const CloudflareEmailSenderSchema = Trim.pipe(
  check(
    makeFilter(
      (sender) =>
        sender.length === 0 ||
        /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(sender) ||
        'ULTRAMODERN_EMAIL_SENDER must be a bare email address',
    ),
  ),
);

interface CloudflareEmailBindings {
  send_email?: { allowed_sender_addresses: string[]; name: string }[];
}

/** Shell-only opt-in: no Email Service binding is emitted without the onboarded sender build input. */
export const createCloudflareEmailBindings = (envValue: BuildEnvironmentReader): CloudflareEmailBindings => {
  const sender = getOptionOrUndefined(
    getResultOrThrow(
      decodeUnknownResult(OptionFromUndefinedOr(CloudflareEmailSenderSchema))(envValue('ULTRAMODERN_EMAIL_SENDER')),
    ),
  );
  if (sender === undefined || sender === '') {
    return {};
  }
  return { send_email: [{ allowed_sender_addresses: [sender], name: 'EMAIL' }] };
};

/**
 * CPU budget per invocation, one for every OntOS Worker (Shell and verticals alike). A request that
 * exceeds it fails with Cloudflare error 1102, which the caller sees as a 503, so the cap guards only
 * against runaway loops; the stage cost guard (`scripts/ops/cloudflare-stage-cost-guard.mts`) watches
 * the monthly CPU total.
 *
 * A request's CPU includes the first-request initialization of its isolate: the BFF bundle's module
 * graph is evaluated on the first BFF request, then the per-request Effect HTTP API runtime is built
 * (workerd ties I/O objects to the request that created them). At stage traffic most vertical requests
 * land on a cold isolate. Workers analytics and Workers Logs on stage (2026-10-22, 05:30-08:45 UTC):
 * vertical readiness requests spent 10-24 ms warm and 200-750 ms cold; reads p99 1-7 s, writes up to
 * 7.3 s; Shell p99 5 s, max 9.2 s. The former 100/200/3000 ms tiers cut off cold isolates with 1102,
 * and every deploy reset the higher limits set through the API. 30 s is the Workers Standard maximum.
 */
export const CLOUDFLARE_WORKER_CPU_MS = 30_000;

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
 * which would bypass the stage zone's WAF kill switch), and stops after `CLOUDFLARE_WORKER_CPU_MS` of CPU per request.
 * Wrangler creates the custom domain's DNS record and certificate on deploy. Workers Logs follow
 * the deployment environment (`CLOUDFLARE_WORKER_OBSERVABILITY`).
 */
export const createCloudflareWorkerConfig = (
  envValue: BuildEnvironmentReader,
  {
    hyperdrives,
    publicUrlVariable,
  }: {
    readonly hyperdrives: CloudflareHyperdriveBuildBindings;
    readonly publicUrlVariable: string;
  },
) => {
  const dataPlane = createCloudflareDataPlaneBindings(envValue, hyperdrives);
  // Backend-heavy Workers must not follow a distant caller away from the private data plane.
  // Placement probes a public single-homed endpoint, not a private VPC hostname.
  const placementHost = getOptionOrUndefined(
    getResultOrThrow(
      decodeUnknownResult(OptionFromUndefinedOr(Trim.pipe(check(isMinLength(1)))))(
        envValue('ULTRAMODERN_CLOUDFLARE_PLACEMENT_HOST'),
      ),
    ),
  );
  const placement: { readonly host: string } | { readonly mode: 'off' } =
    placementHost === undefined ? { mode: 'off' } : { host: placementHost };
  const customDomain = new URL(requiredCloudflareBuildValue(envValue, publicUrlVariable)).hostname;
  return {
    ...dataPlane,
    wrangler: {
      ...dataPlane.wrangler,
      compatibility_flags: ['global_fetch_strictly_public'],
      limits: { cpu_ms: CLOUDFLARE_WORKER_CPU_MS },
      observability: resolveCloudflareWorkerObservability(envValue),
      placement,
      preview_urls: false,
      routes: [{ custom_domain: true, pattern: customDomain }],
      workers_dev: false,
    },
  };
};

/** OntOS data-plane policy and module discovery, composed with the published workspace preset. */
export const createWorkspaceModernConfig = ({
  appId,
  cloudflareEmail = false,
  cloudflareHyperdrives,
  headless = false,
  moduleUrl,
}: {
  appId: string;
  /** This unit sends transactional mail through the Cloudflare Email Service binding. */
  cloudflareEmail?: boolean;
  /** The Hyperdrive bindings of the database identities this unit's Worker serves. */
  cloudflareHyperdrives: CloudflareHyperdriveBuildBindings;
  /**
   * An `api-only` topology unit keeps domain code in `src/`, so it points Modern's web entries at an
   * absent directory and builds only its BFF.
   */
  headless?: boolean;
  moduleUrl: string;
}) => {
  const cloudflareWorkerConfig = () => {
    const worker = createCloudflareWorkerConfig(readBuildEnvironmentValue, {
      hyperdrives: cloudflareHyperdrives,
      publicUrlVariable: `ULTRAMODERN_PUBLIC_URL_${appId.replaceAll('-', '_').toUpperCase()}`,
    });
    return {
      ...worker,
      wrangler: cloudflareEmail
        ? { ...worker.wrangler, ...createCloudflareEmailBindings(readBuildEnvironmentValue) }
        : worker.wrangler,
    };
  };
  return {
    ...(resolveDeployTarget().target === 'cloudflare'
      ? {
          deploy: {
            worker: cloudflareWorkerConfig(),
          },
        }
      : undefined),
    dev: {
      setupMiddlewares: appId === 'shell-super-app' ? [] : [createDevelopmentContractMiddleware(moduleUrl)],
    },
    output: {
      // The native TS-Go checker blocks every first compile on a check of the whole reference graph, which
      // holds a cold dev server past readiness budgets. Builds keep the checker; in `modern dev`,
      // `pnpm typecheck` owns type diagnostics.
      disableTsChecker: readBuildEnvironmentValue('NODE_ENV') === 'development',
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
  };
};
