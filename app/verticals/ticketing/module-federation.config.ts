// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from 'node:module';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const pluginI18nVersion = (require('@modern-js/plugin-i18n/package.json') as { version: string })
  .version;
const pluginTanstackVersion = (
  require('@modern-js/plugin-tanstack/package.json') as { version: string }
).version;
const runtimeVersion = (require('@modern-js/runtime/package.json') as { version: string }).version;
const reactVersion = (require('react/package.json') as { version: string }).version;
const reactDomVersion = (require('react-dom/package.json') as { version: string }).version;

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] =
  createModuleFederationConfig({
    bridge: {
      enableBridgeRouter: false,
    },
    dev: {
      disableDynamicRemoteTypeHints: true,
    },
    dts: {
      displayErrorInTerminal: true,
      generateTypes: {
        compilerInstance: 'tsgo',
      },
      tsConfigPath: './tsconfig.mf-types.json',
    },
    exposes: {
      './Route': './src/federation-entry.tsx',
      './Widget': './src/components/ticketing-widget.tsx',
    },
    filename: 'remoteEntry.js',
    name: 'verticalTicketing',
    shared: {
      '@modern-js/plugin-i18n/runtime/no-react-i18next': {
        requiredVersion: pluginI18nVersion,
        singleton: true,
        treeShaking: false,
      },
      '@modern-js/plugin-tanstack/runtime': {
        requiredVersion: pluginTanstackVersion,
        singleton: true,
        treeShaking: false,
      },
      '@modern-js/runtime': {
        requiredVersion: runtimeVersion,
        singleton: true,
        treeShaking: false,
      },
      '@tanstack/react-router': {
        requiredVersion: dependencies['@tanstack/react-router'],
        singleton: true,
        treeShaking: false,
      },
      react: {
        requiredVersion: reactVersion,
        singleton: true,
        treeShaking: false,
      },
      'react-dom': {
        requiredVersion: reactDomVersion,
        singleton: true,
        treeShaking: false,
      },
      'react-dom/client': {
        requiredVersion: reactDomVersion,
        singleton: true,
        treeShaking: false,
      },
    },
    treeShakingSharedExcludePlugins: ['RspackModuleFederationPlugin'],
  });

export default moduleFederationConfig;
