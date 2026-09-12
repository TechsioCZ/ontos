/* oxlint-disable sonarjs/no-duplicate-string -- Modern.js BFF routing requires the deployment prefix in the shared build, locale exclusion and runtime sections; remove-when: the config API accepts one shared prefix value. */
import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import { getBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';

import {
  createModernBuildContext,
  createModernConfig,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

installGlobalRequire(import.meta.url);

const appId = 'commerce-customer-context';
const cloudflareWorkerName = 'app-commerce-customer-context';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT',
  cloudflareWorkerName,
  defaultPort: 4101,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_COMMERCE_CUSTOMER_CONTEXT_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        appId,
        bffPrefix: '/commerce-customer-context-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_COMMERCE_CUSTOMER_CONTEXT_LOADED_CHUNKS__',
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
                '/commerce-customer-context-api',
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
        uniqueName: 'verticalCommerceCustomerContext',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/commerce-customer-context-api',
        runtimeFramework: 'effect',
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '2b4d72d8d032dd53',
        unitId: 'app/commerce-customer-context',
        version: '0.1.0',
      },
    },
  ),
);
