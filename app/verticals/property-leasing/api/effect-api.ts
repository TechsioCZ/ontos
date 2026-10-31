import { propertyLeasingApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/property-leasing',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalPropertyLeasingBackend',
  openapiPath: '/property-leasing-api/openapi.json',
  readinessPath: '/property-leasing-api/property-leasing/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  propertyLeasingApiContract as contract,
  propertyLeasingOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = propertyLeasingApi;
