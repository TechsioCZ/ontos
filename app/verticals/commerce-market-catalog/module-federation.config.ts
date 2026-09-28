import { createRequire } from 'node:module';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import {
  decodeUnknownSync as decodePackageVersion,
  String as PackageVersionString,
  Struct as PackageVersionStruct,
} from 'effect/Schema';

import { createSharedRuntimeConfig } from '../../module-federation.shared.ts';
import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const PackageVersionSchema = PackageVersionStruct({ version: PackageVersionString });
const packageVersion = (specifier: string): string =>
  decodePackageVersion(PackageVersionSchema)(require(specifier)).version;
const pluginI18nVersion = packageVersion('@modern-js/plugin-i18n/package.json');
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
    './Route': './src/federation-entry.tsx',
  },
  filename: 'remoteEntry.js',
  name: 'verticalCommerceMarketCatalog',
  shared: createSharedRuntimeConfig({
    '@modern-js/plugin-i18n/runtime': pluginI18nVersion,
    '@modern-js/runtime': runtimeVersion,
    '@tanstack/react-router': dependencies['@tanstack/react-router'],
    react: reactVersion,
    'react-dom': reactDomVersion,
  }),
});

export default moduleFederationConfig;
