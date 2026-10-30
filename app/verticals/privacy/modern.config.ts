import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identity-data.ts';
import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';

const appId = 'privacy';

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createWorkspaceModernConfig({
        appId,
        cloudflareHyperdrives: [SHARED_RUNTIME_IDENTITY.cloudflareHyperdrive],
        moduleUrl: import.meta.url,
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/privacy-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
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
              '/locales',
              '/mf-manifest.json',
              '/mf-stats.json',
              '/privacy-api',
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
    },
    { appId, from: import.meta.url },
  ),
);
