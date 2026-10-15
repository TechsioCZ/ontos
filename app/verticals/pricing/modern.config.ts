import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { presetUltramodernWorkspace, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';

import {
  createHeadlessModernConfig,
  createModernBuildContext,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

installGlobalRequire(import.meta.url);

const appId = 'pricing';
const bffPrefix = '/pricing-api';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_PRICING',
  cloudflareWorkerName: 'app-pricing',
  defaultPort: 4106,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_PRICING_PORT',
});

// Headless unit: the workspace preset derives its delivery identity, port, output, dev CORS and Worker
// identity from topology; OntOS adds its data plane, module contract and runtime externals.
export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createHeadlessModernConfig({
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PRICING_LOADED_CHUNKS__',
        moduleUrl: import.meta.url,
        plugins: [ultramodernAppTools(), bffPlugin()],
        uniqueName: 'verticalPricing',
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
