/* eslint-disable complexity, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/switch-case-braces -- The strict Effect BFF keeps complete typed error mappings visible. */
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ActionRuntime,
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  loadDatabaseConfig,
  GatewayAssertionRedemptionService,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
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
import { Config, ConfigProvider } from 'effect';
import type { Schema } from 'effect';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { contactsApi, contactsOperationContexts } from '../shared/api.ts';
import type { ContactsProblem, OperationContext } from '../shared/api.ts';
import type {
  EngagementProfileConflict,
  EngagementProfileNotFound,
  EngagementProfilePersistenceUnavailable,
  PartyRegistryReferenceUnavailable,
} from '../shared/domain/engagement-profile.ts';
import {
  contactsCorsAllowedHeaders,
  contactsCorsAllowedMethods,
  contactsCorsAllowedOrigins,
  resolveContactsShellOrigin,
} from '../shared/cors.ts';
import { archiveOrganizationEngagementAction } from '../src/actions/archive-organization-engagement.action.ts';
import { archivePersonEngagementAction } from '../src/actions/archive-person-engagement.action.ts';
import { attachOrganizationEngagementAction } from '../src/actions/attach-organization-engagement.action.ts';
import { attachPersonEngagementAction } from '../src/actions/attach-person-engagement.action.ts';
import { unarchiveOrganizationEngagementAction } from '../src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePersonEngagementAction } from '../src/actions/unarchive-person-engagement.action.ts';
import { PartyRegistryReferenceValidationLive } from '../src/integrations/party-registry/reference-validation.gateway.ts';
import { PartyRegistryReferenceRequest } from '../src/integrations/party-registry/reference-validation-request.ts';
import type { PartyRegistryReferenceRequestOptions } from '../src/integrations/party-registry/reference-validation-request.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
import { ContactsDatabaseLive } from '../src/db/client.ts';

interface OperationSpanAttributes extends Readonly<Record<string, string | undefined>> {
  'modernjs.operation.id': string;
  'modernjs.operation.method': string;
  'modernjs.operation.route': string;
  'modernjs.operation.source': string;
  'modernjs.trace.id'?: string;
}

const operationAttributes = (operationContext: OperationContext) => {
  const attributes: OperationSpanAttributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  if (operationContext.traceId !== undefined) {
    attributes['modernjs.trace.id'] = operationContext.traceId;
  }
  return attributes;
};

const problem = {
  authentication: (): ContactsProblem => ({
    _tag: 'ContactsAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  conflict: (
    code: Extract<ContactsProblem, { readonly _tag: 'ContactsConflictProblem' }>['code'],
  ): ContactsProblem => ({
    _tag: 'ContactsConflictProblem',
    code,
    detail: 'The engagement profile operation conflicts with the current state.',
    status: 409,
    title: 'Engagement profile conflict',
    type: 'https://ontos.dev/problems/contacts-engagement-conflict',
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
    detail: 'The requested engagement profile was not found.',
    status: 404,
    title: 'Engagement profile not found',
    type: 'https://ontos.dev/problems/contacts-engagement-not-found',
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
  | EngagementProfileConflict
  | EngagementProfileNotFound
  | EngagementProfilePersistenceUnavailable
  | PartyRegistryReferenceUnavailable;
type ContactsAttachProblem = Exclude<ContactsProblem, { readonly _tag: 'ContactsNotFoundProblem' }>;

interface ContactsActionTransport {
  readonly correlationId: string;
  idempotencyKey?: string;
  traceId?: string;
}

const isContactsProblem = (
  error: ContactsActionError | ContactsProblem,
): error is ContactsProblem => error._tag.startsWith('Contacts') && error._tag.endsWith('Problem');

const actionProblem = (error: ContactsActionError): ContactsProblem => {
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
    case 'EngagementProfileNotFound':
      return problem.notFound();
    case 'ActionAlreadyCommitted':
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict':
      return problem.conflict('contacts_engagement_profile_lifecycle_conflict');
    case 'EngagementProfileConflict':
      return problem.conflict(error.code);
    case 'ActionCommitIndeterminate':
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'EngagementProfilePersistenceUnavailable':
    case 'PartyRegistryReferenceUnavailable':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
      return problem.unavailable();
    case 'ActionCollectorError':
    case 'ActionHandlerExecutionError':
    case 'ActionResultValidationError':
    case 'ActionPolicyDenied':
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
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<ContactsActionError>,
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
    Effect.catch((error: ContactsActionError | ContactsProblem) => {
      if (isContactsProblem(error)) {
        return Effect.fail(error);
      }
      const mapped = actionProblem(error);
      return failProblem(mapped);
    }),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected Contacts Action BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

const referenceValidationForRequest = (
  requestHeaders: Readonly<Record<string, string | undefined>>,
) => {
  const correlationId = requestHeaders['x-correlation-id'] ?? '';
  const gatewayOptions: PartyRegistryReferenceRequestOptions =
    requestHeaders['cookie'] === undefined
      ? { correlationId }
      : { cookie: requestHeaders['cookie'], correlationId };
  return gatewayOptions;
};

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

const organizationEngagementMutationsLive = HttpApiBuilder.group(
  contactsApi,
  'organizationEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runContactsAction(
          attachOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
        ).pipe(
          Effect.provideService(
            PartyRegistryReferenceRequest,
            referenceValidationForRequest(request.headers),
          ),
          Effect.mapError((error): ContactsAttachProblem =>
            error._tag === 'ContactsNotFoundProblem' ? problem.internal() : error,
          ),
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runContactsAction(archiveOrganizationEngagementAction, payload, headers, request.headers),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runContactsAction(unarchiveOrganizationEngagementAction, payload, headers, request.headers),
      ),
);

const personEngagementMutationsLive = HttpApiBuilder.group(
  contactsApi,
  'personEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runContactsAction(attachPersonEngagementAction, payload, headers, request.headers).pipe(
          Effect.provideService(
            PartyRegistryReferenceRequest,
            referenceValidationForRequest(request.headers),
          ),
          Effect.mapError((error): ContactsAttachProblem =>
            error._tag === 'ContactsNotFoundProblem' ? problem.internal() : error,
          ),
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runContactsAction(archivePersonEngagementAction, payload, headers, request.headers),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runContactsAction(unarchivePersonEngagementAction, payload, headers, request.headers),
      ),
);

const contactsDatabaseLive = ContactsDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
);
const gatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(contactsDatabaseLive),
  Layer.orDie,
);

const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const moduleStateLive = ModuleStateGateLive.pipe(
  Layer.provideMerge(tenantModuleStateServiceLive),
  Layer.orDie,
);
const runtimeServicesLive = Layer.mergeAll(
  ModuleEntrypointGatewayLive,
  OperationalScopeResolverLive,
).pipe(
  Layer.provideMerge(ContextAccessLive),
  Layer.provideMerge(moduleStateLive),
  Layer.provideMerge(CorePersistenceLive),
  Layer.orDie,
);
const actionRuntimeLive = ActionRuntimeLive.pipe(
  Layer.provide([ActionRepositoryLive, ActionPermissionLive, runtimeServicesLive]),
  Layer.orDie,
);
const readRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(runtimeServicesLive), Layer.orDie);
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
  configuration: Layer.Layer<never> = ConfigProvider.layer(ConfigProvider.fromEnv()),
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService> = gatewayAssertionRedemptionLive,
): EffectBffDefinition<typeof contactsApi> & EffectBffRuntime<typeof contactsApi> => {
  const apiHandlersLive = Layer.mergeAll(
    foundationLive,
    organizationEngagementMutationsLive.pipe(
      Layer.provide(actionRuntime),
      Layer.provide(PartyRegistryReferenceValidationLive),
    ),
    personEngagementMutationsLive.pipe(
      Layer.provide(actionRuntime),
      Layer.provide(PartyRegistryReferenceValidationLive),
    ),
    organizationEngagementProfileReadApiLive.pipe(Layer.provide(readRuntime)),
    personEngagementProfileReadApiLive.pipe(Layer.provide(readRuntime)),
  );
  const layer = HttpApiBuilder.layer(contactsApi).pipe(
    Layer.provide(
      apiHandlersLive.pipe(Layer.provide(gatewayAssertionRedemption), Layer.provide(configuration)),
    ),
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

export default makeContactsApiRuntime(actionRuntimeLive, readRuntimeLive);
