import apiRuntime from './index.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ticketingApi, ticketingApiContract, ticketingOperationContexts } from '../shared/api.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/ticketing',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalTicketingBackend',
  openapiPath: '/ticketing-api/openapi.json',
  readinessPath: '/ticketing-api/ticketing/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export const api: unknown = ticketingApi;
export const contract = ticketingApiContract;
export const operationContexts = ticketingOperationContexts;
export const runtime = apiRuntime;

export default apiRuntime;
