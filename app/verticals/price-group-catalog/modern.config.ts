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

const appId = 'price-group-catalog';
const cloudflareWorkerName = 'app-price-group-catalog';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG',
  cloudflareWorkerName,
  defaultPort: 4108,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PRICE_GROUP_CATALOG_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        apiOnly: true,
        appId,
        bffPrefix: '/price-group-catalog-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PRICE_GROUP_CATALOG_LOADED_CHUNKS__',
        cloudflareWorkerName,
        moduleUrl: import.meta.url,
        plugins: [ultramodernAppTools(), bffPlugin()],
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
