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

const appId = 'payment-term-catalog';
const cloudflareWorkerName = 'app-payment-term-catalog';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PAYMENT_TERM_CATALOG',
  cloudflareWorkerName,
  defaultPort: 4103,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PAYMENT_TERM_CATALOG_PORT',
});

export default defineConfig(
  presetUltramodern(
    {
      ...createModernConfig({
        apiOnly: true,
        appId,
        bffPrefix: '/payment-term-catalog-api',
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PAYMENT_TERM_CATALOG_LOADED_CHUNKS__',
        cloudflareWorkerName,
        moduleUrl: import.meta.url,
        plugins: [ultramodernAppTools(), bffPlugin()],
        rsdoctorEnabled: build.getBuildBoolean('ULTRAMODERN_RSDOCTOR'),
        uniqueName: 'verticalPaymentTermCatalog',
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/payment-term-catalog-api',
        runtimeFramework: 'effect',
      },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '1c20de722548cc76',
        unitId: 'app/payment-term-catalog',
        version: '0.1.0',
      },
    },
  ),
);
