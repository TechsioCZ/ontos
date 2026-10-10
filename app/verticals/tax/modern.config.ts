import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
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

const appId = 'tax';
const cloudflareWorkerName = 'app-tax';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_TAX',
  cloudflareWorkerName,
  defaultPort: 4112,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_TAX_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        apiOnly: true,
        appId,
        bffPrefix: '/tax-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_TAX_LOADED_CHUNKS__',
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
                '/tax-api',
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
        uniqueName: 'verticalTax',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/tax-api',
        runtimeFramework: 'effect',
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '5c4b3253f7d46679',
        unitId: 'app/tax',
        version: '0.1.0',
      },
    },
  ),
);
