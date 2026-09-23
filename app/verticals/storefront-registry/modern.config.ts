/* oxlint-disable sonarjs/no-duplicate-string -- Modern.js BFF routing requires the deployment prefix in multiple generated sections; expires: 2027-03-31. */
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

const appId = 'storefront-registry';
const cloudflareWorkerName = 'app-storefront-registry';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_STOREFRONT_REGISTRY',
  cloudflareWorkerName,
  defaultPort: 4107,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_STOREFRONT_REGISTRY_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        appId,
        bffPrefix: '/storefront-registry-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_STOREFRONT_REGISTRY_LOADED_CHUNKS__',
        cloudflareWorkerName,
        moduleUrl: import.meta.url,
        plugins: [
          ultramodernAppTools(),
          tanstackRouterPlugin(),
          i18nPlugin({
            backend: { enabled: true, loadPath: '/locales/{{lng}}/{{ns}}.json' },
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
                '/remoteEntry.js',
                '/robots.txt',
                '/site.webmanifest',
                '/sitemap.xml',
                '/static',
                '/storefront-registry-api',
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
        uniqueName: 'verticalStorefrontRegistry',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/storefront-registry-api',
        runtimeFramework: 'effect',
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '6e1423f340df12ea',
        unitId: 'app/storefront-registry',
        version: '0.1.0',
      },
    },
  ),
);
