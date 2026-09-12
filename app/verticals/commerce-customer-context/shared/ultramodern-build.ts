import { withUltramodernBuildIdentity } from '@app/shared-contracts/ultramodern-build';

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const generatedAppId = 'commerce-customer-context';
const generatedDeployProfile = 'cloudflare-ssr-mf-effect-v1';
const generatedDeliveryUnitKind = 'microvertical-delivery-unit';
const generatedPackageName = '@app/commerce-customer-context';
const generatedUnitId = 'app/commerce-customer-context';

const ultramodernGeneratedBuildArtifact = {
  deliveryUnit: {
    appId: generatedAppId,
    build: '2b4d72d8d032dd53',
    buildMarker: '2b4d72d8d032dd53',
    deployProfile: generatedDeployProfile,
    kind: generatedDeliveryUnitKind,
    packageName: generatedPackageName,
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: generatedUnitId,
    version: '0.1.0',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 1,
  surfaces: {
    api: {
      appId: generatedAppId,
      build: '2b4d72d8d032dd53',
      buildMarker: '2b4d72d8d032dd53',
      deployProfile: generatedDeployProfile,
      kind: generatedDeliveryUnitKind,
      packageName: generatedPackageName,
      schemaVersion: 1,
      sourceRevision: 'workspace',
      surface: 'api',
      unitId: generatedUnitId,
      version: '0.1.0',
    },
    ui: {
      appId: generatedAppId,
      build: '2b4d72d8d032dd53',
      buildMarker: '2b4d72d8d032dd53',
      deployProfile: generatedDeployProfile,
      kind: generatedDeliveryUnitKind,
      packageName: generatedPackageName,
      schemaVersion: 1,
      sourceRevision: 'workspace',
      surface: 'ui',
      unitId: generatedUnitId,
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
const ultramodernBuildArtifact = withUltramodernBuildIdentity(
  ultramodernGeneratedBuildArtifact,
  ultramodernBuildMarker,
  ultramodernSourceRevision,
);

export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
