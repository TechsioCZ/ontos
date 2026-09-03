/* eslint-disable complexity, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, sort-keys, unicorn/switch-case-braces -- The typed Effect Action transport deliberately keeps every closed error mapping visible. */
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
import { Config } from 'effect';
import type { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import { PartyCommandSchemaErrorMiddleware } from '../shared/command-api.ts';
import type {
  PartyCommandProblem,
  ResolvePartyCommandCommitPayload,
  ResolvePartyCommandCommitResult,
} from '../shared/command-api.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
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

interface PartyCommandTransport {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  traceId?: string;
}

const problem = {
  authentication: (): ProblemOf<'PartyCommandAuthenticationProblem'> => ({
    _tag: 'PartyCommandAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  invalid: (): ProblemOf<'PartyCommandInvalidRequestProblem'> => ({
    _tag: 'PartyCommandInvalidRequestProblem',
    detail: 'The Party Registry command request is invalid.',
    status: 400,
    title: 'Invalid Party Registry request',
    type: 'https://ontos.dev/problems/party-command-invalid',
  }),
  forbidden: (): ProblemOf<'PartyCommandForbiddenProblem'> => ({
    _tag: 'PartyCommandForbiddenProblem',
    detail: 'The principal is not permitted to perform this Party Registry command.',
    status: 403,
    title: 'Party Registry command forbidden',
    type: 'https://ontos.dev/problems/party-command-forbidden',
  }),
  notFound: (): ProblemOf<'PartyCommandNotFoundProblem'> => ({
    _tag: 'PartyCommandNotFoundProblem',
    detail: 'The requested Party Registry resource was not found.',
    status: 404,
    title: 'Party Registry resource not found',
    type: 'https://ontos.dev/problems/party-command-not-found',
  }),
  conflict: (
    code: ProblemOf<'PartyCommandConflictProblem'>['code'],
  ): ProblemOf<'PartyCommandConflictProblem'> => ({
    _tag: 'PartyCommandConflictProblem',
    code,
    detail:
      'The command conflicts with the current state. Review the resource before trying again.',
    status: 409,
    title: 'Party Registry command conflict',
    type: 'https://ontos.dev/problems/party-command-conflict',
  }),
  ineligible: (
    code: ProblemOf<'PartyCommandUnprocessableProblem'>['code'],
  ): ProblemOf<'PartyCommandUnprocessableProblem'> => ({
    _tag: 'PartyCommandUnprocessableProblem',
    code,
    detail: 'The command is not eligible for the requested operation.',
    status: 422,
    title: 'Party Registry command ineligible',
    type: 'https://ontos.dev/problems/party-command-ineligible',
  }),
  precondition: (): ProblemOf<'PartyCommandPreconditionRequiredProblem'> => ({
    _tag: 'PartyCommandPreconditionRequiredProblem',
    detail: 'An Idempotency-Key header is required.',
    status: 428,
    title: 'Idempotency key required',
    type: 'https://ontos.dev/problems/idempotency-key-required',
  }),
  unavailable: (): ProblemOf<'PartyCommandUnavailableProblem'> => ({
    _tag: 'PartyCommandUnavailableProblem',
    detail: 'The Party Registry command capability is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Party Registry unavailable',
    type: 'https://ontos.dev/problems/party-command-unavailable',
  }),
  indeterminate: (invocationId: string): ProblemOf<'PartyCommandCommitIndeterminateProblem'> => ({
    _tag: 'PartyCommandCommitIndeterminateProblem',
    detail:
      'The command commit is uncertain. Resolve this invocation before considering any further command.',
    invocationId,
    resolution: 'RESOLVE_COMMIT',
    retryCommand: false,
    status: 503,
    title: 'Party Registry command commit uncertain',
    type: 'https://ontos.dev/problems/party-command-commit-indeterminate',
  }),
  internal: (): ProblemOf<'PartyCommandInternalProblem'> => ({
    _tag: 'PartyCommandInternalProblem',
    detail: 'The Party Registry command could not be completed.',
    status: 500,
    title: 'Party Registry command failed',
    type: 'https://ontos.dev/problems/party-command-failed',
  }),
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const failProblem = <Problem extends PartyCommandProblem>(mapped: Problem) =>
  (mapped._tag === 'PartyCommandAuthenticationProblem' ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(mapped)),
  );

const partyCommandSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  PartyCommandSchemaErrorMiddleware,
  () => Effect.fail(problem.invalid()),
);

const actionProblem = (error: PartyActionError): PartyCommandProblem => {
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
    case 'CounterpartyScopeMismatch':
      return problem.forbidden();
    case 'ActionInvocationNotFound':
    case 'PartyNotFound':
    case 'PartyOfficialIdentifierNotFound':
    case 'CounterpartyNotFound':
    case 'CounterpartyPartyNotFound':
    case 'CounterpartyRolePeriodNotFound':
    case 'PartyContactPointPartyNotFound':
    case 'PartyContactPointNotFound':
    case 'PartyRelationshipNotFound':
    case 'PartyRelationshipEndpointNotFound':
      return problem.notFound();
    case 'PartyAliasWriteRejected':
      return {
        _tag: 'PartyCommandAliasWriteRejectedProblem',
        aliasPartyRef: error.aliasPartyRef,
        canonicalPartyRef: error.canonicalPartyRef,
        code: error.code,
        detail: 'This Party is an alias. Review the canonical Party before issuing a new command.',
        status: 409,
        title: 'Alias write rejected',
        type: 'https://ontos.dev/problems/party-alias-write-rejected',
      };
    case 'ActionAlreadyCommitted':
      return {
        _tag: 'PartyCommandAlreadyCommittedProblem',
        code: error.code,
        detail:
          'This command is already committed. Refresh governed reads to retrieve its outcome.',
        invocationId: error.invocationId,
        resolution: 'REFRESH_GOVERNED_READS',
        retryCommand: false,
        status: 409,
        title: 'Party Registry command already committed',
        type: 'https://ontos.dev/problems/party-command-already-committed',
      };
    case 'ActionInvocationStateError':
    case 'ActionRequestHashConflict':
    case 'PartyLifecycleConflict':
    case 'OfficialIdentifierClaimConflict':
    case 'PartyOfficialIdentifierUpdateConflict':
    case 'DuplicateCandidateConflict':
    case 'ClaimOwnedByDifferentParty':
    case 'PartyCorrectionConflict':
    case 'CounterpartyPartyArchived':
    case 'CounterpartyRoleOverlap':
    case 'CounterpartyRoleAlreadyEnded':
    case 'CounterpartyTemporalConflict':
    case 'PartyContactPointAlreadyExists':
    case 'PartyContactPointRevisionConflict':
    case 'PartyContactPointLifecycleConflict':
    case 'PartyContactPointCorrectionRequired':
    case 'PartyRelationshipOverlapConflict':
    case 'PartyRelationshipRevisionConflict':
    case 'PartyRelationshipCorrectionRequired':
      return problem.conflict(error.code);
    case 'OfficialIdentifierInvalid':
    case 'PartyEvidenceInsufficient':
    case 'CounterpartyEvidenceInsufficient':
    case 'PartyContactPointInvalid':
    case 'PartyRelationshipEndpointTypeMismatch':
    case 'PartyRelationshipTypeUnsupported':
    case 'PartyRelationshipInvalidInterval':
      return problem.ineligible(error.code);
    case 'ActionPolicyDenied':
      // All current commands declare no Policies. Any future Policy must retain Party
      // semantic-ineligibility semantics here or introduce its own explicit mapping.
      return problem.ineligible('action_policy_denied');
    case 'ActionCommitIndeterminate':
      return problem.indeterminate(error.invocationId);
    case 'ActionInvocationPersistenceError':
    case 'ActionPermissionCheckError':
    case 'ActionPolicyEvaluationError':
    case 'ActionTransactionError':
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
    case 'PartyPersistenceUnavailable':
    case 'PartyAliasResolutionBrokenChain':
    case 'PartyAliasResolutionCrossTenant':
    case 'PartyAliasResolutionCycle':
    case 'PartyAliasResolutionUnavailable':
    case 'CounterpartyPersistenceUnavailable':
    case 'PartyContactPointPersistenceUnavailable':
    case 'PartyRelationshipPersistenceUnavailable':
      return problem.unavailable();
    case 'ActionCollectorError':
    case 'ActionHandlerExecutionError':
    case 'ActionResultValidationError':
      return problem.internal();
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const verifyPrincipal = (authorization: string | undefined) =>
  // Missing credentials remain 401 even when the verifier has not been configured yet.
  authorization === undefined
    ? failProblem(problem.authentication())
    : Config.all({
        ONTOS_GATEWAY_ISSUER: Config.string('ONTOS_GATEWAY_ISSUER'),
        ONTOS_GATEWAY_PUBLIC_JWKS: Config.string('ONTOS_GATEWAY_PUBLIC_JWKS'),
      }).pipe(
        Effect.mapError(() => problem.unavailable()),
        Effect.flatMap((environment) => verifyOperationPrincipal(authorization, { environment })),
        Effect.catch(
          (
            error,
          ): Effect.Effect<
            never,
            | ProblemOf<'PartyCommandUnavailableProblem'>
            | ProblemOf<'PartyCommandAuthenticationProblem'>,
            HttpServerRequest.HttpServerRequest
          > =>
            error._tag === 'PartyCommandUnavailableProblem' ||
            error._tag === 'ActionPrincipalConfigurationError' ||
            error._tag === 'ActionPrincipalUnavailableError'
              ? Effect.fail(problem.unavailable())
              : failProblem(problem.authentication()),
        ),
      );

const isCommandProblem = (
  error: PartyActionError | PartyCommandProblem,
): error is PartyCommandProblem => error._tag.startsWith('PartyCommand');

const runPartyCommand = <
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
  payload: Schema.Schema.Type<PayloadSchema>,
  headers: Readonly<Record<string, string | undefined>>,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* executePartyCommand() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (
      correlationId === undefined ||
      correlationId.trim().length === 0 ||
      correlationId.length > 200
    ) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
    const idempotencyKey = headers['idempotency-key'];
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
      return yield* failProblem(problem.precondition());
    }
    const transport: PartyCommandTransport = {
      correlationId,
      idempotencyKey,
    };
    const traceId = requestHeaders['x-trace-id'];
    if (traceId !== undefined) {
      transport.traceId = traceId;
    }
    const runtime = yield* ActionRuntime;
    return yield* runtime.runAction({ payload, principal, registration, transport });
  }).pipe(
    Effect.catch((error: PartyActionError | PartyCommandProblem) => {
      if (isCommandProblem(error)) {
        return Effect.fail(error);
      }
      const mapped = actionProblem(error);
      return failProblem(mapped);
    }),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(Effect.logError('Unexpected Party Registry command BFF defect', defect), {
        actionKey: registration.descriptor.actionKey,
        correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable',
      }).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

export const partyRegistryCommandsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCommands',
  (handlers) =>
    handlers
      .handle('addContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(addContactPointAction, payload, headers, request.headers),
      )
      .handle('addPartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(addPartyOfficialIdentifierAction, payload, headers, request.headers),
      )
      .handle('archiveParty', ({ payload, headers, request }) =>
        runPartyCommand(archivePartyAction, payload, headers, request.headers),
      )
      .handle('confirmDuplicateParties', ({ payload, headers, request }) =>
        runPartyCommand(confirmDuplicatePartiesAction, payload, headers, request.headers),
      )
      .handle('correctPartyFact', ({ payload, headers, request }) =>
        runPartyCommand(correctPartyFactAction, payload, headers, request.headers),
      )
      .handle('counterpartyCreate', ({ payload, headers, request }) =>
        runPartyCommand(counterpartyCreateAction, payload, headers, request.headers),
      )
      .handle('counterpartyRoleAdd', ({ payload, headers, request }) =>
        runPartyCommand(counterpartyRoleAddAction, payload, headers, request.headers),
      )
      .handle('counterpartyRoleEnd', ({ payload, headers, request }) =>
        runPartyCommand(counterpartyRoleEndAction, payload, headers, request.headers),
      )
      .handle('createParty', ({ payload, headers, request }) =>
        runPartyCommand(createPartyAction, payload, headers, request.headers),
      )
      .handle('createPartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(createPartyRelationshipAction, payload, headers, request.headers),
      )
      .handle('dismissDuplicateCandidate', ({ payload, headers, request }) =>
        runPartyCommand(dismissDuplicateCandidateAction, payload, headers, request.headers),
      )
      .handle('endContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(endContactPointAction, payload, headers, request.headers),
      )
      .handle('endPartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(endPartyOfficialIdentifierAction, payload, headers, request.headers),
      )
      .handle('endPartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(endPartyRelationshipAction, payload, headers, request.headers),
      )
      .handle('markDuplicateCandidateNeedsEvidence', ({ payload, headers, request }) =>
        runPartyCommand(
          markDuplicateCandidateNeedsEvidenceAction,
          payload,
          headers,
          request.headers,
        ),
      )
      .handle('matchParty', ({ payload, headers, request }) =>
        runPartyCommand(matchPartyAction, payload, headers, request.headers),
      )
      .handle('requestSearchRebuild', ({ payload, headers, request }) =>
        runPartyCommand(requestSearchRebuildAction, payload, headers, request.headers),
      )
      .handle('resolveDuplicateCandidateCreate', ({ payload, headers, request }) =>
        runPartyCommand(resolveDuplicateCandidateCreateAction, payload, headers, request.headers),
      )
      .handle('resolveDuplicateCandidateMatch', ({ payload, headers, request }) =>
        runPartyCommand(resolveDuplicateCandidateMatchAction, payload, headers, request.headers),
      )
      .handle('unarchiveParty', ({ payload, headers, request }) =>
        runPartyCommand(unarchivePartyAction, payload, headers, request.headers),
      )
      .handle('updateContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(updateContactPointAction, payload, headers, request.headers),
      )
      .handle('updateParty', ({ payload, headers, request }) =>
        runPartyCommand(updatePartyAction, payload, headers, request.headers),
      )
      .handle('updatePartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(updatePartyOfficialIdentifierAction, payload, headers, request.headers),
      )
      .handle('updatePartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(updatePartyRelationshipAction, payload, headers, request.headers),
      ),
).pipe(Layer.provide(partyCommandSchemaErrorLive));

const resolvePartyCommandCommit = (
  payload: ResolvePartyCommandCommitPayload,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* resolvePartyCommandCommitEffect() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (
      correlationId === undefined ||
      correlationId.trim().length === 0 ||
      correlationId.length > 200
    ) {
      return yield* failProblem(problem.invalid());
    }
    const principal = yield* verifyPrincipal(requestHeaders['authorization']);
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
            invocationId: committed.invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          }),
        ),
      );
  }).pipe(
    Effect.catch(
      (
        error,
      ): Effect.Effect<
        never,
        ProblemOf<
          | 'PartyCommandCommitIndeterminateProblem'
          | 'PartyCommandNotFoundProblem'
          | 'PartyCommandConflictProblem'
          | 'PartyCommandInvalidRequestProblem'
          | 'PartyCommandAuthenticationProblem'
          | 'PartyCommandUnavailableProblem'
        >,
        HttpServerRequest.HttpServerRequest
      > => {
        switch (error._tag) {
          case 'ActionCommitIndeterminate':
            return failProblem(problem.indeterminate(error.invocationId));
          case 'ActionInvocationNotFound':
            return failProblem(problem.notFound());
          case 'ActionInvocationStateError':
            return failProblem(problem.conflict(error.code));
          case 'ActionPayloadValidationError':
            return failProblem(problem.invalid());
          case 'ActionTrustedContextValidationError':
            return failProblem(problem.authentication());
          case 'PartyCommandAuthenticationProblem':
          case 'PartyCommandUnavailableProblem':
          case 'PartyCommandInvalidRequestProblem':
            return Effect.fail(error);
          default: {
            const exhaustive: never = error;
            return exhaustive;
          }
        }
      },
    ),
    Effect.catchDefect((defect) =>
      Effect.annotateLogs(
        Effect.logError('Unexpected Party Registry commit-resolution BFF defect', defect),
        { correlationId: requestHeaders['x-correlation-id'] ?? 'unavailable' },
      ).pipe(Effect.andThen(Effect.fail(problem.internal()))),
    ),
  );

export const partyRegistryCommandRecoveryLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCommandRecovery',
  (handlers) =>
    handlers.handle('resolve', ({ payload, request }) =>
      resolvePartyCommandCommit(payload, request.headers),
    ),
).pipe(Layer.provide(partyCommandSchemaErrorLive));
