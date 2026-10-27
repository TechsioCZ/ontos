import { resolveUltramodernBuildArtifact } from '@modern-js/runtime-extensions/build-identity';

const PARTY_REGISTRY_APP_ID = 'party-registry' as const;
const DEPLOY_PROFILE = 'cloudflare-ssr-mf-effect-v1' as const;
const DELIVERY_UNIT_KIND = 'microvertical-delivery-unit' as const;
const PARTY_REGISTRY_PACKAGE_NAME = '@app/party-registry' as const;
const PARTY_REGISTRY_UNIT_ID = 'app/party-registry' as const;

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const ultramodernBuildArtifact = resolveUltramodernBuildArtifact(
  {
    deliveryUnit: {
      appId: PARTY_REGISTRY_APP_ID,
      build: '3f023644c8a07e9a',
      buildMarker: '3f023644c8a07e9a',
      deployProfile: DEPLOY_PROFILE,
      kind: DELIVERY_UNIT_KIND,
      packageName: PARTY_REGISTRY_PACKAGE_NAME,
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: PARTY_REGISTRY_UNIT_ID,
      version: '0.1.0',
    },
    kind: 'ultramodern-build-artifact',
    schemaVersion: 1,
    surfaces: {
      api: {
        appId: PARTY_REGISTRY_APP_ID,
        build: '3f023644c8a07e9a',
        buildMarker: '3f023644c8a07e9a',
        deployProfile: DEPLOY_PROFILE,
        kind: DELIVERY_UNIT_KIND,
        packageName: PARTY_REGISTRY_PACKAGE_NAME,
        schemaVersion: 1,
        sourceRevision: 'workspace',
        surface: 'api',
        unitId: PARTY_REGISTRY_UNIT_ID,
        version: '0.1.0',
      },
      ui: {
        appId: PARTY_REGISTRY_APP_ID,
        build: '3f023644c8a07e9a',
        buildMarker: '3f023644c8a07e9a',
        deployProfile: DEPLOY_PROFILE,
        kind: DELIVERY_UNIT_KIND,
        packageName: PARTY_REGISTRY_PACKAGE_NAME,
        schemaVersion: 1,
        sourceRevision: 'workspace',
        surface: 'ui',
        unitId: PARTY_REGISTRY_UNIT_ID,
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
