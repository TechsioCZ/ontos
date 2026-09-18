import type { EmailDeliveryError } from '../../src/server.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';
import { ResendEmailDeliveryConfig, ResendEmailDeliveryLive } from '../../src/resend.ts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

const configuration = {
  apiKey: Redacted.make('re_test_secret'),
  endpoint: 'https://fixture.resend.test/emails',
  from: 'OntOS <no-reply@example.test>',
  timeout: '20 millis',
} as const;

const message = {
  html: Redacted.make('<p>Hello from OntOS.</p>'),
  idempotencyKey: 'recovery-token-opaque-key',
  subject: 'Verify your account',
  text: Redacted.make('Hello from OntOS.'),
  to: 'person@example.test',
} as const;

const resendTestLayer = (fetch: typeof globalThis.fetch) =>
  ResendEmailDeliveryLive.pipe(
    Layer.provide(Layer.succeed(ResendEmailDeliveryConfig, configuration)),
    Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))),
  );

const encodeForAssertions = (error: EmailDeliveryError) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error);

type FixtureResponseBody = Readonly<Record<string, string>>;

const response = (status: number, body: FixtureResponseBody) => Response.json(body, { status });

interface FetchFixture {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: Request[];
}

const makeFetchFixture = (status: number, body: FixtureResponseBody, onRequest?: () => void): FetchFixture => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    onRequest?.();
    return Promise.resolve(response(status, body));
  };
  return { fetch, requests };
};

const mappingFixture = makeFetchFixture(200, { id: 'resend-message-1' });

it.layer(resendTestLayer(mappingFixture.fetch), { excludeTestServices: true })('Resend submission adapter', (test) => {
  test.effect('maps a validated message to the Resend submission request', () =>
    Effect.gen(function* requestMapping() {
      const service = yield* EmailDeliveryService;
      expect(yield* service.send(message)).toEqual({ accepted: true, id: 'resend-message-1' });
      const request = mappingFixture.requests.at(0);
      expect(request).toBeDefined();
      if (request === undefined) {
        return;
      }
      expect(request.method).toBe('POST');
      expect(request.url).toBe(configuration.endpoint);
      expect(request.headers.get('authorization')).toBe('Bearer re_test_secret');
      expect(request.headers.get('idempotency-key')).toBe(message.idempotencyKey);
      expect(yield* Effect.promise(() => request.json())).toEqual({
        from: configuration.from,
        html: Redacted.value(message.html),
        subject: message.subject,
        text: Redacted.value(message.text),
        to: [message.to],
      });
    }),
  );
});

const rejectionFixture = makeFetchFixture(422, {
  message: 'recipient body should never be retained',
  name: 'validation_error',
});

it.layer(resendTestLayer(rejectionFixture.fetch), { excludeTestServices: true })('Resend rejections', (test) => {
  test.effect('maps a provider rejection without copying provider diagnostics or message data', () =>
    Effect.gen(function* rejectedSubmission() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(Schema.is(EmailDeliveryRejected)(error)).toBe(true);
      if (!Schema.is(EmailDeliveryRejected)(error)) {
        return;
      }
      const encoded = yield* encodeForAssertions(error);
      expect(error.reason).toBe('provider_rejected');
      expect(error.status).toBe(422);
      expect(encoded).not.toContain('recipient body');
      expect(encoded).not.toContain(message.to);
      expect(encoded).not.toContain('re_test_secret');
    }),
  );
});

let malformedRequestCount = 0;
const malformedFixture = makeFetchFixture(200, { id: 'unexpected' }, () => {
  malformedRequestCount += 1;
});
const malformed = { ...message, subject: 'Verify\r\nBcc: attacker@example.test', to: message.to };

it.layer(resendTestLayer(malformedFixture.fetch), { excludeTestServices: true })(
  'Resend preflight validation',
  (test) => {
    test.effect('rejects malformed addresses and header content before making an HTTP request', () =>
      Effect.gen(function* malformedMessage() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(malformed));
        expect(Schema.is(EmailDeliveryInvalidMessage)(error)).toBe(true);
        if (!Schema.is(EmailDeliveryInvalidMessage)(error)) {
          return;
        }
        expect(error.field).toBe('subject');
        expect(error.reason).toBe('control_character');
        expect(malformedRequestCount).toBe(0);
      }),
    );
  },
);

let timeoutRequestCount = 0;
const timeoutFixture: FetchFixture = (() => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    timeoutRequestCount += 1;
    const request = new Request(input, init);
    requests.push(request.clone());
    return Promise.race([]);
  };
  return { fetch, requests };
})();

it.layer(resendTestLayer(timeoutFixture.fetch), { excludeTestServices: true })('Resend ambiguous outcomes', (test) => {
  test.effect('reports a timeout as indeterminate acceptance and never retries automatically', () =>
    Effect.gen(function* timedOutSubmission() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
      if (!Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)) {
        return;
      }
      const encoded = yield* encodeForAssertions(error);
      expect(error.reason).toBe('timeout');
      expect(timeoutRequestCount).toBe(1);
      expect(encoded).not.toContain(message.to);
      expect(encoded).not.toContain('OntOS');
    }),
  );
});

let streamingRequestCount = 0;
let streamingResponseAborted = false;
const streamingFixture: FetchFixture = (() => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    streamingRequestCount += 1;
    const request = new Request(input, init);
    requests.push(request.clone());
    init?.signal?.addEventListener('abort', () => {
      streamingResponseAborted = true;
    });
    const body = new ReadableStream<Uint8Array>();
    return Promise.resolve(
      new Response(body, {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
  };
  return { fetch, requests };
})();

it.layer(resendTestLayer(streamingFixture.fetch), { excludeTestServices: true })(
  'Resend streaming responses',
  (test) => {
    test.effect('bounds a response body that never completes and cancels the request', () =>
      Effect.gen(function* stalledResponse() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
        if (!Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)) {
          return;
        }
        expect(error.reason).toBe('timeout');
        expect(streamingRequestCount).toBe(1);
        expect(streamingResponseAborted).toBe(true);
      }),
    );
  },
);

const unavailableFixture = makeFetchFixture(503, { secret: 'do-not-copy' });

it.layer(resendTestLayer(unavailableFixture.fetch), { excludeTestServices: true })('Resend availability', (test) => {
  test.effect('maps an upstream outage to unavailable without exposing credentials', () =>
    Effect.gen(function* unavailableSubmission() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
      if (!Schema.is(EmailDeliveryUnavailable)(error)) {
        return;
      }
      const encoded = yield* encodeForAssertions(error);
      expect(error.reason).toBe('provider_unavailable');
      expect(error.status).toBe(503);
      expect(encoded).not.toContain('do-not-copy');
      expect(encoded).not.toContain('re_test_secret');
    }),
  );
});
