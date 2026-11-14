import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'price-group-catalog',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/price-group-catalog',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/price-group-catalog',
    version: '0.1.0',
    buildMarker: '1844d569e65d1318',
    build: '1844d569e65d1318',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'price-group-catalog',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/price-group-catalog',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/price-group-catalog',
      version: '0.1.0',
      buildMarker: '1844d569e65d1318',
      build: '1844d569e65d1318',
      surface: 'api',
    },
  },
} as const;

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const ultramodernBuildArtifact = resolveUltramodernBuildArtifact(buildArtifact, {
  buildMarker: () => ULTRAMODERN_BUILD_MARKER,
  sourceRevision: () => ULTRAMODERN_SOURCE_REVISION,
});

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
