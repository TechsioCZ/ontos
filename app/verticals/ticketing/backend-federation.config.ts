// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from 'node:module';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const bffVersion = (require('@modern-js/plugin-bff/package.json') as { version: string }).version;
const effectVersion = (require('effect/package.json') as { version: string }).version;

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] =
  createModuleFederationConfig({
    dts: false,
    exposes: {
      './effect-api': './api/effect-api.ts',
    },
    filename: 'backendRemoteEntry.mjs',
    name: 'verticalTicketingBackend',
    shared: {
      '@modern-js/plugin-bff': {
        requiredVersion: bffVersion,
        singleton: true,
        treeShaking: false,
      },
      '@module-federation/runtime': {
        requiredVersion: dependencies['@module-federation/runtime'],
        singleton: true,
        treeShaking: false,
      },
      effect: {
        requiredVersion: effectVersion,
        singleton: true,
        treeShaking: false,
      },
    },
    treeShakingSharedExcludePlugins: ['RspackModuleFederationPlugin'],
  });

export default moduleFederationConfig;
