import { defineConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { presetUltramodern, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';

import {
  createModernBuildContext,
  createModernConfig,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

installGlobalRequire(import.meta.url);

const appId = 'privacy';
const bffPrefix = '/privacy-api';
const cloudflareWorkerName = 'app-privacy';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PRIVACY',
  cloudflareWorkerName,
  defaultPort: 4112,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PRIVACY_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        appId,
        bffPrefix,
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PRIVACY_LOADED_CHUNKS__',
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
        rsdoctorEnabled: build.getBuildBoolean('ULTRAMODERN_RSDOCTOR'),
        uniqueName: 'verticalPrivacy',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: bffPrefix,
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
    },
    {
      appId,
      deliveryUnit: {
        buildMarker: '00f31ee28a035d1a',
        unitId: 'app/privacy',
        version: '0.1.0',
      },
    },
  ),
);
