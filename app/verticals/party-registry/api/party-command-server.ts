import { ActionRuntime } from '@app/core-runtime';
import { decodeActionEndpointHeaders } from '@app/core-runtime/http/action-runner';
import type { ActionRegistration, DomainEventContractMap } from '@app/core-runtime';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import { partyRegistryApi } from '../shared/api.ts';
import type { ResolvePartyCommandCommitPayload, ResolvePartyCommandCommitResult } from '../shared/command-api.ts';
import { ActionInvocationIdSchema } from '../shared/domain/correction-contracts.ts';
import { bindActionHttpRunner } from './action-http-runner.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';
import {
  failPartyCommandProblem,
  isPartyCommandAuthenticationProblem,
  mapPartyActionProblem,
  partyCommandProblem,
  partyCommandSchemaErrorLive,
} from './party-command-problems.ts';
import type { PartyActionError } from './party-command-problems.ts';
import { partyCommandRegistrations } from './party-command-registrations.ts';

const verifyPrincipal = (authorization: Redacted.Redacted<string | undefined>) =>
  authenticateOperationPrincipal(authorization, {
    authentication: partyCommandProblem.authentication,
    unavailable: partyCommandProblem.unavailable,
  });

const runActionHttp = bindActionHttpRunner({
  authentication: partyCommandProblem.authentication,
  unavailable: partyCommandProblem.unavailable,
});

const runPartyCommand = Effect.fn('PartyCommandServer.runPartyCommand')(function* runPartyCommandEffect<
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<PartyActionError>,
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
  payload: PayloadSchema['Type'],
  request: HttpServerRequest.HttpServerRequest,
) {
  const correlationId = request.headers['x-correlation-id'];
  if (correlationId !== undefined && correlationId.length > 200) {
    return yield* Effect.fail(partyCommandProblem.invalid());
  }
  const endpointHeaders = yield* decodeActionEndpointHeaders(request.headers).pipe(
    Effect.mapError(partyCommandProblem.invalid),
  );
  return yield* runActionHttp<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    Requirements,
    ReturnType<typeof mapPartyActionProblem>,
    ReturnType<typeof partyCommandProblem.invalid>,
    ReturnType<typeof partyCommandProblem.internal>
  >({
    endpointHeaders,
    internalProblem: partyCommandProblem.internal,
    invalidCorrelationProblem: partyCommandProblem.invalid,
    mapError: mapPartyActionProblem,
    payload,
    registration,
    requestHeaders: {
      authorization: Redacted.make(request.headers['authorization']),
      'x-correlation-id': request.headers['x-correlation-id'],
    },
  }).pipe(Effect.catchIf(isPartyCommandAuthenticationProblem, failPartyCommandProblem));
});

const runWirePayloadPartyCommand = Effect.fn('PartyCommandServer.runWirePayloadPartyCommand')(
  function* runWirePayloadPartyCommandEffect<
    PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    DomainErrorSchema extends Schema.ConstraintDecoder<PartyActionError>,
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
    payload: PayloadSchema['Encoded'],
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const decodedPayload = yield* Schema.decodeUnknownEffect(registration.descriptor.payloadSchema)(payload).pipe(
      Effect.mapError(partyCommandProblem.invalid),
    );
    return yield* runPartyCommand<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      Requirements
    >(registration, decodedPayload, request);
  },
);

export const partyRegistryCommandsLive = HttpApiBuilder.group(partyRegistryApi, 'partyCommands', (handlers) =>
  handlers
    .handle('addContactPoint', ({ payload, request }) =>
      runWirePayloadPartyCommand(partyCommandRegistrations.addContactPoint, payload, request),
    )
    .handle('addPartyOfficialIdentifier', ({ payload, request }) =>
      runWirePayloadPartyCommand(partyCommandRegistrations.addPartyOfficialIdentifier, payload, request),
    )
    .handle('archiveParty', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.archiveParty, payload, request),
    )
    .handle('confirmDuplicateParties', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.confirmDuplicateParties, payload, request),
    )
    .handle('correctPartyFact', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.correctPartyFact, payload, request),
    )
    .handle('counterpartyCreate', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.counterpartyCreate, payload, request),
    )
    .handle('counterpartyRoleAdd', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.counterpartyRoleAdd, payload, request),
    )
    .handle('counterpartyRoleEnd', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.counterpartyRoleEnd, payload, request),
    )
    .handle('createParty', ({ payload, request }) =>
      runWirePayloadPartyCommand(partyCommandRegistrations.createParty, payload, request),
    )
    .handle('createPartyRelationship', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.createPartyRelationship, payload, request),
    )
    .handle('dismissDuplicateCandidate', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.dismissDuplicateCandidate, payload, request),
    )
    .handle('endContactPoint', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.endContactPoint, payload, request),
    )
    .handle('endPartyOfficialIdentifier', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.endPartyOfficialIdentifier, payload, request),
    )
    .handle('endPartyRelationship', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.endPartyRelationship, payload, request),
    )
    .handle('markDuplicateCandidateNeedsEvidence', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.markDuplicateCandidateNeedsEvidence, payload, request),
    )
    .handle('matchParty', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.matchParty, payload, request),
    )
    .handle('requestSearchRebuild', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.requestSearchRebuild, payload, request),
    )
    .handle('resolveDuplicateCandidateCreate', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.resolveDuplicateCandidateCreate, payload, request),
    )
    .handle('resolveDuplicateCandidateMatch', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.resolveDuplicateCandidateMatch, payload, request),
    )
    .handle('unarchiveParty', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.unarchiveParty, payload, request),
    )
    .handle('updateContactPoint', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.updateContactPoint, payload, request),
    )
    .handle('updateParty', ({ payload, request }) =>
      runWirePayloadPartyCommand(partyCommandRegistrations.updateParty, payload, request),
    )
    .handle('updatePartyOfficialIdentifier', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.updatePartyOfficialIdentifier, payload, request),
    )
    .handle('updatePartyRelationship', ({ payload, request }) =>
      runPartyCommand(partyCommandRegistrations.updatePartyRelationship, payload, request),
    ),
).pipe(Layer.provide(partyCommandSchemaErrorLive));

const resolvePartyCommandCommit = Effect.fn('PartyCommandServer.resolvePartyCommandCommit')(
  function* resolvePartyCommandCommitEffect(
    payload: ResolvePartyCommandCommitPayload,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const correlationId = request.headers['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0 || correlationId.length > 200) {
      return yield* failPartyCommandProblem(partyCommandProblem.invalid());
    }
    const principal = yield* verifyPrincipal(Redacted.make(request.headers['authorization']));
    const runtime = yield* ActionRuntime;
    return yield* runtime.resolveActionCommit({ invocationId: payload.invocationId, principal }).pipe(
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
        ActionInvocationStateError: (failure) => failPartyCommandProblem(partyCommandProblem.conflict(failure.code)),
        ActionPayloadValidationError: () => failPartyCommandProblem(partyCommandProblem.invalid()),
        ActionTrustedContextValidationError: () => failPartyCommandProblem(partyCommandProblem.authentication()),
      }),
    );
  },
);

export const partyRegistryCommandRecoveryLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCommandRecovery',
  (handlers) => handlers.handle('resolve', ({ payload, request }) => resolvePartyCommandCommit(payload, request)),
).pipe(Layer.provide(partyCommandSchemaErrorLive));
