import type { GatewayContextClientOptions } from '@app/shared-contracts';
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type { HttpApi, HttpApiClient, HttpApiGroup } from '@modern-js/plugin-bff/effect-client';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { projectsApi, projectsApiContract, projectsOperationContexts } from '../../shared/api.ts';
import type {
  ArchiveProjectPayload,
  CreateProjectPayload,
  MoveProjectPayload,
  ProjectsOperationContext,
  ReadProjectRequest,
  UnarchiveProjectPayload,
  UpdateProjectPayload,
} from '../../shared/api.ts';
import { operationGateway } from './action-gateway.ts';

export { Effect } from '@modern-js/plugin-bff/effect-client';
export { projectsApiContract } from '../../shared/api.ts';

export interface ProjectsClientOptions {
  readonly baseUrl?: string | URL;
  readonly correlationId: string;
  readonly gateway?: GatewayContextClientOptions;
  readonly operationContext?: ProjectsOperationContext;
  readonly traceId?: string;
}
export interface ProjectsMutationOptions extends ProjectsClientOptions {
  readonly idempotencyKey: string;
}
type ProjectsApiGroups =
  typeof projectsApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;
type ProjectsClient = HttpApiClient.Client<
  Extract<ProjectsApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;

const invoke = <Success, Failure>(
  options: ProjectsClientOptions,
  context: ProjectsOperationContext,
  operation: (client: ProjectsClient) => Effect.Effect<Success, Failure>,
) =>
  operationGateway.invoke((authorization) => {
    const operationContext =
      options.operationContext ??
      (options.traceId === undefined ? context : { ...context, traceId: options.traceId });
    const headers =
      options.traceId === undefined
        ? { authorization, 'x-correlation-id': options.correlationId }
        : {
            authorization,
            'x-correlation-id': options.correlationId,
            'x-trace-id': options.traceId,
          };
    return makeEffectHttpApiClient(projectsApi, {
      baseUrl: options.baseUrl ?? projectsApiContract.apiPrefix,
      requestContext: { operationContext },
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
    }).pipe(Effect.flatMap(operation));
  }, options.gateway);

const mutationHeaders = (options: ProjectsMutationOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

export const getProjectsReadiness = (baseUrl: string | URL = projectsApiContract.apiPrefix) =>
  makeEffectHttpApiClient(projectsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );
export const createProject = (payload: CreateProjectPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.createProject, (client) =>
    client.mutations.createProject({ headers: mutationHeaders(options), payload }),
  );
export const updateProject = (payload: UpdateProjectPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.updateProject, (client) =>
    client.mutations.updateProject({ headers: mutationHeaders(options), payload }),
  );
export const moveProject = (payload: MoveProjectPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.moveProject, (client) =>
    client.mutations.moveProject({ headers: mutationHeaders(options), payload }),
  );
export const archiveProject = (payload: ArchiveProjectPayload, options: ProjectsMutationOptions) =>
  invoke(options, projectsOperationContexts.archiveProject, (client) =>
    client.mutations.archiveProject({ headers: mutationHeaders(options), payload }),
  );
export const unarchiveProject = (
  payload: UnarchiveProjectPayload,
  options: ProjectsMutationOptions,
) =>
  invoke(options, projectsOperationContexts.unarchiveProject, (client) =>
    client.mutations.unarchiveProject({ headers: mutationHeaders(options), payload }),
  );
export const readProject = (payload: ReadProjectRequest, options: ProjectsClientOptions) =>
  invoke(options, projectsOperationContexts.readProject, (client) =>
    client.reads.execute({ payload }),
  );

export { executeReadProject, executeReadProjectWithAuthorization } from './read-project-client.ts';
