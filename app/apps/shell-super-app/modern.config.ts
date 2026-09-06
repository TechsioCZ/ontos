import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appTools, defineConfig, presetUltramodern } from '@modern-js/app-tools';
import type { AppTools, AppToolsUserConfig, CliPlugin } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, withBuildConfigEnvironment } from '@modern-js/app-tools/config';
import { bffPlugin } from '@modern-js/plugin-bff';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';
import { createModuleDeploymentAllowlistBuildInput } from './module-deployment-allowlist.config.ts';

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

const cloudflareDeployEnabled = getBuildConfigEnvironment('MODERNJS_DEPLOY') === 'cloudflare';
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
const nodeBuiltinRequests = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
/* oxlint-disable promise/prefer-await-to-callbacks -- Rspack externals use a callback API. */
const cloudflareRuntimeExternal = (
  { dependencyType, request }: { dependencyType?: string; request?: string },
  callback: (error?: Error, result?: string | string[], type?: 'module-import') => void,
) => {
  const nativeModuleImport = (specifier: string) =>
    dependencyType?.startsWith('commonjs') === true ? [specifier, 'default'] : specifier;
  if (request === 'cloudflare:sockets') {
    callback(undefined, nativeModuleImport(request), 'module-import');
    return;
  }
  if (request !== undefined && nodeBuiltinRequests.has(request)) {
    callback(
      undefined,
      nativeModuleImport(request.startsWith('node:') ? request : `node:${request}`),
      'module-import',
    );
    return;
  }
  callback();
};
/* oxlint-enable promise/prefer-await-to-callbacks */

const zephyrRspackPlugin = (): CliPlugin<AppTools> => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api) {
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

const appId = 'shell-super-app';
const moduleFederationConfigPath = fileURLToPath(
  new URL('module-federation.config.ts', import.meta.url),
);
const referenceTopologyPath = fileURLToPath(
  new URL('../../topology/reference-topology.json', import.meta.url),
);
const referenceTopology: unknown = JSON.parse(readFileSync(referenceTopologyPath, 'utf-8'));
const developmentOverlayPath = fileURLToPath(
  new URL('../../topology/local-overlays/development.json', import.meta.url),
);
const developmentOverlay: unknown = JSON.parse(readFileSync(developmentOverlayPath, 'utf-8'));
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
const port = Number(getBuildConfigEnvironment('SHELL_SUPER_APP_PORT') ?? 3020);
const envValue = (name: string) => {
  const value = getBuildConfigEnvironment(name)?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP');
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
  getBuildConfigEnvironment('ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS') === 'true' &&
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
          services: [
            {
              binding:
                envValue('VERTICAL_PARTY_REGISTRY_WORKER_BINDING') ??
                'VERTICAL_PARTY_REGISTRY_WORKER',
              prefix: '/party-registry-api',
              service: envValue('VERTICAL_PARTY_REGISTRY_WORKER_NAME') ?? 'app-party-registry',
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
                new rspack.DefinePlugin({
                  'globalThis.FinalizationRegistry': 'undefined',
                }),
                new rspack.NormalModuleReplacementPlugin(/[?&]loaderId=/u, (resource) => {
                  resource.request = resource.request.replace(
                    /(?<separator>[?&])retain=[^&]*/u,
                    '$<separator>retain=true',
                  );
                }),
                new rspack.NormalModuleReplacementPlugin(/^\.\.?[/\\]/u, (resource) => {
                  const [requestPath] = resource.request.split('?', 1);
                  if (
                    requestPath !== undefined &&
                    path
                      .resolve(resource.context, requestPath)
                      .startsWith(effectApiSourceDirectory) &&
                    !resource.request.includes('modern-bff-runtime-source')
                  ) {
                    resource.request = `${resource.request}?modern-bff-runtime-source`;
                  }
                }),
                new rspack.NormalModuleReplacementPlugin(
                  /^contacts\//u,
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
