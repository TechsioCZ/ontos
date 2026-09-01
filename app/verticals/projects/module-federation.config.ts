import { createModuleFederationConfig } from '@module-federation/modern-js-v3';

const config: ReturnType<typeof createModuleFederationConfig> = createModuleFederationConfig({
  exposes: {},
  filename: 'remoteEntry.js',
  name: 'verticalProjects',
});

export default config;
