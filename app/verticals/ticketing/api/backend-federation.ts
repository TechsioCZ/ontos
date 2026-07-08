import runtime from './index.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import {
  ticketingApi as api,
  ticketingApiContract as contract,
  ticketingOperationContexts as operationContexts,
} from '../shared/api.ts';

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
  name: 'verticalTicketingBackend',
  nodeAdapterVersion: 'backend-mf-effect-v1',
  openapiPath: '/ticketing-api/openapi.json',
  readinessPath: '/ticketing-api/ticketing/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { api, contract, operationContexts, runtime };

export default runtime;
