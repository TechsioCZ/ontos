import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'sales-pipeline',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/sales-pipeline',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/sales-pipeline',
    version: '0.1.0',
    buildMarker: '7f1d79b710af8c3d',
    build: '7f1d79b710af8c3d',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'sales-pipeline',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/sales-pipeline',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/sales-pipeline',
      version: '0.1.0',
      buildMarker: '7f1d79b710af8c3d',
      build: '7f1d79b710af8c3d',
      surface: 'api',
    },
    ui: {
      appId: 'sales-pipeline',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/sales-pipeline',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/sales-pipeline',
      version: '0.1.0',
      buildMarker: '7f1d79b710af8c3d',
      build: '7f1d79b710af8c3d',
      surface: 'ui',
      rendererIdentity: {
        renderer: 'react',
        appId: 'sales-pipeline',
        entryName: 'index',
        protocolVersion: 1,
        buildId: '7f1d79b710af8c3d',
      },
      rendererProfile: {
        renderer: 'react',
        protocolVersion: 1,
        compiler: {
          name: '@rsbuild/plugin-react',
          version: '2.1.1',
        },
        hydration: {
          name: 'react-dom',
          version: '19.3.1',
        },
        router: {
          name: 'react-router',
          version: '7.18.4',
          coreName: 'react-router',
          coreVersion: '7.18.4',
        },
      },
      routerBindings: {
        index: {
          owner: '@modern-js/plugin-tanstack',
          evidence: 'file-routes',
          defaultProvider: {
            framework: 'tanstack',
            name: '@tanstack/react-router',
            version: '1.170.39',
            coreName: '@tanstack/router-core',
            coreVersion: '1.171.32',
          },
          providers: [
            {
              framework: 'tanstack',
              name: '@tanstack/react-router',
              version: '1.170.39',
              coreName: '@tanstack/router-core',
              coreVersion: '1.171.32',
            },
          ],
        },
      },
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
const ultramodernUiSurface = ultramodernBuildArtifact.surfaces.ui;
if (ultramodernUiSurface === undefined) {
  throw new Error('Application sales-pipeline requires a UI build identity.');
}
export const ultramodernUiMarker = ultramodernUiSurface;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
