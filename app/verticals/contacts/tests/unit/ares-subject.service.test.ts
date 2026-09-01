// @effect-diagnostics asyncFunction:off strictEffectProvide:off
/* eslint-disable no-await-in-loop -- Ordered adapter scenarios assert isolated request counts and cache state. */
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

const subjectBody = (ico = '48039101') => ({
  datumVzniku: '1992-12-04',
  datumZaniku: null,
  dic: 'CZ48039101',
  ico,
  obchodniJmeno: 'J.E.S., spol. s r.o.',
  pravniForma: '112',
});

const jsonResponse = <Body>(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: Body,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    Response.json(body, {
      headers: { 'content-type': 'application/json' },
      status,
    }),
  );

const rawResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      headers: { 'content-type': 'application/json' },
      status,
    }),
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

test('maps the exact flat Customer fields and constructs a credential-free JSON GET', async () => {
  const requests: {
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly url: URL;
  }[] = [];
  const client = clientFrom((request, url) => {
    requests.push({ request, url });
    return Effect.succeed(
      jsonResponse(request, 200, {
        ...subjectBody('01234567'),
        czNace: ['62010'],
        datumAktualizace: '2026-08-01',
        primarniZdroj: 'ros',
        seznamRegistraci: { stavZdrojeVr: 'AKTIVNI' },
        sidlo: { textovaAdresa: 'Must not escape' },
      }),
    );
  });

  const result = await Effect.runPromise(lookup(client, '01234567'));

  assert.deepEqual(result, {
    dic: 'CZ48039101',
    dissolvedOn: null,
    establishedOn: '1992-12-04',
    ico: '01234567',
    legalFormCode: '112',
    name: 'J.E.S., spol. s r.o.',
  });
  assert.equal(Object.hasOwn(result, 'sidlo'), false);
  assert.equal(Object.hasOwn(result, 'czNace'), false);
  assert.equal(Object.hasOwn(result, 'datumAktualizace'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.request.method, 'GET');
  assert.equal(
    requests[0]?.url.href,
    'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/01234567',
  );
  assert.equal(requests[0]?.request.headers['accept'], 'application/json');
  assert.equal(requests[0]?.request.headers['authorization'], undefined);
  assert.equal(requests[0]?.request.headers['cookie'], undefined);
});

test('maps omitted and null optional ARES values to explicit null Customer fields', async () => {
  const cases = [
    { ico: '11111111', obchodniJmeno: 'Omitted fields' },
    {
      datumVzniku: null,
      datumZaniku: null,
      dic: null,
      ico: '22222222',
      obchodniJmeno: 'Null fields',
      pravniForma: null,
    },
  ] as const;

  for (const body of cases) {
    const client = clientFrom((request) => Effect.succeed(jsonResponse(request, 200, body)));
    const result = await Effect.runPromise(lookup(client, body.ico));
    assert.deepEqual(result, {
      dic: null,
      dissolvedOn: null,
      establishedOn: null,
      ico: body.ico,
      legalFormCode: null,
      name: body.obchodniJmeno,
    });
  }
});

test('rejects partial, overlong, and non-digit IČOs before any network request', async () => {
  let requests = 0;
  const client = clientFrom((request) => {
    requests += 1;
    return Effect.succeed(jsonResponse(request, 200, subjectBody()));
  });

  for (const ico of ['1234567', '123456789', '1234567x', '', '../48039101']) {
    const error = await Effect.runPromise(Effect.flip(lookup(client, ico)));
    assert.equal(error._tag, 'AresSubjectInvalidIco');
    assert.equal(error.code, 'ares_subject_invalid_ico');
    assert.equal(error.reason, 'IČO must contain exactly eight digits');
  }
  assert.equal(requests, 0);
});

test('classifies terminal upstream statuses without retrying them', async () => {
  const cases = [
    [400, 'AresSubjectInvalidIco'],
    [401, 'AresSubjectDenied'],
    [403, 'AresSubjectDenied'],
    [404, 'AresSubjectNotFound'],
  ] as const;

  for (const [status, expectedTag] of cases) {
    let requests = 0;
    const client = clientFrom((request) => {
      requests += 1;
      return Effect.succeed(
        jsonResponse(request, status, {
          kod: 'UPSTREAM_ONLY',
          popis: 'must not reach the typed error',
          subKod: 'PRIVATE_DETAIL',
        }),
      );
    });
    const error = await Effect.runPromise(Effect.flip(lookup(client)));
    assert.equal(error._tag, expectedTag);
    assert.equal(JSON.stringify(error).includes('UPSTREAM_ONLY'), false);
    assert.equal(requests, 1);
  }
});

test('retries throttling and upstream failures with bounded exponential backoff', async () => {
  let throttledAttempts = 0;
  const throttledClient = clientFrom((request) => {
    throttledAttempts += 1;
    return Effect.succeed(
      throttledAttempts < 3
        ? jsonResponse(request, 429, { kod: 'BLOCKED' })
        : jsonResponse(request, 200, subjectBody()),
    );
  });
  const throttledProgram = Effect.gen(function* retryThrottledRequest() {
    const fiber = yield* lookup(throttledClient).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(throttledAttempts, 1);
    yield* TestClock.adjust('100 millis');
    assert.equal(throttledAttempts, 2);
    yield* TestClock.adjust('200 millis');
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));

  const throttledResult = await Effect.runPromise(throttledProgram);
  assert.equal(throttledResult.ico, '48039101');
  assert.equal(throttledAttempts, 3);

  let unavailableAttempts = 0;
  const unavailableClient = clientFrom((request) => {
    unavailableAttempts += 1;
    return Effect.succeed(jsonResponse(request, 500, { kod: 'OBECNA_CHYBA' }));
  });
  const unavailableProgram = Effect.gen(function* retryUnavailableRequest() {
    const fiber = yield* Effect.flip(lookup(unavailableClient)).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust('1 second');
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));

  const unavailableError = await Effect.runPromise(unavailableProgram);
  assert.equal(unavailableError._tag, 'AresSubjectUnavailable');
  assert.equal(unavailableAttempts, 3);
});

test('retries transport failures, logs internal causes, and returns sanitized diagnostics', async () => {
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
  const program = Effect.gen(function* captureTransportDiagnostics() {
    const fiber = yield* Effect.flip(lookup(client, '48039101', 'corr\nprivate')).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust('1 second');
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), capturedLoggerLayer(logs))));

  const error = await Effect.runPromise(program);
  const diagnostic = logs.join('\n');
  assert.equal(error._tag, 'AresSubjectUnavailable');
  assert.equal(JSON.stringify(error).includes('private socket diagnostic'), false);
  assert.equal(attempts, 3);
  assert.match(diagnostic, /private socket diagnostic/u);
  assert.match(diagnostic, /corr private/u);
  assert.doesNotMatch(diagnostic, /corr\\nprivate/u);
});

test('times out each attempt, aborts it, and stops after the bounded retry count', async () => {
  const signals: AbortSignal[] = [];
  const client = clientFrom((_request, _url, signal) => {
    signals.push(signal);
    return Effect.never;
  });
  const program = Effect.gen(function* exerciseTimeouts() {
    const fiber = yield* Effect.flip(lookup(client)).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust('10 seconds');
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

test('does not retry malformed JSON, invalid schemas, or mismatched response IČOs', async () => {
  const cases: readonly ((
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientResponse.HttpClientResponse)[] = [
    (request) => rawResponse(request, 200, '{'),
    (request) => jsonResponse(request, 200, { ico: '48039101' }),
    (request) =>
      jsonResponse(request, 200, {
        ...subjectBody(),
        pravniForma: 'not-a-code',
      }),
    (request) => jsonResponse(request, 200, subjectBody('12345678')),
  ];

  for (const response of cases) {
    let requests = 0;
    const client = clientFrom((request) => {
      requests += 1;
      return Effect.succeed(response(request));
    });
    const error = await Effect.runPromise(Effect.flip(lookup(client)));
    assert.equal(error._tag, 'AresSubjectDecodeFailure');
    assert.equal(requests, 1);
  }
});

test('coalesces concurrent lookups and caches only successful results for five minutes', async () => {
  let requests = 0;
  const client = clientFrom((request) => {
    requests += 1;
    return Effect.sleep('1 second').pipe(
      Effect.andThen(Effect.succeed(jsonResponse(request, 200, subjectBody()))),
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
    const values = yield* Fiber.join(concurrent);
    const cached = yield* service.subject({ correlationId: 'cached', ico: '48039101' });
    assert.equal(requests, 1);
    yield* TestClock.adjust('5 minutes');
    const expired = yield* service
      .subject({ correlationId: 'expired', ico: '48039101' })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust('1 second');
    return { cached, expired: yield* Fiber.join(expired), values };
  }).pipe(
    Effect.provide(AresSubjectServiceLive),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(TestClock.layer()),
  );

  const result = await Effect.runPromise(program);
  assert.equal(requests, 2);
  assert.deepEqual(result.values, [result.cached, result.cached]);
  assert.deepEqual(result.expired, result.cached);
});

test('limits distinct upstream lookups to four concurrent requests', async () => {
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
      Effect.map((ico) => jsonResponse(request, 200, subjectBody(ico))),
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
      Array.from({ length: 8 }, (_, index) => {
        const ico = String(index + 1).padStart(8, '0');
        return service.subject({ correlationId: `concurrency-${index}`, ico });
      }),
      { concurrency: 'unbounded' },
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(active, 4);
    assert.equal(requests, 4);
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

test('cancellation aborts the active request and does not poison the next lookup', async () => {
  let requests = 0;
  let firstSignal: AbortSignal | undefined;
  const client = clientFrom((request, _url, signal) => {
    requests += 1;
    if (requests === 1) {
      firstSignal = signal;
      return Effect.never;
    }
    return Effect.succeed(jsonResponse(request, 200, subjectBody()));
  });
  const program = Effect.gen(function* exerciseCancellation() {
    const service = yield* AresSubjectService;
    const cancelled = yield* service
      .subject({ correlationId: 'cancelled', ico: '48039101' })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(cancelled);
    assert.equal(firstSignal?.aborted, true);
    return yield* service.subject({ correlationId: 'retry', ico: '48039101' });
  }).pipe(
    Effect.provide(AresSubjectServiceLive),
    Effect.provideService(HttpClient.HttpClient, client),
  );

  const result = await Effect.runPromise(program);
  assert.equal(result.ico, '48039101');
  assert.equal(requests, 2);
});
