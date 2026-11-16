import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'commerce-cart',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/commerce-cart',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/commerce-cart',
    version: '0.1.0',
    buildMarker: 'e6215fce3998f57e',
    build: 'e6215fce3998f57e',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'commerce-cart',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/commerce-cart',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/commerce-cart',
      version: '0.1.0',
      buildMarker: 'e6215fce3998f57e',
      build: 'e6215fce3998f57e',
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
