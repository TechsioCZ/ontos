import { createModuleFederationConfig } from '@module-federation/modern-js-v3';

// @ultramodern-mf no-exposes: Party Registry publishes governed APIs, not browser entrypoints.
const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] =
  createModuleFederationConfig({
    dts: false,
    exposes: {},
    filename: 'remoteEntry.js',
    name: 'verticalPartyRegistry',
  });

export default moduleFederationConfig;
