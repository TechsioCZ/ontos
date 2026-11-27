import { fileURLToPath } from 'node:url';
import { getBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';

const appId = 'catalog';
const workspaceConfig = createWorkspaceModernConfig({
  appId,
  moduleUrl: import.meta.url,
});

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...workspaceConfig,
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/catalog-api',
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
              '/catalog-api',
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
      ],
      source: {
        ...workspaceConfig.source,
        globalVars: {
          ...workspaceConfig.source?.globalVars,
          ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT:
            getBuildConfigEnvironment('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT') ?? 'http://localhost:3070',
        },
      },
    },
    { appId, from: import.meta.url },
  ),
);
