import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identity-data.ts';
import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata.ts';

const appId = 'finance-billing';

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
        prefix: '/finance-billing-api',
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
              '/finance-billing-api',
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
      ],
    },
    { appId, from: import.meta.url },
  ),
);
