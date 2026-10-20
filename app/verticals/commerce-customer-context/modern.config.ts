import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import {
  CLOUDFLARE_WORKER_CPU_MS,
  createWorkspaceModernConfig,
} from '../../packages/shared-contracts/tooling/modern-config.ts';

const appId = 'commerce-customer-context';

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createWorkspaceModernConfig({
        appId,
        cloudflareCpuMs: CLOUDFLARE_WORKER_CPU_MS.largeApiVertical,
        cloudflareHyperdrives: [SHARED_RUNTIME_IDENTITY.cloudflareHyperdrive],
        headless: true,
        moduleUrl: import.meta.url,
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
      plugins: [bffPlugin()],
    },
    { appId, from: import.meta.url },
  ),
);
