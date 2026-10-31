import { facilityOperationsApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/facility-operations',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalFacilityOperationsBackend',
  openapiPath: '/facility-operations-api/openapi.json',
  readinessPath: '/facility-operations-api/facility-operations/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  facilityOperationsApiContract as contract,
  facilityOperationsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = facilityOperationsApi;
