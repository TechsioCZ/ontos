/* eslint-disable complexity, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/switch-case-braces -- The strict Effect BFF keeps complete typed error mappings visible. */
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
import { FetchHttpClient } from 'effect/unstable/http';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { projectsApi, projectsOperationContexts } from '../shared/api.ts';
import type { ProjectsProblem, OperationContext } from '../shared/api.ts';
import {
  projectsCorsAllowedHeaders,
  projectsCorsAllowedMethods,
  projectsCorsAllowedOrigins,
  resolveProjectsShellOrigin,
} from '../shared/cors.ts';
import type { ProjectsContactNotFound } from '../shared/apis/contact-detail.ts';
import type {
  ProjectsCustomerIcoConflict,
  ProjectsCustomerNotFound,
  ProjectsLifecycleConflict,
  ProjectsPersistenceUnavailable,
} from '../shared/apis/customer-detail.ts';
import { archiveContactAction } from '../src/actions/archive-contact.action.ts';
import { archiveCustomerAction } from '../src/actions/archive-customer.action.ts';
import { createContactAction } from '../src/actions/create-contact.action.ts';
import { createCustomerAction } from '../src/actions/create-customer.action.ts';
import { editContactAction } from '../src/actions/edit-contact.action.ts';
import { editCustomerAction } from '../src/actions/edit-customer.action.ts';
import { AresSubjectServiceLive } from '../src/integrations/ares/ares-subject.service.ts';
import type { AresSubjectService } from '../src/integrations/ares/ares-subject.service.ts';
import { unarchiveContactAction } from '../src/actions/unarchive-contact.action.ts';
import { unarchiveCustomerAction } from '../src/actions/unarchive-customer.action.ts';
import { contactDetailReadApiLive } from './contact-detail-read-server.ts';
import { contactListReadApiLive } from './contact-list-read-server.ts';
import { customerAresLookupReadApiLive } from './customer-ares-lookup-read-server.ts';
import { customerDetailReadApiLive } from './customer-detail-read-server.ts';
import { customerListReadApiLive } from './customer-list-read-server.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  return operationContext.traceId === undefined
    ? attributes
    : { ...attributes, 'modernjs.trace.id': operationContext.traceId };
};

const problem = {
  authentication: (): ProjectsProblem => ({
    _tag: 'ProjectsAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  conflict: (): ProjectsProblem => ({
    _tag: 'ProjectsConflictProblem',
    code: 'projects_conflict',
    detail: 'The Projects operation conflicts with the current state.',
    status: 409,
    title: 'Projects operation conflict',
    type: 'https://ontos.dev/problems/projects-conflict',
  }),
  customerIcoConflict: (): ProjectsProblem => ({
    _tag: 'ProjectsConflictProblem',
    code: 'projects_customer_ico_conflict',
    detail: 'A Customer with this IČO already exists.',
    status: 409,
    title: 'Customer IČO conflict',
    type: 'https://ontos.dev/problems/projects-customer-ico-conflict',
  }),
  forbidden: (): ProjectsProblem => ({
    _tag: 'ProjectsForbiddenProblem',
    detail: 'The principal is not permitted to perform this Projects operation.',
    status: 403,
    title: 'Projects operation forbidden',
    type: 'https://ontos.dev/problems/projects-forbidden',
  }),
  internal: (): Extract<ProjectsProblem, { readonly _tag: 'ProjectsInternalProblem' }> => ({
    _tag: 'ProjectsInternalProblem',
    detail: 'The Projects operation could not be completed.',
    status: 500,
    title: 'Projects operation failed',
    type: 'https://ontos.dev/problems/projects-failed',
  }),
  invalid: (): ProjectsProblem => ({
    _tag: 'ProjectsInvalidRequestProblem',
    detail: 'The Projects operation request is invalid.',
    status: 400,
    title: 'Invalid Projects request',
    type: 'https://ontos.dev/problems/projects-invalid',
  }),
  notFound: (): ProjectsProblem => ({
    _tag: 'ProjectsNotFoundProblem',
    detail: 'The requested Projects record was not found.',
    status: 404,
    title: 'Projects record not found',
    type: 'https://ontos.dev/problems/projects-not-found',
  }),
  precondition: (): ProjectsProblem => ({
    _tag: 'ProjectsPreconditionRequiredProblem',
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

type ProjectsActionError =
  | ActionCoreError
  | ProjectsContactNotFound
  | ProjectsCustomerIcoConflict
  | ProjectsCustomerNotFound
  | ProjectsLifecycleConflict
  | ProjectsPersistenceUnavailable;
type ProjectsCreateCustomerProblem = Exclude<
  ProjectsProblem,
  { readonly _tag: 'ProjectsNotFoundProblem' }
>;

interface ProjectsActionTransport {
  readonly correlationId: string;
  idempotencyKey?: string;
  traceId?: string;
}

const isProjectsProblem = (
  error: ProjectsActionError | ProjectsProblem,
): error is ProjectsProblem => error._tag.startsWith('Projects') && error._tag.endsWith('Problem');

const actionProblem = (error: ProjectsActionError, supportsNotFound: boolean): ProjectsProblem => {
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
      return supportsNotFound ? problem.notFound() : problem.internal();
    case 'ProjectsContactNotFound':
    case 'ProjectsCustomerNotFound':
      return problem.notFound();
    case 'ActionAlreadyCommitted':
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict':
    case 'ProjectsLifecycleConflict':
      return problem.conflict();
    case 'ProjectsCustomerIcoConflict':
      return problem.customerIcoConflict();
    case 'ActionCommitIndeterminate':
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'ProjectsPersistenceUnavailable':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
      return problem.unavailable();
    case 'ActionCollectorError':
    case 'ActionHandlerExecutionError':
    case 'ActionResultValidationError':
      return problem.internal();
    case 'ActionPolicyDenied':
      // Every Projects Action currently declares policies: []; a denial is an internal invariant breach.
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
    Effect.catch((error) => {
      if ('_tag' in error && error._tag === 'ProjectsUnavailableProblem') {
        return Effect.fail(error);
      }
      return error._tag === 'ActionPrincipalConfigurationError' ||
        error._tag === 'ActionPrincipalUnavailableError'
        ? Effect.fail(problem.unavailable())
        : failProblem(problem.authentication());
    }),
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
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
    const runtime = yield* ActionRuntime;
    const transport: ProjectsActionTransport = { correlationId };
    const idempotencyKey = headers['idempotency-key'];
    if (idempotencyKey !== undefined) {
      transport.idempotencyKey = idempotencyKey;
    }
    const traceId = requestHeaders['x-trace-id'];
    if (traceId !== undefined) {
      transport.traceId = traceId;
    }
    return yield* runtime.runAction({ payload, principal, registration, transport });
  }).pipe(
    Effect.catch((error: ProjectsActionError | ProjectsProblem) =>
      isProjectsProblem(error)
        ? Effect.fail(error)
        : failProblem(
            actionProblem(
              error,
              registration.descriptor.actionKey !== 'projects.core.create-customer',
            ),
          ),
    ),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected Projects Action BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

const foundationLive = HttpApiBuilder.group(projectsApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: ultramodernApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.projects.readiness', {
        attributes: operationAttributes(projectsOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const customerMutationsLive = HttpApiBuilder.group(projectsApi, 'customerMutations', (handlers) =>
  handlers
    .handle('createCustomer', ({ headers, payload, request }) =>
      runProjectsAction(createCustomerAction, payload, headers, request.headers).pipe(
        Effect.mapError((error): ProjectsCreateCustomerProblem =>
          error._tag === 'ProjectsNotFoundProblem' ? problem.internal() : error,
        ),
      ),
    )
    .handle('editCustomer', ({ headers, payload, request }) =>
      runProjectsAction(editCustomerAction, payload, headers, request.headers),
    )
    .handle('archiveCustomer', ({ headers, payload, request }) =>
      runProjectsAction(archiveCustomerAction, payload, headers, request.headers),
    )
    .handle('unarchiveCustomer', ({ headers, payload, request }) =>
      runProjectsAction(unarchiveCustomerAction, payload, headers, request.headers),
    ),
);

const contactMutationsLive = HttpApiBuilder.group(projectsApi, 'contactMutations', (handlers) =>
  handlers
    .handle('createContact', ({ headers, payload, request }) =>
      runProjectsAction(createContactAction, payload, headers, request.headers),
    )
    .handle('editContact', ({ headers, payload, request }) =>
      runProjectsAction(editContactAction, payload, headers, request.headers),
    )
    .handle('archiveContact', ({ headers, payload, request }) =>
      runProjectsAction(archiveContactAction, payload, headers, request.headers),
    )
    .handle('unarchiveContact', ({ headers, payload, request }) =>
      runProjectsAction(unarchiveContactAction, payload, headers, request.headers),
    ),
);

const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const readRuntimeLive = makeReadRuntimeLive(ContextAccessLive).pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const aresSubjectServiceLive = AresSubjectServiceLive.pipe(Layer.provide(FetchHttpClient.layer));
const readShellOrigin = (): string => {
  let configuredOrigin: string | undefined;
  try {
    configuredOrigin = ULTRAMODERN_SHELL_ORIGIN;
  } catch {
    configuredOrigin = undefined;
  }
  return resolveProjectsShellOrigin(configuredOrigin);
};

const shellOrigin = readShellOrigin();
export const makeProjectsApiRuntime = (
  actionRuntime: Layer.Layer<ActionRuntime>,
  readRuntime: Layer.Layer<ReadRuntime>,
  aresSubjectService: Layer.Layer<AresSubjectService> = aresSubjectServiceLive,
): EffectBffDefinition<typeof projectsApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof projectsApi, EffectRuntimeLayer> => {
  const apiHandlersLive = Layer.mergeAll(
    foundationLive,
    customerMutationsLive.pipe(Layer.provide(actionRuntime)),
    contactMutationsLive.pipe(Layer.provide(actionRuntime)),
    customerAresLookupReadApiLive.pipe(
      Layer.provide(readRuntime),
      Layer.provide(aresSubjectService),
    ),
    customerDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    customerListReadApiLive.pipe(Layer.provide(readRuntime)),
    contactDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    contactListReadApiLive.pipe(Layer.provide(readRuntime)),
  );
  const layer = HttpApiBuilder.layer(projectsApi).pipe(
    Layer.provide(apiHandlersLive),
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

const apiRuntime = makeProjectsApiRuntime(actionRuntimeLive, readRuntimeLive);

export default apiRuntime;
