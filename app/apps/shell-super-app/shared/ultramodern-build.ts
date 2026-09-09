import { resolveUltramodernBuildArtifact } from '@modern-js/runtime-extensions/build-identity';

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const ultramodernBuildArtifact = resolveUltramodernBuildArtifact(
  {
    deliveryUnit: {
      appId: 'shell-super-app',
      build: '090dd0a19fdd0853',
      buildMarker: '090dd0a19fdd0853',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/shell-super-app',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/shell-super-app',
      version: '0.1.0',
    },
    kind: 'ultramodern-build-artifact',
    schemaVersion: 1,
    surfaces: {
      api: {
        appId: 'shell-super-app',
        build: '090dd0a19fdd0853',
        buildMarker: '090dd0a19fdd0853',
        deployProfile: 'cloudflare-ssr-mf-effect-v1',
        kind: 'microvertical-delivery-unit',
        packageName: '@app/shell-super-app',
        schemaVersion: 1,
        sourceRevision: 'workspace',
        surface: 'api',
        unitId: 'app/shell-super-app',
        version: '0.1.0',
      },
      ui: {
        appId: 'shell-super-app',
        build: '090dd0a19fdd0853',
        buildMarker: '090dd0a19fdd0853',
        deployProfile: 'cloudflare-ssr-mf-effect-v1',
        kind: 'microvertical-delivery-unit',
        packageName: '@app/shell-super-app',
        schemaVersion: 1,
        sourceRevision: 'workspace',
        surface: 'ui',
        unitId: 'app/shell-super-app',
        version: '0.1.0',
      },
    },
  } as const,
  {
    buildMarker: () => ULTRAMODERN_BUILD_MARKER,
    sourceRevision: () => ULTRAMODERN_SOURCE_REVISION,
  }
);

export const ultramodernDeliveryUnit = ultramodernBuildArtifact.deliveryUnit;
