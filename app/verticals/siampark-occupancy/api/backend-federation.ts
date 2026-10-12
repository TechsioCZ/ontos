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
  name: 'verticalSiamparkOccupancyBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/siampark-occupancy-api/openapi.json',
  readinessPath: '/siampark-occupancy-api/siampark-occupancy/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkOccupancyApi as api,
  siamparkOccupancyApiContract as contract,
  siamparkOccupancyOperationContexts as operationContexts,
} from '../shared/api.ts';
