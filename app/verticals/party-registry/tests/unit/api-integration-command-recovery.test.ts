/* eslint-disable no-await-in-loop -- Recovery outcomes intentionally exercise separate sequential transport fixtures. */
// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Duration, Effect, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  PartyCommandCommitIndeterminateProblemSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  ResolvePartyCommandCommitPayloadSchema,
  ResolvePartyCommandCommitResultSchema,
  partyRegistryCommandRecoveryApi,
  partyRegistryCommandsApi,
} from '../../shared/command-api.ts';
import {
  requestSearchRebuildWithAuthorization,
  resolvePartyCommandCommit,
  recoverPartyCreate,
} from '../../src/api/party-command-client.ts';

const invocationId = '10000000-0000-4000-8000-000000000001';

test('already committed is terminal and carries the invocation for governed refresh', () => {
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
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyCommandAlreadyCommittedProblemSchema)(problem),
    problem,
  );
  for (const endpoint of Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints)) {
    assert.ok([...endpoint.error].some((schema) => Schema.is(schema)(problem)));
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyCommandAlreadyCommittedProblemSchema)({
      ...problem,
      retryCommand: true,
    }),
  );
});

test('commit uncertainty retains a resolution handle and never instructs blind command retry', () => {
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
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyCommandCommitIndeterminateProblemSchema)(problem),
    problem,
  );
  for (const endpoint of Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints)) {
    assert.ok([...endpoint.error].some((schema) => Schema.is(schema)(problem)));
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyCommandCommitIndeterminateProblemSchema)({
      ...problem,
      retryCommand: true,
    }),
  );
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

test('the command client decodes indeterminate commits without losing recovery metadata', async () => {
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
  const result = await Effect.runPromise(
    requestSearchRebuildWithAuthorization({}, Redacted.make('Bearer test'), {
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'uncertain',
      idempotencyKey: 'same-key',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure, problem);
});

test('the command client preserves committed invocation metadata across HTTP', async () => {
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
  const result = await Effect.runPromise(
    requestSearchRebuildWithAuthorization({}, Redacted.make('Bearer test'), {
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'committed',
      idempotencyKey: 'same-key',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure, problem);
});

test('recovery acquires a fresh assertion without submitting an idempotency key or re-running a command', async () => {
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
  const result = await Effect.runPromise(
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
  assert.equal(assertions, 1);
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

test(
  'Create recovery bounds the durable decision read by the caller deadline and never replays Create',
  { timeout: 5000 },
  async () => {
    const requests: Request[] = [];
    let aborted = false;
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).hostname === 'shell.example') {
        return Response.json({ expiresAt: 2_000_000_000, token: 'fresh' });
      }
      if (request.url.endsWith('/resolve')) {
        return Response.json({
          _tag: 'PartyCommandCommitResolution',
          invocationId,
          retryCommand: false,
          state: 'COMMITTED',
        });
      }
      // The decision read answers nothing on its own: the only thing that ends this leg is the
      // forwarded deadline aborting the request, so an unbounded leg trips the test timeout.
      request.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      await once(request.signal, 'abort');
      throw new Error('decision read ended only by the forwarded deadline');
    };
    const [elapsed, result] = await Effect.runPromise(
      recoverPartyCreate(
        { invocationId },
        {
          baseUrl: 'https://party.example/party-registry-api',
          correlationId: 'recover-deadline',
          gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
          timeoutMs: 25,
        },
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.timed),
    );
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, 'TimeoutError');
    // Far under the 10s default this leg spent before the caller deadline was forwarded.
    assert.ok(Duration.toMillis(elapsed) < 2000, `recovery read took ${Duration.format(elapsed)}`);
    assert.ok(aborted);
    assert.ok(requests.some((request) => request.url.endsWith('/reads/party-match-decision')));
    assert.ok(
      requests.every(
        (request) =>
          !request.url.includes('/commands/') && request.headers.get('idempotency-key') === null,
      ),
    );
  },
);

test('Create recovery resolves commit and returns exact original operation result with fresh read authority', async () => {
  for (const outcome of ['CREATED', 'MATCHED_EXISTING', 'AMBIGUOUS'] as const) {
    const requests: Request[] = [];
    let assertions = 0;
    const partyRef = {
      moduleId: 'party.registry',
      resourceId: invocationId,
      resourceType: 'party.registry.party',
      tenantId: invocationId,
    };
    const decisionRef = { ...partyRef, resourceType: 'party.registry.party-match-decision' };
    const caseRef = { ...partyRef, resourceType: 'party.registry.duplicate-candidate-case' };
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
    const recovered = await Effect.runPromise(
      recoverPartyCreate(
        { invocationId },
        {
          baseUrl: 'https://party.example/party-registry-api',
          correlationId: 'recover',
          gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
    );
    assert.equal(recovered._tag, 'PartyCreateRecovered');
    if (recovered._tag === 'PartyCreateRecovered') {
      assert.equal(recovered.result.outcome, outcome);
    }
    assert.equal(assertions, 2);
    assert.equal(requests.length, 4);
    assert.ok(
      requests.every(
        (request) =>
          !request.url.includes('/commands/') && request.headers.get('idempotency-key') === null,
      ),
    );
  }
});
