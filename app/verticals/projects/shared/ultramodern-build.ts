import { resolveUltramodernBuildArtifact } from '@modern-js/backend-federation-contracts';

const buildArtifact = {
  deliveryUnit: {
    appId: 'projects',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/projects',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: 'app/projects',
    version: '0.1.0',
    buildMarker: '73f9b5b664d77c6a',
    build: '73f9b5b664d77c6a',
  },
  kind: 'ultramodern-build-artifact',
  schemaVersion: 2,
  surfaces: {
    api: {
      appId: 'projects',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/projects',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/projects',
      version: '0.1.0',
      buildMarker: '73f9b5b664d77c6a',
      build: '73f9b5b664d77c6a',
      surface: 'api',
    },
    ui: {
      appId: 'projects',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: '@app/projects',
      schemaVersion: 1,
      sourceRevision: 'workspace',
      unitId: 'app/projects',
      version: '0.1.0',
      buildMarker: '73f9b5b664d77c6a',
      build: '73f9b5b664d77c6a',
      surface: 'ui',
      rendererIdentity: {
        renderer: 'react',
        appId: 'projects',
        entryName: 'index',
        protocolVersion: 1,
        buildId: '73f9b5b664d77c6a',
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
  throw new Error('Application projects requires a UI build identity.');
}
export const ultramodernUiMarker = ultramodernUiSurface;
export const ultramodernApiMarker = ultramodernBuildArtifact.surfaces.api;
