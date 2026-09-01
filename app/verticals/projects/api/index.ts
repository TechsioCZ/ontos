// @effect-diagnostics missedPipeableOpportunity:off strictEffectProvide:off
/* eslint-disable complexity, curly, no-nested-ternary, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/no-nested-ternary, unicorn/switch-case-braces -- The strict Effect BFF keeps complete typed error mappings visible. */
import {
  ActionRuntime,
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  makeReadRuntimeLive,
} from '@app/core-runtime';
import type {
  ActionCoreError,
  ActionRegistration,
  DomainEventContractMap,
  ReadRuntime,
} from '@app/core-runtime';
import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpEffect,
  HttpRouter,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import type { Schema } from 'effect';
import { Config } from 'effect';
import { projectsApi } from '../shared/api.ts';
import type { ProjectsProblem } from '../shared/api.ts';
import {
  projectsCorsAllowedHeaders,
  projectsCorsAllowedMethods,
  projectsCorsAllowedOrigins,
  resolveProjectsShellOrigin,
} from '../shared/cors.ts';
import type {
  ProjectOwnerEligibilityUnavailable,
  ProjectOwnerNotEligible,
} from '../src/actions/create-project.action.ts';
import { createProjectAction } from '../src/actions/create-project.action.ts';
import type { ProjectOwnerIneligible } from '../src/actions/update-project.action.ts';
import { updateProjectAction } from '../src/actions/update-project.action.ts';
import { archiveProjectAction } from '../src/actions/archive-project.action.ts';
import { moveProjectAction } from '../src/actions/move-project.action.ts';
import { unarchiveProjectAction } from '../src/actions/unarchive-project.action.ts';
import type {
  ProjectHierarchyConflict,
  ProjectLifecycleConflict,
  ProjectNotFound,
  ProjectPersistenceUnavailable,
  ProjectPrefixConflict,
} from '../src/domain/project.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
import { readProjectReadApiLive } from './read-project-read-server.ts';

declare const ULTRAMODERN_SHELL_ORIGIN: string;

type ProjectsActionError =
  | ActionCoreError
  | ProjectHierarchyConflict
  | ProjectLifecycleConflict
  | ProjectNotFound
  | ProjectOwnerEligibilityUnavailable
  | ProjectOwnerIneligible
  | ProjectOwnerNotEligible
  | ProjectPersistenceUnavailable
  | ProjectPrefixConflict;

const problem = {
  authentication: (): ProjectsProblem => ({
    _tag: 'ProjectsAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  conflict: (
    code: Extract<ProjectsProblem, { readonly status: 409 }>['code'] = 'projects_conflict',
  ): ProjectsProblem => ({
    _tag: 'ProjectsConflictProblem',
    code,
    detail: 'The Projects operation conflicts with the current state.',
    status: 409,
    title: 'Projects operation conflict',
    type: 'https://ontos.dev/problems/projects-conflict',
  }),
  forbidden: (): ProjectsProblem => ({
    _tag: 'ProjectsForbiddenProblem',
    detail: 'The principal is not permitted to perform this Projects operation.',
    status: 403,
    title: 'Projects operation forbidden',
    type: 'https://ontos.dev/problems/projects-forbidden',
  }),
  internal: (): ProjectsProblem => ({
    _tag: 'ProjectsInternalProblem',
    detail: 'The Projects operation could not be completed.',
    status: 500,
    title: 'Projects operation failed',
    type: 'https://ontos.dev/problems/projects-failed',
  }),
  invalid: (): ProjectsProblem => ({
    _tag: 'ProjectsInvalidProblem',
    detail: 'The Projects operation request is invalid.',
    status: 400,
    title: 'Invalid Projects request',
    type: 'https://ontos.dev/problems/projects-invalid',
  }),
  notFound: (): ProjectsProblem => ({
    _tag: 'ProjectsNotFoundProblem',
    detail: 'The requested Project was not found.',
    status: 404,
    title: 'Project not found',
    type: 'https://ontos.dev/problems/project-not-found',
  }),
  precondition: (): ProjectsProblem => ({
    _tag: 'ProjectsPreconditionProblem',
    detail: 'An Idempotency-Key header is required.',
    status: 428,
    title: 'Idempotency key required',
    type: 'https://ontos.dev/problems/idempotency-key-required',
  }),
  unavailable: (): ProjectsProblem => ({
    _tag: 'ProjectsUnavailableProblem',
    detail: 'The Projects operation is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Projects unavailable',
    type: 'https://ontos.dev/problems/projects-unavailable',
  }),
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const failProblem = (mapped: ProjectsProblem) =>
  (mapped._tag === 'ProjectsAuthenticationProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );
const isProjectsProblem = (
  error: ProjectsActionError | ProjectsProblem,
): error is ProjectsProblem => error._tag.startsWith('Projects') && error._tag.endsWith('Problem');
const failProjectsProblem = (error: ProjectsProblem) => Effect.fail(error);

interface ProjectsActionTransport {
  readonly correlationId: string;
  idempotencyKey?: string;
  traceId?: string;
}

const actionProblem = (error: ProjectsActionError): ProjectsProblem => {
  switch (error._tag) {
    case 'ActionPayloadValidationError':
      return problem.invalid();
    case 'ActionTrustedContextValidationError':
    case 'OperationAuthenticationRequired':
      return problem.authentication();
    case 'ActionIdempotencyKeyRequired':
      return problem.precondition();
    case 'ActionPermissionDenied':
    case 'ModuleStateDeniedError':
    case 'OperationContextDenied':
    case 'OperationContextInvalid':
      return problem.forbidden();
    case 'ActionInvocationNotFound':
    case 'ProjectNotFound':
      return problem.notFound();
    case 'ProjectHierarchyConflict':
      return problem.conflict('project_hierarchy_conflict');
    case 'ProjectLifecycleConflict':
      return problem.conflict('project_lifecycle_conflict');
    case 'ProjectOwnerEligibilityUnavailable':
    case 'ProjectOwnerIneligible':
    case 'ProjectOwnerNotEligible':
      return problem.conflict('project_owner_ineligible');
    case 'ProjectPrefixConflict':
      return problem.conflict('project_prefix_conflict');
    case 'ActionAlreadyCommitted':
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict':
      return problem.conflict();
    case 'ActionCommitIndeterminate':
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
    case 'ProjectPersistenceUnavailable':
      return problem.unavailable();
    case 'ActionCollectorError':
    case 'ActionHandlerExecutionError':
    case 'ActionPolicyDenied':
    case 'ActionResultValidationError':
      return problem.internal();
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const verifyPrincipal = (authorization: string | undefined) =>
  Config.all({
    ONTOS_GATEWAY_ISSUER: Config.string('ONTOS_GATEWAY_ISSUER'),
    ONTOS_GATEWAY_PUBLIC_JWKS: Config.string('ONTOS_GATEWAY_PUBLIC_JWKS'),
  }).pipe(
    Effect.mapError(() => problem.unavailable()),
    Effect.flatMap((environment) => verifyOperationPrincipal(authorization, { environment })),
    Effect.catch((error) =>
      '_tag' in error && error._tag === 'ProjectsUnavailableProblem'
        ? Effect.fail(error)
        : error._tag === 'ActionPrincipalConfigurationError' ||
            error._tag === 'ActionPrincipalUnavailableError'
          ? Effect.fail(problem.unavailable())
          : failProblem(problem.authentication()),
    ),
  );

const runProjectsAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<ProjectsActionError, never>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    Requirements
  >,
  payload: Schema.Schema.Type<PayloadSchema>,
  headers: Readonly<Record<string, string | undefined>>,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* executeProjectsAction() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0)
      return yield* failProblem(problem.invalid());
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
    const runtime = yield* ActionRuntime;
    const transport: ProjectsActionTransport = { correlationId };
    const idempotencyKey = headers['idempotency-key'];
    if (idempotencyKey !== undefined) transport.idempotencyKey = idempotencyKey;
    const traceId = requestHeaders['x-trace-id'];
    if (traceId !== undefined) transport.traceId = traceId;
    return yield* runtime
      .runAction({ payload, principal, registration, transport })
      .pipe(Effect.provide(ContextAccessLive));
  }).pipe(
    Effect.catch((error: ProjectsActionError | ProjectsProblem) =>
      isProjectsProblem(error) ? failProjectsProblem(error) : failProblem(actionProblem(error)),
    ),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected Projects Action BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

const mutationsLive = HttpApiBuilder.group(projectsApi, 'mutations', (handlers) =>
  handlers
    .handle('createProject', ({ headers, payload, request }) =>
      runProjectsAction(createProjectAction, payload, headers, request.headers),
    )
    .handle('updateProject', ({ headers, payload, request }) =>
      runProjectsAction(updateProjectAction, payload, headers, request.headers),
    )
    .handle('moveProject', ({ headers, payload, request }) =>
      runProjectsAction(moveProjectAction, payload, headers, request.headers),
    )
    .handle('archiveProject', ({ headers, payload, request }) =>
      runProjectsAction(archiveProjectAction, payload, headers, request.headers),
    )
    .handle('unarchiveProject', ({ headers, payload, request }) =>
      runProjectsAction(unarchiveProjectAction, payload, headers, request.headers),
    ),
);

const foundationLive = HttpApiBuilder.group(projectsApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({ appId: 'projects' as const, status: 'ready' as const }),
  ),
);

const readRuntimeLive = makeReadRuntimeLive(ContextAccessLive).pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const actionRuntimeLive = ActionRuntimeLive.pipe(
  Layer.provide(ContextAccessLive),
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);

export const makeProjectsApiRuntime = (
  actionRuntime: Layer.Layer<ActionRuntime> = actionRuntimeLive,
  readRuntime: Layer.Layer<ReadRuntime> = readRuntimeLive,
): EffectBffDefinition<typeof projectsApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof projectsApi, EffectRuntimeLayer> => {
  const handlers = Layer.mergeAll(
    foundationLive,
    mutationsLive.pipe(Layer.provide(actionRuntime)),
    readProjectReadApiLive.pipe(Layer.provide(readRuntime)),
  );
  let configuredOrigin: string | undefined;
  try {
    configuredOrigin = ULTRAMODERN_SHELL_ORIGIN;
  } catch {
    configuredOrigin = undefined;
  }
  const shellOrigin = resolveProjectsShellOrigin(configuredOrigin);
  const layer = HttpApiBuilder.layer(projectsApi).pipe(
    Layer.provide(handlers),
    Layer.merge(
      HttpRouter.cors({
        allowedHeaders: [...projectsCorsAllowedHeaders],
        allowedMethods: [...projectsCorsAllowedMethods],
        allowedOrigins: projectsCorsAllowedOrigins(shellOrigin),
        maxAge: 600,
      }),
    ),
  ) satisfies EffectRuntimeLayer;
  return defineEffectBff({ api: projectsApi, layer });
};

const projectsApiRuntime = makeProjectsApiRuntime();
export default projectsApiRuntime;
