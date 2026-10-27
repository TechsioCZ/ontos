import { Deferred, Effect, Fiber, Random } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { afterAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import {
  agentMutationIntent,
  agentMutationUncertain,
  decideAgentItems,
  revertAgentBatch,
} from '../../../src/routes/agent-platform/agent-platform-client.ts';

const originalFetch = globalThis.fetch;
const fetch = rstest.fn<typeof globalThis.fetch>();
beforeEach(() => {
  fetch.mockReset();
  globalThis.fetch = fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
const decision = { batchKey: 'core:batch', decision: 'approve', itemKeys: ['core:item'], note: 'Reviewed' } as const;

it.effect('retries a lost decision response with the same ingress key and exact original payload', () =>
  Effect.gen(function* retryDecision() {
    const itemKeys: string[] = [...decision.itemKeys];
    const payload = { ...decision, itemKeys };
    const intent = yield* agentMutationIntent(undefined, payload);
    payload.itemKeys.push('core:changed-after-dispatch');
    fetch.mockRejectedValueOnce(new Error('connection lost'));
    const first = yield* decideAgentItems(intent);
    expect(agentMutationUncertain(first)).toBe(true);
    expect(yield* agentMutationIntent(intent, { ...decision, itemKeys: [...decision.itemKeys] })).toBe(intent);
    fetch.mockResolvedValueOnce(Response.json({ results: [] }));
    expect((yield* decideAgentItems(intent)).status).toBe('ok');
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(decision));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toEqual(new URL('/shell-super-app-api/agent-platform/decide', location.href));
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(intent.idempotencyKey);
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('retains a revert intent after an unreadable success body and retries with the same header', () =>
  Effect.gen(function* retryRevert() {
    const intent = yield* agentMutationIntent(undefined, { batchKey: 'core:batch', note: 'Restore' });
    fetch.mockResolvedValueOnce(new Response('not the expected response'));
    expect(agentMutationUncertain(yield* revertAgentBatch(intent))).toBe(true);
    fetch.mockResolvedValueOnce(Response.json({ message: 'Restored', outcome: 'reverted' }));
    expect((yield* revertAgentBatch(intent)).status).toBe('ok');
    expect(fetch.mock.calls[1]?.[0]).toEqual(new URL('/shell-super-app-api/agent-platform/revert', location.href));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('idempotency-key')).toBe(intent.idempotencyKey);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('treats a lost response stream as uncertain instead of rejecting outside the transport boundary', () =>
  Effect.gen(function* lostBody() {
    const response = Response.json({ results: [] });
    rstest.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('response stream lost'));
    fetch.mockResolvedValueOnce(response);
    expect(agentMutationUncertain(yield* decideAgentItems(yield* agentMutationIntent(undefined, decision)))).toBe(true);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('creates a new ingress key only for a new or changed action intent', () =>
  Effect.gen(function* changedIntent() {
    const first = yield* agentMutationIntent(undefined, decision);
    expect(yield* agentMutationIntent(first, decision)).toBe(first);
    expect((yield* agentMutationIntent(first, { ...decision, note: 'Different' })).idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
    expect((yield* agentMutationIntent(undefined, decision)).idempotencyKey).not.toBe(first.idempotencyKey);
  }),
);

it('distinguishes uncertain transport/server outcomes from terminal rejections', () => {
  for (const httpStatus of [0, 408, 409, 425, 429, 500, 503]) {
    expect(agentMutationUncertain({ httpStatus, message: 'Failed', status: 'failed' })).toBe(true);
  }
  for (const httpStatus of [400, 401, 403, 404, 422, 428]) {
    expect(agentMutationUncertain({ httpStatus, message: 'Rejected', status: 'failed' })).toBe(false);
  }
  expect(agentMutationUncertain({ status: 'ok', value: {} })).toBe(false);
});

it.effect('uses injected randomness only when allocating a new intent', () =>
  Effect.gen(function* injectedRandom() {
    const nextDoubleUnsafe = rstest.fn(() => 0.5);
    const random = { nextDoubleUnsafe, nextIntUnsafe: () => 0 };
    const first = yield* agentMutationIntent(undefined, decision).pipe(Effect.provideService(Random.Random, random));
    expect(first.idempotencyKey).toBe('80000000800000008000000080000000');
    expect(nextDoubleUnsafe).toHaveBeenCalledTimes(4);
    expect(yield* agentMutationIntent(first, decision).pipe(Effect.provideService(Random.Random, random))).toBe(first);
    expect(nextDoubleUnsafe).toHaveBeenCalledTimes(4);
  }),
);

it.effect('aborts a stalled response body at the transport deadline and keeps the exact retry intent', () =>
  Effect.gen(function* bodyDeadline() {
    const reading = yield* Deferred.make<boolean>();
    const stalledBody = Promise.withResolvers<ArrayBuffer>();
    const response = Response.json({ results: [] });
    rstest.spyOn(response, 'arrayBuffer').mockImplementationOnce(() => {
      Deferred.doneUnsafe(reading, Effect.succeed(true));
      return stalledBody.promise;
    });
    fetch.mockResolvedValueOnce(response);
    const intent = yield* agentMutationIntent(undefined, decision);
    const pending = yield* decideAgentItems(intent).pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    yield* TestClock.adjust('30 seconds');
    expect(agentMutationUncertain(yield* Fiber.join(pending))).toBe(true);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    stalledBody.resolve(new ArrayBuffer(0));
    fetch.mockResolvedValueOnce(Response.json({ results: [] }));
    expect((yield* decideAgentItems(intent)).status).toBe('ok');
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('idempotency-key')).toBe(intent.idempotencyKey);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
