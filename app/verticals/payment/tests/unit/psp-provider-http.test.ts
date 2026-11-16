import { Context, Effect, Fiber, Layer, Match, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { ProviderHttp } from '../../src/integrations/psp/provider-http.ts';
import { ProviderHttpLive } from '../../src/integrations/psp/provider-http-live.ts';
import { GatewayProviderOutcomeUnknown, GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import type {
  GatewayProviderOutcomeUnknownError,
  GatewayProviderUnavailableError,
} from '../../src/integrations/psp/psp-errors.ts';

/**
 * #1158 ProviderHttp against a recorded HttpClient: each scripted step answers one attempt, and every
 * attempt the provider would have seen is recorded. The donor client retried POST on 5xx; here a
 * mutation is sent exactly once whatever the transport outcome.
 */

const operationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const credential = 'credential-under-test-7f3a';
const createUrl = 'https://psp.example.test/v1/checkout/sessions';
const readUrl = 'https://psp.example.test/v1/checkout/sessions/cs_1';

const FailStepSchema = Schema.TaggedStruct('Fail', { code: Schema.String });
const HangStepSchema = Schema.TaggedStruct('Hang', {});
const RespondStepSchema = Schema.TaggedStruct('Respond', { body: Schema.String, status: Schema.Finite });
const StepSchema = Schema.Union([FailStepSchema, HangStepSchema, RespondStepSchema]);
type Step = typeof StepSchema.Type;

const respond = (status: number, body = '{}'): Step => RespondStepSchema.make({ body, status });
const fail = (code: string): Step => FailStepSchema.make({ code });
const hang: Step = HangStepSchema.make({});

/** A Node fetch failure: `TypeError('fetch failed')` wrapping the socket error with its `code`. */
const fetchFailure = (code: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`socket ${code}`), { code }) });

const runStep = (
  request: HttpClientRequest.HttpClientRequest,
  step: Step,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
  Match.value(step).pipe(
    Match.tag('Fail', ({ code }) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ cause: fetchFailure(code), request }),
        }),
      ),
    ),
    Match.tag('Hang', () => Effect.never),
    Match.tag('Respond', ({ body, status }) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
    ),
    Match.exhaustive,
  );

const recordedProvider = (steps: readonly Step[]) =>
  Effect.gen(function* recordedProviderEffect() {
    const sent: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      const step = steps[sent.length] ?? respond(599, 'unscripted attempt');
      sent.push(request);
      return runStep(request, step);
    });
    const context = yield* Layer.build(
      ProviderHttpLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    );
    return { http: Context.get(context, ProviderHttp), sent };
  });

const createRequest = HttpClientRequest.post(createUrl).pipe(
  HttpClientRequest.bearerToken(credential),
  HttpClientRequest.bodyText('amount=159950', 'application/x-www-form-urlencoded'),
);
const readRequest = HttpClientRequest.get(readUrl).pipe(HttpClientRequest.bearerToken(credential));

const mutation = { family: 'STRIPE', operationId, request: createRequest } as const;
const read = { family: 'STRIPE', request: readRequest } as const;

type ProviderHttpFailure = GatewayProviderOutcomeUnknownError | GatewayProviderUnavailableError;
const isOutcomeUnknown = Schema.is(GatewayProviderOutcomeUnknown);
const isUnavailable = Schema.is(GatewayProviderUnavailable);

/** No credential, body or URL is put into the typed failure. */
const expectNoSecret = (error: ProviderHttpFailure) => {
  const rendered = JSON.stringify(error);
  expect(rendered).not.toContain(credential);
  expect(rendered).not.toContain('amount=159950');
  expect(rendered).not.toContain(createUrl);
};

const expectOutcomeUnknown = (error: ProviderHttpFailure, reason: string) => {
  expect(isOutcomeUnknown(error)).toBe(true);
  expect(error).toMatchObject({ code: 'gateway_provider_outcome_unknown', family: 'STRIPE', operationId, reason });
  expectNoSecret(error);
};

const expectUnavailable = (error: ProviderHttpFailure, family: string, reason: string) => {
  expect(isUnavailable(error)).toBe(true);
  expect(error).toMatchObject({ code: 'gateway_provider_unavailable', family, reason });
  expectNoSecret(error);
};

describe('#1158 ProviderHttp mutation is a single attempt', () => {
  it.effect('#1158 A create that times out is OUTCOME_UNKNOWN and is never resent', () =>
    Effect.gen(function* createTimesOut() {
      const { http, sent } = yield* recordedProvider([hang, respond(200)]);
      const fiber = yield* Effect.forkChild(Effect.flip(http.mutate(mutation)));

      yield* TestClock.adjust('19999 millis');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust('1 millis');
      const error = yield* Fiber.join(fiber);

      expectOutcomeUnknown(error, 'provider_attempt_timed_out');
      yield* TestClock.adjust('1 minute');
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('#1158 A 5xx mutation is OUTCOME_UNKNOWN and is never resent (inverts the donor POST retry)', () =>
    Effect.gen(function* createServerError() {
      const { http, sent } = yield* recordedProvider([respond(503), respond(200)]);
      const error = yield* Effect.flip(http.mutate(mutation));

      expectOutcomeUnknown(error, 'provider_server_error');
      yield* TestClock.adjust('1 minute');
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('#1158 A connection dropped after the write is OUTCOME_UNKNOWN', () =>
    Effect.gen(function* createConnectionReset() {
      for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) {
        const { http, sent } = yield* recordedProvider([fail(code), respond(200)]);
        const error = yield* Effect.flip(http.mutate(mutation));

        expectOutcomeUnknown(error, 'provider_transport_failed');
        expect(sent).toHaveLength(1);
      }
    }),
  );

  it.effect('#1158 Connection refused before send is UNAVAILABLE', () =>
    Effect.gen(function* createRefused() {
      for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
        const { http, sent } = yield* recordedProvider([fail(code), respond(200)]);
        const error = yield* Effect.flip(http.mutate(mutation));

        expectUnavailable(error, 'STRIPE', 'provider_request_not_sent');
        yield* TestClock.adjust('1 minute');
        expect(sent).toHaveLength(1);
      }
    }),
  );

  it.effect('#1158 A 4xx mutation is returned for classification', () =>
    Effect.gen(function* createRejected() {
      const body = '{"error":{"type":"card_error"}}';
      const { http, sent } = yield* recordedProvider([respond(402, body), respond(200)]);
      const response = yield* http.mutate(mutation);

      expect(response).toEqual({ bodyText: body, status: 402 });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe('POST');
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${credential}`);
    }),
  );
});

describe('#1158 ProviderHttp read retries within its bound', () => {
  it.effect('#1158 A read retries a 503 within its bound', () =>
    Effect.gen(function* readRetries503() {
      const { http, sent } = yield* recordedProvider([respond(503), respond(429), respond(200, '{"id":"cs_1"}')]);
      const fiber = yield* Effect.forkChild(http.read(read));

      yield* TestClock.adjust('199 millis');
      expect(sent).toHaveLength(1);
      yield* TestClock.adjust('1 millis');
      expect(sent).toHaveLength(2);
      yield* TestClock.adjust('399 millis');
      expect(sent).toHaveLength(2);
      yield* TestClock.adjust('1 millis');
      const response = yield* Fiber.join(fiber);

      expect(response).toEqual({ bodyText: '{"id":"cs_1"}', status: 200 });
      expect(sent).toHaveLength(3);
      expect(sent.every((request) => request.method === 'GET')).toBe(true);
    }),
  );

  it.effect('#1158 A read that keeps failing is UNAVAILABLE after three attempts', () =>
    Effect.gen(function* readExhausted() {
      const { http, sent } = yield* recordedProvider([respond(503), fail('ECONNRESET'), respond(500), respond(200)]);
      const fiber = yield* Effect.forkChild(Effect.flip(http.read(read)));
      yield* TestClock.adjust('1 minute');
      const error = yield* Fiber.join(fiber);

      expectUnavailable(error, 'STRIPE', 'provider_server_error');
      expect(sent).toHaveLength(3);
    }),
  );

  it.effect('#1158 A read attempt is bounded by 10 s and the whole read by three attempts', () =>
    Effect.gen(function* readTimesOut() {
      const { http, sent } = yield* recordedProvider([hang, hang, hang, respond(200)]);
      const fiber = yield* Effect.forkChild(Effect.flip(http.read(read)));

      yield* TestClock.adjust('9999 millis');
      expect(sent).toHaveLength(1);
      yield* TestClock.adjust('1 millis');
      yield* TestClock.adjust('200 millis');
      expect(sent).toHaveLength(2);
      yield* TestClock.adjust('10 seconds');
      yield* TestClock.adjust('400 millis');
      expect(sent).toHaveLength(3);
      yield* TestClock.adjust('9999 millis');
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust('1 millis');
      const error = yield* Fiber.join(fiber);

      expectUnavailable(error, 'STRIPE', 'provider_attempt_timed_out');
      expect(sent).toHaveLength(3);
    }),
  );

  it.effect('#1158 A 4xx read other than 429 is returned without retry', () =>
    Effect.gen(function* readNotFound() {
      const { http, sent } = yield* recordedProvider([respond(404, '{"error":"missing"}'), respond(200)]);
      const response = yield* http.read(read);

      expect(response).toEqual({ bodyText: '{"error":"missing"}', status: 404 });
      yield* TestClock.adjust('1 minute');
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('#1158 A read that cannot be built is UNAVAILABLE without retry', () =>
    Effect.gen(function* readInvalidUrl() {
      const { http, sent } = yield* recordedProvider([respond(200)]);
      const error = yield* Effect.flip(
        http.read({
          family: 'GOPAY',
          request: HttpClientRequest.get('not a url').pipe(HttpClientRequest.bearerToken(credential)),
        }),
      );

      expectUnavailable(error, 'GOPAY', 'provider_request_not_sent');
      expect(sent).toHaveLength(0);
    }),
  );
});
