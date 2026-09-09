import { DateTime, Effect, Fiber, Logger, Option, Predicate, Schema } from 'effect';
// @effect-diagnostics strictEffectProvide:off -- Tests intentionally provide isolated adapter and logger layers. expires: 2026-12-31.
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http';
import type { HttpClientRequest } from 'effect/unstable/http';

import { AresSubjectService, AresSubjectServiceLive } from '../../src/integrations/ares/ares-subject.service.ts';

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
  }).pipe(Effect.provide(AresSubjectServiceLive), Effect.provideService(HttpClient.HttpClient, client));

const capturedLoggerLayer = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

it.effect('maps a bounded ARES observation and sends an exact credential-free JSON request', () =>
  Effect.gen(function* aresSubjectServiceCase1() {
    const requests: {
      readonly request: HttpClientRequest.HttpClientRequest;
      readonly url: URL;
    }[] = [];
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
    const result = yield* lookup(client, ' 01234567 ');

    expect(result.status).toBe('FOUND');
    expect(result.provider).toBe('ares');
    expect(result.queryIco).toBe('01234567');
    expect(result.subject.ico).toBe('01234567');
    expect(Option.getOrUndefined(result.subject.businessName)).toBe('J.E.S., spol. s r.o.');
    const registeredAddress = Option.getOrUndefined(result.subject.registeredAddress);
    expect(registeredAddress).toBeDefined();
    if (registeredAddress === undefined) {
      throw new Error('Expected registeredAddress to be defined');
    }
    expect(Option.getOrUndefined(registeredAddress.municipality)).toBe('Praha');
    expect(result.providerChangedOn.pipe(Option.map(DateTime.formatIsoDateUtc), Option.getOrUndefined)).toBe(
      '2026-09-01',
    );
    expect(Option.getOrUndefined(result.providerRecordRef)).toBe('provider-record-123');
    expect(Object.hasOwn(result, 'czNace')).toBe(false);
    expect(Object.hasOwn(result, 'seznamRegistraci')).toBe(false);
    expect(requests.length).toBe(1);
    expect(requests[0]?.url.href).toBe(
      'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/01234567',
    );
    expect(requests[0]?.request.method).toBe('GET');
    expect(requests[0]?.request.headers['accept']).toBe('application/json');
    expect(requests[0]?.request.headers['authorization']).toBe(undefined);
    expect(requests[0]?.request.headers['cookie']).toBe(undefined);
  }),
);

it.effect('rejects malformed IČOs before provider I/O', () =>
  Effect.gen(function* aresSubjectServiceCase2() {
    let requests = 0;
    const client = clientFrom((request) => {
      requests += 1;
      return Effect.succeed(jsonResponse(request, 200, rawSubject()));
    });

    yield* Effect.forEach(
      ['1234567', '123456789', '1234 5678', 'abcdefgh', '../48039101'],
      (ico) =>
        Effect.gen(function* aresSubjectServiceCase3() {
          const error = yield* Effect.flip(lookup(client, ico));
          expect(Predicate.isTagged(error, 'AresSubjectInvalidIco')).toBe(true);
        }),
      { concurrency: 'unbounded' },
    );
    expect(requests).toBe(0);
  }),
);

it.effect('represents absent optional provider facts explicitly without inventing Party facts', () =>
  Effect.gen(function* aresSubjectServiceCase4() {
    const client = clientFrom((request) =>
      Effect.succeed(
        jsonResponse(request, 200, {
          ico: '48039101',
          obchodniJmeno: null,
          sidlo: {},
        }),
      ),
    );
    const result = yield* client.pipe(lookup);

    expect(result.subject).toEqual({
      businessName: Option.none(),
      dic: Option.none(),
      dissolvedOn: Option.none(),
      establishedOn: Option.none(),
      ico: '48039101',
      legalFormCode: Option.none(),
      registeredAddress: Option.none(),
    });
    expect(Option.isNone(result.providerChangedOn)).toBe(true);
    expect(Option.isNone(result.providerRecordRef)).toBe(true);
  }),
);

it.effect('keeps not-found, denial, throttling, timeout, and unavailable failures distinct and safe', () =>
  Effect.gen(function* aresSubjectServiceCase5() {
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
    yield* Effect.all(
      statusCases.map(([status, tag, expectedAttempts]) =>
        Effect.gen(function* aresSubjectServiceCase6() {
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
          });
          const error = yield* expectedAttempts === 3 ? fiberProgram : program;
          expect(Predicate.isTagged(error, tag)).toBe(true);
          expect(attempts).toBe(expectedAttempts);
          expect(
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error)).includes(
              'PRIVATE_PROVIDER_CODE',
            ),
          ).toBe(false);
          expect(
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error)).includes(
              'private provider detail',
            ),
          ).toBe(false);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect('retries transport faults with bounded backoff without exposing diagnostics', () =>
  Effect.gen(function* aresSubjectServiceCase7() {
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
      const fiber = yield* Effect.flip(lookup(client, '48039101', 'corr\nprivate')).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust('10 seconds');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(capturedLoggerLayer(logs)));
    const error = yield* program;

    expect(Predicate.isTagged(error, 'AresSubjectUnavailable')).toBe(true);
    expect(attempts).toBe(3);
    expect(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error)).includes('private socket diagnostic'),
    ).toBe(false);
    expect(logs.join('\n')).toMatch(/private socket diagnostic/u);
    expect(logs.join('\n')).toMatch(/corr private/u);
  }),
);

it.effect('times out and aborts each of the three bounded attempts', () =>
  Effect.gen(function* aresSubjectServiceCase8() {
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
    });
    const error = yield* program;

    expect(Predicate.isTagged(error, 'AresSubjectTimeout')).toBe(true);
    expect(signals.length).toBe(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }),
);

it.effect('bounds stalled response bodies with the same three-attempt timeout policy', () =>
  Effect.gen(function* aresSubjectServiceCase9() {
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
      const fiber = yield* Effect.flip(lookup(client).pipe(Effect.timeout('20 seconds'))).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust('30 seconds');
      return yield* Fiber.join(fiber);
    });
    const error = yield* program;
    expect(Predicate.isTagged(error, 'AresSubjectTimeout')).toBe(true);
    expect(attempts).toBe(3);
  }),
);

it.effect('rejects malformed JSON, schema drift, mismatched IČO, and oversized text without partial evidence', () =>
  Effect.gen(function* aresSubjectServiceCase10() {
    const responses: readonly ((
      request: HttpClientRequest.HttpClientRequest,
    ) => HttpClientResponse.HttpClientResponse)[] = [
      (request) => rawResponse(request, 200, '{'),
      (request) => jsonResponse(request, 200, { obchodniJmeno: 'missing IČO' }),
      (request) => jsonResponse(request, 200, rawSubject('12345678')),
      (request) =>
        jsonResponse(request, 200, {
          ...rawSubject(),
          obchodniJmeno: 'x'.repeat(501),
        }),
    ];

    yield* Effect.forEach(
      responses,
      (response) =>
        Effect.gen(function* aresSubjectServiceCase11() {
          let requests = 0;
          const client = clientFrom((request) => {
            requests += 1;
            return Effect.succeed(response(request));
          });
          const error = yield* Effect.flip(lookup(client));
          expect(Predicate.isTagged(error, 'AresSubjectResponseInvalid')).toBe(true);
          expect(requests).toBe(1);
        }),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect('coalesces identical requests and exposes cache age without changing observedAt', () =>
  Effect.gen(function* aresSubjectServiceCase12() {
    let requests = 0;
    const client = clientFrom((request) => {
      requests += 1;
      return Effect.sleep('1 second').pipe(Effect.andThen(Effect.succeed(jsonResponse(request, 200, rawSubject()))));
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
      expect(requests).toBe(1);
      yield* TestClock.adjust('1 second');
      const initial = yield* Fiber.join(concurrent);
      yield* TestClock.adjust('2 minutes');
      const cached = yield* service.subject({
        correlationId: 'cached',
        ico: '48039101',
      });
      return { cached, initial };
    }).pipe(Effect.provide(AresSubjectServiceLive), Effect.provideService(HttpClient.HttpClient, client));
    const result = yield* program;

    expect(requests).toBe(1);
    expect(result.initial[0]?.observedAt).toBe(result.initial[1]?.observedAt);
    expect(result.cached.observedAt).toBe(result.initial[0]?.observedAt);
    expect(result.cached.cacheAgeSeconds).toBe(120);
    expect(result.cached.servedAt).not.toBe(result.cached.observedAt);
  }),
);

it.effect('bounds distinct upstream lookups to four concurrent requests', () =>
  Effect.gen(function* aresSubjectServiceCase13() {
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
      expect(active).toBe(4);
      yield* TestClock.adjust('2 seconds');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(AresSubjectServiceLive), Effect.provideService(HttpClient.HttpClient, client));
    const results = yield* program;

    expect(results.length).toBe(8);
    expect(requests).toBe(8);
    expect(maximumActive).toBe(4);
    expect(active).toBe(0);
  }),
);
