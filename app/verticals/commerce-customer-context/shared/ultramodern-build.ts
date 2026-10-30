import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'commerce-customer-context',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/commerce-customer-context',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/commerce-customer-context',
    version: '0.1.0',
    buildMarker: '19fda008a3f0e23b',
    build: '19fda008a3f0e23b',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'commerce-customer-context',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/commerce-customer-context',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/commerce-customer-context',
      version: '0.1.0',
      buildMarker: '19fda008a3f0e23b',
      build: '19fda008a3f0e23b',
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
