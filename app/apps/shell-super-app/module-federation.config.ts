// ultramodern-mf: host-only
import { createRequire } from 'node:module';

import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { getOrUndefined as getOptionOrUndefined } from 'effect/Option';
import { isSuccess as isResultSuccess } from 'effect/Result';
import {
  OptionFromUndefinedOr,
  String as StringSchema,
  Struct,
  Trim,
  check,
  decodeUnknownResult,
  decodeUnknownSync,
  isMinLength,
} from 'effect/Schema';

import { createSharedRuntimeConfig } from '../../module-federation.shared.ts';
import { dependencies } from './package.json';

const nonEmptyBuildStringSchema = Trim.pipe(check(isMinLength(1)));
const getOptionalBuildConfig = (name: string): string | undefined => {
  const decoded = decodeUnknownResult(OptionFromUndefinedOr(nonEmptyBuildStringSchema))(
    getBuildConfigEnvironment(name),
  );
  return isResultSuccess(decoded) ? getOptionOrUndefined(decoded.success) : undefined;
};
const cloudflareDeployEnabled = resolveDeployTarget().target === 'cloudflare';
const cloudflareWorkersDevSubdomain = getOptionalBuildConfig('ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN');
const createRemoteManifestUrl = (options: {
  manifestEnv: string;
  mfName: string;
  port: number;
  publicUrlEnv: string;
  workerName: string;
}) => {
  const configuredManifest = getOptionalBuildConfig(options.manifestEnv);
  if (configuredManifest !== undefined) {
    return configuredManifest;
  }

  const configuredPublicUrl = getOptionalBuildConfig(options.publicUrlEnv);
  if (configuredPublicUrl !== undefined) {
    return `${options.mfName}@${configuredPublicUrl.replace(/\/+$/u, '')}/mf-manifest.json`;
  }

  if (cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined) {
    return `${options.mfName}@https://${options.workerName}.${cloudflareWorkersDevSubdomain}.workers.dev/mf-manifest.json`;
  }

  return `${options.mfName}@http://localhost:${options.port}/mf-manifest.json`;
};

const require = createRequire(import.meta.url);
const PackageVersionSchema = Struct({ version: StringSchema });
const packageVersion = (packageName: string): string =>
  decodeUnknownSync(PackageVersionSchema)(require(`${packageName}/package.json`)).version;
const i18nVersion = packageVersion('@modern-js/plugin-i18n');
const runtimeVersion = packageVersion('@modern-js/runtime');
const reactVersion = packageVersion('react');
const effectVersion = packageVersion('effect');
const reactDomVersion = packageVersion('react-dom');

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] = createModuleFederationConfig({
  bridge: {
    enableBridgeRouter: false,
  },
  dts: {
    consumeTypes: true,
    generateTypes: false,
    tsConfigPath: './tsconfig.mf-types.json',
  },
  filename: 'remoteEntry.js',
  name: 'shellSuperApp',
  remotes: {
    partyRegistry: createRemoteManifestUrl({
      manifestEnv: 'VERTICAL_PARTY_REGISTRY_MF_MANIFEST',
      mfName: 'verticalPartyRegistry',
      port: 4102,
      publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY',
      workerName: 'app-party-registry',
    }),
  },
  shared: createSharedRuntimeConfig({
    '@modern-js/plugin-i18n/runtime': i18nVersion,
    '@modern-js/runtime': runtimeVersion,
    '@tanstack/react-router': dependencies['@tanstack/react-router'],
    effect: effectVersion,
    react: reactVersion,
    'react-dom': reactDomVersion,
  }),
});

export default moduleFederationConfig;
