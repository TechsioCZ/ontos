const ultramodernBuildArtifact = {
  deliveryUnit: {
    appId: 'shell-super-app',
    build: 'f2a12915381c5eab',
    buildMarker: 'f2a12915381c5eab',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/shell-super-app',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/shell-super-app',
    version: '0.1.0',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 1,
  surfaces: {
    api: {
      appId: 'shell-super-app',
      build: 'f2a12915381c5eab',
      buildMarker: 'f2a12915381c5eab',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/shell-super-app',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      surface: 'api',
      unitId: 'app/shell-super-app',
      version: '0.1.0',
    },
    ui: {
      appId: 'shell-super-app',
      build: 'f2a12915381c5eab',
      buildMarker: 'f2a12915381c5eab',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/shell-super-app',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      surface: 'ui',
      unitId: 'app/shell-super-app',
      version: '0.1.0',
    },
  },
} as const;

export { ultramodernBuildArtifact };

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
export const ultramodernVerticalIdentity = ultramodernDeliveryUnit;
export const ultramodernUiMarker = ultramodernBuildArtifact.surfaces.ui;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
