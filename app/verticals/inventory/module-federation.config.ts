import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';

import { dependencies } from './package.json';

const tsgoCompilerInstance = resolveEffectTsgoCompiler({ from: import.meta.url });

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] = createModuleFederationConfig({
  bridge: {
    enableBridgeRouter: false,
  },
  dts: {
    displayErrorInTerminal: true,
    generateTypes: {
      compilerInstance: tsgoCompilerInstance,
    },
    tsConfigPath: './tsconfig.mf-types.json',
  },
  exposes: {
    './InventoryWidget': './src/components/inventory-widget.tsx',
    './Route': './src/federation-entry.tsx',
    './Widget': './src/components/inventory-widget.tsx',
  },
  filename: 'remoteEntry.js',
  name: 'verticalInventory',
  shared: {
    '@modern-js/plugin-i18n/runtime/no-react-i18next': {
      requiredVersion: dependencies['@modern-js/plugin-i18n'],
      singleton: true,
      treeShaking: false,
    },
    '@modern-js/plugin-i18n/runtime/no-react-i18next/consumer': {
      requiredVersion: dependencies['@modern-js/plugin-i18n'],
      singleton: true,
      treeShaking: false,
    },
    '@modern-js/plugin-tanstack/runtime': {
      requiredVersion: dependencies['@modern-js/plugin-tanstack'],
      singleton: true,
      treeShaking: false,
    },
    '@modern-js/runtime': {
      requiredVersion: dependencies['@modern-js/runtime'],
      singleton: true,
      treeShaking: false,
    },
    '@tanstack/react-router': {
      requiredVersion: dependencies['@tanstack/react-router'],
      singleton: true,
      treeShaking: false,
    },
    react: {
      requiredVersion: dependencies.react,
      singleton: true,
      treeShaking: false,
    },
    'react-dom': {
      requiredVersion: dependencies['react-dom'],
      singleton: true,
      treeShaking: false,
    },
    'react-dom/client': {
      requiredVersion: dependencies['react-dom'],
      singleton: true,
      treeShaking: false,
    },
  },
});

export default moduleFederationConfig;
