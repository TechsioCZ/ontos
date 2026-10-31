import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';

const appId = 'pricing';

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createWorkspaceModernConfig({
        appId,
        headless: true,
        moduleUrl: import.meta.url,
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: '/pricing-api',
        runtimeFramework: 'effect',
      },
      plugins: [bffPlugin()],
    },
    { appId, from: import.meta.url },
  ),
);
