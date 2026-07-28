declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const ultramodernGeneratedBuildArtifact = {
  deliveryUnit: {
    appId: 'shell-super-app',
    build: '090dd0a19fdd0853',
    buildMarker: '090dd0a19fdd0853',
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
      build: '090dd0a19fdd0853',
      buildMarker: '090dd0a19fdd0853',
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
      build: '090dd0a19fdd0853',
      buildMarker: '090dd0a19fdd0853',
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
const ultramodernBuildMarker =
  typeof ULTRAMODERN_BUILD_MARKER === 'string'
    ? ULTRAMODERN_BUILD_MARKER
    : ultramodernGeneratedBuildArtifact.deliveryUnit.buildMarker;
const ultramodernSourceRevision =
  typeof ULTRAMODERN_SOURCE_REVISION === 'string'
    ? ULTRAMODERN_SOURCE_REVISION
    : ultramodernGeneratedBuildArtifact.deliveryUnit.sourceRevision;
const ultramodernBuildArtifact = {
  ...ultramodernGeneratedBuildArtifact,
  deliveryUnit: {
    ...ultramodernGeneratedBuildArtifact.deliveryUnit,
    build: ultramodernBuildMarker,
    buildMarker: ultramodernBuildMarker,
    sourceRevision: ultramodernSourceRevision,
  },
  surfaces: {
    api: {
      ...ultramodernGeneratedBuildArtifact.surfaces.api,
      build: ultramodernBuildMarker,
      buildMarker: ultramodernBuildMarker,
      sourceRevision: ultramodernSourceRevision,
    },
    ui: {
      ...ultramodernGeneratedBuildArtifact.surfaces.ui,
      build: ultramodernBuildMarker,
      buildMarker: ultramodernBuildMarker,
      sourceRevision: ultramodernSourceRevision,
    },
  },
} as const;

export { ultramodernBuildArtifact };

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
export const ultramodernVerticalIdentity = ultramodernDeliveryUnit;
export const ultramodernUiMarker = ultramodernBuildArtifact.surfaces.ui;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
