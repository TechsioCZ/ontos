// ultramodern-mf: host-only
import { createRequire } from 'node:module';

import { getBuildConfigEnvironment } from '@modern-js/app-tools/config';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import * as Schema from 'effect/Schema';

import { dependencies } from './package.json';

const cloudflareDeployEnabled = getBuildConfigEnvironment('MODERNJS_DEPLOY') === 'cloudflare';
const cloudflareWorkersDevSubdomain = getBuildConfigEnvironment(
  'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN',
)?.trim();
const requireCloudflarePublicUrls =
  getBuildConfigEnvironment('ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS') === 'true';

const createRemoteManifestUrl = (options: {
  manifestEnv: string;
  mfName: string;
  port: number;
  publicUrlEnv: string;
  workerName: string;
}) => {
  const configuredManifest = getBuildConfigEnvironment(options.manifestEnv)?.trim();
  if (configuredManifest !== undefined && configuredManifest.length > 0) {
    return configuredManifest;
  }

  const configuredPublicUrl = getBuildConfigEnvironment(options.publicUrlEnv)?.trim();
  if (configuredPublicUrl !== undefined && configuredPublicUrl.length > 0) {
    return `${options.mfName}@${configuredPublicUrl.replace(/\/+$/u, '')}/mf-manifest.json`;
  }

  if (
    cloudflareDeployEnabled &&
    cloudflareWorkersDevSubdomain !== undefined &&
    cloudflareWorkersDevSubdomain.length > 0
  ) {
    return `${options.mfName}@https://${options.workerName}.${cloudflareWorkersDevSubdomain}.workers.dev/mf-manifest.json`;
  }

  if (cloudflareDeployEnabled && requireCloudflarePublicUrls) {
    throw new Error(
      `Cloudflare deploy needs ${options.publicUrlEnv}, ${options.manifestEnv}, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN for remote ${options.mfName}.`,
    );
  }

  return `${options.mfName}@http://localhost:${options.port}/mf-manifest.json`;
};

const require = createRequire(import.meta.url);
const PackageVersionSchema = Schema.Struct({ version: Schema.String });
const packageVersion = (packageName: string): string =>
  Schema.decodeUnknownSync(PackageVersionSchema)(require(`${packageName}/package.json`)).version;
const i18nVersion = packageVersion('@modern-js/plugin-i18n');
const runtimeVersion = packageVersion('@modern-js/runtime');
const reactVersion = packageVersion('react');
const reactDomVersion = packageVersion('react-dom');

const moduleFederationConfig: Parameters<typeof createModuleFederationConfig>[0] =
  createModuleFederationConfig({
    dts: {
      consumeTypes: true,
      generateTypes: false,
      tsConfigPath: './tsconfig.mf-types.json',
    },
    filename: 'remoteEntry.js',
    name: 'shellSuperApp',
    remotes: {
      contacts: createRemoteManifestUrl({
        manifestEnv: 'VERTICAL_CONTACTS_MF_MANIFEST',
        mfName: 'verticalContacts',
        port: 4101,
        publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_CONTACTS',
        workerName: 'app-contacts',
      }),
    },
    shared: {
      '@modern-js/plugin-i18n/runtime': {
        import: '@modern-js/plugin-i18n/runtime/no-react-i18next',
        requiredVersion: i18nVersion,
        singleton: true,
        strictVersion: true,
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
