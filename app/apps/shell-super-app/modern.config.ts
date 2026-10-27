import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { getBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { getOrThrow as getResultOrThrow } from 'effect/Result';
import {
  Array as SchemaArray,
  NonEmptyString,
  Struct,
  check,
  decodeUnknownResult,
  fromJsonString,
  makeFilter,
} from 'effect/Schema';
import {
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../packages/core-runtime/src/db/database-identity-data.ts';
import {
  createCloudflareEmailBindings,
  createWorkspaceModernConfig,
} from '../../packages/shared-contracts/tooling/modern-config.ts';
import { ROOT_ROUTES } from './shared/mcp-resource.ts';
import { OAUTH_METADATA_ROUTES } from './shared/oauth-metadata-routes.ts';

const appId = 'shell-super-app';

const referenceTopologyPath = fileURLToPath(new URL('../../topology/reference-topology.json', import.meta.url));
// This is a build check of the native BFF convention, never a runtime module registry.
const NativeBffTopologySchema = Struct({
  verticals: SchemaArray(
    Struct({
      api: Struct({ bff: Struct({ prefix: NonEmptyString }) }),
      id: NonEmptyString,
    }).pipe(
      check(
        makeFilter(({ api, id }) =>
          api.bff.prefix === `/${id}-api` ? undefined : `Native module dispatch requires /${id}-api`,
        ),
      ),
    ),
  ),
});
getResultOrThrow(
  decodeUnknownResult(fromJsonString(NativeBffTopologySchema))(readFileSync(referenceTopologyPath, 'utf-8')),
);

const ontos = createWorkspaceModernConfig({
  appId,
  // Shell reaches PostgreSQL as the shared runtime and, for gateway scope grants only, as the issuer.
  cloudflareHyperdrives: [
    SHARED_RUNTIME_IDENTITY.cloudflareHyperdrive,
    SHELL_GATEWAY_ISSUER_IDENTITY.cloudflareHyperdrive,
  ],
  moduleUrl: import.meta.url,
});

const shellDeploy = { ...ontos.deploy, releaseEnvelopeRole: 'shell' as const };
if (ontos.deploy !== undefined) {
  Object.assign(shellDeploy, {
    worker: {
      ...ontos.deploy.worker,
      // Node root middleware is not executable in the Worker artifact.
      publicAssetExcludes: ['server'],
      rootRoutes: {
        metadata: Object.fromEntries(OAUTH_METADATA_ROUTES),
        routes: Object.fromEntries(ROOT_ROUTES),
      },
      wrangler: {
        ...ontos.deploy.worker.wrangler,
        ...createCloudflareEmailBindings(getBuildConfigEnvironment),
      },
    },
  });
}

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...ontos,
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/shell-super-app-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      deploy: shellDeploy,
      dev: { ...ontos.dev, lazyCompilation: getBuildConfigEnvironment('CI') ? false : undefined },
      plugins: [
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
              // The Shell runtime contract the Application Composition publisher observes.
              '/.well-known',
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
          },
          reactI18next: false,
        }),
        moduleFederationPlugin({
          configPath: fileURLToPath(new URL('module-federation.config.ts', import.meta.url)),
        }),
      ],
      server: {
        ...ontos.server,
        publicDir: ['./.dev-public', './locales', './assets'],
        ssr: { mode: 'stream', moduleFederationAppSSR: true },
      },
      source: {
        ...ontos.source,
        globalVars: {
          ...ontos.source.globalVars,
          'globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT':
            getBuildConfigEnvironment('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT') ??
            (ontos.deploy === undefined ? 'http://localhost:3070' : ''),
        },
      },
      splitChunks: { chunks: 'async' },
    },
    {
      appId,
      enableBffRequestId: true,
      enableModuleFederationSSR: true,
      enableTelemetryExporters: true,
      from: import.meta.url,
      telemetryFailLoudStartup: false,
    },
  ),
);
