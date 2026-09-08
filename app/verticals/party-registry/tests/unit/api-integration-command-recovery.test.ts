import { expect, it } from 'effect-rstest';
import { Effect, Match, Result, Schema, Struct } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  PartyCommandCommitIndeterminateProblemSchema,
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

const invocationId = Schema.decodeUnknownSync(ActionInvocationIdSchema)(
  '10000000-0000-4000-8000-000000000001',
);

it.effect('already committed is terminal and carries the invocation for governed refresh', () =>
  Effect.gen(function* decodeContract1() {
    const problem = {
      _tag: 'PartyCommandAlreadyCommittedProblem',
      code: 'action_already_committed',
      detail: 'Refresh the authoritative governed reads.',
      invocationId,
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
      status: 409,
      title: 'Already committed',
      type: 'urn:ontos:party:already-committed',
    };
    const decodedProblem = yield* Schema.decodeUnknownEffect(
      PartyCommandAlreadyCommittedProblemSchema,
    )(problem);
    expect(Schema.is(PartyCommandAlreadyCommittedProblemSchema)(decodedProblem)).toBe(true);
    expect(Struct.omit(decodedProblem, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
    for (const endpoint of Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints)) {
      expect([...endpoint.error].some((schema) => Schema.is(schema)(problem))).toBe(true);
    }
    expect(() =>
      Schema.decodeUnknownSync(PartyCommandAlreadyCommittedProblemSchema)({
        ...problem,
        retryCommand: true,
      }),
    ).toThrow();
  }),
);

it.effect(
  'commit uncertainty retains a resolution handle and never instructs blind command retry',
  () =>
    Effect.gen(function* decodeContract2() {
      const problem = {
        _tag: 'PartyCommandCommitIndeterminateProblem',
        detail: 'Resolve the invocation before deciding the next step.',
        invocationId,
        resolution: 'RESOLVE_COMMIT',
        retryCommand: false,
        status: 503,
        title: 'Commit outcome unknown',
        type: 'urn:ontos:party:commit-indeterminate',
      };
      const decodedProblem = yield* Schema.decodeUnknownEffect(
        PartyCommandCommitIndeterminateProblemSchema,
      )(problem);
      expect(Schema.is(PartyCommandCommitIndeterminateProblemSchema)(decodedProblem)).toBe(true);
      expect(Struct.omit(decodedProblem, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
      for (const endpoint of Object.values(
        partyRegistryCommandsApi.groups.partyCommands.endpoints,
      )) {
        expect([...endpoint.error].some((schema) => Schema.is(schema)(problem))).toBe(true);
      }
      expect(() =>
        Schema.decodeUnknownSync(PartyCommandCommitIndeterminateProblemSchema)({
          ...problem,
          retryCommand: true,
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(ResolvePartyCommandCommitPayloadSchema)({
          invocationId: 'invalid',
        }),
      ).toThrow();
    }),
);

it.effect('recovery is separate from the unchanged set of explicit mutation endpoints', () =>
  Effect.gen(function* decodeContract3() {
    expect(Object.keys(partyRegistryCommandsApi.groups.partyCommands.endpoints).length).toBe(24);
    const endpoint = partyRegistryCommandRecoveryApi.groups.partyCommandRecovery.endpoints.resolve;
    expect(endpoint.path).toBe('/party-registry/action-commits/resolve');
    for (const state of ['OPEN', 'COMMITTED']) {
      const resolution = yield* Schema.decodeUnknownEffect(ResolvePartyCommandCommitResultSchema)({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state,
      });
      expect(Schema.is(ResolvePartyCommandCommitResultSchema)(resolution)).toBe(true);
      expect(Struct.omit(resolution, ['_tag'])).toEqual({
        invocationId,
        retryCommand: false,
        state,
      });
    }
  }),
);

it.effect('the command client decodes indeterminate commits without losing recovery metadata', () =>
  Effect.gen(function* testProgram1() {
    const problem = {
      _tag: 'PartyCommandCommitIndeterminateProblem',
      detail: 'Resolve first.',
      invocationId,
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: 503,
      title: 'Unknown commit',
      type: 'urn:ontos:party:commit-indeterminate',
    };
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        Response.json(problem, {
          headers: { 'content-type': 'application/problem+json' },
          status: 503,
        }),
      );
    const result = yield* requestSearchRebuildWithAuthorization({}, 'Bearer test', {
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'uncertain',
      idempotencyKey: 'same-key',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      throw new Error('Expected truthy value');
    }
    expect(Schema.is(PartyCommandCommitIndeterminateProblemSchema)(result.failure)).toBe(true);
    expect(Struct.omit(result.failure, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
  }),
);

it.effect('the command client preserves committed invocation metadata across HTTP', () =>
  Effect.gen(function* testProgram2() {
    const problem = {
      _tag: 'PartyCommandAlreadyCommittedProblem',
      code: 'action_already_committed',
      detail: 'Refresh the authoritative governed reads.',
      invocationId,
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
      status: 409,
      title: 'Already committed',
      type: 'urn:ontos:party:already-committed',
    };
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        Response.json(problem, {
          headers: { 'content-type': 'application/problem+json' },
          status: 409,
        }),
      );
    const result = yield* requestSearchRebuildWithAuthorization({}, 'Bearer test', {
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'committed',
      idempotencyKey: 'same-key',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      throw new Error('Expected truthy value');
    }
    expect(Schema.is(PartyCommandAlreadyCommittedProblemSchema)(result.failure)).toBe(true);
    expect(Struct.omit(result.failure, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
  }),
);

it.effect(
  'recovery acquires a fresh assertion without submitting an idempotency key or re-running a command',
  () =>
    Effect.gen(function* testProgram3() {
      const requests: Request[] = [];
      let assertions = 0;
      const fakeFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (new URL(request.url).hostname === 'shell.example') {
          assertions += 1;
          return Promise.resolve(
            Response.json({ expiresAt: 2_000_000_000, token: `fresh-${assertions}` }),
          );
        }
        return Promise.resolve(
          Response.json({
            _tag: 'PartyCommandCommitResolution',
            invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          }),
        );
      };
      const result = yield* resolvePartyCommandCommit(
        { invocationId },
        {
          baseUrl: 'https://party.example/party-registry-api',
          correlationId: 'recovery',
          gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
          traceId: 'trace',
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(result.state).toBe('COMMITTED');
      expect(assertions).toBe(1);
      expect(requests.length).toBe(2);
      const [, request] = requests;
      expect(Boolean(request)).toBe(true);
      if (request === undefined) {
        throw new Error('Expected truthy value');
      }
      expect(request.url).toBe(
        'https://party.example/party-registry-api/party-registry/action-commits/resolve',
      );
      expect(request.headers.get('authorization')).toBe('Bearer fresh-1');
      expect(request.headers.get('idempotency-key')).toBe(null);
      expect(request.headers.get('x-correlation-id')).toBe('recovery');
      expect(request.headers.get('x-trace-id')).toBe('trace');
      expect(yield* Effect.promise(() => request.json())).toEqual({ invocationId });
    }),
);

it.effect(
  'Create recovery resolves commit and returns exact original operation result with fresh read authority',
  () =>
    Effect.all(
      (['CREATED', 'MATCHED_EXISTING', 'AMBIGUOUS'] as const).map((outcome) =>
        Effect.gen(function* testProgram5() {
          const requests: Request[] = [];
          let assertions = 0;
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
          const fakeFetch: typeof fetch = (input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            if (new URL(request.url).hostname === 'shell.example') {
              return Promise.resolve(
                Response.json({ expiresAt: 2_000_000_000, token: `fresh-${(assertions += 1)}` }),
              );
            }
            if (request.url.endsWith('/resolve')) {
              return Promise.resolve(
                Response.json({
                  _tag: 'PartyCommandCommitResolution',
                  invocationId,
                  retryCommand: false,
                  state: 'COMMITTED',
                }),
              );
            }
            return Promise.resolve(
              Response.json({
                caseRef: outcome === 'AMBIGUOUS' ? caseRef : null,
                committedCreateOutcome: outcome,
                decidedAt: '2026-09-04T00:00:00Z',
                decisionRef,
                evidenceExplanation: [],
                matchRuleVersion: 'party-exact-claims.v1',
                operation: 'CREATE',
                outcome: outcome === 'MATCHED_EXISTING' ? 'MATCHED' : outcome,
                partyRef: outcome === 'AMBIGUOUS' ? null : partyRef,
              }),
            );
          };
          const recovered = yield* recoverPartyCreate(
            { invocationId },
            {
              baseUrl: 'https://party.example/party-registry-api',
              correlationId: 'recover',
              gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
            },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
          const recoveredResult = Match.value(recovered).pipe(
            Match.tag('PartyCreateRecovered', ({ result }) => result),
            Match.tag('PartyCreateRecoveryPending', ({ resolution }) =>
              (() => {
                throw new Error(`Expected committed recovery, received ${resolution.state}`);
              })(),
            ),
            Match.exhaustive,
          );
          expect(recoveredResult.outcome).toBe(outcome);
          expect(assertions).toBe(2);
          expect(requests.length).toBe(4);
          expect(
            requests.every(
              (request) =>
                !request.url.includes('/commands/') &&
                request.headers.get('idempotency-key') === null,
            ),
          ).toBe(true);
        }),
      ),
    ),
);
