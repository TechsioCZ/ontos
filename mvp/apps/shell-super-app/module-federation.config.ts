import {
  createRemoteManifestUrl,
  createUltramodernModuleFederationConfig,
} from '@mvp/ultramodern-config';

export default createUltramodernModuleFederationConfig({
  baseUrl: import.meta.url,
  name: 'shellSuperApp',
  remotes: {
    accountingCore: createRemoteManifestUrl({
      manifestEnv: 'VERTICAL_ACCOUNTING_CORE_MF_MANIFEST',
      mfName: 'verticalAccountingCore',
      port: 4102,
      publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_ACCOUNTING_CORE',
      workerName: 'mvp-accounting-core',
    }),
    propertyRegistry: createRemoteManifestUrl({
      manifestEnv: 'VERTICAL_PROPERTY_REGISTRY_MF_MANIFEST',
      mfName: 'verticalPropertyRegistry',
      port: 4101,
      publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY',
      workerName: 'mvp-property-registry',
    }),
  },
});
