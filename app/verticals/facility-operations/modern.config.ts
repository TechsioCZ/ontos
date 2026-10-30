import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata.ts';

const appId = 'facility-operations';

const localeDigest = createHash('sha256');
for (const language of ['cs', 'en']) {
  for (const agenda of ['agenda', 'assets', 'documents', 'meters', 'purchasing', 'security']) {
    localeDigest.update(readFileSync(new URL(`locales/${language}/agendas/${agenda}.json`, import.meta.url)));
  }
}
const localeCacheDigest = localeDigest.digest('hex');

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createWorkspaceModernConfig({
        appId,
        moduleUrl: import.meta.url,
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/facility-operations-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      performance: {
        buildCache: { cacheDigest: [appId, 'web', localeCacheDigest] },
      },
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
              '/facility-operations-api',
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
