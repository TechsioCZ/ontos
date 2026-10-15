import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
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
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_STOREFRONT_REGISTRY_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        apiOnly: true,
        appId,
        bffPrefix: '/storefront-registry-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_STOREFRONT_REGISTRY_LOADED_CHUNKS__',
        cloudflareWorkerName,
        moduleUrl: import.meta.url,
        plugins: [ultramodernAppTools(), bffPlugin()],
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
