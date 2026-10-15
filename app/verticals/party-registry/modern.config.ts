import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';

import {
  createModernBuildContext,
  createWorkspaceModernConfig,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

installGlobalRequire(import.meta.url);

const appId = 'party-registry';
const cloudflareWorkerName = 'app-party-registry';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY',
  cloudflareWorkerName,
  defaultPort: 4102,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PARTY_REGISTRY_PORT',
});

// The workspace preset derives the delivery identity, renderer, port, asset prefix, output, dev CORS,
// Zephyr upload, chunk namespace and Worker identity from topology; OntOS adds its data plane, module
// contract and runtime externals.
export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createWorkspaceModernConfig({
        build,
        moduleUrl: import.meta.url,
        plugins: [
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
          moduleFederationPlugin(),
        ],
      }),
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
    },
    { appId, from: import.meta.url },
  ),
);
