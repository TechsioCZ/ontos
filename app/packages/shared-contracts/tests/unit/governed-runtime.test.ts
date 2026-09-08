import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
} from '@modern-js/plugin-bff/effect-client';
import { Effect, Redacted, Schema, Result, flow } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  makeEffectTestCallback,
  runEffectTestPromise,
} from '../../../core-runtime/src/testing/effect-runtime.ts';
import { makeGovernedEffectBffClient } from '../../src/client-runtime.ts';
import { makeGovernedReadProblems } from '../../src/effect-bff-runtime.ts';
import {
  makeProblemDetailsSchema,
  makeRetryableProblemDetailsSchema,
} from '../../src/problem-details.ts';

const schemas = {
  authentication: makeProblemDetailsSchema('AuthenticationProblem', 401),
  forbidden: makeProblemDetailsSchema('ForbiddenProblem', 403),
  internal: makeProblemDetailsSchema('InternalProblem', 500),
  invalid: makeProblemDetailsSchema('InvalidProblem', 400),
  notFound: makeProblemDetailsSchema('NotFoundProblem', 404),
  policyConflict: makeProblemDetailsSchema('PolicyConflictProblem', 409),
  policyIneligible: makeProblemDetailsSchema('PolicyProblem', 422),
  unavailable: makeRetryableProblemDetailsSchema('UnavailableProblem', 503),
};
const problems = makeGovernedReadProblems(schemas);
const statuses = {
  authentication: 401,
  forbidden: 403,
  internal: 500,
  invalid: 400,
  notFound: 404,
  policyConflict: 409,
  policyIneligible: 422,
  unavailable: 503,
} as const;

test('shared problem factories preserve concrete schemas, statuses, retryability and sanitized values', () => {
  for (const key of Object.keys(problems)) {
    // Decode the key rather than casting away the concrete schema/factory contract.
    const kind = Schema.decodeUnknownSync(
      Schema.Literals([
        'authentication',
        'forbidden',
        'internal',
        'invalid',
        'notFound',
        'policyConflict',
        'policyIneligible',
        'unavailable',
      ])
    )(key);
    const problem = problems[kind]();
    assert.equal(Schema.is(schemas[kind])(problem), true);
    assert.equal(problem.status, statuses[kind]);
    assert.equal('retryable' in problem, kind === 'unavailable');
    assert.equal(problem.type.startsWith('https://ontos.dev/problems/'), true);
    assert.notEqual(problems[kind](), problem);
  }
  const unavailable: typeof schemas.unavailable.Type = problems.unavailable();
  assert.equal(unavailable.retryable, true);
  assert.deepEqual(
    problems.authentication(),
    schemas.authentication.make({
      detail: 'A valid audience-scoped Bearer assertion is required.',
      status: 401,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/operation-authentication-required',
    })
  );
  assert.deepEqual(
    problems.internal(),
    schemas.internal.make({
      detail: 'The governed read could not be completed.',
      status: 500,
      title: 'Read failed',
      type: 'https://ontos.dev/problems/read-failed',
    })
  );
});

const api = HttpApi.make('GovernedTransportTest').add(
  HttpApiGroup.make('read').add(
    HttpApiEndpoint.get('execute', '/read', {
      error: schemas.unavailable,
      success: Schema.String,
    })
  )
);
const makeClient = (
  credential: string,
  requestCorrelation: string,
  baseUrl: string | URL
) =>
  makeGovernedEffectBffClient(
    {
      api,
      credential: Redacted.make(credential),
      defaultApiPrefix: '/owner-api',
      requestCorrelation,
    },
    { baseUrl }
  );

test(
  'shared transport is lazy and keeps each invocation credential, correlation and trusted URL',
  makeEffectTestCallback(
    Effect.gen(function* checkTransport() {
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = flow(
        (input: RequestInfo | URL, init?: RequestInit) =>
          Effect.sync(() => {
            requests.push(new Request(input, init));
            return Response.json('ok');
          }),
        runEffectTestPromise
      );
      const url = new URL('https://owner.example/custom');
      const first = makeClient('Bearer first', 'first-correlation', url);
      url.protocol = 'ftp:';
      url.hostname = 'attacker.example';
      const second = makeClient(
        'Bearer second',
        'second-correlation',
        'https://owner.example/custom'
      );
      assert.equal(requests.length, 0);
      for (const client of [first, second]) {
        const result = yield* client.pipe(
          Effect.flatMap((value) => value.read.execute({})),
          Effect.provideService(FetchHttpClient.Fetch, fetch)
        );
        assert.equal(result, 'ok');
      }
      assert.deepEqual(
        requests.map((request) => [
          request.url,
          request.headers.get('authorization'),
          request.headers.get('x-correlation-id'),
        ]),
        [
          [
            'https://owner.example/custom/read',
            'Bearer first',
            'first-correlation',
          ],
          [
            'https://owner.example/custom/read',
            'Bearer second',
            'second-correlation',
          ],
        ]
      );
    })
  )
);

test(
  'shared transport retains the concrete retryable backend error union',
  makeEffectTestCallback(
    Effect.gen(function* checkTypedFailure() {
      const fetch: typeof globalThis.fetch = flow(
        () =>
          Effect.sync(() =>
            Response.json(problems.unavailable(), {
              headers: { 'content-type': 'application/problem+json' },
              status: 503,
            })
          ),
        runEffectTestPromise
      );
      const result = yield* makeClient(
        'Bearer proof',
        'correlation',
        'https://owner.example/api'
      ).pipe(
        Effect.flatMap((client) => client.read.execute({})),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result
      );
      assert.equal(Result.isFailure(result), true);
      if (Result.isFailure(result)) {
        assert.equal(Schema.is(schemas.unavailable)(result.failure), true);
      }
    })
  )
);

for (const baseUrl of [
  'data:text/plain,unsafe',
  'https://user:password@owner.example/api',
  '//attacker.example/api',
]) {
  test(
    `shared transport rejects unsafe URL ${baseUrl} before fetch`,
    makeEffectTestCallback(
      Effect.gen(function* checkUnsafeUrl() {
        let calls = 0;
        const fetch: typeof globalThis.fetch = flow(
          () =>
            Effect.sync(() => {
              calls += 1;
              return Response.json('unsafe');
            }),
          runEffectTestPromise
        );
        const result = yield* makeClient(
          'Bearer secret',
          'correlation',
          baseUrl
        ).pipe(
          Effect.flatMap((client) => client.read.execute({})),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.result
        );
        assert.equal(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.equal(Schema.isSchemaError(result.failure), true);
          if (Schema.isSchemaError(result.failure)) {
            assert.doesNotMatch(
              result.failure.message,
              /password|Bearer secret|owner\.example/u
            );
          }
        }
        assert.equal(calls, 0);
      })
    )
  );
}
