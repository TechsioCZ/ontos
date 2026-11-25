import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Schema } from 'effect';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  PlatformError,
  Redacted,
} from 'effect';
import type { SymmyNegativeProofFailure, SymmyNegativeProofFetch } from './stage-symmy-negative-proof.mts';

import {
  AKROS_SYMMY_STAGE_ORIGIN,
  loadSymmyNegativeProofConfig,
  parseSymmyNegativeProofArguments,
  runSymmyNegativeProof,
  symmyNegativeProofFailureLine,
} from './stage-symmy-negative-proof.mts';

await using runtime = ManagedRuntime.make(Layer.empty);

const expectFailure = <A, R>(program: Effect.Effect<A, SymmyNegativeProofFailure, R>) =>
  program.pipe(
    Effect.match({ onFailure: (error) => error, onSuccess: () => assert.fail('Expected the proof to fail closed') }),
  );

const keyFileFlag = '--key-file';
const originFlag = '--origin';
const keyFile = '/private/key';
const secret = 'test-only-never-print-this-key';
const missingId = '77777777-7777-4777-8777-777777777777';
const config = { apiKey: Redacted.make(secret), origin: AKROS_SYMMY_STAGE_ORIGIN };
const page = {
  count: 1,
  limit: 1,
  offset: 0,
  orders: [
    {
      createdAt: '2026-11-22T10:00:00.000Z',
      currencyCode: 'CZK',
      customerId: 'persisted-party-9',
      id: 'persisted-order-42',
      lines: [
        {
          productId: 'persisted-product-7',
          productName: 'Private product',
          quantity: 1,
          sku: 'SKU-7',
          totalMinor: 12_100,
          totalVatMinor: 2100,
          unitPriceMinor: 10_000,
          vatRate: 21,
        },
      ],
      number: 'OBJ-2026-0042',
      partyId: 'persisted-party-9',
      pricesIncludeVat: false,
      status: 'NEW',
      totalMinor: 12_100,
      totalNetMinor: 10_000,
      totalVatMinor: 2100,
      updatedAt: '2026-11-22T10:00:00.000Z',
    },
  ],
};
const problemHeaders = { 'content-type': 'application/problem+json' };
const challenge = 'ApiKey realm="ontos-gateway"';
const authProblem = {
  _tag: 'GatewayAuthenticationRequiredProblem',
  detail: 'Key required',
  status: 401,
  title: 'Unauthorized',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
};
const missingProblem = {
  _tag: 'SymmyDemoOrderNotFoundProblem',
  detail: 'Order absent',
  status: 404,
  title: 'Not found',
  type: 'https://ontos.dev/problems/symmy-order-not-found',
};
const fixture = (
  statuses = [401, 401, 404, 200],
  body: Schema.Json = page,
  overrides: Record<number, Response> = {},
) => {
  const calls: { readonly init: RequestInit | undefined; readonly url: string }[] = [];
  const lines: string[] = [];
  const fetch: SymmyNegativeProofFetch = (input, init) =>
    Effect.sync(() => {
      calls.push({ init, url: new Request(input).url });
      const index = calls.length - 1;
      const status = statuses[index] ?? 500;
      const override = overrides[index];
      if (override !== undefined) {
        return override;
      }
      if (index < 2) {
        return Response.json(authProblem, { headers: { ...problemHeaders, 'www-authenticate': challenge }, status });
      }
      if (index === 2) {
        return Response.json(missingProblem, { headers: problemHeaders, status });
      }
      return Response.json(body, { status });
    });
  return {
    calls,
    fetch,
    lines,
    newOrderId: () => missingId,
    writeLine: (line: string) =>
      Effect.sync(() => {
        lines.push(line);
      }),
  };
};

await test('executes only the four GET checks, authenticates only the last two, and prints no data or key', (context) =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      const timeouts: number[] = [];
      const signals: AbortSignal[] = [];
      context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
        timeouts.push(milliseconds);
        const { signal } = new AbortController();
        signals.push(signal);
        return signal;
      });
      const current = fixture();
      yield* runSymmyNegativeProof(config, current);
      assert.deepEqual(
        current.calls.map(({ url }) => url),
        [
          `${config.origin}/api/symmy/v1/orders`,
          `${config.origin}/api/symmy/v1/catalog/revision`,
          `${config.origin}/api/symmy/v1/orders/${missingId}`,
          `${config.origin}/api/symmy/v1/orders?limit=1&offset=0`,
        ],
      );
      for (const [index, { init }] of current.calls.entries()) {
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'manual');
        assert.equal(init?.credentials, 'omit');
        assert.equal(init?.cache, 'no-store');
        assert.equal(init?.referrerPolicy, 'no-referrer');
        assert.equal(init?.signal, signals[index]);
        assert.equal(init?.body, undefined);
        assert.equal(new Headers(init?.headers).get('x-api-key'), index < 2 ? null : secret);
      }
      assert.deepEqual(timeouts, [15_000, 15_000, 15_000, 15_000]);
      assert.deepEqual(current.lines, [
        'PASS orders-unauthenticated status=401',
        'PASS catalog-revision-unauthenticated status=401',
        'PASS missing-order status=404',
        'PASS orders-list status=200',
      ]);
      assert.equal(current.lines.join('\n').includes(secret), false);
      assert.equal(current.lines.join('\n').includes('persisted'), false);
    }),
  ));

await test('requires explicit run/origin/file arguments and refuses N1, storefront, injected paths and credentials', () =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      for (const argv of [
        [],
        [originFlag, config.origin, '--run', keyFileFlag, keyFile],
        ['--run=true', originFlag, config.origin, keyFileFlag, keyFile],
        ['--run', originFlag, config.origin, keyFileFlag, ' '],
        ['--run', originFlag, config.origin, keyFileFlag, keyFile, secret],
      ]) {
        yield* expectFailure(parseSymmyNegativeProofArguments(argv));
      }
      const args = yield* parseSymmyNegativeProofArguments(['--run', originFlag, config.origin, keyFileFlag, keyFile]);
      assert.equal(args.origin, config.origin);
      for (const origin of [
        'https://ontos-stage-n1.web-revolution.cz',
        'https://ontos-stage-akros.web-revolution.cz',
        `${config.origin}/`,
        `${config.origin}/api`,
        `${config.origin}?key=${secret}`,
        'https://user:password@ontos-stage.web-revolution.cz',
        new URL(config.origin).origin.replace('https:', 'http:'),
      ]) {
        let reads = 0;
        yield* expectFailure(
          loadSymmyNegativeProofConfig({ keyFile, origin }).pipe(
            Effect.provide(
              FileSystem.layerNoop({
                readFileString: () =>
                  Effect.sync(() => {
                    reads += 1;
                    return secret;
                  }),
              }),
            ),
          ),
        );
        assert.equal(reads, 0);
      }
    }),
  ));

await test('reads a key only when explicitly loading configuration and sanitizes file errors', () =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      let reads = 0;
      const loaded = yield* loadSymmyNegativeProofConfig({ keyFile, origin: config.origin }).pipe(
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.sync(() => {
                reads += 1;
                return `${secret}\n`;
              }),
          }),
        ),
      );
      assert.equal(reads, 1);
      assert.equal(Redacted.value(loaded.apiKey), secret);
      for (const key of ['', 'white space', 'a\0b', 'a\u007Fb', 'a'.repeat(4097)]) {
        const invalid = yield* expectFailure(
          loadSymmyNegativeProofConfig({ keyFile, origin: config.origin }).pipe(
            Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(key) })),
          ),
        );
        assert.equal(symmyNegativeProofFailureLine(invalid), 'FAIL configuration status=none reason=invalid_key');
      }
      for (const key of ['a'.repeat(4096), 'unicode-😀-\u0080']) {
        const valid = yield* loadSymmyNegativeProofConfig({ keyFile, origin: config.origin }).pipe(
          Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(key) })),
        );
        assert.equal(Redacted.value(valid.apiKey), key);
      }
      const failure = yield* expectFailure(
        loadSymmyNegativeProofConfig({ keyFile: `/private/${secret}`, origin: config.origin }).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFileString: () =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: 'Unknown',
                    description: secret,
                    method: 'readFileString',
                    module: 'FileSystem',
                  }),
                ),
            }),
          ),
        ),
      );
      assert.equal(symmyNegativeProofFailureLine(failure), 'FAIL configuration status=none reason=key_file_unreadable');
    }),
  ));

await test('fails closed on redirects and unexpected auth/detail statuses without reading or printing response bodies', () =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      for (const statuses of [[302], [200], [401, 403], [401, 401, 200], [401, 401, 404, 503]]) {
        let cancellations = 0;
        const stream = new ReadableStream<Uint8Array>({
          cancel: () => {
            cancellations += 1;
          },
        });
        const index = statuses.length - 1;
        const current = fixture(statuses, { secret }, { [index]: new Response(stream, { status: statuses[index] }) });
        const error = yield* expectFailure(runSymmyNegativeProof(config, current));
        {
          const line = symmyNegativeProofFailureLine(error);
          assert.equal(line.includes(secret), false);
          assert.match(line, /^FAIL [a-z-]+ status=\d+ reason=(?:redirect_refused|unexpected_status)$/u);
        }
        assert.equal(current.calls.length, statuses.length);
        assert.equal(current.lines.length, statuses.length - 1);
        assert.equal(cancellations, 1);
        assert.equal(stream.locked, false);
      }
    }),
  ));

await test('requires schema-valid nonempty persisted identifiers, not merely a 200 response', () =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      for (const body of [
        {},
        { ...page, count: 0, orders: [] },
        { ...page, orders: [{ ...page.orders[0], id: '' }] },
        { ...page, orders: [{ ...page.orders[0], customerId: 'different-party' }] },
        { ...page, limit: 50 },
        { ...page, offset: 1 },
      ]) {
        const error = yield* expectFailure(runSymmyNegativeProof(config, fixture(undefined, body)));
        assert.match(
          symmyNegativeProofFailureLine(error),
          /^FAIL orders-list status=200 reason=(?:response_invalid|orders_empty)$/u,
        );
      }
    }),
  ));

await test('rejects unrelated 401/404 responses and a missing or foreign challenge without leaking their bodies', () =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      for (const [index, response] of [
        [0, Response.json(authProblem, { headers: problemHeaders, status: 401 })],
        [1, Response.json(authProblem, { headers: { ...problemHeaders, 'www-authenticate': 'Bearer' }, status: 401 })],
        [
          0,
          Response.json(
            { ...authProblem, _tag: 'Other', detail: secret },
            {
              headers: { ...problemHeaders, 'www-authenticate': challenge },
              status: 401,
            },
          ),
        ],
        [2, new Response('Not found', { status: 404 })],
        [
          2,
          Response.json({ ...missingProblem, _tag: 'Other', detail: secret }, { headers: problemHeaders, status: 404 }),
        ],
        [2, Response.json({ ...missingProblem, status: 401 }, { headers: problemHeaders, status: 404 })],
        [0, new Response(secret, { headers: { ...problemHeaders, 'www-authenticate': challenge }, status: 401 })],
        [0, new Response(null, { headers: { ...problemHeaders, 'www-authenticate': challenge }, status: 401 })],
        [
          0,
          Response.json(
            { ...authProblem, detail: secret.repeat(40_000) },
            {
              headers: { ...problemHeaders, 'www-authenticate': challenge },
              status: 401,
            },
          ),
        ],
      ] as const) {
        const current = fixture(undefined, page, { [index]: response });
        const check = ['orders-unauthenticated', 'catalog-revision-unauthenticated', 'missing-order'][index];
        const error = yield* expectFailure(runSymmyNegativeProof(config, current));
        assert.equal(
          symmyNegativeProofFailureLine(error),
          `FAIL ${check} status=${String(response.status)} reason=response_invalid`,
        );
        assert.equal(current.calls.length, index + 1);
        assert.equal(response.body?.locked ?? false, false);
      }
    }),
  ));

await test('sanitizes network errors and refuses an invalid generated selector before sending any requests', () =>
  runtime.runPromise(
    Effect.gen(function* proofTest() {
      const current = fixture();
      yield* expectFailure(runSymmyNegativeProof(config, { ...current, newOrderId: () => secret }));
      assert.equal(current.calls.length, 0);
      const fetch: SymmyNegativeProofFetch = () => Effect.fail(new Error(secret));
      const error = yield* expectFailure(runSymmyNegativeProof(config, { ...current, fetch }));
      assert.equal(
        symmyNegativeProofFailureLine(error),
        'FAIL orders-unauthenticated status=none reason=network_failed',
      );
      assert.equal(
        symmyNegativeProofFailureLine(new Error(secret)),
        'FAIL configuration status=none reason=unexpected_failure',
      );
    }),
  ));

await test(
  'aborts the actual authenticated fetch boundary on fiber interruption or its 15-second deadline',
  { timeout: 2000 },
  (context) =>
    runtime.runPromise(
      Effect.gen(function* abortFetch() {
        for (const interruption of ['fiber', 'deadline']) {
          const started = yield* Deferred.make<boolean>();
          const pending = Promise.withResolvers<Response>();
          const deadline = new AbortController();
          const calls: { readonly init: RequestInit | undefined; readonly url: string }[] = [];
          const lines: string[] = [];
          const timeouts: number[] = [];
          context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
            timeouts.push(milliseconds);
            return deadline.signal;
          });
          context.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            calls.push({ init, url: new Request(input).url });
            if (calls.length < 3) {
              return Promise.resolve(
                Response.json(authProblem, {
                  headers: { ...problemHeaders, 'www-authenticate': challenge },
                  status: 401,
                }),
              );
            }
            init?.signal?.addEventListener(
              'abort',
              () => {
                pending.reject(new Error(secret));
              },
              { once: true },
            );
            Deferred.doneUnsafe(started, Effect.succeed(true));
            return pending.promise;
          });
          const fiber = yield* Effect.forkChild(
            runSymmyNegativeProof(config, {
              newOrderId: () => missingId,
              writeLine: (line) =>
                Effect.sync(() => {
                  lines.push(line);
                }),
            }),
          );
          yield* Deferred.await(started);
          assert.equal(new Headers(calls[2]?.init?.headers).get('x-api-key'), secret);
          if (interruption === 'fiber') {
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            assert.ok(Exit.isFailure(exit));
            assert.equal(Cause.hasInterruptsOnly(exit.cause), true);
            assert.equal(deadline.signal.aborted, false);
          } else {
            deadline.abort();
            const failure = yield* expectFailure(Fiber.join(fiber));
            assert.equal(
              symmyNegativeProofFailureLine(failure),
              'FAIL missing-order status=none reason=network_failed',
            );
          }
          assert.equal(calls[2]?.init?.signal?.aborted, true);
          assert.deepEqual(timeouts, [15_000, 15_000, 15_000]);
          assert.equal(calls.length, 3);
          assert.deepEqual(lines, [
            'PASS orders-unauthenticated status=401',
            'PASS catalog-revision-unauthenticated status=401',
          ]);
        }
      }),
    ),
);

await test('cancels an interrupted authenticated response reader before releasing its lock', { timeout: 2000 }, () =>
  runtime.runPromise(
    Effect.gen(function* interruptBody() {
      const reading = yield* Deferred.make<boolean>();
      const cancellations: boolean[] = [];
      const stream = new ReadableStream<Uint8Array>(
        {
          cancel: () => {
            cancellations.push(stream.locked);
          },
          pull: () => {
            Deferred.doneUnsafe(reading, Effect.succeed(true));
          },
        },
        { highWaterMark: 0 },
      );
      const current = fixture(undefined, page, { 2: new Response(stream, { headers: problemHeaders, status: 404 }) });
      const fiber = yield* Effect.forkChild(runSymmyNegativeProof(config, current));
      yield* Deferred.await(reading);
      assert.equal(stream.locked, true);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.ok(Exit.isFailure(exit));
      assert.equal(Cause.hasInterruptsOnly(exit.cause), true);
      assert.deepEqual(cancellations, [true]);
      assert.equal(stream.locked, false);
      assert.equal(current.calls.length, 3);
      assert.equal(current.lines.length, 2);
    }),
  ),
);

await test('cancels a response over the byte limit before releasing its reader and stops immediately', () =>
  runtime.runPromise(
    Effect.gen(function* oversizedBody() {
      const cancellations: boolean[] = [];
      const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancellations.push(stream.locked);
        },
        start: (controller) => {
          controller.enqueue(new Uint8Array(1_000_001));
        },
      });
      const current = fixture(undefined, page, {
        0: new Response(stream, {
          headers: { ...problemHeaders, 'www-authenticate': challenge },
          status: 401,
        }),
      });
      const failure = yield* expectFailure(runSymmyNegativeProof(config, current));
      assert.equal(
        symmyNegativeProofFailureLine(failure),
        'FAIL orders-unauthenticated status=401 reason=response_invalid',
      );
      assert.deepEqual(cancellations, [true]);
      assert.equal(stream.locked, false);
      assert.equal(current.calls.length, 1);
      assert.deepEqual(current.lines, []);
    }),
  ));
