import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'storefront-registry',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/storefront-registry',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/storefront-registry',
    version: '0.1.0',
    buildMarker: '07dd35dd87823ff5',
    build: '07dd35dd87823ff5',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'storefront-registry',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/storefront-registry',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/storefront-registry',
      version: '0.1.0',
      buildMarker: '07dd35dd87823ff5',
      build: '07dd35dd87823ff5',
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
