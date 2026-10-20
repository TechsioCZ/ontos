import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { presetUltramodernWorkspace, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';

import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  createHeadlessModernConfig,
  createModernBuildContext,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

installGlobalRequire(import.meta.url);

const appId = 'price-group-catalog';
const bffPrefix = '/price-group-catalog-api';
const cloudflareWorkerName = 'app-price-group-catalog';
const build = createModernBuildContext({
  appId,
  cloudflareHyperdrives: [SHARED_RUNTIME_IDENTITY.cloudflareHyperdrive],
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG',
  cloudflareWorkerName,
  defaultPort: 4108,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PRICE_GROUP_CATALOG_PORT',
});

// Headless unit: the workspace preset derives its delivery identity, port, output, dev CORS and Worker
// identity from topology; OntOS adds its data plane, module contract and runtime externals.
export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createHeadlessModernConfig({
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PRICE_GROUP_CATALOG_LOADED_CHUNKS__',
        moduleUrl: import.meta.url,
        plugins: [ultramodernAppTools(), bffPlugin()],
        uniqueName: 'verticalPriceGroupCatalog',
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
    } satisfies AppToolsUserConfig,
    { appId, from: import.meta.url },
  ),
);
