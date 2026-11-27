// ultramodern-mf: host-only
import { createRequire } from 'node:module';

import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { String as StringSchema, Struct, decodeUnknownSync } from 'effect/Schema';

import { createSharedRuntimeConfig, resolveUiKitShare } from '../../module-federation.shared.ts';
import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const PackageVersionSchema = Struct({ version: StringSchema });
const packageVersion = (packageName: string): string =>
  decodeUnknownSync(PackageVersionSchema)(require(`${packageName}/package.json`)).version;
const i18nVersion = packageVersion('@modern-js/plugin-i18n');
const runtimeVersion = packageVersion('@modern-js/runtime');
const reactVersion = packageVersion('react');
const reactDomVersion = packageVersion('react-dom');

const uiKit = resolveUiKitShare(import.meta.url);

// A host with no static remotes otherwise consumes these contexts only as private fallbacks.
// Publish the exact modules that own the Shell's resolver and translation providers for dynamic remotes.
const hostContext = (request: string, version: string) => ({
  import: require.resolve(request),
  requiredVersion: version,
  singleton: true,
  strictVersion: true,
  treeShaking: false,
  version,
});

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] = createModuleFederationConfig({
  bridge: {
    enableBridgeRouter: false,
  },
  dts: {
    consumeTypes: false,
    generateTypes: false,
    tsConfigPath: './tsconfig.mf-types.json',
  },
  filename: 'remoteEntry.js',
  name: 'shellSuperApp',
  remotes: {},
  shared: {
    ...createSharedRuntimeConfig(
      {
        '@modern-js/plugin-i18n/runtime': i18nVersion,
        '@modern-js/runtime': runtimeVersion,
        '@tanstack/react-router': dependencies['@tanstack/react-router'],
        react: reactVersion,
        'react-dom': reactDomVersion,
      },
      { role: 'host', uiKit },
    ),
    '@modern-js/plugin-i18n/runtime/contexts': hostContext('@modern-js/plugin-i18n/runtime/contexts', i18nVersion),
    '@modern-js/runtime/context': hostContext('@modern-js/runtime/context', runtimeVersion),
  },
});

export default moduleFederationConfig;
