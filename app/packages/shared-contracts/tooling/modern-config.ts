import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, Option, Result, Schema } from 'effect';

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

const nonEmptyBuildStringSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));

interface ModernBuildContext {
  assetPrefix: string;
  buildCacheDirectory: string;
  buildOutputRoot: string;
  buildTarget: 'cloudflare' | 'web';
  buildTempDirectory: string;
  cloudflareDeployEnabled: boolean;
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
    const decoded = Schema.decodeUnknownResult(Schema.OptionFromUndefinedOr(nonEmptyBuildStringSchema))(
      getBuildConfigEnvironment(name),
    );
    return Result.isSuccess(decoded) ? Option.getOrUndefined(decoded.success) : undefined;
  };
  const getBuildBoolean = (name: string): boolean =>
    Option.getOrElse(
      Result.getOrThrow(
        Schema.decodeUnknownResult(Schema.OptionFromUndefinedOr(Config.Boolean))(getBuildConfigEnvironment(name)),
      ),
      () => false,
    );
  return { envValue, getBuildBoolean };
};

const getCloudflareDeployEnabled = (getBuildConfigEnvironment: BuildConfigEnvironment): boolean => {
  const cloudflareDeployMode = Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.OptionFromUndefinedOr(Schema.Literals(['cloudflare', 'node'])))(
      getBuildConfigEnvironment('MODERNJS_DEPLOY'),
    ),
  );
  return Option.contains(cloudflareDeployMode, 'cloudflare');
};

const getBuildPort = (
  getBuildConfigEnvironment: BuildConfigEnvironment,
  portEnvironmentVariable: string,
  defaultPort: number,
): number =>
  Option.getOrElse(
    Result.getOrThrow(
      Schema.decodeUnknownResult(
        Schema.OptionFromUndefinedOr(
          Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
        ),
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

const assertCloudflarePublicUrl = ({
  appId,
  cloudflareDeployEnabled,
  cloudflarePublicUrlEnvironmentVariable,
  configuredCloudflareUrl,
  configuredSiteUrl,
  getBuildBoolean,
  inferredCloudflareUrl,
}: {
  appId: string;
  cloudflareDeployEnabled: boolean;
  cloudflarePublicUrlEnvironmentVariable: string;
  configuredCloudflareUrl: string | undefined;
  configuredSiteUrl: string | undefined;
  getBuildBoolean: (name: string) => boolean;
  inferredCloudflareUrl: string | undefined;
}): void => {
  if (
    cloudflareDeployEnabled &&
    getBuildBoolean('ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS') &&
    configuredCloudflareUrl === undefined &&
    configuredSiteUrl === undefined &&
    inferredCloudflareUrl === undefined
  ) {
    // oxlint-disable-next-line effect-native/no-native-error-construction -- Missing required deployment configuration is a synchronous build-time invariant at this non-Effect tooling boundary.
    throw new Error(
      `Cloudflare deploy for ${appId} needs ${cloudflarePublicUrlEnvironmentVariable}, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
    );
  }
};

export const createModernBuildContext = ({
  appId,
  cloudflarePublicUrlEnvironmentVariable,
  cloudflareWorkerName,
  defaultPort,
  getBuildConfigEnvironment,
  portEnvironmentVariable,
}: {
  appId: string;
  cloudflarePublicUrlEnvironmentVariable: string;
  cloudflareWorkerName: string;
  defaultPort: number;
  getBuildConfigEnvironment: BuildConfigEnvironment;
  portEnvironmentVariable: string;
}): ModernBuildContext => {
  const { envValue, getBuildBoolean } = createBuildConfigReaders(getBuildConfigEnvironment);
  const cloudflareDeployEnabled = getCloudflareDeployEnabled(getBuildConfigEnvironment);
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

  assertCloudflarePublicUrl({
    appId,
    cloudflareDeployEnabled,
    cloudflarePublicUrlEnvironmentVariable,
    configuredCloudflareUrl,
    configuredSiteUrl,
    getBuildBoolean,
    inferredCloudflareUrl,
  });

  return {
    assetPrefix,
    buildCacheDirectory,
    buildOutputRoot,
    buildTarget,
    buildTempDirectory,
    cloudflareDeployEnabled,
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

const createDevelopmentContractMiddleware = (moduleUrl: string) => {
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

const createCloudflareDeployment = (enabled: boolean, workerName: string) =>
  enabled
    ? {
        deploy: {
          worker: {
            compatibilityDate: '2026-06-02',
            name: workerName,
            security: createCloudflareWorkerSecurity(),
            ssr: true,
          },
        },
      }
    : undefined;

interface RspackConfiguration {
  externals?: unknown;
  node?: false | object;
  plugins: unknown[];
  resolve: { alias?: false | object };
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
    const configuredAliases = config.resolve.alias;
    config.resolve.alias = configuredAliases === false || configuredAliases === undefined ? {} : configuredAliases;
    Object.assign(config.resolve.alias, {
      'pg-pool$': createRequire(import.meta.resolve('pg/package.json')).resolve('pg-pool'),
      'pg-protocol$': fileURLToPath(new URL('../pg-protocol/dist/index.js', import.meta.resolve('pg/package.json'))),
    });
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
  appId,
  bffPrefix,
  build,
  builderPlugins,
  chunkLoadingGlobal,
  cloudflareWorkerName,
  moduleUrl,
  plugins,
  rsdoctorEnabled,
  uniqueName,
}: {
  appId: string;
  bffPrefix: string;
  build: ModernBuildContext;
  builderPlugins?: BuilderPlugin[];
  chunkLoadingGlobal: string;
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
    ...createCloudflareDeployment(build.cloudflareDeployEnabled, cloudflareWorkerName),
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
      disableTsChecker: false,
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
        '@modern-js/plugin-i18n/runtime': '@modern-js/plugin-i18n/runtime/no-react-i18next',
      },
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

export const createZephyrRspackPlugin = <Configuration>(options: {
  configure: () => Configuration;
  readToken: () => string | undefined;
}) => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: { modifyRspackConfig: (configuration: Configuration) => void }) {
    // Only authoritative CI deployments upload artifacts. Ordinary builds need
    // no Zephyr account or network access; deployment upload failures stay fatal.
    if (options.readToken() === undefined) {
      return;
    }
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
