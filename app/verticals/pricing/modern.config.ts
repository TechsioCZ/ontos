/* oxlint-disable sonarjs/no-duplicate-string -- Modern.js BFF routing requires the deployment prefix in multiple generated sections; remove-when: the generated config accepts one shared prefix value. */
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

const appId = 'pricing';
const cloudflareWorkerName = 'app-pricing';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PRICING',
  cloudflareWorkerName,
  defaultPort: 4106,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PRICING_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        appId,
        bffPrefix: '/pricing-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PRICING_LOADED_CHUNKS__',
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
                '/pricing-api',
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
        uniqueName: 'verticalPricing',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/pricing-api',
        runtimeFramework: 'effect',
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '472426e9fbfd8da9',
        unitId: 'app/pricing',
        version: '0.1.0',
      },
    },
  ),
);
