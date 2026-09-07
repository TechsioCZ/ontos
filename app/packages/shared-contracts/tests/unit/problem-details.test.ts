// @effect-diagnostics asyncFunction:off -- Node test callbacks and Web handlers bridge the Effect contracts under test; expires: 2027-03-31.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpRouter,
  HttpServer,
} from '@modern-js/plugin-bff/effect-edge';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Context, Effect, Layer, Result, Schema, SchemaAST } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  makeProblemDetailsSchema,
  makeRetryableProblemDetailsSchema,
} from '../../src/problem-details.ts';
import { ImportedUnconstrainedExtensionSchema } from '../fixtures/unconstrained-extension.ts';

const statuses = [400, 401, 403, 404, 409, 422, 428, 429, 500, 503, 504] as const;

for (const status of statuses) {
  void test(`couples the ${status} body, schema, and HttpApi status`, () => {
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

    assert.deepEqual(Schema.decodeUnknownSync(schema)(problem), problem);
    assert.deepEqual(Schema.encodeUnknownSync(schema)(problem), problem);
    assert.equal(schema.ast.annotations?.['httpApiStatus'], status);
    assert.deepEqual(schema.ast.annotations?.['~httpApiEncoding'], {
      _tag: 'Json',
      contentType: 'application/problem+json',
    });
    assert.throws(() => Schema.decodeUnknownSync(schema)({ ...problem, status: 418 }));
    assert.throws(() =>
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({
        ...problem,
        internalDiagnostic: 'must-not-pass',
      }),
    );
  });
}

void test('adds only the deliberate retryable literal marker', () => {
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

  assert.deepEqual(Schema.decodeUnknownSync(schema)(problem), problem);
  assert.throws(() => Schema.decodeUnknownSync(schema)({ ...problem, retryable: false }));
});

void test('drives real HttpApi responses and generated client decoding', async () => {
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
  const server = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  try {
    const request = new Request('https://fixture.ontos.test/problem-fixture', {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const response = await server.handler(request, Context.empty());
    assert.equal(response.status, problem.status);
    assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json\b/u);
    assert.deepEqual(await response.json(), problem);

    const client = makeEffectHttpApiClient(api, { baseUrl: 'https://fixture.ontos.test' });
    const clientResult = await runEffectTestPromise(
      client.pipe(
        Effect.flatMap((generated) => generated.problemFixture.execute({ payload: {} })),
        Effect.result,
        Effect.provideService(
          FetchHttpClient.Fetch,
          async (input, init) => await server.handler(new Request(input, init), Context.empty()),
        ),
      ),
    );
    assert.ok(Result.isFailure(clientResult));
    assert.deepEqual(clientResult.failure, problem);
  } finally {
    await server.dispose();
  }
});

void test('rejects reserved and unconstrained extension schemas at construction', () => {
  const uniqueSymbol = Symbol('problem-detail-extension');
  const nestedUniqueSymbol = Symbol('nested-problem-detail-extension');
  assert.throws(
    () =>
      makeProblemDetailsSchema('ReservedFixtureProblem', 400, {
        status: Schema.Finite,
      }),
    /reserved/u,
  );
  assert.throws(
    () =>
      makeProblemDetailsSchema('PrototypeSyntaxFixtureProblem', 400, { __proto__: Schema.String }),
    /plain object/u,
  );
  assert.throws(
    () =>
      makeProblemDetailsSchema('SymbolKeyFixtureProblem', 400, {
        [uniqueSymbol]: Schema.Unknown,
      }),
    /names must be strings/u,
  );
  assert.throws(
    () =>
      makeProblemDetailsSchema('PrototypeKeyFixtureProblem', 400, {
        ['__proto__']: Schema.String,
      }),
    /reserved/u,
  );
  assert.throws(
    () =>
      makeProblemDetailsSchema('UnknownFixtureProblem', 400, {
        unsafe: Schema.Unknown,
      }),
    /concrete/u,
  );
  assert.throws(
    () =>
      makeProblemDetailsSchema('AnyFixtureProblem', 400, {
        unsafe: Schema.Any,
      }),
    /concrete/u,
  );
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
    assert.throws(
      () => makeProblemDetailsSchema('NestedUnknownFixtureProblem', 400, { unsafe }),
      /concrete/u,
    );
  }
  for (const literal of [undefined, Symbol('non-json-literal')]) {
    // @ts-expect-error JavaScript callers can provide unsupported literal values, so the runtime factory must still reject them.
    const unsafe = Schema.Literal(literal);
    assert.throws(
      () => makeProblemDetailsSchema('NonJsonLiteralFixtureProblem', 400, { unsafe }),
      /concrete/u,
    );
  }
});

void test('rejects accessor-backed extension fields before reading them', () => {
  let reads = 0;
  const extensions = Object.defineProperty({}, 'diagnostics', {
    enumerable: true,
    get: () => {
      reads += 1;
      return reads === 1 ? Schema.String : Schema.Unknown;
    },
  });

  assert.throws(
    () => makeProblemDetailsSchema('AccessorFixtureProblem', 400, extensions),
    /enumerable data property/u,
  );
  assert.equal(reads, 0);
});

void test('uses one descriptor snapshot for extension keys and schema ASTs', () => {
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
  assert.equal(ownKeyReads, 1);
  assert.throws(() =>
    Schema.decodeUnknownSync(stableSchema)({
      _tag: 'StableSnapshotProblem',
      detail: 'Wrong status.',
      status: 418,
      title: 'Wrong status',
      type: 'urn:ontos:test:wrong-status',
    }),
  );

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
  assert.throws(
    () =>
      makeProblemDetailsSchema('StableAstProblem', 400, {
        diagnostics: changingSchema,
      }),
    /concrete/u,
  );

  const mutableExtension = Schema.Struct({ note: Schema.String });
  const immutableProblem = makeProblemDetailsSchema('ImmutableAstProblem', 400, {
    metadata: mutableExtension,
  });
  assert.ok(SchemaAST.isObjects(mutableExtension.ast));
  const [note] = mutableExtension.ast.propertySignatures;
  assert.ok(note !== undefined);
  Reflect.set(note, 'type', Schema.Unknown.ast);
  assert.throws(() =>
    Schema.decodeUnknownSync(immutableProblem)({
      _tag: 'ImmutableAstProblem',
      detail: 'Must stay concrete.',
      metadata: { note: { internal: 'must not decode' } },
      status: 400,
      title: 'Immutable AST',
      type: 'urn:ontos:test:immutable-ast',
    }),
  );
});

void test('accepts concrete JSON literals and schemas with JSON-safe encodings', () => {
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
  assert.equal(decoded.amount, 12.5);
  assert.deepEqual(decoded.attachment, new Uint8Array([1, 2]));
  assert.equal(decoded.count, 7n);
  assert.equal(decoded.occurredAt.toISOString(), encoded.occurredAt);
  assert.deepEqual(Schema.encodeUnknownSync(schema)(decoded), encoded);
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
