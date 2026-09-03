/* eslint-disable unicorn/prefer-export-from -- Runtime schemas are imported for endpoint composition and re-exported as the public contract. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { ReadProjectApi } from './apis/read-project.ts';
import {
  ArchiveProjectPayloadSchema,
  ArchiveProjectResultSchema,
} from '../src/actions/archive-project.action.ts';
import {
  CreateProjectPayloadSchema,
  CreateProjectResultSchema,
} from '../src/actions/create-project.action.ts';
import {
  MoveProjectPayloadSchema,
  MoveProjectResultSchema,
} from '../src/actions/move-project.action.ts';
import {
  UnarchiveProjectPayloadSchema,
  UnarchiveProjectResultSchema,
} from '../src/actions/unarchive-project.action.ts';
import {
  UpdateProjectPayloadSchema,
  UpdateProjectResultSchema,
} from '../src/actions/update-project.action.ts';

export const projectsApiContract = {
  apiPrefix: '/projects-api',
  appId: 'projects',
  basePath: '/projects-api/projects',
  readinessPath: '/projects-api/projects/readiness',
} as const;

// The generated child contract owns its HttpApiGroup.make and HttpApiEndpoint.post declarations.
export const ProjectsApiMarkerSchema = Schema.Struct({ appId: Schema.Literal('projects') });
export const ProjectsReadinessSchema = Schema.Struct({
  appId: Schema.Literal('projects'),
  status: Schema.Literal('ready'),
});
export type ProjectsReadiness = typeof ProjectsReadinessSchema.Type;

export interface ProjectsOperationContext {
  readonly method: string;
  readonly operationId: string;
  readonly routePath: string;
  readonly source: 'generated-client';
  readonly traceId?: string;
}

export const ProjectsMutationHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

const problemFields = {
  detail: Schema.String,
  title: Schema.String,
  type: Schema.String,
} as const;
const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });
const projectProblem = <Tag extends string, Status extends number>(tag: Tag, status: Status) =>
  Schema.TaggedStruct(tag, { ...problemFields, status: Schema.Literal(status) }).pipe(
    asProblemDetails,
    HttpApiSchema.status(status),
  );
export const ProjectsInvalidProblemSchema = projectProblem('ProjectsInvalidProblem', 400);
export const ProjectsAuthenticationProblemSchema = projectProblem(
  'ProjectsAuthenticationProblem',
  401,
);
export const ProjectsForbiddenProblemSchema = projectProblem('ProjectsForbiddenProblem', 403);
export const ProjectsNotFoundProblemSchema = projectProblem('ProjectsNotFoundProblem', 404);
export const ProjectsConflictProblemSchema = Schema.TaggedStruct('ProjectsConflictProblem', {
  ...problemFields,
  code: Schema.Literals([
    'projects_conflict',
    'project_hierarchy_conflict',
    'project_lifecycle_conflict',
    'project_owner_ineligible',
    'project_prefix_conflict',
  ]),
  status: Schema.Literal(409),
}).pipe(asProblemDetails, HttpApiSchema.status(409));
export const ProjectsPreconditionProblemSchema = projectProblem('ProjectsPreconditionProblem', 428);
export const ProjectsUnavailableProblemSchema = Schema.TaggedStruct('ProjectsUnavailableProblem', {
  ...problemFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(asProblemDetails, HttpApiSchema.status(503));
export const ProjectsInternalProblemSchema = projectProblem('ProjectsInternalProblem', 500);

export type ProjectsProblem =
  | typeof ProjectsInvalidProblemSchema.Type
  | typeof ProjectsAuthenticationProblemSchema.Type
  | typeof ProjectsForbiddenProblemSchema.Type
  | typeof ProjectsNotFoundProblemSchema.Type
  | typeof ProjectsConflictProblemSchema.Type
  | typeof ProjectsPreconditionProblemSchema.Type
  | typeof ProjectsUnavailableProblemSchema.Type
  | typeof ProjectsInternalProblemSchema.Type;

const mutationErrors = [
  ProjectsInvalidProblemSchema,
  ProjectsAuthenticationProblemSchema,
  ProjectsForbiddenProblemSchema,
  ProjectsNotFoundProblemSchema,
  ProjectsConflictProblemSchema,
  ProjectsPreconditionProblemSchema,
  ProjectsUnavailableProblemSchema,
  ProjectsInternalProblemSchema,
] as const;

export const projectsMutationApi = HttpApi.make('ProjectsMutationApi').add(
  HttpApiGroup.make('mutations')
    .add(
      HttpApiEndpoint.post('createProject', '/projects/create', {
        error: mutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: CreateProjectPayloadSchema,
        success: CreateProjectResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('updateProject', '/projects/update', {
        error: mutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: UpdateProjectPayloadSchema,
        success: UpdateProjectResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('moveProject', '/projects/move', {
        error: mutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: MoveProjectPayloadSchema,
        success: MoveProjectResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveProject', '/projects/archive', {
        error: mutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: ArchiveProjectPayloadSchema,
        success: ArchiveProjectResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveProject', '/projects/unarchive', {
        error: mutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: UnarchiveProjectPayloadSchema,
        success: UnarchiveProjectResultSchema,
      }),
    ),
);

export const projectsFoundationApi = HttpApi.make('ProjectsFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/projects/readiness', {
      success: ProjectsReadinessSchema,
    }),
  ),
);

export const projectsApi = HttpApi.make('ProjectsApi')
  .addHttpApi(projectsFoundationApi)
  .addHttpApi(projectsMutationApi)
  .addHttpApi(ReadProjectApi);

const operation = (method: string, routePath: string): ProjectsOperationContext => ({
  method,
  operationId: `ProjectsApi:${routePath}`,
  routePath,
  source: 'generated-client',
});

export const projectsOperationContexts = {
  archiveProject: operation('POST', '/projects/archive'),
  createProject: operation('POST', '/projects/create'),
  moveProject: operation('POST', '/projects/move'),
  readProject: operation('POST', '/reads/read-project'),
  readiness: operation('GET', '/projects/readiness'),
  unarchiveProject: operation('POST', '/projects/unarchive'),
  updateProject: operation('POST', '/projects/update'),
} satisfies Record<string, ProjectsOperationContext>;

export {
  ArchiveProjectPayloadSchema,
  ArchiveProjectResultSchema,
  CreateProjectPayloadSchema,
  CreateProjectResultSchema,
  MoveProjectPayloadSchema,
  MoveProjectResultSchema,
  UnarchiveProjectPayloadSchema,
  UnarchiveProjectResultSchema,
  UpdateProjectPayloadSchema,
  UpdateProjectResultSchema,
};
export type {
  ArchiveProjectPayload,
  ArchiveProjectResult,
} from '../src/actions/archive-project.action.ts';
export type {
  CreateProjectPayload,
  CreateProjectResult,
} from '../src/actions/create-project.action.ts';
export type { MoveProjectPayload, MoveProjectResult } from '../src/actions/move-project.action.ts';
export type {
  UnarchiveProjectPayload,
  UnarchiveProjectResult,
} from '../src/actions/unarchive-project.action.ts';
export type {
  UpdateProjectPayload,
  UpdateProjectResult,
} from '../src/actions/update-project.action.ts';

export {
  ReadProjectApi,
  ReadProjectRequestSchema,
  ReadProjectResponseSchema,
} from './apis/read-project.ts';
export type { ReadProjectRequest, ReadProjectResponse } from './apis/read-project.ts';
