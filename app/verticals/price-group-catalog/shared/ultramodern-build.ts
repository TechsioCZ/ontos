import { resolveUltramodernBuildArtifact } from '@modern-js/runtime-extensions/build-identity';

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const generatedAppId = 'price-group-catalog';
const generatedBuildMarker = 'af022b7822b7562c';
const generatedDeployProfile = 'cloudflare-ssr-mf-effect-v1';
const generatedDeliveryUnitKind = 'microvertical-delivery-unit';
const generatedPackageName = '@app/price-group-catalog';
const generatedUnitId = 'app/price-group-catalog';

const ultramodernBuildArtifact = resolveUltramodernBuildArtifact(
  {
    deliveryUnit: {
      appId: generatedAppId,
      build: generatedBuildMarker,
      buildMarker: generatedBuildMarker,
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
        build: generatedBuildMarker,
        buildMarker: generatedBuildMarker,
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
        build: generatedBuildMarker,
        buildMarker: generatedBuildMarker,
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
  } as const,
  {
    buildMarker: () => ULTRAMODERN_BUILD_MARKER,
    sourceRevision: () => ULTRAMODERN_SOURCE_REVISION,
  },
);

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
