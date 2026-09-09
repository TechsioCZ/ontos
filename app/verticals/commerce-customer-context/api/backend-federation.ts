import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: ultramodernApiMarker.packageName,
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  contractVersion: 'microvertical-server-effect-v1',
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalCommerceCustomerContextBackend',
  nodeAdapterVersion: 'backend-mf-effect-v1',
  openapiPath: '/commerce-customer-context-api/openapi.json',
  readinessPath: '/commerce-customer-context-api/commerce-customer-context/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  commerceCustomerContextApi as api,
  commerceCustomerContextApiContract as contract,
  commerceCustomerContextOperationContexts as operationContexts,
} from '../shared/api.ts';
