import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { Predicate, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

const RepresentativeConflictSchema = Schema.TaggedStruct(
  'RepresentativeConflict',
  {
    detail: Schema.String,
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  }
).pipe(
  HttpApiSchema.asJson({ contentType: 'application/problem+json' }),
  HttpApiSchema.status(409)
);

const RepresentativeApi = HttpApi.make('RepresentativeApi').add(
  HttpApiGroup.make('representative').add(
    HttpApiEndpoint.get('read', '/read', {
      error: RepresentativeConflictSchema,
      success: Schema.Struct({ value: Schema.String }),
    })
  )
);

const controlledTransportFailureFetch: typeof fetch = () =>
  Promise.reject(new TypeError('controlled transport failure'));
const invalidResponseFetch: typeof fetch = () =>
  Promise.resolve(Response.json({ value: 358 }));

const representativeClientEffect = makeEffectBffClient({
  api: RepresentativeApi,
  defaultApiPrefix: '/representative-api',
});
type RepresentativeClient = Effect.Success<typeof representativeClientEffect>;
type RepresentativeReadEffect = ReturnType<
  RepresentativeClient['representative']['read']
>;
type RepresentativeReadSuccess = Effect.Success<RepresentativeReadEffect>;
type RepresentativeReadError = Effect.Error<RepresentativeReadEffect>;

const preserveRepresentativeReadType = (
  client: RepresentativeClient
): RepresentativeReadEffect => client.representative.read({});
const preserveRepresentativeSuccessType = (
  success: RepresentativeReadSuccess
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

it.effect('constructs fresh typed clients lazily as Effect values', () =>
  Effect.gen(function* testScenario1() {
    const clientEffect = makeEffectBffClient({
      api: RepresentativeApi,
      defaultApiPrefix: 'https://owner.example/representative-api',
    });
    expect(Effect.isEffect(clientEffect)).toBe(true);

    const first = yield* clientEffect;
    const second = yield* clientEffect;

    expect(first).not.toBe(second);
    expect(Effect.isEffect(first.representative.read({}))).toBe(true);
  })
);

it.effect('uses the owner-supplied API prefix by default', () =>
  Effect.gen(function* testScenario2() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json({ value: 'default-prefix' }));
    };
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (location === undefined) {
          Reflect.deleteProperty(globalThis, 'location');
        } else {
          Object.defineProperty(globalThis, 'location', location);
        }
      })
    );
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://shell.example', pathname: '/en' },
    });

    const result = yield* makeEffectBffClient({
      api: RepresentativeApi,
      defaultApiPrefix: '/representative-api',
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
    );

    expect(result).toEqual({ value: 'default-prefix' });
    expect(requests.map(({ url }) => url)).toEqual([
      'https://shell.example/representative-api/read',
    ]);
  })
);

it.effect('uses an explicit caller base URL instead of the owner prefix', () =>
  Effect.gen(function* testScenario3() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json({ value: 'override' }));
    };

    const result = yield* makeEffectBffClient({
      api: RepresentativeApi,
      baseUrl: new URL('https://owner.example/custom-api'),
      defaultApiPrefix: '/representative-api',
    }).pipe(
      Effect.flatMap((client) => client.representative.read({})),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
    );

    expect(result).toEqual({ value: 'override' });
    expect(requests.map(({ url }) => url)).toEqual([
      'https://owner.example/custom-api/read',
    ]);
  })
);

it.effect(
  'propagates supported request context and resolved transport headers',
  () =>
    Effect.gen(function* testScenario4() {
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({ value: 'context' }));
      };
      const operationContext = {
        method: 'GET',
        operationId: 'RepresentativeApi:/read',
        routePath: '/read',
        source: 'generated-client' as const,
      };
      const traceparent =
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

      yield* makeEffectBffClient({
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
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      );

      const [request] = requests;
      expect(request).toBeDefined();
      if (request === undefined) {
        throw new Error('Expected captured request');
      }
      expect(request.headers.get('accept-language')).toBe('cs');
      expect(request.headers.get('traceparent')).toBe(traceparent);
      expect(request.headers.get('x-operation-id')).toBe(
        operationContext.operationId
      );
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Unknown)
        )(request.headers.get('x-modernjs-bff-operation-context') ?? '')
      ).toEqual(operationContext);
      expect(request.headers.get('authorization')).toBe(
        'Bearer owner-resolved-assertion'
      );
      expect(request.headers.get('x-correlation-id')).toBe('correlation-358');
    })
);

it.effect(
  'omits absent optional request context and transport header values',
  () =>
    Effect.gen(function* testScenario5() {
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({ value: 'omitted' }));
      };

      yield* makeEffectBffClient({
        api: RepresentativeApi,
        baseUrl: 'https://owner.example/representative-api',
        defaultApiPrefix: '/representative-api',
        requestContext: {},
        transportHeaders: [],
      }).pipe(
        Effect.flatMap((client) => client.representative.read({})),
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      );

      const [request] = requests;
      expect(request).toBeDefined();
      if (request === undefined) {
        throw new Error('Expected captured request');
      }
      for (const header of [
        'accept-language',
        'traceparent',
        'x-modernjs-bff-operation-context',
        'x-operation-id',
      ]) {
        expect(request.headers.has(header), header).toBe(false);
      }
    })
);

it.effect(
  'keeps declared backend failures in the typed Effect error channel',
  () =>
    Effect.gen(function* testScenario6() {
      const problem = {
        _tag: 'RepresentativeConflict' as const,
        detail: 'The representative value changed.',
        status: 409 as const,
        title: 'Representative conflict',
        type: 'urn:ontos:test:representative-conflict',
      };
      const fakeFetch: typeof fetch = () =>
        Promise.resolve(
          Response.json(problem, {
            headers: { 'content-type': 'application/problem+json' },
            status: 409,
          })
        );

      const outcome = yield* makeEffectBffClient({
        api: RepresentativeApi,
        defaultApiPrefix: 'https://owner.example/representative-api',
      }).pipe(
        Effect.flatMap((client) => client.representative.read({})),
        Effect.flip,
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      );

      expect(Schema.is(RepresentativeConflictSchema)(outcome)).toBe(true);
      expect(Struct.omit(outcome, ['_tag'])).toEqual(
        Struct.omit(problem, ['_tag'])
      );
    })
);

for (const [failureKind, transport, expectedTag] of [
  ['transport', controlledTransportFailureFetch, 'HttpClientError'],
  ['response decoding', invalidResponseFetch, 'SchemaError'],
] as const) {
  it.effect(
    `keeps ${failureKind} failures in the typed Effect error channel`,
    () =>
      Effect.gen(function* typedClientFailure() {
        const outcome = yield* makeEffectBffClient({
          api: RepresentativeApi,
          defaultApiPrefix: 'https://owner.example/representative-api',
        }).pipe(
          Effect.flatMap((client) => client.representative.read({})),
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, transport)
        );
        expect(Predicate.isTagged(outcome, expectedTag)).toBe(true);
      })
  );
}
