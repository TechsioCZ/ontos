import { siamparkPropertyApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-property',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkPropertyBackend',
  openapiPath: '/siampark-property-api/openapi.json',
  readinessPath: '/siampark-property-api/siampark-property/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkPropertyApiContract as contract,
  siamparkPropertyOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkPropertyApi;
