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
import { PartyMatchDecisionAuthenticationProblemSchema } from '../../shared/apis/party-match-decision.ts';
import {
  requestSearchRebuildWithAuthorization,
  recoverPartyCreateWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { makeCommandAssertionFetch } from '../support/command-assertion-fetch.ts';
import {
  compositionRevision,
  createDecision,
  invocationId,
  makeSingleUseOwnerResponse,
  recoveryCredential,
} from '../support/party-command-recovery.ts';

const approvedApiBaseUrl = 'https://party.example/party-registry-api';

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

it.effect('recovery is separate from the unchanged set of explicit mutation endpoints', () =>
  Effect.gen(function* decodeContract3() {
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

it.effect('native Create recovery acquires a fresh single-use credential for each read of the captured release', () =>
  Effect.gen(function* nativeCreateRecovery() {
    const baseUrl = 'https://immutable-party-release.example/party-registry-api';
    const { acquire, acquisitions } = makeNativeRecoveryAcquirer(baseUrl);
    const { requests, assertions, fakeFetch, consumedJtis } = makeNativeRecoveryFetch((request) =>
      request.url.endsWith('/resolve')
        ? Response.json({
            _tag: 'PartyCommandCommitResolution',
            invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          })
        : Response.json(createDecision('CREATED')),
    );
    const recovered = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
      baseUrl,
      compositionRevision,
      correlationId: 'native-recovery',
      gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    Match.value(recovered).pipe(
      Match.tag('PartyCreateRecovered', ({ result }) => expect(result.outcome).toBe('CREATED')),
      Match.tag('PartyCreateRecoveryPending', () => expect.unreachable('Expected committed Create recovery')),
      Match.exhaustive,
    );
    expect(acquisitions()).toBe(2);
    expect([...consumedJtis]).toEqual(['native-1', 'native-2']);
    expect(assertions()).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      `${baseUrl}/party-registry/action-commits/resolve`,
      `${baseUrl}/reads/party-match-decision`,
    ]);
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      recoveryCredential('native-1'),
      recoveryCredential('native-2'),
    ]);
    for (const request of requests) {
      expect(request.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request.headers.get('x-correlation-id')).toBe('native-recovery');
      expect(request.headers.get('idempotency-key')).toBe(null);
    }
    const [commitRequest, decisionRequest] = requests;
    if (commitRequest === undefined || decisionRequest === undefined) {
      return expect.unreachable('Expected commit and decision reads');
    }
    expect(yield* Effect.promise(() => commitRequest.json())).toEqual({ invocationId });
    expect(yield* Effect.promise(() => decisionRequest.json())).toEqual({ actionInvocationId: invocationId });
  }),
);

it.effect('native Create recovery leaves an open commit pending without reading a decision', () =>
  Effect.gen(function* nativePendingRecovery() {
    const { acquire, acquisitions } = makeNativeRecoveryAcquirer();
    const { requests, assertions, fakeFetch } = makeNativeRecoveryFetch(() =>
      Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'OPEN',
      }),
    );
    const recovered = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
      baseUrl: approvedApiBaseUrl,
      compositionRevision,
      correlationId: 'native-pending',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    Match.value(recovered).pipe(
      Match.tag('PartyCreateRecoveryPending', ({ resolution }) =>
        expect(Struct.omit(resolution, ['_tag'])).toEqual({ invocationId, retryCommand: false, state: 'OPEN' }),
      ),
      Match.tag('PartyCreateRecovered', () => expect.unreachable('Expected pending Create recovery')),
      Match.exhaustive,
    );
    expect(acquisitions()).toBe(1);
    expect(assertions()).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      `${approvedApiBaseUrl}/party-registry/action-commits/resolve`,
    ]);
  }),
);

it.effect('native Create recovery rejects a committed invocation without a proven Create result', () =>
  Effect.gen(function* nativeUnavailableRecovery() {
    const { acquire, acquisitions } = makeNativeRecoveryAcquirer();
    const { requests, assertions, fakeFetch } = makeNativeRecoveryFetch((request) =>
      request.url.endsWith('/resolve')
        ? Response.json({
            _tag: 'PartyCommandCommitResolution',
            invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          })
        : Response.json({ ...createDecision('CREATED'), committedCreateOutcome: null, operation: 'LEGACY' }),
    );
    const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
      baseUrl: approvedApiBaseUrl,
      compositionRevision,
      correlationId: 'native-unavailable',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return expect.unreachable('Expected unavailable Create recovery');
    }
    expect(Schema.is(PartyCreateRecoveryUnavailable)(result.failure)).toBe(true);
    expect(acquisitions()).toBe(2);
    expect(assertions()).toBe(0);
    expect(requests).toHaveLength(2);
  }),
);

const committedRecoveryResponse = (request: Request) =>
  request.url.endsWith('/resolve')
    ? Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      })
    : Response.json(createDecision('CREATED'));

it.effect(
  'native recovery retains the invocation and request context when caller inputs change during the commit read',
  () =>
    Effect.gen(function* mutatedRecoveryInputs() {
      const payload = { invocationId };
      const options = {
        compositionRevision,
        correlationId: 'captured-correlation',
        traceId: 'captured-trace',
      };
      const { acquire, acquisitions } = makeNativeRecoveryAcquirer();
      const { requests, fakeFetch } = makeNativeRecoveryFetch((request) => {
        if (request.url.endsWith('/resolve')) {
          payload.invocationId = Schema.decodeSync(ActionInvocationIdSchema)('10000000-0000-4000-8000-000000000002');
          options.compositionRevision = 'b'.repeat(64);
          options.correlationId = 'changed-correlation';
          options.traceId = 'changed-trace';
        }
        return committedRecoveryResponse(request);
      });
      const recovered = yield* recoverPartyCreateWithAuthorization(payload, acquire, options).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      );
      Match.value(recovered).pipe(
        Match.tag('PartyCreateRecovered', ({ result }) => expect(result.outcome).toBe('CREATED')),
        Match.tag('PartyCreateRecoveryPending', () => expect.unreachable('Expected committed Create recovery')),
        Match.exhaustive,
      );
      expect(acquisitions()).toBe(2);
      const [commitRequest, decisionRequest] = requests;
      if (commitRequest === undefined || decisionRequest === undefined) {
        return expect.unreachable('Expected commit and decision reads');
      }
      expect(yield* Effect.promise(() => commitRequest.json())).toEqual({ invocationId });
      expect(yield* Effect.promise(() => decisionRequest.json())).toEqual({ actionInvocationId: invocationId });
      expect(commitRequest.headers.get('x-trace-id')).toBe('captured-trace');
      for (const request of requests) {
        expect(request.headers.get('x-correlation-id')).toBe('captured-correlation');
        expect(request.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      }
    }),
);

it.effect('native Create recovery rejects a reused credential before the decision HTTP request', () =>
  Effect.gen(function* reusedCredentialRecovery() {
    let acquisitions = 0;
    const acquire = () =>
      Effect.sync(() => {
        acquisitions += 1;
        return {
          credential: Redacted.make(recoveryCredential('reused')),
          options: { baseUrl: approvedApiBaseUrl, compositionRevision },
        };
      });
    const { requests, consumedJtis, fakeFetch } = makeNativeRecoveryFetch(committedRecoveryResponse);
    const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
      compositionRevision,
      correlationId: 'native-reused-credential',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return expect.unreachable('Expected credential reuse rejection');
    }
    expect(Schema.is(PartyCreateRecoveryUnavailable)(result.failure)).toBe(true);
    expect(acquisitions).toBe(2);
    expect(requests).toHaveLength(1);
    expect([...consumedJtis]).toEqual(['reused']);
  }),
);

it.effect('the owner rejects two distinct JWT strings that reuse one consumed jti during native recovery', () =>
  Effect.gen(function* reusedJtiRecovery() {
    let acquisitions = 0;
    const acquire = () =>
      Effect.sync(() => {
        acquisitions += 1;
        return {
          credential: Redacted.make(recoveryCredential('reused-jti', `signature-${acquisitions}`)),
          options: { baseUrl: approvedApiBaseUrl, compositionRevision },
        };
      });
    const { requests, consumedJtis, rejectedJtis, fakeFetch } = makeNativeRecoveryFetch(committedRecoveryResponse);
    const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
      compositionRevision,
      correlationId: 'native-reused-jti',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      return expect.unreachable('Expected single-use JWT rejection');
    }
    expect(Schema.is(PartyMatchDecisionAuthenticationProblemSchema)(result.failure)).toBe(true);
    expect(acquisitions).toBe(2);
    expect(requests).toHaveLength(2);
    expect([...consumedJtis]).toEqual(['reused-jti']);
    expect(rejectedJtis).toEqual(['reused-jti']);
  }),
);

const approvedRecoveryTarget = { baseUrl: approvedApiBaseUrl, compositionRevision };

for (const { name, firstTarget, secondTarget, expectedRequests, expectedAcquisitions } of [
  {
    name: 'native recovery rejects a first credential for a different revision before any HTTP request',
    firstTarget: { ...approvedRecoveryTarget, compositionRevision: 'b'.repeat(64) },
    secondTarget: approvedRecoveryTarget,
    expectedRequests: 0,
    expectedAcquisitions: 1,
  },
  {
    name: 'native recovery rejects a changed revision before the decision HTTP request',
    firstTarget: approvedRecoveryTarget,
    secondTarget: { ...approvedRecoveryTarget, compositionRevision: 'b'.repeat(64) },
    expectedRequests: 1,
    expectedAcquisitions: 2,
  },
  {
    name: 'native recovery rejects a changed API URL before the decision HTTP request',
    firstTarget: approvedRecoveryTarget,
    secondTarget: { ...approvedRecoveryTarget, baseUrl: 'https://other-release.example/party-registry-api' },
    expectedRequests: 1,
    expectedAcquisitions: 2,
  },
]) {
  it.effect(name, () =>
    Effect.gen(function* changedReleaseRecovery() {
      let acquisitions = 0;
      const acquire = () =>
        Effect.sync(() => {
          acquisitions += 1;
          return {
            credential: Redacted.make(recoveryCredential(`changed-release-${acquisitions}`)),
            options: acquisitions === 1 ? firstTarget : secondTarget,
          };
        });
      const { requests, fakeFetch } = makeNativeRecoveryFetch(committedRecoveryResponse);
      const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
        compositionRevision,
        correlationId: 'native-changed-release',
      }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) {
        return expect.unreachable('Expected release identity rejection');
      }
      expect(Schema.is(PartyCreateRecoveryUnavailable)(result.failure)).toBe(true);
      expect(acquisitions).toBe(expectedAcquisitions);
      expect(requests).toHaveLength(expectedRequests);
    }),
  );
}

for (const failedAcquisition of [1, 2]) {
  it.effect(`native recovery stops immediately when credential acquisition ${failedAcquisition} fails`, () =>
    Effect.gen(function* unavailableCredentialRecovery() {
      let acquisitions = 0;
      const acquisitionFailure = new PartyCreateRecoveryUnavailable({ reason: 'Credential issuer unavailable' });
      const acquire = () =>
        Effect.gen(function* acquireRecoveryCredential() {
          acquisitions += 1;
          if (acquisitions === failedAcquisition) {
            return yield* acquisitionFailure;
          }
          return {
            credential: Redacted.make(recoveryCredential(`available-${acquisitions}`)),
            options: approvedRecoveryTarget,
          };
        });
      const { requests, fakeFetch } = makeNativeRecoveryFetch(committedRecoveryResponse);
      const result = yield* recoverPartyCreateWithAuthorization({ invocationId }, acquire, {
        compositionRevision,
        correlationId: 'native-failed-acquisition',
      }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) {
        return expect.unreachable('Expected credential acquisition failure');
      }
      expect(result.failure).toBe(acquisitionFailure);
      expect(acquisitions).toBe(failedAcquisition);
      expect(requests).toHaveLength(failedAcquisition - 1);
    }),
  );
}
