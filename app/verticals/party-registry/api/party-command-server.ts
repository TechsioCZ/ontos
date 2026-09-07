import { ActionRuntime } from '@app/core-runtime';
import type { ActionRegistration, DomainEventContractMap } from '@app/core-runtime';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type { HttpServerRequest } from 'effect/unstable/http';
import { Redacted } from 'effect';
import type { Schema } from 'effect';

import { partyRegistryApi } from '../shared/api.ts';
import type {
  ResolvePartyCommandCommitPayload,
  ResolvePartyCommandCommitResult,
} from '../shared/command-api.ts';
import { ActionInvocationIdSchema } from '../shared/domain/correction-contracts.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';
import { partyCommandRegistrations } from './party-command-registrations.ts';
import {
  failPartyCommandProblem,
  isPartyCommandAuthenticationProblem,
  mapPartyActionProblem,
  partyCommandProblem,
  partyCommandSchemaErrorLive,
} from './party-command-problems.ts';
import type { PartyActionError } from './party-command-problems.ts';

const verifyPrincipal = (authorization: Redacted.Redacted<string | undefined>) =>
  authenticateOperationPrincipal(authorization, {
    authentication: partyCommandProblem.authentication,
    unavailable: partyCommandProblem.unavailable,
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
      return yield* failPartyCommandProblem(partyCommandProblem.invalid());
    }
    const principal = yield* verifyPrincipal(Redacted.make(request.headers['authorization']));
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
      return yield* failPartyCommandProblem(partyCommandProblem.precondition());
    }
    const traceId = request.headers['x-trace-id'];
    const transport =
      traceId === undefined
        ? { correlationId, idempotencyKey }
        : { correlationId, idempotencyKey, traceId };
    const runtime = yield* ActionRuntime;
    return yield* runtime
      .runAction({ payload, principal, registration, transport })
      .pipe(
        Effect.mapError(mapPartyActionProblem),
        Effect.catchIf(isPartyCommandAuthenticationProblem, failPartyCommandProblem),
      );
  },
);

export const partyRegistryCommandsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCommands',
  (handlers) =>
    handlers
      .handle('addContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.addContactPoint,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('addPartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.addPartyOfficialIdentifier,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('archiveParty', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.archiveParty,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('confirmDuplicateParties', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.confirmDuplicateParties,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('correctPartyFact', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.correctPartyFact,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('counterpartyCreate', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.counterpartyCreate,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('counterpartyRoleAdd', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.counterpartyRoleAdd,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('counterpartyRoleEnd', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.counterpartyRoleEnd,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('createParty', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.createParty,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('createPartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.createPartyRelationship,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('dismissDuplicateCandidate', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.dismissDuplicateCandidate,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('endContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.endContactPoint,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('endPartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.endPartyOfficialIdentifier,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('endPartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.endPartyRelationship,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('markDuplicateCandidateNeedsEvidence', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.markDuplicateCandidateNeedsEvidence,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('matchParty', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.matchParty,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('requestSearchRebuild', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.requestSearchRebuild,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('resolveDuplicateCandidateCreate', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.resolveDuplicateCandidateCreate,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('resolveDuplicateCandidateMatch', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.resolveDuplicateCandidateMatch,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('unarchiveParty', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.unarchiveParty,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('updateContactPoint', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.updateContactPoint,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('updateParty', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.updateParty,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('updatePartyOfficialIdentifier', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.updatePartyOfficialIdentifier,
          payload,
          headers['idempotency-key'],
          request,
        ),
      )
      .handle('updatePartyRelationship', ({ payload, headers, request }) =>
        runPartyCommand(
          partyCommandRegistrations.updatePartyRelationship,
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
      return yield* failPartyCommandProblem(partyCommandProblem.invalid());
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
            failPartyCommandProblem(partyCommandProblem.indeterminate(failure.invocationId)),
          ActionInvocationNotFound: () => failPartyCommandProblem(partyCommandProblem.notFound()),
          ActionInvocationStateError: (failure) =>
            failPartyCommandProblem(partyCommandProblem.conflict(failure.code)),
          ActionPayloadValidationError: () =>
            failPartyCommandProblem(partyCommandProblem.invalid()),
          ActionTrustedContextValidationError: () =>
            failPartyCommandProblem(partyCommandProblem.authentication()),
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
