import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findFirst } from 'effect/Array';
import {
  getOrElse as getOptionOrElse,
  getOrThrow as getOptionOrThrow,
  getOrUndefined as getOptionOrUndefined,
} from 'effect/Option';
import { getOrThrow as getResultOrThrow, isSuccess as isResultSuccess } from 'effect/Result';
import {
  Array as SchemaArray,
  Boolean as BooleanSchema,
  Literal,
  Literals,
  NonEmptyString,
  NumberFromString,
  OptionFromUndefinedOr,
  Record as SchemaRecord,
  String as SchemaString,
  Struct,
  Trim,
  check,
  decodeTo,
  decodeUnknownResult,
  fromJsonString,
  isBetween,
  isInt,
  isMinLength,
  optionalKey,
} from 'effect/Schema';
import { transform } from 'effect/SchemaTransformation';

const nodeBuiltinRequests = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

interface ExternalRequest {
  dependencyType?: string;
  request?: string;
}
type ExternalResult = [error?: Error | undefined, result?: string | string[], type?: 'module-import'];

export const resolveCloudflareExternal = (
  { dependencyType, request }: ExternalRequest,
  includeNodeBuiltins = true,
): ExternalResult => {
  if (request === undefined) {
    return [];
  }
  const isNodeBuiltin = includeNodeBuiltins && nodeBuiltinRequests.has(request);
  if (request !== 'cloudflare:sockets' && !isNodeBuiltin) {
    return [];
  }
  const specifier = isNodeBuiltin && !request.startsWith('node:') ? `node:${request}` : request;
  const nativeImport = dependencyType?.startsWith('commonjs') === true ? [specifier, 'default'] : specifier;
  return [undefined, nativeImport, 'module-import'];
};

/* oxlint-disable promise/prefer-await-to-callbacks -- Rspack externals use a callback API. expires: 2026-12-31. */
const createCloudflareRuntimeExternal =
  (includeNodeBuiltins: boolean) =>
  (request: ExternalRequest, callback: (error?: Error, result?: string | string[], type?: 'module-import') => void) => {
    callback(...resolveCloudflareExternal(request, includeNodeBuiltins));
  };
/* oxlint-enable promise/prefer-await-to-callbacks */

const nonEmptyBuildStringSchema = Trim.pipe(check(isMinLength(1)));
const buildBooleanSchema = Literals(['true', 'yes', 'on', '1', 'y', 'false', 'no', 'off', '0', 'n']).pipe(
  decodeTo(
    BooleanSchema,
    transform({
      decode: (value) => value === 'true' || value === 'yes' || value === 'on' || value === '1' || value === 'y',
      encode: (value) => (value ? 'true' : 'false'),
    }),
  ),
);

interface ModernBuildContext {
  assetPrefix: string;
  buildCacheDirectory: string;
  buildOutputRoot: string;
  buildTarget: 'cloudflare' | 'web';
  buildTempDirectory: string;
  cloudflareDeployEnabled: boolean;
  cloudflarePublicUrlEnvironmentVariable: string;
  envValue: (name: string) => string | undefined;
  getBuildBoolean: (name: string) => boolean;
  moduleFederationDevServerOrigin: string;
  port: number;
  siteUrl: string;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- The framework build-environment callback is an untyped configuration boundary whose values are decoded by the local readers before use.
type BuildConfigEnvironment = (name: string) => unknown;

const createBuildConfigReaders = (getBuildConfigEnvironment: BuildConfigEnvironment) => {
  const envValue = (name: string): string | undefined => {
    const decoded = decodeUnknownResult(OptionFromUndefinedOr(nonEmptyBuildStringSchema))(
      getBuildConfigEnvironment(name),
    );
    return isResultSuccess(decoded) ? getOptionOrUndefined(decoded.success) : undefined;
  };
  const getBuildBoolean = (name: string): boolean =>
    getOptionOrElse(
      getResultOrThrow(decodeUnknownResult(OptionFromUndefinedOr(buildBooleanSchema))(getBuildConfigEnvironment(name))),
      () => false,
    );
  return { envValue, getBuildBoolean };
};

const getBuildPort = (
  getBuildConfigEnvironment: BuildConfigEnvironment,
  portEnvironmentVariable: string,
  defaultPort: number,
): number =>
  getOptionOrElse(
    getResultOrThrow(
      decodeUnknownResult(
        OptionFromUndefinedOr(NumberFromString.pipe(check(isInt(), isBetween({ maximum: 65_535, minimum: 1 })))),
      )(getBuildConfigEnvironment(portEnvironmentVariable)),
    ),
    () => defaultPort,
  );

const inferCloudflareUrl = (
  cloudflareDeployEnabled: boolean,
  cloudflareWorkerName: string,
  cloudflareWorkersDevSubdomain: string | undefined,
): string | undefined =>
  cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
    ? `https://${cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`
    : undefined;

const getDefaultRemoteAssetPrefix = (
  configuredCloudflareUrl: string | undefined,
  inferredCloudflareUrl: string | undefined,
  cloudflareDeployEnabled: boolean,
  port: number,
): string => {
  const remoteAssetOrigin =
    configuredCloudflareUrl ?? inferredCloudflareUrl ?? (cloudflareDeployEnabled ? '' : `http://localhost:${port}`);
  return remoteAssetOrigin.length > 0 ? `${remoteAssetOrigin.replace(/\/+$/u, '')}/` : 'auto';
};

export const createModernBuildContext = ({
  appId,
  cloudflarePublicUrlEnvironmentVariable,
  cloudflareWorkerName,
  defaultPort,
  deployTarget,
  getBuildConfigEnvironment,
  portEnvironmentVariable,
}: {
  appId: string;
  cloudflarePublicUrlEnvironmentVariable: string;
  cloudflareWorkerName: string;
  defaultPort: number;
  /** `resolveDeployTarget().target` from `@modern-js/app-tools-extensions/config`. */
  deployTarget: string;
  getBuildConfigEnvironment: BuildConfigEnvironment;
  portEnvironmentVariable: string;
}): ModernBuildContext => {
  const { envValue, getBuildBoolean } = createBuildConfigReaders(getBuildConfigEnvironment);
  const cloudflareDeployEnabled = deployTarget === 'cloudflare';
  const port = getBuildPort(getBuildConfigEnvironment, portEnvironmentVariable, defaultPort);
  const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
  const configuredCloudflareUrl = envValue(cloudflarePublicUrlEnvironmentVariable);
  const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX');
  const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX');
  const moduleFederationDevServerOrigin = envValue('ULTRAMODERN_MF_DEV_ORIGIN') ?? 'http://localhost:3020';
  const cloudflareWorkersDevSubdomain = envValue('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
  const inferredCloudflareUrl = inferCloudflareUrl(
    cloudflareDeployEnabled,
    cloudflareWorkerName,
    cloudflareWorkersDevSubdomain,
  );
  // Site origin (SEO: canonical/hreflang URLs) prefers the site-wide public URL;
  // the per-app deployment URL only fills in when no site origin is configured.
  const siteUrl = configuredSiteUrl ?? configuredCloudflareUrl ?? inferredCloudflareUrl ?? `http://localhost:${port}`;
  // When deploying to Cloudflare without a configured public URL, publish an
  // 'auto' publicPath so the remote resolves its chunks from the origin its
  // remoteEntry.js was loaded from (the vertical's Worker), not the host shell's
  // origin — otherwise cross-origin chunk loading 404s and MF reports an empty
  // moduleId. A configured/inferred URL still wins as an absolute prefix.
  const defaultRemoteAssetPrefix = getDefaultRemoteAssetPrefix(
    configuredCloudflareUrl,
    inferredCloudflareUrl,
    cloudflareDeployEnabled,
    port,
  );
  const assetPrefix = configuredModernAssetPrefix ?? configuredUltramodernAssetPrefix ?? defaultRemoteAssetPrefix;
  const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';
  const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';
  const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;
  // oxlint-disable-next-line github/js-class-name -- This interpolated value is a filesystem directory name required by Modern.js, not a CSS class name.
  const buildTempDirectory = `node_modules/.modern-js-${appId}-${buildTarget}`;

  return {
    assetPrefix,
    buildCacheDirectory,
    buildOutputRoot,
    buildTarget,
    buildTempDirectory,
    cloudflareDeployEnabled,
    cloudflarePublicUrlEnvironmentVariable,
    envValue,
    getBuildBoolean,
    moduleFederationDevServerOrigin,
    port,
    siteUrl,
  };
};

export const installGlobalRequire = (moduleUrl: string) => {
  Object.assign(globalThis, { require: createRequire(moduleUrl) });
};

interface DevelopmentMiddlewareSetup {
  unshift: (
    middleware: (
      request: { url?: string },
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

const requiredCloudflareBuildValue = (envValue: ModernBuildContext['envValue'], name: string): string =>
  getResultOrThrow(
    decodeUnknownResult(
      Trim.pipe(check(isMinLength(1, { message: `${name} is required for a Cloudflare Worker build` }))),
    )(envValue(name) ?? ''),
  );

/**
 * Every OntOS Worker reaches the private data plane through two account objects: PostgreSQL through
 * the `HYPERDRIVE` binding (Core's `#database-runtime`) and SpiceDB's HTTP gateway through the
 * `SPICEDB` Workers VPC binding (Core's `#spicedb-transport`). It reads the published active
 * Application Composition from the `ONTOS_ACTIVE_APPLICATION_COMPOSITION` Workers KV binding (Core's
 * `#active-application-composition-source`). Their IDs are reviewed build inputs.
 */
export const createCloudflareDataPlaneBindings = (envValue: ModernBuildContext['envValue']) => ({
  vpcServices: [
    {
      binding: 'SPICEDB',
      serviceId: requiredCloudflareBuildValue(envValue, 'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID'),
    },
  ],
  wrangler: {
    hyperdrive: [
      { binding: 'HYPERDRIVE', id: requiredCloudflareBuildValue(envValue, 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID') },
    ],
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
const resolveCloudflareWorkerObservability = (envValue: ModernBuildContext['envValue']) =>
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
  envValue: ModernBuildContext['envValue'],
  { cpuMs, publicUrlVariable }: { readonly cpuMs: number; readonly publicUrlVariable: string },
) => {
  const dataPlane = createCloudflareDataPlaneBindings(envValue);
  const customDomain = new URL(requiredCloudflareBuildValue(envValue, publicUrlVariable)).hostname;
  return {
    ...dataPlane,
    wrangler: {
      ...dataPlane.wrangler,
      limits: { cpu_ms: cpuMs },
      observability: resolveCloudflareWorkerObservability(envValue),
      preview_urls: false,
      routes: [{ custom_domain: true, pattern: customDomain }],
      workers_dev: false,
    },
  };
};

/** A Worker service binding to another OntOS unit's Worker, named as in the reference topology. */
export interface CloudflareUnitServiceBinding {
  readonly binding: string;
  readonly service: string;
}

const UnitServiceBindingTopologySchema = Struct({
  verticals: SchemaArray(
    Struct({
      backendFederation: Struct({
        executionSurfaces: Struct({
          cloudflare: Struct({ workerDispatch: Struct({ serviceBinding: NonEmptyString }) }),
        }),
      }),
      cloudflare: Struct({ workerName: NonEmptyString }),
      id: NonEmptyString,
    }),
  ),
});
const UnitServiceBindingPlacementSchema = Struct({
  unitServiceBindings: optionalKey(SchemaRecord(SchemaString, SchemaArray(SchemaString))),
});
const topologyDocumentUrl = (name: string) => new URL(`../../../topology/${name}`, import.meta.url);

/**
 * The service bindings a placed unit's Worker declares to the other units it calls, from the
 * reviewed placement (`unitServiceBindings`) and each target's topology binding and Worker names.
 * The deploy planner reads the same placement to deploy every target before its consumer.
 */
const readCloudflareUnitServiceBindings = (appId: string): readonly CloudflareUnitServiceBinding[] => {
  const placement = getResultOrThrow(
    decodeUnknownResult(fromJsonString(UnitServiceBindingPlacementSchema))(
      readFileSync(topologyDocumentUrl('cloudflare-placement.json'), 'utf-8'),
    ),
  );
  const topology = getResultOrThrow(
    decodeUnknownResult(fromJsonString(UnitServiceBindingTopologySchema))(
      readFileSync(topologyDocumentUrl('reference-topology.json'), 'utf-8'),
    ),
  );
  return (placement.unitServiceBindings?.[appId] ?? []).map((target) => {
    // The deploy planner rejects a binding to a unit that is not a placed vertical.
    const vertical = getOptionOrThrow(findFirst(topology.verticals, ({ id }) => id === target));
    return {
      binding: vertical.backendFederation.executionSurfaces.cloudflare.workerDispatch.serviceBinding,
      service: vertical.cloudflare.workerName,
    };
  });
};

const createCloudflareDeployment = (
  build: ModernBuildContext,
  worker: {
    readonly cpuMs: number;
    readonly name: string;
    readonly unitServiceBindings: readonly CloudflareUnitServiceBinding[];
  },
) =>
  build.cloudflareDeployEnabled
    ? {
        deploy: {
          worker: {
            ...createCloudflareWorkerConfig(build.envValue, {
              cpuMs: worker.cpuMs,
              publicUrlVariable: build.cloudflarePublicUrlEnvironmentVariable,
            }),
            compatibilityDate: '2026-06-02',
            name: worker.name,
            security: createCloudflareWorkerSecurity(),
            services: worker.unitServiceBindings.map(({ binding, service }) => ({ binding, service })),
            ssr: true,
          },
        },
      }
    : undefined;

interface RspackConfiguration {
  externals?: unknown;
  node?: false | object;
  plugins: unknown[];
}

/* oxlint-disable anti-slop/no-unknown-returns -- Rspack supplies opaque plugin constructors; their instances are forwarded unchanged to its generic plugin collection and are never inspected here. */
interface RspackContext {
  environment: { name: string };
  rspack: {
    DefinePlugin: new (definitions: Record<string, string>) => unknown;
    NormalModuleReplacementPlugin: new (
      pattern: RegExp,
      replace: (resource: { context: string; request: string }) => void,
    ) => unknown;
  };
}
/* oxlint-enable anti-slop/no-unknown-returns */

const createCloudflareRspack = (cloudflareDeployEnabled: boolean, sourceDirectory: string) => {
  const cloudflareRuntimeExternal = createCloudflareRuntimeExternal(cloudflareDeployEnabled);
  return (config: RspackConfiguration, { environment, rspack }: RspackContext) => {
    if (!cloudflareDeployEnabled) {
      return;
    }
    const configuredExternals = config.externals;
    const nextExternals = [cloudflareRuntimeExternal];
    if (configuredExternals !== undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Rspack's external configuration is intentionally opaque and is forwarded unchanged into its generic externals collection.
      nextExternals.push(...(Array.isArray(configuredExternals) ? configuredExternals : [configuredExternals]));
    }
    config.externals = nextExternals;
    if (environment.name !== 'workerSSR') {
      return;
    }
    const configuredNode = config.node;
    const nextNode = configuredNode === false || configuredNode === undefined ? {} : configuredNode;
    config.node = nextNode;
    Object.assign(nextNode, {
      __dirname: false,
      __filename: false,
    });
    config.plugins.push(...createWorkerSsrPlugins(rspack, sourceDirectory)); // oxlint-disable-line eslint/no-use-before-define -- The plugin factory remains beside the replacement helpers it closes over.
  };
};

/* oxlint-disable anti-slop/no-unknown-returns -- The framework-owned fluent chain return is intentionally opaque and ignored after configuring the chunk-loading global. */
interface BundlerChain {
  output: {
    uniqueName: (name: string) => { chunkLoadingGlobal: (name: string) => unknown };
  };
}
/* oxlint-enable anti-slop/no-unknown-returns */

export const createModernConfig = <Plugin, BuilderPlugin>({
  apiOnly = false,
  appId,
  bffPrefix,
  build,
  builderPlugins,
  chunkLoadingGlobal,
  cloudflareCpuMs = CLOUDFLARE_WORKER_CPU_MS.vertical,
  cloudflareWorkerName,
  moduleUrl,
  plugins,
  rsdoctorEnabled,
  uniqueName,
}: {
  apiOnly?: boolean;
  appId: string;
  bffPrefix: string;
  build: ModernBuildContext;
  builderPlugins?: BuilderPlugin[];
  chunkLoadingGlobal: string;
  cloudflareCpuMs?: number;
  cloudflareWorkerName: string;
  moduleUrl: string;
  plugins: Plugin[];
  rsdoctorEnabled?: boolean;
  uniqueName: string;
}) => {
  const appDevServerHeaders = {
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Origin': build.moduleFederationDevServerOrigin,
  };

  return {
    bff: {
      effect: {
        entry: './api/index',
        openapi: {
          path: '/openapi.json',
        },

        strictEffectApproach: true as const,
      },
      prefix: bffPrefix,
      runtimeFramework: 'effect' as const,
    },
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- This generic optional field retains the public factory's inferred return shape and its position in the emitted configuration.
    ...(builderPlugins === undefined ? {} : { builderPlugins }),
    ...createCloudflareDeployment(build, {
      cpuMs: cloudflareCpuMs,
      name: cloudflareWorkerName,
      unitServiceBindings: build.cloudflareDeployEnabled ? readCloudflareUnitServiceBindings(appId) : [],
    }),
    dev: {
      // Remote dev manifests must publish an absolute publicPath so host
      // shells load remoteEntry.js and exposed chunks from this dev server.
      assetPrefix: build.assetPrefix,
      server: {
        headers: appDevServerHeaders,
      },
      setupMiddlewares: [createDevelopmentContractMiddleware(moduleUrl)],
    },
    html: {
      outputStructure: 'flat' as const,
    },
    output: {
      assetPrefix: build.assetPrefix,
      // `pnpm typecheck` (tsc --build over the reference graph) owns type diagnostics.
      disableTsChecker: true,
      distPath: {
        html: './',
        root: build.buildOutputRoot,
      },
      polyfill: 'off' as const,
      splitRouteChunks: true,
      tempDir: build.buildTempDirectory,
    },
    performance: {
      buildCache: {
        cacheDigest: [appId, build.buildTarget],
        cacheDirectory: build.buildCacheDirectory,
      },
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- This optional nested field retains the public factory's inferred return shape and its position in the emitted configuration.
      ...(rsdoctorEnabled === undefined
        ? {}
        : {
            rsdoctor: {
              disableClientServer: true,
              enabled: rsdoctorEnabled,
            },
          }),
    },
    plugins,
    server: {
      port: build.port,
      publicDir: ['./locales', './assets', './.dev-public'],
    },
    source: {
      alias: {
        '@modern-js/plugin-i18n/runtime$': '@modern-js/plugin-i18n/runtime/no-react-i18next',
      },
      // Modern.js detects API-only apps from a missing entries directory. Keep
      // owner source under `src/`, while directing its web-entry scan to a path
      // that does not exist for API-only MicroVerticals.
      entriesDir: apiOnly ? '.api-only-no-web-entry' : undefined,
      globalVars: {
        ULTRAMODERN_SHELL_ORIGIN: build.moduleFederationDevServerOrigin,
        ULTRAMODERN_SITE_URL: build.siteUrl,
      },
      mainEntryName: 'index',
    },
    tools: {
      autoprefixer: {
        overrideBrowserslist: ['defaults'],
      },
      bundlerChain: (chain: BundlerChain) => {
        chain.output.uniqueName(uniqueName).chunkLoadingGlobal(chunkLoadingGlobal);
      },
      rspack: createCloudflareRspack(build.cloudflareDeployEnabled, fileURLToPath(new URL('api/', moduleUrl))),
    },
  };
};

// Zephyr uploads only for a deploy that provides ZE_CI_TOKEN; the deploy environment then sets
// ZE_FAIL_BUILD=true so a failed upload fails the build instead of shipping without it.
const zephyrFailBuildSchema = Literal('true').annotate({
  message:
    'ZE_CI_TOKEN is set but ZE_FAIL_BUILD is not "true", so a failed Zephyr upload would not fail the deploy. Set ZE_FAIL_BUILD=true in the deploy environment next to ZE_CI_TOKEN.',
});

export const createZephyrRspackPlugin = <Configuration>(options: {
  configure: () => Configuration;
  readEnvironment: (name: 'ZE_CI_TOKEN' | 'ZE_FAIL_BUILD') => string | undefined;
}) => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: { modifyRspackConfig: (configuration: Configuration) => void }) {
    // Ordinary builds need no Zephyr account or network access.
    if (options.readEnvironment('ZE_CI_TOKEN') === undefined) {
      return;
    }
    getResultOrThrow(decodeUnknownResult(zephyrFailBuildSchema)(options.readEnvironment('ZE_FAIL_BUILD')));
    api.modifyRspackConfig(options.configure());
  },
});

interface ReplacementResource {
  context: string;
  request: string;
}

const retainWorkerLoader = (resource: ReplacementResource) => {
  resource.request = resource.request.replace(/(?<separator>[?&])retain=[^&]*/u, '$<separator>retain=true');
};

const markWorkerApiSource = (resource: ReplacementResource, sourceDirectory: string) => {
  const [requestPath] = resource.request.split('?', 1);
  if (
    requestPath !== undefined &&
    path.resolve(resource.context, requestPath).startsWith(sourceDirectory) &&
    !resource.request.includes('modern-bff-runtime-source')
  ) {
    resource.request = `${resource.request}?modern-bff-runtime-source`;
  }
};

export const createWorkerSsrPlugins = <DefinitionPlugin, ReplacementPlugin>(
  rspack: {
    DefinePlugin: new (definitions: Record<string, string>) => DefinitionPlugin;
    NormalModuleReplacementPlugin: new (
      pattern: RegExp,
      replace: (resource: ReplacementResource) => void,
    ) => ReplacementPlugin;
  },
  sourceDirectory: string,
) => [
  new rspack.DefinePlugin({ 'globalThis.FinalizationRegistry': 'undefined' }),
  new rspack.NormalModuleReplacementPlugin(/[?&]loaderId=/u, retainWorkerLoader),
  new rspack.NormalModuleReplacementPlugin(/^\.\.?[/\\]/u, (resource) => {
    markWorkerApiSource(resource, sourceDirectory);
  }),
];
