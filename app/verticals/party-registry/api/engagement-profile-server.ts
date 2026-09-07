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
import { Match, Redacted, Result, Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  ContactsAuthenticationProblemSchema,
  ContactsConflictProblemSchema,
  ContactsForbiddenProblemSchema,
  ContactsInternalProblemSchema,
  ContactsInvalidRequestProblemSchema,
  ContactsNotFoundProblemSchema,
  ContactsPreconditionRequiredProblemSchema,
  ContactsUnavailableProblemSchema,
} from '../shared/engagement-profile-api.ts';
import type {
  ContactsMutationHeadersSchema,
  ContactsProblem,
} from '../shared/engagement-profile-api.ts';
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
import { bindActionHttpRunner } from './action-http-runner.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';

const problem = {
  authentication: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsAuthenticationProblemSchema)({
        _tag: 'ContactsAuthenticationProblem',
        detail: 'A valid audience-scoped Bearer assertion is required.',
        status: 401,
        title: 'Authentication required',
        type: 'https://ontos.dev/problems/operation-authentication-required',
      }),
    ),
  conflict: (
    code: Extract<ContactsProblem, { readonly _tag: 'ContactsConflictProblem' }>['code'],
  ) =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsConflictProblemSchema)({
        _tag: 'ContactsConflictProblem',
        code,
        detail: 'The engagement profile operation conflicts with the current state.',
        status: 409,
        title: 'Engagement profile conflict',
        type: 'https://ontos.dev/problems/contacts-engagement-conflict',
      }),
    ),
  forbidden: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsForbiddenProblemSchema)({
        _tag: 'ContactsForbiddenProblem',
        detail: 'The principal is not permitted to perform this Party Registry operation.',
        status: 403,
        title: 'Party Registry operation forbidden',
        type: 'https://ontos.dev/problems/party-registry-forbidden',
      }),
    ),
  internal: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsInternalProblemSchema)({
        _tag: 'ContactsInternalProblem',
        detail: 'The engagement profile operation could not be completed.',
        status: 500,
        title: 'Engagement profile operation failed',
        type: 'https://ontos.dev/problems/party-registry-engagement-failed',
      }),
    ),
  invalid: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsInvalidRequestProblemSchema)({
        _tag: 'ContactsInvalidRequestProblem',
        detail: 'The engagement profile operation request is invalid.',
        status: 400,
        title: 'Invalid engagement profile request',
        type: 'https://ontos.dev/problems/party-registry-engagement-invalid',
      }),
    ),
  notFound: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsNotFoundProblemSchema)({
        _tag: 'ContactsNotFoundProblem',
        detail: 'The requested engagement profile was not found.',
        status: 404,
        title: 'Engagement profile not found',
        type: 'https://ontos.dev/problems/party-registry-engagement-not-found',
      }),
    ),
  precondition: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsPreconditionRequiredProblemSchema)({
        _tag: 'ContactsPreconditionRequiredProblem',
        detail: 'An Idempotency-Key header is required.',
        status: 428,
        title: 'Idempotency key required',
        type: 'https://ontos.dev/problems/idempotency-key-required',
      }),
    ),
  unavailable: () =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(ContactsUnavailableProblemSchema)({
        _tag: 'ContactsUnavailableProblem',
        detail: 'The engagement profile operation is temporarily unavailable.',
        retryable: true,
        status: 503,
        title: 'Engagement profile unavailable',
        type: 'https://ontos.dev/problems/party-registry-engagement-unavailable',
      }),
    ),
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const isAuthenticationProblem = Schema.is(ContactsAuthenticationProblemSchema);
const failProblem = <Problem extends ContactsProblem>(mapped: Problem) =>
  (isAuthenticationProblem(mapped) ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );

const runActionHttp = bindActionHttpRunner({
  authentication: problem.authentication,
  unavailable: problem.unavailable,
});

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

const actionProblem = (error: EngagementActionError): ContactsProblem =>
  Match.value(error).pipe(
    Match.tags({
      ActionAlreadyCommitted: () =>
        problem.conflict('contacts_engagement_profile_lifecycle_conflict'),
      ActionCollectorError: problem.internal,
      ActionCommitIndeterminate: problem.unavailable,
      ActionHandlerExecutionError: problem.internal,
      ActionIdempotencyKeyRequired: problem.precondition,
      ActionInvocationNotFound: problem.notFound,
      ActionInvocationPersistenceError: problem.unavailable,
      ActionInvocationStateError: () =>
        problem.conflict('contacts_engagement_profile_lifecycle_conflict'),
      ActionPayloadValidationError: problem.invalid,
      ActionPermissionCheckError: problem.unavailable,
      ActionPermissionDenied: problem.forbidden,
      ActionPolicyDenied: problem.internal,
      ActionPolicyEvaluationError: problem.unavailable,
      ActionRequestHashConflict: () =>
        problem.conflict('contacts_engagement_profile_lifecycle_conflict'),
      ActionResultValidationError: problem.internal,
      ActionTransactionError: problem.unavailable,
      ActionTrustedContextValidationError: problem.authentication,
      EngagementProfileConflict: ({ code }) => problem.conflict(code),
      EngagementProfileNotFound: problem.notFound,
      EngagementProfilePersistenceUnavailable: problem.unavailable,
      ModuleStateCheckUnavailableError: problem.unavailable,
      ModuleStateDeniedError: problem.forbidden,
      OperationAuthenticationRequired: problem.authentication,
      OperationContextDenied: problem.forbidden,
      OperationContextInvalid: problem.forbidden,
      OperationContextUnavailable: problem.unavailable,
      PartyRegistryReferenceUnavailable: problem.unavailable,
    }),
    Match.exhaustive,
  );

const RequestHeadersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined]),
);
type RequestHeaders = Schema.Schema.Type<typeof RequestHeadersSchema>;
type ContactsMutationHeaders = Schema.Schema.Type<typeof ContactsMutationHeadersSchema>;

const isContactsNotFoundProblem = Schema.is(ContactsNotFoundProblemSchema);
const mapAttachProblem = (error: ContactsProblem): EngagementAttachProblem =>
  isContactsNotFoundProblem(error) ? problem.internal() : error;

const attachActionProblem = (error: EngagementActionError): EngagementAttachProblem => {
  const mapped = actionProblem(error);
  return mapAttachProblem(mapped);
};

const runEngagementAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<EngagementActionError>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
  PublicProblem extends ContactsProblem,
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
  headers: ContactsMutationHeaders,
  requestHeaders: RequestHeaders,
  mapError: (error: EngagementActionError) => PublicProblem,
) =>
  runActionHttp({
    endpointHeaders: {
      idempotencyKey: headers['idempotency-key'],
      traceId: requestHeaders['x-trace-id'],
    },
    internalProblem: problem.internal,
    invalidCorrelationProblem: problem.invalid,
    mapError,
    payload,
    registration,
    requestHeaders: {
      authorization: Redacted.make(requestHeaders['authorization']),
      'x-correlation-id': requestHeaders['x-correlation-id'],
    },
  }).pipe(Effect.catchIf(isAuthenticationProblem, failProblem));

export const organizationEngagementMutationsLive = HttpApiBuilder.group(
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
          attachActionProblem,
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(
          archiveOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
          actionProblem,
        ),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(
          unarchiveOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
          actionProblem,
        ),
      ),
);

const personEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'personEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runEngagementAction(
          attachPersonEngagementAction,
          payload,
          headers,
          request.headers,
          attachActionProblem,
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(
          archivePersonEngagementAction,
          payload,
          headers,
          request.headers,
          actionProblem,
        ),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(
          unarchivePersonEngagementAction,
          payload,
          headers,
          request.headers,
          actionProblem,
        ),
      ),
);

export const engagementProfileApiHandlersLive = Layer.mergeAll(
  organizationEngagementMutationsLive,
  personEngagementMutationsLive,
  organizationEngagementProfileReadApiLive,
  personEngagementProfileReadApiLive,
);
