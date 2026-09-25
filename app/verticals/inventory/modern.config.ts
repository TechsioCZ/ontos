import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, withBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { Config, Option, Result, Schema } from 'effect';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';

import {
  createWorkerSsrPlugins,
  createZephyrRspackPlugin,
  resolveCloudflareExternal,
} from '../../packages/shared-contracts/tooling/modern-config.ts';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const nonEmptyBuildStringSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));
const getOptionalBuildConfig = (name: string): string | undefined => {
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
const cloudflareDeployMode = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.OptionFromUndefinedOr(Schema.Literals(['cloudflare', 'node'])))(
    getBuildConfigEnvironment('MODERNJS_DEPLOY'),
  ),
);
const cloudflareDeployEnabled = Option.contains(cloudflareDeployMode, 'cloudflare');
const resolvePostgresProtocolCommonJsEntry = () =>
  fileURLToPath(new URL('../pg-protocol/dist/index.js', import.meta.resolve('pg/package.json')));
const resolvePostgresPoolCommonJsEntry = () => createRequire(import.meta.resolve('pg/package.json')).resolve('pg-pool');
const resolveEffectApiSourceDirectory = () => fileURLToPath(new URL('api/', import.meta.url));
/* oxlint-disable promise/prefer-await-to-callbacks -- Rspack externals use a callback API. expires: 2026-12-31. */
const cloudflareRuntimeExternal = (
  request: { dependencyType?: string; request?: string },
  callback: (error?: Error, result?: string | string[], type?: 'module-import') => void,
) => {
  callback(...resolveCloudflareExternal(request, cloudflareDeployEnabled));
};
/* oxlint-enable promise/prefer-await-to-callbacks */

const zephyrRspackPlugin = () =>
  createZephyrRspackPlugin({
    configure: () => withBuildConfigEnvironment('ZE_FAIL_BUILD', 'true', withZephyrRspack()),
    readToken: () => getOptionalBuildConfig('ZE_CI_TOKEN'),
  });

const appId = 'inventory';
const cloudflareWorkerName = 'app-inventory';
const port = Option.getOrElse(
  Result.getOrThrow(
    Schema.decodeUnknownResult(
      Schema.OptionFromUndefinedOr(
        Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
      ),
    )(getBuildConfigEnvironment('VERTICAL_INVENTORY_PORT')),
  ),
  () => 4109,
);
const envValue = getOptionalBuildConfig;
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_INVENTORY');
const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX');
const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX');
const moduleFederationDevServerAllowedOrigins = [
  'http://localhost:3020',
  'http://localhost:4101',
  'http://localhost:4102',
  'http://localhost:4103',
  'http://localhost:4104',
  'http://localhost:4105',
  'http://localhost:4106',
  'http://localhost:4107',
  'http://localhost:4108',
  'http://localhost:4109',
];
const cloudflareWorkersDevSubdomain = envValue('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
const inferredCloudflareUrl =
  cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
    ? `https://${cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`
    : undefined;
// Site origin (SEO: canonical/hreflang URLs) prefers the site-wide public URL;
// the per-app deployment URL only fills in when no site origin is configured.
const siteUrl = configuredSiteUrl ?? configuredCloudflareUrl ?? inferredCloudflareUrl ?? `http://localhost:${port}`;
const remoteAssetOrigin =
  configuredCloudflareUrl ?? inferredCloudflareUrl ?? (cloudflareDeployEnabled ? '' : `http://localhost:${port}`);
// When deploying to Cloudflare without a configured public URL, publish an
// 'auto' publicPath so the remote resolves its chunks from the origin its
// remoteEntry.js was loaded from (the vertical's Worker), not the host shell's
// origin — otherwise cross-origin chunk loading 404s and MF reports an empty
// moduleId. A configured/inferred URL still wins as an absolute prefix.
const defaultRemoteAssetPrefix = remoteAssetOrigin.length > 0 ? `${remoteAssetOrigin.replace(/\/+$/u, '')}/` : 'auto';
const defaultAssetPrefix = defaultRemoteAssetPrefix;
// Asset loading is intentionally independent from the canonical site URL.
// Module Federation remotes must publish an absolute publicPath so browsers
// load remoteEntry.js and exposed chunks from the remote origin, not the host.
const assetPrefix = configuredModernAssetPrefix ?? configuredUltramodernAssetPrefix ?? defaultAssetPrefix;
const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';
const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';
const modernBuildDirectory = ['node_modules/.modern', 'js'].join('-');
const buildTempDirectory = `${modernBuildDirectory}-${appId}-${buildTarget}`;
const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;

if (
  cloudflareDeployEnabled &&
  getBuildBoolean('ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS') &&
  configuredCloudflareUrl === undefined &&
  configuredSiteUrl === undefined &&
  inferredCloudflareUrl === undefined
) {
  throw new Error(
    `Cloudflare deploy for ${appId} needs ULTRAMODERN_PUBLIC_URL_INVENTORY, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
  );
}

const whenEnabled = <Configuration>(enabled: boolean, configuration: Configuration) =>
  enabled ? configuration : undefined;

const cloudflareDeployment = whenEnabled(cloudflareDeployEnabled, {
  deploy: {
    worker: {
      compatibilityDate: '2026-06-02',
      name: cloudflareWorkerName,
      security: {
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
      },
      ssr: true,
    },
  },
} satisfies Pick<AppToolsUserConfig, 'deploy'>);

const performanceConfig = {
  buildCache: {
    cacheDigest: [appId, buildTarget],
    cacheDirectory: buildCacheDirectory,
  },
  rsdoctor: {
    disableClientServer: true,
    enabled: getBuildBoolean('ULTRAMODERN_RSDOCTOR'),
  },
};

export default defineConfig(
  presetUltramodern(
    {
      bff: {
        effect: {
          entry: './api/index',
          openapi: {
            path: '/openapi.json',
          },

          strictEffectApproach: true,
        },
        prefix: '/inventory-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      ...cloudflareDeployment,
      dev: {
        // Remote dev manifests must publish an absolute publicPath so host
        // shells load remoteEntry.js and exposed chunks from this dev server.
        assetPrefix,
        // MF assets are non-credentialed and only permit configured local app origins.
        server: {
          cors: {
            origin: moduleFederationDevServerAllowedOrigins,
          },
          headers: {
            'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          },
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
      performance: performanceConfig,
      plugins: [
        ultramodernAppTools(),
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
              '/inventory-api',
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
            // SAFETY: the generated route metadata is a locale-to-route string map consumed read-only by the plugin.
            localisedUrls: ultramodernLocalisedUrls as Record<string, Record<string, string>>,
          },
          reactI18next: false,
        }),
        bffPlugin(),
        moduleFederationPlugin(),
        zephyrRspackPlugin(),
      ],
      server: {
        port,
        publicDir: ['./locales', './assets'],
      },
      source: {
        alias: {
          '@modern-js/plugin-i18n/runtime$': '@modern-js/plugin-i18n/runtime/no-react-i18next',
        },
        globalVars: {
          ULTRAMODERN_SITE_URL: siteUrl,
        },
        mainEntryName: 'index',
      },
      tools: {
        autoprefixer: {
          overrideBrowserslist: ['defaults'],
        },
        bundlerChain: (chain) => {
          chain.output
            .uniqueName('verticalInventory')
            .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_INVENTORY_LOADED_CHUNKS__');
        },
        rspack: (config, { environment, rspack }) => {
          if (!cloudflareDeployEnabled) {
            return;
          }
          const configuredAliases = config.resolve.alias;
          config.resolve.alias =
            configuredAliases === false || configuredAliases === undefined ? {} : configuredAliases;
          Object.assign(config.resolve.alias, {
            'pg-pool$': resolvePostgresPoolCommonJsEntry(),
            'pg-protocol$': resolvePostgresProtocolCommonJsEntry(),
          });
          const configuredExternals = config.externals;
          config.externals = [cloudflareRuntimeExternal];
          if (configuredExternals !== undefined) {
            config.externals.push(
              ...(Array.isArray(configuredExternals) ? configuredExternals : [configuredExternals]),
            );
          }
          if (environment.name === 'workerSSR') {
            const effectApiSourceDirectory = resolveEffectApiSourceDirectory();
            const configuredNode = config.node;
            config.node = configuredNode === false || configuredNode === undefined ? {} : configuredNode;
            Object.assign(config.node, {
              __dirname: false,
              __filename: false,
            });
            config.plugins.push(...createWorkerSsrPlugins(rspack, effectApiSourceDirectory));
          }
        },
        tsChecker: {
          typescript: {
            build: false,
          },
        },
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: 'd87a59b2fccc989f',
        unitId: 'app/inventory',
        version: '0.1.0',
      },
    },
  ),
);
