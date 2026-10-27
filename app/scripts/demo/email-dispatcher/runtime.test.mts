import { Effect, Exit, Fiber, Match, Option, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { emailTransport } from '../../../packages/email-delivery/src/transport.ts';
import { healthResponse } from './main.mts';
import { deleteMessages, listMessages, messagesToDelete } from './tidy-inbox.mts';
import type { MailpitMessageSchema } from './tidy-inbox.mts';

type MailpitMessage = typeof MailpitMessageSchema.Type;
const mailpit = 'https://mailpit.invalid';
const message = (id: string, subject = 'Order OBJ-2026-0001', address = 'customer@demo.ontos'): MailpitMessage => ({
  Created: '2026-10-27T12:00:00Z',
  ID: id,
  Subject: subject,
  To: [{ Address: address }],
});

it('selects only removed AKROS orders and test recipients', () => {
  const messages = [
    message('removed'),
    message('kept', 'Order OBJ-2026-0002'),
    message('test', 'Payment reminder', 'qa@example.invalid'),
    message('audit', 'Agenda notification', 'audit@demo.ontos'),
    message('other', 'Payment reminder'),
  ];
  expect(messagesToDelete(messages, new Set(['OBJ-2026-0001'])).map((item) => item.ID)).toEqual([
    'removed',
    'test',
    'audit',
  ]);
});

it.effect('reads every Mailpit page sequentially until the total is reached', () =>
  Effect.gen(function* paginatedMessages() {
    const starts: string[] = [];
    const client = HttpClient.make((request, url) => {
      const start = url.searchParams.get('start') ?? '';
      starts.push(start);
      expect(url.searchParams.get('limit')).toBe('500');
      const messages = start === '0' ? [message('first')] : [message('last')];
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ messages, total: 2 })));
    });
    const result = yield* listMessages(mailpit).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(starts).toEqual(['0', '500']);
    expect(result.map((item) => item.ID)).toEqual(['first', 'last']);
  }),
);

it.effect('stops at an empty page even if Mailpit reports a larger total', () =>
  Effect.gen(function* emptyPage() {
    let requests = 0;
    const client = HttpClient.make((request) => {
      requests += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ messages: [], total: 1000 })));
    });
    const result = yield* listMessages(mailpit).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(result).toEqual([]);
    expect(requests).toBe(1);
  }),
);

it.effect('rejects malformed Mailpit pages through the typed schema error channel', () =>
  Effect.gen(function* malformedPage() {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ messages: [{ ID: 'incomplete' }], total: 1 })),
      ),
    );
    const failure = yield* listMessages(mailpit).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
    );
    expect(Schema.isSchemaError(failure)).toBe(true);
  }),
);

it.effect('does not retry an HTTP failure while listing messages', () =>
  Effect.gen(function* failedPage() {
    let requests = 0;
    const client = HttpClient.make((request) => {
      requests += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })));
    });
    const failure = yield* listMessages(mailpit).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
    );
    expect(HttpClientError.isHttpClientError(failure)).toBe(true);
    expect(requests).toBe(1);
  }),
);

it.effect('deletes only the selected IDs in ordered batches of at most 200', () =>
  Effect.gen(function* deletionBatches() {
    const batches: (readonly string[])[] = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* recordDeletion() {
        expect(request.method).toBe('DELETE');
        expect(request.url).toBe(`${mailpit}/api/v1/messages`);
        expect(request.headers['content-type']).toBe('application/json');
        const text = Match.value(request.body).pipe(
          Match.tag('Uint8Array', (body) => new TextDecoder().decode(body.body)),
          Match.orElse(() => ''),
        );
        const body = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ IDs: Schema.Array(Schema.String) })),
        )(text).pipe(Effect.orDie);
        batches.push(body.IDs);
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }),
    );
    const messages = Array.from({ length: 401 }, (_, index) => message(String(index)));
    yield* deleteMessages(mailpit, messages).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 1]);
    expect(batches.flat()).toEqual(messages.map((item) => item.ID));
  }),
);

it.effect('stops deleting after the first rejected batch and never retries it', () =>
  Effect.gen(function* failedDeletion() {
    let requests = 0;
    const client = HttpClient.make((request) => {
      requests += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })));
    });
    const result = yield* deleteMessages(
      mailpit,
      Array.from({ length: 201 }, (_, index) => message(String(index))),
    ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(requests).toBe(1);
  }),
);

it.effect('interrupts a stalled Mailpit request after its timeout', () =>
  Effect.gen(function* requestTimeout() {
    let cancelled = false;
    const client = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
      ),
    );
    const fiber = yield* listMessages(mailpit).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.forkChild,
    );
    yield* TestClock.adjust('30 seconds');
    const result = yield* Fiber.await(fiber);
    expect(Exit.isFailure(result)).toBe(true);
    expect(cancelled).toBe(true);
  }),
);

it.effect('serves the same provider JSON only for the exact GET health path', () =>
  Effect.gen(function* healthEndpoint() {
    const response = yield* healthResponse.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`${mailpit}/healthz`)),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const provider = yield* HttpClientResponse.schemaBodyJson(
      Schema.Struct({
        ok: Schema.Literal(true),
        provider: Schema.Struct({ configured: Schema.Boolean, label: Schema.OptionFromNullOr(Schema.String) }),
      }),
    )(HttpServerResponse.toClientResponse(response));
    expect(provider.provider.configured).toBe(emailTransport.provider.configured);
    expect(Option.getOrNull(provider.provider.label)).toBe(emailTransport.provider.label);
    for (const request of [
      new Request(`${mailpit}/healthz`, { method: 'POST' }),
      new Request(`${mailpit}/healthz?query=1`),
    ]) {
      const notFound = yield* healthResponse.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      );
      expect(notFound.status).toBe(404);
      expect(yield* HttpServerResponse.toClientResponse(notFound).text).toBe('{"error":"not_found"}');
    }
  }),
);
