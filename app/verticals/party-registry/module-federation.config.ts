import { createRequire } from 'node:module';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import * as Schema from 'effect/Schema';

import { createSharedRuntimeConfig } from '../../module-federation.shared.ts';
import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const PackageVersionSchema = Schema.Struct({ version: Schema.String });
const packageVersion = (specifier: string): string =>
  Schema.decodeUnknownSync(PackageVersionSchema)(require(specifier)).version;
const i18nVersion = packageVersion('@modern-js/plugin-i18n/package.json');
const runtimeVersion = packageVersion('@modern-js/runtime/package.json');
const reactVersion = packageVersion('react/package.json');
const reactDomVersion = packageVersion('react-dom/package.json');

const tsgoCompilerInstance = resolveEffectTsgoCompiler({
  from: import.meta.url,
});
const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] = createModuleFederationConfig({
  bridge: {
    enableBridgeRouter: false,
  },
  dts: {
    displayErrorInTerminal: true,
    generateTypes: { compilerInstance: tsgoCompilerInstance },
    tsConfigPath: './tsconfig.mf-types.json',
  },
  exposes: {
    './PageContacts': './src/federation/page-contacts.tsx',
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
  name: 'verticalPartyRegistry',
  shared: createSharedRuntimeConfig({
    '@modern-js/plugin-i18n/runtime': i18nVersion,
    '@modern-js/runtime': runtimeVersion,
    '@tanstack/react-router': dependencies['@tanstack/react-router'],
    react: reactVersion,
    'react-dom': reactDomVersion,
  }),
});

export default moduleFederationConfig;
