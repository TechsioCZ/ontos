import { Effect } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { EffectBffRequestContext } from '@app/shared-contracts/client-runtime';
import { projectsApi, projectsApiContract, projectsOperationContexts } from '../../shared/api.ts';
import { executeCreateProject } from './create-project-action-client.ts';
import { executeUpdateProject } from './update-project-action-client.ts';
import { executeMoveProject } from './move-project-action-client.ts';
import { executeArchiveProject } from './archive-project-action-client.ts';
import { executeUnarchiveProject } from './unarchive-project-action-client.ts';
import { executeReadProject } from './read-project-client.ts';
import { executeProjectOwnerCandidates } from './project-owner-candidates-client.ts';

export const projectsClient = {
  archive: executeArchiveProject,
  create: executeCreateProject,
  move: executeMoveProject,
  ownerCandidates: executeProjectOwnerCandidates,
  read: executeReadProject,
  unarchive: executeUnarchiveProject,
  update: executeUpdateProject,
};
// <generated-action-http-client-exports>
export { executeArchiveProject, executeArchiveProjectWithAuthorization } from './archive-project-action-client.ts';
export { executeCreateProject, executeCreateProjectWithAuthorization } from './create-project-action-client.ts';
export { executeMoveProject, executeMoveProjectWithAuthorization } from './move-project-action-client.ts';
export {
  executeUnarchiveProject,
  executeUnarchiveProjectWithAuthorization,
} from './unarchive-project-action-client.ts';
export { executeUpdateProject, executeUpdateProjectWithAuthorization } from './update-project-action-client.ts';
// </generated-action-http-client-exports>

export const getProjectsReadiness = ({
  baseUrl,
  ...requestContext
}: EffectBffRequestContext & { baseUrl?: string | URL } = {}) =>
  makeEffectBffClient({
    api: projectsApi,
    baseUrl: baseUrl ?? projectsApiContract.apiPrefix,
    defaultApiPrefix: projectsApiContract.apiPrefix,
    requestContext: {
      ...requestContext,
      operationContext: requestContext.operationContext ?? projectsOperationContexts.readiness,
    },
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
