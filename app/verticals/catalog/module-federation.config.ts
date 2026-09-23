import { createRequire } from 'node:module';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { decodeUnknownSync, String as SchemaString, Struct } from 'effect/Schema';

import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const PackageVersionSchema = Struct({ version: SchemaString });
const packageVersion = (specifier: string): string =>
  decodeUnknownSync(PackageVersionSchema)(require(specifier)).version;
const pluginI18nVersion = packageVersion('@modern-js/plugin-i18n/package.json');
const pluginTanstackVersion = packageVersion('@modern-js/plugin-tanstack/package.json');
const runtimeVersion = packageVersion('@modern-js/runtime/package.json');
const reactVersion = packageVersion('react/package.json');
const reactDomVersion = packageVersion('react-dom/package.json');

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
    './CatalogWidget': './src/components/catalog-widget.tsx',
    './Route': './src/federation-entry.tsx',
    './Widget': './src/components/catalog-widget.tsx',
  },
  filename: 'remoteEntry.js',
  name: 'verticalCatalog',
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
  },
});

export default moduleFederationConfig;
