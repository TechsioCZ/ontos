import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeUnknownResult,
  Struct,
  optional,
  RedactedFromValue,
  String as StringSchema,
  Literals,
  NumberFromString,
  isInt,
  isBetween,
  Trim,
  isNonEmpty,
  makeFilter,
  URLFromString,
} from 'effect/Schema';
import { getOrThrow } from 'effect/Result';

import type { AppUserConfig } from '@modern-js/app-tools';
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

const appId = 'siampark-relationships';
const cloudflareWorkerName = 'app-siampark-relationships';
const HttpUrlSchema = URLFromString.check(
  makeFilter(
    (url) => url.protocol === 'http:' || url.protocol === 'https:' || 'Expected an HTTP or HTTPS deployment URL',
  ),
);
const buildEnvironment = getOrThrow(
  decodeUnknownResult(
    Struct({
      assetPrefix: optional(Trim.check(isNonEmpty())),
      failBuild: optional(Literals(['true', 'false'])),
      modernAssetPrefix: optional(Trim.check(isNonEmpty())),
      port: NumberFromString.check(isInt(), isBetween({ maximum: 65_535, minimum: 1 })),
      publicUrl: optional(HttpUrlSchema),
      siteUrl: optional(HttpUrlSchema),
      workerSubdomain: optional(Trim.check(isNonEmpty())),
      zephyrToken: optional(RedactedFromValue(StringSchema)),
    }).check(
      makeFilter(
        (config) =>
          config.zephyrToken === undefined || config.failBuild === 'true' || 'ZE_CI_TOKEN requires ZE_FAIL_BUILD=true',
      ),
    ),
  )({
    assetPrefix: getBuildConfigEnvironment('ULTRAMODERN_ASSET_PREFIX'),
    failBuild: getBuildConfigEnvironment('ZE_FAIL_BUILD'),
    modernAssetPrefix: getBuildConfigEnvironment('MODERN_ASSET_PREFIX'),
    port: getBuildConfigEnvironment('VERTICAL_SIAMPARK_RELATIONSHIPS_PORT') ?? String(developmentOverlay.ports[appId]),
    publicUrl: getBuildConfigEnvironment('ULTRAMODERN_PUBLIC_URL_SIAMPARK_RELATIONSHIPS'),
    siteUrl: getBuildConfigEnvironment('MODERN_PUBLIC_SITE_URL'),
    workerSubdomain: getBuildConfigEnvironment('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN'),
    zephyrToken: getBuildConfigEnvironment('ZE_CI_TOKEN'),
  }),
);
const cloudflareDeployEnabled = resolveDeployTarget().target === 'cloudflare';

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
    // opt-out). The deploy environment sets ZE_FAIL_BUILD=true next to
    // ZE_CI_TOKEN so an upload failure is a hard build failure.
    if (buildEnvironment.zephyrToken === undefined) {
      return;
    }
    api.modifyRspackConfig(withZephyrRspack());
  },
});

const { port } = buildEnvironment;
const configuredSiteUrl = buildEnvironment.siteUrl?.href;
const configuredCloudflareUrl = buildEnvironment.publicUrl?.href;
const configuredUltramodernAssetPrefix = buildEnvironment.assetPrefix;
const configuredModernAssetPrefix = buildEnvironment.modernAssetPrefix;
const moduleFederationDevServerAllowedOrigins = Object.values(developmentOverlay.ports).map(
  (localPort) => `http://localhost:${localPort}`,
);
const cloudflareWorkersDevSubdomain = buildEnvironment.workerSubdomain;
const inferredCloudflareUrl =
  cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
    ? getOrThrow(
        decodeUnknownResult(HttpUrlSchema)(
          `https://${cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`,
        ),
      )
    : undefined;
// Site origin (SEO: canonical/hreflang URLs) prefers the site-wide public URL;
// the per-app deployment URL only fills in when no site origin is configured.
const localOrigin = getOrThrow(decodeUnknownResult(HttpUrlSchema)(`http://localhost:${port}`));
const siteUrl = configuredSiteUrl ?? configuredCloudflareUrl ?? inferredCloudflareUrl?.href ?? localOrigin.href;
const remoteAssetOrigin =
  buildEnvironment.publicUrl ?? inferredCloudflareUrl ?? (cloudflareDeployEnabled ? undefined : localOrigin);
// When deploying to Cloudflare without a configured public URL, publish an
// 'auto' publicPath so the remote resolves its chunks from the origin its
// remoteEntry.js was loaded from (the vertical's Worker), not the host shell's
// origin — otherwise cross-origin chunk loading 404s and MF reports an empty
// moduleId. A configured/inferred URL still wins as an absolute prefix.
const defaultRemoteAssetPrefix = remoteAssetOrigin === undefined ? 'auto' : `${remoteAssetOrigin.origin}/`;
const defaultAssetPrefix = defaultRemoteAssetPrefix;
// Asset loading is intentionally independent from the canonical site URL.
// Module Federation remotes must publish an absolute publicPath so browsers
// load remoteEntry.js and exposed chunks from the remote origin, not the host.
const assetPrefix = configuredModernAssetPrefix ?? configuredUltramodernAssetPrefix ?? defaultAssetPrefix;
const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';
const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';
const buildTempDirectory = `node_modules/.modern-build-${appId}-${buildTarget}`;
const buildCacheDirectory = `node_modules/.cache/rspack-${appId}-${buildTarget}`;

type DeployOptions = Pick<AppUserConfig, 'deploy'>;
const deployOptions: DeployOptions = {};
if (cloudflareDeployEnabled) {
  deployOptions.deploy = {
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
  };
}

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
        prefix: '/siampark-relationships-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      ...deployOptions,
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
              '/siampark-relationships-api',
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
            .uniqueName('verticalSiamparkRelationships')
            .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_SIAMPARK_RELATIONSHIPS_LOADED_CHUNKS__');
        },
        tsChecker: {
          typescript: {
            build: false,
          },
        },
      },
    },
    {
      appId,
      deliveryUnit: {
        buildMarker: '34118b88515b135e',
        unitId: 'app/siampark-relationships',
        version: '0.1.0',
      },
    },
  ),
);
