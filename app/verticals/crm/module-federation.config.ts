import { createRequire } from 'node:module';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { Schema } from 'effect';

import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const PackageVersionSchema = Schema.Struct({ version: Schema.String });
const packageVersion = (specifier: string): string =>
  Schema.decodeUnknownSync(PackageVersionSchema)(require(specifier)).version;
const pluginI18nVersion = packageVersion('@modern-js/plugin-i18n/package.json');
const pluginTanstackVersion = packageVersion('@modern-js/plugin-tanstack/package.json');
const runtimeVersion = packageVersion('@modern-js/runtime/package.json');
const reactVersion = packageVersion('react/package.json');
const reactDomVersion = packageVersion('react-dom/package.json');

const tsgoCompilerInstance = resolveEffectTsgoCompiler({
  from: import.meta.url,
});
const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] =
  createModuleFederationConfig({
    dts: {
      displayErrorInTerminal: true,
      generateTypes: {
        compilerInstance: tsgoCompilerInstance,
      },
      tsConfigPath: './tsconfig.mf-types.json',
    },
    exposes: {
      './PageContactCreate': './src/federation/page-contact-create.tsx',
      './PageContactDetail': './src/federation/page-contact-detail.tsx',
      './PageContactEdit': './src/federation/page-contact-edit.tsx',
      './PageCrm': './src/federation-entry.tsx',
      './PageCustomerCreate': './src/federation/page-customer-create.tsx',
      './PageCustomerDetail': './src/federation/page-customer-detail.tsx',
      './PageCustomerEdit': './src/federation/page-customer-edit.tsx',
      './PageCustomersList': './src/federation/page-customers-list.tsx',
    },
    filename: 'remoteEntry.js',
    manifest: {
      additionalData: ({ stats }) => ({
        ...stats,
        exposes: stats.exposes.map((expose) => ({
          ...expose,
          assets: {
            ...expose.assets,
            css: {
              ...expose.assets.css,
              async: expose.assets.css.async.filter((asset) => !asset.includes('/async-index.')),
            },
          },
        })),
      }),
    },
    name: 'verticalCrm',
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
  });

export default moduleFederationConfig;
