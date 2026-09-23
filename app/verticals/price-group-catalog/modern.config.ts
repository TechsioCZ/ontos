/* oxlint-disable sonarjs/no-duplicate-string -- Modern.js BFF routing requires the deployment prefix in the shared build, locale exclusion and runtime sections; remove-when: the config API accepts one shared prefix value. */
import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';

import {
  createModernBuildContext,
  createModernConfig,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

installGlobalRequire(import.meta.url);

const appId = 'price-group-catalog';
const cloudflareWorkerName = 'app-price-group-catalog';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG',
  cloudflareWorkerName,
  defaultPort: 4104,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PRICE_GROUP_CATALOG_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        appId,
        bffPrefix: '/price-group-catalog-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PRICE_GROUP_CATALOG_LOADED_CHUNKS__',
        cloudflareWorkerName,
        moduleUrl: import.meta.url,
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
                '/price-group-catalog-api',
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
        ],
        rsdoctorEnabled: build.getBuildBoolean('ULTRAMODERN_RSDOCTOR'),
        uniqueName: 'verticalPriceGroupCatalog',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/price-group-catalog-api',
        runtimeFramework: 'effect',
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: 'af022b7822b7562c',
        unitId: 'app/price-group-catalog',
        version: '0.1.0',
      },
    },
  ),
);
