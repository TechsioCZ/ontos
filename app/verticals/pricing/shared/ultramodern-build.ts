import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'pricing',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/pricing',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/pricing',
    version: '0.1.0',
    buildMarker: 'b5403c43a092fccb',
    build: 'b5403c43a092fccb',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'pricing',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/pricing',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/pricing',
      version: '0.1.0',
      buildMarker: 'b5403c43a092fccb',
      build: 'b5403c43a092fccb',
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
