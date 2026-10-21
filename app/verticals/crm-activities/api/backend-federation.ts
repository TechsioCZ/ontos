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
  name: 'verticalCrmActivitiesBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/crm-activities-api/openapi.json',
  readinessPath: '/crm-activities-api/crm-activities/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  crmActivitiesApi as api,
  crmActivitiesApiContract as contract,
  crmActivitiesOperationContexts as operationContexts,
} from '../shared/api.ts';
