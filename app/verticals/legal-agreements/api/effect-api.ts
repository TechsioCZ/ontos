import { legalAgreementsApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/legal-agreements',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalLegalAgreementsBackend',
  openapiPath: '/legal-agreements-api/openapi.json',
  readinessPath: '/legal-agreements-api/legal-agreements/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  legalAgreementsApiContract as contract,
  legalAgreementsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = legalAgreementsApi;
