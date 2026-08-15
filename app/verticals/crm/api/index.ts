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
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { crmApi, crmOperationContexts } from '../shared/api.ts';
import type { CrmProblem, OperationContext } from '../shared/api.ts';
import {
  crmCorsAllowedHeaders,
  crmCorsAllowedMethods,
  crmCorsAllowedOrigins,
} from '../shared/cors.ts';
import type { CrmContactNotFound } from '../shared/apis/contact-detail.ts';
import type {
  CrmCustomerNotFound,
  CrmLifecycleConflict,
  CrmPersistenceUnavailable,
} from '../shared/apis/customer-detail.ts';
import { archiveContactAction } from '../src/actions/archive-contact.action.ts';
import { archiveCustomerAction } from '../src/actions/archive-customer.action.ts';
import { createContactAction } from '../src/actions/create-contact.action.ts';
import { createCustomerAction } from '../src/actions/create-customer.action.ts';
import { editContactAction } from '../src/actions/edit-contact.action.ts';
import { editCustomerAction } from '../src/actions/edit-customer.action.ts';
import { unarchiveContactAction } from '../src/actions/unarchive-contact.action.ts';
import { unarchiveCustomerAction } from '../src/actions/unarchive-customer.action.ts';
import { contactDetailReadApiLive } from './contact-detail-read-server.ts';
import { contactListReadApiLive } from './contact-list-read-server.ts';
import { customerDetailReadApiLive } from './customer-detail-read-server.ts';
import { customerListReadApiLive } from './customer-list-read-server.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
  ...(typeof operationContext.traceId === 'string'
    ? { 'modernjs.trace.id': operationContext.traceId }
    : {}),
});

const problem = {
  authentication: (): CrmProblem => ({
    _tag: 'CrmAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  conflict: (): CrmProblem => ({
    _tag: 'CrmConflictProblem',
    detail: 'The CRM operation conflicts with the current state.',
    status: 409,
    title: 'CRM operation conflict',
    type: 'https://ontos.dev/problems/crm-conflict',
  }),
  forbidden: (): CrmProblem => ({
    _tag: 'CrmForbiddenProblem',
    detail: 'The principal is not permitted to perform this CRM operation.',
    status: 403,
    title: 'CRM operation forbidden',
    type: 'https://ontos.dev/problems/crm-forbidden',
  }),
  internal: (): CrmProblem => ({
    _tag: 'CrmInternalProblem',
    detail: 'The CRM operation could not be completed.',
    status: 500,
    title: 'CRM operation failed',
    type: 'https://ontos.dev/problems/crm-failed',
  }),
  invalid: (): CrmProblem => ({
    _tag: 'CrmInvalidRequestProblem',
    detail: 'The CRM operation request is invalid.',
    status: 400,
    title: 'Invalid CRM request',
    type: 'https://ontos.dev/problems/crm-invalid',
  }),
  notFound: (): CrmProblem => ({
    _tag: 'CrmNotFoundProblem',
    detail: 'The requested CRM record was not found.',
    status: 404,
    title: 'CRM record not found',
    type: 'https://ontos.dev/problems/crm-not-found',
  }),
  precondition: (): CrmProblem => ({
    _tag: 'CrmPreconditionRequiredProblem',
    detail: 'An Idempotency-Key header is required.',
    status: 428,
    title: 'Idempotency key required',
    type: 'https://ontos.dev/problems/idempotency-key-required',
  }),
  unavailable: (): CrmProblem => ({
    _tag: 'CrmUnavailableProblem',
    detail: 'The CRM operation is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'CRM unavailable',
    type: 'https://ontos.dev/problems/crm-unavailable',
  }),
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const failProblem = (mapped: CrmProblem) =>
  (mapped._tag === 'CrmAuthenticationProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );

type CrmActionError =
  | ActionCoreError
  | CrmContactNotFound
  | CrmCustomerNotFound
  | CrmLifecycleConflict
  | CrmPersistenceUnavailable;
type CrmCreateCustomerProblem = Exclude<CrmProblem, { readonly _tag: 'CrmNotFoundProblem' }>;

const actionProblem = (error: CrmActionError, supportsNotFound: boolean): CrmProblem => {
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
    case 'CrmContactNotFound':
    case 'CrmCustomerNotFound':
      return problem.notFound();
    case 'ActionAlreadyCommitted':
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict':
    case 'CrmLifecycleConflict':
      return problem.conflict();
    case 'ActionCommitIndeterminate':
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'CrmPersistenceUnavailable':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
      return problem.unavailable();
    case 'ActionCollectorError':
    case 'ActionHandlerExecutionError':
    case 'ActionResultValidationError':
      return problem.internal();
    case 'ActionPolicyDenied':
      // Every CRM Action currently declares policies: []; a denial is an internal invariant breach.
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
      if ('_tag' in error && error._tag === 'CrmUnavailableProblem') {
        return Effect.fail(error);
      }
      return error._tag === 'ActionPrincipalConfigurationError' ||
        error._tag === 'ActionPrincipalUnavailableError'
        ? Effect.fail(problem.unavailable())
        : failProblem(problem.authentication());
    }),
  );

const runCrmAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
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
  payload: unknown,
  headers: Readonly<Record<string, string | undefined>>,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* executeCrmAction() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
    const runtime = yield* ActionRuntime;
    return yield* runtime.runAction({
      payload,
      principal,
      registration,
      transport: {
        correlationId,
        ...(headers['idempotency-key'] === undefined
          ? {}
          : { idempotencyKey: headers['idempotency-key'] }),
        ...(requestHeaders['x-trace-id'] === undefined
          ? {}
          : { traceId: requestHeaders['x-trace-id'] }),
      },
    });
  }).pipe(
    Effect.catch((error) =>
      '_tag' in error && error._tag.startsWith('Crm') && error._tag.endsWith('Problem')
        ? Effect.fail(error as CrmProblem)
        : failProblem(
            actionProblem(
              error as CrmActionError,
              registration.descriptor.actionKey !== 'crm.core.create-customer',
            ),
          ),
    ),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected CRM Action BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

const foundationLive = HttpApiBuilder.group(crmApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.crm.readiness', {
        attributes: operationAttributes(crmOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const customerMutationsLive = HttpApiBuilder.group(crmApi, 'customerMutations', (handlers) =>
  handlers
    .handle('createCustomer', ({ headers, payload, request }) =>
      runCrmAction(createCustomerAction, payload, headers, request.headers).pipe(
        Effect.mapError(
          (error): CrmCreateCustomerProblem =>
            error._tag === 'CrmNotFoundProblem'
              ? (problem.internal() as CrmCreateCustomerProblem)
              : error,
        ),
      ),
    )
    .handle('editCustomer', ({ headers, payload, request }) =>
      runCrmAction(editCustomerAction, payload, headers, request.headers),
    )
    .handle('archiveCustomer', ({ headers, payload, request }) =>
      runCrmAction(archiveCustomerAction, payload, headers, request.headers),
    )
    .handle('unarchiveCustomer', ({ headers, payload, request }) =>
      runCrmAction(unarchiveCustomerAction, payload, headers, request.headers),
    ),
);

const contactMutationsLive = HttpApiBuilder.group(crmApi, 'contactMutations', (handlers) =>
  handlers
    .handle('createContact', ({ headers, payload, request }) =>
      runCrmAction(createContactAction, payload, headers, request.headers),
    )
    .handle('editContact', ({ headers, payload, request }) =>
      runCrmAction(editContactAction, payload, headers, request.headers),
    )
    .handle('archiveContact', ({ headers, payload, request }) =>
      runCrmAction(archiveContactAction, payload, headers, request.headers),
    )
    .handle('unarchiveContact', ({ headers, payload, request }) =>
      runCrmAction(unarchiveContactAction, payload, headers, request.headers),
    ),
);

const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const readRuntimeLive = makeReadRuntimeLive(ContextAccessLive).pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const shellOrigin =
  typeof ULTRAMODERN_SHELL_ORIGIN === 'string' ? ULTRAMODERN_SHELL_ORIGIN : 'http://localhost:3020';
export const makeCrmApiRuntime = (
  actionRuntime: Layer.Layer<ActionRuntime>,
  readRuntime: Layer.Layer<ReadRuntime>,
): EffectBffDefinition<typeof crmApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof crmApi, EffectRuntimeLayer> => {
  const apiHandlersLive = Layer.mergeAll(
    foundationLive,
    customerMutationsLive.pipe(Layer.provide(actionRuntime)),
    contactMutationsLive.pipe(Layer.provide(actionRuntime)),
    customerDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    customerListReadApiLive.pipe(Layer.provide(readRuntime)),
    contactDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    contactListReadApiLive.pipe(Layer.provide(readRuntime)),
  );
  const layer = HttpApiBuilder.layer(crmApi).pipe(
    Layer.provide(apiHandlersLive),
    Layer.merge(
      HttpRouter.cors({
        allowedHeaders: [...crmCorsAllowedHeaders],
        allowedMethods: [...crmCorsAllowedMethods],
        allowedOrigins: crmCorsAllowedOrigins(shellOrigin),
        maxAge: 600,
      }),
    ),
  ) satisfies EffectRuntimeLayer;
  return defineEffectBff({ api: crmApi, layer });
};

const apiRuntime = makeCrmApiRuntime(actionRuntimeLive, readRuntimeLive);

export default apiRuntime;
