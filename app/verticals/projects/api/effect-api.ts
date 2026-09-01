import { projectsApi, projectsApiContract } from '../shared/api.ts';

export const backendFederationContract = {
  compatibility: {
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/projects',
    unitId: 'app/projects',
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalProjectsBackend',
  openapiPath: '/projects-api/openapi.json',
  readinessPath: projectsApiContract.readinessPath,
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  projectsApiContract as contract,
  projectsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = projectsApi;
