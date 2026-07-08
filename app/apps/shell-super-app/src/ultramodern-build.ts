const shellDeliveryUnit = {
  schemaVersion: 1,
  kind: 'shell-delivery-unit',
  unitId: 'app/shell-super-app',
  appId: 'shell-super-app',
  packageName: '@app/shell-super-app',
  version: '0.1.0',
  sourceRevision: 'workspace',
  buildMarker: 'workspace',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  build: 'workspace',
} as const;

export const ultramodernBuildArtifact = {
  schemaVersion: 1,
  kind: 'ultramodern-build-artifact',
  deliveryUnit: shellDeliveryUnit,
  surfaces: {
    ui: {
      ...shellDeliveryUnit,
      surface: 'ui',
    },
  },
} as const;

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
export const ultramodernUiMarker = ultramodernBuildArtifact.surfaces.ui;
