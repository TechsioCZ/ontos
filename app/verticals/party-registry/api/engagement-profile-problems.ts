import type { ActionCoreError } from '@app/core-runtime';
import { Match, Result, Schema } from 'effect';

import type {
  EngagementProfileConflict,
  EngagementProfileNotFound,
  EngagementProfilePersistenceUnavailable,
  PartyRegistryReferenceUnavailable,
} from '../shared/domain/engagement-profile.ts';
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
import type { ContactsProblem } from '../shared/engagement-profile-api.ts';
import { failAuthenticatedProblem } from './fail-authenticated-problem.ts';

export type EngagementActionError =
  | ActionCoreError
  | EngagementProfileConflict
  | EngagementProfileNotFound
  | EngagementProfilePersistenceUnavailable
  | PartyRegistryReferenceUnavailable;
export type EngagementAttachProblem = Exclude<
  ContactsProblem,
  { readonly _tag: 'ContactsNotFoundProblem' }
>;

export const engagementProblem = {
  authentication: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsAuthenticationProblemSchema)({
        _tag: 'ContactsAuthenticationProblem',
        detail: 'A valid audience-scoped Bearer assertion is required.',
        status: 401,
        title: 'Authentication required',
        type: 'https://ontos.dev/problems/operation-authentication-required',
      })
    ),
  conflict: (
    code: Extract<
      ContactsProblem,
      { readonly _tag: 'ContactsConflictProblem' }
    >['code']
  ) =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsConflictProblemSchema)({
        _tag: 'ContactsConflictProblem',
        code,
        detail:
          'The engagement profile operation conflicts with the current state.',
        status: 409,
        title: 'Engagement profile conflict',
        type: 'https://ontos.dev/problems/contacts-engagement-conflict',
      })
    ),
  forbidden: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsForbiddenProblemSchema)({
        _tag: 'ContactsForbiddenProblem',
        detail:
          'The principal is not permitted to perform this Party Registry operation.',
        status: 403,
        title: 'Party Registry operation forbidden',
        type: 'https://ontos.dev/problems/party-registry-forbidden',
      })
    ),
  internal: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsInternalProblemSchema)({
        _tag: 'ContactsInternalProblem',
        detail: 'The engagement profile operation could not be completed.',
        status: 500,
        title: 'Engagement profile operation failed',
        type: 'https://ontos.dev/problems/party-registry-engagement-failed',
      })
    ),
  invalid: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsInvalidRequestProblemSchema)({
        _tag: 'ContactsInvalidRequestProblem',
        detail: 'The engagement profile operation request is invalid.',
        status: 400,
        title: 'Invalid engagement profile request',
        type: 'https://ontos.dev/problems/party-registry-engagement-invalid',
      })
    ),
  notFound: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsNotFoundProblemSchema)({
        _tag: 'ContactsNotFoundProblem',
        detail: 'The requested engagement profile was not found.',
        status: 404,
        title: 'Engagement profile not found',
        type: 'https://ontos.dev/problems/party-registry-engagement-not-found',
      })
    ),
  precondition: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsPreconditionRequiredProblemSchema)({
        _tag: 'ContactsPreconditionRequiredProblem',
        detail: 'An Idempotency-Key header is required.',
        status: 428,
        title: 'Idempotency key required',
        type: 'https://ontos.dev/problems/idempotency-key-required',
      })
    ),
  unavailable: () =>
    Result.getOrThrow(
      Schema.decodeResult(ContactsUnavailableProblemSchema)({
        _tag: 'ContactsUnavailableProblem',
        detail: 'The engagement profile operation is temporarily unavailable.',
        retryable: true,
        status: 503,
        title: 'Engagement profile unavailable',
        type: 'https://ontos.dev/problems/party-registry-engagement-unavailable',
      })
    ),
};

export const isEngagementAuthenticationProblem = Schema.is(
  ContactsAuthenticationProblemSchema
);
export const failEngagementProblem = <Problem extends ContactsProblem>(
  mapped: Problem
) => failAuthenticatedProblem(mapped, isEngagementAuthenticationProblem);

export const mapEngagementActionProblem = (
  error: EngagementActionError
): ContactsProblem =>
  Match.value(error).pipe(
    Match.tags({
      ActionAlreadyCommitted: () =>
        engagementProblem.conflict(
          'contacts_engagement_profile_lifecycle_conflict'
        ),
      ActionCollectorError: engagementProblem.internal,
      ActionCommitIndeterminate: engagementProblem.unavailable,
      ActionHandlerExecutionError: engagementProblem.internal,
      ActionIdempotencyKeyRequired: engagementProblem.precondition,
      ActionInvocationNotFound: engagementProblem.notFound,
      ActionInvocationPersistenceError: engagementProblem.unavailable,
      ActionInvocationStateError: () =>
        engagementProblem.conflict(
          'contacts_engagement_profile_lifecycle_conflict'
        ),
      ActionPayloadValidationError: engagementProblem.invalid,
      ActionPermissionCheckError: engagementProblem.unavailable,
      ActionPermissionDenied: engagementProblem.forbidden,
      ActionPolicyDenied: engagementProblem.internal,
      ActionPolicyEvaluationError: engagementProblem.unavailable,
      ActionRequestHashConflict: () =>
        engagementProblem.conflict(
          'contacts_engagement_profile_lifecycle_conflict'
        ),
      ActionResultValidationError: engagementProblem.internal,
      ActionTransactionError: engagementProblem.unavailable,
      ActionTrustedContextValidationError: engagementProblem.authentication,
      EngagementProfileConflict: ({ code }) => engagementProblem.conflict(code),
      EngagementProfileNotFound: engagementProblem.notFound,
      EngagementProfilePersistenceUnavailable: engagementProblem.unavailable,
      ModuleStateCheckUnavailableError: engagementProblem.unavailable,
      ModuleStateDeniedError: engagementProblem.forbidden,
      OperationAuthenticationRequired: engagementProblem.authentication,
      OperationContextDenied: engagementProblem.forbidden,
      OperationContextInvalid: engagementProblem.forbidden,
      OperationContextUnavailable: engagementProblem.unavailable,
      PartyRegistryReferenceUnavailable: engagementProblem.unavailable,
    }),
    Match.exhaustive
  );

export const mapEngagementAttachProblem = (
  error: ContactsProblem
): EngagementAttachProblem =>
  Schema.is(ContactsNotFoundProblemSchema)(error)
    ? engagementProblem.internal()
    : error;
