import type { ActionCoreError } from '@app/core-runtime';
import { Effect, HttpApiMiddleware } from '@modern-js/bff-effect/effect-edge';
import { Match, Schema } from 'effect';

import {
  PartyCommandAliasWriteRejectedProblemSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  PartyCommandAuthenticationProblemSchema,
  PartyCommandCommitIndeterminateProblemSchema,
  PartyCommandConflictProblemSchema,
  PartyCommandForbiddenProblemSchema,
  PartyCommandInternalProblemSchema,
  PartyCommandInvalidRequestProblemSchema,
  PartyCommandNotFoundProblemSchema,
  PartyCommandPreconditionRequiredProblemSchema,
  PartyCommandSchemaErrorMiddleware,
  PartyCommandUnavailableProblemSchema,
  PartyCommandUnprocessableProblemSchema,
} from '../shared/command-api.ts';
import type { PartyCommandProblem } from '../shared/command-api.ts';
import { ActionInvocationIdSchema } from '../shared/domain/correction-contracts.ts';
import { failAuthenticatedProblem } from './fail-authenticated-problem.ts';
import type { partyCommandRegistrations } from './party-command-registrations.ts';

export type PartyActionError =
  | ActionCoreError
  | (typeof partyCommandRegistrations)[keyof typeof partyCommandRegistrations]['descriptor']['domainErrorSchema']['Type'];
type ProblemOf<Tag extends PartyCommandProblem['_tag']> = Extract<PartyCommandProblem, { readonly _tag: Tag }>;

const problemStatus = {
  authentication: 401,
  conflict: 409,
  forbidden: 403,
  ineligible: 422,
  internal: 500,
  invalid: 400,
  notFound: 404,
  precondition: 428,
  unavailable: 503,
} as const;

export const partyCommandProblem = {
  authentication: (): ProblemOf<'PartyCommandAuthenticationProblem'> =>
    PartyCommandAuthenticationProblemSchema.make({
      detail: 'A valid audience-scoped Bearer assertion is required.',
      status: problemStatus.authentication,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/operation-authentication-required',
    }),
  invalid: (): ProblemOf<'PartyCommandInvalidRequestProblem'> =>
    PartyCommandInvalidRequestProblemSchema.make({
      detail: 'The Party Registry command request is invalid.',
      status: problemStatus.invalid,
      title: 'Invalid Party Registry request',
      type: 'https://ontos.dev/problems/party-command-invalid',
    }),
  forbidden: (): ProblemOf<'PartyCommandForbiddenProblem'> =>
    PartyCommandForbiddenProblemSchema.make({
      detail: 'The principal is not permitted to perform this Party Registry command.',
      status: problemStatus.forbidden,
      title: 'Party Registry command forbidden',
      type: 'https://ontos.dev/problems/party-command-forbidden',
    }),
  notFound: (): ProblemOf<'PartyCommandNotFoundProblem'> =>
    PartyCommandNotFoundProblemSchema.make({
      detail: 'The requested Party Registry resource was not found.',
      status: problemStatus.notFound,
      title: 'Party Registry resource not found',
      type: 'https://ontos.dev/problems/party-command-not-found',
    }),
  conflict: (code: ProblemOf<'PartyCommandConflictProblem'>['code']): ProblemOf<'PartyCommandConflictProblem'> =>
    PartyCommandConflictProblemSchema.make({
      code,
      detail: 'The command conflicts with the current state. Review the resource before trying again.',
      status: problemStatus.conflict,
      title: 'Party Registry command conflict',
      type: 'https://ontos.dev/problems/party-command-conflict',
    }),
  ineligible: (
    code: ProblemOf<'PartyCommandUnprocessableProblem'>['code'],
  ): ProblemOf<'PartyCommandUnprocessableProblem'> =>
    PartyCommandUnprocessableProblemSchema.make({
      code,
      detail: 'The command is not eligible for the requested operation.',
      status: problemStatus.ineligible,
      title: 'Party Registry command ineligible',
      type: 'https://ontos.dev/problems/party-command-ineligible',
    }),
  precondition: (): ProblemOf<'PartyCommandPreconditionRequiredProblem'> =>
    PartyCommandPreconditionRequiredProblemSchema.make({
      detail: 'An Idempotency-Key header is required.',
      status: problemStatus.precondition,
      title: 'Idempotency key required',
      type: 'https://ontos.dev/problems/idempotency-key-required',
    }),
  unavailable: (): ProblemOf<'PartyCommandUnavailableProblem'> =>
    PartyCommandUnavailableProblemSchema.make({
      detail: 'The Party Registry command capability is temporarily unavailable.',
      retryable: true,
      status: problemStatus.unavailable,
      title: 'Party Registry unavailable',
      type: 'https://ontos.dev/problems/party-command-unavailable',
    }),
  indeterminate: (invocationId: string): ProblemOf<'PartyCommandCommitIndeterminateProblem'> =>
    PartyCommandCommitIndeterminateProblemSchema.make({
      detail: 'The command commit is uncertain. Resolve this invocation before considering any further command.',
      invocationId: ActionInvocationIdSchema.make(invocationId),
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: problemStatus.unavailable,
      title: 'Party Registry command commit uncertain',
      type: 'https://ontos.dev/problems/party-command-commit-indeterminate',
    }),
  internal: (): ProblemOf<'PartyCommandInternalProblem'> =>
    PartyCommandInternalProblemSchema.make({
      detail: 'The Party Registry command could not be completed.',
      status: problemStatus.internal,
      title: 'Party Registry command failed',
      type: 'https://ontos.dev/problems/party-command-failed',
    }),
};

export const isPartyCommandAuthenticationProblem = Schema.is(PartyCommandAuthenticationProblemSchema);
export const failPartyCommandProblem = <Problem extends PartyCommandProblem>(mapped: Problem) =>
  failAuthenticatedProblem(mapped, isPartyCommandAuthenticationProblem);

export const partyCommandSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  PartyCommandSchemaErrorMiddleware,
  () => Effect.fail(partyCommandProblem.invalid()),
);

export const mapPartyActionProblem = (error: PartyActionError): PartyCommandProblem =>
  Match.value(error).pipe(
    Match.tags({
      ActionAlreadyCommitted: (failure) =>
        PartyCommandAlreadyCommittedProblemSchema.make({
          code: failure.code,
          detail: 'This command is already committed. Refresh governed reads to retrieve its outcome.',
          invocationId: ActionInvocationIdSchema.make(failure.invocationId),
          resolution: 'REFRESH_GOVERNED_READS',
          retryCommand: false,
          status: problemStatus.conflict,
          title: 'Party Registry command already committed',
          type: 'https://ontos.dev/problems/party-command-already-committed',
        }),
      ActionCollectorError: partyCommandProblem.internal,
      ActionCommitIndeterminate: (failure) => partyCommandProblem.indeterminate(failure.invocationId),
      ActionHandlerExecutionError: partyCommandProblem.internal,
      ActionIdempotencyKeyRequired: partyCommandProblem.precondition,
      ActionInvocationNotFound: partyCommandProblem.notFound,
      ActionInvocationPersistenceError: partyCommandProblem.unavailable,
      ActionInvocationStateError: (failure) => partyCommandProblem.conflict(failure.code),
      ActionPayloadValidationError: partyCommandProblem.invalid,
      ActionPermissionCheckError: partyCommandProblem.unavailable,
      ActionPermissionDenied: partyCommandProblem.forbidden,
      ActionPolicyDenied: () => partyCommandProblem.ineligible('action_policy_denied'),
      ActionPolicyEvaluationError: partyCommandProblem.unavailable,
      ActionRequestHashConflict: (failure) => partyCommandProblem.conflict(failure.code),
      ActionResultValidationError: partyCommandProblem.internal,
      ActionTransactionError: partyCommandProblem.unavailable,
      ActionTrustedContextValidationError: partyCommandProblem.authentication,
      ClaimOwnedByDifferentParty: (failure) => partyCommandProblem.conflict(failure.code),
      CounterpartyEvidenceInsufficient: (failure) => partyCommandProblem.ineligible(failure.code),
      CounterpartyNotFound: partyCommandProblem.notFound,
      CounterpartyPartyArchived: (failure) => partyCommandProblem.conflict(failure.code),
      CounterpartyPartyNotFound: partyCommandProblem.notFound,
      CounterpartyPersistenceUnavailable: partyCommandProblem.unavailable,
      CounterpartyRoleAlreadyEnded: (failure) => partyCommandProblem.conflict(failure.code),
      CounterpartyRoleOverlap: (failure) => partyCommandProblem.conflict(failure.code),
      CounterpartyRolePeriodNotFound: partyCommandProblem.notFound,
      CounterpartyScopeMismatch: partyCommandProblem.forbidden,
      CounterpartyTemporalConflict: (failure) => partyCommandProblem.conflict(failure.code),
      DuplicateCandidateConflict: (failure) => partyCommandProblem.conflict(failure.code),
      ModuleStateCheckUnavailableError: partyCommandProblem.unavailable,
      ModuleStateDeniedError: partyCommandProblem.forbidden,
      OfficialIdentifierClaimConflict: (failure) => partyCommandProblem.conflict(failure.code),
      OfficialIdentifierInvalid: (failure) => partyCommandProblem.ineligible(failure.code),
      OperationAuthenticationRequired: partyCommandProblem.authentication,
      OperationContextDenied: partyCommandProblem.forbidden,
      OperationContextInvalid: partyCommandProblem.forbidden,
      OperationContextUnavailable: partyCommandProblem.unavailable,
      PartyAliasResolutionBrokenChain: partyCommandProblem.unavailable,
      PartyAliasResolutionCrossTenant: partyCommandProblem.unavailable,
      PartyAliasResolutionCycle: partyCommandProblem.unavailable,
      PartyAliasResolutionUnavailable: partyCommandProblem.unavailable,
      PartyAliasWriteRejected: (failure) =>
        PartyCommandAliasWriteRejectedProblemSchema.make({
          aliasPartyRef: failure.aliasPartyRef,
          canonicalPartyRef: failure.canonicalPartyRef,
          code: failure.code,
          detail: 'This Party is an alias. Review the canonical Party before issuing a new command.',
          status: problemStatus.conflict,
          title: 'Alias write rejected',
          type: 'https://ontos.dev/problems/party-alias-write-rejected',
        }),
      PartyContactPointAlreadyExists: (failure) => partyCommandProblem.conflict(failure.code),
      PartyContactPointCorrectionRequired: (failure) => partyCommandProblem.conflict(failure.code),
      PartyContactPointInvalid: (failure) => partyCommandProblem.ineligible(failure.code),
      PartyContactPointLifecycleConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyContactPointNotFound: partyCommandProblem.notFound,
      PartyContactPointPartyNotFound: partyCommandProblem.notFound,
      PartyContactPointPersistenceUnavailable: partyCommandProblem.unavailable,
      PartyContactPointRevisionConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyCorrectionConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyEvidenceInsufficient: (failure) => partyCommandProblem.ineligible(failure.code),
      PartyLifecycleConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyNotFound: partyCommandProblem.notFound,
      PartyOfficialIdentifierNotFound: partyCommandProblem.notFound,
      PartyOfficialIdentifierUpdateConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyPersistenceUnavailable: partyCommandProblem.unavailable,
      PartyRelationshipCorrectionRequired: (failure) => partyCommandProblem.conflict(failure.code),
      PartyRelationshipEndpointNotFound: partyCommandProblem.notFound,
      PartyRelationshipEndpointTypeMismatch: (failure) => partyCommandProblem.ineligible(failure.code),
      PartyRelationshipInvalidInterval: (failure) => partyCommandProblem.ineligible(failure.code),
      PartyRelationshipNotFound: partyCommandProblem.notFound,
      PartyRelationshipOverlapConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyRelationshipPersistenceUnavailable: partyCommandProblem.unavailable,
      PartyRelationshipRevisionConflict: (failure) => partyCommandProblem.conflict(failure.code),
      PartyRelationshipTypeUnsupported: (failure) => partyCommandProblem.ineligible(failure.code),
    }),
    Match.exhaustive,
  );
