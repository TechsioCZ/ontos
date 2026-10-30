import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { ArchiveProjectActionApi } from './apis/archive-project-action.ts';
import { CreateProjectActionApi } from './apis/create-project-action.ts';
import { MoveProjectActionApi } from './apis/move-project-action.ts';
import { ProjectOwnerCandidatesApi } from './apis/project-owner-candidates.ts';
import { ReadProjectApi } from './apis/read-project.ts';
import { UnarchiveProjectActionApi } from './apis/unarchive-project-action.ts';
import { UpdateProjectActionApi } from './apis/update-project-action.ts';
// </generated-governed-http-api-imports>

export type OperationContext = MicroVerticalOperationContext;
export const projectsMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
});
export const projectsReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: projectsMarkerSchema,
});
export type ProjectsReadiness = typeof projectsReadinessSchema.Type;
export const projectsFoundationApi = HttpApi.make('ProjectsApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/projects/readiness', { success: projectsReadinessSchema }),
  ),
);

export const projectsApi = HttpApi.make('ProjectsApi')
  .addHttpApi(projectsFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ArchiveProjectActionApi)
  .addHttpApi(CreateProjectActionApi)
  .addHttpApi(MoveProjectActionApi)
  .addHttpApi(ProjectOwnerCandidatesApi)
  .addHttpApi(ReadProjectApi)
  .addHttpApi(UnarchiveProjectActionApi)
  .addHttpApi(UpdateProjectActionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const projectsOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'ProjectsApi:projects:readiness',
    routePath: '/projects/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const projectsApiContract = {
  apiPrefix: '/projects-api',
  basePath: '/projects-api/projects',
  ownerId: 'projects',
  readinessPath: '/projects-api/projects/readiness',
} as const;
