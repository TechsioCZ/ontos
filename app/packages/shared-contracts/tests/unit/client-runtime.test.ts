// @effect-diagnostics asyncFunction:off -- Node's test runner owns this compatibility edge; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { Predicate, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

const RepresentativeConflictSchema = Schema.TaggedStruct('RepresentativeConflict', {
  detail: Schema.String,
  status: Schema.Literal(409),
  title: Schema.String,
  type: Schema.String,
}).pipe(
  HttpApiSchema.asJson({ contentType: 'application/problem+json' }),
  HttpApiSchema.status(409),
);

const RepresentativeApi = HttpApi.make('RepresentativeApi').add(
  HttpApiGroup.make('representative').add(
    HttpApiEndpoint.get('read', '/read', {
      error: RepresentativeConflictSchema,
      success: Schema.Struct({ value: Schema.String }),
    }),
  ),
);

const controlledTransportFailureFetch: typeof fetch = async () => {
  throw new TypeError('controlled transport failure');
};
const invalidResponseFetch: typeof fetch = async () => Response.json({ value: 358 });

const representativeClientEffect = makeEffectBffClient({
  api: RepresentativeApi,
  defaultApiPrefix: '/representative-api',
});
type RepresentativeClient = Effect.Success<typeof representativeClientEffect>;
type RepresentativeReadEffect = ReturnType<RepresentativeClient['representative']['read']>;
type RepresentativeReadSuccess = Effect.Success<RepresentativeReadEffect>;
type RepresentativeReadError = Effect.Error<RepresentativeReadEffect>;

const preserveRepresentativeReadType = (client: RepresentativeClient): RepresentativeReadEffect =>
  client.representative.read({});
const preserveRepresentativeSuccessType = (
  success: RepresentativeReadSuccess,
): Readonly<{ value: string }> => success;
const preserveRepresentativeErrorType = (error: RepresentativeReadError) => {
  if (Schema.is(RepresentativeConflictSchema)(error)) {
    return error.status satisfies 409;
  }
  return error;
};

void preserveRepresentativeReadType;
void preserveRepresentativeSuccessType;
void preserveRepresentativeErrorType;

test('constructs fresh typed clients lazily as Effect values', async () => {
  const clientEffect = makeEffectBffClient({
    api: RepresentativeApi,
    defaultApiPrefix: 'https://owner.example/representative-api',
  });
  assert.equal(Effect.isEffect(clientEffect), true);

  const first = await Effect.runPromise(clientEffect);
  const second = await Effect.runPromise(clientEffect);

  assert.notEqual(first, second);
  assert.equal(Effect.isEffect(first.representative.read({})), true);
});

test('uses the owner-supplied API prefix by default', async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ value: 'default-prefix' });
  };
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en' },
  });

  try {
    const result = await Effect.runPromise(
      makeEffectBffClient({
        api: RepresentativeApi,
        defaultApiPrefix: '/representative-api',
      }).pipe(
        Effect.flatMap((client) => client.representative.read({})),
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      ),
    );

    assert.deepEqual(result, { value: 'default-prefix' });
    assert.deepEqual(
      requests.map(({ url }) => url),
      ['https://shell.example/representative-api/read'],
    );
  } finally {
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }
});

test('uses an explicit caller base URL instead of the owner prefix', async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ value: 'override' });
  };

  const result = await Effect.runPromise(
    makeEffectBffClient({
      api: RepresentativeApi,
      baseUrl: new URL('https://owner.example/custom-api'),
      defaultApiPrefix: '/representative-api',
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    ),
  );

  assert.deepEqual(result, { value: 'override' });
  assert.deepEqual(
    requests.map(({ url }) => url),
    ['https://owner.example/custom-api/read'],
  );
});

test('propagates supported request context and resolved transport headers', async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ value: 'context' });
  };
  const operationContext = {
    method: 'GET',
    operationId: 'RepresentativeApi:/read',
    routePath: '/read',
    source: 'generated-client' as const,
  };
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  await Effect.runPromise(
    makeEffectBffClient({
      api: RepresentativeApi,
      baseUrl: 'https://owner.example/representative-api',
      defaultApiPrefix: '/representative-api',
      requestContext: {
        locale: 'cs',
        operationContext,
        traceparent,
      },
      transportHeaders: {
        authorization: 'Bearer owner-resolved-assertion',
        'x-correlation-id': 'correlation-358',
      },
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    ),
  );

  const [request] = requests;
  assert.ok(request);
  assert.equal(request.headers.get('accept-language'), 'cs');
  assert.equal(request.headers.get('traceparent'), traceparent);
  assert.equal(request.headers.get('x-operation-id'), operationContext.operationId);
  assert.deepEqual(
    JSON.parse(request.headers.get('x-modernjs-bff-operation-context') ?? ''),
    operationContext,
  );
  assert.equal(request.headers.get('authorization'), 'Bearer owner-resolved-assertion');
  assert.equal(request.headers.get('x-correlation-id'), 'correlation-358');
});

test('omits absent optional request context and transport header values', async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ value: 'omitted' });
  };

  await Effect.runPromise(
    makeEffectBffClient({
      api: RepresentativeApi,
      baseUrl: 'https://owner.example/representative-api',
      defaultApiPrefix: '/representative-api',
      requestContext: {},
      transportHeaders: [],
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    ),
  );

  const [request] = requests;
  assert.ok(request);
  for (const header of [
    'accept-language',
    'traceparent',
    'x-modernjs-bff-operation-context',
    'x-operation-id',
  ]) {
    assert.equal(request.headers.has(header), false, header);
  }
});

test('keeps declared backend failures in the typed Effect error channel', async () => {
  const problem = {
    _tag: 'RepresentativeConflict' as const,
    detail: 'The representative value changed.',
    status: 409 as const,
    title: 'Representative conflict',
    type: 'urn:ontos:test:representative-conflict',
  };
  const fakeFetch: typeof fetch = async () =>
    Response.json(problem, {
      headers: { 'content-type': 'application/problem+json' },
      status: 409,
    });

  const outcome = await Effect.runPromise(
    makeEffectBffClient({
      api: RepresentativeApi,
      defaultApiPrefix: 'https://owner.example/representative-api',
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.result,
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    ),
  );

  assert.ok(Result.isFailure(outcome));
  assert.deepEqual(outcome.failure, problem);
});

test('keeps transport failures in the typed Effect error channel', async () => {
  const outcome = await Effect.runPromise(
    makeEffectBffClient({
      api: RepresentativeApi,
      defaultApiPrefix: 'https://owner.example/representative-api',
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.result,
      Effect.provideService(FetchHttpClient.Fetch, controlledTransportFailureFetch),
    ),
  );

  assert.ok(Result.isFailure(outcome));
  assert.ok(Predicate.isTagged(outcome.failure, 'HttpClientError'));
});

test('keeps response decoding failures in the typed Effect error channel', async () => {
  const outcome = await Effect.runPromise(
    makeEffectBffClient({
      api: RepresentativeApi,
      defaultApiPrefix: 'https://owner.example/representative-api',
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.result,
      Effect.provideService(FetchHttpClient.Fetch, invalidResponseFetch),
    ),
  );

  assert.ok(Result.isFailure(outcome));
  assert.ok(Predicate.isTagged(outcome.failure, 'SchemaError'));
});
