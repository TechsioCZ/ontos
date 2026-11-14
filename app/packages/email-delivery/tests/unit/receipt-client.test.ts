import { DateTime, Deferred, Effect, Fiber, Layer, Match, Option, Schema } from 'effect';
import { flow } from 'effect/Function';
import { FetchHttpClient } from 'effect/http';
import { afterAll, beforeAll, describe, expect, it, rs } from 'effect-rstest';
import {
  EmailDeliveryReceiptsResponseSchema,
  EmailReceiptsProblemSchema,
  EmailReceiptsInvalidProblemSchema,
  EmailReceiptsAuthenticationProblemSchema,
  EmailReceiptsForbiddenProblemSchema,
  EmailReceiptsUnavailableProblemSchema,
} from '../../src/receipt-api.ts';
import type { EmailReceiptsProblem } from '../../src/receipt-api.ts';
import { getEmailProvider, listEmailDeliveries } from '../../src/receipt-client.ts';

// The production client resolves the Shell path against its current browser document.
const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('https://receipt.ontos.test/cs/finance'),
  });
});
afterAll(() => {
  if (previousLocation === undefined) {
    Reflect.deleteProperty(globalThis, 'location');
  } else {
    Object.defineProperty(globalThis, 'location', previousLocation);
  }
});

it.layer(
  FetchHttpClient.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.RequestInit, {
        cache: 'no-store',
        credentials: 'include',
      }),
    ),
  ),
)((test) => {
  const response: typeof EmailDeliveryReceiptsResponseSchema.Encoded = {
    deliveries: [
      {
        createdAt: '2026-10-21T12:00:00.000Z',
        event: 'ORDER_CREATED',
        eventAt: '2026-10-21T12:00:00.000Z',
        eventLabel: 'Přijetí objednávky',
        sentAt: '2026-10-21T12:00:01.000Z',
        source: 'akros-order',
        status: 'SENT',
        subjectId: 'order-1',
        subjectNumber: 'OBJ-1',
      },
      {
        createdAt: '2026-10-21T12:01:00.000Z',
        event: 'CONFIRMED',
        eventAt: '2026-10-21T12:01:00.000Z',
        eventLabel: null,
        sentAt: null,
        source: 'akros-order',
        status: 'RETRY',
        subjectId: 'order-1',
        subjectNumber: 'OBJ-1',
      },
    ],
  };

  test.effect('uses the authenticated uncached Shell path and preserves repeated selectors', () =>
    Effect.gen(function* receiptRequest() {
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = flow(
        (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new Request(input, init));
        },
        rs.fn<() => Promise<Response>>().mockResolvedValue(Response.json(response)),
      );
      const receipts = yield* listEmailDeliveries({
        source: 'akros-order',
        subjectId: ['order-1', 'order-2'],
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      const [request] = requests;
      if (request === undefined) {
        expect.unreachable('The receipt client must execute its owning request');
      }
      expect(requests).toHaveLength(1);
      const url = new URL(request.url);
      expect(url.origin).toBe('https://receipt.ontos.test');
      expect(url.pathname).toBe('/shell-super-app-api/email/deliveries');
      expect(url.searchParams.get('source')).toBe('akros-order');
      expect(url.searchParams.getAll('subjectId')).toEqual(['order-1', 'order-2']);
      expect(request.method).toBe('GET');
      expect(request.credentials).toBe('include');
      expect(request.cache).toBe('no-store');
      expect(request.body).toBeNull();
      const [sent, historical] = receipts.deliveries;
      if (sent === undefined || historical === undefined) {
        expect.unreachable('Both sent and historical receipt fixtures must decode');
      }
      expect(DateTime.formatIso(sent.createdAt)).toBe('2026-10-21T12:00:00.000Z');
      expect(DateTime.formatIso(sent.eventAt)).toBe('2026-10-21T12:00:00.000Z');
      expect(sent.eventLabel).toEqual(Option.some('Přijetí objednávky'));
      expect(sent.sentAt.pipe(Option.map(DateTime.formatIso))).toEqual(Option.some('2026-10-21T12:00:01.000Z'));
      expect(Option.isNone(historical.eventLabel)).toBe(true);
      expect(Option.isNone(historical.sentAt)).toBe(true);
      expect(yield* Schema.encodeEffect(EmailDeliveryReceiptsResponseSchema)(receipts)).toEqual(response);
    }),
  );

  const problems = [
    {
      _tag: 'EmailReceiptsInvalidProblem',
      detail: 'The receipt selector is invalid.',
      error: 'invalid_query',
      status: 400,
      title: 'Invalid query',
      type: 'about:blank',
    },
    {
      _tag: 'EmailReceiptsAuthenticationProblem',
      detail: 'Authentication is required.',
      error: 'authentication_required',
      status: 401,
      title: 'Authentication required',
      type: 'about:blank',
    },
    {
      _tag: 'EmailReceiptsForbiddenProblem',
      detail: 'This receipt is unavailable to the caller.',
      error: 'forbidden',
      status: 403,
      title: 'Forbidden',
      type: 'about:blank',
    },
    {
      _tag: 'EmailReceiptsUnavailableProblem',
      detail: 'Receipts are temporarily unavailable.',
      error: 'email_unavailable',
      retryable: true,
      status: 503,
      title: 'Email unavailable',
      type: 'about:blank',
    },
  ] as const satisfies readonly EmailReceiptsProblem[];

  describe('receipt Problem Details', () => {
    for (const problem of problems) {
      test.effect(`retains the ${problem.status} ${problem.error} error category`, () =>
        Effect.gen(function* receiptFailure() {
          const fetch: typeof globalThis.fetch = rs.fn<() => Promise<Response>>().mockResolvedValue(
            Response.json(problem, {
              headers: { 'content-type': 'application/problem+json' },
              status: problem.status,
            }),
          );
          const failure = yield* Effect.flip(
            listEmailDeliveries({ source: 'akros-order', subjectId: 'order-1' }).pipe(
              Effect.provideService(FetchHttpClient.Fetch, fetch),
            ),
          );
          expect(Schema.is(EmailReceiptsProblemSchema)(failure)).toBe(true);
          if (!Schema.is(EmailReceiptsProblemSchema)(failure)) {
            expect.unreachable('A declared Problem must retain its typed failure channel');
          }
          const expectedCategory = Match.value(problem).pipe(
            Match.tag('EmailReceiptsInvalidProblem', () => Schema.is(EmailReceiptsInvalidProblemSchema)(failure)),
            Match.tag('EmailReceiptsAuthenticationProblem', () =>
              Schema.is(EmailReceiptsAuthenticationProblemSchema)(failure),
            ),
            Match.tag('EmailReceiptsForbiddenProblem', () => Schema.is(EmailReceiptsForbiddenProblemSchema)(failure)),
            Match.tag('EmailReceiptsUnavailableProblem', () =>
              Schema.is(EmailReceiptsUnavailableProblemSchema)(failure),
            ),
            Match.exhaustive,
          );
          expect(expectedCategory).toBe(true);
          expect(failure.status).toBe(problem.status);
          expect(failure.error).toBe(problem.error);
        }),
      );
    }
  });

  test.effect('aborts the receipt fetch when the calling fiber is interrupted', () =>
    Effect.gen(function* cancelledReceiptRequest() {
      const startedEffect: Effect.Effect<Deferred.Deferred<void>> = Deferred.make();
      const started = yield* startedEffect;
      const pendingResponse: Promise<Response> = Promise.race([]);
      let aborted = false;
      const fetch: typeof globalThis.fetch = flow((_input: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
        Deferred.doneUnsafe(started, Effect.void);
      }, rs.fn<() => Promise<Response>>().mockReturnValue(pendingResponse));
      const fiber = yield* listEmailDeliveries({ source: 'rent-reminder', subjectId: 'reminder-1' }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(aborted).toBe(true);
    }),
  );

  test.effect('keeps recipients, message bodies and provider identifiers out of decoded public receipts', () =>
    Effect.gen(function* receiptPrivacy() {
      const fetch: typeof globalThis.fetch = rs.fn<() => Promise<Response>>().mockResolvedValue(
        Response.json({
          deliveries: response.deliveries.map((receipt) => ({
            ...receipt,
            html: '<p>Private body</p>',
            messageId: 'private-provider-id',
            recipient: 'private@example.org',
            text: 'Private body',
          })),
        }),
      );
      const receipts = yield* listEmailDeliveries({ source: 'akros-order', subjectNumber: 'OBJ-1' }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      const encoded = yield* Schema.encodeEffect(EmailDeliveryReceiptsResponseSchema)(receipts);
      expect(encoded).toEqual(response);
      for (const receipt of receipts.deliveries) {
        expect(receipt).not.toHaveProperty('recipient');
        expect(receipt).not.toHaveProperty('text');
        expect(receipt).not.toHaveProperty('html');
        expect(receipt).not.toHaveProperty('messageId');
      }
    }),
  );

  describe('public email provider', () => {
    for (const provider of [
      { configured: true, label: 'Cloudflare Email Service' },
      { configured: false, label: null },
    ]) {
      test.effect(
        `decodes the ${provider.configured ? 'configured' : 'disabled'} provider without changing its wire label`,
        () =>
          Effect.gen(function* providerStatus() {
            const requests: Request[] = [];
            const fetch: typeof globalThis.fetch = flow(
              (input: RequestInfo | URL, init?: RequestInit) => {
                requests.push(new Request(input, init));
              },
              rs.fn<() => Promise<Response>>().mockResolvedValue(Response.json(provider)),
            );
            const decoded = yield* getEmailProvider().pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
            expect(decoded.configured).toBe(provider.configured);
            expect(decoded.label).toEqual(Option.fromNullishOr(provider.label));
            const [request] = requests;
            if (request === undefined) {
              expect.unreachable('The provider client must execute its owning request');
            }
            expect(requests).toHaveLength(1);
            expect(new URL(request.url).pathname).toBe('/shell-super-app-api/email/provider');
            expect(request.method).toBe('GET');
            expect(request.credentials).toBe('include');
            expect(request.cache).toBe('no-store');
          }),
      );
    }

    test.effect('retains the provider unavailable Problem as a typed 503 failure', () =>
      Effect.gen(function* providerUnavailable() {
        const problem = problems.find((candidate) => candidate.status === 503);
        if (problem === undefined) {
          expect.unreachable('The Problem fixtures must include the unavailable category');
        }
        const fetch: typeof globalThis.fetch = rs.fn<() => Promise<Response>>().mockResolvedValue(
          Response.json(problem, {
            headers: { 'content-type': 'application/problem+json' },
            status: problem.status,
          }),
        );
        const failure = yield* Effect.flip(
          getEmailProvider().pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
        );
        expect(Schema.is(EmailReceiptsProblemSchema)(failure)).toBe(true);
        if (!Schema.is(EmailReceiptsProblemSchema)(failure)) {
          expect.unreachable('The provider must retain its declared unavailable failure');
        }
        expect(Schema.is(EmailReceiptsUnavailableProblemSchema)(failure)).toBe(true);
        expect(failure.status).toBe(503);
        expect(failure.error).toBe('email_unavailable');
      }),
    );
  });
});
