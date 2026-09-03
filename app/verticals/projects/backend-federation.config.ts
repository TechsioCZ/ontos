import { createModuleFederationConfig } from '@module-federation/modern-js-v3';

const config: ReturnType<typeof createModuleFederationConfig> = createModuleFederationConfig({
  dts: false,
  exposes: { './effect-api': './api/effect-api.ts' },
  filename: 'backendRemoteEntry.cjs',
  library: { type: 'commonjs-module' },
  name: 'verticalProjectsBackend',
});

export default config;
