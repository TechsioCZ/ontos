import { resolveUltramodernBuildArtifact } from '@modern-js/runtime-extensions/build-identity';

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const ultramodernBuildArtifact = resolveUltramodernBuildArtifact(
  {
    deliveryUnit: {
      appId: 'party-registry',
      build: '3f023644c8a07e9a',
      buildMarker: '3f023644c8a07e9a',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/party-registry',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/party-registry',
      version: '0.1.0',
    },
    kind: 'ultramodern-build-artifact',
    schemaVersion: 1,
    surfaces: {
      api: {
        appId: 'party-registry',
        build: '3f023644c8a07e9a',
        buildMarker: '3f023644c8a07e9a',
        deployProfile: 'cloudflare-ssr-mf-effect-v1',
        kind: 'microvertical-delivery-unit',
        packageName: '@app/party-registry',
        schemaVersion: 1,
        sourceRevision: 'workspace',
        surface: 'api',
        unitId: 'app/party-registry',
        version: '0.1.0',
      },
      ui: {
        appId: 'party-registry',
        build: '3f023644c8a07e9a',
        buildMarker: '3f023644c8a07e9a',
        deployProfile: 'cloudflare-ssr-mf-effect-v1',
        kind: 'microvertical-delivery-unit',
        packageName: '@app/party-registry',
        schemaVersion: 1,
        sourceRevision: 'workspace',
        surface: 'ui',
        unitId: 'app/party-registry',
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
export const ultramodernUiMarker = ultramodernBuildArtifact.surfaces.ui;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
