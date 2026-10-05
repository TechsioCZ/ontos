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
import developmentOverlay from '../../topology/local-overlays/development.json';

installGlobalRequire(import.meta.url);

const appId = 'availability';
const bffPrefix = '/availability-api';
const cloudflareWorkerName = 'app-availability';
const build = createModernBuildContext({
  appId,
  cloudflarePublicUrlEnvironmentVariable: 'ULTRAMODERN_PUBLIC_URL_AVAILABILITY',
  cloudflareWorkerName,
  defaultPort: developmentOverlay.ports[appId],
  deployTarget: resolveDeployTarget().target,
  getBuildConfigEnvironment,
  portEnvironmentVariable: 'VERTICAL_AVAILABILITY_PORT',
});
const moduleFederationDevServerAllowedOrigins = Object.values(developmentOverlay.ports).map(
  (port) => `http://localhost:${port}`,
);
const modernConfig = createModernConfig({
  apiOnly: true,
  appId,
  bffPrefix,
  build,
  builderPlugins: [],
  chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_AVAILABILITY_LOADED_CHUNKS__',
  cloudflareWorkerName,
  moduleUrl: import.meta.url,
  plugins: [ultramodernAppTools(), bffPlugin()],
  uniqueName: 'verticalAvailability',
});

export default defineConfig(
  presetUltramodern(
    {
      ...modernConfig,
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: bffPrefix,
        runtimeFramework: 'effect',
      },
      dev: {
        ...modernConfig.dev,
        server: {
          cors: { origin: moduleFederationDevServerAllowedOrigins },
          headers: {
            'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Requested-With',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          },
        },
      },
      output: { ...modernConfig.output, disableTsChecker: false },
    } satisfies AppToolsUserConfig,
    {
      appId,
      deliveryUnit: {
        buildMarker: '7b0e5ab486adc9c0',
        unitId: 'app/availability',
        version: '0.1.0',
      },
    },
  ),
);
