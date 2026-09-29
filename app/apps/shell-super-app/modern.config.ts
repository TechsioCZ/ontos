import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@modern-js/app-tools';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import type { AppTools, AppToolsUserConfig, CliPlugin } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { sortWith } from 'effect/Array';
import { getOrElse as getOptionOrElse, getOrUndefined as getOptionOrUndefined } from 'effect/Option';
import { String as StringOrder } from 'effect/Order';
import { getOrThrow as getResultOrThrow, isSuccess as isResultSuccess } from 'effect/Result';
import {
  Array as SchemaArray,
  Boolean as BooleanSchema,
  Literals,
  NonEmptyString,
  NumberFromString,
  OptionFromUndefinedOr,
  Struct,
  Trim,
  check,
  decodeTo,
  decodeUnknownResult,
  fromJsonString,
  isBetween,
  isInt,
  isMinLength,
} from 'effect/Schema';
import { transform } from 'effect/SchemaTransformation';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';

import {
  createCloudflareDataPlaneBindings,
  createCloudflareWorkerSecurity,
  createWorkerSsrPlugins,
  createZephyrRspackPlugin,
  resolveCloudflareExternal,
} from '../../packages/shared-contracts/tooling/modern-config.ts';
import {
  DeploymentAllowlistOverlaySchema,
  DeploymentAllowlistTopologySchema,
} from './api/modules/deployment-allowlist.ts';
import { createModuleDeploymentAllowlistBuildInput } from './module-deployment-allowlist.config.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

type RspackConfigHandler = Extract<
  NonNullable<NonNullable<AppToolsUserConfig['tools']>['rspack']>,
  (...arguments_: never[]) => void
>;

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const nonEmptyBuildStringSchema = Trim.pipe(check(isMinLength(1)));
const getOptionalBuildConfig = (name: string): string | undefined => {
  const decoded = decodeUnknownResult(OptionFromUndefinedOr(nonEmptyBuildStringSchema))(
    getBuildConfigEnvironment(name),
  );
  return isResultSuccess(decoded) ? getOptionOrUndefined(decoded.success) : undefined;
};
const envValue = getOptionalBuildConfig;
const BuildBooleanSchema = Literals(['true', 'yes', 'on', '1', 'y', 'false', 'no', 'off', '0', 'n']).pipe(
  decodeTo(
    BooleanSchema,
    transform({
      decode: (value) => ['true', 'yes', 'on', '1', 'y'].includes(value),
      encode: (value) => (value ? 'true' : 'false'),
    }),
  ),
);
const getBuildBoolean = (name: string): boolean =>
  getOptionOrElse(
    getResultOrThrow(decodeUnknownResult(OptionFromUndefinedOr(BuildBooleanSchema))(getBuildConfigEnvironment(name))),
    () => false,
  );
const cloudflareDeployEnabled = resolveDeployTarget().target === 'cloudflare';
// Only a Worker build binds the private data plane; its IDs are required there and unused elsewhere.
const cloudflareDataPlaneBindings = cloudflareDeployEnabled ? createCloudflareDataPlaneBindings(envValue) : undefined;
const cloudflareWorkerRemoteStubPath = fileURLToPath(
  new URL('src/api/cloudflare-worker-remote-stub.ts', import.meta.url),
);
const effectApiSourceDirectory = fileURLToPath(new URL('api/', import.meta.url));
/* oxlint-disable promise/prefer-await-to-callbacks -- Rspack externals use a callback API. expires: 2026-12-31. */
const cloudflareRuntimeExternal = (
  request: { dependencyType?: string; request?: string },
  callback: (error?: Error, result?: string | string[], type?: 'module-import') => void,
) => {
  callback(...resolveCloudflareExternal(request));
};
/* oxlint-enable promise/prefer-await-to-callbacks */

const zephyrRspackPlugin = (): CliPlugin<AppTools> =>
  createZephyrRspackPlugin({
    configure: () => withZephyrRspack(),
    readEnvironment: getOptionalBuildConfig,
  });

const appId = 'shell-super-app';
const moduleFederationConfigPath = fileURLToPath(new URL('module-federation.config.ts', import.meta.url));
const referenceTopologyPath = fileURLToPath(new URL('../../topology/reference-topology.json', import.meta.url));
const referenceTopology = getResultOrThrow(
  decodeUnknownResult(fromJsonString(DeploymentAllowlistTopologySchema))(readFileSync(referenceTopologyPath, 'utf-8')),
);
// The Shell binds every vertical Worker under the vertical's topology identity: its Worker name, its
// `workerDispatch.serviceBinding` and its BFF prefix. Module discovery and the deploy planner read the
// same topology, so a renamed binding changes every caller at once.
const ShellServiceBindingTopologySchema = Struct({
  verticals: SchemaArray(
    Struct({
      api: Struct({ bff: Struct({ prefix: NonEmptyString }) }),
      backendFederation: Struct({
        executionSurfaces: Struct({
          cloudflare: Struct({ workerDispatch: Struct({ serviceBinding: NonEmptyString }) }),
        }),
      }),
      cloudflare: Struct({ workerName: NonEmptyString }),
    }),
  ),
});
const verticalServiceBindings = sortWith(
  getResultOrThrow(
    decodeUnknownResult(fromJsonString(ShellServiceBindingTopologySchema))(
      readFileSync(referenceTopologyPath, 'utf-8'),
    ),
  ).verticals.map(({ api, backendFederation, cloudflare }) => ({
    binding: backendFederation.executionSurfaces.cloudflare.workerDispatch.serviceBinding,
    prefix: api.bff.prefix,
    service: cloudflare.workerName,
  })),
  ({ prefix }) => prefix,
  StringOrder,
);
const developmentOverlayPath = fileURLToPath(
  new URL('../../topology/local-overlays/development.json', import.meta.url),
);
const developmentOverlay = getResultOrThrow(
  decodeUnknownResult(fromJsonString(DeploymentAllowlistOverlaySchema))(readFileSync(developmentOverlayPath, 'utf-8')),
);
const moduleDeploymentAllowlist = createModuleDeploymentAllowlistBuildInput({
  cloudflareDeployEnabled,
  developmentOverlay,
  readEnvironment: getBuildConfigEnvironment,
  topology: referenceTopology,
});
Object.assign(globalThis, {
  ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: referenceTopology,
  ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: moduleDeploymentAllowlist,
});
const cloudflareWorkerName = 'app-shell-super-app';
const port = getOptionOrElse(
  getResultOrThrow(
    decodeUnknownResult(
      OptionFromUndefinedOr(NumberFromString.pipe(check(isInt(), isBetween({ maximum: 65_535, minimum: 1 })))),
    )(getBuildConfigEnvironment('SHELL_SUPER_APP_PORT')),
  ),
  () => 3020,
);
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP');
const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX');
const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX');
const moduleFederationDevServerOrigin = getOptionalBuildConfig('ULTRAMODERN_MF_DEV_ORIGIN') ?? 'http://localhost:3020';
const cloudflareWorkersDevSubdomain = getOptionalBuildConfig('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
const inferredCloudflareUrl =
  cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
    ? `https://${cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`
    : undefined;
// Site origin (SEO: canonical/hreflang URLs) prefers the site-wide public URL;
// the per-app deployment URL only fills in when no site origin is configured.
const siteUrl = configuredSiteUrl || configuredCloudflareUrl || inferredCloudflareUrl || `http://localhost:${port}`;
const defaultAssetPrefix = '/';
// Asset loading is intentionally independent from the canonical site URL.
// Module Federation remotes must publish an absolute publicPath so browsers
// load remoteEntry.js and exposed chunks from the remote origin, not the host.
const assetPrefix = configuredModernAssetPrefix || configuredUltramodernAssetPrefix || defaultAssetPrefix;
const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';
const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';
const buildTempDirectory = `node_modules/.modern-js-${appId}-${buildTarget}`;
const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;
const shellDevServerHeaders: NonNullable<NonNullable<NonNullable<AppToolsUserConfig['dev']>['server']>['headers']> = {
  'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Origin': moduleFederationDevServerOrigin,
};

export default defineConfig(
  presetUltramodern(
    withOptionalProperty(
      {
        bff: {
          effect: {
            entry: './api/index',
            openapi: {
              path: '/openapi.json',
            },
            strictEffectApproach: true,
          },
          prefix: '/shell-super-app-api',
          runtimeFramework: 'effect',
        },
        builderPlugins: [pluginTailwindcss()],
      } satisfies AppToolsUserConfig,
      cloudflareDeployEnabled,
      'deploy',
      {
        worker: {
          ...cloudflareDataPlaneBindings,
          compatibilityDate: '2026-06-02',
          name: cloudflareWorkerName,
          security: createCloudflareWorkerSecurity(),
          services: verticalServiceBindings,
          ssr: true,
        },
      } satisfies NonNullable<AppToolsUserConfig['deploy']>,
      {
        dev: {
          // Keep shell dev assets origin-relative so the shell works through
          // tunnels and local previews without rewriting its own chunks.
          assetPrefix: '/',
          lazyCompilation: getBuildBoolean('CI') ? false : undefined,
          server: {
            headers: shellDevServerHeaders,
          },
        },
        html: {
          outputStructure: 'flat',
        },
        output: {
          assetPrefix,
          // `pnpm typecheck` (tsc --build over the reference graph) owns type diagnostics.
          disableTsChecker: true,
          distPath: {
            html: './',
            root: buildOutputRoot,
          },
          polyfill: 'off',
          splitRouteChunks: true,
          tempDir: buildTempDirectory,
        },
        performance: {
          buildCache: {
            cacheDigest: [appId, buildTarget],
            cacheDirectory: buildCacheDirectory,
          },
        },
        plugins: [
          ultramodernAppTools(),
          bffPlugin(),
          tanstackRouterPlugin(),
          i18nPlugin({
            backend: {
              enabled: true,
              loadPath: '/locales/{{lng}}/{{ns}}.json',
            },
            localeDetection: {
              fallbackLanguage: 'en',
              ignoreRedirectRoutes: [
                // The Shell runtime contract the Application Composition publisher observes.
                '/.well-known',
                '/@mf-types',
                '/assets',
                '/bundles',
                '/shell-super-app-api',
                '/locales',
                '/mf-manifest.json',
                '/mf-stats.json',
                '/remoteEntry.js',
                '/robots.txt',
                '/site.webmanifest',
                '/sitemap.xml',
                '/static',
                '/zephyr-manifest.json',
              ],
              languages: ['en', 'cs'],
              localePathRedirect: true,
            },
            reactI18next: false,
          }),
          moduleFederationPlugin({
            configPath: moduleFederationConfigPath,
          }),
          zephyrRspackPlugin(),
        ],
        server: {
          port,
          publicDir: ['./locales', './assets'],
          ssr: {
            mode: 'stream',
            moduleFederationAppSSR: true,
          },
        },
        source: {
          alias: {
            '@modern-js/plugin-i18n/runtime$': '@modern-js/plugin-i18n/runtime/no-react-i18next',
          },
          globalVars: {
            ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: referenceTopology,
            ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: moduleDeploymentAllowlist,
            ULTRAMODERN_SITE_URL: siteUrl,
          },
          mainEntryName: 'index',
        },
        splitChunks: {
          chunks: 'async',
        },
        tools: {
          autoprefixer: {
            overrideBrowserslist: ['defaults'],
          },
          bundlerChain: (chain) => {
            chain.output
              .uniqueName('shellSuperApp')
              .chunkLoadingGlobal('__ULTRAMODERN_SHELL_SUPER_APP_LOADED_CHUNKS__');
          },
          rspack: ((config, { environment, rspack }) => {
            if (!cloudflareDeployEnabled) {
              return;
            }
            const configuredExternals = config.externals;
            config.externals = [cloudflareRuntimeExternal];
            if (configuredExternals !== undefined) {
              config.externals.push(
                ...(Array.isArray(configuredExternals) ? configuredExternals : [configuredExternals]),
              );
            }
            if (environment.name === 'workerSSR') {
              const configuredNode = config.node;
              config.node = configuredNode === false || configuredNode === undefined ? {} : configuredNode;
              Object.assign(config.node, {
                __dirname: false,
                __filename: false,
              });
              config.plugins.push(
                ...createWorkerSsrPlugins(rspack, effectApiSourceDirectory),
                new rspack.NormalModuleReplacementPlugin(/^partyRegistry\//u, cloudflareWorkerRemoteStubPath),
              );
            }
          }) satisfies RspackConfigHandler,
        },
      } satisfies AppToolsUserConfig,
    ) satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '090dd0a19fdd0853',
        unitId: 'app/shell-super-app',
        version: '0.1.0',
      },
      enableBffRequestId: true,
      enableModuleFederationSSR: true,
      enableTelemetryExporters: true,
      telemetryFailLoudStartup: false,
    },
  ),
);
