import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'payment-term-catalog',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/payment-term-catalog',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/payment-term-catalog',
    version: '0.1.0',
    buildMarker: '1c20de722548cc76',
    build: '1c20de722548cc76',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'payment-term-catalog',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/payment-term-catalog',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/payment-term-catalog',
      version: '0.1.0',
      buildMarker: '1c20de722548cc76',
      build: '1c20de722548cc76',
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
