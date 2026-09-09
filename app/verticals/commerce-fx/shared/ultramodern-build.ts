declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const ultramodernGeneratedBuildArtifact = {
  deliveryUnit: {
    appId: 'commerce-fx',
    build: '23f9d2de8eede332',
    buildMarker: '23f9d2de8eede332',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/commerce-fx',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/commerce-fx',
    version: '0.1.0',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 1,
  surfaces: {
    api: {
      appId: 'commerce-fx',
      build: '23f9d2de8eede332',
      buildMarker: '23f9d2de8eede332',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/commerce-fx',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      surface: 'api',
      unitId: 'app/commerce-fx',
      version: '0.1.0',
    },
    ui: {
      appId: 'commerce-fx',
      build: '23f9d2de8eede332',
      buildMarker: '23f9d2de8eede332',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/commerce-fx',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      surface: 'ui',
      unitId: 'app/commerce-fx',
      version: '0.1.0',
    },
  },
} as const;
const readInjectedBuildMarker = (): string => {
  try {
    return ULTRAMODERN_BUILD_MARKER;
  } catch {
    return ultramodernGeneratedBuildArtifact.deliveryUnit.buildMarker;
  }
};

const readInjectedSourceRevision = (): string => {
  try {
    return ULTRAMODERN_SOURCE_REVISION;
  } catch {
    return ultramodernGeneratedBuildArtifact.deliveryUnit.sourceRevision;
  }
};

const ultramodernBuildMarker = readInjectedBuildMarker();
const ultramodernSourceRevision = readInjectedSourceRevision();
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

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
export const ultramodernUiMarker = ultramodernBuildArtifact.surfaces.ui;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
