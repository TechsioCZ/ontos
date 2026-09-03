/* eslint-disable complexity, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/switch-case-braces -- The strict Effect BFF keeps complete typed error mappings visible. */
import {
  ActionRuntime,
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  GatewayAssertionRedemptionService,
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
import { contactsApi, contactsOperationContexts } from '../shared/api.ts';
import type { ContactsProblem, OperationContext } from '../shared/api.ts';
import {
  contactsCorsAllowedHeaders,
  contactsCorsAllowedMethods,
  contactsCorsAllowedOrigins,
  resolveContactsShellOrigin,
} from '../shared/cors.ts';
import type { ContactsContactNotFound } from '../shared/apis/contact-detail.ts';
import type {
  ContactsCustomerIcoConflict,
  ContactsCustomerNotFound,
  ContactsLifecycleConflict,
  ContactsPersistenceUnavailable,
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
import { GatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';

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
  authentication: (): ContactsProblem => ({
    _tag: 'ContactsAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  conflict: (): ContactsProblem => ({
    _tag: 'ContactsConflictProblem',
    code: 'contacts_conflict',
    detail: 'The Contacts operation conflicts with the current state.',
    status: 409,
    title: 'Contacts operation conflict',
    type: 'https://ontos.dev/problems/contacts-conflict',
  }),
  customerIcoConflict: (): ContactsProblem => ({
    _tag: 'ContactsConflictProblem',
    code: 'contacts_customer_ico_conflict',
    detail: 'A Customer with this IČO already exists.',
    status: 409,
    title: 'Customer IČO conflict',
    type: 'https://ontos.dev/problems/contacts-customer-ico-conflict',
  }),
  forbidden: (): ContactsProblem => ({
    _tag: 'ContactsForbiddenProblem',
    detail: 'The principal is not permitted to perform this Contacts operation.',
    status: 403,
    title: 'Contacts operation forbidden',
    type: 'https://ontos.dev/problems/contacts-forbidden',
  }),
  internal: (): Extract<ContactsProblem, { readonly _tag: 'ContactsInternalProblem' }> => ({
    _tag: 'ContactsInternalProblem',
    detail: 'The Contacts operation could not be completed.',
    status: 500,
    title: 'Contacts operation failed',
    type: 'https://ontos.dev/problems/contacts-failed',
  }),
  invalid: (): ContactsProblem => ({
    _tag: 'ContactsInvalidRequestProblem',
    detail: 'The Contacts operation request is invalid.',
    status: 400,
    title: 'Invalid Contacts request',
    type: 'https://ontos.dev/problems/contacts-invalid',
  }),
  notFound: (): ContactsProblem => ({
    _tag: 'ContactsNotFoundProblem',
    detail: 'The requested Contacts record was not found.',
    status: 404,
    title: 'Contacts record not found',
    type: 'https://ontos.dev/problems/contacts-not-found',
  }),
  precondition: (): ContactsProblem => ({
    _tag: 'ContactsPreconditionRequiredProblem',
    detail: 'An Idempotency-Key header is required.',
    status: 428,
    title: 'Idempotency key required',
    type: 'https://ontos.dev/problems/idempotency-key-required',
  }),
  unavailable: (): ContactsProblem => ({
    _tag: 'ContactsUnavailableProblem',
    detail: 'The Contacts operation is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Contacts unavailable',
    type: 'https://ontos.dev/problems/contacts-unavailable',
  }),
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const failProblem = (mapped: ContactsProblem) =>
  (mapped._tag === 'ContactsAuthenticationProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );

type ContactsActionError =
  | ActionCoreError
  | ContactsContactNotFound
  | ContactsCustomerIcoConflict
  | ContactsCustomerNotFound
  | ContactsLifecycleConflict
  | ContactsPersistenceUnavailable;
type ContactsCreateCustomerProblem = Exclude<
  ContactsProblem,
  { readonly _tag: 'ContactsNotFoundProblem' }
>;

interface ContactsActionTransport {
  readonly correlationId: string;
  idempotencyKey?: string;
  traceId?: string;
}

const isContactsProblem = (
  error: ContactsActionError | ContactsProblem,
): error is ContactsProblem => error._tag.startsWith('Contacts') && error._tag.endsWith('Problem');

const actionProblem = (error: ContactsActionError, supportsNotFound: boolean): ContactsProblem => {
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
    case 'ContactsContactNotFound':
    case 'ContactsCustomerNotFound':
      return problem.notFound();
    case 'ActionAlreadyCommitted':
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict':
    case 'ContactsLifecycleConflict':
      return problem.conflict();
    case 'ContactsCustomerIcoConflict':
      return problem.customerIcoConflict();
    case 'ActionCommitIndeterminate':
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'ContactsPersistenceUnavailable':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
      return problem.unavailable();
    case 'ActionCollectorError':
    case 'ActionHandlerExecutionError':
    case 'ActionResultValidationError':
      return problem.internal();
    case 'ActionPolicyDenied':
      // Every Contacts Action currently declares policies: []; a denial is an internal invariant breach.
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
    Effect.flatMap((environment) =>
      GatewayAssertionRedemptionService.pipe(
        Effect.flatMap((redemption) =>
          verifyOperationPrincipal(authorization, {
            environment,
            redemption,
          }),
        ),
      ),
    ),
    Effect.catch((error) => {
      if ('_tag' in error && error._tag === 'ContactsUnavailableProblem') {
        return Effect.fail(error);
      }
      return error._tag === 'ActionPrincipalConfigurationError' ||
        error._tag === 'ActionPrincipalUnavailableError'
        ? Effect.fail(problem.unavailable())
        : failProblem(problem.authentication());
    }),
  );

const runContactsAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<ContactsActionError, never>,
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
  Effect.gen(function* executeContactsAction() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
    const runtime = yield* ActionRuntime;
    const transport: ContactsActionTransport = { correlationId };
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
    Effect.catch((error: ContactsActionError | ContactsProblem) =>
      isContactsProblem(error)
        ? Effect.fail(error)
        : failProblem(
            actionProblem(
              error,
              registration.descriptor.actionKey !== 'contacts.core.create-customer',
            ),
          ),
    ),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected Contacts Action BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

const foundationLive = HttpApiBuilder.group(contactsApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.contacts.readiness', {
        attributes: operationAttributes(contactsOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const customerMutationsLive = HttpApiBuilder.group(contactsApi, 'customerMutations', (handlers) =>
  handlers
    .handle('createCustomer', ({ headers, payload, request }) =>
      runContactsAction(createCustomerAction, payload, headers, request.headers).pipe(
        Effect.mapError((error): ContactsCreateCustomerProblem =>
          error._tag === 'ContactsNotFoundProblem' ? problem.internal() : error,
        ),
      ),
    )
    .handle('editCustomer', ({ headers, payload, request }) =>
      runContactsAction(editCustomerAction, payload, headers, request.headers),
    )
    .handle('archiveCustomer', ({ headers, payload, request }) =>
      runContactsAction(archiveCustomerAction, payload, headers, request.headers),
    )
    .handle('unarchiveCustomer', ({ headers, payload, request }) =>
      runContactsAction(unarchiveCustomerAction, payload, headers, request.headers),
    ),
);

const contactMutationsLive = HttpApiBuilder.group(contactsApi, 'contactMutations', (handlers) =>
  handlers
    .handle('createContact', ({ headers, payload, request }) =>
      runContactsAction(createContactAction, payload, headers, request.headers),
    )
    .handle('editContact', ({ headers, payload, request }) =>
      runContactsAction(editContactAction, payload, headers, request.headers),
    )
    .handle('archiveContact', ({ headers, payload, request }) =>
      runContactsAction(archiveContactAction, payload, headers, request.headers),
    )
    .handle('unarchiveContact', ({ headers, payload, request }) =>
      runContactsAction(unarchiveContactAction, payload, headers, request.headers),
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
  return resolveContactsShellOrigin(configuredOrigin);
};

const shellOrigin = readShellOrigin();
export const makeContactsApiRuntime = (
  actionRuntime: Layer.Layer<ActionRuntime>,
  readRuntime: Layer.Layer<ReadRuntime>,
  aresSubjectService: Layer.Layer<AresSubjectService> = aresSubjectServiceLive,
): EffectBffDefinition<typeof contactsApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof contactsApi, EffectRuntimeLayer> => {
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
  const layer = HttpApiBuilder.layer(contactsApi).pipe(
    Layer.provide(apiHandlersLive.pipe(Layer.provide(GatewayAssertionRedemptionLive))),
    Layer.merge(
      HttpRouter.cors({
        allowedHeaders: [...contactsCorsAllowedHeaders],
        allowedMethods: [...contactsCorsAllowedMethods],
        allowedOrigins: contactsCorsAllowedOrigins(shellOrigin),
        maxAge: 600,
      }),
    ),
  ) satisfies EffectRuntimeLayer;
  return defineEffectBff({ api: contactsApi, layer });
};

const apiRuntime = makeContactsApiRuntime(actionRuntimeLive, readRuntimeLive);

export default apiRuntime;
