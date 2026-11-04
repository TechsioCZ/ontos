import { CloudflareEmailApiDeliveryLive, isCloudflareEmailApiConfigured } from '../../src/cloudflare-api.ts';
import type { CloudflareEmailApiConfig } from '../../src/cloudflare-api.ts';
import type { EmailDeliveryError } from '../../src/server.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';
import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const ACCOUNT_ID = '384e8a94acf428ce447e7e73122d91d1';
const TOKEN = 'cfut_test_fixture_token';

const configuration: CloudflareEmailApiConfig = {
  accountId: ACCOUNT_ID,
  apiToken: Redacted.make(TOKEN),
  from: 'OntOS <noreply@example.test>',
  timeout: '20 millis',
};

const message = {
  html: Redacted.make('<p>Ověřte účet.</p>'),
  subject: 'Verify your account',
  text: Redacted.make('Verify your account.'),
  to: 'person@example.test',
} as const;

interface Fixture {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: Request[];
}

const recording = (answer: () => Response): Fixture => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(answer());
  };
  return { fetch, requests };
};

const respondWith = (status: number, body: string): Fixture =>
  recording(() => new Response(body, { headers: { 'content-type': 'application/json' }, status }));

const cloudflareTestLayer = (fetch: typeof globalThis.fetch, config: CloudflareEmailApiConfig = configuration) =>
  CloudflareEmailApiDeliveryLive(config, fetch);

const encodeForAssertions = (error: EmailDeliveryError) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error);

const envelope = (result: string) => `{"success":true,"errors":[],"messages":[],"result":${result}}`;
const acceptedResult =
  '{"delivered":[],"message_id":"cf-message-1","permanent_bounces":[],"queued":["person@example.test"],"suppressed_recipients":[]}';

const success = respondWith(200, envelope(acceptedResult));

it.layer(cloudflareTestLayer(success.fetch), { excludeTestServices: true })(
  'Cloudflare Email Service API submission',
  (test) => {
    test.effect('posts one authenticated REST submission and returns its message id as the receipt', () =>
      Effect.gen(function* submission() {
        const service = yield* EmailDeliveryService;
        expect(yield* service.send(message)).toEqual({ accepted: true, id: 'cf-message-1' });
        const request = success.requests.at(0);
        expect(request).toBeDefined();
        if (request === undefined) {
          return;
        }
        expect(request.method).toBe('POST');
        expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/email/sending/send`);
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        expect(request.headers.get('content-type')).toBe('application/json');
        expect(yield* Effect.promise(() => request.json())).toEqual({
          from: configuration.from,
          html: Redacted.value(message.html),
          subject: message.subject,
          text: Redacted.value(message.text),
          to: message.to,
        });
      }),
    );
  },
);

const throttled = respondWith(
  429,
  '{"success":false,"errors":[{"code":10004,"message":"email.sending.error.throttled"}],"messages":[],"result":null}',
);

it.layer(cloudflareTestLayer(throttled.fetch), { excludeTestServices: true })(
  'Cloudflare API rate limiting',
  (test) => {
    test.effect(
      'maps a throttled submission to a rate-limited rejection without copying provider text or the token',
      () =>
        Effect.gen(function* rateLimited() {
          const service = yield* EmailDeliveryService;
          const error = yield* Effect.flip(service.send(message));
          expect(error).toBeInstanceOf(EmailDeliveryRejected);
          expect(error).toMatchObject({ reason: 'rate_limited', status: 429 });
          expect(yield* encodeForAssertions(error)).not.toContain(TOKEN);
        }),
    );
  },
);

const badRequest = respondWith(
  400,
  '{"success":false,"errors":[{"code":10202,"message":"email.sending.error.email.invalid"}],"messages":[],"result":null}',
);

it.layer(cloudflareTestLayer(badRequest.fetch), { excludeTestServices: true })(
  'Cloudflare API validation rejection',
  (test) => {
    test.effect('maps a 4xx submission failure to a provider rejection', () =>
      Effect.gen(function* rejected() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(error).toBeInstanceOf(EmailDeliveryRejected);
        expect(error).toMatchObject({ reason: 'provider_rejected', status: 400 });
      }),
    );
  },
);

const bounced = respondWith(
  200,
  envelope(
    '{"delivered":[],"message_id":"cf-message-1","permanent_bounces":["person@example.test"],"queued":[],"suppressed_recipients":[]}',
  ),
);

it.layer(cloudflareTestLayer(bounced.fetch), { excludeTestServices: true })(
  'Cloudflare API recipient refusal',
  (test) => {
    test.effect('treats a permanently bounced recipient as rejected, not accepted', () =>
      Effect.gen(function* refused() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(error).toBeInstanceOf(EmailDeliveryRejected);
        expect(error).toMatchObject({ reason: 'provider_rejected', status: 200 });
      }),
    );
  },
);

const suppressed = respondWith(
  200,
  envelope(
    '{"delivered":[],"message_id":"cf-message-1","permanent_bounces":[],"queued":[],"suppressed_recipients":["person@example.test"]}',
  ),
);

it.layer(cloudflareTestLayer(suppressed.fetch), { excludeTestServices: true })(
  'Cloudflare API suppressed recipient',
  (test) => {
    test.effect('treats a suppressed recipient as rejected, not accepted', () =>
      Effect.gen(function* suppressedSubmission() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(error).toBeInstanceOf(EmailDeliveryRejected);
        expect(error).toMatchObject({ reason: 'provider_rejected', status: 200 });
      }),
    );
  },
);

const upstreamDown = respondWith(
  503,
  '{"success":false,"errors":[{"code":10100,"message":"email.sending.error.authentication.upstream"}],"messages":[],"result":null}',
);

it.layer(cloudflareTestLayer(upstreamDown.fetch), { excludeTestServices: true })(
  'Cloudflare API upstream failure',
  (test) => {
    test.effect('maps a 5xx response to provider unavailable, which is not a safe-retry signal', () =>
      Effect.gen(function* upstream() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(error).toBeInstanceOf(EmailDeliveryUnavailable);
        expect(error).toMatchObject({ reason: 'provider_unavailable', status: 503 });
      }),
    );
  },
);

const malformed = respondWith(200, '{"success":true,"errors":[],"messages":[],"result":{}}');

it.layer(cloudflareTestLayer(malformed.fetch), { excludeTestServices: true })(
  'Cloudflare API malformed success',
  (test) => {
    test.effect('treats a success response without a message id as an indeterminate acceptance', () =>
      Effect.gen(function* malformedSuccess() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(error).toBeInstanceOf(EmailDeliveryAcceptanceIndeterminate);
        expect(error).toMatchObject({ reason: 'response_invalid' });
      }),
    );
  },
);

const hangingRequests: Request[] = [];
const hangingFetch: Fixture = {
  fetch: (input, init) => {
    hangingRequests.push(new Request(input, init));
    return Promise.withResolvers<Response>().promise;
  },
  requests: hangingRequests,
};

it.layer(cloudflareTestLayer(hangingFetch.fetch), { excludeTestServices: true })('Cloudflare API timeout', (test) => {
  test.effect('reports a timed-out submission as an indeterminate timeout and aborts the stalled request', () =>
    Effect.gen(function* timeout() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(error).toBeInstanceOf(EmailDeliveryAcceptanceIndeterminate);
      expect(error).toMatchObject({ reason: 'timeout' });
      expect(hangingFetch.requests.at(0)?.signal.aborted).toBe(true);
    }),
  );
});

const networkDown: Fixture = {
  fetch: () => Promise.reject(new TypeError('fetch failed')),
  requests: [],
};

it.layer(cloudflareTestLayer(networkDown.fetch), { excludeTestServices: true })(
  'Cloudflare API transport failure',
  (test) => {
    test.effect('maps a network failure to an indeterminate transport error', () =>
      Effect.gen(function* transport() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send(message));
        expect(error).toBeInstanceOf(EmailDeliveryAcceptanceIndeterminate);
        expect(error).toMatchObject({ reason: 'transport' });
      }),
    );
  },
);

const unconfigured = respondWith(200, envelope(acceptedResult));

it.layer(
  cloudflareTestLayer(unconfigured.fetch, {
    accountId: 'not-an-account',
    apiToken: Redacted.make(TOKEN),
    from: configuration.from,
  }),
  { excludeTestServices: true },
)('Cloudflare API configuration checks', (test) => {
  test.effect('refuses an invalid account id before any request is made', () =>
    Effect.gen(function* badAccount() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(error).toBeInstanceOf(EmailDeliveryUnavailable);
      expect(error).toMatchObject({ reason: 'configuration' });
      expect(unconfigured.requests).toHaveLength(0);
    }),
  );
});

const validated = respondWith(200, envelope(acceptedResult));

it.layer(cloudflareTestLayer(validated.fetch), { excludeTestServices: true })(
  'Cloudflare API message validation',
  (test) => {
    test.effect('refuses a malformed recipient before any request is made', () =>
      Effect.gen(function* badRecipient() {
        const service = yield* EmailDeliveryService;
        const error = yield* Effect.flip(service.send({ ...message, to: 'not-an-address' }));
        expect(error).toBeInstanceOf(EmailDeliveryInvalidMessage);
        expect(error).toMatchObject({ field: 'to', reason: 'invalid_format' });
        expect(validated.requests).toHaveLength(0);
      }),
    );
  },
);

it('accepts only a 32-hex account id and a single-token API credential', () => {
  expect(isCloudflareEmailApiConfigured({ accountId: ACCOUNT_ID, apiToken: Redacted.make(TOKEN) })).toBe(true);
  expect(isCloudflareEmailApiConfigured({ accountId: 'ABCDEF', apiToken: Redacted.make(TOKEN) })).toBe(false);
  expect(isCloudflareEmailApiConfigured({ accountId: ACCOUNT_ID, apiToken: Redacted.make('two words') })).toBe(false);
});
