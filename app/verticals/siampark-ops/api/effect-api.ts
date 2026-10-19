import { siamparkOpsApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-ops',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkOpsBackend',
  openapiPath: '/siampark-ops-api/openapi.json',
  readinessPath: '/siampark-ops-api/siampark-ops/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkOpsApiContract as contract,
  siamparkOpsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkOpsApi;
