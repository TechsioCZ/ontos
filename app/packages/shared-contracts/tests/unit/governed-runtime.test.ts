import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { makeGovernedEffectBffClient } from '../../src/client-runtime.ts';
import { makeGovernedReadProblems } from '../../src/effect-bff-runtime.ts';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '../../src/problem-details.ts';

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

it('shared problem factories preserve concrete schemas, statuses, retryability and sanitized values', () => {
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
      ]),
    )(key);
    const problem = problems[kind]();
    expect(Schema.is(schemas[kind])(problem)).toBe(true);
    expect(problem.status).toBe(statuses[kind]);
    expect('retryable' in problem).toBe(kind === 'unavailable');
    expect(problem.type.startsWith('https://ontos.dev/problems/')).toBe(true);
    expect(problems[kind]()).not.toBe(problem);
  }
  const unavailable: typeof schemas.unavailable.Type = problems.unavailable();
  expect(unavailable.retryable).toBe(true);
  expect(problems.authentication()).toEqual(
    schemas.authentication.make({
      detail: 'A valid audience-scoped Bearer assertion is required.',
      status: 401,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/operation-authentication-required',
    }),
  );
  expect(problems.internal()).toEqual(
    schemas.internal.make({
      detail: 'The governed read could not be completed.',
      status: 500,
      title: 'Read failed',
      type: 'https://ontos.dev/problems/read-failed',
    }),
  );
});

const api = HttpApi.make('GovernedTransportTest').add(
  HttpApiGroup.make('read').add(
    HttpApiEndpoint.get('execute', '/read', {
      error: schemas.unavailable,
      success: Schema.String,
    }),
  ),
);
const makeClient = (credential: string, requestCorrelation: string, baseUrl: string | URL) =>
  makeGovernedEffectBffClient(
    {
      api,
      credential: Redacted.make(credential),
      defaultApiPrefix: '/owner-api',
      requestCorrelation,
    },
    { baseUrl },
  );

it.effect('shared transport is lazy and keeps each invocation credential, correlation and trusted URL', () =>
  Effect.gen(function* checkTransport() {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json('ok'));
    };
    const url = new URL('https://owner.example/custom');
    const first = makeClient('Bearer first', 'first-correlation', url);
    url.protocol = 'ftp:';
    url.hostname = 'attacker.example';
    const second = makeClient('Bearer second', 'second-correlation', 'https://owner.example/custom');
    expect(requests.length).toBe(0);
    for (const client of [first, second]) {
      const result = yield* client.pipe(
        Effect.flatMap((value) => value.read.execute({})),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      expect(result).toBe('ok');
    }
    expect(
      requests.map((request) => [
        request.url,
        request.headers.get('authorization'),
        request.headers.get('x-correlation-id'),
      ]),
    ).toEqual([
      ['https://owner.example/custom/read', 'Bearer first', 'first-correlation'],
      ['https://owner.example/custom/read', 'Bearer second', 'second-correlation'],
    ]);
  }),
);

it.effect('shared transport retains the concrete retryable backend error union', () =>
  Effect.gen(function* checkTypedFailure() {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        Response.json(problems.unavailable(), {
          headers: { 'content-type': 'application/problem+json' },
          status: 503,
        }),
      );
    const result = yield* makeClient('Bearer proof', 'correlation', 'https://owner.example/api').pipe(
      Effect.flatMap((client) => client.read.execute({})),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.flip,
    );
    expect(Schema.is(schemas.unavailable)(result)).toBe(true);
    const problem = yield* Schema.decodeUnknownEffect(schemas.unavailable)(result);
    expect(yield* Schema.encodeEffect(schemas.unavailable)(problem)).toEqual(
      yield* Schema.encodeEffect(schemas.unavailable)(problems.unavailable()),
    );
  }),
);

for (const baseUrl of ['data:text/plain,unsafe', 'https://user:password@owner.example/api', '//attacker.example/api']) {
  it.effect(`shared transport rejects unsafe URL ${baseUrl} before fetch`, () =>
    Effect.gen(function* checkUnsafeUrl() {
      let calls = 0;
      const fetch: typeof globalThis.fetch = () => {
        calls += 1;
        return Promise.resolve(Response.json('unsafe'));
      };
      const result = yield* makeClient('Bearer secret', 'correlation', baseUrl).pipe(
        Effect.flatMap((client) => client.read.execute({})),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.flip,
      );
      expect(Schema.isSchemaError(result)).toBe(true);
      if (Schema.isSchemaError(result)) {
        expect(result.message).not.toMatch(/password|Bearer secret|owner\.example/u);
      }
      expect(calls).toBe(0);
    }),
  );
}
