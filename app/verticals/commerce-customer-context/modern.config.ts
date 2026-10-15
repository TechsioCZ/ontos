import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { presetUltramodernWorkspace, ultramodernAppTools } from '@modern-js/ultramodern-app-tools';

import {
  CLOUDFLARE_WORKER_CPU_MS,
  createHeadlessModernConfig,
  createModernBuildContext,
  installGlobalRequire,
} from '../../packages/shared-contracts/tooling/modern-config.ts';
import { COMMERCE_CUSTOMER_CONTEXT_API_PREFIX } from './shared/deployment-paths.ts';

installGlobalRequire(import.meta.url);

const appId = 'commerce-customer-context';
const bffPrefix = COMMERCE_CUSTOMER_CONTEXT_API_PREFIX;
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT',
  cloudflareWorkerName: 'app-commerce-customer-context',
  defaultPort: 4101,
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_COMMERCE_CUSTOMER_CONTEXT_PORT',
});

// Headless unit: the workspace preset derives its delivery identity, port, output, dev CORS and Worker
// identity from topology; OntOS adds its data plane, module contract and runtime externals.
export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createHeadlessModernConfig({
        build,
        chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_COMMERCE_CUSTOMER_CONTEXT_LOADED_CHUNKS__',
        cloudflareCpuMs: CLOUDFLARE_WORKER_CPU_MS.largeApiVertical,
        moduleUrl: import.meta.url,
        plugins: [ultramodernAppTools(), bffPlugin()],
        uniqueName: 'verticalCommerceCustomerContext',
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
