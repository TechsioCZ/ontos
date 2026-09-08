import { readFileSync } from 'node:fs';
import {
  createCloudflareWorkerSecurity,
  createWorkerSsrPlugins,
  createZephyrRspackPlugin,
  resolveCloudflareExternal,
} from '../../packages/shared-contracts/tooling/modern-config.ts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appTools, defineConfig, presetUltramodern, ultramodernReleaseEnvelopePlugin } from '@modern-js/app-tools';
import type { AppTools, AppToolsUserConfig, CliPlugin } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, withBuildConfigEnvironment } from '@modern-js/app-tools/config';
import { bffPlugin } from '@modern-js/plugin-bff';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';
import {
  contains as optionContains,
  getOrElse as getOptionOrElse,
  getOrUndefined as getOptionOrUndefined,
} from 'effect/Option';
import { getOrThrow as getResultOrThrow, isSuccess as isResultSuccess } from 'effect/Result';
import {
  Boolean as BooleanSchema,
  Literals,
  NumberFromString,
  OptionFromUndefinedOr,
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
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';
import { createModuleDeploymentAllowlistBuildInput } from './module-deployment-allowlist.config.ts';
import {
  DeploymentAllowlistOverlaySchema,
  DeploymentAllowlistTopologySchema,
} from './api/modules/deployment-allowlist.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
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
const BuildBooleanSchema = Literals([
  'true',
  'yes',
  'on',
  '1',
  'y',
  'false',
  'no',
  'off',
  '0',
  'n',
]).pipe(
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
    getResultOrThrow(
      decodeUnknownResult(OptionFromUndefinedOr(BuildBooleanSchema))(
        getBuildConfigEnvironment(name),
      ),
    ),
    () => false,
  );
const cloudflareDeployMode = getResultOrThrow(
  decodeUnknownResult(OptionFromUndefinedOr(Literals(['cloudflare', 'node'])))(
    getBuildConfigEnvironment('MODERNJS_DEPLOY'),
  ),
);
const cloudflareDeployEnabled = optionContains(cloudflareDeployMode, 'cloudflare');
const postgresProtocolCommonJsEntry = fileURLToPath(
  new URL('../pg-protocol/dist/index.js', import.meta.resolve('pg/package.json')),
);
const postgresPoolCommonJsEntry = createRequire(import.meta.resolve('pg/package.json')).resolve(
  'pg-pool',
);
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
    configure: () => withBuildConfigEnvironment('ZE_FAIL_BUILD', 'true', withZephyrRspack()),
    readToken: () => getOptionalBuildConfig('ZE_CI_TOKEN'),
  });

const appId = 'shell-super-app';
const moduleFederationConfigPath = fileURLToPath(
  new URL('module-federation.config.ts', import.meta.url),
);
const referenceTopologyPath = fileURLToPath(
  new URL('../../topology/reference-topology.json', import.meta.url),
);
const referenceTopology = getResultOrThrow(
  decodeUnknownResult(fromJsonString(DeploymentAllowlistTopologySchema), {
    onExcessProperty: 'preserve',
  })(readFileSync(referenceTopologyPath, 'utf-8')),
);
const developmentOverlayPath = fileURLToPath(
  new URL('../../topology/local-overlays/development.json', import.meta.url),
);
const developmentOverlay = getResultOrThrow(
  decodeUnknownResult(fromJsonString(DeploymentAllowlistOverlaySchema), {
    onExcessProperty: 'preserve',
  })(readFileSync(developmentOverlayPath, 'utf-8')),
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
      OptionFromUndefinedOr(
        NumberFromString.pipe(check(isInt(), isBetween({ maximum: 65_535, minimum: 1 }))),
      ),
    )(getBuildConfigEnvironment('SHELL_SUPER_APP_PORT')),
  ),
  () => 3020,
);
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP');
const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX');
const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX');
const moduleFederationDevServerOrigin =
  getOptionalBuildConfig('ULTRAMODERN_MF_DEV_ORIGIN') ?? 'http://localhost:3020';
const cloudflareWorkersDevSubdomain = getOptionalBuildConfig(
  'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN',
);
const inferredCloudflareUrl =
  cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
    ? `https://${cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`
    : undefined;
// Site origin (SEO: canonical/hreflang URLs) prefers the site-wide public URL;
// the per-app deployment URL only fills in when no site origin is configured.
const siteUrl =
  configuredSiteUrl ||
  configuredCloudflareUrl ||
  inferredCloudflareUrl ||
  `http://localhost:${port}`;
const defaultAssetPrefix = '/';
// Asset loading is intentionally independent from the canonical site URL.
// Module Federation remotes must publish an absolute publicPath so browsers
// load remoteEntry.js and exposed chunks from the remote origin, not the host.
const assetPrefix =
  configuredModernAssetPrefix || configuredUltramodernAssetPrefix || defaultAssetPrefix;
const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';
const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';
const buildTempDirectory = `node_modules/.modern-js-${appId}-${buildTarget}`;
const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;
const shellDevServerHeaders: NonNullable<
  NonNullable<NonNullable<AppToolsUserConfig['dev']>['server']>['headers']
> = {
  'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Origin': moduleFederationDevServerOrigin,
};

if (
  cloudflareDeployEnabled &&
  getBuildBoolean('ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS') &&
  configuredCloudflareUrl === undefined &&
  configuredSiteUrl === undefined &&
  inferredCloudflareUrl === undefined
) {
  throw new Error(
    `Cloudflare deploy for ${appId} needs ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
  );
}

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
          compatibilityDate: '2026-06-02',
          name: cloudflareWorkerName,
          security: createCloudflareWorkerSecurity(),
          services: [
            {
              binding:
                getOptionalBuildConfig('VERTICAL_PARTY_REGISTRY_WORKER_BINDING') ??
                'VERTICAL_PARTY_REGISTRY_WORKER',
              prefix: '/party-registry-api',
              service:
                getOptionalBuildConfig('VERTICAL_PARTY_REGISTRY_WORKER_NAME') ??
                'app-party-registry',
            },
          ],
          ssr: true,
        },
      } satisfies NonNullable<AppToolsUserConfig['deploy']>,
      {
        dev: {
          // Keep shell dev assets origin-relative so the shell works through
          // tunnels and local previews without rewriting its own chunks.
          assetPrefix: '/',
          server: {
            headers: shellDevServerHeaders,
          },
        },
        html: {
          outputStructure: 'flat',
        },
        output: {
          assetPrefix,
          disableTsChecker: false,
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
          rsdoctor: {
            disableClientServer: true,
            enabled: getBuildBoolean('ULTRAMODERN_RSDOCTOR'),
          },
        },
        plugins: [
          appTools(),
          ultramodernReleaseEnvelopePlugin(),
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
              localisedUrls: ultramodernLocalisedUrls,
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
            '@modern-js/plugin-i18n/runtime': '@modern-js/plugin-i18n/runtime/no-react-i18next',
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
            const configuredAliases = config.resolve.alias;
            config.resolve.alias =
              configuredAliases === false || configuredAliases === undefined
                ? {}
                : configuredAliases;
            Object.assign(config.resolve.alias, {
              'pg-pool$': postgresPoolCommonJsEntry,
              'pg-protocol$': postgresProtocolCommonJsEntry,
            });
            const configuredExternals = config.externals;
            config.externals = [cloudflareRuntimeExternal];
            if (configuredExternals !== undefined) {
              config.externals.push(
                ...(Array.isArray(configuredExternals)
                  ? configuredExternals
                  : [configuredExternals]),
              );
            }
            if (environment.name === 'workerSSR') {
              const configuredNode = config.node;
              config.node =
                configuredNode === false || configuredNode === undefined ? {} : configuredNode;
              Object.assign(config.node, {
                __dirname: false,
                __filename: false,
              });
              config.plugins.push(
                ...createWorkerSsrPlugins(rspack, effectApiSourceDirectory),
                new rspack.NormalModuleReplacementPlugin(
                  /^partyRegistry\//u,
                  cloudflareWorkerRemoteStubPath,
                ),
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
