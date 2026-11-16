import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';

import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...createWorkspaceModernConfig({
        appId: 'symmy-integration',
        headless: true,
        moduleUrl: import.meta.url,
      }),
      bff: {
        effect: {
          entry: './api/index',
          openapi: {
            path: '/openapi.json',
          },

          strictEffectApproach: true,
        },
        prefix: '/symmy-integration-api',
        runtimeFramework: 'effect',
      },
      plugins: [bffPlugin()],
    },
    {
      appId: 'symmy-integration',
      from: import.meta.url,
    },
  ),
);
