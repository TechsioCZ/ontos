import { siamparkOccupancyApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-occupancy',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkOccupancyBackend',
  openapiPath: '/siampark-occupancy-api/openapi.json',
  readinessPath: '/siampark-occupancy-api/siampark-occupancy/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkOccupancyApiContract as contract,
  siamparkOccupancyOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkOccupancyApi;
