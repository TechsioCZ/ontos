import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: ultramodernApiMarker.packageName,
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  contractVersion: 'microvertical-server-effect-v1',
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalPropertyLeasingBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/property-leasing-api/openapi.json',
  readinessPath: '/property-leasing-api/property-leasing/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  propertyLeasingApi as api,
  propertyLeasingApiContract as contract,
  propertyLeasingOperationContexts as operationContexts,
} from '../shared/api.ts';
