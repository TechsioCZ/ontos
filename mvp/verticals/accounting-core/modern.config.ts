// @effect-diagnostics processEnv:off
import { appTools, defineConfig, presetUltramodern } from '@modern-js/app-tools';
import { bffPlugin } from '@modern-js/plugin-bff';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

type ZephyrRspackConfig = Parameters<ReturnType<typeof withZephyrRspack>>[0];

const zephyrEnabled = process.env['ULTRAMODERN_ZEPHYR'] !== 'false';
const cloudflareDeployEnabled = process.env['MODERNJS_DEPLOY'] === 'cloudflare';

const zephyrRspackPlugin = () => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: {
    modifyRspackConfig: (
      handler: (config: ZephyrRspackConfig) => ZephyrRspackConfig | Promise<ZephyrRspackConfig>,
    ) => void;
  }) {
    if (!zephyrEnabled) {
      return;
    }
    api.modifyRspackConfig((config) => withZephyrRspack()(config));
  },
});

const appId = 'accounting-core';
const cloudflareWorkerName = 'mvp-accounting-core';
const port = Number(process.env['VERTICAL_ACCOUNTING_CORE_PORT'] ?? 4102);
const envValue = (name: string) => {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_ACCOUNTING_CORE');
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
// Asset origin prefers the per-app deployment URL (each MF app serves its own
// assets). Vertical dev remotes also need a self-origin asset prefix so a shell
// on another localhost port does not fetch remote chunks from the shell origin.
const assetPrefix = configuredCloudflareUrl || configuredSiteUrl || inferredCloudflareUrl || '/';
const localDevAssetPrefix =
  configuredCloudflareUrl || configuredSiteUrl || `http://localhost:${port}/`;

if (
  cloudflareDeployEnabled &&
  process.env['ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS'] === 'true' &&
  configuredCloudflareUrl === undefined &&
  configuredSiteUrl === undefined &&
  inferredCloudflareUrl === undefined
) {
  throw new Error(
    `Cloudflare deploy for ${appId} needs ULTRAMODERN_PUBLIC_URL_ACCOUNTING_CORE, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
  );
}

export default defineConfig(
  presetUltramodern(
    {
      bff: {
        effect: {
          entry: './api/effect/index',
          openapi: {
            path: '/openapi.json',
          },
        },
        prefix: '/accounting-core-api',
        runtimeFramework: 'effect',
      },
      ...(cloudflareDeployEnabled
        ? {
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
                  cookies: {
                    mutateSetCookie: false,
                    reason:
                      'Generated Cloudflare worker does not own application Set-Cookie headers.',
                  },
                  enabled: true,
                  headers: {
                    contentTypeOptions: 'nosniff',
                    permissionsPolicy:
                      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
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
          }
        : {}),
      dev: {
        assetPrefix: localDevAssetPrefix,
      },
      html: {
        outputStructure: 'flat',
      },
      output: {
        assetPrefix,
        disableTsChecker: true,
        distPath: {
          html: './',
        },
        polyfill: 'off',
        splitRouteChunks: true,
      },
      performance: {
        rsdoctor: {
          disableClientServer: true,
          enabled: process.env['ULTRAMODERN_RSDOCTOR'] === 'true',
        },
      },
      plugins: [
        appTools(),
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
              '/accounting-core-api',
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
        ssr: {
          mode: 'string',
          moduleFederationAppSSR: true,
        },
      },
      source: {
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
            .uniqueName('verticalAccountingCore')
            .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_ACCOUNTING_CORE_LOADED_CHUNKS__');
          chain.ignoreWarnings([
            {
              message: /the request of a dependency is an expression/u,
              module: /modern-js-plugin-i18n/u,
            },
          ]);
        },
      },
    },
    {
      appId,
      enableBffRequestId: true,
      enableModuleFederationSSR: true,
      enableTelemetryExporters: true,
      telemetryFailLoudStartup: false,
    },
  ),
);
