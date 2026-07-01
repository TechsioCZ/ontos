import { createUltramodernModuleFederationConfig } from '@mvp/ultramodern-config';

export default createUltramodernModuleFederationConfig({
  baseUrl: import.meta.url,
  exposes: {
    './PropertyUnitCard': './src/components/property-unit-card.tsx',
    './Route': './src/federation-entry.tsx',
    './Widget': './src/components/property-registry-widget.tsx',
  },
  name: 'verticalPropertyRegistry',
});
