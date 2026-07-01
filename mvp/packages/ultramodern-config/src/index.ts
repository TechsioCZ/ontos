// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { createRequire } from 'node:module';
import { appTools, defineConfig, presetUltramodern } from '@modern-js/app-tools';
import { bffPlugin } from '@modern-js/plugin-bff';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import {
  createModuleFederationConfig,
  moduleFederationPlugin,
} from '@module-federation/modern-js-v3';
import { withZephyr as withZephyrRspack } from 'zephyr-rspack-plugin';

type ZephyrRspackConfig = Parameters<ReturnType<typeof withZephyrRspack>>[0];

interface BundlerChain {
  output: {
    uniqueName: (name: string) => {
      chunkLoadingGlobal: (name: string) => void;
    };
  };
  ignoreWarnings: (warnings: { message: RegExp; module: RegExp }[]) => void;
}

const envValue = (name: string) => {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};

const sharedSingleton = (requiredVersion: string) => ({
  requiredVersion,
  singleton: true,
  treeShaking: false,
});

const createZephyrRspackPlugin = () => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: {
    modifyRspackConfig: (
      handler: (config: ZephyrRspackConfig) => ZephyrRspackConfig | Promise<ZephyrRspackConfig>,
    ) => void;
  }) {
    if (process.env['ULTRAMODERN_ZEPHYR'] === 'false') {
      return;
    }
    api.modifyRspackConfig((config) => withZephyrRspack()(config));
  },
});

const sharedCloudflareWorkerSecurity = {
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
  cookies: {
    mutateSetCookie: false as const,
    reason: 'Generated Cloudflare worker does not own application Set-Cookie headers.',
  },
  enabled: true,
  headers: {
    contentTypeOptions: 'nosniff' as const,
    permissionsPolicy: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    referrerPolicy: 'strict-origin-when-cross-origin',
  },
  noindex: {
    localhost: true as const,
    previewHostnames: [],
    workersDev: true as const,
  },
};

const sharedIgnoredLocaleRedirectRoutes = (apiPrefix: string) => [
  '/@mf-types',
  '/assets',
  '/bundles',
  apiPrefix,
  '/locales',
  '/mf-manifest.json',
  '/mf-stats.json',
  '/remoteEntry.js',
  '/robots.txt',
  '/site.webmanifest',
  '/sitemap.xml',
  '/static',
  '/zephyr-manifest.json',
];

export interface CreateUltramodernAppConfigOptions {
  apiPrefix: string;
  appId: string;
  chunkLoadingGlobal: string;
  cloudflarePublicUrlEnv: string;
  cloudflareWorkerName: string;
  defaultPort: number;
  devAssetPrefix: 'origin-relative' | 'self-origin';
  localisedUrls: Record<string, Record<string, string>>;
  portEnv: string;
  uniqueName: string;
}

export const createUltramodernAppConfig = (options: CreateUltramodernAppConfigOptions) => {
  const cloudflareDeployEnabled = process.env['MODERNJS_DEPLOY'] === 'cloudflare';
  const port = Number(process.env[options.portEnv] ?? options.defaultPort);
  const configuredSiteUrl = envValue('MODERN_PUBLIC_SITE_URL');
  const configuredCloudflareUrl = envValue(options.cloudflarePublicUrlEnv);
  const cloudflareWorkersDevSubdomain = envValue('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
  const inferredCloudflareUrl =
    cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined
      ? `https://${options.cloudflareWorkerName}.${cloudflareWorkersDevSubdomain}.workers.dev`
      : undefined;
  const siteUrl =
    configuredSiteUrl ??
    configuredCloudflareUrl ??
    inferredCloudflareUrl ??
    `http://localhost:${port}`;
  const assetPrefix = configuredCloudflareUrl ?? configuredSiteUrl ?? inferredCloudflareUrl ?? '/';
  const devAssetPrefix =
    options.devAssetPrefix === 'origin-relative'
      ? '/'
      : (configuredCloudflareUrl ?? configuredSiteUrl ?? `http://localhost:${port}/`);

  if (
    cloudflareDeployEnabled &&
    process.env['ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS'] === 'true' &&
    configuredCloudflareUrl === undefined &&
    configuredSiteUrl === undefined &&
    inferredCloudflareUrl === undefined
  ) {
    throw new Error(
      `Cloudflare deploy for ${options.appId} needs ${options.cloudflarePublicUrlEnv}, MODERN_PUBLIC_SITE_URL, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN.`,
    );
  }

  return defineConfig(
    presetUltramodern(
      {
        bff: {
          effect: {
            entry: './api/effect/index',
            openapi: {
              path: '/openapi.json',
            },
          },
          prefix: options.apiPrefix,
          runtimeFramework: 'effect',
        },
        ...(cloudflareDeployEnabled
          ? {
              deploy: {
                worker: {
                  compatibilityDate: '2026-06-02',
                  name: options.cloudflareWorkerName,
                  security: sharedCloudflareWorkerSecurity,
                  ssr: true,
                },
              },
            }
          : {}),
        dev: {
          assetPrefix: devAssetPrefix,
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
              ignoreRedirectRoutes: sharedIgnoredLocaleRedirectRoutes(options.apiPrefix),
              languages: ['en', 'cs'],
              localePathRedirect: true,
              localisedUrls: options.localisedUrls,
            },
            reactI18next: false,
          }),
          bffPlugin(),
          moduleFederationPlugin(),
          createZephyrRspackPlugin(),
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
          bundlerChain: (chain: BundlerChain) => {
            chain.output
              .uniqueName(options.uniqueName)
              .chunkLoadingGlobal(options.chunkLoadingGlobal);
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
        appId: options.appId,
        enableBffRequestId: true,
        enableModuleFederationSSR: true,
        enableTelemetryExporters: true,
        telemetryFailLoudStartup: false,
      },
    ),
  );
};

export interface CreateRemoteManifestUrlOptions {
  manifestEnv: string;
  mfName: string;
  port: number;
  publicUrlEnv: string;
  workerName?: string;
}

export const createRemoteManifestUrl = (options: CreateRemoteManifestUrlOptions) => {
  const configuredManifest = envValue(options.manifestEnv);
  if (configuredManifest !== undefined) {
    return configuredManifest;
  }

  const configuredPublicUrl = envValue(options.publicUrlEnv);
  if (configuredPublicUrl !== undefined) {
    return `${options.mfName}@${configuredPublicUrl.replace(/\/+$/u, '')}/mf-manifest.json`;
  }

  const cloudflareWorkersDevSubdomain = envValue('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
  if (
    options.workerName !== undefined &&
    process.env['MODERNJS_DEPLOY'] === 'cloudflare' &&
    cloudflareWorkersDevSubdomain !== undefined
  ) {
    return `${options.mfName}@https://${options.workerName}.${cloudflareWorkersDevSubdomain}.workers.dev/mf-manifest.json`;
  }

  if (
    options.workerName !== undefined &&
    process.env['MODERNJS_DEPLOY'] === 'cloudflare' &&
    process.env['ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS'] === 'true'
  ) {
    throw new Error(
      `Cloudflare deploy needs ${options.publicUrlEnv}, ${options.manifestEnv}, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN for remote ${options.mfName}.`,
    );
  }

  return `${options.mfName}@http://localhost:${options.port}/mf-manifest.json`;
};

interface PackageJsonWithDependencies {
  dependencies: Record<string, string>;
}

interface CreateUltramodernModuleFederationConfigOptions {
  baseUrl: string;
  exposes?: Record<string, string>;
  name: string;
  remotes?: Record<string, string>;
}

export const createUltramodernModuleFederationConfig = (
  options: CreateUltramodernModuleFederationConfigOptions,
) => {
  const require = createRequire(options.baseUrl);
  const { dependencies } = require('./package.json') as PackageJsonWithDependencies;
  const pluginI18nVersion = (require('@modern-js/plugin-i18n/package.json') as { version: string })
    .version;
  const pluginTanstackVersion = (
    require('@modern-js/plugin-tanstack/package.json') as { version: string }
  ).version;
  const runtimeVersion = (require('@modern-js/runtime/package.json') as { version: string })
    .version;
  const reactVersion = (require('react/package.json') as { version: string }).version;
  const reactDomVersion = (require('react-dom/package.json') as { version: string }).version;
  const routerVersion = dependencies['@tanstack/react-router'];
  if (routerVersion === undefined) {
    throw new Error('@tanstack/react-router must be declared before it can be shared.');
  }

  return createModuleFederationConfig({
    bridge: {
      enableBridgeRouter: false,
    },
    dev: {
      disableDynamicRemoteTypeHints: true,
    },
    dts: {
      displayErrorInTerminal: true,
      generateTypes: {
        compilerInstance: 'tsgo',
      },
    },
    ...(options.exposes === undefined ? {} : { exposes: options.exposes }),
    filename: 'remoteEntry.js',
    name: options.name,
    ...(options.remotes === undefined ? {} : { remotes: options.remotes }),
    shared: {
      '@modern-js/plugin-i18n/runtime': sharedSingleton(pluginI18nVersion),
      '@modern-js/plugin-tanstack/runtime': sharedSingleton(pluginTanstackVersion),
      '@modern-js/runtime': sharedSingleton(runtimeVersion),
      '@tanstack/react-router': sharedSingleton(routerVersion),
      react: sharedSingleton(reactVersion),
      'react-dom': sharedSingleton(reactDomVersion),
      'react-dom/client': sharedSingleton(reactDomVersion),
    },
    treeShakingSharedExcludePlugins: ['RspackModuleFederationPlugin'],
  });
};
