import { siamparkRelationshipsApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-relationships',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkRelationshipsBackend',
  openapiPath: '/siampark-relationships-api/openapi.json',
  readinessPath: '/siampark-relationships-api/siampark-relationships/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkRelationshipsApiContract as contract,
  siamparkRelationshipsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkRelationshipsApi;
