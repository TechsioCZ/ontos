import { withUltramodernBuildIdentity } from '@app/shared-contracts/ultramodern-build';

declare const ULTRAMODERN_BUILD_MARKER: string;
declare const ULTRAMODERN_SOURCE_REVISION: string;

const APP_ID = 'pricing';
const BUILD_MARKER = '472426e9fbfd8da9';
const DEPLOY_PROFILE = 'cloudflare-ssr-mf-effect-v1';
const DELIVERY_UNIT_KIND = 'microvertical-delivery-unit';
const PACKAGE_NAME = '@app/pricing';
const SOURCE_REVISION = 'workspace';
const UNIT_ID = 'app/pricing';
const VERSION = '0.1.0';

const generatedBuildArtifact = {
  deliveryUnit: {
    appId: APP_ID,
    build: BUILD_MARKER,
    buildMarker: BUILD_MARKER,
    deployProfile: DEPLOY_PROFILE,
    kind: DELIVERY_UNIT_KIND,
    packageName: PACKAGE_NAME,
    schemaVersion: 1,
    sourceRevision: SOURCE_REVISION,
    unitId: UNIT_ID,
    version: VERSION,
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 1,
  surfaces: {
    api: {
      appId: APP_ID,
      build: BUILD_MARKER,
      buildMarker: BUILD_MARKER,
      deployProfile: DEPLOY_PROFILE,
      kind: DELIVERY_UNIT_KIND,
      packageName: PACKAGE_NAME,
      schemaVersion: 1,
      sourceRevision: SOURCE_REVISION,
      surface: 'api',
      unitId: UNIT_ID,
      version: VERSION,
    },
    ui: {
      appId: APP_ID,
      build: BUILD_MARKER,
      buildMarker: BUILD_MARKER,
      deployProfile: DEPLOY_PROFILE,
      kind: DELIVERY_UNIT_KIND,
      packageName: PACKAGE_NAME,
      schemaVersion: 1,
      sourceRevision: SOURCE_REVISION,
      surface: 'ui',
      unitId: UNIT_ID,
      version: VERSION,
    },
  },
} as const;

const readInjectedBuildValue = (read: () => string, fallback: string): string => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const buildArtifact = withUltramodernBuildIdentity(
  generatedBuildArtifact,
  readInjectedBuildValue(() => ULTRAMODERN_BUILD_MARKER, generatedBuildArtifact.deliveryUnit.buildMarker),
  readInjectedBuildValue(() => ULTRAMODERN_SOURCE_REVISION, generatedBuildArtifact.deliveryUnit.sourceRevision),
);

export const ultramodernApiMarker = buildArtifact.surfaces.api;
