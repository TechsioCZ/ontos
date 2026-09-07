import { ActionRuntime } from '@app/core-runtime';
import type {
  ActionCoreError,
  ActionRegistration,
  DomainEventContractMap,
} from '@app/core-runtime';
import {
  Effect,
  HttpApiBuilder,
  HttpApiMiddleware,
  HttpEffect,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type { HttpServerRequest } from 'effect/unstable/http';
import { Match, Redacted, Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
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
import type {
  PartyCommandProblem,
  ResolvePartyCommandCommitPayload,
  ResolvePartyCommandCommitResult,
} from '../shared/command-api.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';
import { ActionInvocationIdSchema } from '../shared/domain/correction-contracts.ts';
import { addContactPointAction } from '../src/actions/add-contact-point.action.ts';
import { addPartyOfficialIdentifierAction } from '../src/actions/add-party-official-identifier.action.ts';
import { archivePartyAction } from '../src/actions/archive-party.action.ts';
import { confirmDuplicatePartiesAction } from '../src/actions/confirm-duplicate-parties.action.ts';
import { correctPartyFactAction } from '../src/actions/correct-party-fact.action.ts';
import { counterpartyCreateAction } from '../src/actions/counterparty-create.action.ts';
import { counterpartyRoleAddAction } from '../src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from '../src/actions/counterparty-role-end.action.ts';
import { createPartyAction } from '../src/actions/create-party.action.ts';
import { createPartyRelationshipAction } from '../src/actions/create-party-relationship.action.ts';
import { dismissDuplicateCandidateAction } from '../src/actions/dismiss-duplicate-candidate.action.ts';
import { endContactPointAction } from '../src/actions/end-contact-point.action.ts';
import { endPartyOfficialIdentifierAction } from '../src/actions/end-party-official-identifier.action.ts';
import { endPartyRelationshipAction } from '../src/actions/end-party-relationship.action.ts';
import { markDuplicateCandidateNeedsEvidenceAction } from '../src/actions/mark-duplicate-candidate-needs-evidence.action.ts';
import { matchPartyAction } from '../src/actions/match-party.action.ts';
import { requestSearchRebuildAction } from '../src/actions/request-search-rebuild.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../src/actions/resolve-duplicate-candidate-match.action.ts';
import { unarchivePartyAction } from '../src/actions/unarchive-party.action.ts';
import { updateContactPointAction } from '../src/actions/update-contact-point.action.ts';
import { updatePartyAction } from '../src/actions/update-party.action.ts';
import { updatePartyOfficialIdentifierAction } from '../src/actions/update-party-official-identifier.action.ts';
import { updatePartyRelationshipAction } from '../src/actions/update-party-relationship.action.ts';

// This tuple derives the closed error union only. Dispatch remains explicit at every endpoint.
const commandRegistrations = [
  addContactPointAction,
  addPartyOfficialIdentifierAction,
  archivePartyAction,
  confirmDuplicatePartiesAction,
  correctPartyFactAction,
  counterpartyCreateAction,
  counterpartyRoleAddAction,
  counterpartyRoleEndAction,
  createPartyAction,
  createPartyRelationshipAction,
  dismissDuplicateCandidateAction,
  endContactPointAction,
  endPartyOfficialIdentifierAction,
  endPartyRelationshipAction,
  markDuplicateCandidateNeedsEvidenceAction,
  matchPartyAction,
  requestSearchRebuildAction,
  resolveDuplicateCandidateCreateAction,
  resolveDuplicateCandidateMatchAction,
  unarchivePartyAction,
  updateContactPointAction,
  updatePartyAction,
  updatePartyOfficialIdentifierAction,
  updatePartyRelationshipAction,
] as const;
type PartyActionError =
  | ActionCoreError
  | (typeof commandRegistrations)[number]['descriptor']['domainErrorSchema']['Type'];
type ProblemOf<Tag extends PartyCommandProblem['_tag']> = Extract<
  PartyCommandProblem,
  { readonly _tag: Tag }
>;

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

const problem = {
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
  conflict: (
    code: ProblemOf<'PartyCommandConflictProblem'>['code'],
  ): ProblemOf<'PartyCommandConflictProblem'> =>
    PartyCommandConflictProblemSchema.make({
      code,
      detail:
        'The command conflicts with the current state. Review the resource before trying again.',
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
      detail:
        'The command commit is uncertain. Resolve this invocation before considering any further command.',
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

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const isAuthenticationProblem = Schema.is(PartyCommandAuthenticationProblemSchema);
const failProblem = <Problem extends PartyCommandProblem>(mapped: Problem) =>
  (isAuthenticationProblem(mapped) ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );

const partyCommandSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  PartyCommandSchemaErrorMiddleware,
  () => Effect.fail(problem.invalid()),
);

const actionProblem = (error: PartyActionError): PartyCommandProblem =>
  Match.value(error).pipe(
    Match.tags({
      ActionAlreadyCommitted: (failure) =>
        PartyCommandAlreadyCommittedProblemSchema.make({
          code: failure.code,
          detail:
            'This command is already committed. Refresh governed reads to retrieve its outcome.',
          invocationId: ActionInvocationIdSchema.make(failure.invocationId),
          resolution: 'REFRESH_GOVERNED_READS',
          retryCommand: false,
          status: problemStatus.conflict,
          title: 'Party Registry command already committed',
          type: 'https://ontos.dev/problems/party-command-already-committed',
        }),
      ActionCollectorError: problem.internal,
      ActionCommitIndeterminate: (failure) => problem.indeterminate(failure.invocationId),
      ActionHandlerExecutionError: problem.internal,
      ActionIdempotencyKeyRequired: problem.precondition,
      ActionInvocationNotFound: problem.notFound,
      ActionInvocationPersistenceError: problem.unavailable,
      ActionInvocationStateError: (failure) => problem.conflict(failure.code),
      ActionPayloadValidationError: problem.invalid,
      ActionPermissionCheckError: problem.unavailable,
      ActionPermissionDenied: problem.forbidden,
      ActionPolicyDenied: () => problem.ineligible('action_policy_denied'),
      ActionPolicyEvaluationError: problem.unavailable,
      ActionRequestHashConflict: (failure) => problem.conflict(failure.code),
      ActionResultValidationError: problem.internal,
      ActionTransactionError: problem.unavailable,
      ActionTrustedContextValidationError: problem.authentication,
      ClaimOwnedByDifferentParty: (failure) => problem.conflict(failure.code),
      CounterpartyEvidenceInsufficient: (failure) => problem.ineligible(failure.code),
      CounterpartyNotFound: problem.notFound,
      CounterpartyPartyArchived: (failure) => problem.conflict(failure.code),
      CounterpartyPartyNotFound: problem.notFound,
      CounterpartyPersistenceUnavailable: problem.unavailable,
      CounterpartyRoleAlreadyEnded: (failure) => problem.conflict(failure.code),
      CounterpartyRoleOverlap: (failure) => problem.conflict(failure.code),
      CounterpartyRolePeriodNotFound: problem.notFound,
      CounterpartyScopeMismatch: problem.forbidden,
      CounterpartyTemporalConflict: (failure) => problem.conflict(failure.code),
      DuplicateCandidateConflict: (failure) => problem.conflict(failure.code),
      ModuleStateCheckUnavailableError: problem.unavailable,
      ModuleStateDeniedError: problem.forbidden,
      OfficialIdentifierClaimConflict: (failure) => problem.conflict(failure.code),
      OfficialIdentifierInvalid: (failure) => problem.ineligible(failure.code),
      OperationAuthenticationRequired: problem.authentication,
      OperationContextDenied: problem.forbidden,
      OperationContextInvalid: problem.forbidden,
      OperationContextUnavailable: problem.unavailable,
      PartyAliasResolutionBrokenChain: problem.unavailable,
      PartyAliasResolutionCrossTenant: problem.unavailable,
      PartyAliasResolutionCycle: problem.unavailable,
      PartyAliasResolutionUnavailable: problem.unavailable,
      PartyAliasWriteRejected: (failure) =>
        PartyCommandAliasWriteRejectedProblemSchema.make({
          aliasPartyRef: failure.aliasPartyRef,
          canonicalPartyRef: failure.canonicalPartyRef,
          code: failure.code,
          detail:
            'This Party is an alias. Review the canonical Party before issuing a new command.',
          status: problemStatus.conflict,
          title: 'Alias write rejected',
          type: 'https://ontos.dev/problems/party-alias-write-rejected',
        }),
      PartyContactPointAlreadyExists: (failure) => problem.conflict(failure.code),
      PartyContactPointCorrectionRequired: (failure) => problem.conflict(failure.code),
      PartyContactPointInvalid: (failure) => problem.ineligible(failure.code),
      PartyContactPointLifecycleConflict: (failure) => problem.conflict(failure.code),
      PartyContactPointNotFound: problem.notFound,
      PartyContactPointPartyNotFound: problem.notFound,
      PartyContactPointPersistenceUnavailable: problem.unavailable,
      PartyContactPointRevisionConflict: (failure) => problem.conflict(failure.code),
      PartyCorrectionConflict: (failure) => problem.conflict(failure.code),
      PartyEvidenceInsufficient: (failure) => problem.ineligible(failure.code),
      PartyLifecycleConflict: (failure) => problem.conflict(failure.code),
      PartyNotFound: problem.notFound,
      PartyOfficialIdentifierNotFound: problem.notFound,
      PartyOfficialIdentifierUpdateConflict: (failure) => problem.conflict(failure.code),
      PartyPersistenceUnavailable: problem.unavailable,
      PartyRelationshipCorrectionRequired: (failure) => problem.conflict(failure.code),
      PartyRelationshipEndpointNotFound: problem.notFound,
      PartyRelationshipEndpointTypeMismatch: (failure) => problem.ineligible(failure.code),
      PartyRelationshipInvalidInterval: (failure) => problem.ineligible(failure.code),
      PartyRelationshipNotFound: problem.notFound,
      PartyRelationshipOverlapConflict: (failure) => problem.conflict(failure.code),
      PartyRelationshipPersistenceUnavailable: problem.unavailable,
      PartyRelationshipRevisionConflict: (failure) => problem.conflict(failure.code),
      PartyRelationshipTypeUnsupported: (failure) => problem.ineligible(failure.code),
    }),
    Match.exhaustive,
  );

const verifyPrincipal = (authorization: Redacted.Redacted<string | undefined>) =>
  authenticateOperationPrincipal(authorization, {
    authentication: problem.authentication,
    unavailable: problem.unavailable,
  });

const runPartyCommand = Effect.fn('PartyCommandServer.runPartyCommand')(
  function* runPartyCommandEffect<
    PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
    ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
    DomainErrorSchema extends Schema.ConstraintDecoder<PartyActionError, never>,
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
    payload: Schema.Schema.Type<PayloadSchema> | Schema.Codec.Encoded<PayloadSchema>,
    idempotencyKey: string | undefined,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const correlationId = request.headers['x-correlation-id'];
    if (
      correlationId === undefined ||
      correlationId.trim().length === 0 ||
      correlationId.length > 200
    ) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(Redacted.make(request.headers['authorization']));
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
      return yield* failProblem(problem.precondition());
    }
    const traceId = request.headers['x-trace-id'];
    const transport =
      traceId === undefined
        ? { correlationId, idempotencyKey }
        : { correlationId, idempotencyKey, traceId };
    const runtime = yield* ActionRuntime;
    return yield* runtime
      .runAction({ payload, principal, registration, transport })
      .pipe(Effect.mapError(actionProblem), Effect.catchIf(isAuthenticationProblem, failProblem));
  },
);

export const partyRegistryCommandsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCommands',
  (handlers) =>
    handlers
      .handle('addContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(addContactPointAction, payload, headers['idempotency-key'], request),
      )
      .handle('addPartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(
          addPartyOfficialIdentifierAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('archiveParty', ({ payload, headers, request }) =>
        runPartyCommand(archivePartyAction, payload, headers['idempotency-key'], request),
      )
      .handle('confirmDuplicateParties', ({ payload, headers, request }) =>
        runPartyCommand(
          confirmDuplicatePartiesAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('correctPartyFact', ({ payload, headers, request }) =>
        runPartyCommand(correctPartyFactAction, payload, headers['idempotency-key'], request),
      )
      .handle('counterpartyCreate', ({ payload, headers, request }) =>
        runPartyCommand(counterpartyCreateAction, payload, headers['idempotency-key'], request),
      )
      .handle('counterpartyRoleAdd', ({ payload, headers, request }) =>
        runPartyCommand(counterpartyRoleAddAction, payload, headers['idempotency-key'], request),
      )
      .handle('counterpartyRoleEnd', ({ payload, headers, request }) =>
        runPartyCommand(counterpartyRoleEndAction, payload, headers['idempotency-key'], request),
      )
      .handle('createParty', ({ payload, headers, request }) =>
        runPartyCommand(createPartyAction, payload, headers['idempotency-key'], request),
      )
      .handle('createPartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(
          createPartyRelationshipAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('dismissDuplicateCandidate', ({ payload, headers, request }) =>
        runPartyCommand(
          dismissDuplicateCandidateAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('endContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(endContactPointAction, payload, headers['idempotency-key'], request),
      )
      .handle('endPartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(
          endPartyOfficialIdentifierAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('endPartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(endPartyRelationshipAction, payload, headers['idempotency-key'], request),
      )
      .handle('markDuplicateCandidateNeedsEvidence', ({ payload, headers, request }) =>
        runPartyCommand(
          markDuplicateCandidateNeedsEvidenceAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('matchParty', ({ payload, headers, request }) =>
        runPartyCommand(matchPartyAction, payload, headers['idempotency-key'], request),
      )
      .handle('requestSearchRebuild', ({ payload, headers, request }) =>
        runPartyCommand(requestSearchRebuildAction, payload, headers['idempotency-key'], request),
      )
      .handle('resolveDuplicateCandidateCreate', ({ payload, headers, request }) =>
        runPartyCommand(
          resolveDuplicateCandidateCreateAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('resolveDuplicateCandidateMatch', ({ payload, headers, request }) =>
        runPartyCommand(
          resolveDuplicateCandidateMatchAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('unarchiveParty', ({ payload, headers, request }) =>
        runPartyCommand(unarchivePartyAction, payload, headers['idempotency-key'], request),
      )
      .handle('updateContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(updateContactPointAction, payload, headers['idempotency-key'], request),
      )
      .handle('updateParty', ({ payload, headers, request }) =>
        runPartyCommand(updatePartyAction, payload, headers['idempotency-key'], request),
      )
      .handle('updatePartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(
          updatePartyOfficialIdentifierAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('updatePartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(
          updatePartyRelationshipAction,
          payload,
          headers['idempotency-key'],
          request,
        ),
      ),
).pipe(Layer.provide(partyCommandSchemaErrorLive));

const resolvePartyCommandCommit = Effect.fn('PartyCommandServer.resolvePartyCommandCommit')(
  function* resolvePartyCommandCommitEffect(
    payload: ResolvePartyCommandCommitPayload,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const correlationId = request.headers['x-correlation-id'];
    if (
      correlationId === undefined ||
      correlationId.trim().length === 0 ||
      correlationId.length > 200
    ) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(Redacted.make(request.headers['authorization']));
    const runtime = yield* ActionRuntime;
    return yield* runtime
      .resolveActionCommit({ invocationId: payload.invocationId, principal })
      .pipe(
        Effect.map((resolution): ResolvePartyCommandCommitResult => ({
          _tag: 'PartyCommandCommitResolution',
          invocationId: resolution.invocationId,
          retryCommand: false,
          state: 'OPEN',
        })),
        Effect.catchTag('ActionAlreadyCommitted', (committed) =>
          Effect.succeed<ResolvePartyCommandCommitResult>({
            _tag: 'PartyCommandCommitResolution',
            invocationId: ActionInvocationIdSchema.make(committed.invocationId),
            retryCommand: false,
            state: 'COMMITTED',
          }),
        ),
        Effect.catchTags({
          ActionCommitIndeterminate: (failure) =>
            failProblem(problem.indeterminate(failure.invocationId)),
          ActionInvocationNotFound: () => failProblem(problem.notFound()),
          ActionInvocationStateError: (failure) => failProblem(problem.conflict(failure.code)),
          ActionPayloadValidationError: () => failProblem(problem.invalid()),
          ActionTrustedContextValidationError: () => failProblem(problem.authentication()),
        }),
      );
  },
);

export const partyRegistryCommandRecoveryLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCommandRecovery',
  (handlers) =>
    handlers.handle('resolve', ({ payload, request }) =>
      resolvePartyCommandCommit(payload, request),
    ),
).pipe(Layer.provide(partyCommandSchemaErrorLive));
