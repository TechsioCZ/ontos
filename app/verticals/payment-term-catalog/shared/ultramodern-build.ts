import { withUltramodernBuildIdentity } from '@app/shared-contracts/ultramodern-build';

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const generatedAppId = 'payment-term-catalog';
const generatedDeployProfile = 'cloudflare-ssr-mf-effect-v1';
const generatedDeliveryUnitKind = 'microvertical-delivery-unit';
const generatedPackageName = '@app/payment-term-catalog';
const generatedUnitId = 'app/payment-term-catalog';

const ultramodernGeneratedBuildArtifact = {
  deliveryUnit: {
    appId: generatedAppId,
    build: '3812f892cf5544cf',
    buildMarker: '3812f892cf5544cf',
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
      build: '3812f892cf5544cf',
      buildMarker: '3812f892cf5544cf',
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
      build: '3812f892cf5544cf',
      buildMarker: '3812f892cf5544cf',
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
const readInjectedBuildValue = (readInjectedValue: () => string, fallback: string): string => {
  try {
    return readInjectedValue();
  } catch {
    return fallback;
  }
};

const ultramodernBuildMarker = readInjectedBuildValue(
  () => ULTRAMODERN_BUILD_MARKER,
  ultramodernGeneratedBuildArtifact.deliveryUnit.buildMarker,
);
const ultramodernSourceRevision = readInjectedBuildValue(
  () => ULTRAMODERN_SOURCE_REVISION,
  ultramodernGeneratedBuildArtifact.deliveryUnit.sourceRevision,
);
const ultramodernBuildArtifact = withUltramodernBuildIdentity(
  ultramodernGeneratedBuildArtifact,
  ultramodernBuildMarker,
  ultramodernSourceRevision,
);

export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
