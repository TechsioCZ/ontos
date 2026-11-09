import { TestClock } from 'effect/testing';
import { SymmyJobNotificationStore } from '../../src/services/symmy-job-notification-store.ts';
import { NodeCrypto } from '@effect/platform-node';
import { Duration, Effect, Fiber, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  SymmyJobNotificationPolicySchema,
  SymmyJobCompletionNotificationSchema,
} from '../../shared/domain/symmy-job-notification.ts';
import type { SymmyJobNotificationSettlement } from '../../shared/domain/symmy-job-notification.ts';
import { makeSymmyJobNotificationService } from '../../src/services/symmy-job-notification.service.ts';
import type { SymmyJobNotificationStoreService } from '../../src/services/symmy-job-notification-store.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const routeId = '10000000-0000-4000-8000-000000000002';
const jobId = '10000000-0000-4000-8000-000000000003';
const policy = Schema.decodeUnknownSync(SymmyJobNotificationPolicySchema)({
  authorization: 'internal-notification-secret',
  initialBackoffMs: 1,
  maxAttempts: 2,
  maxBackoffMs: 10,
  policyId: 'internal-policy',
  recipientId: 'internal-recipient',
  recipientUrl: 'https://callbacks.internal.test/imports',
  revision: 'v1',
  routeId,
  tenantId,
  timeoutMs: 1000,
});
const notification = Schema.decodeUnknownSync(SymmyJobCompletionNotificationSchema)({
  contract: 'INTERNAL_C14_NOTIFICATION_V1',
  event: 'symmy.import_job.completed',
  job: {
    id: jobId,
    items: [
      {
        effects: [
          {
            effectId: '10000000-0000-4000-8000-000000000005',
            owner: 'party.registry',
            status: 'accepted_change',
          },
        ],
        itemId: '10000000-0000-4000-8000-000000000004',
      },
    ],
    status: 'completed_all',
  },
});
const input = {
  notification,
  policy: { notificationRequested: true, policyId: policy.policyId, revision: policy.revision },
  routeId,
  tenantId,
};

it.effect('uses only the pinned HTTPS recipient and a privacy-safe notification with manual redirects', () => {
  const requests: Request[] = [];
  const options: (RequestInit | undefined)[] = [];
  const settlements: SymmyJobNotificationSettlement[] = [];
  const store: SymmyJobNotificationStoreService = {
    claim: () => Effect.succeed({ attempt: 1, mode: 'CLAIMED', version: 1 }),
    settle: (settlement) =>
      Effect.sync(() => {
        settlements.push(settlement);
        return true;
      }),
  };
  const transport = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, async (resource, init) => {
          requests.push(new Request(resource, init));
          options.push(init);
          return new Response(null, { status: 204 });
        }),
      ),
    ),
  );
  return Effect.gen(function* verifySafeNotification() {
    expect(
      yield* makeSymmyJobNotificationService([policy])
        .deliver(input)
        .pipe(Effect.provideService(SymmyJobNotificationStore, store)),
    ).toBe('delivered');
    const [request] = requests;
    expect(request?.url).toBe(policy.recipientUrl.href);
    expect(request?.headers.get('authorization')).toBe('Bearer internal-notification-secret');
    expect(options[0]?.redirect).toBe('manual');
    expect(yield* Effect.promise(() => request?.text() ?? Promise.resolve(''))).toBe(JSON.stringify(notification));
    expect(settlements[0]).toMatchObject({ delivered: true, retryable: false, version: 1 });
  }).pipe(Effect.provide(transport));
});

it.effect('retries only notification delivery with one stable key and stops at the configured bound', () => {
  const keys: (string | null)[] = [];
  let attempts = 0;
  const store: SymmyJobNotificationStoreService = {
    claim: () =>
      Effect.sync(() => {
        attempts += 1;
        return { attempt: attempts, mode: 'CLAIMED', version: attempts };
      }),
    settle: () => Effect.succeed(true),
  };
  const transport = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, async (resource, init) => {
          keys.push(new Request(resource, init).headers.get('idempotency-key'));
          return new Response('', { status: 503 });
        }),
      ),
    ),
  );
  return Effect.gen(function* verifyBoundedNotificationRetry() {
    const service = makeSymmyJobNotificationService([policy]);
    const first = yield* service
      .deliver(input)
      .pipe(Effect.provideService(SymmyJobNotificationStore, store))
      .pipe(Effect.flip);
    expect(first).toMatchObject({ code: 'notification_retry' });
    expect(yield* service.deliver(input).pipe(Effect.provideService(SymmyJobNotificationStore, store))).toBe(
      'exhausted',
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^symmy-notification:[\da-f]{64}$/u);
  }).pipe(Effect.provide(transport));
});

it.effect('does not send a delivered receipt again or follow a recipient redirect', () => {
  let calls = 0;
  let delivered = false;
  const store: SymmyJobNotificationStoreService = {
    claim: () => Effect.succeed({ attempt: 1, mode: delivered ? 'DELIVERED' : 'CLAIMED', version: 1 }),
    settle: () => Effect.succeed(true),
  };
  const transport = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, async () => {
          calls += 1;
          return new Response('', { headers: { location: 'https://foreign.internal.test/' }, status: 302 });
        }),
      ),
    ),
  );
  return Effect.gen(function* verifyRedirectAndReplay() {
    const service = makeSymmyJobNotificationService([policy]);
    expect(yield* service.deliver(input).pipe(Effect.provideService(SymmyJobNotificationStore, store))).toBe(
      'exhausted',
    );
    expect(calls).toBe(1);
    delivered = true;
    expect(yield* service.deliver(input).pipe(Effect.provideService(SymmyJobNotificationStore, store))).toBe(
      'delivered',
    );
    expect(calls).toBe(1);
  }).pipe(Effect.provide(transport));
});

it.effect('refuses ambiguous or missing recipient policy without acquiring a delivery claim', () => {
  let claims = 0;
  const store: SymmyJobNotificationStoreService = {
    claim: () =>
      Effect.sync(() => {
        claims += 1;
        return { attempt: 1, mode: 'CLAIMED', version: 1 };
      }),
    settle: () => Effect.succeed(true),
  };
  return Effect.gen(function* verifyNoRecipientFallback() {
    for (const policies of [[], [policy, policy]]) {
      const result = yield* makeSymmyJobNotificationService(policies)
        .deliver(input)
        .pipe(Effect.provideService(SymmyJobNotificationStore, store))
        .pipe(Effect.flip);
      expect(result).toMatchObject({ code: 'notification_configuration_unavailable' });
    }
    const unrequested = yield* makeSymmyJobNotificationService([policy])
      .deliver({ ...input, policy: { policyId: policy.policyId, revision: policy.revision } })
      .pipe(Effect.provideService(SymmyJobNotificationStore, store), Effect.flip);
    expect(unrequested).toMatchObject({ code: 'notification_configuration_unavailable' });
    expect(claims).toBe(0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        FetchHttpClient.layer,
        Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
      ),
    ),
  );
});

it.effect('times out a notification attempt without changing any owner effect', () => {
  const settlements: SymmyJobNotificationSettlement[] = [];
  const store: SymmyJobNotificationStoreService = {
    claim: () => Effect.succeed({ attempt: 1, mode: 'CLAIMED', version: 1 }),
    settle: (value) =>
      Effect.sync(() => {
        settlements.push(value);
        return true;
      }),
  };
  return Effect.gen(function* verifyNotificationTimeout() {
    const running = yield* Effect.forkChild(makeSymmyJobNotificationService([policy]).deliver(input).pipe(Effect.flip));
    yield* TestClock.adjust(Duration.seconds(2));
    const timeout = yield* Fiber.join(running);
    expect(timeout).toMatchObject({ code: 'notification_retry' });
    expect(Object.hasOwn(timeout, 'cause')).toBe(false);
    expect(settlements).toMatchObject([{ delivered: false, retryable: true }]);
  }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(SymmyJobNotificationStore, store),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.never),
    ),
    Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  );
});

it.effect('refuses a private payload field before a callback claim or external request', () => {
  let claims = 0;
  const store: SymmyJobNotificationStoreService = {
    claim: () =>
      Effect.sync(() => {
        claims += 1;
        return { attempt: 1, mode: 'CLAIMED', version: 1 };
      }),
    settle: () => Effect.succeed(true),
  };
  return Effect.gen(function* verifyPrivatePayloadRefusal() {
    const unsafe = {
      ...input,
      notification: {
        ...notification,
        job: { ...notification.job, privateIntent: { name: 'INTERNAL_PERSONAL_MARKER' } },
      },
    };
    const result = yield* makeSymmyJobNotificationService([policy]).deliver(unsafe).pipe(Effect.flip);
    expect(result).toMatchObject({ code: 'notification_configuration_unavailable' });
    expect(claims).toBe(0);
  }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(SymmyJobNotificationStore, store),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  );
});
