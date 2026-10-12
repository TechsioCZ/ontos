import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { value as redactedValue } from 'effect/Redacted';
import {
  Int,
  Literals,
  NumberFromString,
  RedactedFromValue,
  String as SchemaString,
  Struct,
  Trim,
  Union,
  decodeUnknownSync,
  isGreaterThanOrEqualTo,
  isInt,
  isLessThanOrEqualTo,
  optional,
} from 'effect/Schema';
import { defineConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';

import developmentOverlay from '../../topology/local-overlays/development.json';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

const cloudflareDeployEnabled = resolveDeployTarget().target === 'cloudflare';

const appId = 'siampark-billing-finance';
const cloudflareWorkerName = 'app-siampark-billing-finance';
const OptionalText = optional(Trim);
const BuildSettingsSchema = Struct({
  assetPrefix: OptionalText,
  cloudflareUrl: OptionalText,
  failUpload: optional(Literals(['true', 'false'])),
  modernAssetPrefix: OptionalText,
  port: Union([NumberFromString, Int]).check(isInt(), isGreaterThanOrEqualTo(1), isLessThanOrEqualTo(65_535)),
  siteUrl: OptionalText,
  uploadToken: optional(RedactedFromValue(SchemaString)),
  workersDevSubdomain: OptionalText,
});
const buildSettings = decodeUnknownSync(BuildSettingsSchema)({
  assetPrefix: getBuildConfigEnvironment('ULTRAMODERN_ASSET_PREFIX'),
  cloudflareUrl: getBuildConfigEnvironment('ULTRAMODERN_PUBLIC_URL_SIAMPARK_BILLING_FINANCE'),
  failUpload: getBuildConfigEnvironment('ZE_FAIL_BUILD'),
  modernAssetPrefix: getBuildConfigEnvironment('MODERN_ASSET_PREFIX'),
  port: getBuildConfigEnvironment('VERTICAL_SIAMPARK_BILLING_FINANCE_PORT') ?? developmentOverlay.ports[appId],
  siteUrl: getBuildConfigEnvironment('MODERN_PUBLIC_SITE_URL'),
  uploadToken: getBuildConfigEnvironment('ZE_CI_TOKEN'),
  workersDevSubdomain: getBuildConfigEnvironment('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN'),
});
const zephyrRspackPlugin = () => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: { modifyRspackConfig: (handler: ReturnType<typeof withZephyrRspack>) => void }) {
    if (buildSettings.uploadToken === undefined || redactedValue(buildSettings.uploadToken).length === 0) {
      return;
    }
    if (buildSettings.failUpload !== 'true') {
      throw new Error('ZE_FAIL_BUILD=true is required for an authoritative Zephyr upload');
    }
    api.modifyRspackConfig(withZephyrRspack());
  },
});
const { port } = buildSettings;
const configuredSiteUrl = buildSettings.siteUrl;
const configuredCloudflareUrl = buildSettings.cloudflareUrl;
const configuredUltramodernAssetPrefix = buildSettings.assetPrefix;
const configuredModernAssetPrefix = buildSettings.modernAssetPrefix;
const moduleFederationDevServerAllowedOrigins = Object.values(developmentOverlay.ports).map(
  (localPort) => `http://localhost:${localPort}`,
);
const cloudflareWorkersDevSubdomain = buildSettings.workersDevSubdomain;
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
const buildTempDirectory = `node_modules/.modern-output-${appId}-${buildTarget}`;
const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;

const withCloudflareDeployment = <T extends object>(base: T) => {
  if (!cloudflareDeployEnabled) {
    return base;
  }
  return {
    ...base,
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
            mode: 'report-only',
            reason:
              'Report-only by default so Cloudflare Module Federation SSR can prove remote script, style, and connect compatibility before enforcement.',
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
  };
};
export default defineConfig(
  presetUltramodern(
    withCloudflareDeployment({
      bff: {
        effect: {
          entry: './api/index',
          openapi: {
            path: '/openapi.json',
          },

          strictEffectApproach: true,
        },
        prefix: '/siampark-billing-finance-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
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
              const contract = readFileSync(
                fileURLToPath(new URL('.dev-public/.well-known/ontos-module-manifest.json', import.meta.url)),
              );
              response.setHeader('Cache-Control', 'no-cache');
              response.setHeader('Content-Type', 'application/json');
              response.setHeader('Content-Length', String(contract.byteLength));
              response.end(contract);
            });
          },
        ],
        // MF assets are non-credentialed and only permit configured local app origins.
        server: {
          cors: {
            origin: moduleFederationDevServerAllowedOrigins,
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
      performance: {
        buildCache: {
          cacheDigest: [appId, buildTarget],
          cacheDirectory: buildCacheDirectory,
        },
      },
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
              '/.well-known',
              '/@mf-types',
              '/assets',
              '/bundles',
              '/siampark-billing-finance-api',
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
        bffPlugin(),
        moduleFederationPlugin(),
        zephyrRspackPlugin(),
      ],
      server: {
        port,
        publicDir: ['./locales', './assets', './.dev-public'],
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
            .uniqueName('verticalSiamparkBillingFinance')
            .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_SIAMPARK_BILLING_FINANCE_LOADED_CHUNKS__');
        },
        tsChecker: {
          typescript: {
            build: false,
          },
        },
      },
    }),
    {
      appId,
      deliveryUnit: {
        buildMarker: '0601eb5c20ee2712',
        unitId: 'app/siampark-billing-finance',
        version: '0.1.0',
      },
    },
  ),
);
