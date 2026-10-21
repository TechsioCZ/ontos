import { propertyPortfolioApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/property-portfolio',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalPropertyPortfolioBackend',
  openapiPath: '/property-portfolio-api/openapi.json',
  readinessPath: '/property-portfolio-api/property-portfolio/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  propertyPortfolioApiContract as contract,
  propertyPortfolioOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = propertyPortfolioApi;
