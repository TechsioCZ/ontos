import { siamparkWorkApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-work',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkWorkBackend',
  openapiPath: '/siampark-work-api/openapi.json',
  readinessPath: '/siampark-work-api/siampark-work/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkWorkApiContract as contract,
  siamparkWorkOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkWorkApi;
