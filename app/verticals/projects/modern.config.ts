import { createRequire } from 'node:module';
import { appTools, defineConfig } from '@modern-js/app-tools';
import { getBuildConfigEnvironment } from '@modern-js/app-tools/config';
import { bffPlugin } from '@modern-js/plugin-bff';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const shellOrigin =
  getBuildConfigEnvironment('ULTRAMODERN_MF_DEV_ORIGIN')?.trim() || 'http://localhost:3020';

export default defineConfig({
  bff: {
    effect: { entry: './api/index', strictEffectApproach: true },
    prefix: '/projects-api',
    runtimeFramework: 'effect',
  },
  plugins: [appTools(), bffPlugin(), moduleFederationPlugin()],
  server: { port: 4102 },
  source: {
    globalVars: { ULTRAMODERN_SHELL_ORIGIN: shellOrigin },
  },
});
