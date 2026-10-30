import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identity-data.ts';
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
const buildTarget = resolveDeployTarget().target === 'cloudflare' ? 'cloudflare' : 'web';

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
        prefix: '/facility-operations-api',
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      performance: {
        buildCache: { cacheDigest: [appId, buildTarget, localeCacheDigest] },
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
