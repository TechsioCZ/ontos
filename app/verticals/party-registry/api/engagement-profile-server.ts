/* eslint-disable complexity, unicorn/switch-case-braces -- The strict Effect BFF keeps complete typed error mappings visible. */
import { ActionRuntime } from '@app/core-runtime';
import type {
  ActionCoreError,
  ActionRegistration,
  DomainEventContractMap,
} from '@app/core-runtime';
import {
  Effect,
  HttpApiBuilder,
  HttpEffect,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import { Config } from 'effect';
import type { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import type { ContactsProblem } from '../shared/engagement-profile-api.ts';
import type {
  EngagementProfileConflict,
  EngagementProfileNotFound,
  EngagementProfilePersistenceUnavailable,
  PartyRegistryReferenceUnavailable,
} from '../shared/domain/engagement-profile.ts';
import { archiveOrganizationEngagementAction } from '../src/actions/archive-organization-engagement.action.ts';
import { archivePersonEngagementAction } from '../src/actions/archive-person-engagement.action.ts';
import { attachOrganizationEngagementAction } from '../src/actions/attach-organization-engagement.action.ts';
import { attachPersonEngagementAction } from '../src/actions/attach-person-engagement.action.ts';
import { unarchiveOrganizationEngagementAction } from '../src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePersonEngagementAction } from '../src/actions/unarchive-person-engagement.action.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';

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
    detail: 'The principal is not permitted to perform this Party Registry operation.',
    status: 403,
    title: 'Party Registry operation forbidden',
    type: 'https://ontos.dev/problems/party-registry-forbidden',
  }),
  internal: (): Extract<ContactsProblem, { readonly _tag: 'ContactsInternalProblem' }> => ({
    _tag: 'ContactsInternalProblem',
    detail: 'The engagement profile operation could not be completed.',
    status: 500,
    title: 'Engagement profile operation failed',
    type: 'https://ontos.dev/problems/party-registry-engagement-failed',
  }),
  invalid: (): ContactsProblem => ({
    _tag: 'ContactsInvalidRequestProblem',
    detail: 'The engagement profile operation request is invalid.',
    status: 400,
    title: 'Invalid engagement profile request',
    type: 'https://ontos.dev/problems/party-registry-engagement-invalid',
  }),
  notFound: (): ContactsProblem => ({
    _tag: 'ContactsNotFoundProblem',
    detail: 'The requested engagement profile was not found.',
    status: 404,
    title: 'Engagement profile not found',
    type: 'https://ontos.dev/problems/party-registry-engagement-not-found',
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
    detail: 'The engagement profile operation is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Engagement profile unavailable',
    type: 'https://ontos.dev/problems/party-registry-engagement-unavailable',
  }),
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const failProblem = (mapped: ContactsProblem) =>
  (mapped._tag === 'ContactsAuthenticationProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );

type EngagementActionError =
  | ActionCoreError
  | EngagementProfileConflict
  | EngagementProfileNotFound
  | EngagementProfilePersistenceUnavailable
  | PartyRegistryReferenceUnavailable;
type EngagementAttachProblem = Exclude<
  ContactsProblem,
  { readonly _tag: 'ContactsNotFoundProblem' }
>;

interface EngagementActionTransport {
  readonly correlationId: string;
  idempotencyKey?: string;
  traceId?: string;
}

const isContactsProblem = (
  error: EngagementActionError | ContactsProblem,
): error is ContactsProblem => error._tag.startsWith('Contacts') && error._tag.endsWith('Problem');

const actionProblem = (error: EngagementActionError): ContactsProblem => {
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
    Effect.flatMap((environment) => verifyOperationPrincipal(authorization, { environment })),
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

const runEngagementAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<EngagementActionError>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    never
  >,
  payload: Schema.Schema.Type<PayloadSchema>,
  headers: Readonly<Record<string, string | undefined>>,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* executeEngagementAction() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
    const runtime = yield* ActionRuntime;
    const transport: EngagementActionTransport = { correlationId };
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
    Effect.catch((error: EngagementActionError | ContactsProblem) => {
      if (isContactsProblem(error)) {
        return failProblem(error);
      }
      const mapped = actionProblem(error);
      return failProblem(mapped);
    }),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected engagement Action BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

const organizationEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'organizationEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runEngagementAction(
          attachOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
        ).pipe(
          Effect.mapError((error): EngagementAttachProblem =>
            error._tag === 'ContactsNotFoundProblem' ? problem.internal() : error,
          ),
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(archiveOrganizationEngagementAction, payload, headers, request.headers),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(
          unarchiveOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
        ),
      ),
);

const personEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'personEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runEngagementAction(attachPersonEngagementAction, payload, headers, request.headers).pipe(
          Effect.mapError((error): EngagementAttachProblem =>
            error._tag === 'ContactsNotFoundProblem' ? problem.internal() : error,
          ),
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(archivePersonEngagementAction, payload, headers, request.headers),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(unarchivePersonEngagementAction, payload, headers, request.headers),
      ),
);

export const engagementProfileApiHandlersLive = Layer.mergeAll(
  organizationEngagementMutationsLive,
  personEngagementMutationsLive,
  organizationEngagementProfileReadApiLive,
  personEngagementProfileReadApiLive,
);
