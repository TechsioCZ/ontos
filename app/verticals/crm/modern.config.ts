import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appTools, defineConfig, presetUltramodern } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, withBuildConfigEnvironment } from '@modern-js/app-tools/config';
import { bffPlugin } from '@modern-js/plugin-bff';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { config as loadDotenv } from 'dotenv';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';

import { crmCorsAllowedHeaders, crmCorsAllowedMethods, crmCorsAllowedOrigins } from './shared/cors';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

const localisedUrls = Object.fromEntries(
  Object.entries(ultramodernLocalisedUrls).map(([language, routes]) => [language, { ...routes }]),
);

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const rootEnvironmentPath = fileURLToPath(new URL('../../.env', import.meta.url));
const dotenvResult = loadDotenv({ path: rootEnvironmentPath, quiet: true });
const dotenvErrorCode: string | undefined = dotenvResult.error?.code;
if (
  dotenvResult.error !== undefined &&
  dotenvErrorCode !== 'ENOENT' &&
  dotenvErrorCode !== 'NOT_FOUND_DOTENV_ENVIRONMENT'
) {
  throw dotenvResult.error;
}

const cloudflareDeployEnabled = getBuildConfigEnvironment('MODERNJS_DEPLOY') === 'cloudflare';
const moduleFederationConfigPath = fileURLToPath(
  new URL('module-federation.config.ts', import.meta.url),
);
const developmentModuleContractPath = fileURLToPath(
  new URL('.dev-public/.well-known/ontos-module-manifest.json', import.meta.url),
);

const zephyrRspackPlugin = () => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: { modifyRspackConfig: (handler: ReturnType<typeof withZephyrRspack>) => void }) {
    // Zephyr uploads federated build artifacts to Zephyr Cloud (the fast
    // rollback path). Uploading REQUIRES a Zephyr Cloud account and, in CI, a
    // deploy-scoped ZE_CI_TOKEN; without it Zephyr fatally fails to load its
    // application configuration. Zephyr therefore engages ONLY for such an
    // authoritative deploy — a plain build never contacts Zephyr Cloud, needs
    // no account, and is never blocked. This is the framework's "works with or
    // without Zephyr" contract. The plugin stays registered unconditionally
    // (this gate keys on Zephyr's native deploy token, not any UltraModern
    // opt-out). When deploying, ZE_FAIL_BUILD=true makes an upload failure a
    // hard build failure.
    const zephyrCiDeploy = (getBuildConfigEnvironment('ZE_CI_TOKEN') ?? '').length > 0;
    if (!zephyrCiDeploy) {
      return;
    }
    api.modifyRspackConfig(withBuildConfigEnvironment('ZE_FAIL_BUILD', 'true', withZephyrRspack()));
  },
});

const appId = 'crm';
const cloudflareWorkerName = 'app-crm';
const port = Number(getBuildConfigEnvironment('VERTICAL_CRM_PORT') ?? 4101);
const envValue = (name: string) => {
  const value = getBuildConfigEnvironment(name)?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_CRM');
const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX');
const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX');
const moduleFederationDevServerOrigin =
  envValue('ULTRAMODERN_MF_DEV_ORIGIN') || 'http://localhost:3020';
const cloudflareWorkersDevSubdomain = envValue('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
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
const remoteAssetOrigin =
  configuredCloudflareUrl ||
  inferredCloudflareUrl ||
  (cloudflareDeployEnabled ? '' : `http://localhost:${port}`);
// When deploying to Cloudflare without a configured public URL, publish an
// 'auto' publicPath so the remote resolves its chunks from the origin its
// remoteEntry.js was loaded from (the vertical's Worker), not the host shell's
// origin — otherwise cross-origin chunk loading 404s and MF reports an empty
// moduleId. A configured/inferred URL still wins as an absolute prefix.
const defaultRemoteAssetPrefix = remoteAssetOrigin
  ? `${remoteAssetOrigin.replace(/\/+$/u, '')}/`
  : 'auto';
const defaultAssetPrefix = defaultRemoteAssetPrefix;
// Asset loading is intentionally independent from the canonical site URL.
// Module Federation remotes must publish an absolute publicPath so browsers
// load remoteEntry.js and exposed chunks from the remote origin, not the host.
const assetPrefix =
  configuredModernAssetPrefix || configuredUltramodernAssetPrefix || defaultAssetPrefix;
const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';
const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';
const buildTempDirectory = `node_modules/.modern-js-${appId}-${buildTarget}`;
const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;

if (
  cloudflareDeployEnabled &&
  getBuildConfigEnvironment('ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS') === 'true' &&
  configuredCloudflareUrl === undefined &&
  configuredSiteUrl === undefined &&
  inferredCloudflareUrl === undefined
) {
  throw new Error(
    `Cloudflare deploy for ${appId} needs ULTRAMODERN_PUBLIC_URL_CRM, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
  );
}

const whenEnabled = <const Configuration>(enabled: boolean, configuration: Configuration) =>
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
            'script-src': [
              "'self'",
              "'unsafe-inline'",
              "'unsafe-eval'",
              'https:',
              'http:',
              'blob:',
            ],
            'style-src': ["'self'", "'unsafe-inline'", 'https:', 'http:'],
            'worker-src': ["'self'", 'blob:'],
          },
          mode: 'report-only',
          reason:
            'Report-only by default so Cloudflare Module Federation SSR can prove remote script, style, and connect compatibility before enforcement.',
        },
        cors: {
          allowedHeaders: [...crmCorsAllowedHeaders],
          allowedMethods: [...crmCorsAllowedMethods],
          allowedOrigins: crmCorsAllowedOrigins(moduleFederationDevServerOrigin),
          assets: true,
          reason: 'Allow the configured Shell to load CRM assets and invoke its BFF.',
        },
        enabled: true,
        headers: {
          contentTypeOptions: 'nosniff',
          permissionsPolicy: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
          referrerPolicy: 'strict-origin-when-cross-origin',
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
});

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
        prefix: '/crm-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      ...cloudflareDeployment,
      dev: {
        // Remote dev manifests must publish an absolute publicPath so host
        // shells load remoteEntry.js and exposed chunks from this dev server.
        assetPrefix,
        setupMiddlewares: [
          ({ unshift }) => {
            unshift((request, response, next) => {
              if (request.url?.split('?', 1)[0] !== '/.well-known/ontos-module-manifest.json') {
                next();
                return;
              }
              const contract = readFileSync(developmentModuleContractPath);
              response.setHeader('Cache-Control', 'no-cache');
              response.setHeader('Content-Type', 'application/json');
              response.setHeader('Content-Length', String(contract.byteLength));
              response.end(contract);
            });
          },
        ],
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
          enabled: getBuildConfigEnvironment('ULTRAMODERN_RSDOCTOR') === 'true',
        },
      },
      plugins: [
        appTools(),
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
              '/.well-known',
              '/@mf-types',
              '/assets',
              '/bundles',
              '/crm-api',
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
            localisedUrls,
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
        publicDir: ['./locales', './assets', './.dev-public'],
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
          ULTRAMODERN_CRM_API_BASE_URL: `${remoteAssetOrigin.replace(/\/+$/u, '')}/crm-api`,
          ULTRAMODERN_SHELL_ORIGIN: moduleFederationDevServerOrigin,
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
            .uniqueName('verticalCrm')
            .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_CRM_LOADED_CHUNKS__');
        },
        devServer: {
          headers: {
            'Access-Control-Allow-Headers': crmCorsAllowedHeaders.join(', '),
            'Access-Control-Allow-Methods': crmCorsAllowedMethods.join(', '),
            'Access-Control-Allow-Origin': moduleFederationDevServerOrigin,
          },
        },
      },
    },
    {
      appId,
      deliveryUnit: {
        buildMarker: 'b08ddded31ae2315',
        unitId: 'app/crm',
        version: '0.1.0',
      },
      enableBffRequestId: true,
      enableModuleFederationSSR: true,
      enableTelemetryExporters: true,
      telemetryFailLoudStartup: false,
    },
  ),
);
