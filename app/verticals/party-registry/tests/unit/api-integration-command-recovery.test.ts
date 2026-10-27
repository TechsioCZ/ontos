import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Match, Redacted, Result, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

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
import { PartyCreateRecoveryUnavailable } from '../../shared/domain/matching-contracts.ts';
import {
  requestSearchRebuildWithAuthorization,
  resolvePartyCommandCommit,
  recoverPartyCreate,
  recoverPartyCreateWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { makeCommandAssertionFetch } from '../support/command-assertion-fetch.ts';

const invocationId = Schema.decodeSync(ActionInvocationIdSchema)('10000000-0000-4000-8000-000000000001');
const compositionRevision = 'a'.repeat(64);
const approvedApiBaseUrl = 'https://party.example/party-registry-api';
const approvedBrowserApiBasePath = '/module-api/party-registry/build-approved/party-registry-api';

const recoveryCredential = (jti: string, signature = 'signature') =>
  `Bearer ${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ jti }))}.${signature}`;

const makeSingleUseOwnerResponse = (ownerResponse: (request: Request) => Response) => {
  const consumedJtis = new Set<string>();
  const rejectedJtis: string[] = [];
  const respond = (request: Request) => {
    const encodedPayload = request.headers.get('authorization')?.split('.')[1];
    if (encodedPayload === undefined) {
      throw new Error('Expected a JWT credential');
    }
    const { jti } = Schema.decodeUnknownSync(Schema.Struct({ jti: Schema.String }))(JSON.parse(atob(encodedPayload)));
    if (consumedJtis.has(jti)) {
      rejectedJtis.push(jti);
      return Response.json(
        {
          _tag: 'PartyMatchDecisionAuthenticationProblem',
          detail: 'This single-use credential was already consumed.',
          status: 401,
          title: 'Credential already consumed',
          type: 'urn:ontos:party:credential-consumed',
        },
        { headers: { 'content-type': 'application/problem+json' }, status: 401 },
      );
    }
    consumedJtis.add(jti);
    return ownerResponse(request);
  };
  return { consumedJtis, rejectedJtis, respond };
};

const makeNativeRecoveryFetch = (ownerResponse: (request: Request) => Response) => {
  const singleUse = makeSingleUseOwnerResponse(ownerResponse);
  return { ...makeCommandAssertionFetch(singleUse.respond, 'unexpected-shell'), ...singleUse };
};

const makeNativeRecoveryAcquirer = (baseUrl: string | URL = approvedApiBaseUrl) => {
  let acquisitions = 0;
  const acquire = () =>
    Effect.sync(() => {
      acquisitions += 1;
      return {
        credential: Redacted.make(recoveryCredential(`native-${acquisitions}`)),
        options: { baseUrl, compositionRevision },
      };
    });
  return { acquire, acquisitions: () => acquisitions };
};

const pinRecoveryDocument = Effect.gen(function* pinTestDocument() {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        Object.defineProperty(globalThis, 'document', previousDocument);
      }
      if (previousLocation === undefined) {
        Reflect.deleteProperty(globalThis, 'location');
      } else {
        Object.defineProperty(globalThis, 'location', previousLocation);
      }
    }),
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en' },
  });
  yield* pinDocumentCompositionRevision(compositionRevision);
});

const makeRecoveryAssertionFetch = (ownerResponse: (request: Request) => Response) => {
  const singleUse = makeSingleUseOwnerResponse(ownerResponse);
  const requests: Request[] = [];
  let assertions = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname !== '/shell-super-app-api/auth/gateway-context') {
      return Promise.resolve(singleUse.respond(request));
    }
    assertions += 1;
    return Promise.resolve(
      Response.json({
        apiBaseUrl: approvedBrowserApiBasePath,
        compositionRevision,
        expiresAt: 2_000_000_000,
        token: recoveryCredential(`fresh-${assertions}`).slice('Bearer '.length),
      }),
    );
  };
  return { assertions: () => assertions, fakeFetch, requests };
};

const createResult = (outcome: 'CREATED' | 'MATCHED_EXISTING' | 'AMBIGUOUS') => {
  const partyRef = {
    moduleId: 'party.registry',
    resourceId: invocationId,
    resourceType: 'party.registry.party',
    tenantId: invocationId,
  };
  const decisionRef = { ...partyRef, resourceType: 'party.registry.party-match-decision' };
  return outcome === 'AMBIGUOUS'
    ? { outcome, decisionRef, caseRef: { ...partyRef, resourceType: 'party.registry.duplicate-candidate-case' } }
    : { outcome, decisionRef, partyRef };
};

const recoveryProblems = [
  {
    name: 'already committed is terminal and carries the invocation for governed refresh',
    decode: Schema.decodeUnknownEffect(PartyCommandAlreadyCommittedProblemSchema),
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
    decode: Schema.decodeUnknownEffect(PartyCommandCommitIndeterminateProblemSchema),
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

it('review resolutions can reconcile their exact idempotency identity without inventing a new command', () => {
  for (const actionKey of [
    'party.registry.resolve-duplicate-candidate-match',
    'party.registry.resolve-duplicate-candidate-create',
    'party.registry.mark-duplicate-candidate-needs-evidence',
    'party.registry.dismiss-duplicate-candidate',
  ]) {
    expect(Schema.is(ResolvePartyCommandCommitPayloadSchema)({ actionKey, idempotencyKey: 'review:42' })).toBe(true);
  }
  expect(
    Schema.is(ResolvePartyCommandCommitPayloadSchema)({
      actionKey: 'party.registry.merge-parties',
      idempotencyKey: 'review:42',
    }),
  ).toBe(false);
});

for (const { name, decode, is, problem } of recoveryProblems) {
  it.effect(name, () =>
    Effect.gen(function* decodeRecoveryContract() {
      const decoded = yield* decode(problem);
      expect(is(decoded)).toBe(true);
      expect(Struct.omit(decoded, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
      for (const endpoint of Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints)) {
        expect([...endpoint.error].some((schema) => Schema.is(schema)(problem))).toBe(true);
      }
      const invalid: Effect.Effect<unknown, Schema.SchemaError> = decode({
        ...problem,
        retryCommand: true,
      });
      expect(Result.isFailure(yield* Effect.result(invalid))).toBe(true);
    }),
  );
}

it('recovery rejects an invalid invocation handle', () => {
  expect(() =>
    Schema.decodeSync(ResolvePartyCommandCommitPayloadSchema)({
      invocationId: 'invalid',
    }),
  ).toThrow();
});

it('keyed recovery admits only scoped Party actions and rejects mixed lookup identities', () => {
  for (const actionKey of [
    'party.registry.create-party',
    'party.registry.counterparty-customer-onboard',
    'party.registry.add-contact-point',
  ]) {
    expect(
      Schema.decodeUnknownSync(ResolvePartyCommandCommitPayloadSchema)({
        actionKey,
        idempotencyKey: 'opaque-operation-key',
      }),
    ).toEqual({ actionKey, idempotencyKey: 'opaque-operation-key' });
  }
  for (const invalid of [
    { actionKey: 'core.identity.arbitrary-action', idempotencyKey: 'key' },
    { actionKey: 'party.registry.create-party', idempotencyKey: '' },
    { actionKey: 'party.registry.create-party', idempotencyKey: 'x'.repeat(201) },
    { invocationId, actionKey: 'party.registry.create-party', idempotencyKey: 'key' },
    { idempotencyKey: 'key' },
  ]) {
    expect(() => Schema.decodeUnknownSync(ResolvePartyCommandCommitPayloadSchema)(invalid)).toThrow();
  }
});

it.effect('recovery is separate from the unchanged set of explicit mutation endpoints', () =>
  Effect.gen(function* decodeContract3() {
    const endpoint = partyRegistryCommandRecoveryApi.groups.partyCommandRecovery.endpoints.resolve;
    expect(endpoint.path).toBe('/party-registry/action-commits/resolve');
    for (const state of ['RUNNING', 'COMMITTED']) {
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
          }),
        );
      const result = yield* requestSearchRebuildWithAuthorization({}, 'Bearer test', {
        baseUrl: 'https://party.example/party-registry-api',
        correlationId: 'problem-decoding',
        idempotencyKey: 'same-key',
      }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) {
        return expect.unreachable('Expected HTTP problem decoding to fail');
      }
      expect(is(result.failure)).toBe(true);
      expect(Struct.omit(result.failure, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
    }),
  );
}

it.effect('recovery acquires a fresh assertion without submitting an idempotency key or re-running a command', () =>
  Effect.gen(function* testProgram3() {
    yield* pinRecoveryDocument;
    const { requests, assertions, fakeFetch } = makeRecoveryAssertionFetch(() =>
      Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      }),
    );
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
    expect(assertions()).toBe(1);
    expect(requests.length).toBe(2);
    const [, request] = requests;
    expect(Boolean(request)).toBe(true);
    if (request === undefined) {
      throw new Error('Expected truthy value');
    }
    expect(request.url).toBe(
      `https://shell.example${approvedBrowserApiBasePath}/party-registry/action-commits/resolve`,
    );
    expect(request.headers.get('authorization')).toBe(recoveryCredential('fresh-1'));
    expect(request.headers.get('idempotency-key')).toBe(null);
    expect(request.headers.get('x-correlation-id')).toBe('recovery');
    expect(request.headers.get('x-trace-id')).toBe('trace');
    expect(yield* Effect.promise(() => request.json())).toEqual({
      invocationId,
    });
  }),
);

for (const outcome of ['CREATED', 'MATCHED_EXISTING', 'AMBIGUOUS'] as const) {
  it.effect(`native owned recovery returns ${outcome} without reviewer-only reads or resubmission`, () =>
    Effect.gen(function* recoverOwnedResult() {
      const { acquire, acquisitions } = makeNativeRecoveryAcquirer();
      const { requests, assertions, consumedJtis, fakeFetch } = makeNativeRecoveryFetch(() =>
        Response.json({
          _tag: 'PartyCommandCommitResolution',
          invocationId,
          retryCommand: false,
          state: 'COMMITTED',
          createResult: createResult(outcome),
        }),
      );
      const result = yield* recoverPartyCreateWithAuthorization(
        { actionKey: 'party.registry.create-party', idempotencyKey: 'immutable-owner-key' },
        acquire,
        { compositionRevision, correlationId: 'native-owned', traceId: 'trace-owned' },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      Match.value(result).pipe(
        Match.tag('PartyCreateRecovered', (recovered) => expect(recovered.result).toEqual(createResult(outcome))),
        Match.orElse(() => expect.unreachable('Expected committed recovery')),
      );
      expect(acquisitions()).toBe(1);
      expect(assertions()).toBe(0);
      expect([...consumedJtis]).toEqual(['native-1']);
      expect(requests.map((request) => request.url)).toEqual([
        `${approvedApiBaseUrl}/party-registry/action-commits/resolve`,
      ]);
      expect(requests[0]?.headers.get('idempotency-key')).toBe(null);
      expect(requests[0]?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(requests[0]?.headers.get('x-trace-id')).toBe('trace-owned');
      const [request] = requests;
      if (request === undefined) {
        throw new Error('Missing native recovery request');
      }
      expect(yield* Effect.promise(() => request.json())).toEqual({
        actionKey: 'party.registry.create-party',
        idempotencyKey: 'immutable-owner-key',
      });
    }),
  );
}

it.effect('browser recovery uses the same owned invocation result, not reviewer authority', () =>
  Effect.gen(function* browserOwned() {
    yield* pinRecoveryDocument;
    const { requests, assertions, fakeFetch } = makeRecoveryAssertionFetch(() =>
      Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
        createResult: createResult('CREATED'),
      }),
    );
    const recovered = yield* recoverPartyCreate(
      { invocationId },
      { correlationId: 'browser-owned', gateway: { baseUrl: 'https://shell.example/shell-super-app-api' } },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(
      Match.value(recovered).pipe(
        Match.tag('PartyCreateRecovered', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(assertions()).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.url.includes('party-match-decision'))).toBe(true);
  }),
);

for (const state of ['RUNNING', 'COMMITTED'] as const) {
  it.effect(
    `native recovery ${state === 'RUNNING' ? 'waits for an open commit' : 'rejects an unproven committed result'}`,
    () =>
      Effect.gen(function* missingResult() {
        const { acquire, acquisitions } = makeNativeRecoveryAcquirer();
        const { requests, fakeFetch } = makeNativeRecoveryFetch(() =>
          Response.json({ _tag: 'PartyCommandCommitResolution', invocationId, retryCommand: false, state }),
        );
        const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
          compositionRevision,
          correlationId: 'missing-result',
        }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
        if (state === 'RUNNING') {
          expect(
            Result.isSuccess(result) &&
              Match.value(result.success).pipe(
                Match.tag('PartyCreateRecoveryPending', () => true),
                Match.orElse(() => false),
              ),
          ).toBe(true);
        } else {
          expect(Result.isFailure(result) && Schema.is(PartyCreateRecoveryUnavailable)(result.failure)).toBe(true);
        }
        expect(acquisitions()).toBe(1);
        expect(requests).toHaveLength(1);
      }),
  );
}

it.effect('rejects a credential for another release before contacting Party', () =>
  Effect.gen(function* wrongRelease() {
    const { requests, fakeFetch } = makeNativeRecoveryFetch(() => Response.json({}));
    const acquire = () =>
      Effect.succeed({
        credential: Redacted.make('Bearer wrong-release'),
        options: { baseUrl: approvedApiBaseUrl, compositionRevision: 'b'.repeat(64) },
      });
    const failure = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
      compositionRevision,
      correlationId: 'wrong-release',
    }).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Schema.is(PartyCreateRecoveryUnavailable)(failure)).toBe(true);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('stops immediately when native credential acquisition fails', () =>
  Effect.gen(function* failedAcquisition() {
    const failure = new PartyCreateRecoveryUnavailable({ reason: 'Issuer unavailable' });
    const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, () => Effect.fail(failure), {
      compositionRevision,
      correlationId: 'issuer-failure',
    }).pipe(Effect.flip);
    expect(result).toBe(failure);
  }),
);
