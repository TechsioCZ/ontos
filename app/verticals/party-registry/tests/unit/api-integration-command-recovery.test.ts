import { Effect, Match, Result, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  PartyCommandCommitIndeterminateProblemSchema,
  PartyCommandConflictProblemSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  ResolvePartyCommandCommitPayloadSchema,
  ResolvePartyCommandCommitResultSchema,
  partyRegistryCommandRecoveryApi,
  partyRegistryCommandsApi,
} from '../../shared/command-api.ts';
import { ActionInvocationIdSchema } from '../../shared/domain/correction-contracts.ts';
import {
  requestSearchRebuildWithAuthorization,
  resolvePartyCommandCommit,
  recoverPartyCreate,
} from '../../src/api/party-command-client.ts';
import { makeCommandAssertionFetch } from '../support/command-assertion-fetch.ts';

const invocationId = Schema.decodeSync(ActionInvocationIdSchema)(
  '10000000-0000-4000-8000-000000000001'
);

const recoveryProblems = [
  {
    name: 'already committed is terminal and carries the invocation for governed refresh',
    decode: Schema.decodeUnknownEffect(
      PartyCommandAlreadyCommittedProblemSchema
    ),
    is: Schema.is(PartyCommandAlreadyCommittedProblemSchema),
    problem: {
      _tag: 'PartyCommandAlreadyCommittedProblem',
      code: 'action_already_committed',
      detail: 'Refresh the authoritative governed reads.',
      invocationId,
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
      status: 409,
      title: 'Already committed',
      type: 'urn:ontos:party:already-committed',
    },
  },
  {
    name: 'commit uncertainty retains a resolution handle and never instructs blind command retry',
    decode: Schema.decodeUnknownEffect(
      PartyCommandCommitIndeterminateProblemSchema
    ),
    is: Schema.is(PartyCommandCommitIndeterminateProblemSchema),
    problem: {
      _tag: 'PartyCommandCommitIndeterminateProblem',
      detail: 'Resolve the invocation before deciding the next step.',
      invocationId,
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: 503,
      title: 'Commit outcome unknown',
      type: 'urn:ontos:party:commit-indeterminate',
    },
  },
];

for (const { name, decode, is, problem } of recoveryProblems) {
  it.effect(name, () =>
    Effect.gen(function* decodeRecoveryContract() {
      const decoded = yield* decode(problem);
      expect(is(decoded)).toBe(true);
      expect(Struct.omit(decoded, ['_tag'])).toEqual(
        Struct.omit(problem, ['_tag'])
      );
      for (const endpoint of Object.values(
        partyRegistryCommandsApi.groups.partyCommands.endpoints
      )) {
        expect(
          [...endpoint.error].some((schema) => Schema.is(schema)(problem))
        ).toBe(true);
      }
      const invalid: Effect.Effect<unknown, Schema.SchemaError> = decode({
        ...problem,
        retryCommand: true,
      });
      expect(Result.isFailure(yield* Effect.result(invalid))).toBe(true);
    })
  );
}

it('recovery rejects an invalid invocation handle', () => {
  expect(() =>
    Schema.decodeSync(ResolvePartyCommandCommitPayloadSchema)({
      invocationId: 'invalid',
    })
  ).toThrow();
});

it.effect(
  'recovery is separate from the unchanged set of explicit mutation endpoints',
  () =>
    Effect.gen(function* decodeContract3() {
      expect(
        Object.keys(partyRegistryCommandsApi.groups.partyCommands.endpoints)
          .length
      ).toBe(24);
      const endpoint =
        partyRegistryCommandRecoveryApi.groups.partyCommandRecovery.endpoints
          .resolve;
      expect(endpoint.path).toBe('/party-registry/action-commits/resolve');
      for (const state of ['OPEN', 'COMMITTED']) {
        const resolution = yield* Schema.decodeUnknownEffect(
          ResolvePartyCommandCommitResultSchema
        )({
          _tag: 'PartyCommandCommitResolution',
          invocationId,
          retryCommand: false,
          state,
        });
        expect(
          Schema.is(ResolvePartyCommandCommitResultSchema)(resolution)
        ).toBe(true);
        expect(Struct.omit(resolution, ['_tag'])).toEqual({
          invocationId,
          retryCommand: false,
          state,
        });
      }
    })
);

for (const { name, is, problem } of [
  ...recoveryProblems,
  {
    name: 'declared conflict retains its tag and stable conflict code',
    is: Schema.is(PartyCommandConflictProblemSchema),
    problem: {
      _tag: 'PartyCommandConflictProblem',
      code: 'action_request_hash_conflict',
      detail: 'This key was used with a different command payload.',
      status: 409,
      title: 'Idempotency conflict',
      type: 'urn:ontos:action:request-hash-conflict',
    },
  },
]) {
  it.effect(`command client HTTP decoding: ${name}`, () =>
    Effect.gen(function* decodeHttpProblem() {
      const fakeFetch: typeof fetch = () =>
        Promise.resolve(
          Response.json(problem, {
            headers: { 'content-type': 'application/problem+json' },
            status: problem.status,
          })
        );
      const result = yield* requestSearchRebuildWithAuthorization(
        {},
        'Bearer test',
        {
          baseUrl: 'https://party.example/party-registry-api',
          correlationId: 'problem-decoding',
          idempotencyKey: 'same-key',
        }
      ).pipe(
        Effect.result,
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) {
        return expect.unreachable('Expected HTTP problem decoding to fail');
      }
      expect(is(result.failure)).toBe(true);
      expect(Struct.omit(result.failure, ['_tag'])).toEqual(
        Struct.omit(problem, ['_tag'])
      );
    })
  );
}

it.effect(
  'recovery acquires a fresh assertion without submitting an idempotency key or re-running a command',
  () =>
    Effect.gen(function* testProgram3() {
      const { requests, assertions, fakeFetch } = makeCommandAssertionFetch(
        () =>
          Response.json({
            _tag: 'PartyCommandCommitResolution',
            invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          }),
        'fresh'
      );
      const result = yield* resolvePartyCommandCommit(
        { invocationId },
        {
          baseUrl: 'https://party.example/party-registry-api',
          correlationId: 'recovery',
          gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
          traceId: 'trace',
        }
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(result.state).toBe('COMMITTED');
      expect(assertions()).toBe(1);
      expect(requests.length).toBe(2);
      const [, request] = requests;
      expect(Boolean(request)).toBe(true);
      if (request === undefined) {
        throw new Error('Expected truthy value');
      }
      expect(request.url).toBe(
        'https://party.example/party-registry-api/party-registry/action-commits/resolve'
      );
      expect(request.headers.get('authorization')).toBe('Bearer fresh-1');
      expect(request.headers.get('idempotency-key')).toBe(null);
      expect(request.headers.get('x-correlation-id')).toBe('recovery');
      expect(request.headers.get('x-trace-id')).toBe('trace');
      expect(yield* Effect.promise(() => request.json())).toEqual({
        invocationId,
      });
    })
);

it.effect(
  'Create recovery resolves commit and returns exact original operation result with fresh read authority',
  () =>
    Effect.all(
      (['CREATED', 'MATCHED_EXISTING', 'AMBIGUOUS'] as const).map((outcome) =>
        Effect.gen(function* testProgram5() {
          const partyRef = {
            moduleId: 'party.registry',
            resourceId: invocationId,
            resourceType: 'party.registry.party',
            tenantId: invocationId,
          };
          const decisionRef = {
            ...partyRef,
            resourceType: 'party.registry.party-match-decision',
          };
          const caseRef = {
            ...partyRef,
            resourceType: 'party.registry.duplicate-candidate-case',
          };
          const { requests, assertions, fakeFetch } = makeCommandAssertionFetch(
            (request) => {
              if (request.url.endsWith('/resolve')) {
                return Response.json({
                  _tag: 'PartyCommandCommitResolution',
                  invocationId,
                  retryCommand: false,
                  state: 'COMMITTED',
                });
              }
              return Response.json({
                caseRef: outcome === 'AMBIGUOUS' ? caseRef : null,
                committedCreateOutcome: outcome,
                decidedAt: '2026-09-04T00:00:00Z',
                decisionRef,
                evidenceExplanation: [],
                matchRuleVersion: 'party-exact-claims.v1',
                operation: 'CREATE',
                outcome: outcome === 'MATCHED_EXISTING' ? 'MATCHED' : outcome,
                partyRef: outcome === 'AMBIGUOUS' ? null : partyRef,
              });
            },
            'fresh'
          );
          const recovered = yield* recoverPartyCreate(
            { invocationId },
            {
              baseUrl: 'https://party.example/party-registry-api',
              correlationId: 'recover',
              gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
            }
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
          const recoveredResult = Match.value(recovered).pipe(
            Match.tag('PartyCreateRecovered', ({ result }) => result),
            Match.tag('PartyCreateRecoveryPending', ({ resolution }) =>
              (() => {
                throw new Error(
                  `Expected committed recovery, received ${resolution.state}`
                );
              })()
            ),
            Match.exhaustive
          );
          expect(recoveredResult.outcome).toBe(outcome);
          expect(assertions()).toBe(2);
          expect(requests.length).toBe(4);
          expect(
            requests.every(
              (request) =>
                !request.url.includes('/commands/') &&
                request.headers.get('idempotency-key') === null
            )
          ).toBe(true);
        })
      )
    )
);
