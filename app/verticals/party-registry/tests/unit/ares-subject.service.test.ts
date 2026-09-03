// @effect-diagnostics asyncFunction:off strictEffectProvide:off
/* eslint-disable no-await-in-loop -- Ordered provider scenarios verify isolated cache and retry state. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Fiber, Layer, Logger } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http';
import type { HttpClientRequest } from 'effect/unstable/http';
import {
  AresSubjectService,
  AresSubjectServiceLive,
} from '../../src/integrations/ares/ares-subject.service.ts';

type HttpRunner = Parameters<typeof HttpClient.make>[0];

const rawSubject = (ico = '48039101') => ({
  datumAktualizace: '2026-09-01',
  datumVzniku: '1992-12-04',
  datumZaniku: null,
  dic: 'CZ48039101',
  ico,
  icoId: 'provider-record-123',
  obchodniJmeno: 'J.E.S., spol. s r.o.',
  pravniForma: '112',
  sidlo: {
    cisloDomovni: 10,
    kodStatu: 'CZ',
    nazevObce: 'Praha',
    nazevUlice: 'Karlovo namesti',
    psc: 12_000,
    textovaAdresa: 'Karlovo namesti 10, 120 00 Praha',
  },
});

const jsonResponse = <Body>(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: Body,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    Response.json(body, { headers: { 'content-type': 'application/json' }, status }),
  );

const rawResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body, { headers: { 'content-type': 'application/json' }, status }),
  );

const clientFrom = (runner: HttpRunner): HttpClient.HttpClient => HttpClient.make(runner);

const lookup = (client: HttpClient.HttpClient, ico = '48039101', correlationId = 'correlation-1') =>
  Effect.gen(function* lookupAresSubject() {
    const service = yield* AresSubjectService;
    return yield* service.subject({ correlationId, ico });
  }).pipe(
    Effect.provide(AresSubjectServiceLive),
    Effect.provideService(HttpClient.HttpClient, client),
  );

const capturedLoggerLayer = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

test('maps a bounded ARES observation and sends an exact credential-free JSON request', async () => {
  const requests: { readonly request: HttpClientRequest.HttpClientRequest; readonly url: URL }[] =
    [];
  const client = clientFrom((request, url) => {
    requests.push({ request, url });
    return Effect.succeed(
      jsonResponse(request, 200, {
        ...rawSubject('01234567'),
        czNace: ['must not escape'],
        seznamRegistraci: { mustNotEscape: true },
      }),
    );
  });
  const result = await Effect.runPromise(lookup(client, ' 01234567 '));

  assert.equal(result.status, 'FOUND');
  assert.equal(result.provider, 'ares');
  assert.equal(result.queryIco, '01234567');
  assert.equal(result.subject.ico, '01234567');
  assert.equal(result.subject.businessName, 'J.E.S., spol. s r.o.');
  assert.equal(result.subject.registeredAddress?.municipality, 'Praha');
  assert.equal(result.providerChangedOn, '2026-09-01');
  assert.equal(result.providerRecordRef, 'provider-record-123');
  assert.equal(Object.hasOwn(result, 'czNace'), false);
  assert.equal(Object.hasOwn(result, 'seznamRegistraci'), false);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url.href,
    'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/01234567',
  );
  assert.equal(requests[0]?.request.method, 'GET');
  assert.equal(requests[0]?.request.headers['accept'], 'application/json');
  assert.equal(requests[0]?.request.headers['authorization'], undefined);
  assert.equal(requests[0]?.request.headers['cookie'], undefined);
});

test('rejects malformed IČOs before provider I/O', async () => {
  let requests = 0;
  const client = clientFrom((request) => {
    requests += 1;
    return Effect.succeed(jsonResponse(request, 200, rawSubject()));
  });

  for (const ico of ['1234567', '123456789', '1234 5678', 'abcdefgh', '../48039101']) {
    const error = await Effect.runPromise(Effect.flip(lookup(client, ico)));
    assert.equal(error._tag, 'AresSubjectInvalidIco');
  }
  assert.equal(requests, 0);
});

test('represents absent optional provider facts explicitly without inventing Party facts', async () => {
  const client = clientFrom((request) =>
    Effect.succeed(
      jsonResponse(request, 200, {
        ico: '48039101',
        obchodniJmeno: null,
        sidlo: {},
      }),
    ),
  );
  const result = await Effect.runPromise(lookup(client));

  assert.deepEqual(result.subject, {
    businessName: null,
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: '48039101',
    legalFormCode: null,
    registeredAddress: null,
  });
  assert.equal(result.providerChangedOn, null);
  assert.equal(result.providerRecordRef, null);
});

test('keeps not-found, denial, throttling, timeout, and unavailable failures distinct and safe', async () => {
  const statusCases = [
    [400, 'AresSubjectResponseInvalid', 1],
    [401, 'AresSubjectDenied', 1],
    [403, 'AresSubjectDenied', 1],
    [404, 'AresSubjectNotFound', 1],
    [418, 'AresSubjectResponseInvalid', 1],
    [429, 'AresSubjectThrottled', 3],
    [500, 'AresSubjectUnavailable', 3],
    [502, 'AresSubjectUnavailable', 3],
  ] as const;
  for (const [status, tag, expectedAttempts] of statusCases) {
    let attempts = 0;
    const client = clientFrom((request) => {
      attempts += 1;
      return Effect.succeed(
        jsonResponse(request, status, {
          kod: 'PRIVATE_PROVIDER_CODE',
          popis: 'private provider detail',
        }),
      );
    });
    const program = Effect.flip(lookup(client));
    const fiberProgram = Effect.gen(function* finishRetries() {
      const fiber = yield* program.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust('10 seconds');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()));
    const error = await Effect.runPromise(expectedAttempts === 3 ? fiberProgram : program);
    assert.equal(error._tag, tag);
    assert.equal(attempts, expectedAttempts);
    assert.equal(JSON.stringify(error).includes('PRIVATE_PROVIDER_CODE'), false);
    assert.equal(JSON.stringify(error).includes('private provider detail'), false);
  }
});

test('retries transport faults with bounded backoff without exposing diagnostics', async () => {
  const logs: string[] = [];
  let attempts = 0;
  const client = clientFrom((request) => {
    attempts += 1;
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          cause: new Error('private socket diagnostic'),
          description: 'transport unavailable',
          request,
        }),
      }),
    );
  });
  const program = Effect.gen(function* runTransportRetries() {
    const fiber = yield* Effect.flip(lookup(client, '48039101', 'corr\nprivate')).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust('10 seconds');
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), capturedLoggerLayer(logs))));
  const error = await Effect.runPromise(program);

  assert.equal(error._tag, 'AresSubjectUnavailable');
  assert.equal(attempts, 3);
  assert.equal(JSON.stringify(error).includes('private socket diagnostic'), false);
  assert.match(logs.join('\n'), /private socket diagnostic/u);
  assert.match(logs.join('\n'), /corr private/u);
});

test('times out and aborts each of the three bounded attempts', async () => {
  const signals: AbortSignal[] = [];
  const client = clientFrom((_request, _url, signal) => {
    signals.push(signal);
    return Effect.never;
  });
  const program = Effect.gen(function* runTimeouts() {
    const fiber = yield* Effect.flip(lookup(client)).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust('30 seconds');
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));
  const error = await Effect.runPromise(program);

  assert.equal(error._tag, 'AresSubjectTimeout');
  assert.equal(signals.length, 3);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
});

test('bounds stalled response bodies with the same three-attempt timeout policy', async () => {
  let attempts = 0;
  const client = clientFrom((request) => {
    attempts += 1;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(new ReadableStream(), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );
  });
  const program = Effect.gen(function* runBodyTimeouts() {
    const fiber = yield* Effect.flip(lookup(client).pipe(Effect.timeout('20 seconds'))).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust('30 seconds');
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));
  const error = await Effect.runPromise(program);
  assert.equal(error._tag, 'AresSubjectTimeout');
  assert.equal(attempts, 3);
});

test('rejects malformed JSON, schema drift, mismatched IČO, and oversized text without partial evidence', async () => {
  const responses: readonly ((
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientResponse.HttpClientResponse)[] = [
    (request) => rawResponse(request, 200, '{'),
    (request) => jsonResponse(request, 200, { obchodniJmeno: 'missing IČO' }),
    (request) => jsonResponse(request, 200, rawSubject('12345678')),
    (request) => jsonResponse(request, 200, { ...rawSubject(), obchodniJmeno: 'x'.repeat(501) }),
  ];

  for (const response of responses) {
    let requests = 0;
    const client = clientFrom((request) => {
      requests += 1;
      return Effect.succeed(response(request));
    });
    const error = await Effect.runPromise(Effect.flip(lookup(client)));
    assert.equal(error._tag, 'AresSubjectResponseInvalid');
    assert.equal(requests, 1);
  }
});

test('coalesces identical requests and exposes cache age without changing observedAt', async () => {
  let requests = 0;
  const client = clientFrom((request) => {
    requests += 1;
    return Effect.sleep('1 second').pipe(
      Effect.andThen(Effect.succeed(jsonResponse(request, 200, rawSubject()))),
    );
  });
  const program = Effect.gen(function* exerciseCache() {
    const service = yield* AresSubjectService;
    const concurrent = yield* Effect.all(
      [
        service.subject({ correlationId: 'first', ico: '48039101' }),
        service.subject({ correlationId: 'second', ico: '48039101' }),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(requests, 1);
    yield* TestClock.adjust('1 second');
    const initial = yield* Fiber.join(concurrent);
    yield* TestClock.adjust('2 minutes');
    const cached = yield* service.subject({ correlationId: 'cached', ico: '48039101' });
    return { cached, initial };
  }).pipe(
    Effect.provide(AresSubjectServiceLive),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(TestClock.layer()),
  );
  const result = await Effect.runPromise(program);

  assert.equal(requests, 1);
  assert.equal(result.initial[0]?.observedAt, result.initial[1]?.observedAt);
  assert.equal(result.cached.observedAt, result.initial[0]?.observedAt);
  assert.equal(result.cached.cacheAgeSeconds, 120);
  assert.notEqual(result.cached.servedAt, result.cached.observedAt);
});

test('bounds distinct upstream lookups to four concurrent requests', async () => {
  let active = 0;
  let maximumActive = 0;
  let requests = 0;
  const client = clientFrom((request, url) =>
    Effect.sync(() => {
      active += 1;
      requests += 1;
      maximumActive = Math.max(maximumActive, active);
      return url.pathname.slice(-8);
    }).pipe(
      Effect.flatMap((ico) => Effect.sleep('1 second').pipe(Effect.as(ico))),
      Effect.map((ico) => jsonResponse(request, 200, rawSubject(ico))),
      Effect.ensuring(
        Effect.sync(() => {
          active -= 1;
        }),
      ),
    ),
  );
  const program = Effect.gen(function* exerciseConcurrencyLimit() {
    const service = yield* AresSubjectService;
    const fiber = yield* Effect.all(
      Array.from({ length: 8 }, (_, index) =>
        service.subject({
          correlationId: `concurrency-${index}`,
          ico: String(index + 1).padStart(8, '0'),
        }),
      ),
      { concurrency: 'unbounded' },
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(active, 4);
    yield* TestClock.adjust('2 seconds');
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(AresSubjectServiceLive),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(TestClock.layer()),
  );
  const results = await Effect.runPromise(program);

  assert.equal(results.length, 8);
  assert.equal(requests, 8);
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
});
