// @effect-diagnostics nodeBuiltinImport:off
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appTools, defineConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment } from '@modern-js/app-tools/config';
import { bffPlugin } from '@modern-js/plugin-bff';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';

import {
  projectsCorsAllowedHeaders,
  projectsCorsAllowedMethods,
  projectsCorsAllowedOrigins,
} from './shared/cors.ts';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const appId = 'projects';
const cloudflareWorkerName = 'app-projects';
const cloudflareDeployEnabled = getBuildConfigEnvironment('MODERNJS_DEPLOY') === 'cloudflare';
const port = Number(getBuildConfigEnvironment('VERTICAL_PROJECTS_PORT') ?? 4102);
const envValue = (name: string) => {
  const value = getBuildConfigEnvironment(name)?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};
const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
const configuredCloudflareUrl = envValue('ULTRAMODERN_PUBLIC_URL_PROJECTS');
const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX');
const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX');
const moduleFederationDevServerOrigin =
  envValue('ULTRAMODERN_MF_DEV_ORIGIN') || 'http://localhost:3020';
const cloudflareWorkersDevSubdomain = envValue('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
const inferredCloudflareUrl =
  cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
    ? `https://${cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`
    : undefined;
const siteUrl =
  configuredSiteUrl ??
  configuredCloudflareUrl ??
  inferredCloudflareUrl ??
  `http://localhost:${port}`;
const remoteAssetOrigin =
  configuredCloudflareUrl ??
  inferredCloudflareUrl ??
  (cloudflareDeployEnabled ? '' : `http://localhost:${port}`);
const defaultAssetPrefix =
  remoteAssetOrigin.length > 0 ? `${remoteAssetOrigin.replace(/\/+$/u, '')}/` : 'auto';
const assetPrefix =
  configuredModernAssetPrefix ?? configuredUltramodernAssetPrefix ?? defaultAssetPrefix;
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
    `Cloudflare deploy for ${appId} needs ULTRAMODERN_PUBLIC_URL_PROJECTS, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
  );
}

const postgresProtocolCommonJsEntry = fileURLToPath(
  new URL('../pg-protocol/dist/index.js', import.meta.resolve('pg/package.json')),
);
const postgresPoolCommonJsEntry = createRequire(import.meta.resolve('pg/package.json')).resolve(
  'pg-pool',
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
const moduleFederationConfigPath = fileURLToPath(
  new URL('module-federation.config.ts', import.meta.url),
);

const cloudflareDeployment = cloudflareDeployEnabled
  ? {
      deploy: {
        worker: {
          compatibilityDate: '2026-06-02',
          name: cloudflareWorkerName,
          security: {
            cors: {
              allowedHeaders: [...projectsCorsAllowedHeaders],
              allowedMethods: [...projectsCorsAllowedMethods],
              allowedOrigins: projectsCorsAllowedOrigins(moduleFederationDevServerOrigin),
              assets: true,
              reason: 'Allow the configured Shell to load Projects assets and invoke its BFF.',
            },
            enabled: true,
          },
          ssr: true,
        },
      },
    }
  : {};

export default defineConfig({
  bff: {
    effect: {
      entry: './api/index',
      openapi: {
        path: '/openapi.json',
      },
      strictEffectApproach: true,
    },
    prefix: '/projects-api',
    runtimeFramework: 'effect',
  },
  ...cloudflareDeployment,
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
    moduleFederationPlugin({ configPath: moduleFederationConfigPath }),
  ],
  server: {
    port,
    ssr: {
      mode: 'stream',
      moduleFederationAppSSR: true,
    },
  },
  source: {
    globalVars: {
      ULTRAMODERN_SHELL_ORIGIN: moduleFederationDevServerOrigin,
      ULTRAMODERN_SITE_URL: siteUrl,
    },
    mainEntryName: 'index',
  },
  tools: {
    bundlerChain: (chain) => {
      chain.output
        .uniqueName('verticalProjects')
        .chunkLoadingGlobal('__ULTRAMODERN_VERTICAL_PROJECTS_LOADED_CHUNKS__');
    },
    devServer: {
      headers: {
        'Access-Control-Allow-Headers': projectsCorsAllowedHeaders.join(', '),
        'Access-Control-Allow-Methods': projectsCorsAllowedMethods.join(', '),
        'Access-Control-Allow-Origin': moduleFederationDevServerOrigin,
      },
    },
    rspack: (config, { environment, rspack }) => {
      if (!cloudflareDeployEnabled) {
        return;
      }
      const configuredAliases = config.resolve.alias;
      config.resolve.alias =
        configuredAliases === false || configuredAliases === undefined ? {} : configuredAliases;
      Object.assign(config.resolve.alias, {
        'pg-pool$': postgresPoolCommonJsEntry,
        'pg-protocol$': postgresProtocolCommonJsEntry,
      });
      const configuredExternals = config.externals;
      config.externals = [cloudflareRuntimeExternal];
      if (configuredExternals !== undefined) {
        config.externals.push(
          ...(Array.isArray(configuredExternals) ? configuredExternals : [configuredExternals]),
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
              path.resolve(resource.context, requestPath).startsWith(effectApiSourceDirectory) &&
              !resource.request.includes('modern-bff-runtime-source')
            ) {
              resource.request = `${resource.request}?modern-bff-runtime-source`;
            }
          }),
        );
      }
    },
  },
});
