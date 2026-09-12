import { createRequire } from 'node:module';

import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { decodeUnknownSync, String as StringSchema, Struct } from 'effect/Schema';

import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const PackageVersionSchema = Struct({ version: StringSchema });
const packageVersion = (specifier: string): string =>
  decodeUnknownSync(PackageVersionSchema)(require(specifier)).version;
const bffVersion = packageVersion('@modern-js/plugin-bff/package.json');
const effectVersion = packageVersion('effect/package.json');

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] = createModuleFederationConfig({
  dts: false,
  exposes: {
    './effect-api': './api/effect-api.ts',
  },
  filename: 'backendRemoteEntry.cjs',
  library: {
    type: 'commonjs-module',
  },
  name: 'verticalCommerceCustomerContextBackend',
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
});

export default moduleFederationConfig;
