import pluginI18nVersionMetadata from '@modern-js/plugin-i18n/package.json' with { type: 'json' };
import pluginTanstackVersionMetadata from '@modern-js/plugin-tanstack/package.json' with { type: 'json' };
import runtimeVersionMetadata from '@modern-js/runtime/package.json' with { type: 'json' };
import reactVersionMetadata from 'react/package.json' with { type: 'json' };
import reactDomVersionMetadata from 'react-dom/package.json' with { type: 'json' };

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';

import { dependencies } from './package.json';

const pluginI18nVersion = pluginI18nVersionMetadata.version;
const pluginTanstackVersion = pluginTanstackVersionMetadata.version;
const runtimeVersion = runtimeVersionMetadata.version;
const reactVersion = reactVersionMetadata.version;
const reactDomVersion = reactDomVersionMetadata.version;

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
    './PageIntegrations': './src/routes/[lang]/siampark/integrations/page.tsx',
    './PageOverview': './src/routes/[lang]/siampark/overview/page.tsx',
    './PageRecords': './src/routes/[lang]/siampark/properties/page.tsx',
    './Route': './src/federation-entry.tsx',
  },
  filename: 'remoteEntry.js',
  name: 'verticalSiamparkProperty',
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
