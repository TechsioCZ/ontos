import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpRouter,
  HttpServer,
} from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Predicate, Schema, SchemaAST, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '../../src/problem-details.ts';
import { ImportedUnconstrainedExtensionSchema } from '../fixtures/unconstrained-extension.ts';

const statuses = [400, 401, 403, 404, 409, 422, 428, 429, 500, 503, 504] as const;

for (const status of statuses) {
  it(`couples the ${status} body, schema, and HttpApi status`, () => {
    const schema = makeProblemDetailsSchema(`FixtureProblem${status}`, status, {
      recoveryCode: Schema.Literal(`RECOVER_${status}`),
    });
    const problem = {
      _tag: `FixtureProblem${status}`,
      detail: `Fixture ${status} detail`,
      recoveryCode: `RECOVER_${status}`,
      status,
      title: `Fixture ${status}`,
      type: `urn:ontos:test:problem:${status}`,
    } as const;

    const decodedProblem = Schema.decodeSync(schema)(problem);
    expect(Schema.is(schema)(decodedProblem)).toBe(true);
    expect(Struct.omit(decodedProblem, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
    const encodedProblem = Schema.encodeUnknownSync(schema)(problem);
    expect(Schema.is(Schema.toEncoded(schema))(encodedProblem)).toBe(true);
    expect(Struct.omit(encodedProblem, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
    expect(schema.ast.annotations?.['httpApiStatus']).toBe(status);
    const encoding = schema.ast.annotations?.['~httpApiEncoding'];
    expect(Predicate.isTagged(encoding, 'Json')).toBe(true);
    if (!Predicate.isTagged(encoding, 'Json')) {
      throw new Error('Expected JSON HTTP API encoding');
    }
    expect(Struct.omit(encoding, ['_tag'])).toEqual({
      contentType: 'application/problem+json',
    });
    expect(() => Schema.decodeUnknownSync(schema)({ ...problem, status: 418 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({
        ...problem,
        internalDiagnostic: 'must-not-pass',
      }),
    ).toThrow();
  });
}

it('adds only the deliberate retryable literal marker', () => {
  const schema = makeRetryableProblemDetailsSchema('RetryableFixtureProblem', 503, {
    retryAfterSeconds: Schema.Finite,
  });
  const problem = {
    _tag: 'RetryableFixtureProblem',
    detail: 'Try later.',
    retryable: true,
    retryAfterSeconds: 5,
    status: 503,
    title: 'Temporarily unavailable',
    type: 'urn:ontos:test:retryable',
  } as const;

  const decodedProblem = Schema.decodeSync(schema)(problem);
  expect(Schema.is(schema)(decodedProblem)).toBe(true);
  expect(Struct.omit(decodedProblem, ['_tag'])).toEqual(Struct.omit(problem, ['_tag']));
  expect(() => Schema.decodeUnknownSync(schema)({ ...problem, retryable: false })).toThrow();
});

it.live('drives real HttpApi responses and generated client decoding', () =>
  Effect.gen(function* problemDetailsHttpScenario() {
    const schema = makeRetryableProblemDetailsSchema('FixtureGatewayTimeoutProblem', 504, {
      operation: Schema.Literal('fixture-read'),
    });
    const problem = schema.make({
      detail: 'The fixture operation timed out.',
      operation: 'fixture-read',
      retryable: true,
      status: 504,
      title: 'Fixture timeout',
      type: 'urn:ontos:test:fixture-timeout',
    });
    const group = HttpApiGroup.make('problemFixture').add(
      HttpApiEndpoint.post('execute', '/problem-fixture', {
        error: [schema],
        payload: Schema.Struct({}),
        success: Schema.Struct({ ok: Schema.Literal(true) }),
      }),
    );
    const api = HttpApi.make('ProblemFixtureApi').add(group);
    const handlers = HttpApiBuilder.group(api, 'problemFixture', (builder) =>
      builder.handle('execute', () => Effect.fail(problem)),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
          { disableLogger: true },
        ),
      ),
      (webHandler) => Effect.promise(() => webHandler.dispose()),
    );

    const request = new Request('https://fixture.ontos.test/problem-fixture', {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const response = yield* Effect.promise(() => server.handler(request, Context.empty()));
    expect(response.status).toBe(problem.status);
    expect(response.headers.get('content-type') ?? '').toMatch(/^application\/problem\+json\b/u);
    expect(yield* Effect.promise(() => response.json())).toEqual(problem);

    const client = makeEffectHttpApiClient(api, {
      baseUrl: 'https://fixture.ontos.test',
    });
    const clientError = yield* Effect.flip(
      client.pipe(
        Effect.flatMap((generated) => generated.problemFixture.execute({ payload: {} })),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
          server.handler(new Request(input, init), Context.empty()),
        ),
      ),
    );
    expect(clientError).toEqual(problem);
  }),
);

it('rejects reserved and unconstrained extension schemas at construction', () => {
  const uniqueSymbol = Symbol('problem-detail-extension');
  const nestedUniqueSymbol = Symbol('nested-problem-detail-extension');
  expect(() =>
    makeProblemDetailsSchema('ReservedFixtureProblem', 400, {
      status: Schema.Finite,
    }),
  ).toThrow(/reserved/u);
  expect(() =>
    makeProblemDetailsSchema('PrototypeSyntaxFixtureProblem', 400, {
      __proto__: Schema.String,
    }),
  ).toThrow(/plain object/u);
  expect(() =>
    makeProblemDetailsSchema('SymbolKeyFixtureProblem', 400, {
      [uniqueSymbol]: Schema.Unknown,
    }),
  ).toThrow(/names must be strings/u);
  expect(() =>
    makeProblemDetailsSchema('PrototypeKeyFixtureProblem', 400, {
      ['__proto__']: Schema.String,
    }),
  ).toThrow(/reserved/u);
  expect(() =>
    makeProblemDetailsSchema('UnknownFixtureProblem', 400, {
      unsafe: Schema.Unknown,
    }),
  ).toThrow(/concrete/u);
  expect(() =>
    makeProblemDetailsSchema('AnyFixtureProblem', 400, {
      unsafe: Schema.Any,
    }),
  ).toThrow(/concrete/u);
  for (const unsafe of [
    Schema.Array(Schema.Unknown),
    Schema.BigInt,
    Schema.Enum({ Invalid: Number.POSITIVE_INFINITY }),
    Schema.Enum({ Invalid: Number.NaN }),
    Schema.Literal(1n),
    Schema.Json,
    // @effect-diagnostics-next-line schemaNumber:off -- Bare Number is intentionally supplied to prove the helper rejects non-finite JSON values.
    Schema.Number,
    Schema.Record(Schema.String, Schema.String),
    Schema.Symbol,
    Schema.Struct({ nested: Schema.Unknown }),
    Schema.Struct({ [nestedUniqueSymbol]: Schema.String }),
    Schema.Struct({ ['__proto__']: Schema.String }),
    Schema.UniqueSymbol(uniqueSymbol),
    Schema.Undefined,
    ImportedUnconstrainedExtensionSchema,
  ]) {
    expect(() => makeProblemDetailsSchema('NestedUnknownFixtureProblem', 400, { unsafe })).toThrow(/concrete/u);
  }
  for (const literal of [undefined, Symbol('non-json-literal')]) {
    // @ts-expect-error JavaScript callers can provide unsupported literal values, so the runtime factory must still reject them.
    const unsafe = Schema.Literal(literal);
    expect(() => makeProblemDetailsSchema('NonJsonLiteralFixtureProblem', 400, { unsafe })).toThrow(/concrete/u);
  }
});

it('rejects accessor-backed extension fields before reading them', () => {
  let reads = 0;
  const extensions = Object.defineProperty({}, 'diagnostics', {
    enumerable: true,
    get: () => {
      reads += 1;
      return reads === 1 ? Schema.String : Schema.Unknown;
    },
  });

  expect(() => makeProblemDetailsSchema('AccessorFixtureProblem', 400, extensions)).toThrow(
    /enumerable data property/u,
  );
  expect(reads).toBe(0);
});

it('uses one descriptor snapshot for extension keys and schema ASTs', () => {
  let ownKeyReads = 0;
  const changingFields = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: (_target, key) => ({
        configurable: true,
        enumerable: true,
        value: key === 'status' ? Schema.Finite : Schema.Unknown,
        writable: true,
      }),
      ownKeys: () => {
        ownKeyReads += 1;
        return ownKeyReads === 1 ? [] : ['status', Symbol('unsafe')];
      },
    },
  );
  const stableSchema = makeProblemDetailsSchema('StableSnapshotProblem', 400, changingFields);
  expect(ownKeyReads).toBe(1);
  expect(() =>
    Schema.decodeUnknownSync(stableSchema)({
      _tag: 'StableSnapshotProblem',
      detail: 'Wrong status.',
      status: 418,
      title: 'Wrong status',
      type: 'urn:ontos:test:wrong-status',
    }),
  ).toThrow();

  let astReads = 0;
  const changingSchema = new Proxy(Schema.Unknown, {
    get: (target, key, receiver) => {
      if (key === 'ast') {
        astReads += 1;
        return astReads === 1 ? Schema.String.ast : Schema.Unknown.ast;
      }
      // eslint-disable-next-line anti-slop/no-reflect-get -- The adversarial proxy must faithfully forward every non-AST Schema property.
      return Reflect.get(target, key, receiver);
    },
  });
  expect(() =>
    makeProblemDetailsSchema('StableAstProblem', 400, {
      diagnostics: changingSchema,
    }),
  ).toThrow(/concrete/u);

  const mutableExtension = Schema.Struct({ note: Schema.String });
  const immutableProblem = makeProblemDetailsSchema('ImmutableAstProblem', 400, {
    metadata: mutableExtension,
  });
  expect(SchemaAST.isObjects(mutableExtension.ast)).toBe(true);
  const [note] = mutableExtension.ast.propertySignatures;
  expect(note).toBeDefined();
  if (note === undefined) {
    return;
  }
  Reflect.set(note, 'type', Schema.Unknown.ast);
  expect(() =>
    Schema.decodeUnknownSync(immutableProblem)({
      _tag: 'ImmutableAstProblem',
      detail: 'Must stay concrete.',
      metadata: { note: { internal: 'must not decode' } },
      status: 400,
      title: 'Immutable AST',
      type: 'urn:ontos:test:immutable-ast',
    }),
  ).toThrow();
});

it('accepts concrete JSON literals and schemas with JSON-safe encodings', () => {
  const schema = makeProblemDetailsSchema('EncodedExtensionsProblem', 422, {
    amount: Schema.FiniteFromString,
    attachment: Schema.Uint8ArrayFromBase64,
    count: Schema.BigIntFromString,
    occurredAt: Schema.DateFromString,
    // @ts-expect-error Effect's runtime Literal AST supports JSON null although its public LiteralValue type omits it.
    optionalMarker: Schema.Literal(null),
  });
  const encoded = {
    _tag: 'EncodedExtensionsProblem',
    amount: '12.5',
    attachment: 'AQI=',
    count: '7',
    detail: 'Encoded extensions.',
    occurredAt: '2026-09-07T12:00:00.000Z',
    optionalMarker: null,
    status: 422,
    title: 'Encoded extensions',
    type: 'urn:ontos:test:encoded-extensions',
  } as const;
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  expect(decoded.amount).toBe(12.5);
  expect(decoded.attachment).toEqual(new Uint8Array([1, 2]));
  expect(decoded.count).toBe(7n);
  expect(decoded.occurredAt.toISOString()).toBe(encoded.occurredAt);
  const reencoded = Schema.encodeUnknownSync(schema)(decoded);
  expect(Schema.is(Schema.toEncoded(schema))(reencoded)).toBe(true);
  expect(Struct.omit(reencoded, ['_tag'])).toEqual(Struct.omit(encoded, ['_tag']));
});

const narrowSchema = makeProblemDetailsSchema('NarrowFixtureProblem', 409, {
  resolution: Schema.Literal('REFRESH'),
});
type NarrowProblem = typeof narrowSchema.Type;
const narrowProblem: NarrowProblem = {
  _tag: 'NarrowFixtureProblem',
  detail: 'Refresh the resource.',
  resolution: 'REFRESH',
  status: 409,
  title: 'Conflict',
  type: 'urn:ontos:test:narrow',
};
void narrowProblem;
// @ts-expect-error The endpoint-specific tag must remain literal.
const wrongTag: NarrowProblem = { ...narrowProblem, _tag: 'OtherProblem' };
// @ts-expect-error The status must remain literal and match the constructor status.
const wrongStatus: NarrowProblem = { ...narrowProblem, status: 422 };
// @ts-expect-error Extension members must retain their literal types.
const wrongExtension: NarrowProblem = { ...narrowProblem, resolution: 'RETRY' };
void wrongTag;
void wrongStatus;
void wrongExtension;
// @ts-expect-error Unsupported Problem Details statuses cannot be constructed.
makeProblemDetailsSchema('UnsupportedStatusProblem', 418);
