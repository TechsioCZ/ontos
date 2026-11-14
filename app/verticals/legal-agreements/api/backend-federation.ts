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
  name: 'verticalLegalAgreementsBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/legal-agreements-api/openapi.json',
  readinessPath: '/legal-agreements-api/legal-agreements/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  legalAgreementsApi as api,
  legalAgreementsApiContract as contract,
  legalAgreementsOperationContexts as operationContexts,
} from '../shared/api.ts';
