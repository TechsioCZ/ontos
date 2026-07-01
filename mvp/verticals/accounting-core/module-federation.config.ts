import {
  createRemoteManifestUrl,
  createUltramodernModuleFederationConfig,
} from '@mvp/ultramodern-config';

export default createUltramodernModuleFederationConfig({
  baseUrl: import.meta.url,
  exposes: {
    './AccountingDraftEntryCard': './src/components/accounting-draft-entry-card.tsx',
    './Route': './src/federation-entry.tsx',
    './Widget': './src/components/accounting-core-widget.tsx',
  },
  name: 'verticalAccountingCore',
  remotes: {
    propertyRegistry: createRemoteManifestUrl({
      manifestEnv: 'VERTICAL_PROPERTY_REGISTRY_MF_MANIFEST',
      mfName: 'verticalPropertyRegistry',
      port: 4101,
      publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY',
    }),
  },
});
