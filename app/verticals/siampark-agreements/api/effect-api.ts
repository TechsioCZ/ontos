import { siamparkAgreementsApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-agreements',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkAgreementsBackend',
  openapiPath: '/siampark-agreements-api/openapi.json',
  readinessPath: '/siampark-agreements-api/siampark-agreements/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkAgreementsApiContract as contract,
  siamparkAgreementsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkAgreementsApi;
