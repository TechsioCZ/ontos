import { makeCommandAssertionFetch } from '../support/command-assertion-fetch.ts';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Match, Result, Schema } from 'effect';
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

const recoveryProblems = [
  {
    name: 'already committed is terminal and carries the invocation for governed refresh',
    decode: Schema.decodeUnknownSync(PartyCommandAlreadyCommittedProblemSchema),
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
    decode: Schema.decodeUnknownSync(PartyCommandCommitIndeterminateProblemSchema),
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

for (const { name, decode, problem } of recoveryProblems) {
  test(name, () => {
    assert.deepEqual(decode(problem), problem);
    for (const endpoint of Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints)) {
      assert.ok([...endpoint.error].some((schema) => Schema.is(schema)(problem)));
    }
    assert.throws(() => decode({ ...problem, retryCommand: true }));
  });
}

test('recovery rejects an invalid invocation handle', () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(ResolvePartyCommandCommitPayloadSchema)({ invocationId: 'invalid' }),
  );
});

test('recovery is separate from the unchanged set of explicit mutation endpoints', () => {
  assert.equal(Object.keys(partyRegistryCommandsApi.groups.partyCommands.endpoints).length, 24);
  const endpoint = partyRegistryCommandRecoveryApi.groups.partyCommandRecovery.endpoints.resolve;
  assert.equal(endpoint.path, '/party-registry/action-commits/resolve');
  for (const state of ['OPEN', 'COMMITTED']) {
    assert.deepEqual(
      Schema.decodeUnknownSync(ResolvePartyCommandCommitResultSchema)({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state,
      }),
      { _tag: 'PartyCommandCommitResolution', invocationId, retryCommand: false, state },
    );
  }
});

for (const { name, problem } of [
  ...recoveryProblems,
  {
    name: 'declared conflict retains its tag and stable conflict code',
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
  test(`command client HTTP decoding: ${name}`, async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        Response.json(problem, {
          headers: { 'content-type': 'application/problem+json' },
          status: problem.status,
        }),
      );
    const result = await runEffectTestPromise(
      requestSearchRebuildWithAuthorization({}, 'Bearer test', {
        baseUrl: 'https://party.example/party-registry-api',
        correlationId: 'problem-decoding',
        idempotencyKey: 'same-key',
      }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
    );
    assert.ok(Result.isFailure(result));
    assert.deepEqual(result.failure, problem);
  });
}

test('recovery acquires a fresh assertion without submitting an idempotency key or re-running a command', async () => {
  const { requests, assertions, fakeFetch } = makeCommandAssertionFetch(
    () =>
      Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      }),
    'fresh',
  );
  const result = await runEffectTestPromise(
    resolvePartyCommandCommit(
      { invocationId },
      {
        baseUrl: 'https://party.example/party-registry-api',
        correlationId: 'recovery',
        gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
        traceId: 'trace',
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );
  assert.equal(result.state, 'COMMITTED');
  assert.equal(assertions(), 1);
  assert.equal(requests.length, 2);
  const [, request] = requests;
  assert.ok(request);
  assert.equal(
    request.url,
    'https://party.example/party-registry-api/party-registry/action-commits/resolve',
  );
  assert.equal(request.headers.get('authorization'), 'Bearer fresh-1');
  assert.equal(request.headers.get('idempotency-key'), null);
  assert.equal(request.headers.get('x-correlation-id'), 'recovery');
  assert.equal(request.headers.get('x-trace-id'), 'trace');
  assert.deepEqual(await request.json(), { invocationId });
});

test('Create recovery resolves commit and returns exact original operation result with fresh read authority', async () => {
  await Promise.all(
    (['CREATED', 'MATCHED_EXISTING', 'AMBIGUOUS'] as const).map(async (outcome) => {
      const partyRef = {
        moduleId: 'party.registry',
        resourceId: invocationId,
        resourceType: 'party.registry.party',
        tenantId: invocationId,
      };
      const decisionRef = { ...partyRef, resourceType: 'party.registry.party-match-decision' };
      const caseRef = { ...partyRef, resourceType: 'party.registry.duplicate-candidate-case' };
      const { requests, assertions, fakeFetch } = makeCommandAssertionFetch((request) => {
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
      }, 'fresh');
      const recovered = await runEffectTestPromise(
        recoverPartyCreate(
          { invocationId },
          {
            baseUrl: 'https://party.example/party-registry-api',
            correlationId: 'recover',
            gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
      );
      const recoveredResult = Match.value(recovered).pipe(
        Match.tag('PartyCreateRecovered', ({ result }) => result),
        Match.tag('PartyCreateRecoveryPending', ({ resolution }) =>
          assert.fail(`Expected committed recovery, received ${resolution.state}`),
        ),
        Match.exhaustive,
      );
      assert.equal(recoveredResult.outcome, outcome);
      assert.equal(assertions(), 2);
      assert.equal(requests.length, 4);
      assert.ok(
        requests.every(
          (request) =>
            !request.url.includes('/commands/') && request.headers.get('idempotency-key') === null,
        ),
      );
    }),
  );
});
