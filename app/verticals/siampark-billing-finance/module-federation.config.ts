import pluginI18nMetadata from '@modern-js/plugin-i18n/package.json';
import pluginTanstackMetadata from '@modern-js/plugin-tanstack/package.json';
import runtimeMetadata from '@modern-js/runtime/package.json';
import reactMetadata from 'react/package.json';
import reactDomMetadata from 'react-dom/package.json';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';

import { dependencies } from './package.json';

const pluginI18nVersion = pluginI18nMetadata.version;
const pluginTanstackVersion = pluginTanstackMetadata.version;
const runtimeVersion = runtimeMetadata.version;
const reactVersion = reactMetadata.version;
const reactDomVersion = reactDomMetadata.version;

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
    './PageRecords': './src/routes/[lang]/siampark/finance/page.tsx',
    './Route': './src/federation-entry.tsx',
  },
  filename: 'remoteEntry.js',
  name: 'verticalSiamparkBillingFinance',
  shared: {
    '@modern-js/plugin-i18n/runtime/no-react-i18next': {
      requiredVersion: pluginI18nVersion,
      singleton: true,
      treeShaking: false,
    },
    '@modern-js/plugin-i18n/runtime/no-react-i18next/consumer': {
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
    'react/jsx-dev-runtime': {
      requiredVersion: reactVersion,
      singleton: true,
      treeShaking: false,
    },
    'react/jsx-runtime': {
      requiredVersion: reactVersion,
      singleton: true,
      treeShaking: false,
    },
  },
});

export default moduleFederationConfig;
