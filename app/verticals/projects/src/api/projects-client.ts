import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import type { EffectBffClientOptions, EffectBffRequestContext } from '@app/shared-contracts/client-runtime';
import { projectsApi, projectsApiContract, projectsOperationContexts } from '../../shared/api.ts';
import type { ReadProjectRequest } from '../../shared/apis/read-project.ts';
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

/** Exact-target reads opt out explicitly; the generated client forwards these canonical transport options. */
export const executeFreshReadProject = (payload: ReadProjectRequest, requestCorrelation: string) => {
  const options: Pick<EffectBffClientOptions, 'baseUrl' | 'compositionRevision' | 'requestCache'> = {
    requestCache: 'no-store',
  };
  return executeReadProject(payload, requestCorrelation, options);
};

// <generated-action-http-client-exports>
export { executeArchiveProject, executeArchiveProjectWithAuthorization } from './archive-project-action-client.ts';
export type { ArchiveProjectActionClientOptions } from './archive-project-action-client.ts';
export { executeCreateProject, executeCreateProjectWithAuthorization } from './create-project-action-client.ts';
export type { CreateProjectActionClientOptions } from './create-project-action-client.ts';
export { executeMoveProject, executeMoveProjectWithAuthorization } from './move-project-action-client.ts';
export type { MoveProjectActionClientOptions } from './move-project-action-client.ts';
export {
  executeUnarchiveProject,
  executeUnarchiveProjectWithAuthorization,
} from './unarchive-project-action-client.ts';
export type { UnarchiveProjectActionClientOptions } from './unarchive-project-action-client.ts';
export { executeUpdateProject, executeUpdateProjectWithAuthorization } from './update-project-action-client.ts';
export type { UpdateProjectActionClientOptions } from './update-project-action-client.ts';
export {
  executeRequestSearchRebuild,
  executeRequestSearchRebuildWithAuthorization,
} from './request-search-rebuild-action-client.ts';
export type { RequestSearchRebuildActionClientOptions } from './request-search-rebuild-action-client.ts';
// </generated-action-http-client-exports>

export const getProjectsReadiness = ({
  baseUrl,
  ...requestContext
}: EffectBffRequestContext & { baseUrl?: string | URL } = {}) =>
  makeEffectBffClientOptions({
    baseUrl: baseUrl ?? projectsApiContract.apiPrefix,
    defaultApiPrefix: projectsApiContract.apiPrefix,
    requestContext: {
      ...requestContext,
      operationContext: requestContext.operationContext ?? projectsOperationContexts.readiness,
    },
  }).pipe(
    // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- #358 explicitly requires lazy uncached client construction so request metadata and credentials cannot survive across operations. expires: 2026-12-31.
    Effect.flatMap((clientOptions) => makeEffectHttpApiClient(projectsApi, clientOptions)),
    Effect.flatMap((client) => client.foundation.readiness({})),
  );
