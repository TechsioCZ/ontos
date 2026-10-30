import { createRequire } from 'node:module';

import { decodeUnknownSync, String as StringSchema, Struct } from 'effect/Schema';

const require = createRequire(import.meta.url);
const PackageVersionSchema = Struct({ version: StringSchema });
const packageVersion = (specifier: string): string =>
  decodeUnknownSync(PackageVersionSchema)(require(specifier)).version;
const bffVersion = packageVersion('@modern-js/plugin-bff/package.json');
const effectVersion = packageVersion('effect/package.json');
const federationRuntimeVersion = packageVersion('@module-federation/runtime/package.json');

const moduleFederationConfig = {
  dts: false,
  exposes: {
    './effect-api': './api/effect-api.ts',
  },
  filename: 'backendRemoteEntry.cjs',
  library: {
    type: 'commonjs-module',
  },
  name: 'verticalCommerceCartBackend',
  shared: {
    '@modern-js/plugin-bff': {
      requiredVersion: bffVersion,
      singleton: true,
      treeShaking: false,
    },
    '@module-federation/runtime': {
      requiredVersion: federationRuntimeVersion,
      singleton: true,
      treeShaking: false,
    },
    effect: {
      requiredVersion: effectVersion,
      singleton: true,
      treeShaking: false,
    },
  },
};

export default moduleFederationConfig;
