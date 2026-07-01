// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { createRequire } from 'node:module';
import { createModuleFederationConfig } from '@module-federation/modern-js-v3';
import { dependencies } from './package.json';

const require = createRequire(import.meta.url);
const pluginI18nVersion = (require('@modern-js/plugin-i18n/package.json') as { version: string })
  .version;
const pluginTanstackVersion = (
  require('@modern-js/plugin-tanstack/package.json') as { version: string }
).version;
const runtimeVersion = (require('@modern-js/runtime/package.json') as { version: string }).version;
const reactVersion = (require('react/package.json') as { version: string }).version;
const reactDomVersion = (require('react-dom/package.json') as { version: string }).version;

const cloudflareDeployEnabled = process.env['MODERNJS_DEPLOY'] === 'cloudflare';
const cloudflareWorkersDevSubdomain =
  process.env['ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN']?.trim();
const requireCloudflarePublicUrls =
  process.env['ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS'] === 'true';

const createRemoteManifestUrl = (options: {
  manifestEnv: string;
  mfName: string;
  port: number;
  publicUrlEnv: string;
  workerName: string;
}) => {
  const configuredManifest = process.env[options.manifestEnv]?.trim();
  if (configuredManifest !== undefined && configuredManifest.length > 0) {
    return configuredManifest;
  }

  const configuredPublicUrl = process.env[options.publicUrlEnv]?.trim();
  if (configuredPublicUrl !== undefined && configuredPublicUrl.length > 0) {
    return `${options.mfName}@${configuredPublicUrl.replace(/\/+$/u, '')}/mf-manifest.json`;
  }

  if (cloudflareDeployEnabled && cloudflareWorkersDevSubdomain !== undefined) {
    return `${options.mfName}@https://${options.workerName}.${cloudflareWorkersDevSubdomain}.workers.dev/mf-manifest.json`;
  }

  if (cloudflareDeployEnabled && requireCloudflarePublicUrls) {
    throw new Error(
      `Cloudflare deploy needs ${options.publicUrlEnv}, ${options.manifestEnv}, or ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN for remote ${options.mfName}.`,
    );
  }

  return `${options.mfName}@http://localhost:${options.port}/mf-manifest.json`;
};

export default createModuleFederationConfig({
  bridge: {
    enableBridgeRouter: false,
  },
  name: 'shellSuperApp',
  remotes: {
    accounting: createRemoteManifestUrl({
      manifestEnv: 'VERTICAL_ACCOUNTING_MF_MANIFEST',
      mfName: 'verticalAccounting',
      port: 4102,
      publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_ACCOUNTING',
      workerName: 'mvp2-accounting',
    }),
    properties: createRemoteManifestUrl({
      manifestEnv: 'VERTICAL_PROPERTIES_MF_MANIFEST',
      mfName: 'verticalProperties',
      port: 4101,
      publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PROPERTIES',
      workerName: 'mvp2-properties',
    }),
  },
  shared: {
    '@modern-js/plugin-i18n/runtime': {
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
  // The independent shared build must not recursively apply the Rspack MF plugin.
  treeShakingSharedExcludePlugins: ['RspackModuleFederationPlugin'],
});
