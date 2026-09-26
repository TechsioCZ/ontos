import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@modern-js/app-tools';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import type { AppTools, AppToolsUserConfig, CliPlugin } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, withBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';

import {
  createCloudflareWorkerSecurity,
  createModernBuildContext,
  createWorkerSsrPlugins,
  createZephyrRspackPlugin,
  resolveCloudflareExternal,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const resolveDevelopmentModuleContractPath = () =>
  fileURLToPath(new URL('.dev-public/.well-known/ontos-module-manifest.json', import.meta.url));

const appId = 'party-registry';
const cloudflareWorkerName = 'app-party-registry';
const {
  assetPrefix,
  buildCacheDirectory,
  buildOutputRoot,
  buildTarget,
  buildTempDirectory,
  cloudflareDeployEnabled,
  envValue,
  moduleFederationDevServerOrigin,
  port,
  siteUrl,
} = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY',
  cloudflareWorkerName,
  defaultPort: 4102,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PARTY_REGISTRY_PORT',
});
const resolveEffectApiSourceDirectory = () => fileURLToPath(new URL('api/', import.meta.url));
/* oxlint-disable promise/prefer-await-to-callbacks -- Rspack externals use a callback API. expires: 2026-12-31. */
const cloudflareRuntimeExternal = (
  request: { dependencyType?: string; request?: string },
  callback: (error?: Error, result?: string | string[], type?: 'module-import') => void,
) => {
  callback(...resolveCloudflareExternal(request, cloudflareDeployEnabled));
};
/* oxlint-enable promise/prefer-await-to-callbacks */

const zephyrRspackPlugin = (): CliPlugin<AppTools> =>
  createZephyrRspackPlugin({
    readToken: () => envValue('ZE_CI_TOKEN'),
    configure: () => withBuildConfigEnvironment('ZE_FAIL_BUILD', 'true', withZephyrRspack()),
  });

// The dev server serves federated assets to every local app origin, so the
// allowed origin is negotiated per request instead of pinned to one header.
const moduleFederationDevServerAllowedOrigins = [
  ...new Set([moduleFederationDevServerOrigin, `http://localhost:${port}`]),
];

const whenEnabled = <Configuration>(enabled: boolean, configuration: Configuration) =>
  enabled ? configuration : undefined;

const appDevServerHeaders: NonNullable<NonNullable<NonNullable<AppToolsUserConfig['dev']>['server']>['headers']> = {
  'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};

const cloudflareDeployment = whenEnabled(cloudflareDeployEnabled, {
  deploy: {
    worker: {
      compatibilityDate: '2026-06-02',
      name: cloudflareWorkerName,
      security: createCloudflareWorkerSecurity(),
      ssr: true,
    },
  },
} satisfies Pick<AppToolsUserConfig, 'deploy'>);

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
        prefix: '/party-registry-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      ...cloudflareDeployment,
      dev: {
        // Remote dev manifests must publish an absolute publicPath so host
        // shells load remoteEntry.js and exposed chunks from this dev server.
        assetPrefix,
        server: {
          // MF assets are non-credentialed and only permit configured local app origins.
          cors: {
            origin: moduleFederationDevServerAllowedOrigins,
          },
          headers: appDevServerHeaders,
        },
        setupMiddlewares: [
          ({ unshift }) => {
            unshift((request, response, next) => {
              if (request.url?.split('?', 1)[0] !== '/.well-known/ontos-module-manifest.json') {
                next();
                return;
              }
              const contract = readFileSync(resolveDevelopmentModuleContractPath());
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
              '/party-registry-api',
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
        bffPlugin(),
        moduleFederationPlugin({
          configPath: fileURLToPath(new URL('module-federation.config.ts', import.meta.url)),
        }),
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
          ULTRAMODERN_SHELL_ORIGIN: envValue('ULTRAMODERN_MF_DEV_ORIGIN') ?? 'http://localhost:3020',
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
            .uniqueName('verticalPartyRegistry')
            .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_PARTY_REGISTRY_LOADED_CHUNKS__');
        },
        rspack: (config, { environment, rspack }) => {
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
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '3f023644c8a07e9a',
        unitId: 'app/party-registry',
        version: '0.1.0',
      },
    },
  ),
);
